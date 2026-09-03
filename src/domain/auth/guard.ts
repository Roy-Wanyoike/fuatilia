/**
 * The authorization decision core (issue #46, SPEC §35 "Fine-grained
 * permissions / Organization isolation / Resource-level authorization").
 *
 * `can(principal, permission, resource?)` — DETERMINISTIC, DENY-BY-DEFAULT:
 *
 *   1. PERMISSION_UNKNOWN — the requested permission is not in the closed
 *      vocabulary (deny first: an unparseable request grants nothing);
 *   2. PRINCIPAL_SUSPENDED / PRINCIPAL_DEACTIVATED / PRINCIPAL_REVOKED —
 *      the principal record itself is not live;
 *   3. NO_GRANT — no active rule covers the permission (deny-by-default);
 *      NOT_IN_RESOURCE_SCOPE — the permission is held org-wide but not for
 *      THIS resource (grants may be resource-scoped; an org-wide grant —
 *      resourceId null — covers every resource).
 *
 * An ALLOW carries matched-rule EVIDENCE (the rule, its grant, its role) so
 * audit lines can say exactly which grant authorized the action.
 *
 * `authorize(...)` is the auditable boundary on top of `can`: it also
 * validates the optional session (idle/absolute expiry, revocation) and
 * wraps every denial as a DECISION VALUE paired with the `auth.accessDenied`
 * event — refusals are first-class facts (K2 precedent, SPEC §37), never
 * exceptions. Only a broken clock throws.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { PERMISSIONS, type Role } from './roles';
import { isActiveGrant, type RoleGrant } from './assignments';
import type { ApiKey } from './apikeys';
import { sessionState } from './sessions';
import type { Session } from './sessions';
import type { User, UserStatus } from './user';
import { authEvent, type AccessDeniedPayload, type AuthEvent, type DenyReason } from './events';

/** Stable code carried by every audited denial decision value. */
export const AUTH_ACCESS_DENIED = 'AUTH_ACCESS_DENIED';

// --- the principal --------------------------------------------------------------------

/** One authority rule a principal holds (grant-derived or key scope). */
export interface PermissionRule {
  /** Concrete permission or `<resource>:*` role wildcard (expanded on match). */
  readonly rule: string;
  /** The role behind the rule (null for API-key scopes). */
  readonly roleId: Uuid | null;
  /** The grant behind the rule (null for API-key scopes). */
  readonly grantId: Uuid | null;
  /** Org-wide rule when null; scoped to exactly this resource otherwise. */
  readonly resourceId: Uuid | null;
}

/**
 * The resolved actor a decision runs against: the live status of the
 * principal record plus the rules its active grants/scopes confer.
 */
export interface Principal {
  readonly kind: 'user' | 'apiKey';
  readonly principalId: Uuid;
  readonly orgId: Uuid;
  readonly status: UserStatus | 'revoked';
  readonly rules: readonly PermissionRule[];
}

/**
 * Project a user + their grant facts + the org's role registry into a
 * Principal. Only ACTIVE grants contribute; grants whose role is missing
 * from the registry contribute NOTHING (deny-by-default — a dangling grant
 * can never confer authority). Role-level wildcards stay wildcards here and
 * are expanded at match time by `can`.
 */
export const userPrincipal = (
  user: User,
  assignments: readonly RoleGrant[],
  roles: readonly Role[],
): Principal => {
  const byId = new Map(roles.map((r) => [r.roleId, r]));
  const rules: PermissionRule[] = [];
  for (const grant of assignments) {
    if (grant.userId !== user.userId || !isActiveGrant(grant)) continue;
    const role = byId.get(grant.roleId);
    if (!role) continue;
    for (const rule of role.permissions) {
      rules.push({ rule, roleId: role.roleId, grantId: grant.grantId, resourceId: grant.resourceId });
    }
  }
  return {
    kind: 'user',
    principalId: user.userId,
    orgId: user.orgId,
    status: user.status,
    rules,
  };
};

/**
 * Project an API key into a Principal: its concrete scopes ARE its rules
 * (roleId/grantId null — evidence names the key itself), status 'revoked'
 * once the revocation fact landed.
 */
export const apiKeyPrincipal = (key: ApiKey): Principal => ({
  kind: 'apiKey',
  principalId: key.keyId,
  orgId: key.orgId,
  status: key.status === 'active' ? 'active' : 'revoked',
  rules: key.scopes.map((scope) => ({
    rule: scope,
    roleId: null,
    grantId: null,
    resourceId: null,
  })),
});

// --- the decision core ---------------------------------------------------------------------

export type CanDecision =
  | {
      readonly allowed: true;
      /** Matched-rule evidence: which rule, via which grant/role, in scope. */
      readonly via: PermissionRule;
    }
  | {
      readonly allowed: false;
      readonly reason: DenyReason;
      readonly detail: string;
    };

const STATUS_REASONS: Record<string, DenyReason> = {
  suspended: 'PRINCIPAL_SUSPENDED',
  deactivated: 'PRINCIPAL_DEACTIVATED',
  revoked: 'PRINCIPAL_REVOKED',
};

const wildcardCovers = (rule: string, permission: string): boolean =>
  rule.endsWith(':*') && permission.startsWith(rule.slice(0, -1));

