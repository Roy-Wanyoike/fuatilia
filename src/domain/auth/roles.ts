/**
 * Roles & the permission vocabulary (issue #46, SPEC §35 Authorization).
 *
 * Permissions are `"<resource>:<action>"` strings from a CLOSED vocabulary —
 * adapters cannot invent `invoice:nuke` and have it mean anything. Wildcards
 * (`<resource>:*`) are allowed ONLY inside role definitions, never per grant
 * and never as API-key scopes (a scope or grant is a concrete promise; a
 * role is the policy object that may summarize).
 *
 * Roles are org-scoped, immutable after definition (correct = define a new
 * version, never mutate history — R3 spirit), and are the only place
 * wildcards live. `roleCovers` answers "does this role's rule set include
 * this concrete permission" and `effectivePermissions` expands a principal's
 * active grants into the concrete permission set used by the escalation
 * guard and the decision core in guard.ts.
 *
 * Everything is a pure function over plain values: no I/O, no Date.now(),
 * time only via the injected Clock.
 */
import { DomainError, type Clock, type Uuid } from '../shared';

// --- the closed vocabulary (issue #46 + SPEC §35 granularity) ----------------

export const RESOURCES = [
  'receivables',
  'payments',
  'collections',
  'adjustments',
  'ledger',
  'intelligence',
  'admin',
  'policy',
] as const;

export type Resource = (typeof RESOURCES)[number];

/**
 * The closed permission vocabulary. Eight resources carry the platform's
 * authority surface (receivables:read, payments:intake, collections:act,
 * adjustments:request, ledger:post, intelligence:read, admin:manage-users,
 * policy:manage — per the issue) plus the read/write siblings SPEC §35's
 * granular examples require.
 */
