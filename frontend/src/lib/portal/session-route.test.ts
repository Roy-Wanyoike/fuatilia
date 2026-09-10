import { describe, expect, it, vi } from 'vitest';
import {
  handleSessionDelete,
  handleSessionPost,
  type SessionRouteDeps,
} from '@/lib/portal/session-route';
import { PORTAL_SESSION_COOKIE_NAME } from '@/lib/portal/session';

// =============================================================================
// PORTAL SESSION ROUTE (issue #86): POST validates the pasted code against
// the live API and ONLY THEN sets the httpOnly SameSite=Strict cookie; a
// refused code never yields a cookie. Failures are contract envelopes.
// =============================================================================

const CODE = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://portal.test/api/portal/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function depsWith(
  outcome: { ok: true } | { ok: false; status: number; code: string; message: string },
  captured: { code?: string } = {},
  overrides: Partial<SessionRouteDeps> = {},
): SessionRouteDeps {
  return {
    apiBase: 'http://api.test',
    requestIdGenerator: () => 'session-route-rid-1',
    validate: async (deps) => {
      captured.code = deps.code;
      if (outcome.ok) return { tag: 'accepted' };
      return {
        tag: 'refused',
        status: outcome.status,
        code: outcome.code,
        message: outcome.message,
        requestId: 'upstream-rid-1',
      };
    },
    ...overrides,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/portal/session', () => {
  it('sets the httpOnly SameSite=Strict cookie when the API accepts the code', async () => {
    const response = await handleSessionPost(
      postRequest({ code: CODE }),
      depsWith({ ok: true }, {}, { secureCookie: false }),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PORTAL_SESSION_COOKIE_NAME}=${CODE}`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).not.toContain('Secure');
    const body = await readJson(response);
    expect(body).toEqual({ data: { accepted: true } });
    expect(response.headers.get('x-request-id')).toBe('session-route-rid-1');
  });

  it('adds the Secure cookie flag for production deployments', async () => {
    const response = await handleSessionPost(
      postRequest({ code: CODE }),
      depsWith({ ok: true }, {}, { secureCookie: true }),
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('relays the API refusal envelope and sets NO cookie when the code is rejected', async () => {
    const response = await handleSessionPost(
      postRequest({ code: 'wrong-code' }),
      depsWith({ ok: false, status: 401, code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' }),
    );

    expect(response.status).toBe(401);
    const body = await readJson(response);
    expect(body.error).toEqual({ code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' });
    expect(body.requestId).toBe('upstream-rid-1');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses 403 envelopes the same way (authenticated but not authorized)', async () => {
    const response = await handleSessionPost(
      postRequest({ code: CODE }),
      depsWith({ ok: false, status: 403, code: 'AUTH_ACCESS_DENIED', message: 'deny by default' }),
    );
    expect(response.status).toBe(403);
    const body = await readJson(response);
    expect((body.error as { code: string }).code).toBe('AUTH_ACCESS_DENIED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fails closed with a 500 envelope when the API is unreachable — no cookie, no fake acceptance', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps: SessionRouteDeps = {
        apiBase: 'http://api.test',
        validate: async () => ({ tag: 'transport', message: 'the API could not be reached: boom' }),
        requestIdGenerator: () => 'session-route-rid-1',
      };
      const response = await handleSessionPost(postRequest({ code: CODE }), deps);
      expect(response.status).toBe(500);
      const body = await readJson(response);
      expect((body.error as { code: string }).code).toBe('HTTP_INTERNAL_ERROR');
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('answers 400 contract envelopes for malformed or blank bodies', async () => {
    const malformed = await handleSessionPost(
      postRequest('not-json'),
      depsWith({ ok: true }),
    );
    expect(malformed.status).toBe(400);
    expect((await readJson(malformed)).error).toMatchObject({ code: 'HTTP_BODY_MALFORMED' });

    const blank = await handleSessionPost(postRequest({ code: '   ' }), depsWith({ ok: true }));
    expect(blank.status).toBe(400);
    expect((await readJson(blank)).error).toMatchObject({ code: 'HTTP_BODY_INVALID' });

    const missing = await handleSessionPost(postRequest({}), depsWith({ ok: true }));
    expect(missing.status).toBe(400);
    expect((await readJson(missing)).error).toMatchObject({ code: 'HTTP_BODY_INVALID' });
  });

  it('answers 413 for an oversized body before parsing (streamed body without content-length)', async () => {
    const response = await handleSessionPost(
      postRequest({ code: `x${CODE}`, pad: 'y'.repeat(5000) }),
      depsWith({ ok: true }),
    );
    expect(response.status).toBe(413);
    expect((await readJson(response)).error).toMatchObject({ code: 'HTTP_PAYLOAD_TOO_LARGE' });
  });

  it('fails closed with the generic 500 envelope when API_BASE_URL is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handleSessionPost(
        postRequest({ code: CODE }),
        depsWith({ ok: true }, {}, { apiBase: '' }),
      );
      expect(response.status).toBe(500);
      expect((await readJson(response)).error).toMatchObject({ code: 'HTTP_INTERNAL_ERROR' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('DELETE /api/portal/session', () => {
  it('expires the cookie with the same hardened flags', async () => {
    const response = await handleSessionDelete(
      depsWith({ ok: true }, {}, { secureCookie: true }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${PORTAL_SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Secure');
    expect(await readJson(response)).toEqual({ data: { signedOut: true } });
  });
});
