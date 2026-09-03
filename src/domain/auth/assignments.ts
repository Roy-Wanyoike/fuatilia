/**
 * Role assignments — the append-only user⇄role grant facts (issue #46,
 * SPEC §35 RBAC, §37 Audit System).
 *
 * Model (consent-lane "latest-fact-wins" discipline applied to authority):
 *   - a grant is a FACT: { who granted, whom, which role, when, and — for
 *     resource-level authorization — over which resource }. Revocation sets
 *     fields ON the fact; nothing is ever deleted (R3 spirit);
 *   - latest fact wins: a re-grant after revocation is a NEW grant fact; the
 *     revoked one stays as history;
 *   - same-role re-grant while an identical active grant exists is
 *     IDEMPOTENT: the original grant is returned unchanged, no duplicate
 *     fact, no event (issue invariant);
 *   - revocation of a role the user does not (actively) hold is a stable
 *     error, never a silent success (issue invariant);
 *   - ESCALATION GUARD: granting requires `admin:manage-users` AND every
 *     permission the target role confers must already sit in the granter's
 *     own effective set — grants never outlive the granter's authority. The
 *     refusal is a DECISION VALUE paired with the `auth.escalationBlocked`
 *     audit event (K2 precedent in communications/guard.ts), never an
 *     exception — blocked escalation attempts are facts to audit.
 *
 * The granter's authority arrives as an expanded CONCRETE permission set
 * (`granterPermissions`, see effectivePermissions) — this module stays
 * ignorant of role registries beyond the target role value.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { ADMIN_MANAGE_USERS, type Permission, type Role } from './roles';
import {
  authEvent,
  type AuthEvent,
  type EscalationBlockedPayload,
  type EscalationReason,
  type RoleGrantedPayload,
  type RoleRevokedPayload,
} from './events';
import { assertClockDate, assertNonBlank } from './user';

/** Stable code carried by the escalation-refusal decision value. */
export const AUTH_ESCALATION_BLOCKED = 'AUTH_ESCALATION_BLOCKED';

// --- the grant fact -------------------------------------------------------------

export interface RoleGrant {
  readonly grantId: Uuid;
  readonly orgId: Uuid;
  readonly userId: Uuid;
  readonly roleId: Uuid;
  /** Org-wide grant when null; scoped to exactly this resource otherwise. */
  readonly resourceId: Uuid | null;
  readonly grantedBy: Uuid;
  readonly grantedAt: Date;
  /** Revocation fields — set on the fact, never deleted (latest-fact-wins). */
  readonly revokedAt: Date | null;
  readonly revokedBy: Uuid | null;
  readonly revokedReason: string | null;
}

export const isActiveGrant = (grant: RoleGrant): boolean => grant.revokedAt === null;

// --- granting ---------------------------------------------------------------------

export interface GrantRoleArgs {
  readonly grantId: Uuid;
  readonly orgId: Uuid;
  readonly userId: Uuid;
  readonly role: Role;
  readonly grantedBy: Uuid;
  /**
   * The granter's effective CONCRETE permission set (already wildcard-
   * expanded). Empty for a suspended/unknown granter — which simply refuses.
   */
  readonly granterPermissions: readonly Permission[];
  /** Optional resource scope for resource-level authorization (SPEC §35). */
  readonly resourceId?: Uuid | null;
}

export type GrantRoleResult =
  | {
      readonly granted: true;
      readonly grant: RoleGrant;
      readonly event: AuthEvent<'auth.roleGranted', RoleGrantedPayload>;
      readonly alreadyHeld: false;
    }
  | {
      /** Idempotent replay: original grant returned, no duplicate, no event. */
      readonly granted: true;
      readonly grant: RoleGrant;
      readonly event: null;
      readonly alreadyHeld: true;
    }
  | {
      /** Escalation refused as a VALUE + `auth.escalationBlocked` audit event. */
      readonly granted: false;
      readonly code: typeof AUTH_ESCALATION_BLOCKED;
      readonly reason: EscalationReason;
      readonly detail: string;
      /** Concrete permissions of the target role the granter lacks (sorted). */
      readonly missing: readonly string[];
      readonly event: AuthEvent<'auth.escalationBlocked', EscalationBlockedPayload>;
    };

