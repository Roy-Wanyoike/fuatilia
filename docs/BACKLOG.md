# BACKLOG — Dispatchable Feature List

Live status board for agents and maintainers. One row = one PR-sized feature.
Phase mapping: waves 1–2 = fund truth, wave 3 = collections ops, wave 4 = intelligence.
Update `Status` as work lands; PRs must reference the issue so it auto-closes.

| ID | Feature | Wave | Issue | Status | Acceptance criteria (short) |
|----|---------|------|-------|--------|------------------------------|
| F1 | Receivables core — Invoice→Receivable split, lifecycle states, aging, write-off ownership (H1) | 1 | #1 | **done** (PR #12) | Pure transition fns; all legal/illegal transitions tested |
| F2 | Payments core — dual-path intake (C2B + STK), idempotency unique keys (C5, R9, K1) | 1 | #2 | **done** (PR #13) | Duplicate callback returns same payment; tripwire event |
| F3 | Reconciliation — Match re-pointed to Payment; multi-invoice representable (C1, R5) | 1 | #3 | **done** (PR #13) | 3-invoices-1-payment scenario test passes |
| F4 | Adjustments — Refund + RefundAllocation (C2, R6), CreditNote + applications (C3, R7), CustomerCreditBalance (C4) | 1 | #4 | **done** (PR #11) | Ceiling rejections tested; overpayment→balance flow |
| F5 | Allocation engine — strategy chain FIFO/explicit/pro-rata on Money.allocate (H3, R1, R2) | 2 | #5 | **done** (PR #15) | Cross-module R1/R2 suite; reversal flow |
| F6 | Event catalog as typed code + outbox contract (envelope, versioning) | 2 | #6 | **done** (PR #16) | All 27 events typed; replay deterministic |
| F7 | Late fee accrual + PaymentPlan schedule engine (H4, H5) | 2 | #7 | **done** (PR #17) | Accrual caps tested; installment generator |
| F8 | Collections cases + actions + exclusivity invariant (H6, R8) | 3 | #8 | **done** (PR #31) | Second open case rejected; dunning consent hook; derived case status |
| F9 | Multi-currency + FX realized gain/loss postings (H2, R10) | 3 | #9 | **done** (PR #28) | Cross-currency settlement blocked without FX posting |
| F10 | Consent registry (DPA 2019) + WhatsApp opt-in + eTIMS numbering hooks (K2–K4) | 2 | #10 | **done** (PR #14) | No dunning without grant; number format reserved |
| F11 | Sub-ledger posting implementation + GL reconciliation job (K5, R4) | 3 | #18 | **done** (PR #29) | Posting matrix enforced; daily reconciliation job; reversals append-only |
| F12 | Promise-to-pay tracking + dunning orchestration (K2) | 3 | #19 | **done** (PR #33) | Promise lifecycle; consent-checked sends; escalation ladder |
| F16 | Disputes lifecycle — pause collections while disputed (SPEC §29) | 3 | #20 | **done** (PR #27) | Disputed receivable pauses automated dunning; resolution resumes |
| F17 | Payment links — single/partial-use links with lifecycle (SPEC §28) | 3 | #21 | **done** (PR #30) | Token redemption bounds enforced; single-use rejected twice |
| F18 | Communications domain — conversations, messages, delivery attempts, templates (SPEC §26) | 3 | #22 | **done** (PR #32) | Consent-before-send; versioned templates; retry → dead-letter |
| F13 | Collections priority scoring + recommendation feedback loop (H7) | 4 | #23 | **done** (PR #38) | Read-only over events; outcome feedback recorded; explainable |
| F14 | Segment strategies + reporting projections (SPEC §19/§20/§66) | 4 | #24 | **done** (PR #39) | Projections only; no fund-truth writes; predictions labeled |
| F15 | Daraja adapter conformance suite (callback fixtures, at-least-once replay) | 4 | #25 | **done** (PR #45) | Fixture replay is idempotent end-to-end |
| F19 | Customer behavior profiles + anomaly detection (SPEC §4/§24) | 4 | #26 | **done** (PR #40) | Metrics fixture-tested; explainable anomaly events |
| F20 | Policy engine — deterministic allow/deny/require-approval governance for automated actions (VISION §3.9) | 5 | #34 | **done** (PR #41) | Every automated action evaluated; refusals carry machine-readable reasons + audit events |
| F21 | Agent capability layer — financial-state projection, receivables priorities, collections recommendations (VISION §3.8) | 5 | #35 | **done** (PR #44) | Capability queries (not CRUD); every answer carries evidence refs; no fund-truth writes |
| F22 | Next-best-action engine — explainable action selection with cost/benefit + policy filter (VISION §3.4) | 5 | #36 | **done** (PR #42) | Ranks actions with reasons; policy-gated; "do nothing" representable; feedback hook |
| F23 | Explainable financial memory — event-derived behavioral features with evidence trail (VISION §3.3/§3.7) | 5 | #37 | **done** (PR #43) | Cadence/reliability/channel/exposure projections; every claim traceable to events |
| F24 | Auth & RBAC domain core — users, roles, permission matrix, API keys, sessions (SPEC §34/§35) | 6 | #46 | **done** (PR #49) | Deny-by-default with audited denials; escalation guard; suspension cascade; no plaintext secret at rest |
| F25 | Webhook subscriptions + signing + delivery domain — developer platform contracts (SPEC §53) | 6 | #47 | **done** (PR #50) | Revoked endpoints plan nothing; idempotent enqueue + sticky verification ledger; secret never in payloads |
| F26 | Cross-border payments domain — corridors, FX quotes with expiry, transfer intents, fees (SPEC §33) | 6 | #48 | **done** (PR #51) | No cent created or destroyed; idempotent submit replay; quote frozen at authorization; no fund-truth writes |
| F27 | Maker-checker approval workflows — org policies, quorum, apply evidence (SPEC §36) | 7 | #52 | **done** (PR #56) | Self-approval refused; distinct-approver quorum; policies configurable per org; never executes the operation |
| F28 | Unified append-only audit trail — redaction + hash chain (SPEC §37) | 7 | #53 | **done** (PR #57) | Every §37 field representable; append-only at the type level; tamper detection; AI actions auditable |
| F29 | USSD session workflows for low-tech channels (SPEC §31) | 7 | #54 | **done** (PR #58) | Five flows over injected ports; screen budget enforced; i18n keys never copy; no fund-truth writes |
| F30 | HTTP transport kernel — /v1 router, auth middleware, error mapping (SPEC §38) | 7 | #55 | **done** (PR #59) | Zero new deps; consistent envelope + pagination; 401/403 semantics; every denial audited |
| F31 | Mount receivables/payments/collections resources on the /v1 kernel route table | 8 | #60 | **done** (PR #62) | Wire→lane adapters only; vocabulary permission per row; shape→lookup→decision ordering; R8/K2 refusals status-mapped; org-scoped 404s |
| F32 | File-backed AuthStore persistence adapter — JSONL journal, crash-atomic snapshots, replay-on-boot | 8 | #61 | **done** (PR #63) | Zero new deps; quarantine-not-throw replay; snapshot tmp+rename; sequence continuity across restarts; no plaintext at rest |

