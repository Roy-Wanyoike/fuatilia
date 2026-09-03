# Intelligence module — wave 4 (issue #23)

Owns the **F13** slice of the intelligence layer: transparent collections
priority scoring, the next-capability recommendation matrix and the
append-only **recommendation feedback loop** (review finding **H7** —
"recommendation system had no feedback loop").

**The intelligence layer never owns fund truth** (README design principle 2,
docs/07 R4): every function here is read-only arithmetic over PLAIN-DATA
projections the caller supplies. It cannot move money, mutate another lane's
aggregates, or read the wall clock — data in → data out, time via the
injected `Clock`.

## Scope
- **Facts in (plain data, opaque Uuids):** `ReceivableFacts` per receivable
  (ids, `amountMinor`/`currency`, status, `agingBucket` + `ageDays`, disputed,
  optional `promiseState`, `lastPaymentAt`, `consentPresent`,
  `priorActionCounts`) and optional `CustomerFacts` (promise reliability).
  The adapter projects these from the receivables/payments/promises/disputes/
  consent/collections lanes — this module never imports another lane.
- **Scoring (`scoring.ts`) — the transparent expression (H7: no opaque
  numbers):** `score = agePoints + amountPoints + Σ behaviorPoints +
  Σ adjustments` with published, exported tables —
  age per aging bucket 0…60 (same bucket values as `receivables/aging.ts`),
  amount tier 0…20, broken promise +15 (the E27 boost), ≥3 touches with zero
  responses +8, recent payment +5, unreliable promiser +10, open dispute
  −100 (SPEC §29), pending promise −25. Every `ReceivableScore` carries its
  `components` (key, points, reason) and flattened `reasons`; the total is
  the plain integer sum, always re-derivable from its reasons. Bands
  (critical ≥70, high ≥45, medium ≥20, else low) are exported thresholds.
- **Ranking — deterministic total order:** collectible before history, score
  desc, amount desc, age desc, receivableId asc — stable under input
  reordering, no clock, no RNG. Duplicate receivable facts, duplicate
  customer facts and mixed-currency batches are refused (R10 discipline).
- **Recommendations (`recommendations.ts`):** one recommended capability per
  receivable from a published first-match matrix (10 named rules —
  `not_collectible`, `dispute_pause`, `live_promise`, `broken_promise`,
  `aged_unresponsive`, `large_aged_exposure`, `unreliable_promiser`,
  `aged_needs_structure`, `consented_self_serve`,
  `no_consent_manual_follow_up`) over
  `prioritize_for_collector | offer_payment_plan | send_payment_link |
  human_review | do_nothing_yet`, each with evidence reasons and a stable
  `rule` key. `createRecommendation` records the fact (caller-supplied id,
  copied score/reasons) and emits `intelligence.recommendationCreated`.
  **F22 boundary:** this lane recommends CAPABILITIES, never executions —
  the next-best-action lane (F22) adds cost/benefit ranking + the F20 policy
  filter on top; no lane imports either way, contracts stay plain data.
- **Feedback loop (`feedback.ts`, H7):** outcomes arrive as plain data
  (`paid | partial | promise_made | escalated | no_response`) and append ONE
  feedback fact each — never edited, never deleted (R3). **R9-style
  idempotence** by `(recommendationId, outcomeKey)`: a replay returns the
  ORIGINAL fact (`replayed: true`) and raises
  `intelligence.duplicateOutcomeObserved` (the at-least-once tripwire, mirroring
  `payments.duplicateCallbackObserved`); a key replayed with a *different*
  outcome is tampering → `INTEL_OUTCOME_CONFLICT`. Outcomes map to a
  deterministic verdict (`effective | partially_effective | ineffective`) and
  `feedbackEffectiveness` / `feedbackEffectivenessByCapability` aggregate the
  log into pure stats (counts + a plain effectiveness ratio, optional
  capability filter, explicit `asOf` time-box — no hidden clock).

## Events (`./events.ts`, envelope `{name, version, aggregateId, occurredAt, payload}`)
`intelligence.priorityComputed` (one scoring run; ranked ids only) ·
`intelligence.recommendationCreated` ·
`intelligence.recommendationOutcomeRecorded` (raw intake fact) ·
`intelligence.feedbackRecorded` (outcome → verdict signal) ·
`intelligence.duplicateOutcomeObserved` (replay tripwire). Dates travel as
ISO-8601 strings; cross-lane ids as opaque Uuids. Payloads are narrow,
serializable and id-only. (Catalog registration in docs/04 stays with the
events-lane owner, per wave-3 precedent.)

## Rules
- Import ONLY from `../shared` + own files. Receivables, customers, promises,
  disputes, consent and cases are referenced by opaque `Uuid` — never
  imported, never dereferenced.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock` (and an explicit `now` for recency checks); every operation
  returns fresh immutable data, inputs are never mutated.
- Stable `DomainError` codes (SCREAMING_SNAKE, `INTEL_*` prefix):
  `INTEL_FACTS_INVALID`, `INTEL_CUSTOMER_FACTS_INVALID`,
  `INTEL_CUSTOMER_FACTS_DUPLICATE`, `INTEL_FACTS_DUPLICATE`,
  `INTEL_CURRENCY_MISMATCH`, `INTEL_CLOCK_INVALID`,
  `INTEL_RECOMMENDATION_INVALID`, `INTEL_CAPABILITY_INVALID`,
  `INTEL_SCORE_INVALID`, `INTEL_REASONS_REQUIRED`, `INTEL_OUTCOME_INVALID`,
  `INTEL_OUTCOME_KEY_REQUIRED`, `INTEL_OUTCOME_CONFLICT`,
  `INTEL_DETAILS_INVALID`, `INTEL_OCCURRED_AT_INVALID`.

## Definition of done
- Scoring component tables (age/amount/behavior), ranking + tie-breaks,
  dispute/promise adjustments, recommendation matrix + precedence, feedback
  idempotence + duplicate tripwire, effectiveness stats over synthetic
  histories, no-mutation pins and event envelope shapes — all table-driven
  tested.
- `npm run typecheck && npm test` green.
