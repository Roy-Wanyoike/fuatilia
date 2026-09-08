# PostgreSQL persistence adapters (`src/adapters/persistence/pg/`)

Issue #73 (F34). The production swap for the kernel's process-global stores: `PGAuthStore`
implements `AuthStore` (`src/adapters/http/runtime/memory.ts`) and `PGResourceStore`
implements `ResourceStore` (`src/adapters/http/runtime/resources.ts`) — same contracts, same
copy-on-read/upsert-save semantics, durable state in PostgreSQL (`db/migrations/0001–0014`
plus this adapter's idempotent lane DDL). `server.ts` accepts both through its existing
`options.store` / `options.resourceStore` seams with zero kernel edits.

## Why a cache-first SYNCHRONOUS facade

The kernel seams are synchronous (`users(): readonly User[]`, `saveUser(user: User): void`).
A direct async pg implementation cannot satisfy them, so the adapters wrap one PostgreSQL
database with three cooperating parts:

1. **In-memory projection** — every synchronous read is served from a Map keyed by
   `(org, aggregate id)`; the projection is loaded from PostgreSQL inside ONE transaction
   at boot.
2. **Write queue** — every `save*` mutates the projection AND enqueues the change; reads
   are therefore immediately consistent with the writes the process performed.
3. **Async flusher** — drains the queue in order, one PostgreSQL transaction per batch;
   `flush()` (tests, graceful stop) waits until every enqueued mutation is durable.

Failure semantics: the first failed batch is **sticky** — further `save*` calls throw until
a successful `flush()` re-arms the store. The queue itself survives (in-process), so a
dead database that comes back never loses accepted writes. **Crash window:** a process
death after a projection mutation but before the flush loses exactly the un-flushed
mutations — the database never holds a PARTIAL aggregate (one batch = one transaction),
and a re-boot's projection is whatever PostgreSQL actually committed. This is the same
guarantee class as the filestore's journal: durability is bounded by the flush interval,
correctness is not.

Boot (`ensureReady()`) is idempotent: it runs the adapter's lane DDL, then reloads the
projection. Rows that fail structural revival are **quarantined** (moved to
`fuatilia_lane_quarantine` with the parse error, counted in the `PGLoadReport`, skipped) —
a malformed row can never poison a boot; it remains a forensic record. `flush()` drains
and re-arms; `close()` ends the pool the client owns.

## Seam mapping

| Seam (`runtime`) | PostgreSQL | Adapter rule |
|---|---|---|
| `AuthStore.users/roles/grants/keys/sessions` | `users`, `roles`, `role_assignments`→grants, `api_keys`, `sessions` (migrations 0002) | upsert by id; keys stored **hashed via the store's `SecretCodec`** (default SHA-256) — the plaintext secret never reaches a column |
| `AuthStore.record/events` (audited denials) | adapter lane table `fuatilia_lane_events` + `audit_events` (0013) | append-only; org derived defensively from `payload.orgId` |
| `ResourceStore.receivables/payments/cases` | `receivables` (0004), `payments` (0005), `collections_cases` + `case_actions` + `collections_case_receivables` (0009) | upsert by id; case actions/history ride the case row's jsonb, mirrored to `case_actions` |
| `ResourceStore.nextCaseSequence(orgId)` | `case_sequences` (0009) | `UPDATE … SET next = next + 1 WHERE org_id = $1 RETURNING next` on the DB path; the sync facade hands out from a RESERVED block (hi-lo: boot pre-reserves a block inside the boot transaction, `flush()` reserves more before the local block runs out) — never read-modify-write from the request path |
| `ResourceStore.record/events` (lane events) | `fuatilia_lane_events` | append-only, org from `payload.orgId` |
| — (adapter-owned) | `fuatilia_case_lane_state`, `fuatilia_lane_quarantine` | case-lane state mirror; quarantine for structurally invalid rows |

## Org scoping — where multi-org isolation is enforced

Every table row carries `org_id`. The adapters take an `orgScope` option:

- **Scoped store** (`new PGResourceStore(client, { orgId })`): reads are filtered to the
  org; receivable/payment saves are written under the scope; a case carrying ANOTHER
  org's id is refused (`PG_ORG_SCOPE_MISMATCH`).
- **Unscoped store**: single-tenant process-global semantics for cases/events; org-LESS
  lane saves (receivables/payments, whose aggregate shape carries no org) are REFUSED
  (`PG_ORG_SCOPE_REQUIRED`) — no financial fact may enter PostgreSQL without an org.
- The isolation spec (`isolation.spec.ts`) proves the strong version: identical aggregate
  ids under two orgs, zero cross-org reads/writes, independent sequences.

## Environment

| Variable | Meaning |
|---|---|
| `FUATILIA_PG_HOST` / `FUATILIA_PG_PORT` / `FUATILIA_PG_DATABASE` / `FUATILIA_PG_USER` / `FUATILIA_PG_PASSWORD` | production pool config (explicit `config` wins; password may be null for trust/peer auth) |
| `FUATILIA_PG_MAX_CONNS` / `FUATILIA_PG_IDLE_TIMEOUT_MS` / `FUATILIA_PG_MAX_LIFETIME_MS` | pool knobs |
| `FUATILIA_PG_SLOW_QUERY_MS` | slow-query log threshold (default 250 ms) |
| `FUATILIA_TEST_DATABASE_URL` | the specs' lane cluster (default `postgres://postgres@127.0.0.1:5435/fuatilia_pgadapters_test`) |
| `FUATILIA_PG_BIN_DIR` | portable PostgreSQL 16 binaries for the ephemeral-cluster specs (default `/home/z/my-project/tools/pg164/bin`) |

Cluster bootstrap for the specs: `testutil.ts` proves reachability (an unreachable cluster
FAILS the run — never a silent skip), applies `db/migrations/*.sql` through the repo's own
`db/migrate.cjs` under a PostgreSQL advisory lock, and can spawn a THROWAWAY cluster (real
`initdb` + `pg_ctl`) for the dead-postmaster and crash-recovery suites. `purgeOrgs()` is the
only deleter in this folder — test hygiene only (production code never deletes, R3).

## Security & observability

- **Parameterized SQL only** — every statement goes through `query(name, text, values)`;
  statement names power the slow-query log.
- **Least privilege**: the adapter needs exactly the DML on the tables mapped above plus
  `UPDATE` on `case_sequences` — no superuser role is required; a dedicated role with
  grants on the public schema objects and its own lane tables suffices.
- **No credential echo**: errors and logs carry hosts/databases, never passwords or
  parameter values; the slow-query logger receives statement name + duration only.

## Known v1 limitations (honest)

- The flusher is per-instance; a multi-process deployment shares PostgreSQL but each
  process's projection only learns of OTHER processes' writes at its next `ensureReady()`
  re-boot (the kernel's single-process v1 matches the in-memory store's contract).
- The event log is an append-only lane table (the outbox-shaped record); replay into the
  projection follows the `replay.ts` quarantine taxonomy, not the Go relay's NATS path.
- `fuatilia_lane_*` tables are adapter-owned DDL (idempotent `CREATE TABLE IF NOT EXISTS`),
  not part of `db/migrations` — the dispatcher owns the shared schema; this lane owns only
  its folder.
