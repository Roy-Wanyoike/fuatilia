# Cross-border module — wave 6 (issue #48)

Owns the cross-border payments domain: corridors, FX quotes with expiry,
transfer intents and deterministic fee schedules (SPEC §33 deferral — the
movement itself stays with the payment products; Fuatilia understands and
tracks). **No fund-truth writes**: this lane never allocates or settles
receivables — it produces facts other lanes may consume later via events.

## Scope
- `Corridor` (`corridor.ts`) — org-scoped configuration: source → destination
  currency (never the same), inclusive `[min, max]` source-currency bounds,
  allowed rails (lowercase slugs, e.g. `mpesa_ke_tz`), per-corridor fee
  schedule. Mutation is fact-recorded, never silently edited: registration
  emits `crossborder.corridorRegistered`, suspension emits
  `crossborder.corridorSuspended`; there is no update — a changed corridor is
  a NEW registration and the old one is suspended.
- `FeeSchedule` (`fees.ts`) — flat + bps, both in SOURCE-currency minor units
  (fees are charged ON TOP: the sender is debited amount + fee, the recipient
  receives the full converted amount). The bps component is rounded with ONE
  banker's rounding (half-to-even); the total is an exact sum, so
  `flatMinor + bpsMinor === totalMinor` always — no cent created or destroyed.
- `FxQuote` (`quote.ts`) — a forward-looking OFFER (not a realized posting):
  rate snapshot + fee breakdown + expiry. Rate-table rows carry inclusive
  `[effectiveFrom, effectiveTo]` windows; same-pair rows may never overlap —
  not even touch (two rates at one instant are ambiguous →
  `RATE_TABLE_OVERLAP`); different pairs may overlap freely. Conversion is
  exact bigint rational math with ONE banker's rounding; the minor→minor
  ratio folds the scale gap (UGX-style zero-decimal currencies stay exact).
  Quotes are immutable: no edit, no extend — a requote is a NEW quote.
  Usable strictly BEFORE `expiresAt` (`QUOTE_EXPIRED` at the boundary, ±1ms
  tested). `reconcileQuoteLegs` audits the three ledger identities of every
  quote (fee sum, debit = amount + fee, credit = exact conversion).
- `TransferIntent` (`intent.ts`) — lifecycle
  `drafted → quoted → authorized → submitted → settled | cancelled | expired | failed`
  (table `INTENT_TRANSITIONS`; terminals empty). The quote is FROZEN into the
  intent at attach (amounts, fee breakdown, applied rate, expiry); settlement
  records the realized legs against the frozen quote and REFUSES drifted fees
  (`FEE_SCHEDULE_CHANGED`) or non-reconciling realized legs
  (`INTENT_SETTLEMENT_MISMATCH`). Idempotent submit (R9/C5):
  unique(intentId, idempotencyKey) — an identical retry REPLAYS the original
  outcome + `crossborder.intentReplayObserved` tripwire; a conflicting retry
  (different rail/quote/amounts) is refused `INTENT_DUPLICATE_SUBMIT`.

## Rules
- Import ONLY from `../shared`. Cross-lane ids (org, payment products,
  settlement refs) are opaque `Uuid`s/strings — never dereferenced here.
  Rate/quote types are declared INSIDE this lane (they are offers with
  expiry, not the fx lane's realized snapshots — the lanes never import each
  other; the banker's-rounding semantics mirror `shared/fx.ts` by contract).
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock`. Fresh immutable copies everywhere; corridor, rate row,
  quote, fee breakdown and intents are frozen records.
- Stable `DomainError` codes: `CORRIDOR_*`, `AMOUNT_OUT_OF_BOUNDS`,
  `QUOTE_*`, `RATE_TABLE_*`, `INTENT_*`, `FEE_SCHEDULE_*`, plus the shared
  `CURRENCY_MISMATCH` / `MONEY_NOT_INTEGER` / `MONEY_NEGATIVE`.
- Events in repo naming style (`crossborder.*`), envelope
  `{ name, version: 1, aggregateId, occurredAt (ISO), payload }`, narrow
  serializable payloads (ISO dates, safe-integer amounts, exact
  `"numerator/denominator"` rate strings).

## Events
`crossborder.corridorRegistered`, `crossborder.corridorSuspended`,
`crossborder.quoteIssued`, `crossborder.intentAuthorized`,
`crossborder.intentSubmitted`, `crossborder.intentSettled`,
`crossborder.intentCancelled`, `crossborder.intentFailed`,
`crossborder.intentReplayObserved`.

## Deviations (deliberate, documented)
- No `crossborder.intentDrafted` / `intentQuoted` / `intentExpired` events:
  the dispatched event catalog does not include them. Drafting and quoting
  are pre-authorization posture (issuance is observable via
  `crossborder.quoteIssued`); expiry is a silent time-driven flip visible on
  the aggregate — mirroring the collections-lane precedent for uncataloged
  transitions.
- `submitIntent` takes the corridor (for rail validation) and therefore also
  refuses a corridor suspended between authorization and submit.
- `settleIntent` does not re-check corridor liveness: an in-flight transfer
  settles, fails or is cancelled; a suspension mid-flight cannot retract it.
- Fees live in the SOURCE currency and are charged on top; the destination
  leg is the full conversion. This keeps every ledger identity single-currency
  and exact (see `reconcileQuoteLegs`).

## Definition of done
- Quote-expiry boundary table (±1ms), fee rounding table (banker's edges;
  breakdown always sums), rate-table overlap rejection (incl. touching
  windows), corridor validation table, intent lifecycle grid (legal/illegal
  through real states), idempotent submit replay suite, frozen-quote-at-
  authorization pin, no-mutation pins — all table-driven.
- `npm run typecheck && npm test` green.
