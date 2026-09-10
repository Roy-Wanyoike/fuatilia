import { contractInternalError } from '@/lib/server/forward';
import {
  clearedSessionCookie,
  looksLikeSessionToken,
  sessionCookie,
  type SessionCookieOptions,
} from '@/lib/auth/session';
import {
  validateSessionCredential,
  type ValidateSessionCredentialDeps,
} from '@/lib/auth/validate';

/**
 * Pure logic for the collector session route (app/(auth)/api/auth/session —
 * issue #133).
 *
 * POST — the sign-in gate: takes the administrator-issued session
 * credential from the JSON request BODY (never a query string), validates
 * it against the live API, and on success sets the httpOnly
 * SameSite=Strict session cookie. On refusal it relays the API's contract
 * envelope (status, code, requestId) so the sign-in screen renders the
 * exact refusal. No cookie is ever set for a credential the API refused.
 *
 * DELETE — sign-out: expires the cookie.
 *
 * Envelope discipline (contract rule): successes are `{ data, ... }`,
 * failures are `{ error: { code, message }, requestId }`, every response
 * carries `x-request-id`.
 *
 * SEAM (honest, disclosed in the screen): the /v1 contract mounts no
 * session-issuance operation, so the credential pasted here IS the
 * bearerSession token (an opaque session UUID) — issued out-of-band by the
 * auth admin lane. The shape guard + live validation are what make that
 * safe; nothing is invented beyond the mounted surface.
 */

export interface SessionRouteDeps {
  /** Upstream API origin. Empty string ⇒ fail closed (500 envelope). */
  apiBase: string;
  fetchImpl?: typeof fetch;
  /** Cookie `Secure` flag — true in production. */
  secureCookie?: boolean;
  requestIdGenerator?: () => string;
  /** Overridable validator (tests inject a stub; production uses the real one). */
  validate?: typeof validateSessionCredential;
}

/** Request bodies are tiny JSON; anything larger is refused before parsing. */
const MAX_BODY_BYTES = 4096;

function generateRequestId(deps: SessionRouteDeps): string {
  return (
    deps.requestIdGenerator?.() ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `auth-session-${Date.now()}`)
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

/** Shape of the JSON body the gate posts: `{ sessionToken: "<session id>" }`. */
interface SignInBody {
  sessionToken?: unknown;
}

export async function handleSignInPost(
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
      'request body must be JSON of the shape { "sessionToken": "<session id>" }',
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

  let parsed: SignInBody | null;
  try {
    parsed = JSON.parse(rawBody) as SignInBody | null;
  } catch {
    return errorEnvelope(
      requestId,
      'HTTP_BODY_MALFORMED',
      'request body must be JSON of the shape { "sessionToken": "<session id>" }',
      400,
    );
  }

  const sessionToken = typeof parsed?.sessionToken === 'string' ? parsed.sessionToken.trim() : '';
  // Shape guard BEFORE any network call: only a credential shaped like the
  // contract's opaque session UUID may proceed toward the cookie. Anything
  // else (passwords, API keys, junk) is a 400 — the bearerSession scheme
  // has exactly one acceptable shape.
  if (!looksLikeSessionToken(sessionToken)) {
    return errorEnvelope(
      requestId,
      'HTTP_BODY_INVALID',
      'sessionToken must be the opaque session id issued by your Fuatilia administrator (a UUID)',
      400,
    );
  }

  const validate = deps.validate ?? validateSessionCredential;
  const validationDeps: ValidateSessionCredentialDeps = {
    apiBase: deps.apiBase,
    sessionToken,
    fetchImpl: deps.fetchImpl,
  };
  const outcome = await validate(validationDeps);

  if (outcome.tag === 'accepted') {
    // Defense in depth: the API accepted the credential; re-assert the
    // shape before it enters a cookie.
    if (!looksLikeSessionToken(sessionToken)) {
      return contractInternalError(
        new Error('validated credential did not match the session-id shape'),
      );
    }
    const cookieOptions: SessionCookieOptions = { secure: deps.secureCookie ?? false };
    return jsonEnvelopeResponse(
      200,
      { data: { accepted: true } },
      requestId,
      { 'set-cookie': sessionCookie(sessionToken, cookieOptions) },
    );
  }

  if (outcome.tag === 'refused') {
    // Relay the API's exact refusal (status + code + requestId when the
    // envelope was parseable) — the sign-in screen renders it, nothing is
    // papered over. A refused credential NEVER yields a cookie.
    return jsonEnvelopeResponse(
      outcome.status,
      {
        error: {
          code: outcome.code ?? 'HTTP_UNAUTHENTICATED',
          message:
            outcome.message ??
            'the session credential was not accepted — request a fresh session from your Fuatilia administrator',
        },
        requestId: outcome.requestId ?? requestId,
      },
      outcome.requestId ?? requestId,
    );
  }

  // Transport failure reaching the API — honest 500, cause logged only.
  return contractInternalError(new Error(outcome.message));
}

export async function handleSignOutDelete(deps: SessionRouteDeps): Promise<Response> {
  const requestId = generateRequestId(deps);
  const cookieOptions: SessionCookieOptions = { secure: deps.secureCookie ?? false };
  return jsonEnvelopeResponse(
    200,
    { data: { signedOut: true } },
    requestId,
    { 'set-cookie': clearedSessionCookie(cookieOptions) },
  );
}
