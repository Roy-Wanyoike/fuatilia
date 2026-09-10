/**
 * Session-cookie contract (documented in frontend/README.md, "Auth at the
 * seam").
 *
 * The API contract authenticates protected operations with
 * `Authorization: Bearer <sessionToken>` where the token IS the auth-lane
 * session id (bearerSession scheme, "opaque session UUID" — spec
 * components.securitySchemes.bearerSession).
 *
 * Browser contract: that session id lives in an HTTP-only cookie
 * (`fuatilia_session`, SameSite=Strict per issue #133, Secure in production,
 * Path=/). It is NEVER stored in localStorage/sessionStorage and never
 * readable from client JS. Server-side surfaces (middleware gate,
 * dashboard layout gate, BFF proxy) read it and relay it as the Bearer
 * header. SameSite=Strict is the tightest correct policy for a
 * cross-site-needless console (issue #133's cookie AC — it supersedes the
 * earlier Lax note in the README, which still describes the pre-cookie
 * stub).
 *
 * SEAM (issue #133): the mounted /v1 surface exposes session revocation
 * (POST /v1/auth/sessions/revocations) but NO session-issuance (login)
 * operation yet. The sign-in route therefore accepts the
 * administrator-issued session credential (the opaque session id itself),
 * validates it against a live protected operation (lib/auth/validate.ts)
 * and only then holds it in this cookie — no issuance endpoint is invented.
 *
 * Pure Web-standard string handling so it is testable without the Next
 * runtime (mirror of lib/portal/session.ts discipline).
 */

export const SESSION_COOKIE_NAME = 'fuatilia_session';

/**
 * Upper bound for the cookie lifetime. The upstream auth lane enforces its
 * own idle/absolute session expiry; 401 envelopes surface when it does.
 */
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** True when the value looks like the contract's opaque session UUID. */
export function looksLikeSessionToken(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Extract the session token from a raw Cookie header (or null). */
export function readSessionTokenFromCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (cookieHeader === null || cookieHeader === undefined || cookieHeader === '') {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === SESSION_COOKIE_NAME && value.length > 0) {
      return value;
    }
  }
  return null;
}

export interface SessionCookieOptions {
  /** `Secure` in production (HTTPS-only transport). */
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * Serialize the `Set-Cookie` value for a validated collector session. The
 * token is an opaque UUID (guarded by looksLikeSessionToken before this is
 * ever called), so no value-encoding is required — and the shape guard is
 * what makes that safe. Flags: HttpOnly (never readable from browser JS),
 * SameSite=Strict (issue #133), Path=/, bounded Max-Age, Secure in
 * production.
 */
export function sessionCookie(token: string, options: SessionCookieOptions): string {
  const maxAge = options.maxAgeSeconds ?? SESSION_MAX_AGE_SECONDS;
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie` value that expires the session cookie immediately. */
export function clearedSessionCookie(options: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
