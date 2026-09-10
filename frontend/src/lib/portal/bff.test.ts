import { describe, expect, it } from 'vitest';
import { forwardPortalRequest, type PortalForwardDeps } from '@/lib/portal/bff';
import { PORTAL_SESSION_COOKIE_NAME } from '@/lib/portal/session';

// =============================================================================
// PORTAL BFF RELAY (issue #86):
//   - the access code is attached as `Authorization: Bearer …` SERVER-SIDE
//     from the httpOnly cookie — it must NEVER appear in a URL;
//   - the browser's Cookie header is stripped upstream;
//   - a missing cookie answers the contract's 401 envelope, not a
//     header-less upstream call;
//   - upstream statuses/bodies pass through; hop-by-hop headers do not.
// =============================================================================

const TOKEN = '0f1e2d3c-4b5a-4968-8776-6554433221ff';

function portalRequest(
  url: string,
  { method = 'GET', cookie }: { method?: string; cookie?: string } = {},
): Request {
  return new Request(url, {
    method,
    headers: cookie === undefined ? {} : { cookie },
  });
}

function depsWith(upstream: Response, captured: { url?: string; init?: RequestInit } = {}) {
  const deps: PortalForwardDeps = {
    apiBase: 'http://api.test',
    fetchImpl: async (input, init) => {
      captured.url = String(input);
      captured.init = init;
      return upstream;
    },
    requestIdGenerator: () => 'portal-bff-rid-1',
  };
  return deps;
}

describe('portal BFF relay', () => {
  it('relays to /v1 with the Bearer credential attached server-side from the cookie', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const upstream = new Response(JSON.stringify({ data: { receivables: [] } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const response = await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/receivables?limit=20&sort=dueDate', {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`,
      }),
      depsWith(upstream, captured),
    );

    expect(captured.url).toBe('http://api.test/v1/receivables?limit=20&sort=dueDate');
    const headers = new Headers(captured.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
  });

  it('never places the token in the upstream URL', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const upstream = new Response(null, { status: 200 });
    await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/payments', {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`,
      }),
      depsWith(upstream, captured),
    );
    expect(captured.url).toBeDefined();
    expect(captured.url).not.toContain(TOKEN);
    expect(captured.url).not.toContain('access');
    expect(captured.url).not.toContain('token');
  });

  it('strips the browser Cookie header upstream (the credential rides the Authorization header only)', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const upstream = new Response(null, { status: 200 });
    await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/receivables', {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}; other=value`,
      }),
      depsWith(upstream, captured),
    );
    const headers = new Headers(captured.init?.headers);
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('answers a contract-shaped 401 envelope when the cookie is absent (fail closed)', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const deps: PortalForwardDeps = {
      apiBase: 'http://api.test',
      fetchImpl: async (input, init) => {
        captured.url = String(input);
        captured.init = init;
        return new Response(null, { status: 200 });
      },
    };
    const response = await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/receivables'),
      deps,
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: { code: string; message: string };
      requestId: string;
    };
    expect(body.error.code).toBe('HTTP_UNAUTHENTICATED');
    expect(body.requestId).toBeTruthy();
    // Nothing was sent upstream — no credential, no call.
    expect(captured.url).toBeUndefined();
  });

  it('passes upstream status and body through while dropping hop-by-hop headers', async () => {
    const upstream = new Response(JSON.stringify({ error: { code: 'AUTH_ACCESS_DENIED', message: 'denied' }, requestId: 'rid-9' }), {
      status: 403,
      headers: {
        'content-type': 'application/json',
        'content-length': '86',
        'transfer-encoding': 'chunked',
        'x-request-id': 'rid-9',
      },
    });
    const response = await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/receivables', {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`,
      }),
      depsWith(upstream),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('x-request-id')).toBe('rid-9');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('transfer-encoding')).toBeNull();
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_ACCESS_DENIED');
  });

  it('injects an x-request-id when the browser did not supply one', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const upstream = new Response(null, { status: 200 });
    await forwardPortalRequest(
      portalRequest('http://portal.test/api/portal/v1/payments', {
        cookie: `${PORTAL_SESSION_COOKIE_NAME}=${TOKEN}`,
      }),
      depsWith(upstream, captured),
    );
    const headers = new Headers(captured.init?.headers);
    expect(headers.get('x-request-id')).toBe('portal-bff-rid-1');
  });
});
