# Next-best-action (NBA) module — wave 5 (issue #36, VISION §3.4)

Answers: *"what is the most effective action we can take right now to
maximize recovery while respecting customer preferences and business
policy?"* — with a **transparent, deterministic ranking**, a **policy
filter** the engine can never bypass, and a **feedback hook** so historical
collection outcomes can later tune the weights. Recommendation only: no
channel sends, no fund movement.

## Scope
- **Input** — the plain-data `NbaFeatureBundle` (per receivable/customer):
  `amountMinor` + `currency`, `ageDays`, `riskClass`, `paymentHistory`
  (onTime/late/unpaid counts), `promise` (state + `reliabilityPermill`),
  `disputeOpen`, `channelPreferences` (call/whatsapp/sms →
  `opted_in|neutral|opted_out`), `recentActions` (`{action, daysAgo}` —
  counts + recency come **in the bundle**), `priorOutcomes`. Projected by
  the adapter from other lanes; cross-lane ids are opaque `Uuid`s and no
  other lane is imported (cf. F19/F21/F23 — separate lanes, own shapes).
- **Candidates (fixed, first-class):** `call | whatsapp | sms |
  offer_payment_plan | send_payment_link | human_review | escalate |
  do_nothing` — `do_nothing` is a real candidate and can win.
- **Transparent scoring** — identical expression per candidate, integer-only
  (bps / ‰ / minor units), every intermediate value exposed (exact split
  identity — no float drift at any valid amount):
  `score = expectedRecovery × channelFit − cost − fatigue`
  1. `expectedRecovery = floor(floor(amountMinor × recoveryRateBps / 10 000) × signalBps / 10 000)`
     where `signalBps` folds (fixed order, per action class): history
     (4000–13000 by on-time share, 10000 when empty) → risk (low 11000 /
     moderate 10000 / elevated 8500 / high 6500) → promise (none 10000 /
     fulfilled 11000 / broken 12000 / pending 2500 + 7500×(1−reliability))
     → dispute (open: 3000 customer-facing, human_review 15000, escalate
     8000) → age (customer-facing decay 100×days to a 4000 floor; escalate
     instead gets 5000 fresh / 12000 at 30d / 15000 at 60d; human_review
     risk 8000–14000 — riskier means look-sooner) → opt-out (any prior
     `opted_out` outcome ⇒ 0 for customer-facing automation — consent is
     never implied, K2/DPA).
  2. `channelFit` (‰): opted_in 1000 / neutral 600 / opted_out 0; plans and
     links ride the best digital channel (whatsapp | sms); internal actions
     are channel-free (1000‰).
  3. minus `costMinor` (per-action operating-cost proxy), minus
     `fatigueCount × fatiguePenaltyMinor` (recent same-type actions within
     `fatigueWindowDays`), minus `approvalFrictionMinor` when policy says
     `requires_approval`.
- **Weights exposed** — `DEFAULT_NBA_WEIGHTS` + `DEFAULT_ACTION_CAPS` ship
  as pure configuration (replaceable via `RankOptions`); the plan carries
  the `weights` and `caps` IN FORCE, and each `NbaScoredCandidate` carries
  `components` (every intermediate number) and `reasons` (human-readable
  derivation lines). Explainability > opaque score.
- **Policy filter (VISION §3.9)** — `NbaPolicyDecision` (minimal local
  F20-contract shape): `{ action, decision: allow|deny|requires_approval,
  reasonCode }`. `deny` excludes the candidate (visible as `denied`, denial
  recorded in its reasons and in the plan's `policyEvidence` — when the top
  action is denied the NEXT-BEST is recommended);
  `requires_approval` keeps the candidate runnable but downgrades it by the
  approval friction; silence counts as allow. **NBA never bypasses policy**
  — if every candidate (incl. `do_nothing`) is denied, `recommended` is
  `null`: "no legal action" is a possible answer.
- **Fatigue + caps** — per-action `fatiguePenaltyMinor` per recent occurrence
  within the window; `DEFAULT_ACTION_CAPS` exhausts an action at its cap
  (`fatigue_capped`, excluded from recommendation, still listed);
  `do_nothing` can never be capped, so a fully exhausted slate degrades
  gracefully to it.
- **Tie-break** — equal scores rank by the canonical `NBA_ACTIONS` order
  (stable, documented). Same bundle + same clock → identical plan
  (`planId` derived deterministically from org/customer/receivable/
  amount/instant).
- **Feedback hook** (`feedback.ts`) — `recordOutcome(facts, plan, outcome,
  occurredAt, clock)`: append-only, idempotent on unique(planId, outcome);
  a replay returns the ORIGINAL facts unchanged and fires
  `nba.duplicateOutcomeObserved` (R9 pattern). Outcomes:
  `paid | partial | promise_made | no_response | escalated | opted_out`.
  `actionEffectiveness(facts)` derives deterministic per-action stats
  (counts per outcome + `successRatePermill` over paid/partial/promise_made)
  — pure replay, input never mutated.
- **Events** (`events.ts`, envelope `{name, version, aggregateId,
  occurredAt, payload}`): `nba.recommendationCreated` (narrow,
  evidence-refed: planId, recommended action + score, ranked alternatives,
  policy denials) · `nba.actionOutcomeRecorded` ·
  `nba.duplicateOutcomeObserved`. Dates as ISO-8601, money as safe-integer
  minor units, ids opaque. Catalog registration in docs/04 stays with the
  events-lane owner (as every prior lane).

## Rules
- Import ONLY from `../shared` + own files. No I/O, no RNG, no
  `Date.now()` — time comes from the injected `Clock`; recency travels in
  the bundle as whole `daysAgo`. Pure data-in/data-out, fresh copies
  everywhere, inputs never mutated.
- Stable `DomainError` codes (`NBA_*` prefix): `NBA_ACTION_INVALID`,
  `NBA_ID_REQUIRED`, `NBA_AMOUNT_INVALID` (also above
  `NBA_MAX_SCORABLE_AMOUNT_MINOR`, the scoring safe-integer headroom),
  `NBA_CURRENCY_INVALID`, `NBA_AGE_INVALID`, `NBA_RISK_INVALID`,
  `NBA_HISTORY_INVALID`, `NBA_PROMISE_STATE_INVALID`,
  `NBA_RELIABILITY_INVALID`, `NBA_DISPUTE_FLAG_INVALID`,
  `NBA_CHANNEL_PREF_INVALID`, `NBA_RECENT_ACTION_INVALID`,
  `NBA_PRIOR_OUTCOME_INVALID`, `NBA_WEIGHTS_INVALID`, `NBA_CAPS_INVALID`,
  `NBA_POLICY_DECISION_INVALID`, `NBA_POLICY_DECISION_DUPLICATE`,
  `NBA_CLOCK_INVALID`, `NBA_OUTCOME_INVALID`, `NBA_OCCURRED_AT_INVALID`,
  `NBA_FACT_INVALID`, `NBA_PLAN_INVALID`, `NBA_PLAN_HAS_NO_RECOMMENDATION`.

## Definition of done
- Ranking tables over synthetic bundles (deterministic tie-breaks),
  do_nothing-wins tables, channel-fit + fatigue-penalty tables, policy
  deny/requires_approval paths, cap exhaustion, feedback idempotence +
  duplicate tripwire, effectiveness stats, determinism/no-mutation pins,
  event envelope shape — all table-driven tested.
- `npm run typecheck && npm test` green.
