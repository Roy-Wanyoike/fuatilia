-- 0008_ledger.sql — the immutable fund truth (issue #66, R1–R5, K5).
-- Maps src/domain/ledger/{accounts,matrix,journal,reconciliation}.ts.
--
-- Invariants encoded here:
--   * [R3 — append-only] ledger_entries rejects UPDATE and DELETE outright;
--     corrections are compensating entries carrying reversal_of.
--   * [R4 — double entry] every entry's Σ(debit) == Σ(credit) in ONE
--     currency, proven at COMMIT by a DEFERRABLE constraint trigger —
--     batch-safe (a mid-statement row trigger could not see the full batch).
--     No cent is created or destroyed (R1/R2's ledger face).
--   * [R5/K5] posting_matrix whitelists which (source, debit→credit) KIND
--     pairs may post; the COMMIT proof refuses unmapped postings.
--   * [R10] one currency per entry, refused at row level.
--   * Idempotent replay: UNIQUE (org_id, journal_ref, line_no).

CREATE TABLE ledger_accounts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid       NOT NULL REFERENCES orgs(id),
    code        text       NOT NULL,
    name        text       NOT NULL,
    kind        text       NOT NULL,
    currency    text       NOT NULL
                           CONSTRAINT ck_ledger_accounts_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_ledger_accounts_kind CHECK (kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
    CONSTRAINT ck_ledger_accounts_code_nonblank CHECK (char_length(btrim(code)) >= 1),
    CONSTRAINT ck_ledger_accounts_name_nonblank CHECK (char_length(btrim(name)) >= 1)
);

CREATE UNIQUE INDEX uq_ledger_accounts_code ON ledger_accounts (org_id, code);
CREATE UNIQUE INDEX uq_ledger_accounts_org_id ON ledger_accounts (org_id, id);

CREATE TRIGGER trg_ledger_accounts_touch
    BEFORE UPDATE ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- ---------------------------------------------------------------------------
-- posting_matrix — the whitelist of legal (source, debit→credit) KIND pairs
-- (K5). Seeded by deployers; the COMMIT proof consults it. Codes here are
-- account KINDS ('asset', 'income', ...) so the matrix stays small and stable.
-- ---------------------------------------------------------------------------
CREATE TABLE posting_matrix (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid  NOT NULL REFERENCES orgs(id),
    source      text  NOT NULL,
    debit_kind  text  NOT NULL,
    credit_kind text  NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_posting_matrix_kinds CHECK (debit_kind IN ('asset', 'liability', 'equity', 'income', 'expense')
                                             AND credit_kind IN ('asset', 'liability', 'equity', 'income', 'expense')),
    CONSTRAINT uq_posting_matrix UNIQUE (org_id, source, debit_kind, credit_kind)
);
COMMENT ON TABLE posting_matrix IS '[K5/R5] whitelist of legal (source, debit-kind → credit-kind) postings — unmapped postings are refused at COMMIT.';

CREATE TABLE ledger_entries (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid  NOT NULL REFERENCES orgs(id),
    entry_id     uuid  NOT NULL,
    line_no      integer NOT NULL,
    account_id   uuid  NOT NULL,
    direction    text  NOT NULL,
    amount_minor bigint NOT NULL,
    currency     text  NOT NULL
                        CONSTRAINT ck_ledger_entries_currency CHECK (currency IN ('KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX')),
    source       text  NOT NULL,
    source_ref   text,
    journal_ref  text  NOT NULL,
    posted_at    timestamptz NOT NULL DEFAULT now(),
    reversal_of  uuid,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_ledger_entries_direction CHECK (direction IN ('debit', 'credit')),
    CONSTRAINT ck_ledger_entries_amount_pos CHECK (amount_minor > 0),
    CONSTRAINT ck_ledger_entries_line CHECK (line_no >= 1),
    CONSTRAINT ck_ledger_entries_reversal_self CHECK (reversal_of IS NULL OR reversal_of <> id)
);

CREATE UNIQUE INDEX uq_ledger_entries_org_id ON ledger_entries (org_id, id);
CREATE UNIQUE INDEX uq_ledger_entries_replay ON ledger_entries (org_id, journal_ref, line_no);
CREATE INDEX idx_ledger_entries_entry ON ledger_entries (org_id, entry_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries (org_id, account_id, posted_at);
CREATE INDEX idx_ledger_entries_journal ON ledger_entries (org_id, journal_ref);

ALTER TABLE ledger_entries
    ADD CONSTRAINT fk_ledger_entries_account  FOREIGN KEY (org_id, account_id) REFERENCES ledger_accounts (org_id, id),
    ADD CONSTRAINT fk_ledger_entries_reversal FOREIGN KEY (org_id, reversal_of) REFERENCES ledger_entries (org_id, id);

COMMENT ON TABLE ledger_entries IS 'Immutable double-entry fund truth (R3/R4). Corrections append compensating entries with reversal_of — rows are never edited or deleted.';

-- ---------------------------------------------------------------------------
-- [R3] append-only + [R10] single currency, enforced per row.
-- (Batch balance and matrix mapping are COMMIT-time — see below.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_ledger_entries_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_ccy text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'LEDGER_APPEND_ONLY: ledger entries are never deleted (R3) — post a compensating entry with reversal_of';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'LEDGER_APPEND_ONLY: ledger entries are never updated (R3)';
    END IF;

    -- [R10] single currency per entry: compare against rows already visible
    -- in this statement's batch.
    SELECT min(currency) INTO v_ccy
      FROM ledger_entries
     WHERE org_id = NEW.org_id AND entry_id = NEW.entry_id;
    IF v_ccy IS NOT NULL AND v_ccy <> NEW.currency THEN
        RAISE EXCEPTION 'LEDGER_CURRENCY_MIXED: entry % mixes % with % (R10)', NEW.entry_id, v_ccy, NEW.currency;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER trg_ledger_entries_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION fuatilia_ledger_entries_guard();

-- [R4/R5] COMMIT-time proof: Σ(debit) == Σ(credit) for the whole entry, and
-- every (debit-kind → credit-kind) pair in it is whitelisted by the
-- posting_matrix for the entry's source.
CREATE FUNCTION fuatilia_ledger_entries_check_r4() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_org uuid; v_entry uuid; v_debits bigint; v_credits bigint; v_source text;
    r record; v_ok boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_org := OLD.org_id; v_entry := OLD.entry_id;
    ELSE
        v_org := NEW.org_id; v_entry := NEW.entry_id;
    END IF;

    SELECT min(source) INTO v_source
      FROM ledger_entries WHERE org_id = v_org AND entry_id = v_entry;

    SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
           COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
      INTO v_debits, v_credits
      FROM ledger_entries WHERE org_id = v_org AND entry_id = v_entry;

    IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'LEDGER_UNBALANCED: entry % debit % <> credit % (R4)', v_entry, v_debits, v_credits;
    END IF;

    -- Cross join the entry's debit rows against its credit rows: every
    -- (debit kind, credit kind) combination must be mapped (R5/K5).
    FOR r IN
        SELECT DISTINCT a.kind AS debit_kind, c.kind AS credit_kind
          FROM ledger_entries de
          JOIN ledger_accounts a ON a.org_id = de.org_id AND a.id = de.account_id
          JOIN ledger_entries ce ON ce.org_id = de.org_id AND ce.entry_id = de.entry_id
          JOIN ledger_accounts c ON c.org_id = ce.org_id AND c.id = ce.account_id
         WHERE de.org_id = v_org
           AND de.entry_id = v_entry
           AND de.direction = 'debit'
           AND ce.direction = 'credit'
    LOOP
        SELECT EXISTS (
            SELECT 1 FROM posting_matrix m
             WHERE m.org_id = v_org AND m.source = v_source
               AND m.debit_kind = r.debit_kind AND m.credit_kind = r.credit_kind
        ) INTO v_ok;
        IF NOT v_ok THEN
            RAISE EXCEPTION 'POSTING_NOT_MAPPED: source % has no mapping % → % (R5/K5)', v_source, r.debit_kind, r.credit_kind;
        END IF;
    END LOOP;

    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_ledger_entries_check_r4
    AFTER INSERT OR DELETE ON ledger_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fuatilia_ledger_entries_check_r4();

COMMENT ON TRIGGER trg_ledger_entries_guard ON ledger_entries IS '[R3/R10] append-only, single-currency per entry.';
COMMENT ON TRIGGER trg_ledger_entries_check_r4 ON ledger_entries IS '[R4/R5] deferrable COMMIT proof: Σdebit == Σcredit and every kind pair is whitelisted by posting_matrix.';
