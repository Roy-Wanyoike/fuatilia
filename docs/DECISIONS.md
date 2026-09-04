# DECISIONS — Architecture Decision Records

> Statuses: all ADRs below are **Accepted** as of `c65ffba`. They encode commitments already
> visible in the repository and the target stack mandated by
> [docs/SPEC.md](SPEC.md) (§41 "Technology Stack", §39 "Event-Driven Architecture", §40
> "Temporal Workflows", §42 "Database Architecture"), tightened by the production audit
> ([PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md)) and phased in
> [PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md).
>
> Format per ADR: Context / Decision / Consequences / Alternatives.

---

## ADR-0001 — TypeScript domain = specification; Go = production core

**Status:** Accepted

### Context

The repository's entire implementation is a pure TypeScript domain core — `src/domain/**` has
no I/O, injected Clock/RNG, and 2,665 table-driven tests green at `c65ffba` (see
[ENGINEERING_STATUS.md](ENGINEERING_STATUS.md)). Meanwhile SPEC §41 declares the production
backend stack "Mandatory: Go … REST … OpenAPI" and §55 prescribes a Go modular-monolith
layout (`backend/cmd/{api,worker,migration}`, `internal/…` per lane). The repo today has no
Go code (no `go.mod` — verified in [PRODUCTION_AUDIT.md](PRODUCTION_AUDIT.md) §2). The gap
between "the behavior is done" and "the mandated runtime is Go" must be resolved without
wasting the largest asset: an invariant-dense, fully tested behavioral model (R1–R10,
[docs/07-invariants.md](07-invariants.md)).

### Decision

The existing TypeScript domain is the **behavioral specification, reference implementation
and invariant catalog** — the executable definition of what Fuatilia does, kept green forever
as the conformance oracle. **Go is the production port target**: the Go core re-expresses the
TS lanes' behavior against PostgreSQL/NATS/Temporal, and port progress is measured by
conformance — Go must reproduce TS outputs on identical event streams, fixture-for-fixture
(the `src/adapters/daraja/` conformance-suite pattern: frozen fixtures + replay + per-delivery
outcome ledger, generalized). The TS `/v1` kernel (`src/adapters/http/`) and its route table
remain the API contract seed until the Go API reaches parity
([PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) P0→P1).

### Consequences

- **Positive:** the hardest 60% (money semantics, invariants, refusal paths) is already
  specified and tested — the port starts from a green oracle, not a blank page; money bugs
  are caught twice (once per implementation); the spec cannot rot because it executes.
- **Negative:** two implementations must be kept in conformance — a permanent double-test
  tax; behavioral changes must land in the spec first, then the port (a deliberate
  velocity brake on the money path).
- **Neutral:** Node remains a legitimate runtime for tooling, fixtures generation and the
  conformance harness itself.

### Alternatives

1. **Ship the TypeScript core to production as-is** — fastest, but violates the SPEC's
   mandated stack; rejected as the production target (the TS kernel still serves as the
   reference API).
2. **Rewrite the domain in Go and discard TS** — single implementation, but it throws away
   2,665 tests of executable specification and re-derives every invariant by memory;
   rejected.
3. **Dual production runtimes (TS + Go) behind a gateway** — two production money paths to
   keep in sync forever; the worst of both; rejected.

---

## ADR-0002 — PostgreSQL is the only financial source of truth; Redis/ClickHouse/AI never are

**Status:** Accepted

### Context

SPEC §42: "PostgreSQL is the transactional source of truth," with Redis, ClickHouse and
S3 in the stack (§41) for cache/analytics/objects. Today nothing durable exists: financial
aggregates live in an in-memory process-global store
(`src/adapters/http/runtime/resources.ts`) and the only persistence is the file-backed auth
store (`src/adapters/persistence/filestore.ts`). The domain's ledger-first design
(`docs/06-review-findings.md`, R3 append-only postings) requires exactly one authoritative
home for balances, postings and their event log — multi-tenancy must be solved in the same
schema (the audit's CRITICAL gap: receivables/payments aggregates carry no `orgId` at rest —
`src/adapters/http/routes/receivables.ts` header).

### Decision

**PostgreSQL is the only system of record for every financial fact** — receivables, payments,
allocations, adjustments, ledger postings, cases, promises, disputes, links, comms state,
webhook registrations, audit records, and the transactional outbox. Derived stores have
narrow, rebuildable roles: **Redis** = ephemeral cache/locks only (losing it may cost
latency, never truth); **ClickHouse** = analytics projections rebuilt from the event stream;
**S3** = immutable objects (bodies, exports); **AI/model stores** = features and predictions
only. Every derived store must be reconstructible from PostgreSQL + the event log (the
`Outbox.replay()` determinism contract in `src/domain/events/outbox.ts` is the rebuild
primitive). All financial rows carry `org_id` with row-level isolation enforced in the schema
— closing the audit's D1 debt at the storage layer, not in route code.

