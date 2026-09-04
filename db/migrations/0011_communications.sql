-- 0011_communications.sql — conversations, messages, delivery attempts (issue #66, K2).
-- Maps src/domain/communications/{conversation,provider,templates,guard}.ts.
--
-- Notes:
--   * CONSENT IS CHECKED IN THE APPLICATION LANE (consent guard); the DDL
--     carries the channel + recipient so consent audits can join later, and
--     every message records the consent grant it relied on (consent_grant_id,
--     nullable only for inbound/system rows — shape-constrained below).
--   * delivery attempts are append-only (retry ladder = new rows).
--   * templates are versioned; messages pin the exact version they used.

CREATE TYPE comm_channel  AS ENUM ('whatsapp', 'sms', 'email', 'ussd');
CREATE TYPE comm_direction AS ENUM ('outbound', 'inbound', 'system');
CREATE TYPE message_state AS ENUM ('queued', 'sent', 'delivered', 'failed', 'dead_lettered');

CREATE TABLE conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    customer_id uuid NOT NULL,
    channel     comm_channel NOT NULL,
    subject     text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_conversations_org UNIQUE (org_id, id)
);

ALTER TABLE conversations
    ADD CONSTRAINT fk_conversations_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE INDEX idx_conversations_customer ON conversations (org_id, customer_id, created_at);

CREATE TRIGGER trg_conversations_touch
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

CREATE TABLE messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES orgs(id),
    conversation_id uuid NOT NULL,
    direction       comm_direction NOT NULL,
    channel         comm_channel NOT NULL,
    recipient       text NOT NULL,
    body            text NOT NULL,
    state           message_state NOT NULL DEFAULT 'queued',
    template_key    text,
    template_version integer,
    consent_grant_id uuid,
    provider_ref    text,
    error_code      text,
    sequence_no     bigint NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_messages_recipient_nonblank CHECK (char_length(btrim(recipient)) >= 1),
    CONSTRAINT ck_messages_body_nonblank CHECK (char_length(btrim(body)) >= 1),
    CONSTRAINT ck_messages_seq CHECK (sequence_no >= 1),
    -- Outbound messages MUST cite the consent they relied on (DPA 2019, K2).
    CONSTRAINT ck_messages_outbound_consent CHECK (
        direction <> 'outbound' OR consent_grant_id IS NOT NULL),
    -- Template usage is all-or-nothing.
    CONSTRAINT ck_messages_template_shape CHECK (
        (template_key IS NULL) = (template_version IS NULL))
);

CREATE UNIQUE INDEX uq_messages_org_id ON messages (org_id, id);
CREATE UNIQUE INDEX uq_messages_seq ON messages (org_id, conversation_id, sequence_no);
CREATE INDEX idx_messages_conversation ON messages (org_id, conversation_id, created_at);
CREATE INDEX idx_messages_state ON messages (org_id, state) WHERE state IN ('queued', 'failed');

ALTER TABLE messages
    ADD CONSTRAINT fk_messages_conversation FOREIGN KEY (org_id, conversation_id) REFERENCES conversations (org_id, id);

CREATE TRIGGER trg_messages_touch
    BEFORE UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- ---------------------------------------------------------------------------
-- delivery_attempts — append-only retry ladder (per-message sequence).
-- ---------------------------------------------------------------------------
CREATE TABLE delivery_attempts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    message_id  uuid NOT NULL,
    attempt_no  integer NOT NULL,
    outcome     text NOT NULL,
    provider_ref text,
    error_code  text,
    latency_ms  integer,
    attempted_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_delivery_attempts_no CHECK (attempt_no >= 1),
    CONSTRAINT ck_delivery_attempts_outcome CHECK (outcome IN ('success', 'failure')),
    CONSTRAINT uq_delivery_attempts UNIQUE (org_id, message_id, attempt_no)
);

CREATE UNIQUE INDEX uq_delivery_attempts_org_id ON delivery_attempts (org_id, id);
CREATE INDEX idx_delivery_attempts_message ON delivery_attempts (org_id, message_id, attempt_no);

ALTER TABLE delivery_attempts
    ADD CONSTRAINT fk_delivery_attempts_message FOREIGN KEY (org_id, message_id) REFERENCES messages (org_id, id);

CREATE FUNCTION fuatilia_delivery_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELIVERY_ATTEMPTS_APPEND_ONLY: the retry ladder is never deleted';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'DELIVERY_ATTEMPTS_APPEND_ONLY: the retry ladder is never edited';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_delivery_attempts_guard
    BEFORE INSERT OR UPDATE OR DELETE ON delivery_attempts
    FOR EACH ROW EXECUTE FUNCTION fuatilia_delivery_attempts_guard();

COMMENT ON TABLE messages IS 'Communication messages; outbound rows must cite the consent grant they relied on (K2/DPA).';
COMMENT ON TABLE delivery_attempts IS 'Append-only provider attempts — retries append rows, never edit history.';
COMMENT ON CONSTRAINT ck_messages_outbound_consent ON messages IS '[K2] no outbound message without a recorded consent grant.';
