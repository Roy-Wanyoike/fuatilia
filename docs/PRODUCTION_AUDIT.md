# PRODUCTION_AUDIT — Fuatilia at `c65ffba` (post-wave-8)

> **Scope:** verified production readiness of the repository at `origin/main` commit
> `c65ffba` ("docs: wave-8 complete — /v1 resource mounts + file-backed auth persistence
> merged; 2,665 tests / 114 suites").
>
> **Method:** every claim below was re-verified against the working tree — not trusted from
> docs. Domain lanes were spot-verified against their spec files; the suite was re-run
> locally; route tables, adapters and infra files were enumerated directly.
>
> **Companion docs:** [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) (the plan to close these
> gaps), [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md) (status board),
> [DECISIONS.md](DECISIONS.md) (architecture ADRs).

---

## 1. Executive summary

**Fuatilia is a completed financial domain engine — not yet a production platform.**

The domain core is genuinely, verifiably complete: 32/32 backlog features (F1–F32) are merged
([docs/BACKLOG.md](BACKLOG.md)), the suite is green at the audited commit — **2,665 tests
across 114 suites, `npm run typecheck` clean on Node 24** — and the invariants R1–R10
([docs/07-invariants.md](07-invariants.md)) are enforced in code with table-driven tests, not
merely documented.

But the "platform" layers that turn a domain engine into a deployable product are largely
absent, and the absence is verifiable in the tree:

- **No Go backend** — `backend/` does not exist and there is no `go.mod` anywhere in the
  repository; SPEC §41/§55 mandate a Go production core (`docs/SPEC.md` §41 "Backend:
  Mandatory: Go", §55 "GO PROJECT STRUCTURE").
- **No frontend** — no `frontend/` directory, no Next.js app, no second `package.json`.
- **No PostgreSQL** — the only persistence adapter is a file-backed store for the **auth**
  tables (`src/adapters/persistence/filestore.ts`); every financial aggregate
  (receivables, payments, cases) lives in a process-global **in-memory** store
  (`src/adapters/http/runtime/resources.ts`) and dies with the process.
- **No Daraja production adapter** — `src/adapters/daraja/` is a conformance *suite*:
  frozen fixtures, a pure simulator and a scenario harness (`src/adapters/daraja/README.md`).
  It performs no network I/O and holds no credentials.
- **No deployment artifacts** — no `Dockerfile`, no `docker-compose*`, no Terraform, no Helm
  charts anywhere in the repo; CI (`.github/workflows/ci.yml`) is a typecheck+test matrix
  only, and it is currently not executing (see §4 and
  [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md)).

The honest one-liner for stakeholders: **the hardest 60% of a collections platform — the
invariant-dense financial core — is built, tested and green; the deployable 40% (storage,
transport completeness, frontend, integrations, ops) has not been started.** The gap is
structural, not quality-driven: the kernel and store seams (`src/adapters/http/kernel/types.ts`,
`src/adapters/persistence/filestore.ts`) were explicitly designed so production
implementations swap in without touching domain code.

---

## 2. Verification method (reproducible)

| Gate | Command | Result at audit time |
|---|---|---|
| Types | `npm run typecheck` | clean (exit 0) |
| Suite | `npx vitest run` | **Test Files 114 passed (114), Tests 2665 passed (2665)** |
| Secret scan | the dispatch secret-scan regex (GitHub-token prefixes, key/value assignments) via `git grep -iE -- .` | only pre-existing benign hits: fake hashing fixtures (`src/domain/auth/apikeys.spec.ts`, `src/domain/auth/guard.spec.ts`) and the English phrase "risk-relevant" (`src/domain/agent/README.md`, `src/domain/agent/financial-state.ts`) |
| Diff scope | `git diff --stat origin/main` | this audit's four docs files only |
| Route enumeration | `grep -n "pattern:" src/adapters/http/routes/*.ts` | 22 mounted `/v1` route rows (see §3.2) |
| Infra enumeration | `find . -name "go.mod" -o -name "Dockerfile*" -o -name "*.tf"` (excluding `node_modules`) | zero hits |
| Per-suite counts | `npx vitest run` default reporter | every spec file's test count captured; wave sums reconcile exactly to [docs/BACKLOG.md](BACKLOG.md) totals (607 → 1044 → 1439+520=1959 → 2174 → 2531 → 2665) |

The repository at audit time: 357 tracked files (319 under `src/`, 30 under `docs/`),
zero open PRs, zero open issues, `main` = `c65ffba`.

---

## 3. VERIFIED COMPLETE — the domain engine

### 3.1 Per-feature verification table (all 32 features)

Every row lists the actual spec files that make the feature green (paths relative to repo
root). "Tests" are exact counts from the `vitest` run; "PR/Issue" cross-references
[docs/BACKLOG.md](BACKLOG.md). This is the **DOMAIN-ONLY vs COMPLETE** baseline: all 32 rows
are domain-complete; none of them implies a production runtime (that matrix is §4).

| # | Feature | Lane | Spec files (evidence) | Suites | Tests | PR/Issue |
|---|---|---|---|---|---|---|
| F1 | Receivables core (H1) | `src/domain/receivables/` | `src/domain/receivables/invoice.spec.ts`, `src/domain/receivables/receivable.spec.ts`, `src/domain/receivables/aging.spec.ts` | 3 | 102 | #12 / #1 |
| F2 | Payments core — dual-path intake, R9 idempotency (C5, K1) | `src/domain/payments/` | `src/domain/payments/payment.spec.ts`, `src/domain/payments/intake.spec.ts`, `src/domain/payments/events.spec.ts` | 3 | 74 | #13 / #2 |
| F3 | Reconciliation re-pointed to Payment (C1, R5) | `src/domain/payments/` | `src/domain/payments/reconciliation.spec.ts` | 1 | 17 | #13 / #3 |
| F4 | Adjustments — refunds, credit notes, credit balance (C2–C4) | `src/domain/adjustments/` | `src/domain/adjustments/refund.spec.ts`, `src/domain/adjustments/credit-note.spec.ts`, `src/domain/adjustments/credit-balance.spec.ts`, `src/domain/adjustments/events.spec.ts` | 4 | 82 | #11 / #4 |
| F5 | Allocation engine — FIFO/explicit/pro-rata (H3, R1, R2) | `src/domain/allocation/` | `src/domain/allocation/allocation.spec.ts`, `src/domain/allocation/engine.spec.ts`, `src/domain/allocation/strategies.spec.ts` | 3 | 54 | #15 / #5 |
| F6 | Typed event catalog + outbox contract | `src/domain/events/` | `src/domain/events/catalog.spec.ts`, `src/domain/events/defineEvent.spec.ts`, `src/domain/events/envelope.spec.ts`, `src/domain/events/outbox.spec.ts` | 4 | 138 | #16 / #6 |
| F7 | Late fees + payment plans (H4, H5) | `src/domain/receivables/` | `src/domain/receivables/late-fee.spec.ts`, `src/domain/receivables/payment-plan.spec.ts` | 2 | 89 | #17 / #7 |
| F8 | Collections cases + actions + R8 exclusivity (H6) | `src/domain/collections/` | `src/domain/collections/case.spec.ts`, `src/domain/collections/actions.spec.ts`, `src/domain/collections/derive.spec.ts` | 3 | 93 | #31 / #8 |
| F9 | Multi-currency + FX realized gain/loss (H2, R10) | `src/domain/shared/` | `src/domain/shared/fx.spec.ts`, `src/domain/shared/fx-scenarios.spec.ts` | 2 | 59 | #28 / #9 |
| F10 | Consent registry + WhatsApp opt-in + eTIMS hooks (K2–K4) | `src/domain/consent/` | `src/domain/consent/consent-grant.spec.ts`, `src/domain/consent/guard.spec.ts`, `src/domain/consent/etims.spec.ts`, `src/domain/consent/dsar.spec.ts` | 4 | 43 | #14 / #10 |
| F11 | Sub-ledger postings + GL reconciliation job (K5, R4) | `src/domain/ledger/` | `src/domain/ledger/journal.spec.ts`, `src/domain/ledger/reconciliation.spec.ts`, `src/domain/ledger/events.spec.ts` | 3 | 40 | #29 / #18 |
| F12 | Promise-to-pay + dunning orchestration (K2) | `src/domain/promises/` | `src/domain/promises/promise.spec.ts`, `src/domain/promises/dunning.spec.ts` | 2 | 60 | #33 / #19 |
| F16 | Disputes lifecycle + collections pause (§29) | `src/domain/disputes/` | `src/domain/disputes/dispute.spec.ts`, `src/domain/disputes/pause.spec.ts` | 2 | 38 | #27 / #20 |
| F17 | Payment links — lifecycle + bounded redemption (§28) | `src/domain/paymentlinks/` | `src/domain/paymentlinks/link.spec.ts`, `src/domain/paymentlinks/redeem.spec.ts`, `src/domain/paymentlinks/events.spec.ts` | 3 | 79 | #30 / #21 |
| F18 | Communications domain — inbox, templates, retry ladder (§26) | `src/domain/communications/` | `src/domain/communications/conversation.spec.ts`, `src/domain/communications/guard.spec.ts`, `src/domain/communications/provider.spec.ts`, `src/domain/communications/templates.spec.ts` | 4 | 68 | #32 / #22 |
| F13 | Collections priority scoring + feedback (H7) | `src/domain/intelligence/` | `src/domain/intelligence/scoring.spec.ts`, `src/domain/intelligence/feedback.spec.ts`, `src/domain/intelligence/recommendations.spec.ts` | 3 | 76 | #38 / #23 |
| F14 | Segments + reporting projections (§19/§20/§66) | `src/domain/projections/` | `src/domain/projections/segments.spec.ts`, `src/domain/projections/projection.spec.ts`, `src/domain/projections/aging.spec.ts`, `src/domain/projections/effectiveness.spec.ts`, `src/domain/projections/strategies.spec.ts`, `src/domain/projections/events.spec.ts` | 6 | 184 | #39 / #24 |
| F15 | Daraja conformance suite (fixtures, at-least-once replay) | `src/adapters/daraja/` | `src/adapters/daraja/conformance.spec.ts`, `src/adapters/daraja/fixtures.spec.ts`, `src/adapters/daraja/simulator.spec.ts` | 3 | 37 | #45 / #25 |
| F19 | Behavior profiles + anomaly detection (§4/§24) | `src/domain/behavior/` | `src/domain/behavior/anomaly.spec.ts`, `src/domain/behavior/drift.spec.ts`, `src/domain/behavior/profile.spec.ts`, `src/domain/behavior/events.spec.ts` | 4 | 98 | #40 / #26 |
| F20 | Policy engine — allow/deny/require-approval (VISION §3.9) | `src/domain/policy/` | `src/domain/policy/engine.spec.ts`, `src/domain/policy/rules.spec.ts`, `src/domain/policy/request.spec.ts`, `src/domain/policy/events.spec.ts` | 4 | 214 | #41 / #34 |
| F21 | Agent capability queries (VISION §3.8) | `src/domain/agent/` | `src/domain/agent/facts.spec.ts`, `src/domain/agent/financial-state.spec.ts`, `src/domain/agent/priorities.spec.ts`, `src/domain/agent/recommendations.spec.ts` | 4 | 109 | #44 / #35 |
| F22 | Next-best-action engine (VISION §3.4) | `src/domain/nba/` | `src/domain/nba/rank.spec.ts`, `src/domain/nba/feedback.spec.ts`, `src/domain/nba/features.spec.ts`, `src/domain/nba/events.spec.ts` | 4 | 67 | #42 / #36 |
| F23 | Explainable financial memory (VISION §3.3/§3.7) | `src/domain/memory/` | `src/domain/memory/claims.spec.ts`, `src/domain/memory/diff.spec.ts`, `src/domain/memory/events.spec.ts`, `src/domain/memory/facts.spec.ts`, `src/domain/memory/snapshot.spec.ts` | 5 | 130 | #43 / #37 |
| F24 | Auth & RBAC domain core (§34/§35) | `src/domain/auth/` | `src/domain/auth/apikeys.spec.ts`, `src/domain/auth/assignments.spec.ts`, `src/domain/auth/guard.spec.ts`, `src/domain/auth/roles.spec.ts`, `src/domain/auth/sessions.spec.ts`, `src/domain/auth/user.spec.ts` | 6 | 95 | #49 / #46 |
| F25 | Webhook subscriptions + signing + delivery domain (§53) | `src/domain/webhooks/` | `src/domain/webhooks/attempts.spec.ts`, `src/domain/webhooks/endpoint.spec.ts`, `src/domain/webhooks/signing.spec.ts`, `src/domain/webhooks/subscription.spec.ts` | 4 | 57 | #50 / #47 |
| F26 | Cross-border corridors, quotes, intents, fees (§33) | `src/domain/crossborder/` | `src/domain/crossborder/corridor.spec.ts`, `src/domain/crossborder/fees.spec.ts`, `src/domain/crossborder/intent.spec.ts`, `src/domain/crossborder/quote.spec.ts` | 4 | 63 | #51 / #48 |
| F27 | Maker-checker approvals (§36) | `src/domain/approvals/` | `src/domain/approvals/policy.spec.ts`, `src/domain/approvals/request.spec.ts` | 2 | 67 | #56 / #52 |
| F28 | Unified audit trail — redaction + hash chain (§37) | `src/domain/audit/` | `src/domain/audit/chain.spec.ts`, `src/domain/audit/events.spec.ts`, `src/domain/audit/project.spec.ts`, `src/domain/audit/record.spec.ts`, `src/domain/audit/redact.spec.ts` | 5 | 78 | #57 / #53 |
| F29 | USSD session workflows (§31) | `src/domain/ussd/` | `src/domain/ussd/flows.spec.ts`, `src/domain/ussd/menu.spec.ts`, `src/domain/ussd/session.spec.ts` | 3 | 94 | #58 / #54 |
| F30 | HTTP /v1 kernel — router, middleware, error mapping (§38) | `src/adapters/http/` | `src/adapters/http/kernel/errors.spec.ts`, `src/adapters/http/kernel/router.spec.ts`, `src/adapters/http/middleware/auth.spec.ts`, `src/adapters/http/pagination.spec.ts`, `src/adapters/http/server.spec.ts` | 5 | 118 | #59 / #55 |
| F31 | /v1 resource mounts — payments, receivables, collections | `src/adapters/http/` | `src/adapters/http/routes/payments.spec.ts`, `src/adapters/http/routes/receivables.spec.ts`, `src/adapters/http/routes/collections.spec.ts`, `src/adapters/http/runtime/resources.spec.ts` | 4 | 87 | #62 / #60 |
| F32 | File-backed AuthStore persistence (JSONL + snapshots) | `src/adapters/persistence/` | `src/adapters/persistence/filestore.spec.ts`, `src/adapters/persistence/journal.spec.ts`, `src/adapters/persistence/replay.spec.ts`, `src/adapters/persistence/seam.spec.ts` | 4 | 47 | #63 / #61 |

*(Plus the shared kernel suite `src/domain/shared/money.spec.ts` — 8 tests — which predates
the F-numbering; the grand total is exactly 2,665.)*

### 3.2 What actually runs today (the full runtime inventory)

The only executable surface in the repository is the zero-dependency HTTP kernel over
`node:http` (`src/adapters/http/server.ts` — "the ONLY socket-aware file in the lane"):

- **22 route rows** are mounted, enumerated from `grep "pattern:" src/adapters/http/routes/*.ts`:
  - Public: `GET /v1/health`, `GET /v1/meta` (`src/adapters/http/routes/public.ts`);
  - Auth admin: users, role grants, role revocations, api-keys, api-key revocations, session
    revocations (`src/adapters/http/routes/auth.ts` — 6 rows);
  - Receivables read model: list + get (`src/adapters/http/routes/receivables.ts` — 2 rows);
  - Payments: intake, get, list, confirmations, refund-reservations
    (`src/adapters/http/routes/payments.ts` — 5 rows);
  - Collections: cases (open/get/list), transitions, escalations, actions, action
    completions (`src/adapters/http/routes/collections.ts` — 7 rows).
- **State:** an in-memory `InMemoryAuthStore` and in-memory `InMemoryResourceStore` by
  default (`src/adapters/http/server.ts`, options block: `store`/`resourceStore` defaults) —
  or the file-backed auth store (`src/adapters/persistence/filestore.ts`) injected at the
  same seam.
- **Not mounted anywhere:** ledger, adjustments (refunds/credit notes), communications,
  payment links, disputes, promises, webhooks, cross-border, intelligence, agent, NBA,
  memory, approvals, audit, USSD lanes — all domain-complete, none exposed over HTTP yet.

---

## 4. PRODUCTION GAPS matrix

Status legend:
**COMPLETE** — production-usable as-is · **DOMAIN-ONLY** — real domain logic exists, runtime
shells around it are missing · **CONTRACT-ONLY** — interface/protocol implemented, no real
external integration · **MOCKED** — external system simulated · **NOT STARTED** — no code.

| Capability | Status | Evidence (file paths) | Blocking severity |
|---|---|---|---|
| Financial domain core (F1–F32) | **COMPLETE (domain)** | `src/domain/**` (all lanes + spec files listed in §3.1) | — (done, by design pure) |
| Auth/RBAC domain | **COMPLETE (domain)** | `src/domain/auth/` (`guard.ts`, `roles.ts`, `apikeys.ts`, `sessions.ts`) | — |
| HTTP kernel + mounted resources | **DOMAIN-ONLY** | kernel: `src/adapters/http/kernel/*`; mounted: `src/adapters/http/routes/{auth,receivables,payments,collections,public}.ts` (22 rows, §3.2); 15 capability lanes have no routes | **HIGH** — API surface is a fraction of SPEC §38's `/v1/*` list |
| Persistence — financial truth (PostgreSQL) | **NOT STARTED** | no `migrations/`, no SQL, no pg client in `package.json`; financial rows live in `src/adapters/http/runtime/resources.ts` (in-memory `InMemoryResourceStore`) | **CRITICAL** — every financial fact is lost on process restart |
| Persistence — auth store | **DOMAIN-ONLY** | `src/adapters/persistence/filestore.ts` (JSONL journal + crash-atomic snapshot) — real and tested (`src/adapters/persistence/journal.spec.ts`, `src/adapters/persistence/replay.spec.ts`, `src/adapters/persistence/filestore.spec.ts`, `src/adapters/persistence/seam.spec.ts`), but file-backed only; no PostgreSQL port | **HIGH** |
| Event fabric runtime (outbox → broker) | **CONTRACT-ONLY** | `src/domain/events/outbox.ts` — "pure, in-memory contract of the transactional outbox… persistence adapters (Postgres outbox table) will implement the same contract"; no NATS/publisher code exists | **HIGH** — consumers, retries and delivery guarantees have no runtime |
| Daraja integration (M-Pesa C2B/STK/B2C) | **MOCKED** | `src/adapters/daraja/simulator.ts` + `src/adapters/daraja/fixtures/` + `src/adapters/daraja/conformance.ts` (`src/adapters/daraja/README.md`: "no network, no DB, no RNG"); `wire.ts` is the untrusted-input parser. No HTTP client, no credentials, no callback endpoint deployment | **CRITICAL** for the product thesis (Kenya-native reconciliation) |
| eTIMS (KRA invoice numbering) | **CONTRACT-ONLY** | `src/domain/consent/etims.ts` — format/validate/mod-97 check + `createNumberingService(sequenceSource, clock)` where the sequence source "might be a SELECT … FOR UPDATE … or a KRA reservation call"; no KRA connection exists | **MEDIUM** — legal for issuance only once a real reservation source exists |
| Communications providers (SMS/WhatsApp/email) | **MOCKED** | `src/domain/communications/provider.ts` — `simulatedProvider` (line ~68) is the scripted provider; the real `MessagingProvider` port is documented for adapters; no gateway client | **HIGH** — collections execution cannot reach customers |
| Webhooks delivery runtime | **DOMAIN-ONLY** | `src/domain/webhooks/attempts.ts` — pure plan/enqueue/attempt ladder with statuses and dead-letter; no HTTP delivery worker, no HMAC over the wire runtime, no queue | **MEDIUM** |
| Background workers / schedulers | **NOT STARTED** | no worker process or entrypoint (only `src/index.ts` barrel + `src/adapters/http/server.ts`); dunning/aging/reconciliation are pure functions that must be invoked by a caller that doesn't exist yet | **HIGH** — dunning, FX sweeps, expiry, GL reconciliation need triggers |
| Durable workflows (Temporal per SPEC §40) | **NOT STARTED** | no temporal code/config; only pure ladders (`src/domain/promises/dunning.ts`, `src/domain/webhooks/attempts.ts`) | **MEDIUM** (until P1) |
| Observability (metrics, traces, structured logs) | **NOT STARTED** | the kernel's only hook is `onError: (error, requestId) => void` (`src/adapters/http/server.ts` options; "Observability sink for internal errors — never the response body"); no OpenTelemetry/Prometheus/loki anywhere | **HIGH** — undiagnosable in production |
| Deployment (Docker/K8s/Terraform/ArgoCD) | **NOT STARTED** | zero `Dockerfile`/`*.tf`/helm files in tree (§2 enumeration); SPEC §41 "Infrastructure" mandates them | **CRITICAL** for P1 launch |
| Frontend (Next.js per SPEC §41/§45–§49) | **NOT STARTED** | no `frontend/` dir, no second package manifest, no React code in tree | **HIGH** for self-serve users (collections workspace, dashboards) |
| Go production core (SPEC §41/§55) | **NOT STARTED** | no `backend/`, no `go.mod`; TS domain is the only implementation | **HIGH** (strategic — see [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) positioning) |
| OpenAPI contract | **NOT STARTED** | no `openapi/` dir or spec file; route table (`src/adapters/http/kernel/types.ts` `RouteRecord`) is the de-facto contract; SPEC §38/§65 require OpenAPI | **HIGH** for developer platform + Go port |
| Developer platform (SDKs, portal, API keys UX) | **DOMAIN-ONLY** | domain ready: `src/domain/webhooks/` (registry/signing/attempts), `src/domain/auth/apikeys.ts` (issuance/revocation/scopes); surface: only 6 admin routes mounted; no SDK, no docs site | **MEDIUM** |
| Multi-tenancy at the store layer | **DOMAIN-ONLY** | most aggregates carry `orgId` (e.g. `src/domain/collections/case.ts`, `src/domain/auth/*`); **receivables and payments aggregates carry no orgId** — "the reference store is process-global; multi-org deployments enforce isolation in their persistence adapter" (`src/adapters/http/routes/receivables.ts` header, `src/adapters/http/runtime/resources.ts` header) | **CRITICAL** — must be solved in the PostgreSQL schema (P0) |
| Rate limiting / abuse controls | **NOT STARTED** | no limiter in `src/adapters/http/kernel/` (kernel files: `src/adapters/http/kernel/router.ts`, `src/adapters/http/kernel/body.ts`, `src/adapters/http/kernel/errors.ts`, `src/adapters/http/middleware/` only) | **HIGH** before public exposure |
| TLS / transport security | **NOT STARTED** | `src/adapters/http/server.ts` creates a plain `node:http` server (`http://127.0.0.1:…`); no TLS termination anywhere | **HIGH** (can be satisfied by a reverse proxy, but undocumented) |
| Secret management (vault/KMS) | **NOT STARTED** | codecs are injectable ports (`SecretCodec` in `src/domain/auth/user.ts`; `AuditHashPort` in `src/domain/audit/chain.ts`) but no production key management exists | **HIGH** |
| Dependency scanning / supply chain | **NOT STARTED** | `.github/workflows/ci.yml` runs only npm ci/typecheck/test; no audit/scan step, no Dependabot config in `.github/` | **MEDIUM** |
| Background durable storage of the audit trail | **DOMAIN-ONLY** | `src/domain/audit/chain.ts` provides append-only type-level sink + hash chain with an honest truncation limit ("cannot see TAIL truncation from the inside"); persistence is the caller's `AuditSink` — no durable sink implementation | **HIGH** for compliance claims |

---

## 5. SECURITY REVIEW

### 5.1 Present and verified (strong for a domain core)

- **Deny-by-default RBAC with audited denials.** `src/domain/auth/guard.ts` +
  `src/domain/auth/roles.ts` implement a closed permission vocabulary; the middleware documents the wire contract —
  "401 … the lane refused the credential … every denial is audited … 403 … the denial is
  audited as an `auth.accessDenied` event" — and "No secret material is ever echoed:
  messages reference prefixes/ids only" (`src/adapters/http/middleware/auth.ts` header).
  Matrix-tested in `src/adapters/http/middleware/auth.spec.ts` (14 tests).
- **API keys: hashed at rest, prefix-only visibility.** `src/domain/auth/apikeys.ts`:
  "issuance record: visible `prefix` (first KEY_PREFIX_LENGTH chars)… the raw secret is never
  stored anywhere"; revocation is a fact (replay of a revoked key denies forever, with a
  deterministic denial precedence `KEY_UNKNOWN → KEY_SECRET_MISMATCH → KEY_REVOKED →
  KEY_EXPIRED → KEY_OWNER_INACTIVE`).
- **Escalation guard.** `AUTH_ESCALATION_BLOCKED` is a first-class kernel 403
  (`src/adapters/http/kernel/errors.ts`); the auth lane refuses grants that would let a
  granter confer permissions they don't hold (tested in `src/domain/auth/guard.spec.ts`,
  and the wave-7 seed fix shows it actively rejects bad setups).
