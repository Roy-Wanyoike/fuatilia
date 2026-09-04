-- 0006_allocations.sql — allocations (issue #5, review finding H3).
-- Maps src/domain/allocation/{allocation,engine,strategies}.ts.
--
-- Invariants encoded here:
--   * [R2 — no over-allocation] Σ(ACTIVE allocations of one source) ≤ the
--     source's funds (payment.confirmed_minor / customer credit balance),
--     proven at COMMIT by a DEFERRABLE constraint trigger — a batch of rows
--     that individually fit but jointly overdraw is rejected at COMMIT.
--   * [R1 — balance integrity, "sum-of-allocations == applied amount"]
--     receivables.applied_minor is maintained to equal Σ(ACTIVE allocation
--     rows) by trg_allocations_sync_receivable, and a deferrable constraint
--     trigger re-proves the equality (plus Σ ≤ original_minor) at COMMIT.
--     Over-allocation trips ck_receivables_balance_nonneg (0004) immediately.
--   * [R3] rows are never deleted and never mutated, EXCEPT the single
--     reversal stamp (reversed_at NULL → set once); corrections append a
--     compensating row carrying reversal_of.
--   * Idempotent replay: UNIQUE (org_id, source_type, source_id, sequence_no)
--     — docs/05 "sequenceNo … with sourceId+receivableId defines idempotent
--     replay".
--   * [R10] single-currency rows (currency CHECK + engine-side mismatch).

CREATE TYPE allocation_source   AS ENUM ('payment', 'credit_balance');
CREATE TYPE allocation_strategy AS ENUM ('fifo', 'explicit', 'pro_rata');

CREATE TABLE allocations (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id                   uuid               NOT NULL REFERENCES orgs(id),
    source_type              allocation_source  NOT NULL,
    -- Source-of-funds split: exactly one branch is set and source_id is its
    -- coalescing alias (docs/05 sourceType/sourceId as a typed pair).
    source_payment_id        uuid,
    source_credit_customer_id uuid,
    source_id                uuid               NOT NULL,
    receivable_id            uuid               NOT NULL,
    amount_minor             bigint             NOT NULL,
    currency                 text               NOT NULL
                                                CONSTRAINT ck_allocations_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    strategy                 allocation_strategy NOT NULL DEFAULT 'fifo',
    sequence_no              bigint             NOT NULL,
    allocated_at             timestamptz        NOT NULL DEFAULT now(),
    -- [R3] the single mutable instant: stamped once when this row is reversed.
    reversed_at              timestamptz,
    -- [R3] set on a COMPENSATING row; points at the row it undoes.
    reversal_of              uuid,
    created_at               timestamptz        NOT NULL DEFAULT now(),
    updated_at               timestamptz        NOT NULL DEFAULT now(),

    CONSTRAINT ck_allocations_amount_pos CHECK (amount_minor > 0),
    CONSTRAINT ck_allocations_seq        CHECK (sequence_no >= 1),
    -- Exactly-one source branch, always in agreement with source_id:
    CONSTRAINT ck_allocations_source_payment_branch
        CHECK ((source_type = 'payment') = (source_payment_id IS NOT NULL)),
    CONSTRAINT ck_allocations_source_credit_branch
        CHECK ((source_type = 'credit_balance') = (source_credit_customer_id IS NOT NULL)),
    CONSTRAINT ck_allocations_source_id_link
        CHECK (source_id = COALESCE(source_payment_id, source_credit_customer_id)),
    -- A compensating row cannot reference itself.
    CONSTRAINT ck_allocations_reversal_link CHECK (reversal_of IS NULL OR reversal_of <> id)
);

CREATE UNIQUE INDEX uq_allocations_org_id ON allocations (org_id, id);
-- Idempotent replay key (docs/05).
CREATE UNIQUE INDEX uq_allocations_replay ON allocations (org_id, source_type, source_id, sequence_no);
CREATE INDEX idx_allocations_receivable   ON allocations (org_id, receivable_id) WHERE reversed_at IS NULL;
CREATE INDEX idx_allocations_payment      ON allocations (org_id, source_payment_id) WHERE source_payment_id IS NOT NULL;
CREATE INDEX idx_allocations_credit       ON allocations (org_id, source_credit_customer_id) WHERE source_credit_customer_id IS NOT NULL;

ALTER TABLE allocations
    ADD CONSTRAINT fk_allocations_receivable  FOREIGN KEY (org_id, receivable_id)         REFERENCES receivables (org_id, id),
    ADD CONSTRAINT fk_allocations_payment     FOREIGN KEY (org_id, source_payment_id)     REFERENCES payments    (org_id, id),
    ADD CONSTRAINT fk_allocations_credit_cust FOREIGN KEY (org_id, source_credit_customer_id) REFERENCES customers (org_id, id),
    ADD CONSTRAINT fk_allocations_reversal    FOREIGN KEY (org_id, reversal_of)           REFERENCES allocations (org_id, id);

-- ---------------------------------------------------------------------------
-- [R3] append-only with ONE legal edit: stamping reversed_at on a live row.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_allocations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ALLOCATIONS_APPEND_ONLY: allocation rows are never deleted (R3) — append a compensating row instead';
    END IF;
    -- The only legal UPDATE: reversed_at NULL → NOT NULL, all else identical.
    IF OLD.reversed_at IS NOT NULL THEN
        RAISE EXCEPTION 'ALLOCATION_ALREADY_REVERSED: allocation % was stamped reversed at % (R3)', OLD.id, OLD.reversed_at;
    END IF;
    IF NEW.reversed_at IS NULL THEN
        RAISE EXCEPTION 'ALLOCATIONS_IMMUTABLE: the only permitted edit is stamping reversed_at (R3)';
    END IF;
    IF (NEW.id, NEW.org_id, NEW.source_type, NEW.source_payment_id, NEW.source_credit_customer_id,
        NEW.source_id, NEW.receivable_id, NEW.amount_minor, NEW.currency, NEW.strategy,
        NEW.sequence_no, NEW.allocated_at, NEW.reversal_of, NEW.created_at)
       IS NOT DISTINCT FROM
       (OLD.id, OLD.org_id, OLD.source_type, OLD.source_payment_id, OLD.source_credit_customer_id,
        OLD.source_id, OLD.receivable_id, OLD.amount_minor, OLD.currency, OLD.strategy,
        OLD.sequence_no, OLD.allocated_at, OLD.reversal_of, OLD.created_at) THEN
        RETURN NEW; -- the single reversal stamp
    END IF;
    RAISE EXCEPTION 'ALLOCATIONS_IMMUTABLE: only reversed_at may change on an allocation row (R3)';
END $$;

CREATE TRIGGER trg_allocations_guard
    BEFORE UPDATE OR DELETE ON allocations
    FOR EACH ROW EXECUTE FUNCTION fuatilia_allocations_guard();

-- ---------------------------------------------------------------------------
-- [R1] applied_minor maintenance: recompute from ACTIVE rows on every write.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_allocations_sync_receivable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_rec uuid;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_org := NEW.org_id; v_rec := NEW.receivable_id;
    ELSE
        v_org := OLD.org_id; v_rec := OLD.receivable_id;
    END IF;
    UPDATE receivables r
       SET applied_minor = (
             SELECT COALESCE(SUM(a.amount_minor), 0)
               FROM allocations a
              WHERE a.org_id = v_org
                AND a.receivable_id = v_rec
                AND a.reversed_at IS NULL
                AND a.reversal_of IS NULL)
     WHERE r.org_id = v_org
       AND r.id = v_rec;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_allocations_sync_receivable
    AFTER INSERT OR UPDATE OF reversed_at ON allocations
    FOR EACH ROW EXECUTE FUNCTION fuatilia_allocations_sync_receivable();

-- ---------------------------------------------------------------------------
-- [R1] COMMIT-time proof: stored applied_minor == Σ(ACTIVE rows) and
-- Σ(ACTIVE rows) ≤ original_minor ("sum-of-allocations == applied amount").
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_allocations_check_r1() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_rec uuid; v_sum bigint; v_stored bigint; v_original bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org := OLD.org_id; v_rec := OLD.receivable_id;
    ELSE
        v_org := NEW.org_id; v_rec := NEW.receivable_id;
    END IF;
    SELECT original_minor, applied_minor INTO v_original, v_stored
      FROM receivables WHERE org_id = v_org AND id = v_rec;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ALLOCATION_UNKNOWN_RECEIVABLE: receivable % missing in org %', v_rec, v_org;
    END IF;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum
      FROM allocations
     WHERE org_id = v_org AND receivable_id = v_rec
       AND reversed_at IS NULL AND reversal_of IS NULL;
    IF v_sum <> v_stored THEN
        RAISE EXCEPTION 'RECEIVABLE_APPLIED_DRIFT: receivable % applied_minor % <> Σ(active allocations) % — R1 tripwire', v_rec, v_stored, v_sum;
    END IF;
    IF v_sum > v_original THEN
        RAISE EXCEPTION 'RECEIVABLE_OVER_APPLIED: Σ(active allocations) % > original_minor % on receivable % — R1', v_sum, v_original, v_rec;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_allocations_check_r1
    AFTER INSERT OR UPDATE OF reversed_at ON allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_allocations_check_r1();

-- ---------------------------------------------------------------------------
-- [R2] COMMIT-time ceiling per source of funds:
--   payment        → Σ(active allocations) ≤ confirmed_minor
--   credit_balance → Σ(active allocations) ≤ available_minor (0007)
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_allocations_check_r2() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_type allocation_source; v_src uuid; v_sum bigint;
    v_confirmed bigint; v_available bigint;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org := OLD.org_id; v_type := OLD.source_type; v_src := OLD.source_id;
    ELSE
        v_org := NEW.org_id; v_type := NEW.source_type; v_src := NEW.source_id;
    END IF;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum
      FROM allocations
     WHERE org_id = v_org AND source_type = v_type AND source_id = v_src
       AND reversed_at IS NULL AND reversal_of IS NULL;

    IF v_type = 'payment' THEN
        SELECT confirmed_minor INTO v_confirmed FROM payments WHERE org_id = v_org AND id = v_src;
        IF v_confirmed IS NULL THEN
            RAISE EXCEPTION 'ALLOCATION_SOURCE_UNKNOWN: payment % missing or not confirmed in org %', v_src, v_org;
        END IF;
        IF v_sum > v_confirmed THEN
            RAISE EXCEPTION 'ALLOCATION_EXCEEDS_CONFIRMED: Σ(active allocations) % > confirmed_minor % on payment % — R2', v_sum, v_confirmed, v_src;
        END IF;
    ELSE
        SELECT available_minor INTO v_available
          FROM customer_credit_balances
         WHERE org_id = v_org AND customer_id = v_src;
        IF v_available IS NULL THEN
            RAISE EXCEPTION 'ALLOCATION_SOURCE_UNKNOWN: no credit balance for customer % in org %', v_src, v_org;
        END IF;
        IF v_sum > v_available THEN
            RAISE EXCEPTION 'ALLOCATION_EXCEEDS_CREDIT_BALANCE: Σ(active allocations) % > available_minor % on customer % — R2/R7', v_sum, v_available, v_src;
        END IF;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_allocations_check_r2
    AFTER INSERT OR UPDATE OF reversed_at ON allocations
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_allocations_check_r2();

COMMENT ON TABLE allocations IS 'Append-only postings moving value from ONE source (payment | credit_balance) to ONE receivable (R1/R2/R3 core).';
COMMENT ON CONSTRAINT ck_allocations_source_id_link ON allocations IS 'source_id is always COALESCE(payment, credit-balance customer) — the typed source pair, drift-proof.';
COMMENT ON TRIGGER trg_allocations_check_r2 ON allocations IS '[R2] deferrable: Σ(active allocations) ≤ source funds, proven at COMMIT so multi-row batches cannot overdraw.';
COMMENT ON TRIGGER trg_allocations_check_r1 ON allocations IS '[R1] deferrable: applied_minor == Σ(active allocations) and Σ ≤ original_minor at COMMIT.';