/**
 * `can(principal, permission, resource?)` — the deterministic permission
 * matrix. Pure: no clock, no I/O; precedence pinned by tests.
 */
export function can(principal: Principal, permission: string, resource?: Uuid): CanDecision {
  // 1. Unknown permission — deny-by-default starts at the vocabulary.
  if (typeof permission !== 'string' || !isKnownPermission(permission)) {
    return {
      allowed: false,
      reason: 'PERMISSION_UNKNOWN',
      detail: `permission '${String(permission)}' is outside the closed vocabulary — nothing can be granted it`,
    };
  }
  // 2. The principal record itself must be live.
  if (principal.status !== 'active') {
    const reason = STATUS_REASONS[principal.status] ?? 'PRINCIPAL_DEACTIVATED';
    return {
      allowed: false,
      reason,
      detail: `principal ${principal.principalId} is ${principal.status} — no decision runs against an inactive principal`,
    };
  }
  // 3. Match rules: covering rule + (when a resource is named) scope.
  let coversPermission = false;
  for (const rule of principal.rules) {
    const covered = rule.rule === permission || wildcardCovers(rule.rule, permission);
    if (!covered) continue;
    coversPermission = true;
    if (resource === undefined || rule.resourceId === null || rule.resourceId === resource) {
      return { allowed: true, via: rule };
    }
  }
  return coversPermission
    ? {
        allowed: false,
        reason: 'NOT_IN_RESOURCE_SCOPE',
        detail: `permission '${permission}' is held but not for resource ${String(resource)} — grants are scoped, not guessed`,
      }
    : {
        allowed: false,
        reason: 'NO_GRANT',
        detail: `no active grant or scope covers '${permission}' — deny by default`,
      };
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

const isKnownPermission = (permission: string): boolean => KNOWN_PERMISSIONS.has(permission);

// --- the auditable boundary --------------------------------------------------------------------

export interface AuthorizeArgs {
  /** The user record — null means "unknown principal" (still audited). */
  readonly user: User | null;
  readonly assignments: readonly RoleGrant[];
  readonly roles: readonly Role[];
  /** Present for session-authenticated requests; null for service calls. */
  readonly session: Session | null;
  readonly orgId: Uuid;
}

export type AuthorizeResult =
  | {
      readonly allowed: true;
      readonly decision: CanDecision & { readonly allowed: true };
      readonly principal: Principal;
    }
  | {
      readonly allowed: false;
      /** Stable code — always AUTH_ACCESS_DENIED (exported const). */
      readonly code: typeof AUTH_ACCESS_DENIED;
      readonly reason: DenyReason;
      readonly detail: string;
      /** auth.accessDenied — persist next to the denial decision (audit). */
      readonly event: AuthEvent<'auth.accessDenied', AccessDeniedPayload>;
    };

const SESSION_STATE_REASONS: Record<string, DenyReason> = {
  idleExpired: 'SESSION_IDLE_EXPIRED',
  absoluteExpired: 'SESSION_ABSOLUTE_EXPIRED',
  revoked: 'SESSION_REVOKED',
  ended: 'SESSION_ENDED',
  expired: 'SESSION_ABSOLUTE_EXPIRED',
};

/**
 * The auditable authorization boundary: session check → can() → wrap every
 * denial as a value + `auth.accessDenied` event (aggregate = the org; the
 * denial may concern an unknown principal). Pure: reads the arguments, never
 * mutates them; only a broken injected clock throws (AUTH_CLOCK_INVALID).
 */
export function authorize(
  args: AuthorizeArgs,
  permission: string,
  resource: Uuid | null,
  clock: Clock,
): AuthorizeResult {
  // Validate the clock up-front (also when the outcome is an early deny).
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('AUTH_CLOCK_INVALID', 'clock returned an invalid Date');
  }

  const deny = (reason: DenyReason, detail: string, principal: Principal | null): AuthorizeResult => ({
    allowed: false,
    code: AUTH_ACCESS_DENIED,
    reason,
    detail,
    event: authEvent(
      'auth.accessDenied',
      args.orgId,
      {
        orgId: args.orgId,
        principalId: principal === null ? null : principal.principalId,
        principalKind: principal === null ? 'unknown' : principal.kind,
        permission,
        resource,
        reason,
        detail,
        at: now.toISOString(),
      },
      clock,
    ),
  });

  // 0. Session gate (when the request rides a session).
  if (args.session) {
    const state = sessionState(args.session, clock);
    if (state !== 'active') {
      const reason = SESSION_STATE_REASONS[state] ?? 'SESSION_ENDED';
      return deny(
        reason,
        `session ${args.session.sessionId} is ${state} — expired or revoked sessions authorize nothing`,
        null,
      );
    }
  }

  // 1. Unknown principal.
  if (!args.user) {
    return deny('PRINCIPAL_UNKNOWN', 'no user record matches the presented identity', null);
  }

  // 2-4. The deterministic matrix.
  const principal = userPrincipal(args.user, args.assignments, args.roles);
  const decision = can(principal, permission, resource ?? undefined);
  if (decision.allowed) {
    return { allowed: true, decision, principal };
  }
  return deny(decision.reason, decision.detail, principal);
}
