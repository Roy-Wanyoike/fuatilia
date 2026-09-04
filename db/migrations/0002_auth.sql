-- 0002_auth.sql — identity & access (issue #66): users, roles, role_assignments,
-- api_keys, sessions. Maps src/domain/auth/{user,roles,assignments,apikeys,sessions}.ts.
--
-- Invariants encoded here:
--   * role_assignments is an APPEND-ONLY ledger: grants AND revocations are
--     INSERTed as facts; UPDATE/DELETE are rejected by trigger (R3 spirit —
--     "revoked" in the domain model is an immutable fact row, never an edit).
--   * NO-SELF-ESCALATION is a CHECK: a user can never be the granter of their
--     own role grant (ck_role_assignments_no_self_grant).
--   * api_keys stores ONLY a hash + a visible 8-char prefix. There is no
--     plaintext-secret column by design (src/domain/auth/apikeys.ts:
--     "the raw secret is never stored anywhere").
--   * sessions carry both idle and absolute timeout bounds as positive
--     integers and cannot be active once ended (status ⇔ ended_at).

-- Shared enum types for the auth lane (closed vocabularies, like the domain).
CREATE TYPE user_status       AS ENUM ('active', 'suspended', 'deactivated');
CREATE TYPE session_status    AS ENUM ('active', 'ended', 'expired', 'revoked');
CREATE TYPE api_key_status    AS ENUM ('active', 'revoked');
CREATE TYPE role_grant_kind   AS ENUM ('grant', 'revoke');

CREATE TABLE users (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id           uuid        NOT NULL REFERENCES orgs(id),
    email            text        NOT NULL,
    username         text        NOT NULL,
    display_name     text        NOT NULL,
    status           user_status NOT NULL DEFAULT 'active',
    -- PasswordRecord: digest material ONLY (codec output). Plaintext is never
    -- persisted — this column is opaque verifier bytes, never a secret.
    password_hash    text        NOT NULL,
    suspended_at     timestamptz,
    suspended_reason text,
    reactivated_at   timestamptz,
    deactivated_at   timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    -- Identity hygiene (src/domain/auth/user.ts assertEmail/assertUsername).
    CONSTRAINT ck_users_email_nonblank    CHECK (position('@' in btrim(email)) > 1),
    CONSTRAINT ck_users_username_nonblank CHECK (char_length(btrim(username)) >= 3),
    CONSTRAINT ck_users_display_nonblank  CHECK (char_length(btrim(display_name)) >= 1)
);

-- Per-tenant uniqueness of identity handles (U markers, docs/05).
CREATE UNIQUE INDEX uq_users_org_email    ON users (org_id, email);
CREATE UNIQUE INDEX uq_users_org_username ON users (org_id, username);
-- Composite target for org-scoped child FKs (sessions, grants, api keys).
CREATE UNIQUE INDEX uq_users_org_id       ON users (org_id, id);
-- Suspension cascade lookups (auth lane: suspending a user must be able to
-- enumerate their keys/sessions).
CREATE INDEX idx_users_status ON users (org_id, status);

CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON COLUMN users.password_hash IS 'Password verifier (codec digest) ONLY — plaintext secrets never touch this schema.';

CREATE TABLE roles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid        NOT NULL REFERENCES orgs(id),
    name         text        NOT NULL,   -- unique per org, e.g. "Collector"
    permissions  text[]      NOT NULL,   -- validated vocabulary subset, sorted
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_roles_name_nonblank CHECK (char_length(btrim(name)) >= 1),
    -- A role with zero permissions is dead weight and a mis-grant hazard.
    CONSTRAINT ck_roles_permissions_nonempty CHECK (cardinality(permissions) >= 1)
);

CREATE UNIQUE INDEX uq_roles_org_name ON roles (lower(name), org_id);
CREATE UNIQUE INDEX uq_roles_org_id   ON roles (org_id, id);

CREATE TRIGGER trg_roles_touch BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE roles IS 'Per-org role definitions; permissions are the sorted, validated rule set from src/domain/auth/roles.ts.';

