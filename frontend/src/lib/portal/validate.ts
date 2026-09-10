/**
 * Portal access-code validation against the LIVE API (issue #86).
 *
 * The payer pastes the access code once at the gate; this module checks it
 * against a real protected /v1 operation before any cookie is set. The
 * validation call is `GET /v1/receivables?limit=1` with
 * `Authorization: Bearer <code>` — the smallest mounted operation the portal
 * itself needs (permission `receivables:read`). The API is the ONLY
 * authority: there is no local allowlist, no seeded demo value, no shape
 * shortcut that could let an unvalidated code onto the portal.
 *
 * Outcomes are TAGGED VALUES (refusal-as-value house rule — this module
 * never throws for expected outcomes):
 *   - `accepted`  — the live API answered 200 (the credential is live);
 *   - `refused`   — the live API answered 4xx/5xx; the contract envelope's
 *                   code/message/requestId are carried through so the gate
 *                   can render the exact refusal;
 *   - `transport` — the API could not be reached; the gate renders an honest
 *                   unreachable state (never a fake acceptance).
 *
 * The code travels in the Authorization header ONLY — never in a URL, never
 * in browser storage, never back to client JS after validation.
 */

export type PortalAccessOutcome =
  | { tag: 'accepted' }
  | {
      tag: 'refused';
      status: number;
      /** Contract error code when the API answered with a parseable envelope. */
      code: string | null;
      message: string | null;
      requestId: string | null;
    }
  | { tag: 'transport'; message: string };

export interface ValidatePortalAccessDeps {
  apiBase: string;
  code: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Probe path + query — visible constants so the wire shape is auditable. */
export const PORTAL_VALIDATION_PATH = '/v1/receivables?limit=1';

export async function validatePortalAccess(
  deps: ValidatePortalAccessDeps,
): Promise<PortalAccessOutcome> {
  const url = `${deps.apiBase.replace(/\/+$/, '')}${PORTAL_VALIDATION_PATH}`;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let response: Response;
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${deps.code}`,
      },
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(timeoutMs);
    }
    response = await (deps.fetchImpl ?? fetch)(url, init);
  } catch (error: unknown) {
    const isTimeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      tag: 'transport',
      message: isTimeout
        ? `the API did not answer within ${timeoutMs}ms`
        : `the API could not be reached: ${describeError(error)}`,
    };
  }

  if (response.ok) {
    return { tag: 'accepted' };
  }

  // Parse the contract error envelope leniently — the gate wants the code +
  // requestId when the API sent one, but must not throw when it did not.
  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  const envelope = (
    parsed as { error?: { code?: unknown; message?: unknown }; requestId?: unknown } | null
  )?.error;
  return {
    tag: 'refused',
    status: response.status,
    code: typeof envelope?.code === 'string' ? envelope.code : null,
    message: typeof envelope?.message === 'string' ? envelope.message : null,
    requestId: typeof (parsed as { requestId?: unknown } | null)?.requestId === 'string'
      ? (parsed as { requestId: string }).requestId
      : null,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
