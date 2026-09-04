-- 0005_payments_matches.sql — payments (fund truth for inflows) and
-- reconciliation_matches. Maps src/domain/payments/{payment,intake,reconciliation}.ts.
--
-- Invariants encoded here:
--   * [R9/C5 — idempotent intake] UNIQUE (org_id, external_ref) — the Daraja
--     transaction id can only ever produce ONE payment row per org; a replayed
--     callback finds the existing row instead of creating money. Also
--     UNIQUE (org_id, idempotency_key) per docs/05.
--   * [R2/R6 frame] confirmed_minor is set once (state ⇔ confirmed shape
--     CHECK) and every committed claim against it (allocations in 0006,
--     refunds in 0007) is ceiling-checked at COMMIT by deferrable triggers.
--   * unapplied_minor is the maintained derivation
--     confirmed − Σ(active allocations) − Σ(refunds); a deferrable trigger
--     proves the stored value equals the derivation at COMMIT.
--   * [R5] a ReconciliationMatch points at a PAYMENT — payment_id is the only
--     target; N receivables per payment is expressed through allocations, so
--     there is no receivable_id column here at all.
--   * [R3] matches are append-only (UPDATE/DELETE rejected); a correction is a
--     new match row with reversal_of → the original.

CREATE TYPE payment_channel AS ENUM ('c2b', 'stk');
CREATE TYPE payment_state   AS ENUM ('initiated', 'pending_confirmation', 'confirmed',
                                     'partially_allocated', 'allocated', 'unapplied',
                                     'failed', 'reversed', 'partially_refunded', 'refunded');
CREATE TYPE match_confidence AS ENUM ('auto', 'manual');

CREATE TABLE payments (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid           NOT NULL REFERENCES orgs(id),
    customer_id       uuid,          -- NULL until identified (unapplied parking)
    channel           payment_channel NOT NULL,
    -- Daraja transaction id — the at-least-once callback identity (K1).
    external_ref      text           NOT NULL,
    idempotency_key   text           NOT NULL,
    state             payment_state  NOT NULL DEFAULT 'initiated',
    currency          text           NOT NULL
                                     CONSTRAINT ck_payments_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    -- What was asked for at intake (E11 requestedMinor).
    requested_minor   bigint         NOT NULL,
    -- Set EXACTLY ONCE at confirmation (docs/05); never mutated afterwards.
    confirmed_minor   bigint,
    -- Maintained derivation: confirmed − Σ(active allocations) − Σ(refunds).
    unapplied_minor   bigint,
    declared_refs     text[]         NOT NULL DEFAULT '{}',
    initiated_at      timestamptz    NOT NULL DEFAULT now(),
    confirmed_at      timestamptz,
    failed_at         timestamptz,
    failure_code      text,
    reversed_at       timestamptz,
    reversal_reason   text,
    created_at        timestamptz    NOT NULL DEFAULT now(),
    updated_at        timestamptz    NOT NULL DEFAULT now(),

    CONSTRAINT ck_payments_requested_nonneg CHECK (requested_minor >= 0),
    CONSTRAINT ck_payments_confirmed_pos    CHECK (confirmed_minor IS NULL OR confirmed_minor > 0),
    -- [R9] the callback identity fields can never be blank.
    CONSTRAINT ck_payments_external_ref     CHECK (char_length(btrim(external_ref)) >= 1),
    CONSTRAINT ck_payments_idem_key         CHECK (char_length(btrim(idempotency_key)) >= 1),
    -- state ⇔ confirmed_minor shape: exactly the confirmed family (+ reversed,
    -- which is only reachable FROM confirmed) carries a confirmed amount.
    CONSTRAINT ck_payments_state_confirmed_shape
        CHECK ((state IN ('confirmed', 'partially_allocated', 'allocated', 'unapplied',
                          'partially_refunded', 'refunded', 'reversed'))
               = (confirmed_minor IS NOT NULL)),
    -- Terminal failure shape: a failed payment records when and why.
    CONSTRAINT ck_payments_failed_shape
        CHECK ((state = 'failed') = (failed_at IS NOT NULL)),
    -- Reversal is an explicit, reasoned decision (R3).
    CONSTRAINT ck_payments_reversal_shape
        CHECK ((state = 'reversed') = (reversed_at IS NOT NULL))
);

