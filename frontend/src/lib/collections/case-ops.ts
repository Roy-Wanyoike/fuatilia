import { z } from 'zod';
import type { ApiResult, FetchLike, Refusal } from '@/lib/api/client';
import { isKnownErrorCode } from '@/lib/api/error-codes';
import { rawErrorEnvelopeSchema } from '@/lib/api/envelope';
import {
  CASE_ACTION_SOURCES,
  CASE_ACTION_TYPES,
  CASE_PRIORITIES,
  CASE_STATUSES,
  caseActionViewSchema,
  caseDetailDataSchema,
  caseViewSchema,
  type CaseActionView,
  type CaseView,
} from '@/lib/api/wire-types';

/**
 * The collections WRITE-op client — hand-derived from
 * api/openapi/fuatilia.v1.yaml §/v1/collections (spec lines 1060–1594):
 *
 *   POST /v1/collections/cases                                        → openCase (201)
 *   POST /v1/collections/cases/{caseId}/transitions                   → transitionCase (200)
 *   POST /v1/collections/cases/{caseId}/escalations                   → escalateCase (200)
 *   POST /v1/collections/cases/{caseId}/actions                       → recordCaseAction (201)
 *   POST /v1/collections/cases/{caseId}/actions/{actionId}/completions → completeCaseAction (200)
 *
 * Contract rules mirrored from the read client (lib/api/client.ts — kept
 * untouched in its own lane):
 *  - every request carries x-request-id; every response carries it back;
 *  - success envelope `{ data }`; error envelope `{ error: { code, message },
 *    requestId }`;
 *  - refusals are TAGGED VALUES (the same Refusal union as the read
 *    client) — this client never throws for expected outcomes.
 *
 * Body schemas mirror the spec's request-body schemas exactly (OpenCaseBody,
 * TransitionBody, EscalationBody, RecordActionBody, CompleteActionBody —
 * spec lines 2500–2563). Local validation is defense in depth: the server
 * remains the source of truth and its coded refusals surface verbatim.
 */

// ---------------------------------------------------------------------------
// request-body schemas (spec lines 2500–2563)
// ---------------------------------------------------------------------------

const uuidSchema = z.string().uuid();
const isoDateTimeSchema = z.string().datetime({ offset: true });

/** OpenCaseBody — receivableIds non-empty + UNIQUE (spec lines 2504–2512). */
export const openCaseBodySchema = z
  .object({
    receivableIds: z
      .array(uuidSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: 'receivableIds must be unique (R8 shape rule)',
      }),
    collectorId: uuidSchema,
    priority: z.enum(CASE_PRIORITIES).optional(),
  })
  .strict();
export type OpenCaseInput = z.infer<typeof openCaseBodySchema>;

/** TransitionBody — legal edges are the lane's decision, not ours. */
export const transitionBodySchema = z
  .object({
    to: z.enum(CASE_STATUSES),
    reason: z.string().min(1),
  })
  .strict();
export type TransitionInput = z.infer<typeof transitionBodySchema>;

/** EscalationBody — strictly-upward is enforced server-side (400 refusal). */
export const escalationBodySchema = z
  .object({
    to: z.enum(CASE_PRIORITIES),
    reason: z.string().min(1),
  })
  .strict();
export type EscalationInput = z.infer<typeof escalationBodySchema>;

/** RecordActionBody — K2 consentRef required for automated outbound sends. */
export const recordActionBodySchema = z
  .object({
    type: z.enum(CASE_ACTION_TYPES),
    scheduledFor: isoDateTimeSchema,
    outcome: z.string().min(1).optional(),
    source: z.enum(CASE_ACTION_SOURCES).optional(),
    consentRef: z.string().min(1).optional(),
  })
  .strict();
export type RecordActionInput = z.infer<typeof recordActionBodySchema>;

/** CompleteActionBody — outcome is mandatory and non-blank. */
export const completeActionBodySchema = z
  .object({
    outcome: z.string().min(1),
    actorId: uuidSchema.optional(),
  })
  .strict();
export type CompleteActionInput = z.infer<typeof completeActionBodySchema>;

// ---------------------------------------------------------------------------
// response schemas (spec lines 2460–2496)
// ---------------------------------------------------------------------------

/** CaseActionRecordedResponse.data — the post-append case AND the action. */
export const caseActionRecordedDataSchema = z
  .object({
    case: caseViewSchema,
    action: caseActionViewSchema.nullable(),
  })
  .strict();
export type CaseActionRecordedData = z.infer<typeof caseActionRecordedDataSchema>;

