/**
 * The KRA VSDC wire model + the K1 untrusted-input gate (issue #129).
 *
 * Everything in this file models what the KRA eTIMS gateway actually sends
 * over the VSDC boundary: a JSON envelope
 *
 *     { "resultCd": "000", "resultMsg": "...", "resultDt": "20260615100000",
 *       "data": { "grantId": "...", "from": "00000001", "to": "00000500" } }
 *
 * following the documented eTIMS conventions — `resultCd` is a 3–4 digit
 * decimal STRING ("000"/"0000" = success), `resultDt` is a `YYYYMMDDHHmmss`
 * Kenyan-local (EAT, UTC+3) timestamp, and identity/sequence fields arrive as
 * decimal STRINGS. Channel input is UNTRUSTED (review finding K1):
 * `parseVsdcBandGrantResponse` is the only door from the wire into the
 * numbering source. It validates every field it returns, and anything it
 * cannot fully validate is refused with a stable `ETIMS_VSDC_*` code — the
 * client folds that into a refusal VALUE and the reservation is never taken.
 *
 * Exact decimal discipline (no float): wire sequences are parsed only from
 * strict `\d{1,8}` decimal strings through `Number()` — JSON numbers,
 * exponents (`1e3`), fractional forms (`1.0`) and signs are structurally
 * impossible to accept. All arithmetic on granted ranges is safe-integer
 * addition/subtraction only; there is no float anywhere in the lane.
 *
 * Pure: no I/O, no clock, no RNG.
 */
import { DomainError } from '../../domain/shared';
import { ETIMS_ERRORS, refusedResultCode } from './codes';

/** The 8-digit sequence field width of the eTIMS invoice number (domain port). */
export const ETIMS_MAX_SEQUENCE = 99_999_999;

/** eTIMS result codes: 3–4 digit decimal strings. */
const RESULT_CD_PATTERN = /^\d{3,4}$/;
/** Documented success codes across the eTIMS gateway generations. */
export const VSDC_SUCCESS_RESULT_CDS: ReadonlySet<string> = new Set(['000', '0000']);
/** KRA `resultDt`: YYYYMMDDHHmmss (EAT). */
const RESULT_DT_PATTERN = /^\d{14}$/;
/** Band grant ids: opaque uppercase-ish tokens, 6–64 chars. */
const GRANT_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{5,63}$/;
/**
 * Wire sequence fields: plain decimal strings, 1–8 digits. This is the exact
 * integer gate — everything else (JSON numbers, floats, exponents, signs,
 * whitespace, padding past 8 digits) is wire junk and refused.
 */
const WIRE_SEQUENCE_PATTERN = /^\d{1,8}$/;

/** Kenyan local time = EAT = UTC+3; KRA reports resultDt in EAT. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Wire sequence → exact integer. Accepts ONLY strict 1–8 digit decimal
 * strings in [1, ETIMS_MAX_SEQUENCE]; every other shape throws
 * `ETIMS_VSDC_WIRE_MALFORMED` (never rounds, never coerces, never floats).
 */
export const sequenceFromWire = (raw: unknown, field: string): number => {
  if (typeof raw !== 'string' || !WIRE_SEQUENCE_PATTERN.test(raw)) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_WIRE_MALFORMED,
      `${field} must be a decimal string of 1–8 digits, got ${typeof raw === 'string' ? `"${raw}"` : typeof raw}`,
      { field },
    );
  }
  const value = Number(raw); // exact: the regex guarantees ≤ 8 integer digits < 2^53
  if (value < 1 || value > ETIMS_MAX_SEQUENCE) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_WIRE_MALFORMED,
      `${field} "${raw}" is outside the 8-digit sequence field [1, ${ETIMS_MAX_SEQUENCE}]`,
      { field, value },
    );
  }
  return value;
};

/** 'YYYYMMDDHHmmss' (EAT) → Date. Calendar-invalid fields are rejected. */
export const resultDtToDate = (raw: unknown, field = 'resultDt'): Date => {
  if (typeof raw !== 'string' || !RESULT_DT_PATTERN.test(raw)) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_WIRE_MALFORMED,
      `${field} must be YYYYMMDDHHmmss (EAT), got ${typeof raw === 'string' ? `"${raw}"` : typeof raw}`,
      { field },
    );
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_WIRE_MALFORMED,
      `${field} "${raw}" has an out-of-range field`,
      { field, value: raw },
    );
  }
  // The wire fields are EAT wall-clock fields; encode them as UTC fields and
  // verify Date did not silently roll any component over (Feb 30 → Mar 2,
  // Apr 31 → May 1) — the K1 boundary never rewrites a timestamp.
  const encoded = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const rolled =
    encoded.getUTCFullYear() !== year ||
    encoded.getUTCMonth() !== month - 1 ||
    encoded.getUTCDate() !== day ||
    encoded.getUTCHours() !== hour ||
    encoded.getUTCMinutes() !== minute ||
    encoded.getUTCSeconds() !== second;
  if (rolled) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_WIRE_MALFORMED,
      `${field} "${raw}" is not a real calendar instant`,
      { field, value: raw },
    );
  }
  return new Date(encoded.getTime() - EAT_OFFSET_MS);
};