- **Tamper-evident audit trail.** `src/domain/audit/chain.ts`: `recordHash = H(prevHash ‖
  canonical(record))` over **redacted** snapshots, canonical JSON, injected hash port,
  verify-as-decision-values; the honest limit (tail truncation needs external length/head
  anchoring) is documented in the header and pinned by tests (`src/domain/audit/chain.spec.ts`).
- **Redaction before persistence.** `src/domain/audit/redact.ts` + `record.ts`: the sink
  re-redacts before storing; `redact.spec.ts` (20 tests) pins recursive redaction.
- **Untrusted-input boundary for Daraja.** `src/adapters/daraja/wire.ts` refuses malformed
  callbacks with stable `DARAJA_*` codes (dead-letter, never processed); same-TransID
  different-money is tampering, not retry (`src/adapters/daraja/README.md`).
- **Body cap with no over-limit buffering.** `src/adapters/http/server.ts`: "An over-limit
  body is NEVER buffered: the size counter trips first" → deterministic 413
  (`HTTP_PAYLOAD_TOO_LARGE`, `src/adapters/http/kernel/errors.ts`).
- **No plaintext secrets in persistence.** `src/adapters/persistence/filestore.ts`: "rows
  already hold HASHED secrets upstream (the codec port); the journal and snapshots store
  exactly what the rows hold and never add plaintext" — proven by plaintext-absence specs
  (`filestore.spec.ts`, `journal.spec.ts`).