**Dispatch rule:** a feature enters *in-progress* only when an agent owns its module lane
(no cross-module imports); wave N+1 starts after its dependencies merged to `main`.

## Wave-1 dispatch — COMPLETE (merged 2026-09-02)
- PR #12 `feat/receivables-core` → #1 closed (102 tests)
- PR #13 `feat/payments-reconciliation` → #2 + #3 closed (91 tests)
- PR #11 `feat/adjustments-core` → #4 closed (82 tests)
- Combined main: 283/283 tests green (Node 22.21.1 + Node 24.19, typecheck clean)

**Wave-2 dispatch — COMPLETE (merged 2026-09-02):** PR #15 allocation (#5), PR #16 events (#6), PR #17 late fees+plans (#7), PR #14 consent/eTIMS (#10). Combined main: 607/607 tests green.

## Wave-3 dispatch — collections ops (2026-09-03)

Audited against docs/SPEC.md (master build requirements) and the design review: the remaining
collections-ops features are F8 + F9 (carried over from wave 2) and F11, F12, F16, F17, F18.
All seven ship in parallel — each owns one fresh module lane, no cross-lane imports:

- `feat/collections-cases` → #8 (F8) — **merged as PR #31**

- `feat/fx-postings` → #9 (F9) — **merged as PR #28**
- `feat/ledger-postings` → #18 (F11) — **merged as PR #29**
- `feat/promises-dunning` → #19 (F12) — **merged as PR #33**

