-- 0004_invoicing_receivables.sql — invoices, invoice_items, receivables.
-- Maps src/domain/receivables/{invoice,receivable,aging}.ts (issues #1, #10).
--
-- Invariants encoded here:
--   * [R1 — receivable side] balance_minor is a GENERATED column:
--       balance_minor = original_minor − applied_minor, CHECK (>= 0).
--     The receivable can structurally never hold a negative balance.
--     (On brownfield adoption this CHECK would be added with
--     `NOT VALID` + `VALIDATE CONSTRAINT` so a backfill scan never runs
--     inside the write path — noted in db/README.md.)
--   * [R1] settled ⇔ fully applied: state='settled' requires balance_minor=0.
--   * [R1] voiding requires zero applied funds (docs/03 void rule).
--   * [H1] write-off is an approved DECISION: reason + approver are mandatory.
--   * Exactly one receivable per invoice: UNIQUE (org_id, invoice_id).
--   * Invoice totals are frozen at issuance: line edits are rejected once the
--     invoice leaves 'draft' (INVOICE_LINES_FROZEN, DDL-enforced), and the
--     stored total must equal Σ(line items) at commit (deferrable trigger).
--   * Aging-relevant generated column: balance_minor STORED (arreras = what
--     aging scans read), plus partial indexes over live receivables by
--     due_date — the access pattern behind GET /v1/receivables?sort=dueDate.

CREATE TYPE invoice_status   AS ENUM ('draft', 'issued', 'sent', 'voided');
CREATE TYPE receivable_state AS ENUM ('draft', 'open', 'partially_paid', 'settled',
                                      'written_off', 'recovered', 'uncollectible', 'voided');

CREATE TABLE invoices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid          NOT NULL REFERENCES orgs(id),
    customer_id     uuid          NOT NULL,
    status          invoice_status NOT NULL DEFAULT 'draft',
    currency        text          NOT NULL
                                  CONSTRAINT ck_invoices_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    total_minor     bigint        NOT NULL DEFAULT 0,
    -- eTIMS-reserved number (KRA), stamped at issuance; NULL while draft.
    invoice_number  text,
    issued_at       timestamptz,
    due_date        timestamptz   NOT NULL,
    sent_at         timestamptz,
    sent_channel    text,
    voided_at       timestamptz,
    void_reason     text,
    voided_by       text,
    created_at      timestamptz   NOT NULL DEFAULT now(),
    updated_at      timestamptz   NOT NULL DEFAULT now(),
    -- Totals are non-negative magnitudes in integer minor units.
    CONSTRAINT ck_invoices_total_nonneg CHECK (total_minor >= 0),
    -- Voiding is a decision with a reason and an actor (docs/03).
    CONSTRAINT ck_invoices_void_shape
        CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL AND voided_at IS NOT NULL)),
    -- The eTIMS number exists exactly when the invoice left draft.
    CONSTRAINT ck_invoices_number_shape
        CHECK ((status = 'draft') = (invoice_number IS NULL))
);