- **Fail-closed governance.** `src/domain/policy/engine.ts`: unknown action → deny
  `POLICY_ACTION_UNKNOWN` "safe by default"; no rule matched → deny
  `POLICY_NO_RULE_MATCHED` — "silence never widens permissions"; every decision emits an
  audit event.
- **Secret hygiene in the repo.** Full-history scans in waves 5–8 found no committed tokens;
  the current-tree scan (§2) shows only fake fixtures and the English phrase
  "ri**sk-**relevant".

### 5.2 Missing (before any production exposure)

1. **Rate limiting / throttling** — nothing in the kernel; every authenticated caller can
   drive the synchronous handler loop unbounded (§4 row).
2. **TLS** — plain `node:http`; termination must be documented and provisioned (proxy or
   Node TLS).
3. **Secret management** — where do the Daraja consumer keys, SMS credentials, signing
   secrets live? No KMS/vault integration; `SecretCodec` exists as a seam only.
4. **Dependency & container scanning** — no `npm audit`/Dependabot/CodeQL in
   `.github/workflows/ci.yml`; the repo has exactly two runtime deps (zero runtime deps —
   `package.json` declares only `typescript` + `vitest` devDependencies), which lowers the
   risk but doesn't close it.
5. **Security headers / CORS** — not implemented in the kernel response path.
6. **Durable, externally-anchored audit storage** — the chain's own header names the gap:
   tail truncation is invisible without anchoring expected length/head externally
   (`src/domain/audit/chain.ts` header).
