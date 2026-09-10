import { describe, expect, it, vi } from 'vitest';
import {
  handleSignOutDelete,
  handleSignInPost,
  type SessionRouteDeps,
} from '@/lib/auth/session-route';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

// =============================================================================
// COLLECTOR SESSION ROUTE (issue #133): POST validates the pasted session
// credential against the live API and ONLY THEN sets the httpOnly
// SameSite=Strict cookie; a refused credential never yields a cookie.
// Failures are contract envelopes. Sign-out expires the cookie.
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://console.test/api/auth/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function depsWith(
  outcome: {
    ok: true;
  }
  | {
      ok: false;
      status: number;
      code: string | null;
      message: string | null;
      requestId?: string | null;
    },
  captured: { sessionToken?: string } = {},
  overrides: Partial<SessionRouteDeps> = {},
): SessionRouteDeps {
  return {
    apiBase: 'http://api.test',
    requestIdGenerator: () => 'session-route-rid-1',
    validate: async (deps) => {
      captured.sessionToken = deps.sessionToken;
      if (outcome.ok) return { tag: 'accepted' };
      return {
        tag: 'refused',
        status: outcome.status,
        code: outcome.code,
        message: outcome.message,
        requestId: outcome.requestId !== undefined ? outcome.requestId : 'upstream-rid-1',
      };
    },
    ...overrides,
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/auth/session', () => {
  it('sets the httpOnly SameSite=Strict cookie when the API accepts the credential', async () => {
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN }),
      depsWith({ ok: true }, {}, { secureCookie: false }),
    );

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${TOKEN}`);
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
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN }),
      depsWith({ ok: true }, {}, { secureCookie: true }),
    );
    expect(response.headers.get('set-cookie')).toContain('Secure');
  });

  it('relays the API refusal envelope and sets NO cookie when the credential is rejected', async () => {
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN }),
      depsWith({
        ok: false,
        status: 401,
        code: 'SESSION_IDLE_EXPIRED',
        message: 'session idle expired',
      }),
    );

    expect(response.status).toBe(401);
    const body = await readJson(response);
    expect(body.error).toEqual({ code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' });
    expect(body.requestId).toBe('upstream-rid-1');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('relays 403 refusals the same way (live credential, missing permission)', async () => {
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN }),
      depsWith({ ok: false, status: 403, code: 'AUTH_ACCESS_DENIED', message: 'deny by default' }),
    );
    expect(response.status).toBe(403);
    const body = await readJson(response);
    expect((body.error as { code: string }).code).toBe('AUTH_ACCESS_DENIED');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('falls back to the contract 401 code when the API refusal carried no parseable envelope', async () => {
    // Exactly what validateSessionCredential returns for a status-401
    // response without a contract envelope: null code/message/requestId.
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN }),
      depsWith({ ok: false, status: 401, code: null, message: null, requestId: null }),
    );
    expect(response.status).toBe(401);
    const body = await readJson(response);
    expect((body.error as { code: string }).code).toBe('HTTP_UNAUTHENTICATED');
    expect(body.requestId).toBe('session-route-rid-1');
  });

  it('fails closed with a 500 envelope when the API is unreachable — no cookie, no fake acceptance', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const deps: SessionRouteDeps = {
        apiBase: 'http://api.test',
        validate: async () => ({
          tag: 'transport',
          message: 'the API could not be reached: boom',
        }),
        requestIdGenerator: () => 'session-route-rid-1',
      };
      const response = await handleSignInPost(postRequest({ sessionToken: TOKEN }), deps);
      expect(response.status).toBe(500);
      const body = await readJson(response);
      expect((body.error as { code: string }).code).toBe('HTTP_INTERNAL_ERROR');
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('answers 400 for anything that is not the opaque session-UUID shape — before any network call', async () => {
    const captured: { sessionToken?: string } = {};
    const validate = vi.fn();
    for (const bad of ['password123', 'ApiKey abc.secret', `${TOKEN}; Path=/evil`, '', '   ']) {
      const response = await handleSignInPost(
        postRequest({ sessionToken: bad }),
        depsWith({ ok: true }, captured, { validate: validate as unknown as SessionRouteDeps['validate'] }),
      );
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: { code: 'HTTP_BODY_INVALID' } });
    }
    // The validator was never invoked — garbage never reaches the API or the cookie.
    expect(validate).not.toHaveBeenCalled();
    expect(captured.sessionToken).toBeUndefined();
  });

  it('answers 400 contract envelopes for malformed or missing bodies', async () => {
    const malformed = await handleSignInPost(postRequest('not-json'), depsWith({ ok: true }));
    expect(malformed.status).toBe(400);
    expect((await readJson(malformed)).error).toMatchObject({ code: 'HTTP_BODY_MALFORMED' });

    const missing = await handleSignInPost(postRequest({}), depsWith({ ok: true }));
    expect(missing.status).toBe(400);
    expect((await readJson(missing)).error).toMatchObject({ code: 'HTTP_BODY_INVALID' });

    const wrongType = await handleSignInPost(
      postRequest({ sessionToken: 42 }),
      depsWith({ ok: true }),
    );
    expect(wrongType.status).toBe(400);
    expect((await readJson(wrongType)).error).toMatchObject({ code: 'HTTP_BODY_INVALID' });
  });

  it('answers 413 for an oversized body before parsing (streamed body without content-length)', async () => {
    const response = await handleSignInPost(
      postRequest({ sessionToken: TOKEN, pad: 'y'.repeat(5000) }),
      depsWith({ ok: true }),
    );
    expect(response.status).toBe(413);
    expect((await readJson(response)).error).toMatchObject({ code: 'HTTP_PAYLOAD_TOO_LARGE' });
  });

  it('fails closed with the generic 500 envelope when API_BASE_URL is not configured', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await handleSignInPost(
        postRequest({ sessionToken: TOKEN }),
        depsWith({ ok: true }, {}, { apiBase: '' }),
      );
      expect(response.status).toBe(500);
      expect((await readJson(response)).error).toMatchObject({ code: 'HTTP_INTERNAL_ERROR' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('DELETE /api/auth/session', () => {
  it('expires the cookie with the same hardened flags (sign-out)', async () => {
    const response = await handleSignOutDelete(depsWith({ ok: true }, {}, { secureCookie: true }));
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('Secure');
    expect(await readJson(response)).toEqual({ data: { signedOut: true } });
  });
});
