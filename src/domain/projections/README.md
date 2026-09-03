# Projections lane — wave 4 (issue #24, SPEC §19/§20/§66)

The read-only reporting & strategy layer: AR aging snapshots, collection
effectiveness figures, cash-collection **projections**, and the segment →
strategy mapping. This lane is the intelligence side of README design
principle 2 — **it never owns fund truth**. It imports nothing but
`../shared` + its own files; callers supply plain-data facts (projected from
the fund-truth lanes by adapters) and receive pure values back.

## Scope

- **`facts.ts`** — the plain-data contracts (`ReceivableFact`, `BehaviorFact`)
  and the shared validation gates (Money-safe amounts, ISO dates with
  required zones, Uuid-shaped opaque ids, duplicate detection). Wire-shaped
  on purpose: adapters can feed event-store rows straight in.
- **`aging.ts`** — `arAgingByBucket(receivables, asOf)`: outstanding balances
  per currency in the standard buckets `current | 1-30 | 31-60 | 61-90 | 90+`
  (whole days past due, floored; boundaries 30/31, 60/61, 90/91 pinned by
  tests). Returns `kind: 'actual'`, per-currency first-seen order, zero-filled
  buckets; every bucket total (figure) carries its own `asOf` + `evidenceRefs`
  (contributing receivable ids). Zero-balance facts are skipped (counted, not
  aged) — settled debt has nothing to age.
- **`effectiveness.ts`** — `collectionEffectiveness(facts, window)`:
  `collectedVsBilled` (money ratio), `promiseKept` + `disputeRate` (count
  ratios) over an inclusive `[from, to]` window. Every figure carries `asOf`
  (window end) + `evidenceRefs` (numerator contributors, then
  denominator-only, deduped, input order). Not-computable figures are
  `value: null` WITH a reason — never a misleading 0; ratios > 1 are legal
  (collecting pre-window invoices) and never clamped. Single-currency (R10).
- **`projection.ts`** — `projectCollections(receivables, behaviorFacts,
  horizonDays, clock)`: deterministic pessimistic/expected/optimistic bands
  from transparent rules (`PROJECTION_RULES`, frozen + exported):
  propensity × overdue haircuts (≤30d ×0.8, 31-60d ×0.6, 61-90d ×0.4, >90d
  ×0.2), optimistic ×1.25 capped at 1, pessimistic ×0.75, disputed
  receivables excluded (SPEC §29 pause), fractions applied via
  `Money.allocate` (sum-preserving, bigint-only). Every output carries
  `kind: 'projection'` + an `assumptions` list (scope rule, haircuts, band
  factors, defaulted-propensity customers, excluded disputes, skipped
  zero-balances — each line only when it applies). **No actual balance field
  ever appears inside a projection structure** — actuals live in aging
  snapshots, and the two kinds are never mixed.
- **`segments.ts`** — `segmentCustomers(customerFacts)`: deterministic,
  explainable segmentation into the stable named segments
  `high_value_reliable | watch | at_risk | chronic_late | dormant`. First-match
  matrix (risk outranks value; dormancy outranks all): zero exposure →
  dormant; silence ≥ 180d → dormant; ≥ 3 broken promises or ≥ 90d overdue →
  chronic_late; open dispute or ≥ 31d overdue or kept-rate < 0.5 → at_risk;
  exposure ≥ 10M minor + nothing overdue + kept-rate ≥ 0.8 (or no history) →
  high_value_reliable; else watch. Thresholds exported frozen
  (`SEGMENT_THRESHOLDS`); every assignment carries the fired conditions as
  `reasons`.
- **`strategies.ts`** — `strategyFor(segment, overrides?)` and
  `assignStrategies(assignments, overrides?)`: pure mapping to the named
  strategies `self_serve_reminders | guided_follow_up | intensive_follow_up |
  escalate_early` (DEFAULT_STRATEGIES, frozen). Override precedence:
  explicit per-customer > explicit per-segment > default; every result names
  its `source` + `reason`. Strategies are names, not executions.
- **`events.ts`** — lane events, repo envelope
  `{ name, version, aggregateId, occurredAt, payload }`, v1, ISO dates:
  `projections.agingSnapshotTaken` (aggregate = org), 
  `projections.collectionsProjected` (aggregate = org; payload carries
  `kind: 'projection'`), `segment.customerSegmentAssigned` /
  `segment.strategyAssigned` (aggregate = customer). Both `projections.*`
  payloads carry an `evidenceRefs` trail; kind guards refuse to label a
  prediction as an actual (or vice versa) on the wire; minor units travel as
  safe-integer numbers (`PROJ_AMOUNT_NOT_SAFE_INTEGER`).

## Rules

- Import ONLY from `../shared` + own files. Receivables, customers,
  promises, disputes are referenced by opaque `Uuid` ids or plain facts —
  never by importing another lane's types.
- **Pure and read-only.** No I/O, no RNG, no `Date.now()` — time comes from
  the injected `Clock` or the caller's `asOf`; inputs are never mutated;
  every result is a fresh value. **No fund-truth writes, ever.**
- Any forward-looking number is a labeled projection (`kind: 'projection'` +
  assumptions); actuals are labeled `kind: 'actual'`. The two never share a
  structure.
- Single-currency arithmetic throughout (R10): totals live per-currency;
  cross-currency sums are structurally impossible.
- Money-safe arithmetic: amounts are non-negative integer minor units
  (bigint discipline); fractions are applied via `Money.allocate`, so
  applied + remainder always sum back to the balance — no cent invented, no
  float drift.
- Every figure is explainable: evidence refs back each number, assumptions
  surface every default, reasons back every segment/strategy decision
  (VISION §3.7).
- Stable `DomainError` codes (SCREAMING_SNAKE):
  `PROJ_AS_OF_INVALID`, `PROJ_CLOCK_INVALID`, `PROJ_HORIZON_INVALID`,
  `PROJ_PROPENSITY_INVALID`, `PROJ_BEHAVIOR_FACT_INVALID`,
  `PROJ_BEHAVIOR_FACT_DUPLICATE`, `PROJ_RECEIVABLE_INVALID`,
  `PROJ_RECEIVABLE_DUPLICATE`, `PROJ_DUE_DATE_INVALID`, `PROJ_BALANCE_INVALID`,
  `PROJ_CURRENCY_INVALID`, `PROJ_AMOUNT_INVALID`, `PROJ_FACT_DATE_INVALID`,
  `PROJ_EFFECTIVENESS_FACT_INVALID`, `PROJ_FACT_REF_DUPLICATE`,
  `PROJ_WINDOW_INVALID`, `PROJ_AMOUNT_NOT_SAFE_INTEGER`, `PROJ_KIND_INVALID`,
  `PROJ_FRACTION_INVALID`,
  `SEG_CUSTOMER_FACT_INVALID`, `SEG_CUSTOMER_DUPLICATE`,
  `SEG_CURRENCY_INVALID`, `SEG_EXPOSURE_INVALID`, `SEG_RATE_INVALID`,
  `SEG_SEGMENT_UNKNOWN`, `SEG_STRATEGY_INVALID`,
  `SEG_OVERRIDE_SEGMENT_UNKNOWN`, `SEG_OVERRIDE_CUSTOMER_INVALID`.

## Definition of done

- Table-driven tests: aging bucket boundaries (±1 day), multi-currency
  totals, effectiveness math + window bounds, projection band construction +
  labeling + assumption surfacing, segmentation matrix + override precedence,
  strategy mapping completeness, event envelope shapes, no-mutation pins,
  determinism.
- `npm run typecheck && npm test` green.
