import { readSessionTokenFromCookieHeader, SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * The same-origin BFF forwarder (app/api/v1/[...path]/route.ts adapts this
 * to Next route handlers). It relays browser calls to the API host,
 * attaching `Authorization: Bearer <sessionToken>` from the httpOnly
 * session cookie server-side — the bearer credential never enters browser
 * JS. When the cookie is absent the browser gets a contract-shaped 401
 * envelope (the API's own Unauthorized example) instead of leaking a
 * header-less call upstream.
 *
 * Pure Web-standard Request/Response so it is testable without the Next
 * runtime.
 */

export interface ForwardDeps {
  /** Upstream API origin, e.g. http://localhost:3000 (server env var). */
  apiBase: string;
  fetchImpl?: typeof fetch;
  requestIdGenerator?: () => string;
}

/** Headers we pass through to the upstream API. */
const PASSTHROUGH_HEADERS = new Set(['content-type', 'accept', 'x-request-id', 'x-correlation-id']);

/** Headers we never send upstream (hop-by-hop / browser-controlled). */
const STRIPPED_HEADERS = new Set(['cookie', 'connection', 'host', 'content-length']);

export interface ForwardOutcome {
  response: Response;
}

export async function forwardAuthenticated(
  request: Request,
  deps: ForwardDeps,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  // Route handler catches /api/v1/*; the upstream path is /v1/*.
  const suffix = incomingUrl.pathname.replace(/^\/api\/v1/, '') || '/';
  const upstreamUrl = `${deps.apiBase.replace(/\/+$/, '')}/v1${suffix}${incomingUrl.search}`;

  const token = readSessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (token === null) {
    return contractUnauthorized();
  }

  const headers = new Headers();
  for (const [name, value] of request.headers.entries()) {
    const lowered = name.toLowerCase();
    if (PASSTHROUGH_HEADERS.has(lowered) && !STRIPPED_HEADERS.has(lowered)) {
      headers.set(name, value);
    }
  }
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('x-request-id') && !headers.has('x-correlation-id')) {
    const generate =
      deps.requestIdGenerator ??
      (() =>
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `bff-${Date.now()}`);
    headers.set('x-request-id', generate());
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const upstream = await (deps.fetchImpl ?? fetch)(upstreamUrl, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
  });

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers.entries()) {
    const lowered = name.toLowerCase();
    if (lowered === 'content-length' || lowered === 'transfer-encoding') continue;
    responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** The contract's Unauthorized example, byte-shaped (spec lines 2619–2623). */
export function contractUnauthorized(requestId?: string): Response {
  const rid =
    requestId ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `bff-${Date.now()}`);
  return new Response(
    JSON.stringify({
      error: {
        code: 'HTTP_UNAUTHENTICATED',
        message:
          'authentication required — supply "Authorization: Bearer <sessionToken>" or "Authorization: ApiKey <id>.<secret>"',
      },
      requestId: rid,
    }),
    {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-request-id': rid },
    },
  );
}

/** Fail-closed proxy error — generic message, real cause logged server-side. */
export function contractInternalError(cause: unknown): Response {
  console.error('[fuatilia-bff] proxy failure:', cause);
  return new Response(
    JSON.stringify({
      error: { code: 'HTTP_INTERNAL_ERROR', message: 'internal server error' },
      requestId:
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `bff-${Date.now()}`,
    }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

export { SESSION_COOKIE_NAME };
