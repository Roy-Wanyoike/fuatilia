-- 0002_dso_daily.sql — daily portfolio snapshot + Days-Sales-Outstanding
-- (issue #89, RICE #7 "Collections analytics on ClickHouse", SPEC §42).
--
-- MEANING
--   One row per (org, currency, activity day): the closing AR book for that
--   day and the DSO computed against the trailing sales window.
--
--   A row exists only for days on which the org's book or billing actually
--   changed (event-driven, not calendar-filled) — dashboards read the latest
--   row with day <= target. This is an ACTUALS store: nothing here is a
--   forecast; every figure is the deterministic fold of the event ledger
--   (event_fact) in per-org (created_at, event_id) canonical order — the same
--   order Outbox.drain() guarantees on the wire.
--
-- FORMULA (ported discipline; no TS DSO source exists — the null-with-reason
-- and no-clamp rules come from src/domain/projections/effectiveness.ts)
--   ar_balance_minor      Σ balances of live receivables in this currency.
--                         Balance truth: receivable.opened (E05 originalMinor),
--                         receivable.partiallySettled (E06 remainingMinor —
--                         authoritative), receivable.settled (E07 → 0),
--                         receivable.writtenOff (E09 → 0). Receivables whose
--                         invoice was voided (E04) are excluded from AR.
--   billed_trailing_minor Σ invoicing.invoiceIssued (E02 totalMinor) with
--                         event day in [day - window + 1, day]; invoiceVoided
--                         (E04) subtracts the voided invoice's total.
--   dso                   = ar_balance_minor / billed_trailing_minor
--                         × dso_window_days. Reported as-is — never clamped
--                         (collecting faster than you bill is a real,
--                         reportable state, mirroring effectiveness.ts).
--   dso_window_days       30 (fixed trailing window, inclusive bounds).
--
-- NULL-WITH-REASON DISCIPLINE (effectiveness.ts, issue #89 "labeling")
--   dso IS NULL exactly when the figure cannot be computed honestly
--   (billed_trailing_minor = 0 — DSO against zero sales is meaningless, and
--   writing 0 would be a silently misleading figure). null_reason then says
--   why, in prose a dashboard can surface verbatim.
--
-- LABELING (REAL-labels)
--   label       = 'derived_from_events' on every row, always.
--   as_of       = the row's day-closing instant (UTC end-of-day) — the
--                 instant the AR figure was measured at.
--   computed_at = the deterministic processing watermark (the created_at of
--                 the last canonical event folded for this org). Replaying
--                 the same event stream reproduces computed_at byte-for-byte;
--                 freshness lag is now() − computed_at at query time.
--
-- ENGINE + ORDER BY
--   ReplacingMergeTree(computed_at): every batch re-derives affected rows and
--   upserts the same keys — the version column makes the newest fold win
--   (SELECT ... FINAL for the audited read).
--   ORDER BY (org_id, currency, day): dashboards ask "AR + DSO for this org
--   and currency over the last N days" — the key IS the dashboard's scan.
--
-- REBUILD PATH
--   Disposable at any time: TRUNCATE dso_daily, then re-fold event_fact
--   (see 0001_event_fact.sql header). Rows reappear byte-identical.
--
-- Zero secrets. Applied manually (clickhouse-client < 0002_dso_daily.sql) —
-- no ClickHouse runner is provisioned in this environment yet; column parity
-- with the ingester's SQL contract is enforced by ddl_parity_test.go.

CREATE TABLE IF NOT EXISTS dso_daily
(
    org_id                 String,
    currency               LowCardinality(String),
    day                    Date,
    ar_balance_minor       Int64,
    receivables_aged       UInt32,
    zero_balance_receivables UInt32,
    billed_trailing_minor  Int64,
    dso_window_days        UInt32,
    dso                    Nullable(Float64),
    null_reason            LowCardinality(String) DEFAULT '',
    evidence_refs          Array(String),
    label                  String DEFAULT 'derived_from_events',
    as_of                  DateTime64(9, 'UTC'),
    computed_at            DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (org_id, currency, day);
