import { z } from 'zod';
import {
  knownErrorEnvelopeSchema,
  paginationMetaSchema,
  rawErrorEnvelopeSchema,
} from './envelope';
import { isKnownErrorCode, type ErrorCode } from './error-codes';
import {
  caseDetailDataSchema,
  caseListDataSchema,
  healthDataSchema,
  metaDataSchema,
  paymentDetailDataSchema,
  paymentListDataSchema,
  receivableDetailDataSchema,
  receivableListDataSchema,
  type CaseDetailData,
  type CaseListData,
  type CaseView,
  type HealthData,
  type MetaData,
  type PaymentDetailData,
  type PaymentListData,
  type PaymentView,
  type ReceivableDetailData,
  type ReceivableListData,
  type ReceivableView,
} from './wire-types';

/**
 * The typed /v1 client — hand-derived from api/openapi/fuatilia.v1.yaml.
 *
 * Contract rules implemented here (spec header comment + "Envelope"):
 *  - every response carries x-request-id (echoed from our request header);
 *  - success envelope `{ data, meta? }`, lists carry meta.pagination;
 *  - error envelope `{ error: { code, message }, requestId }`;
 *  - refusals are TAGGED VALUES — the client never throws for expected
 *    outcomes (4xx/5xx/transport/decoding), mirroring the repo's
 *    refusal-as-value house rule.
 */

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tagged refusal surfaces — the client's error vocabulary. */
export type ApiErrorRefusal = {
  tag: 'api-error';
  status: number;
  /** A code from the committed spec union (contract.test.ts pins it). */
  code: ErrorCode;
  message: string;
  requestId: string;
};

export type UnknownApiErrorRefusal = {
  tag: 'unknown-error';
  status: number;
  /** Pattern-valid SCREAMING_SNAKE code outside the known union. */
  rawCode: string;
  message: string | null;
  requestId: string | null;
};

export type TransportRefusal = {
  tag: 'transport-error';
  reason: 'network' | 'timeout' | 'invalid-response';
  message: string;
};

export type DecodingRefusal = {
  tag: 'decoding-error';
  message: string;
  requestId: string | null;
};

export type Refusal =
  | ApiErrorRefusal
  | UnknownApiErrorRefusal
  | TransportRefusal
  | DecodingRefusal;

export interface PaginationInfo {
  nextCursor: string | null;
  total: number | null;
}

export type ApiSuccess<T> = {
  ok: true;
  data: T;
  pagination: PaginationInfo | null;
  /** Correlation id echoed by the kernel (x-request-id / error body). */
  requestId: string | null;
};

export type ApiFailure = {
  ok: false;
  refusal: Refusal;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

/** One page of a paginated list operation. */
export interface Page<T> {
  rows: T[];
  pagination: PaginationInfo;
}

// ---------------------------------------------------------------------------
// List query parameters (per-resource sort whitelists — strict 1–100 limits)
// ---------------------------------------------------------------------------

export const RECEIVABLE_SORTS = ['id', 'state', 'dueDate'] as const;
export const PAYMENT_SORTS = ['id', 'state', 'initiatedAt'] as const;
export const CASE_SORTS = ['id', 'caseNumber', 'priority', 'status'] as const;
export const ORDERS = ['asc', 'desc'] as const;

export type ReceivableSort = (typeof RECEIVABLE_SORTS)[number];
export type PaymentSort = (typeof PAYMENT_SORTS)[number];
export type CaseSort = (typeof CASE_SORTS)[number];

export interface ReceivableListQuery {
  /** STRICT boundaries per the kernel — it never clamps (1–100). */
  limit?: number;
  cursor?: string;
  sort?: ReceivableSort;
  order?: (typeof ORDERS)[number];
}

export interface PaymentListQuery {
  limit?: number;
  cursor?: string;
  sort?: PaymentSort;
  order?: (typeof ORDERS)[number];
}

export interface CaseListQuery {
  limit?: number;
  cursor?: string;
  sort?: CaseSort;
  order?: (typeof ORDERS)[number];
}

const listQuerySchema = <S extends readonly [string, ...string[]]>(sorts: S) =>
  z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().min(1).max(512).optional(),
      sort: z.enum(sorts).optional(),
      order: z.enum(ORDERS).optional(),
    })
    .strict();

const receivableListQuerySchema = listQuerySchema(RECEIVABLE_SORTS);
const paymentListQuerySchema = listQuerySchema(PAYMENT_SORTS);
const caseListQuerySchema = listQuerySchema(CASE_SORTS);

// ---------------------------------------------------------------------------
// Observability: request log hook (SPEC §47 traceability — requestId echo)
// ---------------------------------------------------------------------------

export type ClientLogLevel = 'info' | 'warn' | 'error';

export interface ClientLogEvent {
  level: ClientLogLevel;
  message: string;
  method: string;
  url: string;
  status: number | null;
  requestId: string | null;
  durationMs: number | null;
}

