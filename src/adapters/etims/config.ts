/**
 * eTIMS VSDC configuration — env-only credentials, never literals (issue #129).
 *
 * The KRA eTIMS VSDC boundary is authenticated with the taxpayer identity
 * (PIN + branch + device serial) and the device's VSDC credential (the OSCU
 * "cmcKey" convention — a per-device key minted during eTIMS onboarding).
 * Those values are secrets: they arrive ONLY through the injected `env`
 * accessor, are never written into code, fixtures or logs, and `redactEtimsConfig`
 * is the only sanctioned way to render the config for observability.
 *
 * Wire-contract grounding (documented model of the KRA eTIMS gateway):
 *   - sandbox base `https://etims-api-sbx.kra.go.ke`, production base
 *     `https://etims-api.kra.go.ke/etims-api` — hence the strict https rule;
 *   - taxpayer fields follow the eTIMS API conventions: `tin` (`P000000045R`
 *     shape), `bhfId` (`00`), `dvcSrlNo` (`MOVA22`).
 *
 * Exact-integer discipline: the sizing knobs (band size, low watermark, max
 * reservation) are parsed from decimal-integer STRINGS with a strict shape
 * regex before `Number()` — floats, exponents, signs, and padding junk are
 * config errors, never rounded values.
 */
import { DomainError, type Clock } from '../../domain/shared';
import { ETIMS_ERRORS } from './codes';

/** The taxpayer identity + VSDC credential the boundary client authenticates with. */
export interface EtimsConfig {
  /** eTIMS gateway base URL (https, no trailing slash). */
  readonly baseUrl: string;
  /** KRA PIN (`tin`), e.g. `P000000045R`. */
  readonly tin: string;
  /** Branch id (`bhfId`), e.g. `00` for the main branch. */
  readonly branchId: string;
  /** Device serial number (`dvcSrlNo`), e.g. `MOVA22`. */
  readonly deviceSerial: string;
  /** The VSDC device credential (OSCU cmcKey convention) — SECRET. */
  readonly cmcKey: string;
  /** Sequences requested per band-registration call (the outage buffer size). */
  readonly bandSize: number;
  /** Remaining-stock level at or below which `stats().needsRefill` is true. */
  readonly lowWatermark: number;
  /** Largest single burst the reservation port will serve. */
  readonly maxReservation: number;
}

const TIN_PATTERN = /^[A-Z]\d{8,9}[A-Z]$/;
const BRANCH_ID_PATTERN = /^[0-9A-Z]{1,3}$/;
const DEVICE_SERIAL_PATTERN = /^[0-9A-Za-z-]{4,32}$/;
/** Strict decimal integer for env knobs — no sign, no dot, no exponent. */
const ENV_INT_PATTERN = /^\d{1,9}$/;

const MAX_BAND_SIZE = 100_000;
const MAX_MAX_RESERVATION = 10_000;

export const DEFAULT_BAND_SIZE = 500;
export const DEFAULT_LOW_WATERMARK = 100;
export const DEFAULT_MAX_RESERVATION = 100;

const readEnv = (env: (key: string) => string, key: string): string => {
  const raw = env(key);
  return typeof raw === 'string' ? raw.trim() : '';
};

const intFromEnv = (
  env: (key: string) => string,
  key: string,
  fallback: number,
  max: number,
): number => {
  const raw = readEnv(env, key);
  if (raw === '') return fallback;
  if (!ENV_INT_PATTERN.test(raw)) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `${key} "${raw}" must be a plain decimal integer (no sign, dot or exponent)`,
      { key, value: raw },
    );
  }
  const value = Number(raw); // exact: the regex guarantees ≤ 9 integer digits < 2^53
  if (value < 1 || value > max) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `${key} must be in [1, ${max}], got ${value}`,
      { key, value },
    );
  }
  return value;
};

/**
 * Build the eTIMS config from the environment accessor. Missing or malformed
 * credentials throw a stable `ETIMS_CONFIG_INVALID` — the lane never starts
 * half-configured and never falls back to defaults for secrets.
 */
