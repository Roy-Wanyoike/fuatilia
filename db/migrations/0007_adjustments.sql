-- 0007_adjustments.sql — refunds, credit notes, customer credit balances.
-- Maps src/domain/adjustments/{refund,credit-note,credit-balance}.ts (issues #4; C2/C3/C4).
--
-- Invariants encoded here:
--   * [R6 — refund ceiling] a refund draws only on confirmed funds not already
--     allocated or refunded: at COMMIT,
--       refund.total_minor ≤ confirmed_minor − Σ(active allocations) − Σ(other live refunds)
--     proven by a deferrable trigger (REFUND_EXCEEDS_CEILING otherwise).
--   * [docs/05] Σ(refund_allocations) == refund.total_minor at COMMIT.
--   * [R7 — credit ceilings] Σ(credit-note applications) + Σ(consented credit-
--     balance routings sourced from the note) ≤ note total_minor at COMMIT.
--   * [C4] one credit balance per (org, customer, currency); the balance is
--     maintained from an APPEND-ONLY movement log and can never go negative.
--   * [C4 movement contract] kind ⇔ direction ⇔ required source column as a
--     CHECK (overpayment/credit_note_excess increase, applied_to_receivable
--     decreases), mirroring MOVEMENT_CONTRACT in credit-balance.ts.
--   * [R3] movement log rows are immutable (UPDATE/DELETE rejected).

CREATE TYPE refund_state        AS ENUM ('requested', 'approved', 'rejected', 'processing', 'completed', 'failed');
CREATE TYPE refund_source       AS ENUM ('confirmed_funds', 'credit_balance');
CREATE TYPE credit_note_state   AS ENUM ('draft', 'issued', 'partially_applied', 'fully_applied', 'voided');
CREATE TYPE cb_movement_kind     AS ENUM ('overpayment', 'credit_note_excess', 'applied_to_receivable');
CREATE TYPE cb_movement_direction AS ENUM ('increase', 'decrease');

-- ---------------------------------------------------------------------------
-- customer credit balances + movements (C4) — created first: the allocation
-- lane's R2 trigger (0006) reads available_minor.
-- ---------------------------------------------------------------------------
CREATE TABLE customer_credit_balances (
    org_id          uuid        NOT NULL REFERENCES orgs(id),
    customer_id     uuid        NOT NULL,
    currency        text        NOT NULL
                                CONSTRAINT ck_ccb_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    -- Maintained by trg_ccb_apply_movement from the append-only log below;
    -- proven consistent by the deferrable trigger at COMMIT.
    available_minor bigint      NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    -- [C4] one balance per currency per customer (composite PK, docs/05).
    CONSTRAINT ck_ccb_available_nonneg CHECK (available_minor >= 0),
    PRIMARY KEY (org_id, customer_id, currency)
);

ALTER TABLE customer_credit_balances
    ADD CONSTRAINT fk_ccb_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE TRIGGER trg_ccb_touch BEFORE UPDATE ON customer_credit_balances
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE customer_credit_balances IS '[C4] overpayment home: one available balance per (customer, currency), maintained from the append-only movement log.';

CREATE TABLE customer_credit_balance_movements (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                uuid                 NOT NULL REFERENCES orgs(id),
    customer_id           uuid                 NOT NULL,
    currency              text                 NOT NULL,
    kind                  cb_movement_kind     NOT NULL,
    direction             cb_movement_direction NOT NULL,
    -- > 0 — the direction carries the sign (negative = modelling bug).
    amount_minor          bigint               NOT NULL,
    -- kind='overpayment': the source payment reference (Daraja ref or id).
    source_payment_ref    text,
    -- kind='credit_note_excess': the consented routing's originating note (R7).
    source_credit_note_id uuid,
    -- kind='applied_to_receivable': the receivable being settled.
    receivable_id         uuid,
    occurred_at           timestamptz          NOT NULL DEFAULT now(),
    created_at            timestamptz          NOT NULL DEFAULT now(),
    updated_at            timestamptz          NOT NULL DEFAULT now(),

    CONSTRAINT ck_ccbm_amount_pos CHECK (amount_minor > 0),
    CONSTRAINT ck_ccbm_currency   CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    -- [C4] MOVEMENT_CONTRACT as DDL: kind ⇔ direction ⇔ required reference.
    CONSTRAINT ck_ccbm_contract_overpayment
        CHECK (kind <> 'overpayment'         OR (direction = 'increase' AND source_payment_ref IS NOT NULL)),
    CONSTRAINT ck_ccbm_contract_note_excess
        CHECK (kind <> 'credit_note_excess'  OR (direction = 'increase' AND source_credit_note_id IS NOT NULL)),
    CONSTRAINT ck_ccbm_contract_applied
        CHECK (kind <> 'applied_to_receivable' OR (direction = 'decrease' AND receivable_id IS NOT NULL))
);

CREATE UNIQUE INDEX uq_ccbm_org_id        ON customer_credit_balance_movements (org_id, id);
CREATE INDEX idx_ccbm_customer            ON customer_credit_balance_movements (org_id, customer_id, occurred_at);
CREATE INDEX idx_ccbm_note_source         ON customer_credit_balance_movements (org_id, source_credit_note_id)
    WHERE source_credit_note_id IS NOT NULL;

ALTER TABLE customer_credit_balance_movements
    ADD CONSTRAINT fk_ccbm_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);
