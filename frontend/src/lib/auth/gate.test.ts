import { describe, expect, it } from 'vitest';
import { resolveDashboardGate, safeNextPath } from '@/lib/auth/gate';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

// =============================================================================
// (dashboard) MIDDLEWARE GATE (issue #133): a dashboard request without a
// session cookie shaped like the contract's opaque session UUID is
// redirected to /sign-in with a next hint (PATH only — no token, no
// external URL). A shape-valid cookie is allowed through; liveness is the
// API's business (401 envelopes surface in-page).
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

describe('resolveDashboardGate', () => {
  it('allows a request whose session cookie is present with the contract shape', () => {
    expect(
      resolveDashboardGate(`other=value; ${SESSION_COOKIE_NAME}=${TOKEN}`, '/collections'),
    ).toEqual({ tag: 'allow' });
  });

  it('redirects to /sign-in with a next hint when the cookie is absent', () => {
    expect(resolveDashboardGate(null, '/collections')).toEqual({
      tag: 'redirect',
      location: '/sign-in?next=%2Fcollections',
    });
    expect(resolveDashboardGate(undefined, '/')).toEqual({
      tag: 'redirect',
      location: '/sign-in?next=%2F',
    });
  });

  it('redirects when the cookie value is not the opaque session-UUID shape', () => {
    expect(
      resolveDashboardGate(`${SESSION_COOKIE_NAME}=garbage`, '/payments'),
    ).toMatchObject({ tag: 'redirect' });
    expect(resolveDashboardGate(`${SESSION_COOKIE_NAME}=`, '/payments')).toMatchObject({
      tag: 'redirect',
    });
  });

  it('never places a credential or request data into the redirect location', () => {
    const resolution = resolveDashboardGate(null, '/collections?secret=1');
    expect(resolution).toMatchObject({ tag: 'redirect', location: '/sign-in?next=%2Fcollections' });
    const location = (resolution as { location: string }).location;
    expect(location).not.toContain('secret');
    expect(location).not.toContain(TOKEN);
  });

  it('redirects without a next hint for a path that is not relative', () => {
    expect(resolveDashboardGate(null, 'https://evil.test')).toEqual({
      tag: 'redirect',
      location: '/sign-in',
    });
  });
});

describe('safeNextPath', () => {
  it('honors same-origin relative paths', () => {
    expect(safeNextPath('/collections')).toBe('/collections');
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('%2Fpayments')).toBe('/payments');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath(undefined)).toBe('/');
  });

  it('falls back for protocol-relative URLs, schemes, backslashes and junk', () => {
    expect(safeNextPath('//evil.test')).toBe('/');
    expect(safeNextPath('https://evil.test/path')).toBe('/');
    expect(safeNextPath('/\\evil.test')).toBe('/');
    expect(safeNextPath('/collections\\..\\evil')).toBe('/');
    expect(safeNextPath('javascript:alert(1)')).toBe('/');
    expect(safeNextPath('%')).toBe('/'); // decodeURIComponent throws → fallback
  });

  it('honors an explicit fallback target', () => {
    expect(safeNextPath('//evil.test', '/collections')).toBe('/collections');
  });
});