export const PERMISSIONS = [
  'receivables:read',
  'receivables:write',
  'payments:read',
  'payments:intake',
  'payments:refund',
  'collections:read',
  'collections:act',
  'adjustments:request',
  'adjustments:approve',
  'ledger:read',
  'ledger:post',
  'intelligence:read',
  'admin:manage-users',
  'policy:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** The role-administration permission — REQUIRED to grant or revoke roles. */
export const ADMIN_MANAGE_USERS: Permission = 'admin:manage-users';

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

const isPermissionShape = (raw: string): boolean =>
  /^[a-z][a-z0-9]*:[a-z][a-zA-Z0-9-]*$/.test(raw);

/**
 * A role-level wildcard: exactly `<known-resource>:*`. A bare `*`, a
 * `resource:*` for an unknown resource, or any wider glob is malformed.
 */
export const isRoleWildcard = (raw: string): boolean => {
  const match = /^([a-z][a-z0-9]*):\*$/.exec(raw);
  return match !== null && (RESOURCES as readonly string[]).includes(match[1] ?? '');
};

/**
 * Validate a CONCRETE permission (the only kind allowed in grants, API-key
 * scopes and the escalation guard's permission sets). Throws:
 *   - AUTH_PERMISSION_MALFORMED — not `<resource>:<action>` shaped;
 *   - AUTH_PERMISSION_WILDCARD_FORBIDDEN — a wildcard where only concrete
 *     permissions are allowed (issue: "never per grant");
 *   - AUTH_PERMISSION_UNKNOWN — well-formed but outside the closed
 *     vocabulary (deny-by-default starts at the definitions).
 */
export const assertPermission = (raw: string): Permission => {
  if (isRoleWildcard(raw)) {
    throw new DomainError(
      'AUTH_PERMISSION_WILDCARD_FORBIDDEN',
      `wildcard '${raw}' is only allowed inside role definitions, never per grant or key scope`,
      { permission: raw },
    );
  }
  if (!isPermissionShape(raw)) {
    throw new DomainError(
      'AUTH_PERMISSION_MALFORMED',
      `permission '${raw}' is not a '<resource>:<action>' string`,
      { permission: raw },
    );
  }
  if (!PERMISSION_SET.has(raw)) {
    throw new DomainError(
      'AUTH_PERMISSION_UNKNOWN',
      `permission '${raw}' is outside the closed vocabulary`,
      { permission: raw, allowed: PERMISSIONS },
    );
  }
  return raw as Permission;
};

/**
 * Validate a permission entry in a ROLE definition: concrete vocabulary
 * entries and `<resource>:*` wildcards (role level only) are both legal.
 */
export const assertRolePermission = (raw: string): string => {
  if (isRoleWildcard(raw)) return raw;
  return assertPermission(raw);
};

// --- the role aggregate -------------------------------------------------------

export interface Role {
  readonly roleId: Uuid;
  readonly orgId: Uuid;
  /** Unique per org (case-insensitive) — display name, e.g. "Collector". */
  readonly name: string;
  /** Validated rule set: concrete permissions + resource wildcards, sorted. */
  readonly permissions: readonly string[];
  readonly createdAt: Date;
}

export interface DefineRoleArgs {
  readonly roleId: Uuid;
  readonly orgId: Uuid;
  readonly name: string;
  readonly permissions: readonly string[];
}

/**
 * Define a role (SPEC §35: Owner, Admin, Finance Manager, … are policies,
 * not rows in a hardcoded table — the org composes them from the closed
 * vocabulary). Fresh immutable value; the rules list is deduped and sorted
 * so matrix tests are order-independent.
 *
 * Throws:
 *   - AUTH_ROLE_ID_TAKEN — roleId already defined in this org;
 *   - AUTH_ROLE_NAME_TAKEN — name (case-insensitive) already defined;
 *   - AUTH_ROLE_PERMISSIONS_REQUIRED — empty/blank rule set (a role that
 *     grants nothing is a confusion, not a role);
 *   - AUTH_PERMISSION_* — invalid rule (see assertRolePermission).
 */
export function defineRole(
  existingRoles: readonly Role[],
  args: DefineRoleArgs,
  clock: Clock,
): { role: Role } {
  if (existingRoles.some((r) => r.roleId === args.roleId)) {
    throw new DomainError('AUTH_ROLE_ID_TAKEN', `role ${args.roleId} is already defined`, {
      roleId: args.roleId,
    });
  }
  const name = args.name.trim();
  if (!name) {
    throw new DomainError('AUTH_ROLE_NAME_REQUIRED', 'a role requires a non-blank name', {
      name: args.name,
    });
  }
  if (existingRoles.some((r) => r.orgId === args.orgId && r.name.toLowerCase() === name.toLowerCase())) {
    throw new DomainError('AUTH_ROLE_NAME_TAKEN', `role '${name}' already exists in this org`, {
      name,
    });
  }
  if (args.permissions.length === 0) {
    throw new DomainError(
      'AUTH_ROLE_PERMISSIONS_REQUIRED',
      'a role must carry at least one permission or wildcard',
    );
  }
  const permissions = Object.freeze([...new Set(args.permissions.map(assertRolePermission))].sort());
  return {
    role: Object.freeze({
      roleId: args.roleId,
      orgId: args.orgId,
      name,
      permissions,
      createdAt: clock.now(),
    }),
  };
}

// --- rule matching + expansion -------------------------------------------------

/**
 * Does this role's rule set cover the concrete permission? A concrete entry
 * matches itself; a `<resource>:*` wildcard matches every action on that
 * resource. This is the ONLY place wildcards are interpreted.
 */
export const roleCovers = (role: Role, permission: Permission): boolean =>
  role.permissions.some(
    (rule) => rule === permission || (isRoleWildcard(rule) && rule.startsWith(`${permission.split(':')[0]}:`)),
  );

/**
 * Expand a role's rules into the concrete permission set it confers
 * (wildcards resolved against the closed vocabulary, sorted). The escalation
 * guard compares against this expansion — a granter holding `collections:*`
 * can grant any role whose collections permissions all expand into their set.
 */
export const expandRolePermissions = (role: Role): Permission[] => {
  const expanded = PERMISSIONS.filter((p) => roleCovers(role, p));
  return [...expanded].sort();
};

/**
 * The principal's effective CONCRETE permissions: every active (unrevoked)
 * grant's role, expanded. Grants pointing at roles that don't exist in the
 * org's registry contribute nothing (deny-by-default — a dangling grant can
 * never confer authority).
 */
export const effectivePermissions = (
  roles: readonly Role[],
  grants: readonly { readonly roleId: Uuid; readonly revokedAt: Date | null }[],
): Permission[] => {
  const byId = new Map(roles.map((r) => [r.roleId, r]));
  const active = new Set<Permission>();
  for (const grant of grants) {
    if (grant.revokedAt !== null) continue;
    const role = byId.get(grant.roleId);
    if (!role) continue;
    for (const p of expandRolePermissions(role)) active.add(p);
  }
  return [...active].sort();
};