-- (the FK to credit_notes is added at the end of this file — credit_notes is
-- created further down; PostgreSQL FKs need their target to exist first)

CREATE TRIGGER trg_ccbm_touch BEFORE UPDATE ON customer_credit_balance_movements
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE customer_credit_balance_movements IS 'Append-only credit-balance movement log (R3); the balance is always recomputed from it, never edited.';

-- [R3] the movement log is immutable.
CREATE FUNCTION fuatilia_ccbm_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'CREDIT_BALANCE_MOVEMENTS_APPEND_ONLY: movement rows are immutable (R3) — append the opposite movement instead';
END $$;

CREATE TRIGGER trg_ccbm_append_only
    BEFORE UPDATE OR DELETE ON customer_credit_balance_movements
    FOR EACH ROW EXECUTE FUNCTION fuatilia_ccbm_append_only();

-- Apply the movement to the stored balance immediately (upsert), and prove at
-- COMMIT that the stored value still equals Σ(log) and is >= 0.
CREATE FUNCTION fuatilia_ccbm_apply_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_delta bigint;
BEGIN
    v_delta := CASE NEW.direction WHEN 'increase' THEN NEW.amount_minor ELSE -NEW.amount_minor END;
    INSERT INTO customer_credit_balances (org_id, customer_id, currency, available_minor)
    VALUES (NEW.org_id, NEW.customer_id, NEW.currency, v_delta)
    ON CONFLICT (org_id, customer_id, currency)
    DO UPDATE SET available_minor = customer_credit_balances.available_minor + EXCLUDED.available_minor;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_ccbm_apply_movement
    AFTER INSERT ON customer_credit_balance_movements
    FOR EACH ROW EXECUTE FUNCTION fuatilia_ccbm_apply_movement();

CREATE FUNCTION fuatilia_ccbm_check_consistency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_cust uuid; v_cur text; v_stored bigint; v_sum bigint;
BEGIN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    v_cust := COALESCE(NEW.customer_id, OLD.customer_id);
    v_cur := COALESCE(NEW.currency, OLD.currency);
    SELECT available_minor INTO v_stored FROM customer_credit_balances
      WHERE org_id = v_org AND customer_id = v_cust AND currency = v_cur;
    SELECT COALESCE(SUM(CASE direction WHEN 'increase' THEN amount_minor ELSE -amount_minor END), 0)
      INTO v_sum
      FROM customer_credit_balance_movements
     WHERE org_id = v_org AND customer_id = v_cust AND currency = v_cur;
    IF v_stored IS NULL OR v_stored <> v_sum THEN
        RAISE EXCEPTION 'CREDIT_BALANCE_DRIFT: stored balance % <> Σ(movements) % for (%, %, %) — C4 tripwire', v_stored, v_sum, v_cust, v_cur, v_org;
    END IF;
    IF v_sum < 0 THEN
        RAISE EXCEPTION 'INSUFFICIENT_CREDIT_BALANCE: movement log sums to % for (%, %) — an applied movement was never covered (C4)', v_sum, v_cust, v_cur;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_ccbm_check_consistency
    AFTER INSERT ON customer_credit_balance_movements
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_ccbm_check_consistency();

-- ---------------------------------------------------------------------------
-- refunds (C2) — money leaving the building, traceable to a Payment.
-- ---------------------------------------------------------------------------
CREATE TABLE refunds (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid         NOT NULL REFERENCES orgs(id),
    -- [C2] the source of funds — refunds never float free of their payment.
    payment_id      uuid         NOT NULL,
    requested_by    text         NOT NULL,
    reason          text         NOT NULL,
    state           refund_state NOT NULL DEFAULT 'requested',
    total_minor     bigint       NOT NULL,
    currency        text         NOT NULL
                                 CONSTRAINT ck_refunds_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    -- Current Daraja B2C ref; every retry must use a NEW one (docs/03).
    external_ref    text,
    rejected_reason text,
    failed_reason   text,
    created_at      timestamptz  NOT NULL DEFAULT now(),
    updated_at      timestamptz  NOT NULL DEFAULT now(),

    CONSTRAINT ck_refunds_total_pos CHECK (total_minor > 0),
    CONSTRAINT ck_refunds_reason    CHECK (char_length(btrim(reason)) >= 1),
    CONSTRAINT ck_refunds_requester CHECK (char_length(btrim(requested_by)) >= 1)
);

