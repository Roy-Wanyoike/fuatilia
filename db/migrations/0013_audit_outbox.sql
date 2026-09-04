-- 0013_audit_outbox.sql — tamper-evident audit chain + transactional outbox +
-- durable idempotency keys (issue #66, SPEC §37, R9/C5).
-- Maps src/domain/audit/{record,chain,redact}.ts and src/domain/events/outbox.ts.
--
-- Invariants encoded here:
--   * audit_events is APPEND-ONLY (UPDATE/DELETE refused) and hash-chained:
--     each row stores prev_hash + its own hash over (seq, org, actor, action,
--     payload, prev_hash). Chain continuity + tamper detection are verified
--     by smoke assertions in db/validate.sh; the writer computes hashes.
--   * idempotency_keys: UNIQUE (org_id, scope, key) — the PostgreSQL twin of
--     pkg/idempotency's first-write-wins registry (R9/C5).
--   * outbox_events: UNIQUE event_id — replaying a command cannot
--     double-append an event (OUTBOX_DUPLICATE's DDL face); status advances
--     pending → published → (consumed downstream).

CREATE TABLE audit_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid,
    actor_type  text NOT NULL,
    actor_id    text NOT NULL,
    action      text NOT NULL,
    resource    text NOT NULL,
    resource_id text,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    redacted    boolean NOT NULL DEFAULT false,
    reason      text,
    seq         bigint NOT NULL,
    prev_hash   text NOT NULL,
    hash        text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_audit_actor_type CHECK (actor_type IN ('user', 'system', 'api', 'agent')),
    CONSTRAINT ck_audit_action_nonblank CHECK (char_length(btrim(action)) >= 1),
    CONSTRAINT ck_audit_resource_nonblank CHECK (char_length(btrim(resource)) >= 1),
    CONSTRAINT ck_audit_hash_shape CHECK (char_length(hash) >= 32 AND char_length(prev_hash) >= 32),
    CONSTRAINT ck_audit_seq CHECK (seq >= 1)
);

CREATE UNIQUE INDEX uq_audit_events_org_seq ON audit_events (org_id, seq);
CREATE UNIQUE INDEX uq_audit_events_org_id ON audit_events (org_id, id);
CREATE INDEX idx_audit_events_resource ON audit_events (org_id, resource, resource_id, occurred_at);
CREATE INDEX idx_audit_events_actor ON audit_events (org_id, actor_type, actor_id, occurred_at);
CREATE INDEX idx_audit_events_action ON audit_events (org_id, action, occurred_at);

-- [SPEC §37] append-only: the audit trail is never edited, never deleted.
CREATE FUNCTION fuatilia_audit_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'AUDIT_APPEND_ONLY: the audit trail is never deleted (§37)';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'AUDIT_APPEND_ONLY: the audit trail is never edited (§37)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_audit_events_guard
    BEFORE INSERT OR UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION fuatilia_audit_events_guard();

COMMENT ON TABLE audit_events IS 'Tamper-evident append-only audit trail (§37): hash chain over (seq, prev_hash, hash); every consequential operation lands here.';
COMMENT ON INDEX uq_audit_events_org_seq IS 'Per-org chain sequence — continuity is what makes tampering detectable.';

-- ---------------------------------------------------------------------------
-- idempotency_keys — the durable R9/C5 registry.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    scope       text NOT NULL,
    key         text NOT NULL,
    outcome_ref text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_idempotency_scope_nonblank CHECK (char_length(btrim(scope)) >= 1),
    CONSTRAINT ck_idempotency_key_nonblank CHECK (char_length(btrim(key)) >= 1),
    -- First-write-wins: the second insert with the same (org, scope, key)
    -- violates this index and is refused (IDEMPOTENCY_KEY_TAKEN's DDL face).
    CONSTRAINT uq_idempotency_keys UNIQUE (org_id, scope, key)
);
CREATE UNIQUE INDEX uq_idempotency_keys_org_id ON idempotency_keys (org_id, id);

COMMENT ON TABLE idempotency_keys IS '[R9/C5] durable first-write-wins registry — the storage twin of backend-go/pkg/idempotency; outcome_ref points at the original outcome.';

-- ---------------------------------------------------------------------------
-- outbox_events — transactional outbox (envelope v1, issue #6/F6).
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    event_id    uuid NOT NULL,
    event_type  text NOT NULL,
    version     integer NOT NULL DEFAULT 1,
    payload     jsonb NOT NULL,
    status      text NOT NULL DEFAULT 'pending',
    published_at timestamptz,
    attempts    integer NOT NULL DEFAULT 0,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_outbox_status CHECK (status IN ('pending', 'published', 'poisoned')),
    CONSTRAINT ck_outbox_version CHECK (version >= 1),
    -- Replaying a command cannot double-append the same event.
    CONSTRAINT uq_outbox_events_event UNIQUE (org_id, event_id)
);

CREATE UNIQUE INDEX uq_outbox_events_org_id ON outbox_events (org_id, id);
CREATE INDEX idx_outbox_events_pending ON outbox_events (org_id, created_at) WHERE status = 'pending';

CREATE TRIGGER trg_outbox_events_touch
    BEFORE UPDATE ON outbox_events
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE outbox_events IS 'Transactional outbox: domain transactions append here; the publisher forwards to the event broker and marks published.';