-- ---------------------------------------------------------------------------
-- role_assignments — the APPEND-ONLY grant/revoke ledger.
--   kind='grant'  : a new role grant (revoked_* columns stay NULL forever).
--   kind='revoke' : a revocation FACT referencing the grant it revokes
--                   (revoked_grant_id). Nothing is ever updated or deleted.
--   [R3 spirit] history is the table; "latest fact wins" is a query, not an edit.
-- ---------------------------------------------------------------------------
CREATE TABLE role_assignments (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid             NOT NULL REFERENCES orgs(id),
    kind            role_grant_kind  NOT NULL,
    user_id         uuid             NOT NULL,
    role_id         uuid             NOT NULL,
    -- Org-wide grant when NULL; scoped to exactly one resource otherwise.
    resource_id     uuid,
    granted_by      uuid             NOT NULL,
    granted_at      timestamptz      NOT NULL DEFAULT now(),
    -- revoke rows only:
    revoked_grant_id uuid,
    revoked_at      timestamptz,
    revoked_by      uuid,
    revoked_reason  text,
    created_at      timestamptz      NOT NULL DEFAULT now(),
    updated_at      timestamptz      NOT NULL DEFAULT now(),

    -- [AUTH-1] NO-SELF-ESCALATION: you cannot grant yourself a role. Revoking
    -- your own grant is a demotion and stays legal.
    CONSTRAINT ck_role_assignments_no_self_grant
        CHECK (kind = 'revoke' OR granted_by <> user_id),
    -- Fact-shape discipline: grants carry no revocation, revokes carry it all.
    CONSTRAINT ck_role_assignments_grant_shape
        CHECK (kind = 'revoke' OR (revoked_grant_id IS NULL AND revoked_at IS NULL
                                   AND revoked_by IS NULL AND revoked_reason IS NULL)),
    CONSTRAINT ck_role_assignments_revoke_shape
        CHECK (kind = 'grant' OR (revoked_grant_id IS NOT NULL AND revoked_at IS NOT NULL
                                  AND revoked_by IS NOT NULL))
);

CREATE UNIQUE INDEX uq_role_assignments_org_id ON role_assignments (org_id, id);

-- Org-scoped FKs: actors, subjects and roles are all tenant-local. The
-- revoke→grant link is a composite self-FK; that the target is really a GRANT
-- row (not another revoke) is enforced in trg_role_assignments_validate_revoke
-- (PostgreSQL FKs cannot carry a partial WHERE — the trigger covers it).
ALTER TABLE role_assignments
    ADD CONSTRAINT fk_role_assignments_user     FOREIGN KEY (org_id, user_id)    REFERENCES users (org_id, id),
    ADD CONSTRAINT fk_role_assignments_role     FOREIGN KEY (org_id, role_id)    REFERENCES roles (org_id, id),
    ADD CONSTRAINT fk_role_assignments_granter  FOREIGN KEY (org_id, granted_by) REFERENCES users (org_id, id),
    ADD CONSTRAINT fk_role_assignments_revoked  FOREIGN KEY (org_id, revoked_grant_id)
        REFERENCES role_assignments (org_id, id);

-- Active-grant lookup (guard.ts effectivePermissions) + audit scans.
CREATE INDEX idx_role_assignments_user  ON role_assignments (org_id, user_id, kind);
CREATE INDEX idx_role_assignments_role  ON role_assignments (org_id, role_id);

-- Append-only enforcement (R3): grants and revokes are INSERT-only facts.
CREATE FUNCTION fuatilia_role_assignments_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ROLE_ASSIGNMENTS_APPEND_ONLY: role_assignments is an append-only ledger (R3) — % is rejected; append a fact row instead', TG_OP;
END $$;

CREATE TRIGGER trg_role_assignments_append_only
    BEFORE UPDATE OR DELETE ON role_assignments
    FOR EACH ROW EXECUTE FUNCTION fuatilia_role_assignments_append_only();

-- Revoke-fact validation: target must be a grant of the SAME user/role/org and
-- must not already be revoked (latest-fact-wins, no double revocation).
CREATE FUNCTION fuatilia_role_assignments_validate_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_user uuid; v_role uuid; v_org uuid; v_kind role_grant_kind;
BEGIN
    IF NEW.kind <> 'revoke' THEN RETURN NEW; END IF;
    SELECT org_id, user_id, role_id, kind INTO v_org, v_user, v_role, v_kind
      FROM role_assignments WHERE id = NEW.revoked_grant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ROLE_REVOKE_TARGET_UNKNOWN: grant % does not exist', NEW.revoked_grant_id;
    END IF;
    IF v_kind <> 'grant' THEN
        RAISE EXCEPTION 'ROLE_REVOKE_TARGET_NOT_GRANT: % is not a grant row', NEW.revoked_grant_id;
    END IF;
    IF v_org <> NEW.org_id OR v_user <> NEW.user_id OR v_role <> NEW.role_id THEN
        RAISE EXCEPTION 'ROLE_REVOKE_MISMATCH: revoke fact (org/user/role) does not match grant %', NEW.revoked_grant_id;
    END IF;
    IF EXISTS (SELECT 1 FROM role_assignments r WHERE r.revoked_grant_id = NEW.revoked_grant_id) THEN
        RAISE EXCEPTION 'ROLE_ALREADY_REVOKED: grant % already has a revocation fact', NEW.revoked_grant_id;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_role_assignments_validate_revoke
    BEFORE INSERT ON role_assignments
    FOR EACH ROW EXECUTE FUNCTION fuatilia_role_assignments_validate_revoke();