CREATE UNIQUE INDEX uq_refunds_org_id ON refunds (org_id, id);
-- A B2C ref identifies exactly one refund attempt (retry ⇒ new ref).
CREATE UNIQUE INDEX uq_refunds_org_external_ref ON refunds (org_id, external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX idx_refunds_payment ON refunds (org_id, payment_id);
CREATE INDEX idx_refunds_state   ON refunds (org_id, state);

ALTER TABLE refunds
    ADD CONSTRAINT fk_refunds_payment FOREIGN KEY (org_id, payment_id) REFERENCES payments (org_id, id);

CREATE TRIGGER trg_refunds_touch BEFORE UPDATE ON refunds
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE refunds IS '[C2/R6] refunds: total ≤ confirmed − allocated − refunded-so-far, proven at COMMIT by trg_refunds_check_r6.';

-- [R6] COMMIT-time ceiling: refund.total ≤ confirmed − Σ(active allocations) −
-- Σ(live refunds other than this one). 'rejected'/'failed' attempts release
-- their reservation (they never left the building).
CREATE FUNCTION fuatilia_refunds_check_r6() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_pay uuid; v_self uuid; v_total bigint;
    v_confirmed bigint; v_alloc bigint; v_other_refunds bigint; v_available bigint;
BEGIN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    v_pay := COALESCE(NEW.payment_id, OLD.payment_id);
    v_self := COALESCE(NEW.id, OLD.id);
    v_total := COALESCE(NEW.total_minor, OLD.total_minor);

    SELECT confirmed_minor INTO v_confirmed FROM payments WHERE org_id = v_org AND id = v_pay;
    IF v_confirmed IS NULL THEN
        RAISE EXCEPTION 'REFUND_SOURCE_UNKNOWN: payment % missing or unconfirmed in org %', v_pay, v_org;
    END IF;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_alloc
      FROM allocations
     WHERE org_id = v_org AND source_type = 'payment' AND source_id = v_pay
       AND reversed_at IS NULL AND reversal_of IS NULL;
    SELECT COALESCE(SUM(total_minor), 0) INTO v_other_refunds
      FROM refunds
     WHERE org_id = v_org AND payment_id = v_pay AND id <> v_self
       AND state NOT IN ('rejected', 'failed');
    v_available := v_confirmed - v_alloc - v_other_refunds;
    IF v_total > v_available THEN
        RAISE EXCEPTION 'REFUND_EXCEEDS_CEILING: refund % > available % (confirmed % − allocated % − refunded %) on payment % — R6',
            v_total, v_available, v_confirmed, v_alloc, v_other_refunds, v_pay;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_refunds_check_r6
    AFTER INSERT OR UPDATE OF total_minor, state ON refunds
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_refunds_check_r6();

CREATE TABLE refund_allocations (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid         NOT NULL REFERENCES orgs(id),
    refund_id    uuid         NOT NULL,
    source       refund_source NOT NULL,
    amount_minor bigint       NOT NULL,
    currency     text         NOT NULL
                              CONSTRAINT ck_refund_allocations_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    created_at   timestamptz  NOT NULL DEFAULT now(),
    updated_at   timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT ck_refund_allocations_amount_pos CHECK (amount_minor > 0)
);

CREATE UNIQUE INDEX uq_refund_allocations_org_id ON refund_allocations (org_id, id);
CREATE INDEX idx_refund_allocations_refund ON refund_allocations (org_id, refund_id);

ALTER TABLE refund_allocations
    ADD CONSTRAINT fk_refund_allocations_refund FOREIGN KEY (org_id, refund_id) REFERENCES refunds (org_id, id);

CREATE TRIGGER trg_refund_allocations_touch BEFORE UPDATE ON refund_allocations
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- [docs/05] Σ(refund_allocations) == refund.total_minor at COMMIT.
CREATE FUNCTION fuatilia_refund_allocations_sum_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_ref uuid; v_sum bigint; v_total bigint;
BEGIN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    v_ref := COALESCE(NEW.refund_id, OLD.refund_id);
    SELECT total_minor INTO v_total FROM refunds WHERE org_id = v_org AND id = v_ref;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum
      FROM refund_allocations WHERE org_id = v_org AND refund_id = v_ref;
    IF v_sum <> v_total THEN
        RAISE EXCEPTION 'REFUND_ALLOCATION_SUM_MISMATCH: Σ(refund_allocations) % <> refund total % on refund % — docs/05', v_sum, v_total, v_ref;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_refund_allocations_sum_check
    AFTER INSERT OR UPDATE OR DELETE ON refund_allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_refund_allocations_sum_check();

-- ---------------------------------------------------------------------------
-- credit notes (C3) + applications (R7).
-- ---------------------------------------------------------------------------
CREATE TABLE credit_notes (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid              NOT NULL REFERENCES orgs(id),
    customer_id  uuid              NOT NULL,
    invoice_id   uuid,             -- optional invoice linkage
    reason       text              NOT NULL,
    total_minor  bigint            NOT NULL,  -- > 0, frozen at draft (docs/05)
    currency     text              NOT NULL
                                   CONSTRAINT ck_credit_notes_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    state        credit_note_state NOT NULL DEFAULT 'draft',
    issued_at    timestamptz,
    voided_at    timestamptz,
    created_at   timestamptz       NOT NULL DEFAULT now(),
    updated_at   timestamptz       NOT NULL DEFAULT now(),

    CONSTRAINT ck_credit_notes_total_pos CHECK (total_minor > 0),
    CONSTRAINT ck_credit_notes_reason    CHECK (char_length(btrim(reason)) >= 1),
    -- Voiding only while nothing was applied (docs/03: "never applied").
    CONSTRAINT ck_credit_notes_void_shape
        CHECK (state <> 'voided' OR voided_at IS NOT NULL)
);

CREATE UNIQUE INDEX uq_credit_notes_org_id ON credit_notes (org_id, id);
CREATE INDEX idx_credit_notes_customer ON credit_notes (org_id, customer_id);
CREATE INDEX idx_credit_notes_state    ON credit_notes (org_id, state);

ALTER TABLE credit_notes
    ADD CONSTRAINT fk_credit_notes_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id),
    ADD CONSTRAINT fk_credit_notes_invoice  FOREIGN KEY (org_id, invoice_id)  REFERENCES invoices  (org_id, id);

