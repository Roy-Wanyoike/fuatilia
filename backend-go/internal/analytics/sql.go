package analytics

// The SQL-string contract: every statement this package can issue, as
// constants. These strings are the interface between the ingester, the DDL
// (db/clickhouse/*.sql) and the fake driver's golden-file tests:
//
//   - ddl_parity_test.go cross-checks every table/column here against the
//     CREATE TABLE statements in db/clickhouse/*.sql — a DDL drift or a
//     contract drift fails the gate without a ClickHouse server.
//   - golden_test.go snapshots the exact (statement, args) pairs a canonical
//     event stream produces, so SQL changes are reviewed diffs.
//
// Placeholders are positional `?` (clickhouse-go style). Values only ever
// travel as parameters — no payload byte is ever concatenated into a
// statement. Nullable figures bind nil (NULL) and carry their reason in the
// companion *_reason / null_reason column.
//
// Column lists match the DDL files' column ORDER exactly (the parity test
// enforces this), so `INSERT INTO t (cols…) VALUES (…)` documents the wire
// shape of each row in one place.
const (
	// TableEventFact is the append-only (ReplacingMergeTree) event ledger —
	// the rebuild source. Every consumed event lands here exactly once per
	// (orgId, eventId), payload verbatim.
	TableEventFact = "event_fact"

	// TableDSODaily — daily portfolio snapshot + DSO (0002_dso_daily.sql).
	TableDSODaily = "dso_daily"

	// TableAgingMigration — daily AR aging buckets (0003_aging_migration.sql).
	TableAgingMigration = "aging_migration"

	// TableCollectorEffectiveness — trailing-window effectiveness ratios
	// (0004_collector_effectiveness.sql).
	TableCollectorEffectiveness = "collector_effectiveness"

	// TableCohortRecovery — cohort recovery curves (0005_cohort_recovery.sql).
	TableCohortRecovery = "cohort_recovery"
)

const (
	// SQLInsertEventFact appends one envelope to the ledger: org, event id,
	// name, version, created_at, verbatim payload, label, computed_at. For a
	// ledger row computed_at IS created_at (the row IS the event) — replay
	// therefore reproduces it byte-for-byte.
	SQLInsertEventFact = `INSERT INTO event_fact ` +
		`(org_id, event_id, name, version, created_at, payload, label, computed_at) ` +
		`VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

	// SQLInsertDSODaily upserts one (org, currency, day) portfolio snapshot:
	// closing AR, aging counts, trailing-window billed and the DSO figure.
	// dso binds nil exactly when billed_trailing_minor = 0 and null_reason
	// then says why (NULL-with-reason discipline).
	SQLInsertDSODaily = `INSERT INTO dso_daily ` +
		`(org_id, currency, day, ar_balance_minor, receivables_aged, ` +
		`zero_balance_receivables, billed_trailing_minor, dso_window_days, ` +
		`dso, null_reason, evidence_refs, label, as_of, computed_at) ` +
		`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	// SQLInsertAgingMigration upserts one (org, currency, day, bucket) row —
	// ALL five buckets are always emitted zero-filled, in AGING_BUCKETS
	// order (arAgingByBucket parity).
	SQLInsertAgingMigration = `INSERT INTO aging_migration ` +
		`(org_id, currency, day, bucket, amount_minor, receivable_count, ` +
		`evidence_refs, label, as_of, computed_at) ` +
		`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	// SQLInsertCollectorEffectiveness upserts one trailing-window
	// effectiveness row. collected_vs_billed binds nil when the window has
	// no billed amount; promise_kept and dispute_rate bind nil in v1 always
	// (no promise-made/kept event, no dispute event) with structural
	// reasons — the reasons are data, not structure.
	SQLInsertCollectorEffectiveness = `INSERT INTO collector_effectiveness ` +
		`(org_id, currency, window_start, window_end, collector_id, ` +
		`collected_minor, billed_minor, collected_vs_billed, ` +
		`collected_vs_billed_reason, promises_broken, promise_kept, ` +
		`promise_kept_reason, disputes_raised, dispute_rate, ` +
		`dispute_rate_reason, evidence_refs, label, as_of, computed_at) ` +
		`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

	// SQLInsertCohortRecovery upserts one cohort-curve point. recovery_rate
	// binds nil exactly when original_cumulative_minor = 0 (a cohort with no
	// opened principal cannot have a ratio).
	SQLInsertCohortRecovery = `INSERT INTO cohort_recovery ` +
		`(org_id, currency, cohort_month, days_since_open, ` +
		`collected_cumulative_minor, original_cumulative_minor, ` +
		`recovery_rate, null_reason, evidence_refs, label, as_of, computed_at) ` +
		`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)

// LedgerSelectSQL is the ONLY Query this lane ever issues: the deterministic
// rebuild replay over the ledger (FINAL collapse of redeliveries, canonical
// per-org (created_at, event_id) order). RebuildFromLedger scans
// (org_id string, event_id string, name string, version int64,
// created_at time.Time, payload string) in this column order.
const LedgerSelectSQL = `SELECT org_id, event_id, name, version, created_at, payload ` +
	`FROM event_fact FINAL ` +
	`ORDER BY org_id, created_at, event_id`

// DSOWindowDays is the fixed trailing billing window of the DSO and
// effectiveness rows (inclusive [day-29, day]) — documented in
// 0002_dso_daily.sql / 0004_collector_effectiveness.sql.
const DSOWindowDays = 30

// NullReasonNoBilled is the verbatim effectiveness.ts wording for a money
// ratio whose denominator is zero ('no billed amount in window'), extended
// with the window length the DSO row measured.
const (
	NullReasonNoBilledWindow   = "no billed amount in window"
	NullReasonNoBilledTrailing = "no billed amount in trailing 30-day window"
	// Structural v1 NULLs (issue #89): the v1 catalog cannot produce these
	// figures — the reasons say so instead of writing a misleading 0.
	NullReasonNoPromiseEvents = "no promise-made/kept event in the v1 event catalog (only collections.promiseBroken exists)"
	NullReasonNoDisputeEvents = "no dispute event in the v1 event catalog"
	NullReasonNoOriginal      = "cohort has no opened principal amount"
)
