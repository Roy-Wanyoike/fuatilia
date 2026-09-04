-- 0010_promises_plans.sql — promises-to-pay + payment plans (issue #66, K2/H4/H5).
-- Maps src/domain/promises/{promise,dunning}.ts and
-- src/domain/receivables/payment-plan.ts.
--
-- Notes:
--   * promise states mirror the lane: created/pending/partially_fulfilled/
--     fulfilled/broken/cancelled/expired (fulfilled amount ≤ promised).
--   * payment plans: active/completed/defaulted/cancelled; installments are
--     a deterministic schedule — Σ(installments) == plan total (H4) is
--     proven by a constraint trigger at COMMIT.
--   * late-fee accrual stays in the application lane; DDL only pins shape.

CREATE TYPE promise_state AS ENUM ('created', 'pending', 'partially_fulfilled', 'fulfilled', 'broken', 'cancelled', 'expired');
CREATE TYPE plan_state    AS ENUM ('active', 'completed', 'defaulted', 'cancelled');
CREATE TYPE installment_state AS ENUM ('scheduled', 'due', 'paid', 'missed', 'waived');

CREATE TABLE promises (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES orgs(id),
    customer_id    uuid NOT NULL,
    receivable_id  uuid,
    promised_minor bigint NOT NULL,
    currency       text   NOT NULL
                          CONSTRAINT ck_promises_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    state          promise_state NOT NULL DEFAULT 'created',
    promised_for   timestamptz NOT NULL,
    fulfilled_minor bigint NOT NULL DEFAULT 0,
    broken_at      timestamptz,
    sequence_no    bigint NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_promises_amount_pos CHECK (promised_minor > 0),
    CONSTRAINT ck_promises_fulfilled_nonneg CHECK (fulfilled_minor >= 0),
    CONSTRAINT ck_promises_seq CHECK (sequence_no >= 1),
    CONSTRAINT ck_promises_fulfilled_bounds CHECK (fulfilled_minor <= promised_minor),
    -- Terminal shape: broken carries its instant; terminal states freeze.
    CONSTRAINT ck_promises_broken_shape CHECK ((state = 'broken') = (broken_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_promises_seq ON promises (org_id, sequence_no);
CREATE UNIQUE INDEX uq_promises_org_id ON promises (org_id, id);
CREATE INDEX idx_promises_customer ON promises (org_id, customer_id, promised_for);
CREATE INDEX idx_promises_open ON promises (org_id, state) WHERE state IN ('created', 'pending', 'partially_fulfilled');

ALTER TABLE promises
    ADD CONSTRAINT fk_promises_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE TRIGGER trg_promises_touch
    BEFORE UPDATE ON promises
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- ---------------------------------------------------------------------------
-- payment_plans + installments — the structured promise (H4/H5).
-- ---------------------------------------------------------------------------
CREATE TABLE payment_plans (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs(id),
    customer_id   uuid NOT NULL,
    receivable_id uuid NOT NULL,
    total_minor   bigint NOT NULL,
    currency      text   NOT NULL
                         CONSTRAINT ck_payment_plans_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    state         plan_state NOT NULL DEFAULT 'active',
    frequency     text NOT NULL,
    grace_days    integer NOT NULL DEFAULT 0,
    started_at    timestamptz NOT NULL,
    completed_at  timestamptz,
    sequence_no   bigint NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_payment_plans_total_pos CHECK (total_minor > 0),
    CONSTRAINT ck_payment_plans_grace CHECK (grace_days >= 0),
    CONSTRAINT ck_payment_plans_seq CHECK (sequence_no >= 1),
    CONSTRAINT ck_payment_plans_frequency CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
    CONSTRAINT ck_payment_plans_completed_shape CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_payment_plans_seq ON payment_plans (org_id, sequence_no);
CREATE UNIQUE INDEX uq_payment_plans_org_id ON payment_plans (org_id, id);
CREATE INDEX idx_payment_plans_customer ON payment_plans (org_id, customer_id, state);

ALTER TABLE payment_plans
    ADD CONSTRAINT fk_payment_plans_customer   FOREIGN KEY (org_id, customer_id)   REFERENCES customers (org_id, id),
    ADD CONSTRAINT fk_payment_plans_receivable FOREIGN KEY (org_id, receivable_id) REFERENCES receivables (org_id, id);

CREATE TRIGGER trg_payment_plans_touch
    BEFORE UPDATE ON payment_plans
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

CREATE TABLE installments (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    plan_id     uuid NOT NULL,
    installment_no integer NOT NULL,
    due_date    date NOT NULL,
    amount_minor bigint NOT NULL,
    state       installment_state NOT NULL DEFAULT 'scheduled',
    paid_minor  bigint NOT NULL DEFAULT 0,
    paid_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_installments_no CHECK (installment_no >= 1),
    CONSTRAINT ck_installments_amount_pos CHECK (amount_minor > 0),
    CONSTRAINT ck_installments_paid_nonneg CHECK (paid_minor >= 0),
    CONSTRAINT ck_installments_paid_bounds CHECK (paid_minor <= amount_minor),
    CONSTRAINT ck_installments_paid_shape CHECK (
        (state IN ('paid', 'missed', 'waived')) OR (paid_minor = 0 AND paid_at IS NULL)),
    CONSTRAINT uq_installments_plan UNIQUE (org_id, plan_id, installment_no)
);

CREATE UNIQUE INDEX uq_installments_org_id ON installments (org_id, id);
CREATE INDEX idx_installments_due ON installments (org_id, due_date) WHERE state = 'scheduled';

ALTER TABLE installments
    ADD CONSTRAINT fk_installments_plan FOREIGN KEY (org_id, plan_id) REFERENCES payment_plans (org_id, id);

CREATE TRIGGER trg_installments_touch
    BEFORE UPDATE ON installments
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- [H4] Σ(installments) == plan.total_minor, proven at COMMIT.
CREATE FUNCTION fuatilia_installments_check_sum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_plan uuid; v_sum bigint; v_total bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org := OLD.org_id; v_plan := OLD.plan_id;
    ELSE
        v_org := NEW.org_id; v_plan := NEW.plan_id;
    END IF;
    SELECT total_minor INTO v_total FROM payment_plans WHERE org_id = v_org AND id = v_plan;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INSTALLMENT_PLAN_UNKNOWN: plan % missing in org %', v_plan, v_org;
    END IF;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum
      FROM installments WHERE org_id = v_org AND plan_id = v_plan;
    IF v_sum <> v_total THEN
        RAISE EXCEPTION 'PLAN_SCHEDULE_MISMATCH: Σ(installments) % <> plan total % on plan % (H4)', v_sum, v_total, v_plan;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_installments_check_sum
    AFTER INSERT OR UPDATE OR DELETE ON installments
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_installments_check_sum();

COMMENT ON TABLE promises IS 'Promises-to-pay with lifecycle and fulfilled-amount bounds (K2).';
COMMENT ON TABLE payment_plans IS 'Structured repayment plans (H4/H5); the schedule sum invariant is COMMIT-proven on installments.';
COMMENT ON TRIGGER trg_installments_check_sum ON installments IS '[H4] Σ(installment amounts) must equal the plan total — deterministic schedule guarantee.';