7. **Session token lifecycle at the edge** — sessions verify in the lane
   (`src/domain/auth/sessions.ts`), but there is no cookie/CSRF/refresh story (frontend not
   started).
8. **CI as a security gate** — currently non-executing (billing lock,
   [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md)); until it runs, even the existing
   typecheck/test gate has no independent enforcement.

---

## 6. TECHNICAL DEBT (only what the code shows)

| # | Debt | Evidence | Impact |
|---|---|---|---|
| D1 | **Process-global resource store for payments & receivables.** The lane aggregates carry no `orgId`; the reference store is process-global and isolation is deferred to "their persistence adapter". | `src/adapters/http/routes/receivables.ts` (header, "Org scoping" note) and `src/adapters/http/runtime/resources.ts` (header note) | The single largest correctness risk for multi-org production; must be fixed in the PostgreSQL schema, not patched in routes |
| D2 | **In-memory reference runtime is the default.** `createHttpKernel` defaults to `InMemoryAuthStore` + `InMemoryResourceStore`. | `src/adapters/http/server.ts` (options defaults) | A restarted process forgets every payment/case; acceptable for dev, fatal in prod |
| D3 | **Kernel handlers are synchronous by design.** "Handlers are SYNCHRONOUS on purpose" — I/O must hide behind ports. | `src/adapters/http/kernel/types.ts` header | Determinism wins, but real DB-backed handlers will need async or preloaded state; plan the Go port accordingly |
| D4 | **Body transport is UTF-8 text-only.** "the kernel contract takes DECODED text — … a binary-safe transport adapter is a later wave"; cap 1 MiB. | `src/adapters/http/server.ts` header + options | Fine for JSON APIs; blocks file uploads later |
| D5 | **Intake dedup scope is the caller's array.** `intakePayment` dedupes against `ctx.existing` payments supplied by the caller. | `src/domain/payments/intake.ts` (`IntakeContext.existing`) | Correctness depends on the persistence layer providing a durable `unique(channel, externalRef)` index (R9) |
| D6 | **Event-catalog doc drift.** `docs/04-event-catalog.md` documents the core 27; lanes merged since (collections, promises, comms, links, auth, webhooks, crossborder, policy, audit…) define their own typed events, e.g. `src/domain/communications/events.ts` (9 `comms.*` events) — recorded as "catalog registration left to the events lane owner" in wave logs. | `docs/04-event-catalog.md` vs `src/domain/*/events.ts` | New consumers/integrations can't discover the full event surface from docs; needs a catalog regeneration task |
| D7 | **README badge staleness.** The badge reads 2,174 passing (`README.md` line 6) while the text and reality are 2,665 (`README.md` "Verification"). | `README.md` | Cosmetic; fix in the next docs sweep (dispatcher owns README) |
| D8 | **Persistence adapter exists only for auth.** The `AuthStore` seam is satisfied by files; the `ResourceStore` seam has no durable implementation. | `src/adapters/persistence/filestore.ts` vs `src/adapters/http/runtime/resources.ts` | Mirrors the CRITICAL gap in §4 |
| D9 | **No OpenAPI generation from the route table.** `RouteRecord` rows are the contract; nothing derives a spec from them. | `src/adapters/http/kernel/types.ts` | Slows SDKs, the Go port and partner onboarding |
| D10 | **CI not executing (account billing lock).** Jobs never start; local green is the documented merge gate. | `.github/workflows/ci.yml` (the only workflow); narrative in [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md) | Blocks independent verification; not a code defect |