export type ClientLogger = (event: ClientLogEvent) => void;

/** Dev-only console logger; production wires its own sink or `null`. */
export function consoleLogger(event: ClientLogEvent): void {
  const prefix = `[fuatilia-api] ${event.method} ${event.url}`;
  const suffix = `${event.status ?? 'no-response'}${
    event.requestId ? ` (requestId ${event.requestId})` : ''
  }${event.durationMs != null ? ` ${event.durationMs}ms` : ''}`;
  if (event.level === 'error') console.error(`${prefix} → ${suffix}`);
  else if (event.level === 'warn') console.warn(`${prefix} → ${suffix}`);
  else console.info(`${prefix} → ${suffix}`);
}

export function devLoggerOrNull(): ClientLogger | null {
  return process.env.NODE_ENV === 'production' ? null : consoleLogger;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  /**
   * API base URL. Defaults to the same-origin BFF `/api/v1` (the Next route
   * handler that attaches `Authorization: Bearer <session>` from the
   * httpOnly cookie — the browser never sees the token). Set
   * NEXT_PUBLIC_API_BASE to call the API host directly instead.
   */
  baseUrl?: string;
  /**
   * Bearer credential provider (an auth-lane session id per the contract's
   * bearerSession scheme). Only used for DIRECT calls; the same-origin BFF
   * injects the credential server-side from the httpOnly session cookie.
   */
  authTokenProvider?: () => string | null;
  fetchImpl?: FetchLike;
  requestIdGenerator?: () => string;
  /** Request log hook; defaults to dev-only console, pass null to silence. */
  logger?: ClientLogger | null;
  /** Fetch timeout in ms (default 15_000). */
  timeoutMs?: number;
}

