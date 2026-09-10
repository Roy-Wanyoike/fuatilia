/**
 * The VSDC boundary client (issue #129) — the ONLY place this lane touches
 * the KRA network.
 *
 * The client performs one operation: asking the eTIMS Virtual Sales Control
 * Unit to grant a contiguous band of invoice sequences for a (branch, year).
 * It never invents a grant: the response goes through the K1 gate in
 * `wire.ts`, and every failure — network, transport status, malformed wire,
 * KRA refusal — comes back as a typed refusal VALUE (`VsdcBandResult`) so a
 * background refiller can branch on `retryable` without try/catch gymnastics.
 *
 * Credentials are config-only (`EtimsConfig`, env-injected): the cmcKey is
 * sent in the Authorization header and NEVER appears in a thrown error, a
 * refusal message, or the built request's logged shape. The HTTP call itself
 * rides an injected `VsdcPost` port (global fetch in production wiring — no
 * new dependencies; fakes in tests only).
 *
 * Wire contract (documented model of the eTIMS VSDC boundary):
 *   POST {baseUrl}/vsdc/sequenceBandReserve
 *   headers: Content-Type: application/json, Accept: application/json,
 *            Authorization: Bearer <cmcKey>
 *   body:    { tin, bhfId, dvcSrlNo, year, count, afterSeq, requestId }
 *   success: envelope resultCd "000"/"0000" + data { grantId, from, to }
 *            where from/to are decimal strings and to-from+1 === count.
 * `requestId` is the idempotency key a retried call can repeat.
 */
import { DomainError, type Clock } from '../../domain/shared';
import { ETIMS_ERRORS } from './codes';
import { assertEtimsClock, type EtimsConfig } from './config';
import { ETIMS_MAX_SEQUENCE, parseVsdcBandGrantResponse, type VsdcBandGrant } from './wire';

/** An outbound HTTP POST as the client sees it (injected; faked in tests). */
export type VsdcPost = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly body: string },
) => Promise<{ readonly status: number; readonly body: string }>;

/** Production wiring: the injected port over global fetch (no new deps). */
export const DEFAULT_VSDC_TIMEOUT_MS = 30_000;

export const vsdcPostFromGlobalFetch = (
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs: number = DEFAULT_VSDC_TIMEOUT_MS,
): VsdcPost => {
  if (typeof fetchImpl !== 'function') {
    throw new DomainError(ETIMS_ERRORS.CONFIG_INVALID, 'global fetch is not available in this runtime');
  }
  return async (url, init) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...init.headers },
      body: init.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await response.text() };
  };
};

/** The band-grant ask. `afterSeq` is the last sequence already held (0 = none). */
export interface VsdcBandRequest {
  /** Issuance year the band is scoped to (from the injected Clock). */
  readonly year: number;
  /** Exact band size requested — the VSDC grants whole bands. */
  readonly count: number;
  /** Sequences already granted below this year's stream (0 when fresh). */
  readonly afterSeq: number;
  /** Idempotency key for retried registration calls. */
  readonly requestId: string;
}

/** The typed outcome of one band-grant call — a VALUE, never a throw. */
export type VsdcBandResult =
  | {
      readonly ok: true;
      readonly grant: VsdcBandGrant;
      readonly resultCd: string;
      readonly resultMsg: string;
      readonly resultDt: string;
      readonly resultDate: Date;
    }
  | {
      readonly ok: false;
      /** Stable refusal code (`ETIMS_VSDC_*` or `ETIMS_VSDC_REFUSED_<resultCd>`). */
      readonly code: string;
      /** Whether a LATER attempt may succeed (outage/rate-limit/busy). */
      readonly retryable: boolean;
      readonly resultCd: string | null;
      readonly resultMsg: string | null;
    };

const REQUEST_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{2,63}$/;

const assertBandRequest = (req: VsdcBandRequest, config: EtimsConfig): void => {
  if (!Number.isSafeInteger(req.year) || req.year < 1000 || req.year > 9999) {
    throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `band year must be a 4-digit year, got ${String(req.year)}`, {
      year: req.year,
    });
  }
  if (!Number.isSafeInteger(req.count) || req.count < 1 || req.count > config.bandSize) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `band count must be an integer in [1, ${config.bandSize}], got ${String(req.count)}`,
      { count: req.count },
    );
  }
  if (!Number.isSafeInteger(req.afterSeq) || req.afterSeq < 0 || req.afterSeq > ETIMS_MAX_SEQUENCE) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `afterSeq must be an integer in [0, ${ETIMS_MAX_SEQUENCE}], got ${String(req.afterSeq)}`,
      { afterSeq: req.afterSeq },
    );
  }
  if (typeof req.requestId !== 'string' || !REQUEST_ID_PATTERN.test(req.requestId)) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      'requestId must be 3–64 request-id characters ([0-9A-Za-z._-])',
      { requestId: typeof req.requestId === 'string' ? req.requestId.length : String(req.requestId) },
    );
  }
};

