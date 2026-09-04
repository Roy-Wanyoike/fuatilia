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
 * (`fuatilia_session`, SameSite=Lax, Secure in production, Path=/). It is
 * NEVER stored in localStorage/sessionStorage and never readable from
 * client JS. Server-side surfaces (dashboard layout gate, BFF proxy) read
 * it and relay it as the Bearer header.
 *
 * STUB AT THE SEAM: the mounted /v1 surface exposes session revocation
 * (POST /v1/auth/sessions/revocations) but NO session-issuance (login)
 * operation yet — session creation lands with the backend lane's auth
 * wiring. Until then this module can only enforce the cookie CONTRACT
 * (presence + shape); it cannot validate the session against the backend.
 * That gap is disclosed in the README and the sign-in screen.
 */

export const SESSION_COOKIE_NAME = 'fuatilia_session';

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
