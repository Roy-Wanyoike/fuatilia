-- 0003_aging_migration.sql — daily AR aging buckets, per currency
-- (issue #89; formula parity with src/domain/projections/aging.ts, issue #24).
--
-- MEANING
--   How outstanding debt MIGRATES across the standard AR buckets day over
--   day: for every (org, currency, activity day) the closing book is bucketed
--   and ALL FIVE buckets are emitted zero-filled, in AGING_BUCKETS order —
--   reading two consecutive days shows exactly how much rolled from 'current'
--   into '1-30', '31-60', '61-90', '90+' (or was collected/written off away).
--
--   Buckets are PAST-DUE buckets (aging.ts): 'current' = not yet past due
--   (including due exactly now), '1-30'/'31-60'/'61-90'/'90+' = whole days
--   past due.
--
-- FORMULA — port of aging.ts (agingBucketFor / daysOverdue / arAgingByBucket):
--   days past due = max(0, floor((asOf − dueDate) / 24h)) — whole days,
--                   FLOORED (a partial late day is not yet a full day late)
--                   and CLAMPED at 0 (future dues are never negative).
--   bucket        = day ≤ 0 → 'current'; ≤ 30 → '1-30'; ≤ 60 → '31-60';
--                   ≤ 90 → '61-90'; else '90+'. Boundaries pinned by tests
--                   citing aging.spec.ts (day 1 → '1-30', day 30 → '1-30',
--                   day 31 → '31-60', day 90 → '61-90', day 91 → '90+';
--                   1ms past the due instant is still day 0).
--   zero-balance  settled/zero-balance facts contribute nothing to age —
--                   skipped from buckets and counted in dso_daily.
--                   zero_balance_receivables (aging.ts zeroBalanceCount).
--   asOf          the day-closing instant (UTC end-of-day) — the same
--                   instant dso_daily stamps as as_of, so the two tables
--                   agree for the same day.
--   Balance truth / voided-invoice exclusion: identical to dso_daily
--                   (E05 original, E06 remainingMinor authoritative, E07/E09
--                   → 0; E04-voided invoices excluded).
--
-- EVIDENCE (aging.ts "every figure is self-contained and traceable")
--   evidence_refs = the receivable ids that contributed to THIS bucket row,
--   in canonical input order (aging.ts evidenceRefs, input order preserved).
--
-- LABELING (REAL-labels)
--   label = 'derived_from_events' always; as_of = day-closing instant;
--   computed_at = deterministic watermark (byte-identical on replay).
--   Actuals only — never a projection of future aging.
--
-- ENGINE + ORDER BY
--   ReplacingMergeTree(computed_at) — newest fold of the same key wins.
--   ORDER BY (org_id, currency, day, bucket): the dashboard's aging-migration
--   chart reads one org+currency over a day range and pivots bucket — the key
--   matches that scan exactly.
--
-- REBUILD PATH
--   Disposable: TRUNCATE aging_migration, re-fold event_fact (0001 header).
--   Zero secrets. Column parity enforced by ddl_parity_test.go.

CREATE TABLE IF NOT EXISTS aging_migration
(
    org_id           String,
    currency         LowCardinality(String),
    day              Date,
    bucket           LowCardinality(String),
    amount_minor     Int64,
    receivable_count UInt32,
    evidence_refs    Array(String),
    label            String DEFAULT 'derived_from_events',
    as_of            DateTime64(9, 'UTC'),
    computed_at      DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (org_id, currency, day, bucket);
