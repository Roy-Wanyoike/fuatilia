# ARCHITECTURE — how Fuatilia is built and why

> The engineering map of the running system: what owns the truth, where every
> lane lives, how events move, and what actually boots. Every path in this
> document exists in the tree — if you find one that doesn't, that's a bug;
> fix it in the same PR that moved the code.
>
> Companion documents: [CONTRIBUTING.md](CONTRIBUTING.md) (how to change the
> system), [docs/README.md](README.md) (design-doc index),
> [DECISIONS.md](DECISIONS.md) (the ADRs this page summarizes).

---

## 1. The dual-kernel design (ADR-0001)

Fuatilia is **two implementations of one specification**:

| Kernel | Location | Role |
|---|---|---|
| **TypeScript spec kernel** | `src/domain/**` (+ `src/adapters/**`) | The **behavioral specification**: pure functions, zero I/O, injected clock/RNG, table-driven tests. It is the executable definition of what Fuatilia does — the conformance oracle that never rots because it runs. |
| **Go production kernel** | `backend-go/**` | The **production surface**: the `/v1` HTTP service (`cmd/api`), the outbox relay (`cmd/worker`), and the delivery machinery, ported lane-by-lane against PostgreSQL and NATS. |

The port is measured by **conformance**: Go tests port named Vitest scenarios
with identical inputs and expected outputs (see
`backend-go/pkg/money/conformance_test.go` for the scenario-to-scenario
mapping, and `src/adapters/daraja/conformance.ts` for the frozen-fixture
pattern the approach generalizes). Behavioral changes land in the TS lane
first, then the port — a deliberate velocity brake on the money path.

Why: SPEC §41 mandates Go for the production backend, but the domain was
already specified and tested in TypeScript (2,600+ hermetic tests). Rewriting
from scratch would discard the invariant catalog; shipping TS to production
would violate the mandated stack. ADR-0001 ([DECISIONS.md](DECISIONS.md))
keeps both: TS is the brain, Go is the body.

---

## 2. Truth registry — what owns what

**PostgreSQL is the only financial source of truth. Everything else is
specification, surface, or a rebuildable derivative** (ADR-0002).

| System | Location | Truth role | Losing it costs |
|---|---|---|---|
| **PostgreSQL 16** | `db/migrations/*.sql` (0001–0014, ~30 tables) | **ALL financial facts**: receivables, payments, allocations, adjustments, ledger postings, cases, promises, disputes, links, comms, webhooks, audit, idempotency keys, and the transactional outbox (`outbox_events`, migration `db/migrations/0013_audit_outbox.sql`). Every row is org-scoped. | **Truth** — restore from backup |
| **TypeScript domain** | `src/domain/**` | **No truth at runtime — pure specification.** No DB, no clock, no RNG, no network. Deterministic, hermetic, fully tested. | Nothing (spec is re-derivable from Git) |
| **Go backend** | `backend-go/` | **Production surface, not a second truth.** State changes commit through `internal/application` services; Go owns transactions and I/O, never a divergent copy of balances. | Nothing durable |
| **NATS JetStream** | compose service `nats` | Event fabric with delivery buffering only. Facts replay deterministically from PostgreSQL (`worker replay --from --to`, `backend-go/internal/outbox/replay.go`). | Redelivery buffering, nothing more |
| **ClickHouse** | (designed role, ADR-0002 — not yet provisioned) | **Rebuildable analytics projections**, reconstructed from the event stream. Never a balance authority. | Nothing — rebuild by replay |
| **File-backed store** | `src/adapters/persistence/filestore.ts` | Dev/store seam for the TS reference runtime. Append-only JSONL journal + crash-atomic snapshots. | Dev data only |
| **Frontend** | `frontend/` | Renders projections. The BFF (`frontend/src/app/api/v1/[...path]/route.ts`) relays to the API server-side; the browser never touches PostgreSQL and never sees a session token. | Nothing |

The one-way rule this table encodes: **derived stores may be rebuilt from
PostgreSQL + the event log — always; nothing but PostgreSQL may originate a
financial fact — ever.** The intelligence lanes (`src/domain/intelligence/`,
`src/domain/nba/`, `src/domain/behavior/`, `src/domain/memory/`,
`src/domain/agent/`) are read-only by construction and can never move money
(ADR-0005).

---

## 3. Bounded-context map

Contexts follow [01-context-map.md](01-context-map.md); the table below maps
each to the code and schema that implements it today. Every domain lane
carries its own `README.md` stating its contract and invariants.

