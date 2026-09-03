# Ledger module — wave 3 (issue #18, F11)

Owns the sub-ledger posting implementation (the posting matrix) and the daily
sub-ledger ↔ GL reconciliation job. Review findings **K5** (reconciliation) and
**K6** (immutability & concurrency), invariants **R3** (append-only postings)
and **R4** (ledger completeness), SPEC §17 (financial ledger).

## Scope

- **Typed chart of accounts** (`accounts.ts`): `AR_CONTROL`, `CASH`, `REVENUE`,
  `REVENUE_CONTRA`, `SALES_REFUNDS`, `BAD_DEBT_EXPENSE`, `OTHER_INCOME` — a
  closed union; adapters cannot invent accounts. `JournalLine` = account +
  direction (`DEBIT`/`CREDIT`) + amount (integer minor units, magnitude) +
  currency.
- **Posting matrix** (`matrix.ts`) — the core: a pure frozen table mapping each
  money-moving source event to exactly one balanced entry:

  | Issue #18 row    | Source event (opaque name)     | Debit            | Credit       |
  |------------------|--------------------------------|------------------|--------------|
  | invoiceIssued    | `invoicing.invoiceIssued`      | AR_CONTROL       | REVENUE      |
  | paymentCompleted | `payments.paymentCompleted`    | CASH             | AR_CONTROL   |
  | creditNoteApplied| `adjustments.creditNoteApplied`| REVENUE_CONTRA   | AR_CONTROL   |
  | refundCompleted  | `adjustments.refundCompleted`  | SALES_REFUNDS    | CASH         |
  | writeOffApproved | `receivables.writeOffApproved` | BAD_DEBT_EXPENSE | AR_CONTROL   |
  | lateFeeAssessed  | `receivables.lateFeeAssessed`  | AR_CONTROL       | OTHER_INCOME |

  docs/05's "Allocation executed" row is deliberately absent: allocation is
  memo-only ("movement is within AR"), so an allocation event has **no matrix
  row** and is rejected with `LEDGER_EVENT_NOT_POSTABLE` rather than
  zero-posted.
- **`JournalEntry` aggregate** (`journal.ts`): `entryId`, `orgId`,
  `occurredAt` (+ `postedAt`), `sourceEventName` + `sourceEventId` (opaque),
  `status` `POSTED | REVERSED`, `reversalOf`, `reason`, balanced `lines`, plus
  the SPEC §17 audit fields `reference` (external ref) and `actor`
  (actor/system). Every entry carries amount, currency, direction, account,
  reference, source, idempotency key, timestamps, actor and status.
- **Append-only + reversals (R3/K6):** posted entries are never mutated or
  deleted (returned frozen). Corrections append a reversing entry with swapped
  lines, `reversalOf` → the original and a required `reason`; the original is
  re-emitted as a NEW immutable object with `status: 'REVERSED'` +
  `reversedBy`. Reversing a reversal is rejected (`LEDGER_REVERSAL_OF_REVERSAL`)
  — correct the original again instead.
- **Idempotency (SPEC §17, R9 spirit):** the producing lane's `sourceEventId`
  is the idempotency key (scoped by `orgId`). Re-posting returns the ORIGINAL
  entry unchanged (`outcome: 'already_posted'`, zero events). A same-id event
  with different movement details is refused as
  `LEDGER_IDEMPOTENCY_CONFLICT` — that is a mutated event, not a replay.
- **Daily reconciliation job (K5, R4)** (`reconciliation.ts`): pure function
  over a deterministic job spec (`dailyReconciliationJob(orgId, currency,
  runDate)` — the date parameter makes runs and job ids reproducible):
  verifies `Σ(open receivable balances) == AR_CONTROL net balance` for the
  org+currency. Zero drift → `outcome: 'ok'` + `ledger.reconciliationMatched`;
  drift → the typed `ReconciliationDrift` exception result +
  `ledger.reconciliationDriftDetected` (sub-ledger vs GL vs signed
  `driftMinor`). Reversed entries self-cancel in the math (append-only), so
  corrections never break reconciliation.

## Lane events

`ledger.entryPosted`, `ledger.entryReversed`,
`ledger.reconciliationDriftDetected`, `ledger.reconciliationMatched` —
additive to the 27-event catalog (docs/04), same envelope style as the other
lanes (`name`, `version: 1`, `aggregateId`, ISO `occurredAt`, narrow
JSON-serializable payload; minor units as safe-integer numbers, guarded by
`minorUnits`).

## Rules

- Import ONLY from `../shared` and own files. Producing lanes are referenced
  by opaque ids and event names — never by importing their types.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`.
- Stable `DomainError` codes (`LEDGER_*` prefix; `REVERSAL_REASON_REQUIRED`
  and `CURRENCY_MISMATCH` shared with the repo) for every invalid input and
  posting violation. Drift is a VALUE (`ReconciliationDrift`), not an error.
- Unbalanced entries are rejected wherever lines are explicit
  (`LEDGER_ENTRY_UNBALANCED`); matrix-posted entries are balanced by
  construction and re-proven by the balance check.

## Definition of done

- Posting matrix: every row table-driven tested (legal + illegal — unknown
  event, unbalanced lines, double-post, reverse-a-reversal).
- Reconciliation: drift and no-drift scenarios, scope/currency filtering,
  duplicate/negative input guards.
- `npm run typecheck && npm test` green.
