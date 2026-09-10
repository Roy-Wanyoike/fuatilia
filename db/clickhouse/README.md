# db/clickhouse — the analytics read-model DDL (issue #89, ADR-0002)

DDL for the ClickHouse analytics store: **strictly rebuildable, strictly
read-model** (ADR-0002: PostgreSQL is the only financial source of truth;
ClickHouse holds analytics projections rebuilt from the event stream — never
a balance authority). Nothing here can move money; the ingester's entire
write surface is these five tables.

## Files, in application order

| File | Table | Engine | Key (ORDER BY) |
|---|---|---|---|
| `0001_event_fact.sql` | `event_fact` | `ReplacingMergeTree(computed_at)` | `(org_id, event_id)` |
| `0002_dso_daily.sql` | `dso_daily` | `ReplacingMergeTree(computed_at)` | `(org_id, currency, day)` |
| `0003_aging_migration.sql` | `aging_migration` | `ReplacingMergeTree(computed_at)` | `(org_id, currency, day, bucket)` |
| `0004_collector_effectiveness.sql` | `collector_effectiveness` | `ReplacingMergeTree(computed_at)` | `(org_id, currency, window_end, collector_id)` |
| `0005_cohort_recovery.sql` | `cohort_recovery` | `ReplacingMergeTree(computed_at)` | `(org_id, currency, cohort_month, days_since_open)` |

Apply with `clickhouse-client` in number order (the numbers are order
documentation, not a runner — no ClickHouse migration runner exists in this
repo yet; `db/migrate.cjs` is PostgreSQL-only). Tables are independent —
the order is convention so the ledger (the rebuild source) always exists
first. Every statement is idempotent (`CREATE TABLE IF NOT EXISTS`).

## Labeling discipline (REAL-labels, issue #89)

Every exported projection row carries:

- `label = 'derived_from_events'` — always; nothing in this store is a
  prediction, mirroring `src/domain/projections` `kind:'actual'` discipline.
- `as_of` — the reporting instant the figure was measured at.
- `computed_at` — the **deterministic processing watermark**: the
  `created_at` of the last canonical event folded for the org. Replaying the
  same event stream reproduces `computed_at` byte-for-byte (it is derived
  from events, never from the wall clock). Dashboard freshness lag is
  `now() − max(computed_at)` at query time.

## NULL-with-reason discipline

Where the v1 event catalog cannot honestly produce a figure, the figure is
`NULL` **with a prose reason** in its companion `*_reason` /
`null_reason` column — never a silently misleading 0
(`src/domain/projections/effectiveness.ts` discipline). In v1 this is
structural for `promise_kept` (no promise-made/kept event — only
`collections.promiseBroken` exists) and `dispute_rate` (no dispute event).
The reasons are data, not structure: when the catalog grows the missing
events (the envelope is additive), the figures light up without a schema
change.

## Rebuild path (ADR-0002 consequence)

1. `event_fact` is the **only** rebuild source — never truncate it.
2. Projections are disposable:
   `TRUNCATE TABLE dso_daily; TRUNCATE TABLE aging_migration; TRUNCATE TABLE collector_effectiveness; TRUNCATE TABLE cohort_recovery;`
3. Re-fold: `backend-go/internal/analytics` `RebuildFromLedger` reads
   `SELECT org_id, event_id, name, version, created_at, payload FROM event_fact FINAL ORDER BY org_id, created_at, event_id`
   through the injected Driver port and re-derives every projection.
4. Re-derived rows are **byte-identical** to the originals: the fold is a
   pure function of the per-org `(created_at, event_id)`-ordered ledger —
   the same canonical order `Outbox.drain()` guarantees on the wire — proven
   by the determinism tests in `backend-go/internal/analytics`.

## Honesty notes

- No ClickHouse server exists in the build environment: this DDL is written
  against the ClickHouse SQL dialect but has **not** been executed against a
  real cluster. Column/name parity between this DDL and the ingester's SQL
  contract (the only writer) is enforced by `ddl_parity_test.go` in
  `backend-go/internal/analytics` until a real cluster can run it.
- Zero secrets: no connection strings, hosts, users or credentials appear in
  these files or in the ingester. Database name and cluster topology are
  deployment concerns, chosen at commissioning time.
- The engines are `ReplacingMergeTree(computed_at)` throughout: the ingester
  re-derives rows and upserts the same deterministic keys; the version column
  makes the newest fold win. Audited reads use `SELECT ... FINAL`.
