/**
 * Portal session-cookie contract (issue #86).
 *
 * The payer portal's credential is a portal access code — an auth-lane
 * session credential (the same bearerSession scheme the dashboard uses:
 * `Authorization: Bearer <sessionToken>`, spec
 * components.securitySchemes.bearerSession). The payer pastes it ONCE at the
 * gate; the server validates it against the live API and then holds it in an
 * HTTP-only cookie. From then on the dedicated portal BFF
 * (app/(portal)/api/portal/v1/[...path]) relays it as the Bearer header
 * server-side.
 *
 * Cookie contract:
 *   - name `fuatilia_portal_session` (deliberately distinct from the
 *     dashboard's `fuatilia_session` — the two surfaces never share a
 *     credential);
 *   - `HttpOnly` — never readable from browser JS;
 *   - `SameSite=Strict` — the portal is cross-site-needless, so Strict is the
 *     tightest correct policy (the dashboard uses Lax for inbound nav);
 *   - `Secure` in production; `Path=/`; `Max-Age` bounded at 8 h — an upper
 *     bound only, the upstream session can expire sooner (idle/absolute),
 *     which surfaces honestly as 401 envelopes in the views;
 *   - NEVER in localStorage/sessionStorage, NEVER in a URL.
 *
 * Pure Web-standard string handling so it is testable without the Next
 * runtime (mirror of lib/auth/session.ts discipline).
 */

export const PORTAL_SESSION_COOKIE_NAME = 'fuatilia_portal_session';

/**
 * Upper bound for the cookie lifetime. The upstream auth lane enforces its
 * own idle/absolute session expiry; 401 envelopes surface when it does.
 */
export const PORTAL_SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

/** True when the value looks like the contract's opaque session UUID. */
export function looksLikePortalSessionToken(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export interface PortalCookieOptions {
  /** `Secure` in production (HTTPS-only transport). */
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * Serialize the `Set-Cookie` value for a validated portal session. The token
 * is an opaque UUID (guarded by looksLikePortalSessionToken before this is
 * ever called), so no value-encoding is required — and the shape guard is
 * what makes that safe.
 */
export function portalSessionCookie(token: string, options: PortalCookieOptions): string {
  const maxAge = options.maxAgeSeconds ?? PORTAL_SESSION_MAX_AGE_SECONDS;
  const parts = [
    `${PORTAL_SESSION_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** `Set-Cookie` value that expires the portal session cookie immediately. */
export function clearedPortalSessionCookie(options: PortalCookieOptions): string {
  const parts = [
    `${PORTAL_SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Extract the portal session token from a raw Cookie header (or null). */
export function readPortalSessionFromCookieHeader(
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
    if (name === PORTAL_SESSION_COOKIE_NAME && value.length > 0) {
      return value;
    }
  }
  return null;
}
