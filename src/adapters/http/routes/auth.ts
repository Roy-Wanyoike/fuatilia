/**
 * `/v1/auth/*` admin routes over the merged auth lane (issue #55).
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows (SPEC §38): every admin route requires the
 * `admin:manage-users` vocabulary permission; the kernel's middleware does
 * authenticate → `can(principal, permission)` → audited denial (401/403)
 * BEFORE the handler runs, so handlers start from a guaranteed Principal.
 *
 * Handlers are wire→domain adapters ONLY: they validate the body shape
 * (`HTTP_BODY_INVALID`), look up referenced aggregates (`HTTP_*_NOT_FOUND`),
 * call the auth lane's pure functions with the injected clock/id ports,
 * persist through the injected store, record the lane's events, and project
 * serializable views. Decision VALUES the lane returns (idempotent replays,
 * the escalation guard's refusal) are mapped to statuses here:
 * replays → 200 with the `already*` flag, escalation refusal → audited AND
 * thrown as `AUTH_ESCALATION_BLOCKED` (403, table-mapped).
 *
 * Secret discipline (SPEC §34): issuing a key REQUIRES the caller-supplied
 * secret in the request body and the response carries the prefix only —
 * neither the raw secret nor its hash is ever echoed, logged or stored.
 */
import { DomainError, type Uuid } from '../../../domain/shared';
import { uuid as parseUuid } from '../../../domain/shared/ids';
import { AUTH_ESCALATION_BLOCKED } from '../../../domain/auth/assignments';
import { grantRole, revokeRole, type RoleGrant } from '../../../domain/auth/assignments';
import { issueKey, revokeKey, type ApiKey } from '../../../domain/auth/apikeys';
import { revokeSession, type Session } from '../../../domain/auth/sessions';
import { createUser, type User } from '../../../domain/auth/user';
import { effectivePermissions, ADMIN_MANAGE_USERS, type Role } from '../../../domain/auth/roles';
import type { Clock } from '../../../domain/shared/ids';
import { HTTP_BODY_INVALID, HTTP_ROLE_NOT_FOUND, HTTP_SESSION_NOT_FOUND, HTTP_USER_NOT_FOUND } from '../kernel/errors';
import type { RequestContext, RouteRecord } from '../kernel/types';
import type { AuthStore } from '../runtime/memory';

// --- body field guards (wire-shape validation only — the domain re-validates values) --

const requirePrincipal = (ctx: RequestContext): NonNullable<RequestContext['principal']> => {
  if (!ctx.principal) {
    // Unreachable: the kernel runs permission-gated handlers only with a
    // resolved principal — a violation is a kernel bug, so fail closed.
    throw new DomainError('HTTP_INTERNAL_ERROR', 'permission-gated handler reached without a principal');
  }
  return ctx.principal;
};

const bodyObject = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(HTTP_BODY_INVALID, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

const stringField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty string`);
  }
  return value.trim();
};

const uuidField = (body: Record<string, unknown>, name: string): Uuid => {
  const raw = stringField(body, name);
  try {
    return parseUuid(raw);
  } catch {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a UUID`);
  }
};