CREATE UNIQUE INDEX uq_invoices_org_id ON invoices (org_id, id);
-- eTIMS numbers are unique per org once reserved (NULL drafts don't collide).
CREATE UNIQUE INDEX uq_invoices_org_number ON invoices (org_id, invoice_number) WHERE invoice_number IS NOT NULL;
-- List/sort access pattern: GET /v1/receivables joins invoice due_date; and
-- the collections intelligence scans by customer.
CREATE INDEX idx_invoices_customer ON invoices (org_id, customer_id);
CREATE INDEX idx_invoices_due_date ON invoices (org_id, due_date);

ALTER TABLE invoices
    ADD CONSTRAINT fk_invoices_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers (org_id, id);

CREATE TRIGGER trg_invoices_touch BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE  invoices IS 'Invoice — the document (receivables lane); corrections after issuance go through credit notes, never edits.';
COMMENT ON COLUMN invoices.total_minor IS 'Σ(line items), frozen at issuance; equality enforced by trg_invoice_items_sum_check.';

CREATE TABLE invoice_items (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid        NOT NULL REFERENCES orgs(id),
    invoice_id    uuid        NOT NULL,
    line_no       integer     NOT NULL,
    description   text        NOT NULL,
    amount_minor  bigint      NOT NULL,
    currency      text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_invoice_items_amount_pos CHECK (amount_minor > 0),           -- addInvoiceLine: positive lines only
    CONSTRAINT ck_invoice_items_desc_nonblank CHECK (char_length(btrim(description)) >= 1),
    -- [R10] single-currency arithmetic: a line cannot be in a foreign currency.
    CONSTRAINT ck_invoice_items_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    CONSTRAINT ck_invoice_items_line_no CHECK (line_no >= 1)
);

CREATE UNIQUE INDEX uq_invoice_items_org_id ON invoice_items (org_id, id);
CREATE UNIQUE INDEX uq_invoice_items_line   ON invoice_items (org_id, invoice_id, line_no);

ALTER TABLE invoice_items
    ADD CONSTRAINT fk_invoice_items_invoice FOREIGN KEY (org_id, invoice_id) REFERENCES invoices (org_id, id);

CREATE TRIGGER trg_invoice_items_touch BEFORE UPDATE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- [docs/03] INVOICE_LINES_FROZEN as DDL: once the invoice is issued/sent/voided
-- the lines are immutable (issueInvoice freezes totals).
CREATE FUNCTION fuatilia_invoice_items_guard_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status invoice_status;
BEGIN
    SELECT status INTO v_status FROM invoices
      WHERE org_id = COALESCE(NEW.org_id, OLD.org_id) AND id = COALESCE(NEW.invoice_id, OLD.invoice_id);
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'INVOICE_UNKNOWN: invoice % does not exist', COALESCE(NEW.invoice_id, OLD.invoice_id);
    END IF;
    IF v_status <> 'draft' THEN
        RAISE EXCEPTION 'INVOICE_LINES_FROZEN: invoice is % — totals are frozen; use a credit note (docs/03)', v_status;
    END IF;
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_invoice_items_frozen_guard
    BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION fuatilia_invoice_items_guard_frozen();

-- Σ(line items) == invoices.total_minor at commit (deferrable so a batch of
-- line inserts + total update in one transaction validates once, at COMMIT).
CREATE FUNCTION fuatilia_invoice_items_sum_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_inv uuid; v_sum bigint; v_total bigint;
BEGIN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    v_inv := COALESCE(NEW.invoice_id, OLD.invoice_id);
    SELECT total_minor INTO v_total FROM invoices WHERE org_id = v_org AND id = v_inv;
    SELECT COALESCE(SUM(amount_minor), 0) INTO v_sum FROM invoice_items WHERE org_id = v_org AND invoice_id = v_inv;
    IF v_sum <> v_total THEN
        RAISE EXCEPTION 'INVOICE_TOTAL_MISMATCH: Σ(lines) % <> stored total % on invoice %', v_sum, v_total, v_inv;
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_invoice_items_sum_check
    AFTER INSERT OR UPDATE OR DELETE ON invoice_items
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fuatilia_invoice_items_sum_check();

-- ---------------------------------------------------------------------------
-- receivables — the legal debt position (docs/02; R1 owner).
-- ---------------------------------------------------------------------------
CREATE TABLE receivables (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               uuid            NOT NULL REFERENCES orgs(id),
    invoice_id           uuid            NOT NULL,
    customer_id          uuid            NOT NULL,
    currency             text            NOT NULL
                                         CONSTRAINT ck_receivables_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    -- Frozen at open (docs/05): guarded by trg_receivables_frozen_fields.
    original_minor       bigint          NOT NULL,
    -- Maintained by the allocation lane's trigger (0006): Σ(active allocations).
    applied_minor        bigint          NOT NULL DEFAULT 0,
    -- [R1] GENERATED balance: original − applied, structurally >= 0.
    balance_minor        bigint          GENERATED ALWAYS AS (original_minor - applied_minor) STORED,
    state                receivable_state NOT NULL DEFAULT 'draft',
    -- Stored overdue FLAG (derivable from due_date, cached for query speed —
    -- docs/03); only ever true while the debt is live.
    overdue              boolean         NOT NULL DEFAULT false,
    opened_at            timestamptz,
    due_date             timestamptz     NOT NULL,
    settled_at           timestamptz,
    voided_at            timestamptz,
    -- [H1] write-off decision record: never deletes the receivable.
    write_off_reason     text,
    write_off_approved_by text,
    write_off_at         timestamptz,
    uncollectible_reason text,
    uncollectible_at     timestamptz,
    recovered_at         timestamptz,
    created_at           timestamptz     NOT NULL DEFAULT now(),
    updated_at           timestamptz     NOT NULL DEFAULT now(),

    CONSTRAINT ck_receivables_original_nonneg CHECK (original_minor >= 0),
    CONSTRAINT ck_receivables_applied_nonneg  CHECK (applied_minor  >= 0),
    -- [R1] the generated balance can never go negative, ever.
    CONSTRAINT ck_receivables_balance_nonneg  CHECK (balance_minor  >= 0),
    -- [R1] settled ⇔ nothing left outstanding.
    CONSTRAINT ck_receivables_settled_zero    CHECK (state <> 'settled' OR balance_minor = 0),
    -- [docs/03] voiding is legal only while no funds were applied.
    CONSTRAINT ck_receivables_void_zero_applied CHECK (state <> 'voided' OR applied_minor = 0),
    -- [H1] a write-off decision carries its reason AND its approver.
    CONSTRAINT ck_receivables_writeoff_shape
        CHECK (state <> 'written_off' OR (write_off_reason IS NOT NULL AND write_off_approved_by IS NOT NULL)),
    -- The uncollectible verdict is a recorded decision (docs/03).
    CONSTRAINT ck_receivables_uncollectible_shape
        CHECK (state <> 'uncollectible' OR uncollectible_reason IS NOT NULL),
    -- The overdue flag only lives on live debt.
    CONSTRAINT ck_receivables_overdue_scope
        CHECK (overdue = false OR state IN ('open', 'partially_paid')),
    CONSTRAINT ck_receivables_due_date_present CHECK (due_date IS NOT NULL)
);

-- Exactly ONE receivable per invoice (docs/05: invoiceId unique) — [R1 frame].
CREATE UNIQUE INDEX uq_receivables_org_invoice ON receivables (org_id, invoice_id);
CREATE UNIQUE INDEX uq_receivables_org_id      ON receivables (org_id, id);

ALTER TABLE receivables
    ADD CONSTRAINT fk_receivables_invoice  FOREIGN KEY (org_id, invoice_id)  REFERENCES invoices   (org_id, id),
    ADD CONSTRAINT fk_receivables_customer FOREIGN KEY (org_id, customer_id) REFERENCES customers  (org_id, id);

-- Aging scans (docs/05 "agingBucket derived") and the receivables list route
-- (GET /v1/receivables — sortable id|state|dueDate, customer filter):
CREATE INDEX idx_receivables_state    ON receivables (org_id, state);
CREATE INDEX idx_receivables_customer ON receivables (org_id, customer_id);
-- THE aging index: live debt ordered by due date (bucket scan + listing).
CREATE INDEX idx_receivables_live_due ON receivables (org_id, due_date)
    WHERE state IN ('open', 'partially_paid');
CREATE INDEX idx_receivables_live_overdue ON receivables (org_id, due_date)
    WHERE overdue AND state IN ('open', 'partially_paid');

CREATE TRIGGER trg_receivables_touch BEFORE UPDATE ON receivables
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- Freeze the identity fields at open (docs/05: originalMinor "frozen at open";
-- currency/customer/invoice/dueDate define the debt).
CREATE FUNCTION fuatilia_receivables_frozen_fields() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.invoice_id, NEW.customer_id, NEW.currency, NEW.original_minor, NEW.due_date)
       IS DISTINCT FROM
       (OLD.org_id, OLD.invoice_id, OLD.customer_id, OLD.currency, OLD.original_minor, OLD.due_date) THEN
        RAISE EXCEPTION 'RECEIVABLE_FROZEN_FIELDS: original/currency/customer/invoice/dueDate are frozen at open (docs/05)';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_receivables_frozen_fields
    BEFORE UPDATE OF invoice_id, customer_id, currency, original_minor, due_date ON receivables
    FOR EACH ROW EXECUTE FUNCTION fuatilia_receivables_frozen_fields();

COMMENT ON TABLE  receivables IS 'The legal debt position; balance_minor is a GENERATED column (original − applied) so R1 holds structurally.';
COMMENT ON COLUMN receivables.balance_minor IS '[R1] GENERATED ALWAYS AS (original_minor - applied_minor) STORED; CHECK (>= 0). Brownfield note: add via NOT VALID + VALIDATE CONSTRAINT.';