export interface RecordedAction {
  case: CaseView;
  action: CaseActionView | null;
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface CollectionsClientOptions {
  /** API base URL; defaults to the same-origin BFF `/api/v1`. */
  baseUrl?: string;
  /** Bearer credential provider for DIRECT calls (the BFF injects its own). */
  authTokenProvider?: () => string | null;
  fetchImpl?: FetchLike;
  requestIdGenerator?: () => string;
  timeoutMs?: number;
}

export interface CollectionsCaseClient {
  readonly baseUrl: string;
  /** POST /v1/collections/cases → 201 CaseResponse (R8 conflict is a 409). */
  openCase(input: OpenCaseInput): Promise<ApiResult<CaseView>>;
  /** POST …/{caseId}/transitions → 200 CaseResponse (post-transition view). */
  transitionCase(caseId: string, input: TransitionInput): Promise<ApiResult<CaseView>>;
  /** POST …/{caseId}/escalations → 200 CaseResponse (post-escalation view). */
  escalateCase(caseId: string, input: EscalationInput): Promise<ApiResult<CaseView>>;
  /** POST …/{caseId}/actions → 201 CaseActionRecordedResponse. */
  recordCaseAction(caseId: string, input: RecordActionInput): Promise<ApiResult<RecordedAction>>;
  /** POST …/{caseId}/actions/{actionId}/completions → 200 CaseResponse. */
  completeCaseAction(
    caseId: string,
    actionId: string,
    input: CompleteActionInput,
  ): Promise<ApiResult<CaseView>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createCollectionsClient(
  options: CollectionsClientOptions = {},
): CollectionsCaseClient {
  const baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/+$/, '');
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const generateRequestId =
    options.requestIdGenerator ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(
    path: string,
    body: unknown,
    dataSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<ApiResult<T>> {
    const url = `${baseUrl}${path}`;
    const clientRequestId = generateRequestId();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-request-id': clientRequestId,
    };
    const token = options.authTokenProvider?.() ?? null;
    if (token !== null) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      const init: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(timeoutMs);
      }
      response = await fetchImpl(url, init);
    } catch (error: unknown) {
      const isTimeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      return {
        ok: false,
        refusal: {
          tag: 'transport-error',
          reason: isTimeout ? 'timeout' : 'network',
          message: isTimeout
            ? `request to ${url} timed out after ${timeoutMs}ms`
            : `request to ${url} failed: ${describeError(error)}`,
        },
      };
    }