### Consequences

- **Positive:** one consistency story (ACID transactions + the outbox for events); crash
  recovery is a solved problem (point-in-time recovery); multi-tenancy and audits anchor to
  one schema; projections can be re-run fearlessly.
- **Negative:** PostgreSQL becomes a scaling focus (partitioning, replicas) before
  ClickHouse absorbs reads; strict rule discipline is needed so "just cache it in Redis"
  never becomes "store it in Redis".
- **Risk accepted:** analytical workloads may need careful capacity planning until P4's
  metering scale arrives.

### Alternatives

1. **Event-sourcing-only (no relational truth)** — elegant with the typed catalog, but
   balances need synchronous consistency and regulatory queries need relational integrity;
   rejected as sole truth (the outbox pattern gets the benefits).
2. **MongoDB/document store** — flexible schema for a fast start, but the posting matrix and
   ceiling invariants (R1/R2/R6/R7) want transactions and constraints; rejected.
3. **Multi-source truth (Redis-authoritative hot balances)** — classic split-brain money
   bugs; violates ledger-first principle 1; rejected.

---

## ADR-0003 — Transactional outbox + NATS JetStream for the event fabric

**Status:** Accepted

### Context

The typed event catalog and the outbox are domain-complete as a **pure, in-memory contract**
(`src/domain/events/outbox.ts`: ordered append with `OUTBOX_DUPLICATE` dedupe, per-consumer
cursors, at-least-once drain, deterministic full replay). SPEC §39 mandates NATS JetStream
for event-driven architecture. The gap is runtime: today a state change and its events are
atomic only inside the caller's imagination — there is no broker, no relay, no delivery
guarantee. At-least-once semantics are already the domain's native assumption (Daraja
callbacks are at-least-once and intake is idempotent by construction, R9:
`src/domain/payments/intake.ts`), so the fabric may safely be at-least-once too.

### Decision

Events are published via the **transactional outbox pattern**: each state change inserts its
events into an outbox table **in the same PostgreSQL transaction** as the state change
(ADR-0002), and a relay drains the outbox to **NATS JetStream** with per-consumer durable
cursors mirroring `Outbox.drain()` semantics. Delivery is **at-least-once end-to-end**;
therefore every consumer MUST be idempotent, exactly as the domain lanes already are
(`payments.duplicateCallbackObserved` tripwires, idempotent webhook enqueue in
`src/domain/webhooks/attempts.ts`, idempotent link redemption in
`src/domain/paymentlinks/redeem.ts`). Event shape and ordering guarantees come from the
catalog envelope (`src/domain/events/envelope.ts`); the relay may reorder nothing within a
partition key (aggregate id).

### Consequences

- **Positive:** no dual-write inconsistency ever (state without event, or event without
  state); the existing pure `Outbox` class is the direct contract for the relay; replay
  rebuilds projections deterministically; at-least-once matches the domain's tested
  assumptions instead of inventing exactly-once folklore.
- **Negative:** consumers carry idempotency obligations forever (enforced in review +
  conformance tests); the relay is new critical infrastructure needing its own monitoring
  (outbox lag, redelivery counts); JetStream is one more stateful system to operate.
- **Note:** consumers needing request/response still call the API; the fabric is for facts.

### Alternatives

1. **Dual-write straight to the broker** (publish in the same code path as the DB write) —
   simple, and silently lossy on partial failure; rejected.
2. **Kafka instead of NATS** — stronger ecosystem gravity, heavier ops footprint than SPEC
   §41 mandates for this scale; rejected for now (the outbox seam keeps the broker
   swappable).
3. **Database-as-queue (SKIP LOCKED polling only)** — works at small scale and is the P0
   fallback, but doesn't satisfy §39's streaming requirements (fan-out, replay windows,
   retention); kept only as the relay's read mechanism, not the fabric.

---

## ADR-0004 — Temporal for durable workflows; no cron for stateful flows

**Status:** Accepted

### Context