const optionalIsoField = (body: Record<string, unknown>, name: string): Date | null | undefined => {
  const raw = body[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an ISO-8601 timestamp`);
  }
  return new Date(Date.parse(raw));
};

// --- serializable views (never a raw aggregate: no hashes, no secrets) ----------------

export const userView = (user: User) => ({
  id: user.userId,
  orgId: user.orgId,
  email: user.email,
  username: user.username,
  displayName: user.displayName,
  status: user.status,
  createdAt: user.createdAt.toISOString(),
});

export const roleView = (role: Role) => ({
  id: role.roleId,
  orgId: role.orgId,
  name: role.name,
  permissions: role.permissions,
});

export const grantView = (grant: RoleGrant) => ({
  id: grant.grantId,
  orgId: grant.orgId,
  userId: grant.userId,
  roleId: grant.roleId,
  resourceId: grant.resourceId,
  grantedBy: grant.grantedBy,
  grantedAt: grant.grantedAt.toISOString(),
  revokedAt: grant.revokedAt === null ? null : grant.revokedAt.toISOString(),
  revokedReason: grant.revokedReason,
});

export const keyView = (key: ApiKey) => ({
  id: key.keyId,
  orgId: key.orgId,
  name: key.name,
  prefix: key.prefix,
  scopes: key.scopes,
  expiresAt: key.expiresAt === null ? null : key.expiresAt.toISOString(),
  status: key.status,
  createdAt: key.createdAt.toISOString(),
  lastUsedAt: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
});
// NOTE: `secret` and `secretHash` are deliberately absent — they never leave the process.

export const sessionView = (session: Session) => ({
  id: session.sessionId,
  userId: session.userId,
  orgId: session.orgId,
  status: session.status,
  createdAt: session.createdAt.toISOString(),
  lastSeenAt: session.lastSeenAt.toISOString(),
  endedAt: session.endedAt === null ? null : session.endedAt.toISOString(),
  endedReason: session.endedReason,
});

// --- the route table ---------------------------------------------------------------------

export interface AuthRouteDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly idGen: () => string;
}

/** The one permission every route in this table requires (SPEC §35). */
export const AUTH_ADMIN_PERMISSION = ADMIN_MANAGE_USERS;

/**
 * The `/v1/auth/*` admin table. POST-with-revocation shapes keep every
 * mutation an explicit, auditable command (revocation is a FACT in this
 * domain — there is no DELETE semantics over immutable facts).
 */
export function authRoutes(deps: AuthRouteDeps): RouteRecord[] {
  const { store, clock, idGen } = deps;
  const permission = AUTH_ADMIN_PERMISSION;

  const createUserRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/users',
    permission,
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const { user, event } = createUser(
        store.users(),
        {
          userId: idGen() as Uuid,
          orgId: principal.orgId,
          email: stringField(body, 'email'),
          username: stringField(body, 'username'),
          displayName: stringField(body, 'displayName'),
        },
        clock,
      );
      store.saveUser(user);
      store.record(event);
      return { status: 201, data: { user: userView(user) } };
    },
  };

  const grantRoleRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/roles/grants',
    permission,
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const userId = uuidField(body, 'userId');
      const roleId = uuidField(body, 'roleId');
      const resourceId = body['resourceId'] === undefined ? null : uuidField(body, 'resourceId');
      const role = store.roles().find((r) => r.roleId === roleId);
      if (!role) {
        throw new DomainError(HTTP_ROLE_NOT_FOUND, `role ${roleId} does not exist`);
      }
      if (!store.users().some((u) => u.userId === userId)) {
        throw new DomainError(HTTP_USER_NOT_FOUND, `user ${userId} does not exist`);
      }
      // The escalation guard needs the granter's own CONCRETE effective set.
      const granterPermissions = effectivePermissions(
        store.roles(),
        store.grants().filter((g) => g.userId === principal.principalId),
      );
      const result = grantRole(
        store.grants(),
        {
          grantId: idGen() as Uuid,
          orgId: principal.orgId,
          userId,
          role,
          grantedBy: principal.principalId,
          granterPermissions,
          resourceId,
        },
        clock,
      );
      if (!result.granted) {
        store.record(result.event); // audited refusal (auth.escalationBlocked)
        throw new DomainError(AUTH_ESCALATION_BLOCKED, result.detail, {
          reason: result.reason,
          missing: result.missing,
        });
      }
      store.saveGrant(result.grant);
      if (result.event) store.record(result.event);
      return {
        status: result.alreadyHeld ? 200 : 201,
        data: { grant: grantView(result.grant), alreadyHeld: result.alreadyHeld },
      };
    },
  };

  const revokeRoleRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/roles/revocations',
    permission,
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const userId = uuidField(body, 'userId');
      const roleId = uuidField(body, 'roleId');
      const reason = stringField(body, 'reason');
      const role = store.roles().find((r) => r.roleId === roleId);
      if (!role) {
        throw new DomainError(HTTP_ROLE_NOT_FOUND, `role ${roleId} does not exist`);
      }
      const { grant, event } = revokeRole(
        store.grants(),
        { userId, roleId, revokedBy: principal.principalId, reason },
        clock,
      );
      store.saveGrant(grant);
      store.record(event);
      return { status: 200, data: { grant: grantView(grant) } };
    },
  };

  const issueKeyRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/api-keys',
    permission,
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const scopesRaw = body['scopes'];
      if (!Array.isArray(scopesRaw) || scopesRaw.length === 0 || scopesRaw.some((s) => typeof s !== 'string')) {
        throw new DomainError(HTTP_BODY_INVALID, "field 'scopes' must be a non-empty array of strings");
      }
      const { key, event } = issueKey(
        store.keys(),
        {
          keyId: idGen() as Uuid,
          orgId: principal.orgId,
          name: stringField(body, 'name'),
          createdBy: principal.principalId,
          // Caller-generated secret — the API never returns secret material.
          secret: stringField(body, 'secret'),
          scopes: scopesRaw as string[],
          expiresAt: optionalIsoField(body, 'expiresAt'),
        },
        store.codec,
        clock,
      );
      store.saveKey(key);
      store.record(event);
      return { status: 201, data: { key: keyView(key) } };
    },
  };

  const revokeKeyRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/api-keys/revocations',
    permission,
    handler: (ctx) => {
      const principal = requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const result = revokeKey(
        store.keys(),
        {
          keyId: uuidField(body, 'keyId'),
          revokedBy: principal.principalId,
          reason: stringField(body, 'reason'),
        },
        clock,
      );
      store.saveKey(result.key);
      if (result.event) store.record(result.event);
      return {
        status: 200,
        data: { key: keyView(result.key), alreadyRevoked: result.alreadyRevoked },
      };
    },
  };

  const revokeSessionRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/auth/sessions/revocations',
    permission,
    handler: (ctx) => {
      requirePrincipal(ctx);
      const body = bodyObject(ctx.body);
      const sessionId = uuidField(body, 'sessionId');
      const session = store.sessions().find((s) => s.sessionId === sessionId);
      if (!session) {
        throw new DomainError(HTTP_SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      const { session: revoked } = revokeSession(session, { reason: stringField(body, 'reason') }, clock);
      store.saveSession(revoked);
      return { status: 200, data: { session: sessionView(revoked) } };
    },
  };

  return [
    createUserRoute,
    grantRoleRoute,
    revokeRoleRoute,
    issueKeyRoute,
    revokeKeyRoute,
    revokeSessionRoute,
  ];
}