| Context (owns) | TS lane (spec) | Go surface (production) | Schema | Adapters |
|---|---|---|---|---|
| **Receivables** — invoice→receivable split, lifecycle, aging | `src/domain/receivables/` | `internal/repositories/receivables.go`, `internal/application/receivables.go` | `db/migrations/0004_invoicing_receivables.sql` | `/v1/receivables` routes: `src/adapters/http/routes/receivables.ts` |
| **Payments** — dual-path intake (C2B + STK), idempotency, reconciliation | `src/domain/payments/` (intake = R9 funnel) | `internal/repositories/payments.go`, `internal/application/payments.go`, `internal/daraja/` (client, K1 wire parity) | `db/migrations/0005_payments_matches.sql` | Daraja wire: `src/adapters/daraja/`; PesaLink/bank statements: `src/adapters/bankfeed/` |
| **Ledger** — posting matrix, append-only entries, GL reconciliation | `src/domain/ledger/` | `internal/repositories/ledger.go` | `db/migrations/0008_ledger.sql` | — |
| **Collections** — cases, actions, one-open-case exclusivity (R8), STK execution gate | `src/domain/collections/` (+ `src/domain/promises/`, `src/domain/disputes/`) | `internal/repositories/cases.go`, `internal/application/collections.go` | `db/migrations/0009_collections.sql` (+ `0010_promises_plans.sql`) | routes: `src/adapters/http/routes/collections.ts` |
| **Communications** — conversations, templates, consent-gated sends, retry→dead-letter | `src/domain/communications/` | — (provider adapters are TS lanes) | `db/migrations/0011_communications.sql` | SMS `src/adapters/comm-sms/`, email `src/adapters/comm-email/`, WhatsApp `src/adapters/comm-whatsapp/` |
| **Webhooks** — endpoint registry, subscription grammar, attempt ladder, HMAC signing | `src/domain/webhooks/` | `internal/webhooks/` (delivery worker: claim → sign → POST → record) | `db/migrations/0012_webhooks.sql` | — |
| **Intake** — CSV invoice import, ERP mapping (QuickBooks/Zoho) | — | — | (uses `0004` tables) | `src/adapters/intake/` |
| **Bankfeed** — PesaLink / bank-statement reconciliation feed | — | — | (uses `0005` tables) | `src/adapters/bankfeed/` |
| **Consent / eTIMS** — DPA 2019 consent registry, DSAR, eTIMS numbering hooks | `src/domain/consent/` (`consent-grant.ts`, `dsar.ts`, `etims.ts`, `guard.ts`) | — | `db/migrations/0003_customers_consent.sql` | — |
| **Projections** — segments, aging reports, collection effectiveness (labeled, never balances) | `src/domain/projections/` | — | (read models over `0013` events) | — |
| **Auth** — org-scoped users, RBAC matrix, API keys, sessions | `src/domain/auth/` | `internal/auth/`, `internal/repositories/authstore.go`, `internal/application/authadmin.go` | `db/migrations/0002_auth.sql` | routes: `src/adapters/http/routes/auth.ts` |
| **Events** — typed catalog, envelope contract, pure outbox | `src/domain/events/` | `internal/infra/outbox.go` (append), `internal/outbox/` (relay) | `db/migrations/0013_audit_outbox.sql` | — |
| **Governance** — policy engine, maker-checker approvals, audit hash-chain | `src/domain/policy/`, `src/domain/approvals/`, `src/domain/audit/` | — | `db/migrations/0013_audit_outbox.sql` (audit_events) | — |
| **Cross-border** — corridors, FX quotes, transfer intents (R9/C5) | `src/domain/crossborder/` | — | `db/migrations/0014_crossborder.sql` | — |
| **Shared money** — `bigint` minor units, banker's rounding, exact FX | `src/domain/shared/` | `pkg/money/`, `pkg/idempotency/` | (conventions in every table) | — |
| **HTTP transport** — the `/v1` kernel | `src/adapters/http/kernel/` | `internal/transport/` | — | routes under both kernels |
| **Web console** — dashboard + debtor portal over the BFF | — | — | — | `frontend/` |

The golden rule across all of them: **only fund-truth contexts (receivables,
payments, adjustments, allocation, ledger) change what a customer owes.**
Collections, communications and intelligence write only their own aggregates
and read events ([01-context-map.md](01-context-map.md), R1–R10 in
[07-invariants.md](07-invariants.md)).

---

## 4. Event flow — outbox → relay → JetStream → consumers

The fabric is **at-least-once end-to-end**, therefore every consumer is
idempotent by `eventId` forever (ADR-0003). The full contract is documented in
`backend-go/internal/outbox/README.md`.

