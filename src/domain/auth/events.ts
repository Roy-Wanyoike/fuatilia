/**
 * Auth-lane domain events (wave 6, issue #46, SPEC §34 Authentication +
 * §35 Authorization + §37 Audit System).
 *
 * Envelope mirrors the receivables/disputes/promises/communications lanes:
 * plain objects `{ name, version, aggregateId, occurredAt, payload }` (the
 * typed catalog + outbox of issue #6 wraps these; `version` stays 1 until a
 * breaking payload change). Payloads are narrow, serializable and id-only:
 * dates travel as ISO-8601 strings, cross-lane ids (org, user, resource) as
 * opaque Uuids, and the reason enums below so adapters match codes, never
 * prose.
 *
 * Aggregate conventions:
 *   - user lifecycle facts (userCreated / userSuspended) → the user id;
 *   - role-assignment facts (roleGranted / roleRevoked) → the grant id (the
 *     append-only fact IS the aggregate — revocation never deletes it);
 *   - api-key facts (apiKeyIssued / apiKeyRevoked) → the key id;
 *   - session expiry → the session id;
 *   - escalationBlocked has no aggregate (the refused grant must never
 *     exist) → the org id, like comms.unmatchedInbound;
 *   - accessDenied may concern an unknown principal → the org id.
 *
 * Secrets never travel in payloads: api-key payloads carry the visible
 * `prefix` only — never the raw secret, never its hash (SPEC §34: "Never
 * store plaintext passwords").
 */
import type { Clock, Uuid } from '../shared';

export type AuthEventName =
  | 'auth.userCreated'
  | 'auth.userSuspended'
  | 'auth.roleGranted'
  | 'auth.roleRevoked'
  | 'auth.escalationBlocked'
  | 'auth.apiKeyIssued'
  | 'auth.apiKeyRevoked'
  | 'auth.sessionExpired'
  | 'auth.accessDenied';

/** Stable envelope (issue #4); unifies with the typed catalog in issue #6. */
export interface AuthEvent<TName extends AuthEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the injected Clock
}

/** Pure event factory — the only way this lane builds events. */
export function authEvent<TName extends AuthEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): AuthEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: clock.now().toISOString(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// auth.userCreated / auth.userSuspended
// ---------------------------------------------------------------------------

/** auth.userCreated — an org-scoped principal record came into existence. */
export interface UserCreatedPayload {
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly createdAt: string;
}

/** auth.userSuspended — access cut at the source; sessions/keys cascade. */
export interface UserSuspendedPayload {
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly reason: string;
  readonly suspendedAt: string;
}

// ---------------------------------------------------------------------------
// auth.roleGranted / auth.roleRevoked / auth.escalationBlocked
// ---------------------------------------------------------------------------

/** auth.roleGranted — a new append-only user⇄role grant fact. */
export interface RoleGrantedPayload {
  readonly grantId: Uuid;
  readonly orgId: Uuid;
  readonly userId: Uuid;
  readonly roleId: Uuid;
  /** Org-wide grant when null; resource-scoped grant otherwise. */
  readonly resourceId: Uuid | null;
  readonly grantedBy: Uuid;
  readonly grantedAt: string;
}

/** auth.roleRevoked — revocation is a FACT on the grant, never a deletion. */
export interface RoleRevokedPayload {
  readonly grantId: Uuid;
  readonly orgId: Uuid;
  readonly userId: Uuid;
  readonly roleId: Uuid;
  readonly revokedBy: Uuid;
  readonly reason: string;
  readonly revokedAt: string;
}

/**
 * Why an escalation was blocked. The granter held `admin:manage-users`
 * insufficiently or the target role exceeded the granter's own authority.
 */
export type EscalationReason = 'GRANTER_NOT_ADMIN' | 'GRANTER_LACKS_PERMISSION';

/**
 * auth.escalationBlocked — a grant command that would have escalated the
 * granter's own authority was refused as a VALUE + audit event (K2
 * precedent: refusals that must be audited are facts, not exceptions).
 */
export interface EscalationBlockedPayload {
  readonly orgId: Uuid;
  readonly granterId: Uuid;
  readonly userId: Uuid;
  readonly roleId: Uuid;
  readonly reason: EscalationReason;
  /** Concrete permissions the granter lacks (sorted, empty when NOT_ADMIN). */
  readonly missing: readonly string[];
  readonly at: string;
}

// ---------------------------------------------------------------------------
// auth.apiKeyIssued / auth.apiKeyRevoked
// ---------------------------------------------------------------------------

/** auth.apiKeyIssued — issuance record; prefix visible, secret never. */
export interface ApiKeyIssuedPayload {
  readonly keyId: Uuid;
  readonly orgId: Uuid;
  readonly name: string;
  /** Visible key prefix (first KEY_PREFIX_LENGTH chars) — never the secret. */
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly createdBy: Uuid;
  readonly issuedAt: string;
}

/** auth.apiKeyRevoked — revocation fact; replay of the key is denied after. */
export interface ApiKeyRevokedPayload {
  readonly keyId: Uuid;
  readonly orgId: Uuid;
  readonly revokedBy: Uuid;
  readonly reason: string;
  readonly revokedAt: string;
}

// ---------------------------------------------------------------------------
// auth.sessionExpired
// ---------------------------------------------------------------------------

/** Why a session expired: idle timeout or the absolute lifetime cap. */
export type SessionExpiryReason = 'idle' | 'absolute';

/** auth.sessionExpired — the sweeper retired an idle/lifetime-exceeded session. */
export interface SessionExpiredPayload {
  readonly sessionId: Uuid;
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly reason: SessionExpiryReason;
  readonly expiredAt: string;
}

// ---------------------------------------------------------------------------
// auth.accessDenied — refusals are first-class facts (SPEC §37)
// ---------------------------------------------------------------------------

/**
 * Machine-readable denial reasons, shared by `can` / `authorize` /
 * `authenticateKey`. Precedence is deterministic and documented in
 * guard.ts / apikeys.ts — callers may rely on it.
 */
export type DenyReason =
  | 'PERMISSION_UNKNOWN'
  | 'PRINCIPAL_UNKNOWN'
  | 'PRINCIPAL_SUSPENDED'
  | 'PRINCIPAL_DEACTIVATED'
  | 'PRINCIPAL_REVOKED'
  | 'SESSION_IDLE_EXPIRED'
  | 'SESSION_ABSOLUTE_EXPIRED'
  | 'SESSION_REVOKED'
  | 'SESSION_ENDED'
  | 'NO_GRANT'
  | 'NOT_IN_RESOURCE_SCOPE'
  | 'KEY_UNKNOWN'
  | 'KEY_SECRET_MISMATCH'
  | 'KEY_REVOKED'
  | 'KEY_EXPIRED'
  | 'KEY_OWNER_INACTIVE';

/** auth.accessDenied — every denial, audited (deny-by-default is a fact). */
export interface AccessDeniedPayload {
  readonly orgId: Uuid;
  /** The denied principal when known; null for unknown users/keys. */
  readonly principalId: Uuid | null;
  readonly principalKind: 'user' | 'apiKey' | 'unknown';
  readonly permission: string;
  readonly resource: Uuid | null;
  readonly reason: DenyReason;
  readonly detail: string;
  readonly at: string;
}
