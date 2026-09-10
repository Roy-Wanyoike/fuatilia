import {
  looksLikeSessionToken,
  readSessionTokenFromCookieHeader,
} from '@/lib/auth/session';

/**
 * (dashboard) middleware gate — pure logic (issue #133).
 *
 * Dashboard routes are credential-gated at the EDGE: a request without a
 * session cookie shaped like the contract's opaque session UUID is
 * redirected to the sign-in screen with a `next` hint (the requested PATH
 * only — never a token, never a full external URL). The dashboard layout
 * gate (app/(dashboard)/layout.tsx) stays in place as defense in depth: it
 * renders the designed refused screen (`SignInRequired`) whenever a request
 * reaches it without a valid session, so the refusal is a rendered state,
 * not just a redirect.
 *
 * Cookie presence + shape is the middleware's check because it is the only
 * check that is safe without a network round-trip on the edge. Liveness
 * (expiry/revocation) is enforced by the API itself: every protected read
 * goes through the BFF (lib/server/forward.ts) and 401 envelopes
 * (`SESSION_IDLE_EXPIRED`, `SESSION_ABSOLUTE_EXPIRED`, `SESSION_REVOKED`,
 * `SESSION_ENDED`) surface in-page with their code + requestId.
 *
 * Pure Web-standard string handling so it is testable without the Next
 * runtime (mirror of lib/portal discipline).
 */

export type DashboardGateResolution =
  | { tag: 'allow' }
  | {
      tag: 'redirect';
      /** Absolute-path redirect target: /sign-in?next=<requested path>. */
      location: string;
    };

/**
 * Resolve the gate for a dashboard-route request. `requestPath` must be a
 * relative path (as taken from the incoming request URL); any query or
 * fragment that somehow reaches this function is stripped — the hint
 * carries the requested PATH only.
 */
export function resolveDashboardGate(
  cookieHeader: string | null | undefined,
  requestPath: string,
): DashboardGateResolution {
  const token = readSessionTokenFromCookieHeader(cookieHeader);
  if (token !== null && looksLikeSessionToken(token)) {
    return { tag: 'allow' };
  }
  const pathOnly = requestPath.split(/[?#]/, 1)[0] ?? requestPath;
  // The hint carries the requested PATH only — a credential never travels
  // in a URL, and neither does anything else from the request.
  const location = isRelativePath(pathOnly)
    ? `/sign-in?next=${encodeURIComponent(pathOnly)}`
    : '/sign-in';
  return { tag: 'redirect', location };
}

/**
 * Sanitize a `next` hint from the URL before the browser navigates to it:
 * only a same-origin relative path (starts with `/`, not protocol-relative
 * `//`, no backslashes, no scheme) is honored; anything else falls back to
 * the dashboard root. This keeps the redirect hint from becoming an
 * open-redirect — and no credential ever rides in it either way.
 */
export function safeNextPath(raw: string | null | undefined, fallback = '/'): string {
  if (raw === null || raw === undefined) return fallback;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return fallback;
  }
  if (!isRelativePath(decoded)) return fallback;
  return decoded;
}

function isRelativePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.startsWith('/\\') &&
    !value.includes('\\') &&
    !value.includes('://')
  );
}