/**
 * Grant a role to a user as an append-only fact, gated by the escalation
 * guard. Pure: reads the existing grant trail, never mutates it.
 *
 * Order of evaluation (deterministic, tests pin it):
 *   1. idempotent replay — an existing grant with this grantId over the same
 *      (userId, roleId, resourceId) returns the ORIGINAL grant, no event
 *      (command replays are safe, R9 spirit); a grantId collision with a
 *      DIFFERENT payload is AUTH_GRANT_ID_TAKEN (a fact id is unique forever);
 *   2. idempotent re-grant — an ACTIVE grant over the same
 *      (userId, roleId, resourceId) under a fresh grantId returns the
 *      ORIGINAL grant, no duplicate fact, no event (issue invariant);
 *   3. escalation guard — GRANTER_NOT_ADMIN first, then
 *      GRANTER_LACKS_PERMISSION (both → refusal value + audit event);
 *   4. a revoked same-scope grant does NOT block a fresh grant — latest
 *      fact wins, so this appends a new grant fact + `auth.roleGranted`.
 */
export function grantRole(
  existingGrants: readonly RoleGrant[],
  args: GrantRoleArgs,
  clock: Clock,
): GrantRoleResult {
  const resourceId = args.resourceId === undefined ? null : args.resourceId;

  // 1. Same grantId: replay of the identical command → the original fact.
  const byId = existingGrants.find((g) => g.grantId === args.grantId);
  if (byId) {
    const sameCommand =
      byId.userId === args.userId && byId.roleId === args.role.roleId && byId.resourceId === resourceId;
    if (!sameCommand) {
      throw new DomainError('AUTH_GRANT_ID_TAKEN', `grant ${args.grantId} already exists over a different assignment`, {
        grantId: args.grantId,
      });
    }
    return { granted: true, grant: byId, event: null, alreadyHeld: true };
  }

  // 2. Same assignment already active (fresh command id) → idempotent.
  const replay = existingGrants.find(
    (g) =>
      isActiveGrant(g) &&
      g.userId === args.userId &&
      g.roleId === args.role.roleId &&
      g.resourceId === resourceId,
  );
  if (replay) {
    return { granted: true, grant: replay, event: null, alreadyHeld: true };
  }

  // Escalation guard — check 1: the granter must hold role administration.
  if (!args.granterPermissions.includes(ADMIN_MANAGE_USERS)) {
    const detail = `grant refused: ${args.grantedBy} does not hold ${ADMIN_MANAGE_USERS} — only role administrators may grant roles`;
    return {
      granted: false,
      code: AUTH_ESCALATION_BLOCKED,
      reason: 'GRANTER_NOT_ADMIN',
      detail,
      missing: [],
      event: authEvent(
        'auth.escalationBlocked',
        args.orgId,
        {
          orgId: args.orgId,
          granterId: args.grantedBy,
          userId: args.userId,
          roleId: args.role.roleId,
          reason: 'GRANTER_NOT_ADMIN',
          missing: [],
          at: clock.now().toISOString(),
        },
        clock,
      ),
    };
  }

  // Escalation guard — check 2: no grant may exceed the granter's own set.
  const missing = args.role.permissions
    .flatMap((rule) =>
      rule.endsWith(':*')
        ? // role-level wildcard: every vocabulary permission on that resource
          args.granterPermissions.some((p) => p.startsWith(`${rule.slice(0, -1)}`))
          ? []
          : [rule]
        : args.granterPermissions.includes(rule as Permission)
          ? []
          : [rule],
    )
    .sort();
  if (missing.length > 0) {
    const detail = `grant refused: role '${args.role.name}' confers ${missing.join(', ')} which ${args.grantedBy} does not hold — grants never outlive the granter's authority`;
    return {
      granted: false,
      code: AUTH_ESCALATION_BLOCKED,
      reason: 'GRANTER_LACKS_PERMISSION',
      detail,
      missing,
      event: authEvent(
        'auth.escalationBlocked',
        args.orgId,
        {
          orgId: args.orgId,
          granterId: args.grantedBy,
          userId: args.userId,
          roleId: args.role.roleId,
          reason: 'GRANTER_LACKS_PERMISSION',
          missing,
          at: clock.now().toISOString(),
        },
        clock,
      ),
    };
  }

  const grantedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  const grant: RoleGrant = {
    grantId: args.grantId,
    orgId: args.orgId,
    userId: args.userId,
    roleId: args.role.roleId,
    resourceId,
    grantedBy: args.grantedBy,
    grantedAt,
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
  };
  const payload: RoleGrantedPayload = {
    grantId: grant.grantId,
    orgId: grant.orgId,
    userId: grant.userId,
    roleId: grant.roleId,
    resourceId: grant.resourceId,
    grantedBy: grant.grantedBy,
    grantedAt: grantedAt.toISOString(),
  };
  return {
    granted: true,
    grant,
    event: authEvent('auth.roleGranted', grant.grantId, payload, clock),
    alreadyHeld: false,
  };
}

