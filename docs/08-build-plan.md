# 08 — Build Plan

Three phases, in dependency order. The ordering principle comes from the review: **build fund
truth before collections, and collections before intelligence** — the smart layer is worthless
(and dangerous) on top of a ledger that cannot answer "what does this customer owe".

## Phase 1 — Fund truth (waves 1–2)
Make the money story correct and auditable end-to-end.

- **Wave 1 (parallel, dispatched):** receivables core (#1), payments core + idempotency (#2),
  reconciliation re-pointing (#3), adjustments (refunds, credit notes, credit balance) (#4).
- **Wave 2 (queued):** allocation engine + strategy chain (#5), typed event catalog + outbox
  contract (#6), late fees + payment plans (#7), collections cases + exclusivity (#8),
  multi-currency FX postings (#9), consent registry + eTIMS hooks (#10).

## Phase 2 — Collections operations (wave 3 start)
Case workflows, dunning orchestration with consent checks, promise-to-pay tracking, aging
projections, sub-ledger posting implementation + GL reconciliation job (K5).

## Phase 3 — Intelligence
Priority scoring, propensity models, feedback loop (H7), segment strategies, reporting
projections. Strictly read-only over the event store.

## Definition of done (every feature, no exceptions)
1. Domain logic is pure (no I/O in the core); adapters are a later, separate concern.
2. Tests cover every legal and illegal transition; `npm run typecheck && npm test` green locally.
3. CI green on Node 22 and 24.
4. Work ships as a **pull request** from a feature branch — never direct to `main`.
5. A PR merges only when the feature is **done, tested, verified, and working** — review diffs,
   not vibes. Squash-merge; branch auto-deletes.
6. Backlog status row updated and the linked issue auto-closes via `Closes #N`.
