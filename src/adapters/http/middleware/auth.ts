/**
 * Authentication + authorization middleware (issue #55, SPEC §34/§35/§38).
 *
 * Wire contract:
 *   Authorization: Bearer <sessionToken>   — the auth lane's sessions verify
 *   Authorization: ApiKey <id>.<secret>    — the auth lane's apikeys verify
 *
 * The kernel does NOT own credentials: it delegates to the injected AuthPort
 * (composition wires it over the auth lane's sessions/apikeys/guard modules —
 * see ../runtime/memory.ts). 401 vs 403 semantics:
 *
 *   - 401 UNAUTHENTICATED — no header, malformed header, or the lane refused
 *     the credential (unknown/expired/revoked session, unknown/mismatched/
 *     revoked/expired key). The lane's stable denial codes pass through so
 *     clients can distinguish WHY, and every denial is audited: the port's
 *     `onDenied` sink receives the lane's `auth.accessDenied` event (the
 *     lane pairs the event itself where its API returns one; the middleware
 *     builds the identical shape otherwise).
 *   - 403 AUTH_ACCESS_DENIED — authenticated, but `can(principal, permission)`
 *     denied the route's permission. The denial message IS the CanDecision
 *     detail (carrying the lane's DenyReason — NO_GRANT,
 *     NOT_IN_RESOURCE_SCOPE, PRINCIPAL_SUSPENDED, …) and the denial is
 *     audited as an `auth.accessDenied` event.
 *
 * No secret material is ever echoed: messages reference prefixes/ids only,
 * and the raw Authorization value is never logged nor reflected.
 */
import { AUTH_ACCESS_DENIED, can, type CanDecision, type Principal } from '../../../domain/auth/guard';
import { AUTH_ATTEMPT_PERMISSION } from '../../../domain/auth/apikeys';
import {
  authEvent,
  type AccessDeniedPayload,
  type AuthEvent,
  type DenyReason,
} from '../../../domain/auth/events';
import type { Clock, Uuid } from '../../../domain/shared';
import { HTTP_UNAUTHENTICATED } from '../kernel/errors';
import type { HeaderMap } from '../kernel/body';

/** A nil-org aggregate for denials that precede org identification. */
export const NIL_ORG: Uuid = '00000000-0000-4000-8000-000000000000' as Uuid;

/** The audited denial event shape (auth lane's `auth.accessDenied`). */
export type AccessDeniedEvent = AuthEvent<'auth.accessDenied', AccessDeniedPayload>;

/**
 * The authentication port — composition adapts the auth lane's pure
 * functions to these two lookups (synchronous; persistence-backed ports
 * hide their I/O inside the closure).
 */
export interface AuthPort {
  /** Verify a Bearer session token → Principal (sessions verify + user projection). */
  readonly sessionPrincipal: (token: string) => AuthOutcome;
  /** Verify `ApiKey <id>.<secret>` → Principal (apikeys verify + key projection). */
  readonly apiKeyPrincipal: (id: string, secret: string) => AuthOutcome;
  /** Audit sink — receives every audited denial (append-only upstream). */
  readonly onDenied: (event: AccessDeniedEvent) => void;
}

export type AuthOutcome =
  | { readonly authenticated: true; readonly principal: Principal }
  | {
      readonly authenticated: false;
      /** Stable code (KEY_ / SESS_ / auth-lane codes) — passes through to the envelope. */
      readonly code: string;
      readonly message: string;
      readonly reason: DenyReason;
      readonly orgId: Uuid | null;
      readonly principalId: Uuid | null;
      readonly principalKind: 'user' | 'apiKey' | 'unknown';
      /** The lane's own audited denial event, when its API pairs one. */
      readonly event?: AccessDeniedEvent | null;
    };

/** Build the lane's `auth.accessDenied` event (uniform shape for all denials). */
export function accessDeniedEvent(
  args: {
    readonly orgId: Uuid | null;
    readonly principalId: Uuid | null;
    readonly principalKind: 'user' | 'apiKey' | 'unknown';
    readonly permission: string;
    readonly resource: Uuid | null;
    readonly reason: DenyReason;
    readonly detail: string;
  },
  clock: Clock,
): AccessDeniedEvent {
  const orgId = args.orgId ?? NIL_ORG;
  const payload: AccessDeniedPayload = {
    orgId,
    principalId: args.principalId,
    principalKind: args.principalKind,
    permission: args.permission,
    resource: args.resource,
    reason: args.reason,
    detail: args.detail,
    at: clock.now().toISOString(),
  };
  return authEvent('auth.accessDenied', orgId, payload, clock);
}

// --- header parsing -----------------------------------------------------------------