COMMENT ON TABLE  role_assignments IS 'Append-only grant/revoke ledger (R3). No-self-escalation CHECK: granted_by <> user_id on grant rows.';
COMMENT ON CONSTRAINT ck_role_assignments_no_self_grant ON role_assignments IS '[AUTH-1] no-self-escalation: a user can never grant themselves a role.';

-- ---------------------------------------------------------------------------
-- api_keys — hash + prefix ONLY (never plaintext). See src/domain/auth/apikeys.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
    key_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid           NOT NULL REFERENCES orgs(id),
    name         text           NOT NULL,
    created_by   uuid           NOT NULL,      -- issuer; suspension cascade hook
    prefix       text           NOT NULL,      -- visible KEY_PREFIX_LENGTH(8) chars of the secret
    secret_hash  text           NOT NULL,      -- codec digest of the full secret
    scopes       text[]         NOT NULL,      -- concrete permissions, deduped+sorted
    expires_at   timestamptz,
    status       api_key_status NOT NULL DEFAULT 'active',
    created_at   timestamptz    NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    revoked_at   timestamptz,
    revoked_by   uuid,
    revoked_reason text,
    updated_at   timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ck_api_keys_name_nonblank  CHECK (char_length(btrim(name)) >= 1),
    -- Exactly one visible prefix character count, matching KEY_PREFIX_LENGTH.
    CONSTRAINT ck_api_keys_prefix_len     CHECK (char_length(prefix) = 8),
    CONSTRAINT ck_api_keys_hash_nonblank  CHECK (char_length(btrim(secret_hash)) >= 16),
    CONSTRAINT ck_api_keys_scopes_nonempty CHECK (cardinality(scopes) >= 1),
    -- status ⇔ revocation fact (a key is revoked exactly once, immutably).
    CONSTRAINT ck_api_keys_revocation_shape
        CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

-- Authentication looks keys up by visible prefix, then verifies the hash.
CREATE INDEX idx_api_keys_prefix ON api_keys (org_id, prefix);
CREATE UNIQUE INDEX uq_api_keys_org_id ON api_keys (org_id, key_id);

ALTER TABLE api_keys
    ADD CONSTRAINT fk_api_keys_issuer FOREIGN KEY (org_id, created_by) REFERENCES users (org_id, id);

CREATE TRIGGER trg_api_keys_touch BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE api_keys IS 'API keys — hash + 8-char prefix only; the plaintext secret is never stored (auth lane).';
COMMENT ON COLUMN api_keys.prefix IS 'Visible key prefix (KEY_PREFIX_LENGTH=8) for lookup/display; NOT a secret.';

-- ---------------------------------------------------------------------------
-- sessions — idle + absolute timeout bounds (auth lane sessions.ts).
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
    session_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id            uuid           NOT NULL REFERENCES orgs(id),
    user_id           uuid           NOT NULL,
    idle_timeout_ms   bigint         NOT NULL,
    absolute_timeout_ms bigint       NOT NULL,
    status            session_status NOT NULL DEFAULT 'active',
    created_at        timestamptz    NOT NULL DEFAULT now(),
    last_seen_at      timestamptz    NOT NULL DEFAULT now(),
    ended_at          timestamptz,
    ended_reason      text,
    updated_at        timestamptz    NOT NULL DEFAULT now(),
    CONSTRAINT ck_sessions_timeouts_positive CHECK (idle_timeout_ms > 0 AND absolute_timeout_ms > 0),
    -- An active session has not ended; ended/expired/revoked sessions have.
    CONSTRAINT ck_sessions_end_shape CHECK ((status = 'active') = (ended_at IS NULL))
);

CREATE UNIQUE INDEX uq_sessions_org_id ON sessions (org_id, session_id);

ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_user FOREIGN KEY (org_id, user_id) REFERENCES users (org_id, id);

-- Guard lookups + idle-expiry sweeps.
CREATE INDEX idx_sessions_user_status ON sessions (org_id, user_id, status);
CREATE INDEX idx_sessions_last_seen   ON sessions (status, last_seen_at);

CREATE TRIGGER trg_sessions_touch BEFORE UPDATE ON sessions
    FOR EACH ROW EXECUTE FUNCTION fuatilia_touch_updated_at();

COMMENT ON TABLE sessions IS 'User sessions with idle + absolute timeout bounds (auth lane).';
