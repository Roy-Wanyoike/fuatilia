/**
 * Kernel transport codes + the domain-code → HTTP-status mapping table
 * (issue #55, SPEC §38 "Error formats").
 *
 * Every failure a client can see is `{ error: { code, message }, requestId }`
 * where `code` is a stable SCREAMING_SNAKE code — the kernel never invents
 * prose-only errors and never leaks internals (a 500 carries the generic
 * `HTTP_INTERNAL_ERROR` code + "internal server error", the real error goes
 * to the injected `onError` sink, never to the wire).
 *
 * Mapping table (deterministic precedence, table-tested):
 *   1. EXACT codes — the kernel's own transport codes, the auth lane's
 *      authentication denials (`KEY_*` → 401), the audited authorization
 *      denials (`AUTH_ACCESS_DENIED` / `AUTH_ESCALATION_BLOCKED` → 403) and
 *      special-cased validation codes;
 *   2. PREFIX rules — `SESS_*` / `KEY_*` families mean "unusable
 *      credentials" → 401;
 *   3. SUFFIX rules on the stable domain vocabulary — `*_NOT_FOUND` → 404,
 *      `*_TAKEN/_EXISTS/_DUPLICATE/_MISMATCH` → 409, `*_NOT_*` state
 *      conflicts → 409, `*_EXPIRED/_EXCEEDED/_REFUSED` → 422,
 *      `*_BLOCKED/_NO_CONSENT` → 403, `*_INVALID/_REQUIRED/_MALFORMED/…` →
 *      400;
 *   4. anything unmapped → 500 (fail closed: an unmapped code can never
 *      become a misleading 2xx/4xx).
 */
import { DomainError } from '../../../domain/shared/errors';

// --- the kernel's own stable transport codes ---------------------------------

export const HTTP_PAYLOAD_TOO_LARGE = 'HTTP_PAYLOAD_TOO_LARGE'; // 413
export const HTTP_BODY_MALFORMED = 'HTTP_BODY_MALFORMED'; // 400 — not JSON
export const HTTP_BODY_INVALID = 'HTTP_BODY_INVALID'; // 400 — wrong shape/fields
export const HTTP_QUERY_INVALID = 'HTTP_QUERY_INVALID'; // 400 — pagination/sort
export const HTTP_ROUTE_NOT_FOUND = 'HTTP_ROUTE_NOT_FOUND'; // 404
export const HTTP_METHOD_NOT_ALLOWED = 'HTTP_METHOD_NOT_ALLOWED'; // 405
export const HTTP_UNAUTHENTICATED = 'HTTP_UNAUTHENTICATED'; // 401 — no/bad credentials
export const HTTP_ROUTE_PATTERN_INVALID = 'HTTP_ROUTE_PATTERN_INVALID'; // registration-time
export const HTTP_ROUTE_DUPLICATE = 'HTTP_ROUTE_DUPLICATE'; // registration-time
export const HTTP_USER_NOT_FOUND = 'HTTP_USER_NOT_FOUND'; // 404 — route-level lookup
export const HTTP_ROLE_NOT_FOUND = 'HTTP_ROLE_NOT_FOUND'; // 404 — route-level lookup
export const HTTP_SESSION_NOT_FOUND = 'HTTP_SESSION_NOT_FOUND'; // 404 — route-level lookup
export const HTTP_INTERNAL_ERROR = 'HTTP_INTERNAL_ERROR'; // 500 — generic, never leaks

/** The kernel transport codes with their pinned statuses (table-tested). */
export const KERNEL_STATUS: Readonly<Record<string, number>> = {
  [HTTP_PAYLOAD_TOO_LARGE]: 413,
  [HTTP_BODY_MALFORMED]: 400,
  [HTTP_BODY_INVALID]: 400,
  [HTTP_QUERY_INVALID]: 400,
  [HTTP_ROUTE_NOT_FOUND]: 404,
  [HTTP_METHOD_NOT_ALLOWED]: 405,
  [HTTP_UNAUTHENTICATED]: 401,
  [HTTP_ROUTE_PATTERN_INVALID]: 500,
  [HTTP_ROUTE_DUPLICATE]: 500,
  [HTTP_USER_NOT_FOUND]: 404,
  [HTTP_ROLE_NOT_FOUND]: 404,
  [HTTP_SESSION_NOT_FOUND]: 404,
  [HTTP_INTERNAL_ERROR]: 500,
};

// --- the mapping table -------------------------------------------------------------