The collections lifecycle is a set of long-running, multi-day stateful flows: dunning ladders
span D−3 → D+60 with consent blocks and escalations (`src/domain/promises/dunning.ts`
`DEFAULT_DUNNING_LADDER`), promises expire after grace days, payment links expire
(`src/domain/paymentlinks/link.ts` `expireIfDue`), webhook deliveries climb a 6-step retry
ladder to dead-letter (`src/domain/webhooks/attempts.ts`), and GL reconciliation runs as a
job (`src/domain/ledger/reconciliation.ts`). These are pure functions today that a caller
must drive at the right times — and no such caller exists (audit: "Background workers —
NOT STARTED"). Cron-of-truth for stateful money-adjacent flows is a known reliability trap:
downtime silently skips steps, retries are hand-rolled, and state lives outside the
scheduler. SPEC §40 mandates Temporal.

### Decision

**Temporal is the durable execution layer for every stateful, time-spanning flow** — dunning
orchestration, promise/link expiry, webhook delivery ladders, GL reconciliation, approval
chases, and later the agentic execution flows of
[PRODUCT_ROADMAP.md](PRODUCT_ROADMAP.md) P3. The pattern: Temporal workflows call the lanes'
pure decision functions (e.g. `dueSteps`, `decideRetry`, `expireIfDue`) — the lane stays the
brain, Temporal owns time, retries, and durability. **Plain cron is allowed only for
stateless, idempotent, at-least-once jobs** (report snapshots, projection refreshes,
reconciliation *scheduling*) — never as the driver of a stateful transition; any flow that
would need to "remember where it was" belongs in Temporal.

### Consequences

- **Positive:** no missed dunning steps after a 3 a.m. deploy; retries/timeouts are platform
  features, not bespoke code; workflow history doubles as an execution audit trail feeding
  the audit lane (`src/domain/audit/`); the pure lanes keep their determinism (Temporal
  injected as the clock/trigger port).
- **Negative:** one more stateful system to run (P0's compose deploys it); workflows must be
  deterministic — non-deterministic lane calls are a review gate; SDK surface for Go/TS must
  be pinned per ADR-0001.
- **Migration note:** the pure ladders remain usable in tests and by the TS reference
  runtime; Temporal wraps them, never replaces them.

### Alternatives

1. **Cron + DB state columns** — zero new infra, and the classic path to skipped/Double
   dunning sends; rejected for stateful flows.
2. **BullMQ / queue-delayed jobs** — fine for one-shot retries, weak for multi-day sagas
   with visibility; rejected.
3. **Build a bespoke scheduler on the outbox** — control, but it is a durable-execution
   engine in disguise (the hardest kind of software to get right); rejected.

---

## ADR-0005 — AI never mutates financial truth; policy engine + approvals + audit is the only execution path

**Status:** Accepted

### Context

Fuatilia is "AI-native" by thesis (`docs/VISION.md`): NBA ranking (F22), explainable memory
(F23), behavior anomalies (F19), reconciliation intelligence. The repo already encodes the
guardrails as tested code: the policy engine is fail-closed with machine-readable refusals
(`src/domain/policy/engine.ts`: unknown action → deny, no rule matched → deny, every decision
emits `policy.decisionRecorded`); maker-checker approvals enforce distinct-approver quorums
and never execute operations themselves (`src/domain/approvals/`); the audit trail is
append-only with hash-chain tamper evidence and redaction (`src/domain/audit/`); consent
gates (K2) block automated contact without a grant (`src/domain/consent/guard.ts`,
`src/domain/collections/actions.ts`, `src/domain/communications/guard.ts`); and the
intelligence lanes are read-only by construction (`src/domain/agent/README.md`: "every
function here is a pure, read-only projection… Executing a recommendation is other lanes'
work, gated by the policy engine — never this module"). README design principle 2 states the
invariant positively: "The intelligence layer never owns fund truth."

### Decision

**No AI/ML component may write financial state. Ever.** The ONLY path from a recommendation
(whether AI-generated, rule-generated, or human) to a state change is:
**recommendation → policy engine evaluation → (require_approval ⇒ maker-checker approval
quorum) → deterministic execution lane → audit record**. AI owns prediction,
classification, prioritization, natural-language interfaces and drafting; deterministic
software owns money, permissions, compliance and workflow guarantees (the VISION §4 divide,
non-negotiable). Agent principals are just principals: narrowly-scoped API keys
(`src/domain/auth/apikeys.ts` — wildcards forbidden), subject to the escalation guard
(`AUTH_ESCALATION_BLOCKED`), rate limits, and a global automation kill-switch. Every
autonomous action is attributable: actor, policy decision id, approval id, audit chain entry.

### Consequences

- **Positive:** regulator- and enterprise-credible ("human-controlled autonomy for financial
  operations", VISION §3.5); an AI bug can degrade recommendations, never balances; the
  audit chain answers "why did the system do that?" with evidence ids end-to-end
  (`src/domain/memory/` claims carry `computedFrom` event anchors).
- **Negative:** AI value delivery is bounded by the speed of the governance rails (new
  autonomous actions need policy rules + approval policy + audit coverage, not just model
  work); some latency for human-in-the-loop steps is accepted by design.
- **Enforcement:** conformance tests must include "AI output presented as input to every
  fund-truth lane is refused without a policy decision id" — a port target for the Go
  conformance suite (ADR-0001).

### Alternatives

1. **Agentic writes with post-hoc auditing** — maximally flexible, catastrophic for trust;
   rejected outright (contradicts README principle 2).
2. **AI writes below thresholds without policy review** — "small money" leaks normalize
   ungoverned writes and poison the audit story; rejected.
3. **Separate AI sandbox system with manual export/import into the ledger** — safe but
   disconnects intelligence from execution, recreating the spreadsheets Fuatilia exists to
   kill; rejected in favor of the governed in-platform path.