CREATE TRIGGER trg_credit_notes_touch BEFORE UPDATE ON credit_notes
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE credit_notes IS '[C3/R7] first-class credit note; Σ applications + Σ consented routings ≤ total, proven at COMMIT.';

CREATE TABLE credit_note_applications (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid        NOT NULL REFERENCES orgs(id),
    credit_note_id  uuid        NOT NULL,
    receivable_id   uuid        NOT NULL,
    amount_minor    bigint      NOT NULL,
    currency        text        NOT NULL
                                CONSTRAINT ck_cna_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    applied_at      timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_cna_amount_pos CHECK (amount_minor > 0)
);

CREATE UNIQUE INDEX uq_cna_org_id   ON credit_note_applications (org_id, id);
CREATE INDEX idx_cna_note           ON credit_note_applications (org_id, credit_note_id);
CREATE INDEX idx_cna_receivable     ON credit_note_applications (org_id, receivable_id);

ALTER TABLE credit_note_applications
    ADD CONSTRAINT fk_cna_note       FOREIGN KEY (org_id, credit_note_id) REFERENCES credit_notes (org_id, id),
    ADD CONSTRAINT fk_cna_receivable FOREIGN KEY (org_id, receivable_id)  REFERENCES receivables (org_id, id);

CREATE TRIGGER trg_cna_touch BEFORE UPDATE ON credit_note_applications
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- [R7] COMMIT-time ceiling: Σ applications + Σ consented credit-balance
-- routings sourced from this note ≤ note.total_minor.
CREATE FUNCTION fuatilia_cna_check_r7() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_note uuid; v_apps bigint; v_routed bigint; v_total bigint;
BEGIN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    v_note := COALESCE(NEW.credit_note_id, OLD.credit_note_id);
    SELECT total_minor INTO v_total FROM credit_notes WHERE org_id = v_org AND id = v_note;
    IF v_total IS NULL THEN
        RAISE EXCEPTION 'CREDIT_NOTE_UNKNOWN: note % missing in org %', v_note, v_org;
    END IF;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_apps
      FROM credit_note_applications WHERE org_id = v_org AND credit_note_id = v_note;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_routed
      FROM customer_credit_balance_movements
     WHERE org_id = v_org AND kind = 'credit_note_excess' AND source_credit_note_id = v_note;
    IF v_apps + v_routed > v_total THEN
        RAISE EXCEPTION 'CREDIT_NOTE_OVER_APPLIED: applications % + routings % > note total % on % — R7', v_apps, v_routed, v_total, v_note;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_cna_check_r7
    AFTER INSERT OR UPDATE OR DELETE ON credit_note_applications
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_cna_check_r7();

COMMENT ON CONSTRAINT trg_cna_check_r7 ON credit_note_applications IS '[R7] deferrable ceiling: Σ applications + consented routings ≤ note total.';

-- Credit-balance routings (R7's consented excess path) point back at the note.
ALTER TABLE customer_credit_balance_movements
    ADD CONSTRAINT fk_ccbm_note FOREIGN KEY (org_id, source_credit_note_id)
        REFERENCES credit_notes (org_id, id);
