-- 0001_event_fact.sql — the event-fact ledger (issue #89).
--
-- WHAT THIS IS
--   The ClickHouse face of the event fabric (FUATILIA_EVENTS, ADR-0003): one
--   row per consumed envelope, payload stored VERBATIM (the relay's
--   byte-for-byte jsonb discipline — never re-encoded, never re-rounded).
--   This table is what makes every projection in this database PROVABLY
--   derived-from-events: any figure in dso_daily / aging_migration /
--   collector_effectiveness / cohort_recovery can be recomputed from these
--   rows alone, and audited row-by-row back to the producing aggregate.
--
-- WHAT THIS IS NOT
--   Not a financial source of truth (ADR-0002: PostgreSQL is the only one).
--   Not writable by anything except the analytics ingester
--   (backend-go/internal/analytics). Nothing reads this table to move money.
--
-- MEANING OF COLUMNS
--   org_id      tenant root — every row is org-scoped (row isolation at the
--               storage layer, mirroring outbox_events).
--   event_id    the envelope eventId — consumers dedupe on (org_id, event_id)
--               forever, exactly the outbox README "Consumer idempotency
--               contract". The relay guarantees (org_id, event_id) uniqueness
--               at the source (uq_outbox_events_event), so ReplacingMergeTree
--               collapses broker redeliveries deterministically.
--   name        catalog event name, e.g. 'payment.confirmed' (docs/04, E01–E27).
--   version     envelope payload schema version — part of the wire subject;
--               consumers pin it and never assume a transparent shape change.
--   created_at  the envelope's createdAt (event time, RFC3339Nano → ns) — the
--               canonical ordering instant. ALL per-org canonical ordering
--               (ingester fold and rebuild replay) is (created_at, event_id),
--               mirroring Outbox.drain() / relay drainOrg (created_at, id).
--   payload     the producer's jsonb, byte-for-byte as published. Parse it,
--               never reconstruct it.
--   label       ALWAYS 'derived_from_events'. Nothing in this store is a
--               prediction; actuals only (REAL-labels discipline, issue #89).
--   computed_at deterministic processing watermark — for a ledger row this is
--               the event's own created_at (the row IS the event), so replays
--               are byte-identical. Projection freshness is measured against
--               max(computed_at) of the PROJECTION tables, not this one.
--
-- ENGINE
--   ReplacingMergeTree(computed_at) — append-heavy, mutation-free; the
--   version column makes at-least-once redelivery of the same event collapse
--   to one row in the background (query with FINAL, or rely on the fold's own
--   eventId dedup — both are safe; FINAL is the audited read).
--
-- REBUILD PATH (ADR-0002: every derived store is reconstructible)
--   1. Projections are disposable: TRUNCATE dso_daily; TRUNCATE
--      aging_migration; TRUNCATE collector_effectiveness; TRUNCATE
--      cohort_recovery. NEVER truncate this table — it is the rebuild source.
--   2. Feed every row back through the ingester's fold (deterministic):
--      SELECT org_id, event_id, name, version, created_at, payload
--        FROM event_fact FINAL
--       ORDER BY org_id, created_at, event_id;
--      (backend-go/internal/analytics.RebuildFromLedger issues exactly this
--      query through the Driver port.)
--   3. Re-derived projections are byte-identical: the fold is a pure function
--      of the (created_at, event_id)-ordered ledger — proven by the
--      determinism tests in backend-go/internal/analytics.
--
-- ORDER BY (org_id, event_id)
--   Not dashboard-tuned on purpose: this table is the audit/rebuild source,
--   not a dashboard surface — the dedup key IS the access pattern. Dashboard
--   tables (0002–0005) carry the dashboard-tuned keys.
--
-- No connection strings, no credentials, no environment-specific values in
-- this file. The database (and any cluster topology) is a deployment concern.

CREATE TABLE IF NOT EXISTS event_fact
(
    org_id      String,
    event_id    String,
    name        LowCardinality(String),
    version     UInt32,
    created_at  DateTime64(9, 'UTC'),
    payload     String,
    label       String DEFAULT 'derived_from_events',
    computed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (org_id, event_id);
