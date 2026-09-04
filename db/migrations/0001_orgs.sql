-- 0001_orgs.sql — Fuatilia production PostgreSQL schema (issue #66, wave 9-c).
--
-- Foundation: the org (tenant) row that every org-owned aggregate references,
-- plus the shared conventions used by every later migration:
--   * money is BIGINT minor units, never floats (SPEC §17, R10);
--   * timestamps are timestamptz;
--   * every table carries created_at / updated_at;
--   * org-owned children reference their parent through COMPOSITE foreign
--     keys (org_id, parent_id) — a row can never be linked across tenants;
--   * deterministic naming: uq_*/ck_*/fk_*/idx_*/trg_*.

-- NOTE: no BEGIN/COMMIT here — db/migrate.cjs wraps each file in exactly one
-- transaction (one Query message), so every migration is all-or-nothing.

-- The tenant root. Everything else is org-scoped (see composite FK convention).
CREATE TABLE orgs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text        NOT NULL,
    slug        text        NOT NULL,
    status      text        NOT NULL DEFAULT 'active'
                            CONSTRAINT ck_orgs_status CHECK (status IN ('active', 'suspended', 'closed')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_orgs_slug_nonblank CHECK (char_length(btrim(slug)) >= 1),
    CONSTRAINT ck_orgs_name_nonblank CHECK (char_length(btrim(name)) >= 1)
);

-- Slug is the human-stable tenant handle (login/API-key routing).
CREATE UNIQUE INDEX uq_orgs_slug ON orgs (slug);

COMMENT ON TABLE  orgs IS 'Tenant root — every org-owned table references orgs(id) via composite (org_id, id) FKs so cross-tenant linkage is structurally impossible.';
COMMENT ON COLUMN orgs.slug IS 'URL/login-stable tenant handle, unique globally.';

-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at honest on mutable tables. Append-only tables
-- (ledger, allocations, role_assignments, audit_events, ...) deliberately do
-- NOT get this trigger — their rows never change, so updated_at === created_at
-- forever, which is itself the auditable truth (R3).
-- ---------------------------------------------------------------------------
CREATE FUNCTION fuatilia_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

COMMENT ON FUNCTION fuatilia_touch_updated_at IS 'Shared created_at/updated_at convention: updated_at is stamped on every real UPDATE of mutable tables.';