// --- revoking ------------------------------------------------------------------------

export interface RevokeRoleArgs {
  readonly userId: Uuid;
  readonly roleId: Uuid;
  readonly revokedBy: Uuid;
  readonly reason: string;
  /** Match the scope being revoked (default: the org-wide grant). */
  readonly resourceId?: Uuid | null;
}

/**
 * Revoke a role: set the revocation fields ON the active grant fact and emit
 * `auth.roleRevoked`. Revocation is a fact, never a deletion — the grant row
 * remains as history and a later re-grant appends a NEW fact.
 *
 * Throws:
 *   - AUTH_ROLE_NOT_HELD — no ACTIVE grant for (user, role, scope): revoking
 *     an unheld or already-revoked role is a stable error, not a silent
 *     success (issue invariant);
 *   - AUTH_REASON_REQUIRED / AUTH_ACTOR_REQUIRED / AUTH_CLOCK_INVALID.
 */
export function revokeRole(
  existingGrants: readonly RoleGrant[],
  args: RevokeRoleArgs,
  clock: Clock,
): { grant: RoleGrant; event: AuthEvent<'auth.roleRevoked', RoleRevokedPayload> } {
  const reason = assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'revocation reason');
  assertNonBlank(args.revokedBy, 'AUTH_ACTOR_REQUIRED', 'revoker id');
  const resourceId = args.resourceId === undefined ? null : args.resourceId;
  const target = existingGrants.find(
    (g) =>
      isActiveGrant(g) &&
      g.userId === args.userId &&
      g.roleId === args.roleId &&
      g.resourceId === resourceId,
  );
  if (!target) {
    throw new DomainError(
      'AUTH_ROLE_NOT_HELD',
      `user ${args.userId} does not actively hold role ${args.roleId} in this scope — revoking an unheld role is refused`,
      { userId: args.userId, roleId: args.roleId, resourceId },
    );
  }
  const revokedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  const grant: RoleGrant = {
    ...target,
    revokedAt,
    revokedBy: args.revokedBy,
    revokedReason: reason,
  };
  const payload: RoleRevokedPayload = {
    grantId: grant.grantId,
    orgId: grant.orgId,
    userId: grant.userId,
    roleId: grant.roleId,
    revokedBy: args.revokedBy,
    reason,
    revokedAt: revokedAt.toISOString(),
  };
  return { grant, event: authEvent('auth.roleRevoked', grant.grantId, payload, clock) };
}
