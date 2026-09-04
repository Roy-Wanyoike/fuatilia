-- 0003_customers_consent.sql — customers, contacts, consent_grants.
-- Maps src/domain/shared customer shape, communications linkage, and
-- src/domain/consent/consent-grant.ts (Kenya DPA 2019 fields, K2/K3).
--
-- Invariants encoded here:
--   * consent revocation is an APPEND fact on the row (revoked_at stamped once,
--     never deleted — K2/DPA 2019: the trail of what the data subject agreed
--     to, and when they withdrew it, must survive);
--   * a grant can never be revoked before it was granted (CHECK);
--   * the dunning gate (K2) reads active grants by
--     (org, customer, channel, purpose) — covered by a partial index on live
--     grants.

CREATE TABLE customers (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid        NOT NULL REFERENCES orgs(id),
    display_name   text        NOT NULL,
    msisdn         text,                   -- primary phone (Safaricom format)
    email          text,
    segment        text,                   -- collections segmentation input
    risk_tier      text        NOT NULL DEFAULT 'standard',
    status         text        NOT NULL DEFAULT 'active'
                               CONSTRAINT ck_customers_status CHECK (status IN ('active', 'blocked', 'archived')),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_customers_name_nonblank CHECK (char_length(btrim(display_name)) >= 1),
    -- At least one reachable channel — a customer nobody can reach cannot be
    -- dunned, invoiced or refunded.
    CONSTRAINT ck_customers_channel_present
        CHECK (msisdn IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX uq_customers_org_id ON customers (org_id, id);
-- MSISDN uniqueness within a tenant (one wallet = one customer per org).
CREATE UNIQUE INDEX uq_customers_org_msisdn ON customers (org_id, msisdn) WHERE msisdn IS NOT NULL;
CREATE INDEX idx_customers_status ON customers (org_id, status);

CREATE TRIGGER trg_customers_touch BEFORE UPDATE ON customers
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE customers IS 'Customer (data subject) per org — the linkage root for consent, conversations, promises and credit balances.';

CREATE TABLE contacts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid        NOT NULL REFERENCES orgs(id),
    customer_id uuid        NOT NULL,
    kind        text        NOT NULL
                            CONSTRAINT ck_contacts_kind CHECK (kind IN ('phone', 'email', 'whatsapp', 'postal')),
    value       text        NOT NULL,
    is_primary  boolean     NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_contacts_value_nonblank CHECK (char_length(btrim(value)) >= 1)
);

CREATE UNIQUE INDEX uq_contacts_org_id ON contacts (org_id, id);
CREATE INDEX idx_contacts_customer ON contacts (org_id, customer_id);
-- One primary contact per channel kind per customer (deterministic addressing).
CREATE UNIQUE INDEX uq_contacts_primary ON contacts (org_id, customer_id, kind) WHERE is_primary;

ALTER TABLE contacts
    ADD CONSTRAINT fk_contacts_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE TRIGGER trg_contacts_touch BEFORE UPDATE ON contacts
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE contacts IS 'Customer contact channels; exactly one primary per (customer, kind) via partial unique index.';

-- ---------------------------------------------------------------------------
-- consent_grants — Kenya DPA 2019 consent ledger (K2/K3; consent lane).
-- A dunning message may only be sent under an ACTIVE grant
-- (channel+purpose, granted_at <= now < (revoked_at | infinity)).
-- ---------------------------------------------------------------------------
CREATE TYPE consent_channel  AS ENUM ('whatsapp', 'sms', 'email');
CREATE TYPE consent_purpose  AS ENUM ('dunning', 'marketing');

CREATE TABLE consent_grants (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid            NOT NULL REFERENCES orgs(id),
    customer_id      uuid            NOT NULL,
    channel          consent_channel NOT NULL,
    purpose          consent_purpose NOT NULL,
    granted_at       timestamptz     NOT NULL DEFAULT now(),
    -- Revocation is stamped ONCE on the fact row; the grant row is never
    -- deleted (K2/DPA 2019: consent + withdrawal must both be provable).
    revoked_at       timestamptz,
    -- DPA 2019 fields: the lawful basis and the evidence pointer that makes
    -- the grant auditable (captured UI flow / signed record).
    lawful_basis     text            NOT NULL DEFAULT 'consent'
                                     CONSTRAINT ck_consent_lawful_basis
                                         CHECK (lawful_basis IN ('consent', 'contract', 'legitimate_interest')),
    evidence_ref     text,
    -- Which DPA revision the grant was captured under (regulation pinning).
    dpa_version      text            NOT NULL DEFAULT 'kenya-dpa-2019',
    -- Purpose limitation: consent expires unless re-captured (DPA 2019 s.25
    -- retention discipline); NULL = no policy-driven expiry.
    expires_at       timestamptz,
    granted_by       text,               -- actor/agent that captured the consent
    created_at       timestamptz     NOT NULL DEFAULT now(),
    updated_at       timestamptz     NOT NULL DEFAULT now(),
    -- A withdrawal cannot precede the grant.
    CONSTRAINT ck_consent_revoke_after_grant CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
    -- An explicit expiry must sit after the grant instant.
    CONSTRAINT ck_consent_expiry_after_grant CHECK (expires_at IS NULL OR expires_at > granted_at)
);

CREATE UNIQUE INDEX uq_consent_org_id ON consent_grants (org_id, id);
-- The K2 dunning gate lookup: is there a live dunning grant for this customer
-- on this channel? Partial index keeps it tight to ACTIVE grants.
CREATE INDEX idx_consent_active_lookup ON consent_grants (org_id, customer_id, channel, purpose)
    WHERE revoked_at IS NULL;
CREATE INDEX idx_consent_customer_history ON consent_grants (org_id, customer_id, granted_at DESC);

ALTER TABLE consent_grants
    ADD CONSTRAINT fk_consent_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

-- Revoke-once discipline: revoked_at may be stamped exactly once, then frozen.
CREATE FUNCTION fuatilia_consent_revoke_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'CONSENT_ALREADY_REVOKED: grant % was already revoked at % — the consent trail is immutable (K2/DPA 2019)', OLD.id, OLD.revoked_at;
    END IF;
    IF NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'CONSENT_REVOKE_SHAPE_INVALID: revoked_at must be stamped when revoking';
    END IF;
    -- Everything except revoked_at must stay byte-identical (append-only edit).
    IF (NEW.id, NEW.org_id, NEW.customer_id, NEW.channel, NEW.purpose, NEW.granted_at,
        NEW.lawful_basis, NEW.evidence_ref, NEW.dpa_version, NEW.expires_at, NEW.granted_by,
        NEW.created_at, NEW.updated_at)
       IS NOT DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.customer_id, OLD.channel, OLD.purpose, OLD.granted_at,
        OLD.lawful_basis, OLD.evidence_ref, OLD.dpa_version, OLD.expires_at, OLD.granted_by,
        OLD.created_at, OLD.updated_at) THEN
        RETURN NEW; -- the single legal edit: stamping revoked_at
    END IF;
    RAISE EXCEPTION 'CONSENT_IMMUTABLE: only revoked_at may be stamped on a consent grant (K2/DPA 2019)';
END $$;

CREATE TRIGGER trg_consent_revoke_once
    BEFORE UPDATE OF revoked_at ON consent_grants
    FOR EACH ROW EXECUTE FUNCTION fuatilia_consent_revoke_once();

CREATE TRIGGER trg_consent_touch BEFORE UPDATE ON consent_grants
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE  consent_grants IS 'DPA 2019 consent ledger: grant + withdrawal as immutable facts; dunning requires an ACTIVE grant (K2).';
COMMENT ON CONSTRAINT ck_consent_revoke_after_grant ON consent_grants IS '[K2/DPA 2019] revocation cannot precede the grant.';
COMMENT ON COLUMN consent_grants.evidence_ref IS 'Pointer to the captured consent evidence (UI flow / signed record); the DPA 2019 audit hook.';
