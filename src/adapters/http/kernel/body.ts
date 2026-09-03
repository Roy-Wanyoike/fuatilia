/**
 * Request body + request-id resolution (issue #55, SPEC §38 "Idempotency /
 * Request IDs").
 *
 * Body: the kernel accepts DECODED UTF-8 JSON. A payload over the injected
 * byte limit is refused with 413 `HTTP_PAYLOAD_TOO_LARGE` (the boundary is
 * INCLUSIVE-at-refusal: exactly `maxBytes` passes, one byte more refuses);
 * unparseable JSON is 400 `HTTP_BODY_MALFORMED`. Byte length is computed
 * UTF-8-aware without pulling in node globals, so the kernel stays pure and
 * handler-testable.
 *
 * Request ids: an incoming `x-request-id` (preferred) or `x-correlation-id`
 * is accepted when it is a sane opaque token (`[A-Za-z0-9._-]`, ≤128 chars —
 * anything else could smuggle header/log injection), otherwise the kernel
 * generates one via the injected id port. The id is echoed on EVERY response.
 */

export const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** UTF-8 byte length of a string (surrogate-aware), no node globals. */
export const utf8ByteLength = (text: string): number => {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else {
      bytes += 4;
      i++; // surrogate pair — counts as one character
    }
  }
  return bytes;
};

export type BodyParseResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly code: 'HTTP_PAYLOAD_TOO_LARGE' | 'HTTP_BODY_MALFORMED'; readonly message: string };

/** Parse the raw JSON body (undefined/'' = no body). Never throws. */
export function parseRequestBody(rawBody: string | undefined, maxBytes: number): BodyParseResult {
  if (rawBody === undefined || rawBody === '') return { ok: true, body: undefined };
  const bytes = utf8ByteLength(rawBody);
  if (bytes > maxBytes) {
    return {
      ok: false,
      code: 'HTTP_PAYLOAD_TOO_LARGE',
      message: `request body is ${bytes} bytes — the limit is ${maxBytes}`,
    };
  }
  try {
    return { ok: true, body: JSON.parse(rawBody) as unknown };
  } catch {
    return { ok: false, code: 'HTTP_BODY_MALFORMED', message: 'request body is not valid JSON' };
  }
}

// --- request ids -----------------------------------------------------------------

export const REQUEST_ID_HEADER = 'x-request-id';
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/** Sane opaque token: no whitespace/control chars, bounded length. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._-]{1,128}$/;

export type HeaderMap = Readonly<Record<string, string>>;

/**
 * Accept-or-generate: `x-request-id` wins over `x-correlation-id`; an
 * ill-formed or blank header value is IGNORED (not echoed) and regenerated.
 */
export function resolveRequestId(headers: HeaderMap, idGen: () => string): string {
  const candidate = headers[REQUEST_ID_HEADER] ?? headers[CORRELATION_ID_HEADER];
  if (candidate !== undefined && REQUEST_ID_SHAPE.test(candidate)) return candidate;
  return idGen();
}

/** Lowercase all header names (last value wins on case-collisions). */
export function normalizeHeaders(headers: HeaderMap | undefined): HeaderMap {
  const normalized: Record<string, string> = {};
  if (!headers) return normalized;
  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}