export type ParsedAuthorization =
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'apiKey'; readonly id: string; readonly secret: string };

/**
 * Parse the Authorization header. `Bearer <token>` and `ApiKey <id>.<secret>`
 * (split at the FIRST dot) are understood; anything else is malformed.
 */
export function parseAuthorization(header: string | undefined): ParsedAuthorization {
  if (header === undefined || header.trim() === '') return { kind: 'none' };
  const spaceAt = header.indexOf(' ');
  if (spaceAt < 1) {
    return { kind: 'malformed', detail: 'Authorization header must be "<scheme> <credentials>"' };
  }
  const scheme = header.slice(0, spaceAt).trim().toLowerCase();
  const credentials = header.slice(spaceAt + 1).trim();
  if (credentials === '') {
    return { kind: 'malformed', detail: `Authorization scheme '${scheme}' carries no credentials` };
  }
  if (scheme === 'bearer') return { kind: 'bearer', token: credentials };
  if (scheme === 'apikey') {
    const dotAt = credentials.indexOf('.');
    if (dotAt < 1 || dotAt === credentials.length - 1) {
      return { kind: 'malformed', detail: 'ApiKey credentials must be "<id>.<secret>"' };
    }
    return { kind: 'apiKey', id: credentials.slice(0, dotAt), secret: credentials.slice(dotAt + 1) };
  }
  return { kind: 'malformed', detail: `unsupported authorization scheme '${scheme}'` };
}

// --- authentication (401) --------------------------------------------------------------

export type AuthnResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Authenticate the request or refuse it with 401 semantics. Every refusal —
 * including "no header at all" — is audited via the port's `onDenied` sink
 * (deny-by-default is a fact, SPEC §37).
 */
export function authenticateRequest(headers: HeaderMap, port: AuthPort, clock: Clock): AuthnResult {
  const parsed = parseAuthorization(headers['authorization']);
  if (parsed.kind === 'none') {
    return refuse(
      port,
      clock,
      HTTP_UNAUTHENTICATED,
      'authentication required — supply "Authorization: Bearer <sessionToken>" or "Authorization: ApiKey <id>.<secret>"',
      'no Authorization header was presented',
    );
  }
  if (parsed.kind === 'malformed') {
    return refuse(port, clock, HTTP_UNAUTHENTICATED, parsed.detail, parsed.detail);
  }
  const outcome =
    parsed.kind === 'bearer'
      ? port.sessionPrincipal(parsed.token)
      : port.apiKeyPrincipal(parsed.id, parsed.secret);
  if (outcome.authenticated) return { ok: true, principal: outcome.principal };
  if (outcome.event) {
    port.onDenied(outcome.event);
  } else {
    port.onDenied(
      accessDeniedEvent(
        {
          orgId: outcome.orgId,
          principalId: outcome.principalId,
          principalKind: outcome.principalKind,
          permission: AUTH_ATTEMPT_PERMISSION,
          resource: null,
          reason: outcome.reason,
          detail: outcome.message,
        },
        clock,
      ),
    );
  }
  return { ok: false, code: outcome.code, message: outcome.message };
}

const refuse = (
  port: AuthPort,
  clock: Clock,
  code: string,
  message: string,
  detail: string,
): AuthnResult => {
  port.onDenied(
    accessDeniedEvent(
      {
        orgId: null,
        principalId: null,
        principalKind: 'unknown',
        permission: AUTH_ATTEMPT_PERMISSION,
        resource: null,
        reason: 'PRINCIPAL_UNKNOWN',
        detail,
      },
      clock,
    ),
  );
  return { ok: false, code, message };
};

// --- authorization (403) ------------------------------------------------------------

export type AuthzResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: typeof AUTH_ACCESS_DENIED;
      /** The CanDecision detail — carries the lane's DenyReason. */
      readonly message: string;
      readonly reason: DenyReason;
    };

/**
 * The per-route permission gate: `can(principal, route.permission)` with the
 * denial audited and the CanDecision reason carried to the client.
 */
export function authorizeRequest(
  principal: Principal,
  permission: string,
  port: AuthPort,
  clock: Clock,
): AuthzResult {
  const decision: CanDecision = can(principal, permission);
  if (decision.allowed) return { ok: true };
  port.onDenied(
    accessDeniedEvent(
      {
        orgId: principal.orgId,
        principalId: principal.principalId,
        principalKind: principal.kind,
        permission,
        resource: null,
        reason: decision.reason,
        detail: decision.detail,
      },
      clock,
    ),
  );
  return { ok: false, code: AUTH_ACCESS_DENIED, message: decision.detail, reason: decision.reason };
}
