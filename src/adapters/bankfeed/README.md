# Bank-feed reconciliation (`src/adapters/bankfeed/`)

**RICE #6 / issue #117 (wave 11, lane 11-g)** — distributors and schools collect across M-Pesa
AND bank rails; reconciliation is the wedge capability and bank rails are half of it. This lane
normalizes bank statements into the EXISTING payments intake + match core
(`intakePayment` → `awaitConfirmation` → `confirmPayment` → `matchDecision` → `recordMatch`).
The adapter composes and reports; the domain decides; nothing is force-matched.

## Files

| File | Role |
|---|---|
| `feeds.ts` | Three documented feed shapes → one `BankFeedEntry` (PesaLink-style credit JSON, generic bank CSV with config-driven columns, MT940-lite JSON); strict money (digit-by-digit BigInt minor units — separators/negatives/zeros/>2dp/overflow refused); KES-only with honest refusal (R10); statement CHECKSUM over a stable canonical serialization; duplicate references within a statement refused; deterministic (valueDate, reference) ordering — out-of-order feeds never change truth; candidate-ref extraction from narratives (invoice-number-like tokens with ≥1 digit — 'payment' and 'for' are noise); the statement IS the confirmation evidence, so the funnel runs the EXISTING confirmation transitions; matches recorded through the core only when the CORE decides `matched`. |

## The statement contract

```
importStatement({ statementId, orgId, entries, openInvoices, store, clock })
  → duplicate_replay (first result; commit effects NOT re-run)
  | checksum_mismatch (same id, different content — tampering refusal)
  | duplicate_references (one statement cannot credit a ref twice)
  | imported { totalMinor — the Σ no-cent support, per-entry verdicts }
```

## Honesty rules

- The adapter NEVER force-matches: extraction produces candidate tokens, the core's
  `matchDecision` decides (exact externalRef → fuzzy declaredRefs → honestly unapplied).
- Amount/date-window hints would need invoice amounts, which `OpenInvoiceRef` deliberately does
  not carry (amounts are the allocation engine's business, R1/R2).
- Idempotency keys are statement-scoped (`bankfeed:<statementId>:<reference>`); the checksum is
  order-sensitive across entries (a reordered statement is a DIFFERENT statement worth refusing)
  but deterministic within one.
- Tests never touch network or disk; fixture sets pin the no-cent invariant (Σ intake == Σ entries).
