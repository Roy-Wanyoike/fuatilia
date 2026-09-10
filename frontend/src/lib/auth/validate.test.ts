import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_VALIDATION_PATH,
  validateSessionCredential,
} from '@/lib/auth/validate';

// =============================================================================
// LIVE CREDENTIAL VALIDATION (issue #133): the credential travels in the
// Authorization header ONLY — never in a URL — and the API is the sole
// authority. Outcomes are tagged values; expected refusals never throw.
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';
const API_BASE = 'http://api.test';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureFetch(
  impl: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): { calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return impl(String(url), init);
    }),
  );
  return { calls };
}

describe('validateSessionCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('probes a mounted protected operation with the credential in the Authorization header only', async () => {
    const { calls } = captureFetch(() => jsonResponse(200, { data: [] }));
    const outcome = await validateSessionCredential({ apiBase: API_BASE, sessionToken: TOKEN });

    expect(outcome).toEqual({ tag: 'accepted' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The probe is the dashboard's own landing read (receivables:read) — a
    // real mounted op, not an invented endpoint.
    expect(call.url).toBe(`${API_BASE}${SESSION_VALIDATION_PATH}`);
    expect(call.init?.method).toBe('GET');
    expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    // The credential never rides in a URL.
    expect(call.url).not.toContain(TOKEN);
  });

  it('trailing slashes on the api base do not double-slash the probe', async () => {
    const { calls } = captureFetch(() => jsonResponse(200, { data: [] }));
    await validateSessionCredential({ apiBase: `${API_BASE}/`, sessionToken: TOKEN });
    expect(calls[0]?.url).toBe(`${API_BASE}${SESSION_VALIDATION_PATH}`);
  });

  it('carries the contract refusal envelope (code, message, requestId) through', async () => {
    captureFetch(() =>
      jsonResponse(401, {
        error: { code: 'SESSION_IDLE_EXPIRED', message: 'session idle expired' },
        requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
      }),
    );
    const outcome = await validateSessionCredential({ apiBase: API_BASE, sessionToken: TOKEN });

    expect(outcome).toEqual({
      tag: 'refused',
      status: 401,
      code: 'SESSION_IDLE_EXPIRED',
      message: 'session idle expired',
      requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
    });
  });

  it('relays 403 refusals the same way (live credential, missing permission)', async () => {
    captureFetch(() =>
      jsonResponse(403, {
        error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
        requestId: 'rid-403',
      }),
    );
    const outcome = await validateSessionCredential({ apiBase: API_BASE, sessionToken: TOKEN });
    expect(outcome).toMatchObject({ tag: 'refused', status: 403, code: 'AUTH_ACCESS_DENIED' });
  });

  it('answers refused with null envelope fields when the body is not a contract envelope', async () => {
    captureFetch(() => new Response('<html>gateway</html>', { status: 502 }));
    const outcome = await validateSessionCredential({ apiBase: API_BASE, sessionToken: TOKEN });
    expect(outcome).toEqual({
      tag: 'refused',
      status: 502,
      code: null,
      message: null,
      requestId: null,
    });
  });

  it('answers transport on network failure — never a fake acceptance', async () => {
    captureFetch(() => {
      throw new TypeError('fetch failed');
    });
    const outcome = await validateSessionCredential({ apiBase: API_BASE, sessionToken: TOKEN });
    expect(outcome).toMatchObject({ tag: 'transport' });
    expect((outcome as { message: string }).message).toContain('the API could not be reached');
  });

  it('answers transport with a timeout message when the probe exceeds the deadline', async () => {
    captureFetch(() => {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    });
    const outcome = await validateSessionCredential({
      apiBase: API_BASE,
      sessionToken: TOKEN,
      timeoutMs: 5,
    });
    expect(outcome).toMatchObject({ tag: 'transport', message: 'the API did not answer within 5ms' });
  });
});