- `feat/disputes` → #20 (F16) — **merged as PR #27**
- `feat/payment-links` → #21 (F17) — **merged as PR #30**

- `feat/communications` → #22 (F18) — **merged as PR #32**


## Wave-4 dispatch — intelligence (queued after wave-3 merge)

- `feat/collections-intelligence` → #23 (F13) — new lane `src/domain/intelligence/`
- `feat/reporting-projections` → #24 (F14) — new lane `src/domain/projections/`
- `feat/daraja-conformance` → #25 (F15) — new lane `src/adapters/daraja/`
- `feat/behavior-profiles` → #26 (F19) — new lane `src/domain/behavior/`

## Wave-5 dispatch — agent-ready platform (queued after wave-4 merge)

Derived from [`docs/VISION.md`](VISION.md) (the 10–15 year thesis: Fuatilia as the receivables
intelligence layer that AI agents, payment rails, banks and ERPs plug into). Four fresh lanes,
all domain-pure and parallel-safe — no HTTP transport yet (SPEC §34/35 deferral stands; these
are the capability layers the transport will expose):

- `feat/policy-engine` → F20 — new lane `src/domain/policy/` — deterministic
  allow/deny/require-approval governance with machine-readable reasons + audit events; the
  safety layer between AI and financial execution.
- `feat/agent-capabilities` → F21 — new lane `src/domain/agent/` — capability queries
  (financial-state, receivables priorities, collections recommendations) with evidence refs;
  read-only over events/projections.
- `feat/next-best-action` → F22 — new lane `src/domain/nba/` — explainable action ranking
  (call/WhatsApp/SMS/plan/link/review/escalate/do-nothing) with cost/benefit + policy filter
  and feedback hook.
- `feat/financial-memory` → F23 — new lane `src/domain/memory/` — event-derived behavioral
  features (payment cadence, promise reliability, channel preference, exposure) with an
  evidence trail behind every claim.