```
 domain transaction (PostgreSQL, ONE tx — internal/application/services.go)
   state change + ledger rows + outbox_events row   (infra.AppendOutboxEvent)
        │
        ▼
 cmd/worker  (backend-go/internal/outbox/relay.go)
   SELECT … FOR UPDATE SKIP LOCKED per org → publish → ack → mark published
   poisoned rows are terminal; per-org order is never violated
        │
        ▼
 NATS JetStream — stream FUATILIA_EVENTS, subjects fuatilia.>
   subject = fuatilia.<domain>.<event>.v<version>     (e.g. fuatilia.payment.confirmed.v1)
   dedup key  <org_id>:<event_id>, Nats-Msg-Id window 2 min
        │
        ├──► webhook deliveries ──► internal/webhooks worker
        │      claims due rows from webhook_deliveries (0012), signs
        │      HMAC-SHA256 (`signing.go`), POSTs via the injected Transport,
        │      walks the pure attempt ladder (`attempts.go` ↔ src/domain/webhooks/attempts.ts)
        │      to delivered or dead_lettered
        │
        └──► analytics ingester (designed consumer — ClickHouse projections,
               ADR-0002; the rebuild primitive already exists:
               `worker replay --from <RFC3339> --to <RFC3339>`)
```

Grounding:

- **Pure contract**: `src/domain/events/outbox.ts` (ordered append, `OUTBOX_DUPLICATE`
  dedupe, per-consumer cursors, deterministic `replay()`); envelope shape in
  `src/domain/events/envelope.ts`; the 27-event catalog in
  `src/domain/events/catalog.ts` (names pinned byte-for-byte in
  `backend-go/internal/outbox/subjects_test.go`).
- **Durability**: the outbox row commits **in the same transaction** as the
  state change — no dual-write window ever (`internal/application/services.go`
  `appendOutbox`; schema `db/migrations/0013_audit_outbox.sql`).
- **Delivery guarantees** (proof tests in `backend-go/internal/outbox/`):
  crash between publish and mark redelivers the unmarked set; two concurrent
  relays never double-publish (per-org advisory lock); payload bytes are
  published verbatim; grammar-invalid event types are poisoned, never
  published.
- **DLQ + replay**: poisoned rows are the dead letter queue;
  `worker replay poisons` requeues them; `worker replay --from --to` re-feeds
  any time window for projection rebuilds (`backend-go/internal/outbox/replay.go`).

The synchronous path (HTTP request → response) never touches the broker: the
kernel serves from PostgreSQL, and events reach consumers only through the
relay.

---

## 5. The /v1 request path

Both kernels serve the same machine-checked contract —
[`api/openapi/fuatilia.v1.yaml`](../api/openapi/fuatilia.v1.yaml), exactly
22 operations over 21 paths, nothing aspirational:

- **Envelope**: success `{ "data": ..., "meta"? }`; error
  `{ "error": { "code": SCREAMING_SNAKE, "message" }, "requestId" }`.
- **Auth**: `Authorization: Bearer <sessionToken>` or
  `Authorization: ApiKey <id>.<secret>`; deny-by-default, every 401/403
  refusal audited.
- **Cross-kernel parity lock**: `backend-go/internal/transport/parity_test.go`
  fails if the Go route table and the OpenAPI operation set ever drift apart
  (in either direction); `scripts/validate_openapi.py` re-checks the spec
  against the TS route tables and the permission vocabulary in
  `src/domain/auth/roles.ts`.

Go pipeline (`backend-go/internal/transport/kernel.go`):
`security headers → rate limit (429 + Retry-After) → parse body → route match →
authenticate → authorize → handler`, with typed refusals rendered by
`internal/transport/envelope.go` + `status.go`. The TS reference kernel
(`src/adapters/http/kernel/kernel.ts`) implements the identical pipeline and
remains the behavioral seed (ADR-0001). Frontend access is server-side only:
the BFF route handlers attach the session bearer from an httpOnly cookie
(`frontend/src/lib/portal/bff.ts`).

---

## 6. Deployment topology

The deployable unit is the compose stack ([docker-compose.yml](../docker-compose.yml),
documented in [DEPLOY.md](DEPLOY.md)); `make up` boots it, `make smoke`
proves it end-to-end over HTTP.

```
                     host-published ports: 8080 (api) · 3000 (frontend)
  ┌────────────────────────────────────────────────────────────────────┐
  │  postgres:16.4 ──healthy──► migrate (one-shot, db/migrate.cjs)     │
  │  (volume fuatilia_pgdata)        │ service_completed_successfully  │
  │        │                         ▼                                 │
  │        │                  api (Go /v1, healthcheck /v1/health)     │
  │  nats:2.11 ──healthy──► worker (outbox relay → JetStream)          │
  │  (volume fuatilia_nats)        │                                   │
  │                                ▼                                   │
  │                          frontend (Next.js standalone, BFF)        │
  └────────────────────────────────────────────────────────────────────┘
```