Deliberate non-debts (documented design choices, not accidents): pure domain with injected
Clock/RNG (`README.md` "Engineering that matters"); refusal-as-value patterns
(`src/domain/collections/actions.ts`, `src/domain/webhooks/attempts.ts`); the conformance
suite as the only lane allowed to import domain (`src/adapters/daraja/README.md`).

---

## 7. INVESTOR OPPORTUNITIES (ranked, each tied to existing foundation)

1. **Governed automation ("human-controlled autonomy for finance") — the differentiation.**
   The full chain already exists as tested code: policy engine (214 tests,
   `src/domain/policy/`) → maker-checker approvals (67, `src/domain/approvals/`) → unified
   auditable trail with hash-chain integrity (78, `src/domain/audit/`) → consent gates
   (`src/domain/consent/guard.ts`, `src/domain/collections/actions.ts` K2 hook). Almost no
   competitor can demo AI-proposed, policy-gated, human-approved, fully-audited money
   actions. *Investor story: the safe execution layer beneath AI in finance.*
2. **Explainable collections intelligence.** NBA ranking with per-candidate transparent
   integer scoring and a feedback hook (`src/domain/nba/README.md`, 67 tests), customer
   financial memory where "every number is a claim with evidence"
   (`src/domain/memory/README.md`, 130 tests), behavior profiles + anomalies (98,
   `src/domain/behavior/`), priority scoring with outcome feedback (76,
   `src/domain/intelligence/`). *Investor story: compounding data moat with explanations
   regulators and customers can audit.*
