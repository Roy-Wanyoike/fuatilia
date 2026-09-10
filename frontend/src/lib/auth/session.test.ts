import { describe, expect, it } from 'vitest';
import {
  clearedSessionCookie,
  looksLikeSessionToken,
  readSessionTokenFromCookieHeader,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
} from '@/lib/auth/session';

// =============================================================================
// SESSION COOKIE CONTRACT (issue #133): the collector's bearerSession token
// lives ONLY in an httpOnly SameSite=Strict cookie — never in browser JS,
// never in storage, never in a URL. These tests pin the serialized flags.
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

describe('looksLikeSessionToken', () => {
  it('accepts the contract shape (opaque session UUID, case-insensitive)', () => {
    expect(looksLikeSessionToken('0F1E2D3C-4B5A-4968-8776-6554433221FF')).toBe(true);
    expect(looksLikeSessionToken(TOKEN)).toBe(true);
  });

  it('refuses everything that is not the opaque session UUID', () => {
    expect(looksLikeSessionToken(null)).toBe(false);
    expect(looksLikeSessionToken(undefined)).toBe(false);
    expect(looksLikeSessionToken('')).toBe(false);
    expect(looksLikeSessionToken('password123')).toBe(false);
    expect(looksLikeSessionToken('ApiKey 1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.secret')).toBe(false);
    expect(looksLikeSessionToken(`${TOKEN}; Path=/evil`)).toBe(false);
    expect(looksLikeSessionToken('0f1e2d3c4b5a496887776554433221ff')).toBe(false);
  });
});

describe('readSessionTokenFromCookieHeader', () => {
  it('reads the session cookie from a multi-cookie header', () => {
    expect(
      readSessionTokenFromCookieHeader(`other=value; ${SESSION_COOKIE_NAME}=${TOKEN}`),
    ).toBe(TOKEN);
    expect(readSessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=${TOKEN}`)).toBe(TOKEN);
  });

  it('answers null when the cookie is absent, empty, or blank-valued', () => {
    expect(readSessionTokenFromCookieHeader(null)).toBeNull();
    expect(readSessionTokenFromCookieHeader('')).toBeNull();
    expect(readSessionTokenFromCookieHeader('other=value')).toBeNull();
    expect(readSessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=`)).toBeNull();
    expect(readSessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=   `)).toBeNull();
  });
});

describe('sessionCookie', () => {
  it('serializes the hardened flags: HttpOnly, SameSite=Strict, Path=/, bounded Max-Age', () => {
    const setCookie = sessionCookie(TOKEN, { secure: false });
    expect(setCookie).toBe(
      `${SESSION_COOKIE_NAME}=${TOKEN}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    );
  });

  it('adds Secure in production', () => {
    expect(sessionCookie(TOKEN, { secure: true })).toContain('Secure');
    expect(sessionCookie(TOKEN, { secure: false })).not.toContain('Secure');
  });

  it('honors an explicit Max-Age override (upper bound stays explicit)', () => {
    expect(sessionCookie(TOKEN, { secure: false, maxAgeSeconds: 60 })).toContain('Max-Age=60');
  });
});

describe('clearedSessionCookie', () => {
  it('expires the cookie immediately with the same hardened flags', () => {
    const setCookie = clearedSessionCookie({ secure: true });
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(setCookie).toContain('Secure');
  });
});