**Vision note (2026-09-03):** the owner ratified the agent-ready platform direction —
README Design Principle 5 ("Agent-ready by design") added; `docs/VISION.md` records the
three-layer platform (Financial Truth / Intelligence / Execution + Business Memory + Agent
Interface), the deterministic-vs-AI divide, ecosystem position (SharkPay moves money,
Fuatilia understands & collects; MjengoOS and future SaaS embed "Collections powered by
Fuatilia"), and the staged monetization layers.

Deferred (deliberately not scheduled — see SPEC §2/§33): cross-border payments, embedded
finance, field/offline mobile, USSD APIs, developer platform (§53), auth/RBAC backend
(§34/35 — domain core stays pure; API/auth layer lands after the domain is complete).

**Wave-3 progress note (2026-09-03):** first dispatch delivered F9 (#28), F11 (#29), F16 (#27); five agents hit runtime limits, four re-dispatched (F8, F12, F17, F18). GitHub Actions runners were failing repo-wide (job startup `BlobNotFound`, including pre-existing main pushes) — local `typecheck + full suite` on Node 24 used as the verification gate for merges.

**Wave-3 dispatch — COMPLETE (merged 2026-09-03):** PR #30 payment links (#21), PR #31 collections cases (#8), PR #32 communications (#22), PR #33 promises+dunning (#19), plus earlier PR #27 disputes (#20), PR #28 FX (#9), PR #29 ledger (#18). Combined main: 1044/1044 tests green (Node 24.19, typecheck clean).

**Wave-4 dispatch — COMPLETE (merged 2026-09-03):** PR #38 collections intelligence (#23, +76 tests), PR #39 projections (#24, +184), PR #40 behavior profiles (#26, +98), PR #45 daraja conformance (#25, +37). Four agents hit runtime limits mid-run; the dispatcher audited/completed the interrupted drafts and verified every lane locally before merge.

**Wave-5 dispatch — agent-ready platform — COMPLETE (merged 2026-09-03):** PR #41 policy engine (#34, +214 tests), PR #42 next-best-action (#36, +67), PR #43 financial memory (#37, +130), PR #44 agent capabilities (#35, +109). Same pattern: subagent infra timeouts interrupted the first pass; the dispatcher completed and verified the lanes (fixing draft defects — scorer-bar misalignments in agent-lane specs, world/record contract break in the daraja simulator, branded-Uuid reconciliation types) before opening/merging each PR.

**Combined main after waves 4–5: 1959/1959 tests across 77 suites, typecheck clean (Node 24.19).**
All 23 backlog features (F1–F23) are now merged. Remaining deferrals are deliberate (SPEC §2/§33/§34/§35): HTTP/API transport + auth, cross-border payments, embedded finance, field/offline mobile, USSD, developer platform — the domain core is complete and the API layer can now be built on top of it.

## Wave-6 dispatch — platform services (2026-09-03)

The three deferrals that were domain-representable, scheduled once the F1–F23 core was
complete. Same discipline: one lane, one PR, one issue, full local gate before push.

- `feat/auth-rbac` → #46 (F24) — lane `src/domain/auth/` — **merged as PR #49**
- `feat/webhook-platform` → #47 (F25) — lane `src/domain/webhooks/` — **merged as PR #50**
- `feat/cross-border` → #48 (F26) — lane `src/domain/crossborder/` — **merged as PR #51**

**Wave-6 dispatch — COMPLETE (merged 2026-09-03):** PR #49 auth & RBAC (#46, +95 tests),
PR #50 webhooks developer platform (#47, +57), PR #51 cross-border (#48, +63). The first
agent pass was interrupted by subagent runtime limits; the dispatcher completed the draft
lanes, fixed three draft spec defects (fee arithmetic expectations vs the flat+bps
contract, replay semantics, cascade fixtures), and verified every gate locally before
opening/merging each PR.

**Combined main after wave 6: 2174/2174 tests across 91 suites, typecheck clean (Node 24.19).**
Every backlog feature including the previously-deferred domain work (F1–F26) is merged.
The only remaining roadmap item is the HTTP/API transport (wave 7) that mounts the
completed capability layers — auth (#46) was its last domain dependency.

## Wave-7 dispatch — governance + transport (2026-09-04)

The final domain gaps (maker-checker §36, unified audit §37, USSD §31 — never
scheduled before because the F1–F26 core came first) plus the transport that
mounts everything. Four disjoint lanes, zero file overlap:

- `feat/approvals` → #52 (F27) — lane `src/domain/approvals/` — **merged as PR #56**
- `feat/audit-trail` → #53 (F28) — lane `src/domain/audit/` — **merged as PR #57**
- `feat/ussd-workflows` → #54 (F29) — lane `src/domain/ussd/` — **merged as PR #58**
- `feat/http-kernel` → #55 (F30) — lane `src/adapters/http/` — **merged as PR #59**

**Wave-7 dispatch — COMPLETE (merged 2026-09-04):** PR #56 approvals (+67 tests),
PR #57 audit trail (+78), PR #58 USSD (+94), PR #59 HTTP kernel (+118). Both agent
passes were stopped by the same subagent infra timeouts documented in waves 3–6;
the dispatcher completed every lane from the drafted work, fixing draft-spec defects
(threshold-currency validation order, in-loop org isolation, purity of the matched
policy copy, terminal-cancel refusal-as-value, optional terminal options, back-key
trail popping, reserved-key precedence, seed granter-permission expansion, the
SESSION_* error-family mapping) before opening and merging each PR.

**Combined main after wave 7: 2531/2531 tests across 106 suites, typecheck clean (Node 24.19).**
All 30 backlog features (F1–F30) are merged. The domain core, governance layer and the
first transport surface are complete; further waves mount more /v1 resources on the
kernel's route table without touching kernel files.

## Wave-8 dispatch — transport completion + first persistence adapter (2026-09-04)

The kernel's route table gained its first resource mounts and the documented store seam
gained its first real adapter. Two file-disjoint lanes:

- `feat/route-mounts` → #60 (F31) — lane `src/adapters/http/` (server.ts append-only) — **merged as PR #62**
- `feat/persistence` → #61 (F32) — lane `src/adapters/persistence/` — **merged as PR #63**

**Wave-8 dispatch — COMPLETE (merged 2026-09-04):** PR #62 resource route mounts (+87 tests),
PR #63 file-backed auth persistence (+47). The subagent infra outage persisted (context
deadline exceeded on both dispatches); the dispatcher completed both lanes from the drafted
work, fixing draft defects before merging: shape-validation-before-lookup ordering in the
open handler, URL-safe opaque action ids (the lane's `<caseId>/actions/<n>` default embeds
slashes and cannot travel as a path parameter), wire-level priority enum validation, and
the four missing persistence spec files (journal/replay/filestore/seam).

**Combined main after wave 8: 2665/2665 tests across 114 suites, typecheck clean (Node 24.19).**
All 32 backlog features (F1–F32) are merged. The domain core, governance, transport and the
first persistence adapter are complete; next natural steps are the remaining /v1 resource
mounts (auth sessions admin surface aside: ledger, adjustments, communications) and a
persistence adapter per resource store as the platform hardens toward deployment.

## Wave-9 dispatch — PRODUCTION WAVE 1 (2026-09-04)

The domain backlog being complete is not product completion. Wave 9 started the platform
transformation with four file-disjoint production lanes, each with its own GitHub issue
(#64–#67) and PR (#68/#70/#69/#71), merged into main as `aa98bbe`/`35adfa8`/`5005eed`/`74d54ae`:

- `prod/audit-roadmap` → #64 (PR #68) — **docs/** `PRODUCTION_AUDIT.md` (code-verified
  classification of every capability with file-path evidence), `PRODUCT_ROADMAP.md`
  (P0–P5 with dependency graph; TS domain = behavioral spec, Go = production port),
  `ENGINEERING_STATUS.md` (honest status board; documents the account-billing CI lock
  and the local-green merge gate), `DECISIONS.md` (ADR-0001..0005).
- `prod/go-money-core` → #65 (PR #70) — **backend-go/**: `pkg/money` (int64 minor units,
  overflow-checked math, exact largest-remainder allocation where parts sum to the
  original — R1/R2, single-rounding-point banker's rounding) + `pkg/idempotency`
  (R9/C5 first-write-wins registry). Zero third-party deps. The conformance suite
  ports TS scenarios with identical inputs/expected outputs (money.spec 8/8,
  allocation R1/R2 rows 13/15, strategies pro-rata 8/8) — the TS domain is the
  behavioral specification, the Go port must prove parity. `go.yml` CI included.
- `prod/pg-schema` → #66 (PR #71) — **db/**: 14 forward-only migrations (~30 tables)
  with R1–R10/§37/K5 encoded AS DDL (append-only triggers, deferrable COMMIT proofs,
  composite org-scoped FKs, R8 partial-unique via denormalized marker), plus a real
  validation harness (`validate.sh`: throwaway PostgreSQL 16 cluster → migrate ×2 →
  25 invariant smoke assertions, ALL GATES GREEN) and `docs/DATA_MODEL.md`.
  `db.yml` CI (postgres:16 service) included.
- `prod/openapi-contract` → #67 (PR #69) — **api/openapi/fuatilia.v1.yaml** (OpenAPI 3.1,
  22 operations ≡ 22 mounted route rows, envelope/error/pagination components,
  x-required-permission cross-checked against the roles vocabulary) +
  `scripts/validate_openapi.py` (validator + consistency gate) + `docs/API_STATUS.md`.

**Combined main after wave 9 (74d54ae): 2665/2665 TS tests / 114 suites, typecheck clean;
Go gofmt/vet clean + tests race-green; db validate ALL GATES GREEN (25/25); OpenAPI PASS.**
Next natural waves: 10 — Go /v1 API kernel over `backend-go` + per-store PostgreSQL
persistence adapters; 11 — Next.js frontend foundation against the OpenAPI contract
(Collections Command Center). GitHub Actions remains blocked by the account billing
lock; local gates are the documented merge gate and all three new workflows activate
automatically once billing is resolved.

## Wave 10 — Production wave 2 (merged 2026-09-04)

- `prod/outbox-relay` → #74 (PR #78) — **backend-go/** `cmd/worker` + `internal/outbox`:
  the ADR-0003 relay draining `outbox_events` into the `FUATILIA_EVENTS` JetStream
  stream — at-least-once (publish-then-mark in one org-batch tx), per-org ordered
  (advisory xact lock + SKIP LOCKED), Nats-Msg-Id dedup, grammar-poison + attempt-budget
  DLQ with a replay CLI (poisons / time range). Proven against real PostgreSQL 16.4 +
  real embedded JetStream: crash-safety via the `afterPublish` fault-injection seam,
  double-publish-free concurrency (two relays, 60 events), 100-event ordered soak,
  all 27 catalog names (E01–E27) pinned byte-for-byte. Envelope fidelity: payload =
  the jsonb column's canonical text appended byte-for-byte, money never reinterpreted.
- `prod/deploy-foundation` → #75 (PR #77) — **deploy/**: multi-stage distroless
  `backend-go/Dockerfile` (--target api / --target worker, non-root, pinned bases),
  `docker-compose.yml` (postgres:16 + nats:2.11 jetstream + one-shot migrate job +
  api + worker, only api publishes a port, fail-fast secret interpolation),
  `.env.example` (12-key contract, no default credentials), `docs/DEPLOY.md`
  (quickstart, backup/restore, upgrade path, explicit NOT-covered ledger),
  `scripts/validate_deploy.py` (7 static gates, mutation-proven; strict mode goes
  green when #72's `cmd/api` lands).
- `prod/frontend-foundation` → #76 (PR #79) — **frontend/**: Next.js 15 / React 19
  app-router workspace (strict TS, Tailwind, TanStack Query/Table, zod,
  react-hook-form) consuming the merged OpenAPI contract: typed /v1 client with
  tagged refusals + strict schemas, error-code union pinned set-equal to the spec,
  BFF proxy relaying the httpOnly session cookie, capability-aware shell, and the
  Collections Command Center v1 — seven cards each with real loading/empty/error
  states (dead-backend honesty: no fabricated rows anywhere). 75 frontend tests,
  production build green.

**Combined main after wave 10 (fc64a76): TS 2665/2665 / 114 suites + typecheck clean;
Go race-green (money, idempotency, outbox); OpenAPI PASS (22 ≡ 22); deploy validator
PASS (--allow-pending-lanes); frontend build green + 75/75.**

Still open (carried to wave 11): #72 Go /v1 API kernel (pgx-based vertical slice; the
hand-rolled wire-protocol draft was rejected — use pgxpool) and #73 PostgreSQL
persistence adapters (binding constraint discovered mid-build: the `AuthStore`/
`ResourceStore` seams are SYNCHRONOUS — the PG adapters need a cache-first sync facade
with an async durable flusher, the filestore's sync-fs analog; `client.ts` +
`schema-map.ts` drafts are complete and reviewed, `authstore.ts` needs the redesign).