-- [R9/C5] THE idempotency backbone: one Daraja external ref = one payment.
CREATE UNIQUE INDEX uq_payments_org_external_ref ON payments (org_id, external_ref);
-- [R9] the caller-supplied idempotency key is unique per org too.
CREATE UNIQUE INDEX uq_payments_org_idem_key     ON payments (org_id, idempotency_key);
CREATE UNIQUE INDEX uq_payments_org_id           ON payments (org_id, id);

ALTER TABLE payments
    ADD CONSTRAINT fk_payments_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

-- Route access patterns (src/adapters/http/routes/payments.ts): list is
-- sortable by id|state|initiatedAt; callbacks look up by external_ref (the
-- unique index above serves that); the reconciliation queue scans by state.
CREATE INDEX idx_payments_state         ON payments (org_id, state);
CREATE INDEX idx_payments_initiated_at  ON payments (org_id, initiated_at);
CREATE INDEX idx_payments_customer      ON payments (org_id, customer_id);
-- Unapplied parking sweeps (C4): confirmed money with nowhere to go yet.
CREATE INDEX idx_payments_unapplied     ON payments (org_id, state, unapplied_minor)
    WHERE state IN ('confirmed', 'unapplied', 'partially_allocated');

CREATE TRIGGER trg_payments_touch BEFORE UPDATE ON payments
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE  payments IS 'Fund truth for inflows; idempotent intake via UNIQUE (org_id, external_ref) and (org_id, idempotency_key) [R9].';
COMMENT ON INDEX  uq_payments_org_external_ref IS '[R9/C5] idempotent intake: a duplicate Daraja callback must find this row, never create money.';
COMMENT ON CONSTRAINT ck_payments_state_confirmed_shape ON payments IS '[R2/R6 frame] confirmed_minor is set exactly once, exactly when the payment enters the confirmed family.';

-- ---------------------------------------------------------------------------
-- reconciliation_matches — [R5] points at Payment, THE only target.
-- Append-only (R3): a reversal appends a new row with reversal_of, never edits.
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_matches (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid             NOT NULL REFERENCES orgs(id),
    payment_id    uuid             NOT NULL,           -- [R5] the ONLY target
    declared_refs text[]           NOT NULL DEFAULT '{}', -- payer-typed invoice/receipt refs
    confidence    match_confidence NOT NULL,
    matched_at    timestamptz      NOT NULL DEFAULT now(),
    matched_by    text,
    -- [R3] reversal linkage: the correcting row points at the match it undoes.
    reversal_of   uuid,
    reason        text,
    created_at    timestamptz      NOT NULL DEFAULT now(),
    updated_at    timestamptz      NOT NULL DEFAULT now(),
    -- A correcting row must say why (R3: corrections carry a reason).
    CONSTRAINT ck_matches_reversal_reason
        CHECK (reversal_of IS NULL OR (reason IS NOT NULL AND reversal_of <> id)),
    CONSTRAINT ck_matches_payment_ref CHECK (payment_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_matches_org_id        ON reconciliation_matches (org_id, id);
CREATE INDEX idx_matches_payment             ON reconciliation_matches (org_id, payment_id);
-- Reversal chains resolve quickly + "is this match reversed?" lookups.
CREATE INDEX idx_matches_reversal_of         ON reconciliation_matches (org_id, reversal_of);

ALTER TABLE reconciliation_matches
    ADD CONSTRAINT fk_matches_payment FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id),
    ADD CONSTRAINT fk_matches_reversal FOREIGN KEY (org_id, reversal_of)
        REFERENCES reconciliation_matches (org_id, id);

-- [R3] append-only: corrections are new rows, never edits or deletions.
CREATE FUNCTION fuatilia_matches_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MATCHES_APPEND_ONLY: reconciliation_matches is append-only (R3/R5) — % rejected; append a correcting row instead', TG_OP;
END $$;

CREATE TRIGGER trg_matches_append_only
    BEFORE UPDATE OR DELETE ON reconciliation_matches
    FOR EACH ROW EXECUTE FUNCTION fuatilia_matches_append_only();

COMMENT ON TABLE reconciliation_matches IS '[R5] payment→intake matching; payment_id is the ONLY target (C1 fix), receivables come in via allocations.';
