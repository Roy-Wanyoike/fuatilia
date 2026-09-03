# Behavior lane — wave 4 (issue #26, SPEC §4 + §24)

Owns the customer **behavior memory foundation**: point-in-time behavior
profiles built from plain-data fact histories, transparent drift/trajectory
classification between profiles, and deterministic explainable anomaly
detection. This is the substrate VISION §3.3 ("customer financial memory") is
built on — wave-5 F23 ("explainable financial memory", issue #37) layers its
claims on top of these shapes without breaking changes.

## Scope

- **`profile.ts`** — `buildBehaviorProfile(orgId, customerId, facts, asOf)`:
  one frozen, evidence-backed snapshot per customer.
  - Inputs are PLAIN DATA (`BehaviorFacts`), projected by the adapter from
    other lanes' event streams — this lane never imports other lanes:
    - `payments` (paymentId, receivableId, amountMinor, dueDate, settledAt,
      partial) → cadence: count, min/median/p90 days-to-pay over **integer
      UTC days** (settledAt − dueDate; negative = early; even-count median is
      the mean of the two middles; p90 is R-7 linear interpolation), plus
      onTime/late/partial counts;
    - `promises` (outcome `kept | broken | expired | pending` — the promises
      lane's `fulfilled` maps to `kept` at the adapter, `resolvedAt` decided
      or null) → reliability: kept/broken/expired/pending counts + rate =
      kept / decided (null when nothing decided);
    - `disputes` (openedAt, resolvedAt?) → total / resolved / openCount +
      `currentlyOpen`;
    - `communications` (channel, direction, sentAt) → inbound vs outbound
      counts per channel (channels sorted a→z) + overall `responseRate`
      (inbound share; null when no messages);
    - `allocations` (amountMinor, allocatedAt) → count + totalAmountMinor.
  - **Point-in-time**: facts observed after `asOf` are invisible (payments
    settled later, promises decided later, disputes opened later, messages
    sent later, allocations made later) — this makes before/after drift
    well-defined.
  - **Explainability is a hard requirement (H7)**: every metric block
    carries `evidence` — `EvidenceRef { kind, id }` pointing at the source
    aggregates. `lastActivityAt` is the latest observed fact instant (null
    for empty history).
  - Determinism: same inputs → deeply-equal output; the profile (and every
    nested block) is `Object.freeze`d — mutation attempts throw `TypeError`.
  - Empty history is a VALID, claim-less profile (counts 0, stats null).

- **`drift.ts`** — `compareProfiles(before, after, thresholds?)`:
  `improving | stable | deteriorating` per dimension via **transparent
  threshold rules** (exposed defaults, partial overrides, `BEHAV_THRESHOLD_INVALID`
  on malformed values):
  - `payment_cadence`: Δ median days-to-pay — faster = improving;
  - `promise_reliability`: Δ kept-rate — up = improving;
  - `disputes`: Δ openCount — up = deteriorating;
  - `responsiveness`: Δ inbound response share — down = deteriorating.
  A delta exactly at the threshold is NOT stable (comparison is ≥/≤).
  `null` history on either side ⇒ `stable` + "insufficient history" reason
  (never a fabricated trajectory). **Overall = worst-of** (any deteriorating
  ⇒ deteriorating; else any improving ⇒ improving; else stable) with the
  driving dimensions' reasons. Profiles must be same (org, customer) and
  chronologically ordered (`BEHAV_PROFILE_MISMATCH` /
  `BEHAV_PROFILE_ORDER_INVALID`).

- **`anomaly.ts`** — `detectAnomalies(orgId, customerId, facts, clock, options?)`:
  deterministic rule-based detectors, NO opaque scores; every record carries
  type, stable `rule` id (`BEHAV_RULE_*`), severity (`low|medium|high`),
  evidence refs, measured numbers, the exact thresholds in force, a
  human-readable explanation, and `detectedAt` (injected Clock):
  1. `cadence_deterioration` — recent-window median days-to-pay vs baseline
     (fires at +trigger; severity escalates at medium/high days);
  2. `promise_break_after_streak` — last decided promise broken after ≥
     `promiseMinStreak` consecutive kept (high at `promiseStreakHigh`);
  3. `partial_payment_pattern` — partial share jumped ≥ `partialRateIncrease`
     above baseline (medium when every recent payment is partial, else low);
  4. `silence_after_promise` — pending promise ≥ grace days past promised
     date with no inbound message AND no settled payment since (medium/high
     by days past);
  5. `dispute_spike` — ≥ `disputeSpikeMin` disputes opened in the window
     (high at `disputeSpikeHigh`).
  Fixed emission order (1→5; silence emits per silent promise ordered by
  promisedDate then promiseId). `options.asOf` decouples the analysis
  instant from the Clock; thresholds validate monotonically
  (`BEHAV_THRESHOLD_INVALID`).

- **`events.ts`** — repo-envelope lane events
  (`{ name, version: 1, aggregateId, occurredAt, payload }`, ISO dates,
  narrow serializable payloads):
  `behavior.profileBuilt` (narrow metric summary + evidenceCount),
  `behavior.trajectoryChanged` (from/to + per-dimension verdicts + reasons),
  `behavior.anomalyDetected` (rule, severity, evidence, measured,
  thresholds). `aggregateId` is the customer — a profile/trajectory/anomaly
  is a per-customer fact.

## Rules

- Import ONLY from `../shared` + own files. Payments, promises, disputes,
  communications and allocations are opaque ids and caller-projected facts.
- Pure functions only: no I/O, no RNG, no `Date.now()` — time comes from the
  injected `Clock` (and `asOf`); day arithmetic is UTC-day-index based so day
  boundaries are deterministic and DST-free.
- Outputs are frozen plain data — extensible by ADDITIVE fields only, so
  wave-5 F23 can extend the contract without breaking consumers.
- Stable `DomainError` codes (SCREAMING_SNAKE, `BEHAV_*` prefix):
  `BEHAV_ORG_ID_INVALID`, `BEHAV_CUSTOMER_ID_INVALID`, `BEHAV_AS_OF_INVALID`,
  `BEHAV_FACTS_INVALID`, `BEHAV_PAYMENT_FACT_INVALID`,
  `BEHAV_PROMISE_FACT_INVALID`, `BEHAV_DISPUTE_FACT_INVALID`,
  `BEHAV_COMMUNICATION_FACT_INVALID`, `BEHAV_ALLOCATION_FACT_INVALID`,
  `BEHAV_AMOUNT_INVALID`, `BEHAV_TOTAL_AMOUNT_INVALID`,
  `BEHAV_PERCENTILE_INVALID`, `BEHAV_PROFILE_INVALID`,
  `BEHAV_PROFILE_MISMATCH`, `BEHAV_PROFILE_ORDER_INVALID`,
  `BEHAV_THRESHOLD_INVALID`, `BEHAV_CLOCK_INVALID`.
- Catalog registration for `behavior.*` (docs/04) stays with the events lane
  owner, matching wave-3 precedent.

## Design-for-F23

Keep profile/anomaly/trajectory shapes **plain-data, id-opaque and
additively extensible**: F23 ("explainable financial memory") will derive
its claims from these same fact histories and evidence refs — it must never
need to import another lane or rewrite this one.

## Definition of done

- Table-driven tests: cadence order statistics (empty/single/even/odd, p90
  interpolation, ±1ms UTC day boundaries), reliability/dispute/responsiveness
  tables, asOf point-in-time filtering, determinism + immutability pins,
  no-mutation pins, drift threshold tables per dimension + worst-of overall,
  anomaly fire/no-fire boundaries + severity ladders + evidence presence,
  event envelope shapes, validation error tables.
- `npm run typecheck && npm test` green.