export const etimsConfigFromEnv = (env: (key: string) => string): EtimsConfig => {
  const baseUrl = readEnv(env, 'ETIMS_VSDC_BASE_URL').replace(/\/+$/, '');
  const tin = readEnv(env, 'ETIMS_TIN').toUpperCase();
  const branchId = readEnv(env, 'ETIMS_BRANCH_ID').toUpperCase();
  const deviceSerial = readEnv(env, 'ETIMS_DEVICE_SERIAL');
  const cmcKey = readEnv(env, 'ETIMS_VSDC_CMC_KEY');

  const missing: string[] = [];
  if (baseUrl === '') missing.push('ETIMS_VSDC_BASE_URL');
  if (tin === '') missing.push('ETIMS_TIN');
  if (branchId === '') missing.push('ETIMS_BRANCH_ID');
  if (deviceSerial === '') missing.push('ETIMS_DEVICE_SERIAL');
  if (cmcKey === '') missing.push('ETIMS_VSDC_CMC_KEY');
  if (missing.length > 0) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `missing required eTIMS env config: ${missing.join(', ')} (env-injected, never hardcoded)`,
      { missing },
    );
  }
  if (!baseUrl.startsWith('https://')) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `ETIMS_VSDC_BASE_URL must be https (got a non-https URL) — credentials never travel in cleartext`,
    );
  }
  if (!TIN_PATTERN.test(tin)) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      'ETIMS_TIN must be a KRA PIN of the shape P051234516X (letter + 8–9 digits + letter)',
      { key: 'ETIMS_TIN' },
    );
  }
  if (!BRANCH_ID_PATTERN.test(branchId)) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      'ETIMS_BRANCH_ID must be 1–3 uppercase alphanumeric characters (e.g. 00)',
      { key: 'ETIMS_BRANCH_ID' },
    );
  }
  if (!DEVICE_SERIAL_PATTERN.test(deviceSerial)) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      'ETIMS_DEVICE_SERIAL must be 4–32 alphanumeric/dash characters (e.g. MOVA22)',
      { key: 'ETIMS_DEVICE_SERIAL' },
    );
  }

  const bandSize = intFromEnv(env, 'ETIMS_BAND_SIZE', DEFAULT_BAND_SIZE, MAX_BAND_SIZE);
  const lowWatermark = intFromEnv(env, 'ETIMS_LOW_WATERMARK', DEFAULT_LOW_WATERMARK, MAX_BAND_SIZE);
  const maxReservation = intFromEnv(env, 'ETIMS_MAX_RESERVATION', DEFAULT_MAX_RESERVATION, MAX_MAX_RESERVATION);

  if (maxReservation > bandSize) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `ETIMS_MAX_RESERVATION (${maxReservation}) must not exceed ETIMS_BAND_SIZE (${bandSize}) — a burst larger than one band can never be served`,
    );
  }
  if (lowWatermark > bandSize) {
    throw new DomainError(
      ETIMS_ERRORS.CONFIG_INVALID,
      `ETIMS_LOW_WATERMARK (${lowWatermark}) must not exceed ETIMS_BAND_SIZE (${bandSize})`,
    );
  }

  return { baseUrl, tin, branchId, deviceSerial, cmcKey, bandSize, lowWatermark, maxReservation };
};

/** The loggable view of the config — the credential is masked, always. */
export interface RedactedEtimsConfig {
  readonly baseUrl: string;
  readonly tin: string;
  readonly branchId: string;
  readonly deviceSerial: string;
  readonly cmcKey: string;
  readonly bandSize: number;
  readonly lowWatermark: number;
  readonly maxReservation: number;
}

/** Mask a secret to a fixed placeholder — the value never survives. */
export const redactEtimsConfig = (config: EtimsConfig): RedactedEtimsConfig => ({
  baseUrl: config.baseUrl,
  tin: config.tin,
  branchId: config.branchId,
  deviceSerial: config.deviceSerial,
  cmcKey: '***redacted***',
  bandSize: config.bandSize,
  lowWatermark: config.lowWatermark,
  maxReservation: config.maxReservation,
});

/**
 * Validated clock read for the adapter — same discipline as the domain port:
 * a broken clock is a stable refusal, never a wall-clock fallback.
 */
export const assertEtimsClock = (clock: Clock): Date => {
  if (!clock || typeof clock.now !== 'function') {
    throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `clock.now() must return a valid Date, got ${String(now)}`);
  }
  return now;
};
