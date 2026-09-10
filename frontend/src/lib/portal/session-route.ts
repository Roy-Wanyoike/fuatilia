import { contractInternalError } from '@/lib/server/forward';
import {
  clearedPortalSessionCookie,
  looksLikePortalSessionToken,
  portalSessionCookie,
  type PortalCookieOptions,
} from '@/lib/portal/session';
import { validatePortalAccess, type ValidatePortalAccessDeps } from '@/lib/portal/validate';

/**
 * Pure logic for the portal session route (app/(portal)/api/portal/session).
 *
 * POST — the gate: takes the pasted access code from the JSON request BODY
 * (never a query string), validates it against the live API, and on success
 * sets the httpOnly SameSite=Strict portal cookie. On refusal it relays the
 * API's contract envelope (status, code, requestId) so the gate renders the
 * exact refusal. No cookie is ever set for a credential the API refused.
 *
 * DELETE — sign-out: expires the cookie.
 *
 * Envelope discipline (contract rule): successes are `{ data, ... }`,
 * failures are `{ error: { code, message }, requestId }`, every response
 * carries `x-request-id`.
 */

export interface SessionRouteDeps {
  /** Upstream API origin. Empty string ⇒ fail closed (500 envelope). */
  apiBase: string;
  fetchImpl?: typeof fetch;
  /** Cookie `Secure` flag — true in production. */
  secureCookie?: boolean;
  requestIdGenerator?: () => string;
  /** Overridable validator (tests inject a stub; production uses the real one). */
  validate?: typeof validatePortalAccess;
}

/** Request bodies are tiny JSON; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 4096;

function generateRequestId(deps: SessionRouteDeps): string {
  return (
    deps.requestIdGenerator?.() ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `portal-session-${Date.now()}`)
  );
}

function jsonEnvelopeResponse(
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      ...extraHeaders,
    },
  });
}

function errorEnvelope(
  requestId: string,
  code: string,
  message: string,
  status: number,
): Response {
  return jsonEnvelopeResponse(
    status,
    { error: { code, message }, requestId },
    requestId,
  );
}

/** Shape of the JSON body the gate posts: `{ code: "<access code>" }`. */
interface GateBody {
  code?: unknown;
}

export async function handleSessionPost(
  request: Request,
  deps: SessionRouteDeps,
): Promise<Response> {
  if (deps.apiBase === '') {
    // Fail closed with the contract's generic 500 envelope; the real cause
    // (unset API_BASE_URL) is logged, never leaked to the wire.
    return contractInternalError(new Error('API_BASE_URL is not configured'));
  }
  const requestId = generateRequestId(deps);

  const contentLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return errorEnvelope(
      requestId,
      'HTTP_PAYLOAD_TOO_LARGE',
      `request body exceeds ${MAX_BODY_BYTES} bytes`,
      413,
    );
  }

  // Web-standard body read; the encoded byte length is the payload cap
  // check for transports that stream without a content-length header.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return errorEnvelope(
      requestId,
      'HTTP_BODY_MALFORMED',
      'request body must be JSON of the shape { "code": "<access code>" }',
      400,
    );
  }
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return errorEnvelope(
      requestId,
      'HTTP_PAYLOAD_TOO_LARGE',
      `request body exceeds ${MAX_BODY_BYTES} bytes`,
      413,
    );
  }

  let parsed: GateBody | null;
  try {
    parsed = JSON.parse(rawBody) as GateBody | null;
  } catch {
    return errorEnvelope(
      requestId,
      'HTTP_BODY_MALFORMED',
      'request body must be JSON of the shape { "code": "<access code>" }',
      400,
    );
  }

  const code = typeof parsed?.code === 'string' ? parsed.code.trim() : '';
  if (code.length === 0 || code.length > 256) {
    return errorEnvelope(
      requestId,
      'HTTP_BODY_INVALID',
      'code must be a non-empty access code (max 256 characters)',
      400,
    );
  }

  const validate = deps.validate ?? validatePortalAccess;
  const validationDeps: ValidatePortalAccessDeps = {
    apiBase: deps.apiBase,
    code,
    fetchImpl: deps.fetchImpl,
  };
  const outcome = await validate(validationDeps);

  if (outcome.tag === 'accepted') {
    // Defense in depth: the API accepted the credential; only a credential
    // shaped like the contract's opaque session UUID may enter a cookie.
    if (!looksLikePortalSessionToken(code)) {
      return contractInternalError(
        new Error('validated credential did not match the session-id shape'),
      );
    }
    const cookieOptions: PortalCookieOptions = { secure: deps.secureCookie ?? false };
    return jsonEnvelopeResponse(
      200,
      { data: { accepted: true } },
      requestId,
      { 'set-cookie': portalSessionCookie(code, cookieOptions) },
    );
  }

  if (outcome.tag === 'refused') {
    // Relay the API's exact refusal (status + code + requestId when the
    // envelope was parseable) — the gate renders it, nothing is papered over.
    return jsonEnvelopeResponse(
      outcome.status,
      {
        error: {
          code: outcome.code ?? 'HTTP_UNAUTHENTICATED',
          message:
            outcome.message ??
            'the portal access code was not accepted — request a new code from the biller',
        },
        requestId: outcome.requestId ?? requestId,
      },
      outcome.requestId ?? requestId,
    );
  }

  // Transport failure reaching the API — honest 500, cause logged only.
  return contractInternalError(new Error(outcome.message));
}

export async function handleSessionDelete(deps: SessionRouteDeps): Promise<Response> {
  const requestId = generateRequestId(deps);
  const cookieOptions: PortalCookieOptions = { secure: deps.secureCookie ?? false };
  return jsonEnvelopeResponse(
    200,
    { data: { signedOut: true } },
    requestId,
    { 'set-cookie': clearedPortalSessionCookie(cookieOptions) },
  );
}
