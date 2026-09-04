-- 0014_crossborder.sql — corridors, FX quotes, transfer intents, fees (issue #66, SPEC §33, R10).
-- Maps src/domain/crossborder/{corridor,quote,intent,fees}.ts.
--
-- Invariants encoded here:
--   * [R10] no cent created or destroyed: an intent's source amount and the
--     settled target amount are both stored; FX conversion happens ONLY
--     through an immutable quote snapshot.
--   * fx_quotes are IMMUTABLE (trigger refuses UPDATE/DELETE): rate snapshots
--     frozen at authorization can never be rewritten (R10's audit face).
--   * transfer_intents: one quote frozen at authorization
--     (authorized ⇔ quote snapshot present); idempotent submit replay via
--     UNIQUE (org_id, source_ref); no fund-truth writes in this lane.
--   * fees: flat + bps components; the bps→minor conversion rounds with
--     banker's rounding at the APPLICATION layer (single rounding point) —
--     the DDL pins the components, not the rounded result.

CREATE TABLE crossborder_corridors (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id),
    source_currency   text NOT NULL
                             CONSTRAINT ck_corridors_src_ccy CHECK (source_currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    target_currency   text NOT NULL
                             CONSTRAINT ck_corridors_tgt_ccy CHECK (target_currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_corridors_distinct CHECK (source_currency <> target_currency),
    CONSTRAINT uq_crossborder_corridors UNIQUE (org_id, source_currency, target_currency)
);

CREATE UNIQUE INDEX uq_crossborder_corridors_org_id ON crossborder_corridors (org_id, id);
CREATE INDEX idx_crossborder_corridors_active ON crossborder_corridors (org_id) WHERE active;

CREATE TRIGGER trg_crossborder_corridors_touch
    BEFORE UPDATE ON crossborder_corridors
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- ---------------------------------------------------------------------------
-- fx_quotes — immutable rate snapshots with expiry (SPEC §33).
-- ---------------------------------------------------------------------------
CREATE TABLE fx_quotes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id),
    corridor_id   uuid NOT NULL,
    -- Exact rational rate: target = source × (numerator / denominator).
    rate_numerator   bigint NOT NULL,
    rate_denominator bigint NOT NULL,
    expires_at    timestamptz NOT NULL,
    quoted_at     timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_fx_quotes_rate_pos CHECK (rate_numerator > 0 AND rate_denominator > 0),
    CONSTRAINT ck_fx_quotes_expiry CHECK (expires_at > quoted_at)
);

CREATE UNIQUE INDEX uq_fx_quotes_org_id ON fx_quotes (org_id, id);
CREATE INDEX idx_fx_quotes_corridor ON fx_quotes (org_id, corridor_id, quoted_at);

ALTER TABLE fx_quotes
    ADD CONSTRAINT fk_fx_quotes_corridor FOREIGN KEY (org_id, corridor_id)
        REFERENCES crossborder_corridors (org_id, id);

-- [R10] quotes are immutable snapshots — corrections issue a NEW quote.
CREATE FUNCTION fuatilia_fx_quotes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'FX_QUOTES_IMMUTABLE: quotes are snapshots and are never deleted (R10)';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'FX_QUOTES_IMMUTABLE: quotes are snapshots and are never edited (R10)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_fx_quotes_guard
    BEFORE INSERT OR UPDATE OR DELETE ON fx_quotes
    FOR EACH ROW EXECUTE FUNCTION fuatilia_fx_quotes_guard();

COMMENT ON TABLE fx_quotes IS 'Immutable FX rate snapshots (exact rational, TTL via expires_at) — the only conversion authority for intents (R10).';

-- ---------------------------------------------------------------------------
-- transfer_intents — drafted → quoted → authorized → submitted → settled /
-- cancelled; the quote is frozen at authorization.
-- ---------------------------------------------------------------------------
CREATE TYPE transfer_intent_state AS ENUM ('drafted', 'quoted', 'authorized', 'submitted', 'settled', 'cancelled');

CREATE TABLE transfer_intents (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid NOT NULL REFERENCES orgs(id),
    corridor_id       uuid NOT NULL,
    state             transfer_intent_state NOT NULL DEFAULT 'drafted',
    source_amount_minor bigint NOT NULL,
    target_amount_minor bigint,
    currency          text NOT NULL
                             CONSTRAINT ck_transfer_intents_ccy CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    fee_flat_minor    bigint NOT NULL DEFAULT 0,
    fee_bps           integer NOT NULL DEFAULT 0,
    quote_id          uuid,
    quote_numerator   bigint,
    quote_denominator bigint,
    quote_expires_at  timestamptz,
    source_ref        text,
    submitted_at      timestamptz,
    settled_at        timestamptz,
    cancelled_at      timestamptz,
    sequence_no       bigint NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_transfer_intents_source_pos CHECK (source_amount_minor > 0),
    CONSTRAINT ck_transfer_intents_seq CHECK (sequence_no >= 1),
    CONSTRAINT ck_transfer_intents_fees CHECK (fee_flat_minor >= 0 AND fee_bps >= 0 AND fee_bps <= 10000),
    -- Idempotent submit replay: an external reference claims one intent.
    CONSTRAINT ck_transfer_intents_source_ref_nonblank CHECK (source_ref IS NULL OR char_length(btrim(source_ref)) >= 1),
    CONSTRAINT uq_transfer_intents_source_ref UNIQUE (org_id, source_ref),
    -- [R10] the quote snapshot is present exactly from authorization onward.
    CONSTRAINT ck_transfer_intents_quote_snapshot CHECK (
        (state IN ('authorized', 'submitted', 'settled'))
        = (quote_id IS NOT NULL AND quote_numerator IS NOT NULL AND quote_denominator IS NOT NULL)),
    -- Target amount exists only once the conversion is fixed (quote frozen).
    CONSTRAINT ck_transfer_intents_target_shape CHECK (
        (target_amount_minor IS NOT NULL) = (quote_id IS NOT NULL)),
    -- Terminal shape.
    CONSTRAINT ck_transfer_intents_settled_shape CHECK ((state = 'settled') = (settled_at IS NOT NULL)),
    CONSTRAINT ck_transfer_intents_cancelled_shape CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_transfer_intents_seq ON transfer_intents (org_id, sequence_no);
CREATE UNIQUE INDEX uq_transfer_intents_org_id ON transfer_intents (org_id, id);
CREATE INDEX idx_transfer_intents_state ON transfer_intents (org_id, state);
CREATE INDEX idx_transfer_intents_corridor ON transfer_intents (org_id, corridor_id, created_at);

ALTER TABLE transfer_intents
    ADD CONSTRAINT fk_transfer_intents_corridor FOREIGN KEY (org_id, corridor_id)
        REFERENCES crossborder_corridors (org_id, id);

CREATE TRIGGER trg_transfer_intents_touch
    BEFORE UPDATE ON transfer_intents
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE transfer_intents IS 'Cross-border transfer lifecycle; the quote is snapshotted at authorization and can never change afterwards (R10). This lane writes NO fund truth — settlement postings stay in the ledger.';
