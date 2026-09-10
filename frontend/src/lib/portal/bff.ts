import {
  contractInternalError,
  contractUnauthorized,
} from '@/lib/server/forward';
import { readPortalSessionFromCookieHeader } from '@/lib/portal/session';

/**
 * The PORTAL same-origin BFF forwarder (issue #86) — the dedicated relay for
 * the payer portal. app/(portal)/api/portal/v1/[...path]/route.ts adapts this
 * to Next route handlers; the logic itself is pure Web-standard
 * Request/Response so it is testable without the Next runtime (mirror of
 * lib/server/forward.ts, which serves the dashboard's own /api/v1 relay).
 *
 * It relays browser calls to the API host attaching
 * `Authorization: Bearer <portal access code>` from the httpOnly
 * SameSite=Strict `fuatilia_portal_session` cookie — the credential never
 * enters browser JS. When the cookie is absent the browser gets a
 * contract-shaped 401 envelope (the API's own Unauthorized example) instead
 * of a header-less upstream call.
 */

export interface PortalForwardDeps {
  /** Upstream API origin, e.g. http://localhost:3000 (server env var). */
  apiBase: string;
  fetchImpl?: typeof fetch;
  requestIdGenerator?: () => string;
}

/** Headers we pass through to the upstream API. */
const PASSTHROUGH_HEADERS = new Set(['content-type', 'accept', 'x-request-id', 'x-correlation-id']);

/** Headers we never send upstream (hop-by-hop / browser-controlled). */
const STRIPPED_HEADERS = new Set(['cookie', 'connection', 'host', 'content-length']);

export async function forwardPortalRequest(
  request: Request,
  deps: PortalForwardDeps,
): Promise<Response> {
  const incomingUrl = new URL(request.url);
  // The portal relay catches /api/portal/v1/*; the upstream path is /v1/*.
  const suffix = incomingUrl.pathname.replace(/^\/api\/portal\/v1/, '') || '/';
  const upstreamUrl = `${deps.apiBase.replace(/\/+$/, '')}/v1${suffix}${incomingUrl.search}`;

  const token = readPortalSessionFromCookieHeader(request.headers.get('cookie'));
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
  // The credential is attached SERVER-SIDE only — it never transits browser
  // JS, never appears in any URL, and the browser's Cookie header is stripped.
  headers.set('Authorization', `Bearer ${token}`);
  if (!headers.has('x-request-id') && !headers.has('x-correlation-id')) {
    const generate =
      deps.requestIdGenerator ??
      (() =>
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `portal-bff-${Date.now()}`);
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

export { contractInternalError, contractUnauthorized };