/** A granted contiguous band of sequence numbers, inclusive on both ends. */
export interface VsdcBandGrant {
  readonly grantId: string;
  readonly from: number;
  readonly to: number;
}

/** The typed success value of a band-grant response. */
export interface VsdcGrantSuccess {
  readonly grant: VsdcBandGrant;
  readonly resultCd: string;
  readonly resultMsg: string;
  /** Raw wire `resultDt` (unmodified evidence). */
  readonly resultDt: string;
  /** Decoded `resultDt` instant (EAT → UTC). */
  readonly resultDate: Date;
}

const malformed = (message: string, details?: Record<string, unknown>): DomainError =>
  new DomainError(ETIMS_ERRORS.VSDC_WIRE_MALFORMED, message, details);

/**
 * The single door from the KRA wire into the numbering source. Validates the
 * HTTP transport status, the envelope, and the granted band (which must cover
 * exactly `requestedCount` sequences — the VSDC grants whole bands, not
 * fragments). Anything less than fully valid throws a stable `ETIMS_VSDC_*`
 * DomainError — the client folds it into a refusal value; it never returns a
 * half-trusted grant.
 */
export const parseVsdcBandGrantResponse = (
  status: number,
  body: string,
  requestedCount: number,
): VsdcGrantSuccess => {
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1) {
    throw malformed(`requestedCount must be a positive safe integer, got ${String(requestedCount)}`);
  }

  if (status === 401 || status === 403) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_AUTH_REJECTED,
      `KRA gateway rejected the VSDC credential (HTTP ${status})`,
      { status },
    );
  }
  if (status === 429) {
    throw new DomainError(ETIMS_ERRORS.VSDC_RATE_LIMITED, `KRA gateway rate-limited the request (HTTP 429)`, {
      status,
    });
  }
  if (status >= 500) {
    throw new DomainError(ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE, `KRA gateway outage (HTTP ${status})`, { status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw malformed(`response body is not JSON (HTTP ${status})`, { status });
  }
  if (!isRecord(parsed)) {
    throw malformed(`response envelope must be a JSON object (HTTP ${status})`, { status });
  }

  const resultCd = parsed['resultCd'];
  if (typeof resultCd !== 'string' || !RESULT_CD_PATTERN.test(resultCd)) {
    throw malformed(`envelope resultCd must be a 3–4 digit decimal string, got ${String(resultCd)}`);
  }
  const resultMsg = parsed['resultMsg'];
  if (typeof resultMsg !== 'string') {
    throw malformed('envelope resultMsg must be a string');
  }
  const resultDate = resultDtToDate(parsed['resultDt']);

  if (!VSDC_SUCCESS_RESULT_CDS.has(resultCd)) {
    // KRA business refusal — stable per-result-code identity, message carried as data.
    throw new DomainError(
      refusedResultCode(resultCd),
      `KRA VSDC refused the band request (resultCd ${resultCd}): ${resultMsg}`,
      { resultCd, resultMsg },
    );
  }

  const data = parsed['data'];
  if (!isRecord(data)) {
    throw malformed('a successful grant envelope must carry a data object');
  }
  const grantId = data['grantId'];
  if (typeof grantId !== 'string' || !GRANT_ID_PATTERN.test(grantId)) {
    throw malformed(`data.grantId must be 6–64 grant-id characters, got ${String(grantId)}`);
  }
  const from = sequenceFromWire(data['from'], 'data.from');
  const to = sequenceFromWire(data['to'], 'data.to');
  if (from > to) {
    throw malformed(`granted band is inverted (from ${from} > to ${to})`);
  }
  if (to - from + 1 !== requestedCount) {
    throw new DomainError(
      ETIMS_ERRORS.VSDC_BAND_SIZE_MISMATCH,
      `granted band [${from}, ${to}] covers ${to - from + 1} sequences, expected ${requestedCount} — the VSDC grants whole bands`,
      { from, to, requestedCount },
    );
  }

  return { grant: { grantId, from, to }, resultCd, resultMsg, resultDt: parsed['resultDt'] as string, resultDate };
};