3. **The Kenya moat: Daraja conformance + eTIMS + consent.** At-least-once replay,
   tamper detection, idempotent intake proven end-to-end by the conformance harness (37
   tests, `src/adapters/daraja/`); eTIMS numbering format with transcription-safe check
   characters (`src/domain/consent/etims.ts`); DPA-2019 consent registry
   (`src/domain/consent/`). *Investor story: African payment rails are hostile; we've
   encoded that hostility as tests.*
4. **API-first / agent-ready architecture.** Capability queries over CRUD
   (`src/domain/agent/README.md`, 109 tests), a versioned `/v1` kernel with auth middleware
   and audited denials (`src/adapters/http/`), webhook developer-platform contracts
   (`src/domain/webhooks/`). *Investor story: "Collections powered by Fuatilia" as
   embeddable infrastructure (VISION §6–§7) — the API layer is the product.*
5. **Low-tech channel coverage.** USSD state machine + flows over injected ports (94 tests,
   `src/domain/ussd/`), payment links with bounded redemption (79,
   `src/domain/paymentlinks/`), communications with retry→dead-letter (68,
   `src/domain/communications/`). *Investor story: serves the Kenyan SME reality — not
   every customer has an app.*
6. **Cross-border optionality.** Corridors, exact-rational FX quotes with expiry,
   idempotent transfer intents (63 tests, `src/domain/crossborder/`). *Investor story: a
   ready regional expansion kernel (P5 in
   [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md)).*
7. **Acquisition-grade engineering evidence.** R1–R10 invariants as code
   ([docs/07-invariants.md](07-invariants.md)), 2,665 table-driven tests reconciling
   exactly to wave history (§2), ledger-first append-only design
   (`docs/06-review-findings.md` fixes C1–C5 embedded). *Investor story: technical due
   diligence passes on the first pass — the invariant catalog is the transfer document.*

---

## 8. UNKNOWN (declared, with reasons)

- **Production traffic characteristics** (latency targets, tenancy counts, invoice volume):
  UNKNOWN — no deployment exists to measure; the SPEC sets no numeric SLOs.
- **KRA eTIMS API specifics** (endpoint, auth, environment availability): UNKNOWN —
  `src/domain/consent/etims.ts` deliberately leaves the sequence source to the adapter; no
  KRA sandbox credentials are in the repo (correctly).
- **CI billing-lock resolution date**: UNKNOWN — owner action in GitHub Billing settings;
  the constraint is documented in [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md).
- **Go port team/timeline**: UNKNOWN — no Go code or scaffolding exists (§4); the port
  plan is defined in [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md).