    const headerRequestId = response.headers.get('x-request-id');

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error: unknown) {
      return {
        ok: false,
        refusal: {
          tag: 'transport-error',
          reason: 'invalid-response',
          message: `could not read response body: ${describeError(error)}`,
        },
      };
    }

    let parsed: unknown;
    try {
      parsed = bodyText.length > 0 ? JSON.parse(bodyText) : null;
    } catch {
      return {
        ok: false,
        refusal: {
          tag: 'transport-error',
          reason: 'invalid-response',
          message: `response was not JSON (status ${response.status})`,
        },
      };
    }

    if (!response.ok) {
      return { ok: false, refusal: decodeErrorRefusal(response.status, parsed) };
    }

    // Strict success envelope, then the operation's data payload (same
    // discipline as the read client — contract drift is a tagged refusal).
    const successEnvelope = z.object({ data: z.unknown() }).strict().safeParse(parsed);
    if (!successEnvelope.success) {
      return {
        ok: false,
        refusal: {
          tag: 'decoding-error',
          message: `success envelope did not match the contract: ${firstIssue(successEnvelope.error)}`,
          requestId: headerRequestId,
        },
      };
    }
    const data = dataSchema.safeParse(successEnvelope.data.data);
    if (!data.success) {
      return {
        ok: false,
        refusal: {
          tag: 'decoding-error',
          message: `response data did not match the contract: ${firstIssue(data.error)}`,
          requestId: headerRequestId,
        },
      };
    }

    return { ok: true, data: data.data, pagination: null, requestId: headerRequestId };
  }

  function decodeErrorRefusal(status: number, parsed: unknown): Refusal {
    const raw = rawErrorEnvelopeSchema.safeParse(parsed);
    if (!raw.success) {
      return {
        tag: 'decoding-error',
        message: `error envelope did not match the contract (status ${status})`,
        requestId: null,
      };
    }
    const { code } = raw.data.error;
    if (!isKnownErrorCode(code)) {
      return {
        tag: 'unknown-error',
        status,
        rawCode: code,
        message: raw.data.error.message,
        requestId: raw.data.requestId,
      };
    }
    return {
      tag: 'api-error',
      status,
      code,
      message: raw.data.error.message,
      requestId: raw.data.requestId,
    };
  }

  /** Path-segment guard — ids are non-empty strings (defensive, mirrors read client). */
  function assertId(id: string): boolean {
    return id.length > 0;
  }

  function idRefusal<T>(message: string): ApiResult<T> {
    return {
      ok: false,
      refusal: {
        tag: 'decoding-error',
        message: `client-side validation refused the request: ${message}`,
        requestId: null,
      },
    };
  }

  function validateOrRefuse<S extends z.ZodTypeAny, R>(
    schema: S,
    input: unknown,
  ): { ok: true; value: z.infer<S> } | { ok: false; result: ApiResult<R> } {
    const parsed = schema.safeParse(input);
    if (parsed.success) return { ok: true, value: parsed.data };
    return {
      ok: false,
      result: {
        ok: false,
        refusal: {
          tag: 'decoding-error',
          message: `client-side body validation refused the request: ${firstIssue(parsed.error)}`,
          requestId: null,
        },
      },
    };
  }

  return {
    baseUrl,
    async openCase(input) {
      const guard = validateOrRefuse<typeof openCaseBodySchema, CaseView>(openCaseBodySchema, input);
      if (!guard.ok) return guard.result;
      return post('/v1/collections/cases', guard.value, caseDetailDataSchema).then((result) =>
        mapCase(result),
      );
    },
    async transitionCase(caseId, input) {
      if (!assertId(caseId)) return idRefusal('caseId must be a non-empty string');
      const guard = validateOrRefuse<typeof transitionBodySchema, CaseView>(
        transitionBodySchema,
        input,
      );
      if (!guard.ok) return guard.result;
      return post(
        `/v1/collections/cases/${encodeURIComponent(caseId)}/transitions`,
        guard.value,
        caseDetailDataSchema,
      ).then((result) => mapCase(result));
    },
    async escalateCase(caseId, input) {
      if (!assertId(caseId)) return idRefusal('caseId must be a non-empty string');
      const guard = validateOrRefuse<typeof escalationBodySchema, CaseView>(
        escalationBodySchema,
        input,
      );
      if (!guard.ok) return guard.result;
      return post(
        `/v1/collections/cases/${encodeURIComponent(caseId)}/escalations`,
        guard.value,
        caseDetailDataSchema,
      ).then((result) => mapCase(result));
    },
    async recordCaseAction(caseId, input) {
      if (!assertId(caseId)) return idRefusal('caseId must be a non-empty string');
      const guard = validateOrRefuse<typeof recordActionBodySchema, RecordedAction>(
        recordActionBodySchema,
        input,
      );
      if (!guard.ok) return guard.result;
      return post(
        `/v1/collections/cases/${encodeURIComponent(caseId)}/actions`,
        guard.value,
        caseActionRecordedDataSchema,
      ).then((result) =>
        result.ok
          ? { ok: true, data: { case: result.data.case, action: result.data.action }, pagination: null, requestId: result.requestId }
          : result,
      );
    },
    async completeCaseAction(caseId, actionId, input) {
      if (!assertId(caseId)) return idRefusal('caseId must be a non-empty string');
      if (!assertId(actionId)) return idRefusal('actionId must be a non-empty string');
      const guard = validateOrRefuse<typeof completeActionBodySchema, CaseView>(
        completeActionBodySchema,
        input,
      );
      if (!guard.ok) return guard.result;
      return post(
        `/v1/collections/cases/${encodeURIComponent(caseId)}/actions/${encodeURIComponent(actionId)}/completions`,
        guard.value,
        caseDetailDataSchema,
      ).then((result) => mapCase(result));
    },
  };
}

/** CaseResponse.data → the CaseView itself. */
function mapCase(result: ApiResult<{ case: CaseView }>): ApiResult<CaseView> {
  if (result.ok) {
    return { ok: true, data: result.data.case, pagination: null, requestId: result.requestId };
  }
  return result;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'unknown validation failure';
  return `${issue.path.join('.') || '(root)'}: ${issue.message}`;
}

/**
 * Process-wide write client for the app composition. The base URL mirrors
 * the read client's resolution (browser-client.ts): NEXT_PUBLIC_API_BASE for
 * direct calls, same-origin `/api/v1` BFF by default (the BFF attaches the
 * bearer credential from the httpOnly session cookie server-side).
 */
export function resolveCollectionsBaseUrl(): string {
  const direct = process.env.NEXT_PUBLIC_API_BASE;
  if (direct !== undefined && direct.length > 0) return direct;
  return '/api/v1';
}

/** Process-wide write client for the app composition (mirrors browser-client.ts). */
export const defaultCollectionsClient: CollectionsCaseClient = createCollectionsClient({
  baseUrl: resolveCollectionsBaseUrl(),
});
