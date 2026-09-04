-- 0012_webhooks.sql — endpoint registry + delivery lifecycle (issue #66, SPEC §53).
-- Maps src/domain/webhooks/{endpoint,subscription,attempts,signing}.ts.
--
-- Invariants encoded here:
--   * https-only endpoints (localhost refused) — CHECK on the URL shape.
--   * [idempotent enqueue] UNIQUE (org_id, endpoint_id, event_id): replays of
--     the same event cannot double-enqueue (the sticky verification ledger).
--   * delivery state machine queued→delivered|failed→dead_lettered with a
--     bounded retry ladder (attempts counted in delivery_attempts).
--   * signing secrets are stored HASHED (prefix for identification) — the
--     plaintext is shown exactly once at creation and never persisted (the
--     same discipline as api_keys, 0002).

CREATE TYPE webhook_state AS ENUM ('queued', 'delivering', 'delivered', 'failed', 'dead_lettered');

CREATE TABLE webhook_endpoints (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs(id),
    url          text NOT NULL,
    description  text,
    secret_hash  text NOT NULL,
    secret_prefix text NOT NULL,
    active       boolean NOT NULL DEFAULT true,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_webhook_endpoints_https CHECK (url ~ '^https://'),
    -- Refuse loopback/localhost targets (issue #47: no localhost endpoints).
    CONSTRAINT ck_webhook_endpoints_no_local CHECK (
        url !~* '^https://(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::ffff:127\.0\.0\.1\])'),
    CONSTRAINT ck_webhook_endpoints_secret_shape CHECK (char_length(btrim(secret_hash)) >= 1 AND char_length(btrim(secret_prefix)) >= 1)
);

CREATE UNIQUE INDEX uq_webhook_endpoints_org_id ON webhook_endpoints (org_id, id);
CREATE INDEX idx_webhook_endpoints_active ON webhook_endpoints (org_id) WHERE active;

CREATE TRIGGER trg_webhook_endpoints_touch
    BEFORE UPDATE ON webhook_endpoints
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

CREATE TABLE webhook_subscriptions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    endpoint_id uuid NOT NULL,
    event_type  text NOT NULL,   -- exact type or '*' wildcard (issue #47)
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_webhook_subscriptions_type_nonblank CHECK (char_length(btrim(event_type)) >= 1),
    CONSTRAINT uq_webhook_subscriptions UNIQUE (org_id, endpoint_id, event_type)
);

CREATE UNIQUE INDEX uq_webhook_subscriptions_org_id ON webhook_subscriptions (org_id, id);
ALTER TABLE webhook_subscriptions
    ADD CONSTRAINT fk_webhook_subscriptions_endpoint FOREIGN KEY (org_id, endpoint_id)
        REFERENCES webhook_endpoints (org_id, id) ON DELETE CASCADE;

CREATE TABLE webhook_deliveries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs(id),
    endpoint_id  uuid NOT NULL,
    event_id     uuid NOT NULL,
    event_type   text NOT NULL,
    payload      jsonb NOT NULL,
    state        webhook_state NOT NULL DEFAULT 'queued',
    attempt_count integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    delivered_at  timestamptz,
    dead_lettered_at timestamptz,
    last_error   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    -- [idempotent enqueue] the (endpoint, event) pair is the replay key.
    CONSTRAINT uq_webhook_deliveries_endpoint_event UNIQUE (org_id, endpoint_id, event_id),
    -- Terminal shape discipline.
    CONSTRAINT ck_webhook_deliveries_delivered_shape CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
    CONSTRAINT ck_webhook_deliveries_dead_shape CHECK ((state = 'dead_lettered') = (dead_lettered_at IS NOT NULL)),
    CONSTRAINT ck_webhook_deliveries_attempts CHECK (attempt_count >= 0)
);

CREATE UNIQUE INDEX uq_webhook_deliveries_org_id ON webhook_deliveries (org_id, id);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (org_id, next_attempt_at)
    WHERE state IN ('queued', 'failed');
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries (org_id, endpoint_id, created_at);

ALTER TABLE webhook_deliveries
    ADD CONSTRAINT fk_webhook_deliveries_endpoint FOREIGN KEY (org_id, endpoint_id)
        REFERENCES webhook_endpoints (org_id, id);

CREATE TRIGGER trg_webhook_deliveries_touch
    BEFORE UPDATE ON webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- Terminal states are frozen: delivered/dead_lettered rows never change.
CREATE FUNCTION fuatilia_webhook_deliveries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.state IN ('delivered', 'dead_lettered') THEN
        RAISE EXCEPTION 'WEBHOOK_DELIVERY_TERMINAL: delivery % is already % — terminal states are frozen', OLD.id, OLD.state;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_webhook_deliveries_guard
    BEFORE UPDATE ON webhook_deliveries
    FOR EACH ROW EXECUTE FUNCTION fuatilia_webhook_deliveries_guard();

COMMENT ON TABLE webhook_endpoints IS 'Developer-platform endpoint registry; https-only, no loopback, secret stored hashed with an identification prefix.';
COMMENT ON TABLE webhook_deliveries IS 'Delivery lifecycle queued→delivered|failed→dead_lettered; (endpoint_id,event_id) uniqueness makes enqueue idempotent (issue #47).';
