import { describe, expect, it } from 'vitest';
import {
  clearedPortalSessionCookie,
  looksLikePortalSessionToken,
  PORTAL_SESSION_COOKIE_NAME,
  PORTAL_SESSION_MAX_AGE_SECONDS,
  portalSessionCookie,
  readPortalSessionFromCookieHeader,
} from '@/lib/portal/session';

// =============================================================================
// PORTAL SESSION COOKIE CONTRACT (issue #86):
//   - httpOnly + SameSite=Strict + Path=/ (+ Secure in production);
//   - token never encoded anywhere else — the cookie is the ONLY carrier;
//   - parsing is exact (multi-cookie headers, wrong name, empties).
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

describe('portal session cookie serialization', () => {
  it('sets HttpOnly and SameSite=Strict with Path=/ and a bounded Max-Age', () => {
    const cookie = portalSessionCookie(TOKEN, { secure: false });
    const attributes = cookie.split(';').map((part) => part.trim());
    expect(attributes).toContain(`${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`);
    expect(attributes).toContain('HttpOnly');
    expect(attributes).toContain('SameSite=Strict');
    expect(attributes).toContain('Path=/');
    expect(attributes).toContain(`Max-Age=${PORTAL_SESSION_MAX_AGE_SECONDS}`);
  });

  it('adds Secure only when the deployment is secure (production)', () => {
    expect(portalSessionCookie(TOKEN, { secure: true })).toContain('; Secure');
    expect(portalSessionCookie(TOKEN, { secure: false })).not.toContain('Secure');
  });

  it('allows the lifetime bound to be tightened but never removes the Max-Age', () => {
    const cookie = portalSessionCookie(TOKEN, { secure: true, maxAgeSeconds: 600 });
    expect(cookie).toContain('Max-Age=600');
  });

  it('expires the cookie cleanly on sign-out while keeping the flags', () => {
    const cookie = clearedPortalSessionCookie({ secure: true });
    expect(cookie).toContain(`${PORTAL_SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(cookie).toContain('Secure');
  });
});

describe('portal session token shape guard', () => {
  it('accepts the contract opaque session UUID shape', () => {
    expect(looksLikePortalSessionToken(TOKEN)).toBe(true);
    expect(looksLikePortalSessionToken('6B8C9D0E-1F2A-4B3C-8D4E-5F60718293A4')).toBe(true);
  });

  it('rejects anything else — injection attempts, empties, nullish values', () => {
    expect(looksLikePortalSessionToken('abc')).toBe(false);
    expect(looksLikePortalSessionToken('')).toBe(false);
    expect(looksLikePortalSessionToken(`${TOKEN}; Path=/evil`)).toBe(false);
    expect(looksLikePortalSessionToken(null)).toBe(false);
    expect(looksLikePortalSessionToken(undefined)).toBe(false);
  });
});

describe('portal session cookie parsing', () => {
  it('reads the token from a multi-cookie header', () => {
    const header = `other=1; ${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}; third=3`;
    expect(readPortalSessionFromCookieHeader(header)).toBe(TOKEN);
  });

  it('returns null for absent, empty, or wrong-name cookies', () => {
    expect(readPortalSessionFromCookieHeader(null)).toBeNull();
    expect(readPortalSessionFromCookieHeader('')).toBeNull();
    expect(readPortalSessionFromCookieHeader('fuatilia_session=some-dashboard-token')).toBeNull();
    expect(readPortalSessionFromCookieHeader(`${PORTAL_SESSION_COOKIE_NAME}=`)).toBeNull();
  });

  it('never confuses the portal cookie with the dashboard session cookie', () => {
    const header = `fuatilia_session=dashboard-only-value`;
    expect(readPortalSessionFromCookieHeader(header)).toBeNull();
  });
});
