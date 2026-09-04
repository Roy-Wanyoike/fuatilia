-- 0009_collections.sql — collections cases + actions (issue #66, R8, H6).
-- Maps src/domain/collections/{case,actions,derive}.ts.
--
-- Invariants encoded here:
--   * [R8 — exclusivity] a receivable is covered by AT MOST ONE open case
--     ('open' | 'in_progress'): partial UNIQUE index on the case↔receivable
--     link restricted to open cases — the second open is structurally
--     impossible (CASE_ALREADY_OPEN's DDL face).
--   * Cases are append-mostly: identity/ownership fields are frozen after
--     creation; only status/priority/owner/next-action evolve (trigger).
--   * case_actions is an append-only audit of every step (actor required).
--   * Idempotent replay: UNIQUE (org_id, case_number) and
--     UNIQUE (org_id, sequence_no).

CREATE TYPE case_status   AS ENUM ('open', 'in_progress', 'resolved', 'closed_inactive');
CREATE TYPE case_priority AS ENUM ('low', 'normal', 'high', 'urgent');

CREATE TABLE collections_cases (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES orgs(id),
    case_number  text NOT NULL,
    priority     case_priority NOT NULL DEFAULT 'normal',
    status       case_status   NOT NULL DEFAULT 'open',
    owner_id     uuid NOT NULL,
    next_action  text,
    next_action_at timestamptz,
    opened_at    timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz,
    closed_reason text,
    sequence_no  bigint NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_collections_cases_seq CHECK (sequence_no >= 1),
    CONSTRAINT ck_collections_cases_number_nonblank CHECK (char_length(btrim(case_number)) >= 1),
    -- A closed case carries its closing evidence; an open case has none.
    CONSTRAINT ck_collections_cases_closed_shape CHECK (
        (status IN ('resolved', 'closed_inactive')) = (closed_at IS NOT NULL)),
    CONSTRAINT ck_collections_cases_closed_reason CHECK (
        (status IN ('resolved', 'closed_inactive')) OR closed_reason IS NULL)
);

CREATE UNIQUE INDEX uq_collections_cases_number ON collections_cases (org_id, case_number);
CREATE UNIQUE INDEX uq_collections_cases_seq ON collections_cases (org_id, sequence_no);
CREATE UNIQUE INDEX uq_collections_cases_org_id ON collections_cases (org_id, id);
CREATE INDEX idx_collections_cases_open ON collections_cases (org_id, status, priority) WHERE status IN ('open', 'in_progress');

CREATE TRIGGER trg_collections_cases_touch
    BEFORE UPDATE ON collections_cases
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

-- Freeze the identity fields after creation (append-mostly discipline).
CREATE FUNCTION fuatilia_collections_cases_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.org_id, NEW.case_number, NEW.sequence_no, NEW.opened_at)
       IS NOT DISTINCT FROM
       (OLD.org_id, OLD.case_number, OLD.sequence_no, OLD.opened_at) THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'CASE_IDENTITY_FROZEN: case_number/sequence_no/opened_at never change after creation';
END $$;

CREATE TRIGGER trg_collections_cases_guard
    BEFORE UPDATE ON collections_cases
    FOR EACH ROW EXECUTE FUNCTION fuatilia_collections_cases_guard();

-- The case ↔ receivable link. R8 lives HERE: one OPEN case per receivable.
-- PostgreSQL forbids subqueries in index predicates, so openness is
-- DENORMALIZED into open_receivable_id (receivable_id when the case is open,
-- NULL otherwise) maintained by triggers on both tables — the partial UNIQUE
-- index over that marker is then airtight under concurrency: a second open
-- case for the same receivable cannot exist in any org.
CREATE TABLE collections_case_receivables (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES orgs(id),
    case_id            uuid NOT NULL,
    receivable_id      uuid NOT NULL,
    -- [R8] marker: receivable_id while the covering case is open, else NULL.
    open_receivable_id uuid,
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_collections_case_rec_unique UNIQUE (org_id, case_id, receivable_id)
);

CREATE UNIQUE INDEX uq_collections_case_rec_org_id ON collections_case_receivables (org_id, id);
ALTER TABLE collections_case_receivables
    ADD CONSTRAINT fk_collections_case_rec_case FOREIGN KEY (org_id, case_id)
        REFERENCES collections_cases (org_id, id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_collections_case_rec_rec  FOREIGN KEY (org_id, receivable_id)
        REFERENCES receivables (org_id, id);

-- [R8] the structural one-open-case-per-receivable guarantee.
CREATE UNIQUE INDEX uq_r8_one_open_case_per_receivable
    ON collections_case_receivables (org_id, open_receivable_id)
    WHERE open_receivable_id IS NOT NULL;
COMMENT ON INDEX uq_r8_one_open_case_per_receivable IS '[R8] a receivable is covered by at most one OPEN case — CASE_ALREADY_OPEN as DDL (openness denormalized into open_receivable_id).';

-- Maintain the [R8] marker on link insert: open case → marker set.
CREATE FUNCTION fuatilia_case_rec_r8_marker() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_status case_status;
BEGIN
    SELECT c.status INTO v_status
      FROM collections_cases c
     WHERE c.org_id = NEW.org_id AND c.id = NEW.case_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'CASE_UNKNOWN: case % missing in org %', NEW.case_id, NEW.org_id;
    END IF;
    NEW.open_receivable_id :=
        CASE WHEN v_status IN ('open', 'in_progress') THEN NEW.receivable_id END;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_case_rec_r8_marker
    BEFORE INSERT ON collections_case_receivables
    FOR EACH ROW EXECUTE FUNCTION fuatilia_case_rec_r8_marker();

-- Maintain the [R8] marker when a case changes status (open ⇄ closed).
CREATE FUNCTION fuatilia_case_r8_marker_sync() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE collections_case_receivables
       SET open_receivable_id =
             CASE WHEN NEW.status IN ('open', 'in_progress') THEN receivable_id END
     WHERE org_id = NEW.org_id AND case_id = NEW.id;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_case_r8_marker_sync
    AFTER UPDATE OF status ON collections_cases
    FOR EACH ROW EXECUTE FUNCTION fuatilia_case_r8_marker_sync();

-- ---------------------------------------------------------------------------
-- case_actions — append-only log of every collection step.
-- ---------------------------------------------------------------------------
CREATE TABLE case_actions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES orgs(id),
    case_id     uuid NOT NULL,
    actor_id    text NOT NULL,
    action      text NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    performed_at timestamptz NOT NULL DEFAULT now(),
    sequence_no bigint NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_case_actions_actor_nonblank CHECK (char_length(btrim(actor_id)) >= 1),
    CONSTRAINT ck_case_actions_action_nonblank CHECK (char_length(btrim(action)) >= 1),
    CONSTRAINT ck_case_actions_seq CHECK (sequence_no >= 1)
);

CREATE UNIQUE INDEX uq_case_actions_seq ON case_actions (org_id, case_id, sequence_no);
CREATE UNIQUE INDEX uq_case_actions_org_id ON case_actions (org_id, id);
CREATE INDEX idx_case_actions_case ON case_actions (org_id, case_id, performed_at);

ALTER TABLE case_actions
    ADD CONSTRAINT fk_case_actions_case FOREIGN KEY (org_id, case_id)
        REFERENCES collections_cases (org_id, id);

CREATE FUNCTION fuatilia_case_actions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CASE_ACTIONS_APPEND_ONLY: action history is never deleted';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'CASE_ACTIONS_APPEND_ONLY: action history is never edited';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_case_actions_guard
    BEFORE INSERT OR UPDATE OR DELETE ON case_actions
    FOR EACH ROW EXECUTE FUNCTION fuatilia_case_actions_guard();

COMMENT ON TABLE collections_cases IS 'Collections work queue: one row per case; R8 exclusivity is enforced on collections_case_receivables.';
COMMENT ON TABLE case_actions IS 'Append-only audit of every collection step (who/what/when) — the case timeline.';