/**
 * EXACT overrides — evaluated first, so e.g. `KEY_SECRET_MISMATCH` maps to
 * 401 (unauthenticated) even though the `_MISMATCH` suffix rule says 409.
 */
const EXACT_STATUS: Readonly<Record<string, number>> = {
  ...KERNEL_STATUS,
  // Authorization: authenticated but forbidden — the auth lane's audited denials.
  AUTH_ACCESS_DENIED: 403,
  AUTH_ESCALATION_BLOCKED: 403,
  // Authentication pass-throughs: the auth lane's key-denial decisions.
  KEY_UNKNOWN: 401,
  KEY_SECRET_MISMATCH: 401,
  KEY_REVOKED: 401,
  KEY_EXPIRED: 401,
  KEY_OWNER_INACTIVE: 401,
  // Validation special case: a wildcard where only concrete permissions are legal.
  AUTH_PERMISSION_WILDCARD_FORBIDDEN: 400,
};

/** PREFIX rules — whole code families with one meaning. */
const PREFIX_STATUS: readonly { readonly prefix: string; readonly status: number }[] = [
  { prefix: 'SESSION_', status: 401 }, // the auth lane's session-state denials (idle/absolute expiry, revoked)
  { prefix: 'SESS_', status: 401 }, // short-form session-state denials → unauthenticated
  { prefix: 'KEY_', status: 401 }, // any other key denial → unauthenticated
  { prefix: 'PRINCIPAL_', status: 401 }, // the principal record itself is not live/known
];

/**
 * SUFFIX rules over the repo's stable domain vocabulary. Order inside the
 * list is irrelevant (suffixes are mutually exclusive); `_NOT_FOUND` is
 * checked before the `*_NOT_*` state-conflict rule at the call site.
 */
const SUFFIX_STATUS: readonly { readonly suffix: string; readonly status: number }[] = [
  { suffix: '_TAKEN', status: 409 }, // unique-fact collisions (ids, emails, usernames)
  { suffix: '_EXISTS', status: 409 },
  { suffix: '_DUPLICATE', status: 409 },
  { suffix: '_MISMATCH', status: 409 },
  { suffix: '_EXPIRED', status: 422 }, // well-formed but stale
  { suffix: '_EXCEEDED', status: 422 }, // limits/ceilings refused
  { suffix: '_REFUSED', status: 422 }, // policy refusals
  { suffix: '_BLOCKED', status: 403 }, // audited blockers (escalation, consent)
  { suffix: '_NO_CONSENT', status: 403 }, // COMMS_SEND_BLOCKED_NO_CONSENT
  { suffix: '_INVALID', status: 400 },
  { suffix: '_REQUIRED', status: 400 },
  { suffix: '_MALFORMED', status: 400 },
  { suffix: '_MISSING', status: 400 },
  { suffix: '_UNKNOWN', status: 400 },
  { suffix: '_TOO_SHORT', status: 400 },
  { suffix: '_TOO_LONG', status: 400 },
  { suffix: '_EMPTY', status: 400 },
  { suffix: '_BLANK', status: 400 },
  { suffix: '_ZERO', status: 400 },
  { suffix: '_UNPARSEABLE', status: 400 },
  { suffix: '_INSECURE', status: 400 },
];

/**
 * Map a stable domain/transport code to its HTTP status. Deterministic;
 * unmapped codes → 500 (fail closed, never leak).
 */
export function statusForCode(code: string): number {
  const exact = EXACT_STATUS[code];
  if (exact !== undefined) return exact;
  for (const rule of PREFIX_STATUS) {
    if (code.startsWith(rule.prefix)) return rule.status;
  }
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.includes('_NOT_')) return 409; // *_NOT_ACTIVE / _NOT_HELD / _NOT_DUE … state conflicts
  for (const rule of SUFFIX_STATUS) {
    if (code.endsWith(rule.suffix)) return rule.status;
  }
  return 500;
}

/** A `DomainError` mapped onto the wire — `internal` errors stay generic. */
export interface MappedError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** True when the code was unmapped — the original error must go to the sink. */
  readonly internal: boolean;
}

export const mapDomainError = (error: DomainError): MappedError => {
  const status = statusForCode(error.code);
  if (status >= 500) {
    return { status: 500, code: HTTP_INTERNAL_ERROR, message: 'internal server error', internal: true };
  }
  return { status, code: error.code, message: error.message, internal: false };
};

/** The §38 error envelope. */
export const errorBody = (
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string }; requestId: string } => ({
  error: { code, message },
  requestId,
});