/**
 * Build the wire request (pure — tests pin the exact shape). The credential
 * lives ONLY in the Authorization header of `init`; it never enters the body.
 */
export const buildBandGrantRequest = (
  config: EtimsConfig,
  req: VsdcBandRequest,
): { readonly url: string; readonly init: { readonly headers: Readonly<Record<string, string>>; readonly body: string } } => {
  assertBandRequest(req, config);
  return {
    url: `${config.baseUrl}/vsdc/sequenceBandReserve`,
    init: {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.cmcKey}`,
      },
      body: JSON.stringify({
        tin: config.tin,
        bhfId: config.branchId,
        dvcSrlNo: config.deviceSerial,
        year: req.year,
        count: req.count,
        afterSeq: req.afterSeq,
        requestId: req.requestId,
      }),
    },
  };
};

export interface VsdcClientOptions {
  /**
   * KRA result codes that mean "try again later" (busy/maintenance class).
   * Business refusals default to PERMANENT; when KRA's code table pins
   * transient codes, pass them here — classification is config, not folklore.
   */
  readonly retryableResultCds?: ReadonlySet<string>;
}

/** The VSDC boundary client used by the numbering source's refill half. */
export interface VsdcSequenceClient {
  registerSequenceBand(req: VsdcBandRequest): Promise<VsdcBandResult>;
}

export const createVsdcSequenceClient = (
  config: EtimsConfig,
  post: VsdcPost,
  options: VsdcClientOptions = {},
): VsdcSequenceClient => {
  const retryableResultCds = options.retryableResultCds ?? new Set<string>();
  return {
    async registerSequenceBand(req: VsdcBandRequest): Promise<VsdcBandResult> {
      const { url, init } = buildBandGrantRequest(config, req);
      let status: number;
      let body: string;
      try {
        const wire = await post(url, init);
        status = wire.status;
        body = wire.body;
      } catch (error: unknown) {
        return {
          ok: false,
          code: ETIMS_ERRORS.VSDC_NETWORK_ERROR,
          retryable: true,
          resultCd: null,
          resultMsg: error instanceof Error ? error.message : String(error),
        };
      }
      try {
        const success = parseVsdcBandGrantResponse(status, body, req.count);
        return { ok: true, ...success };
      } catch (error: unknown) {
        if (!(error instanceof DomainError)) {
          return { ok: false, code: ETIMS_ERRORS.VSDC_WIRE_MALFORMED, retryable: false, resultCd: null, resultMsg: null };
        }
        const code: string = error.code;
        const resultCd = code.startsWith('ETIMS_VSDC_REFUSED_')
          ? code.slice('ETIMS_VSDC_REFUSED_'.length)
          : null;
        let retryable = false;
        if (code === ETIMS_ERRORS.VSDC_RATE_LIMITED || code === ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE) {
          retryable = true;
        } else if (resultCd !== null) {
          retryable = retryableResultCds.has(resultCd);
        }
        const resultMsg = typeof (error.details as { resultMsg?: unknown } | undefined)?.resultMsg === 'string'
          ? (error.details as { resultMsg: string }).resultMsg
          : null;
        return { ok: false, code, retryable, resultCd, resultMsg };
      }
    },
  };
};

/**
 * Deterministic request-id minting for refill attempts — clock-driven (no
 * RNG, no wall clock), monotonic per process so concurrent refills of one
 * source never share an id.
 */
export const createRequestIdMinter = (
  clock: Clock,
  prefix = 'etims-band',
): (() => string) => {
  assertEtimsClock(clock);
  let counter = 0;
  return () => {
    counter += 1;
    const at = assertEtimsClock(clock).toISOString().replace(/[-:.]/g, '').slice(0, 14);
    return `${prefix}-${at}-${String(counter).padStart(4, '0')}`;
  };
};
