-- 0005_cohort_recovery.sql — cohort recovery curves (issue #89, RICE #7).
--
-- MEANING
--   A recovery curve per receivable cohort: receivables are grouped by the
--   month their receivable.opened (E05) event landed (cohort_month = first
--   day of that month, per org + currency) and the curve tracks how much of
--   the cohort's original principal has been recovered as days elapse since
--   the cohort opened.
--
--   One row per (org, currency, cohort_month, days_since_open) where
--   days_since_open counts whole days from the cohort month's first day to an
--   activity day (a day on which the cohort's cumulative collected total
--   actually moved — event-driven points, not calendar-filled; day 0 always
--   has a baseline row). Dashboards draw the curve through the observed
--   points; a cohort still accruing simply stops at its latest observed day —
--   the curve NEVER extrapolates. Actuals only (kind:'actual' discipline).
--
-- FORMULA (no TS cohort source exists; the figure/null/clamp discipline is
-- ported from src/domain/projections/effectiveness.ts and the aging model
-- from aging.ts):
--   original_cumulative_minor  Σ E05 originalMinor of the cohort's
--                              receivables, as known at fold time. During a
--                              cohort's own month the denominator grows as
--                              members open; every batch re-derives ALL of a
--                              touched cohort's points from current state and
--                              upserts them (ReplacingMergeTree), so the
--                              published curve is always the full-state view.
--   collected_cumulative_minor Σ applied-to-receivable money for the cohort's
--                              receivables up to and including
--                              days_since_open: E06 amountMinor, E07 (balance
--                              settled away), E10 recoveries.
--   recovery_rate              = collected / original, reported as-is —
--                              NEVER clamped (a cohort can legitimately
--                              recover past… nothing — rate > 1 is impossible
--                              here by construction, but the port keeps the
--                              no-clamp rule for parity and future reuse).
--
-- NULL-WITH-REASON DISCIPLINE (effectiveness.ts)
--   recovery_rate IS NULL exactly when original_cumulative_minor = 0 (a
--   cohort with no opened principal cannot have a recovery ratio; writing 0
--   would be a silently misleading figure) — null_reason then says why.
--
-- EVIDENCE
--   evidence_refs = receivable ids contributing to the NUMERATOR (collected)
--   first, then denominator-only receivables, canonical input order, deduped
--   (effectiveness.ts evidenceRefs shape).
--
-- LABELING (REAL-labels)
--   label = 'derived_from_events'; as_of = the closing instant of the day
--   this point was measured at (cohort_month start + days_since_open);
--   computed_at = deterministic watermark (byte-identical replay).
--
-- ENGINE + ORDER BY
--   ReplacingMergeTree(computed_at) — newest fold wins.
--   ORDER BY (org_id, currency, cohort_month, days_since_open): the dashboard
--   reads whole cohorts in curve order — the key IS the scan.
--
-- REBUILD PATH
--   Disposable: TRUNCATE cohort_recovery, re-fold event_fact (0001 header).
--   Zero secrets. Column parity enforced by ddl_parity_test.go.

CREATE TABLE IF NOT EXISTS cohort_recovery
(
    org_id                      String,
    currency                    LowCardinality(String),
    cohort_month                Date,
    days_since_open             UInt32,
    collected_cumulative_minor  Int64,
    original_cumulative_minor   Int64,
    recovery_rate               Nullable(Float64),
    null_reason                 LowCardinality(String) DEFAULT '',
    evidence_refs               Array(String),
    label                       String DEFAULT 'derived_from_events',
    as_of                       DateTime64(9, 'UTC'),
    computed_at                 DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (org_id, currency, cohort_month, days_since_open);