- **Boot order is enforced by `depends_on` conditions**: postgres healthy →
  migrate completes → api healthy → frontend; worker waits on nats healthy +
  migrate. A failed migration keeps every binary down — a service never boots
  against the wrong schema.
- **Only `api` and `frontend` publish ports.** PostgreSQL and NATS are
  unreachable from outside the compose network (this is what makes the
  migration runner's trust-auth posture safe — rationale in
  [DEPLOY.md](DEPLOY.md) § "Why trust auth in this compose").
- **Volumes**: `fuatilia_pgdata` holds truth (back it up);
  `fuatilia_nats` holds delivery buffering (rebuildable — replay from PG).
- **Environment contract**: everything is interpolated from `.env`
  ([.env.example](../.env.example) is the committed contract; placeholders are
  `CHANGE_ME`, secrets are generated, `.env` is gitignored).
  `scripts/validate_deploy.py` statically enforces the contract in both
  directions — an env var read by compose, Go, db/*.cjs or frontend without a
  `.env.example` key breaks the build.
- **Deliberately absent from the stack**: Temporal (ADR-0004 — durable
  workflows arrive with the roadmap that needs them) and ClickHouse
  (ADR-0002 — analytics projections at P4). Kubernetes is out of scope;
  "complexity is earned" ([VISION.md](VISION.md) §5).
- **Images**: multi-stage distroless builds from `backend-go/Dockerfile`
  (targets `api`, `worker`) and `frontend/Dockerfile`.

---

## 7. ADR summaries (full text in [DECISIONS.md](DECISIONS.md) — link, don't duplicate)

| ADR | Decision in one line |
|---|---|
| [ADR-0001](DECISIONS.md) | TypeScript domain = specification + conformance oracle; Go = production port target; parity proven by ported test scenarios. |
| [ADR-0002](DECISIONS.md) | PostgreSQL is the only financial source of truth; Redis/ClickHouse/S3/AI stores hold cache, rebuildable projections, objects, features — never truth; every derived store is reconstructible from PG + the event log. |
| [ADR-0003](DECISIONS.md) | Transactional outbox → NATS JetStream, at-least-once end-to-end; consumers idempotent by eventId forever; per-org ordering preserved; the relay may reorder nothing within an aggregate. |
| [ADR-0004](DECISIONS.md) | Temporal for durable, time-spanning workflows (dunning ladders, promise/link expiry, delivery ladders, GL reconciliation); cron only for stateless idempotent jobs. Workflows call the lanes' pure decision functions — the lane stays the brain, Temporal owns time. |
| [ADR-0005](DECISIONS.md) | AI never mutates financial truth. The only execution path is recommendation → policy engine → (approval quorum) → deterministic lane → audit record. Agent principals are narrowly-scoped API keys under the same guardrails. |

---

## 8. Invariants and where they are proven

The testable rules (R1–R10 + the K/H/C findings) live in
[07-invariants.md](07-invariants.md). Each one is proven at three levels:

1. **Domain tests** — table-driven specs in `src/domain/**/*.spec.ts`
   (hermetic, fake clocks, boundary tables);
2. **DDL** — constraints and DEFERRABLE COMMIT triggers in
   `db/migrations/*.sql`, every constraint commented with its invariant ID;
   proven to actually **fire** by the 25 assertions in `db/smoke.cjs`
   (run via `bash db/validate.sh`);
3. **Go conformance** — ported scenarios in `backend-go/pkg/money/conformance_test.go`
   and the integration suites under `backend-go/internal/` (real PostgreSQL,
   real JetStream, `-race`, no silent skips).

---

## 9. Where to read next

| Question | Document |
|---|---|
| What do the nine contexts own? | [01-context-map.md](01-context-map.md) |
| Aggregates, entities, relationships | [02-domain-model.md](02-domain-model.md), [docs/design/diagrams/README.md](design/diagrams/README.md) |
| Every lifecycle, diagrammed | [03-state-machines.md](03-state-machines.md) |
| The 27 events + envelope contract | [04-event-catalog.md](04-event-catalog.md), `src/domain/events/` |
| Fields, money semantics, id formats | [05-data-dictionary.md](05-data-dictionary.md) |
| The invariants | [07-invariants.md](07-invariants.md) |
| How to stand the stack up | [DEPLOY.md](DEPLOY.md), `Makefile` targets |
| Current engineering status | [ENGINEERING_STATUS.md](ENGINEERING_STATUS.md), [BACKLOG.md](BACKLOG.md) |
| How to change all of this | [CONTRIBUTING.md](CONTRIBUTING.md) |