export interface FuatiliaClient {
  readonly baseUrl: string;
  listReceivables(query?: ReceivableListQuery): Promise<ApiResult<Page<ReceivableView>>>;
  getReceivable(receivableId: string): Promise<ApiResult<ReceivableView>>;
  listPayments(query?: PaymentListQuery): Promise<ApiResult<Page<PaymentView>>>;
  getPayment(paymentId: string): Promise<ApiResult<PaymentView>>;
  listCases(query?: CaseListQuery): Promise<ApiResult<Page<CaseView>>>;
  getCase(caseId: string): Promise<ApiResult<CaseView>>;
  getHealth(): Promise<ApiResult<HealthData>>;
  getMeta(): Promise<ApiResult<MetaData>>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function buildQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

export function createFuatiliaClient(options: ClientOptions = {}): FuatiliaClient {
  const baseUrl = (options.baseUrl ?? '/api/v1').replace(/\/+$/, '');
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((input, init) => fetch(input, init));
  const generateRequestId =
    options.requestIdGenerator ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const logger: ClientLogger | null =
    options.logger === undefined ? devLoggerOrNull() : options.logger;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    query: Record<string, string | number | undefined>,
    dataSchema: z.ZodType<T, z.ZodTypeDef, unknown>,
    opts: { withPagination?: boolean } = {},
  ): Promise<ApiResult<T>> {
    const url = `${baseUrl}${path}${buildQuery(query)}`;
    const startedAt = nowMs();
    const clientRequestId = generateRequestId();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-request-id': clientRequestId,
    };
    const token = options.authTokenProvider?.() ?? null;
    if (token !== null) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      const init: RequestInit = { method, headers };
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        init.signal = AbortSignal.timeout(timeoutMs);
      }
      response = await fetchImpl(url, init);
    } catch (error: unknown) {
      const isTimeout =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      log('error', method, url, null, null, startedAt);
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
      log('error', method, url, response.status, headerRequestId, startedAt);
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
      log('error', method, url, response.status, headerRequestId, startedAt);
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
      const refusal = decodeErrorRefusal(response.status, parsed);
      log('error', method, url, response.status, requestIdOf(refusal), startedAt);
      return { ok: false, refusal };
    }

    // Envelope shape first (strict keys), then the data payload against the
    // operation's schema. The data check runs outside the envelope object so
    // a generic T cannot be inferred as an optional key (zod marks a
    // property optional when it cannot prove its type excludes undefined).
    const successEnvelope = (
      opts.withPagination === true
        ? z.object({ data: z.unknown(), meta: z.unknown().optional() })
        : z.object({ data: z.unknown() })
    )
      .strict()
      .safeParse(parsed);
    if (!successEnvelope.success) {
      log('error', method, url, response.status, headerRequestId, startedAt);
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
      log('error', method, url, response.status, headerRequestId, startedAt);
      return {
        ok: false,
        refusal: {
          tag: 'decoding-error',
          message: `response data did not match the contract: ${firstIssue(data.error)}`,
          requestId: headerRequestId,
        },
      };
    }

    let pagination: PaginationInfo | null = null;
    if (opts.withPagination === true) {
      const meta = paginationMetaSchema.safeParse(
        (parsed as { meta?: unknown }).meta,
      );
      pagination = meta.success
        ? {
            nextCursor: meta.data.pagination.nextCursor,
            total: meta.data.pagination.total ?? null,
          }
        : { nextCursor: null, total: null };
    }

    log('info', method, url, response.status, headerRequestId, startedAt);
    return { ok: true, data: data.data, pagination, requestId: headerRequestId };
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

  function requestIdOf(refusal: Refusal): string | null {
    switch (refusal.tag) {
      case 'api-error':
      case 'unknown-error':
      case 'decoding-error':
        return refusal.requestId;
      case 'transport-error':
        return null;
    }
  }

  function log(
    level: ClientLogLevel,
    method: string,
    url: string,
    status: number | null,
    requestId: string | null,
    startedAt: number,
  ): void {
    if (logger === null) return;
    logger({
      level,
      message: 'fuatilia api request',
      method,
      url,
      status,
      requestId,
      durationMs: Math.max(0, Math.round(nowMs() - startedAt)),
    });
  }

  function toPageResult<TListData, TRow>(
    result: ApiResult<TListData>,
    pick: (data: TListData) => TRow[],
  ): ApiResult<Page<TRow>> {
    if (result.ok) {
      return {
        ok: true,
        data: {
          rows: pick(result.data),
          pagination: result.pagination ?? { nextCursor: null, total: null },
        },
        pagination: result.pagination,
        requestId: result.requestId,
      };
    }
    return result;
  }

  return {
    baseUrl,
    async listReceivables(query = {}) {
      const parsedQuery = receivableListQuerySchema.safeParse(query);
      if (!parsedQuery.success) {
        return validationRefusal<Page<ReceivableView>>(firstIssue(parsedQuery.error));
      }
      const result = await request(
        'GET',
        '/v1/receivables',
        { ...parsedQuery.data },
        receivableListDataSchema,
        { withPagination: true },
      );
      return toPageResult(result, (data) => data.receivables);
    },
    async getReceivable(receivableId) {
      if (!isOpaqueId(receivableId)) {
        return validationRefusal<ReceivableView>('receivableId must be a non-empty string');
      }
      const result = await request(
        'GET',
        `/v1/receivables/${encodeURIComponent(receivableId)}`,
        {},
        receivableDetailDataSchema,
      );
      return mapSingle(result, (data: ReceivableDetailData) => data.receivable);
    },
    async listPayments(query = {}) {
      const parsedQuery = paymentListQuerySchema.safeParse(query);
      if (!parsedQuery.success) {
        return validationRefusal<Page<PaymentView>>(firstIssue(parsedQuery.error));
      }
      const result = await request(
        'GET',
        '/v1/payments',
        { ...parsedQuery.data },
        paymentListDataSchema,
        { withPagination: true },
      );
      return toPageResult(result, (data) => data.payments);
    },
    async getPayment(paymentId) {
      if (!isOpaqueId(paymentId)) {
        return validationRefusal<PaymentView>('paymentId must be a non-empty string');
      }
      const result = await request(
        'GET',
        `/v1/payments/${encodeURIComponent(paymentId)}`,
        {},
        paymentDetailDataSchema,
      );
      return mapSingle(result, (data: PaymentDetailData) => data.payment);
    },
    async listCases(query = {}) {
      const parsedQuery = caseListQuerySchema.safeParse(query);
      if (!parsedQuery.success) {
        return validationRefusal<Page<CaseView>>(firstIssue(parsedQuery.error));
      }
      const result = await request(
        'GET',
        '/v1/collections/cases',
        { ...parsedQuery.data },
        caseListDataSchema,
        { withPagination: true },
      );
      return toPageResult(result, (data) => data.cases);
    },
    async getCase(caseId) {
      if (!isOpaqueId(caseId)) {
        return validationRefusal<CaseView>('caseId must be a non-empty string');
      }
      const result = await request(
        'GET',
        `/v1/collections/cases/${encodeURIComponent(caseId)}`,
        {},
        caseDetailDataSchema,
      );
      return mapSingle(result, (data: CaseDetailData) => data.case);
    },
    async getHealth() {
      return request('GET', '/v1/health', {}, healthDataSchema);
    },
    async getMeta() {
      return request('GET', '/v1/meta', {}, metaDataSchema);
    },
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function mapSingle<D, R>(result: ApiResult<D>, pick: (data: D) => R): ApiResult<R> {
  if (result.ok) {
    return {
      ok: true,
      data: pick(result.data),
      pagination: null,
      requestId: result.requestId,
    };
  }
  return result;
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
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

function isOpaqueId(id: string): boolean {
  return id.length > 0;
}

function validationRefusal<T>(message: string): ApiResult<T> {
  return {
    ok: false,
    refusal: {
      tag: 'decoding-error',
      message: `client-side query validation refused the request: ${message}`,
      requestId: null,
    },
  };
}
