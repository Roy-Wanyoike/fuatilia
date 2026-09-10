-- 0004_collector_effectiveness.sql — collection effectiveness ratios over a
-- trailing window (issue #89; formula parity with
-- src/domain/projections/effectiveness.ts, issue #24, SPEC §66).
--
-- MEANING
--   For every (org, currency, activity day) a trailing 30-day window
--   [day − 29, day] (inclusive bounds, effectiveness.ts EffectivenessWindow)
--   carrying the three explainable ratio figures:
--
--     collected_vs_billed  Σ collected minor / Σ billed minor   (money ratio)
--     promise_kept         kept promises / resolved promises    (count ratio)
--     dispute_rate         disputes raised / invoices billed    (count ratio)
--
--   Every figure is an ACTUAL historical ratio — kind:'actual' discipline.
--   Ratios may exceed 1 legitimately (collections of invoices billed before
--   the window); they are reported as-is, NEVER clamped (effectiveness.ts).
--
-- FORMULA — port of effectiveness.ts (collectionEffectiveness):
--   collected_vs_billed = collected_minor / billed_minor, both summed from
--                         events whose created_at falls inside the window
--                         (inclusive [window_start 00:00, window_end end-of-day]).
--                         Collected = receivable.partiallySettled (E06
--                         amountMinor) + receivable.settled (E07 — the balance
--                         settled away at settle time) + receivable.recovered
--                         (E10, post-write-off recoveries). Billed =
--                         invoicing.invoiceIssued (E02 totalMinor) minus
--                         invoicing.invoiceVoided (E04) totals. Money figures
--                         are PER CURRENCY (docs/07 R10: cross-currency sums
--                         are structurally impossible — the currency key
--                         enforces it at the storage layer).
--   evidence_refs       numerator contributors first, then denominator-only
--                         contributors, canonical input order, deduped
--                         (effectiveness.ts evidenceRefs verbatim).
--
-- NULL-WITH-REASON DISCIPLINE — the heart of this table (issue #89):
--   The v1 event catalog (docs/04) cannot honestly produce two of the three
--   figures, and this table SAYS SO instead of writing a misleading 0:
--     promise_kept → NULL always, promise_kept_reason =
--       'no promise-made/kept event in the v1 event catalog (only
--       collections.promiseBroken exists)' — E27 gives broken outcomes only;
--       kept outcomes are unobservable, so kept/resolved is not computable.
--       promises_broken carries the observable evidence count.
--     dispute_rate → NULL always, dispute_rate_reason =
--       'no dispute event in the v1 event catalog' — no E-dispute event
--       exists; disputes_raised is structurally 0 in v1.
--   collected_vs_billed → NULL exactly when billed_minor = 0 in the window,
--       reason 'no billed amount in window' (effectiveness.ts wording).
--   When the catalog grows the missing events (the envelope is additive),
--   the figures light up WITHOUT a schema change — the reasons are data,
--   not structure.
--
-- COLLECTOR ATTRIBUTION (honest v1 limitation, same discipline):
--   collector_id is '' on every v1 row: no v1 event payload attributes an
--   action to a collector (E26 caseOpened carries trigger, not actor; cases
--   have owner_id in PostgreSQL, but the event fabric does not publish it).
--   The column exists so per-collector rows appear the moment an attribution
--   event lands — until then org-level rows are the truth, and this header is
--   the disclosure.
--
-- LABELING (REAL-labels)
--   label = 'derived_from_events'; as_of = window_end closing instant (the
--   window the figure is measured as of, effectiveness.ts asOf); computed_at
--   = deterministic watermark (byte-identical replay).
--
-- ENGINE + ORDER BY
--   ReplacingMergeTree(computed_at) — newest fold wins.
--   ORDER BY (org_id, currency, window_end, collector_id): dashboards ask
--   "effectiveness for this org/currency over recent windows" and pivot
--   collector — the key matches that scan.
--
-- REBUILD PATH
--   Disposable: TRUNCATE collector_effectiveness, re-fold event_fact
--   (0001 header). Zero secrets. Column parity enforced by ddl_parity_test.go.

CREATE TABLE IF NOT EXISTS collector_effectiveness
(
    org_id                     String,
    currency                   LowCardinality(String),
    window_start               Date,
    window_end                 Date,
    collector_id               String DEFAULT '',
    collected_minor            Int64,
    billed_minor               Int64,
    collected_vs_billed        Nullable(Float64),
    collected_vs_billed_reason LowCardinality(String) DEFAULT '',
    promises_broken            UInt32,
    promise_kept               Nullable(Float64),
    promise_kept_reason        LowCardinality(String) DEFAULT '',
    disputes_raised            UInt32,
    dispute_rate               Nullable(Float64),
    dispute_rate_reason        LowCardinality(String) DEFAULT '',
    evidence_refs              Array(String),
    label                      String DEFAULT 'derived_from_events',
    as_of                      DateTime64(9, 'UTC'),
    computed_at                DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (org_id, currency, window_end, collector_id);
