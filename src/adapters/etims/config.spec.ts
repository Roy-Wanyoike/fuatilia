import { describe, expect, it } from 'vitest';
import { DomainError, type Clock } from '../../domain/shared';
import { ETIMS_ERRORS } from './codes';
import { DEFAULT_BAND_SIZE, DEFAULT_LOW_WATERMARK, DEFAULT_MAX_RESERVATION, assertEtimsClock, etimsConfigFromEnv, redactEtimsConfig, type EtimsConfig } from './config';

// --- fixtures ---------------------------------------------------------------

const SECRET = 'cmc-live-0001-do-not-leak';

const envOf = (pairs: Record<string, string>) => (key: string): string => pairs[key] ?? '';

const FULL_ENV: Record<string, string> = {
  ETIMS_VSDC_BASE_URL: 'https://etims-api.kra.go.ke/etims-api',
  ETIMS_TIN: 'P051234516X',
  ETIMS_BRANCH_ID: '00',
  ETIMS_DEVICE_SERIAL: 'MOVA22',
  ETIMS_VSDC_CMC_KEY: SECRET,
};

const expectConfigCode = (env: Record<string, string>, fragment: string): void => {
  try {
    etimsConfigFromEnv(envOf(env));
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(ETIMS_ERRORS.CONFIG_INVALID);
    expect((err as DomainError).message).toContain(fragment);
    return;
  }
  throw new Error(`expected ETIMS_CONFIG_INVALID mentioning "${fragment}", but nothing was thrown`);
};

// --- required credentials ------------------------------------------------------

describe('etimsConfigFromEnv — config-only credentials from the environment', () => {
  it('builds the config from a complete environment', () => {
    const config = etimsConfigFromEnv(envOf(FULL_ENV));
    expect(config.baseUrl).toBe('https://etims-api.kra.go.ke/etims-api');
    expect(config.tin).toBe('P051234516X');
    expect(config.branchId).toBe('00');
    expect(config.deviceSerial).toBe('MOVA22');
    expect(config.cmcKey).toBe(SECRET);
    expect(config.bandSize).toBe(DEFAULT_BAND_SIZE);
    expect(config.lowWatermark).toBe(DEFAULT_LOW_WATERMARK);
    expect(config.maxReservation).toBe(DEFAULT_MAX_RESERVATION);
  });

  it('trims values and normalizes trailing slashes + tin case', () => {
    const config = etimsConfigFromEnv(
      envOf({
        ...FULL_ENV,
        ETIMS_VSDC_BASE_URL: 'https://etims-api.kra.go.ke/etims-api///',
        ETIMS_TIN: 'p051234516x',
        ETIMS_BRANCH_ID: ' aa ',
        ETIMS_VSDC_CMC_KEY: `  ${SECRET}  `,
      }),
    );
    expect(config.baseUrl).toBe('https://etims-api.kra.go.ke/etims-api');
    expect(config.tin).toBe('P051234516X');
    expect(config.branchId).toBe('AA');
    expect(config.cmcKey).toBe(SECRET);
  });

  it('refuses missing credentials, naming every missing key', () => {
    const table: Array<[Record<string, string>, string]> = [
      [{}, 'ETIMS_VSDC_BASE_URL'],
      [{ ...FULL_ENV, ETIMS_TIN: '' }, 'ETIMS_TIN'],
      [{ ...FULL_ENV, ETIMS_BRANCH_ID: undefined! }, 'ETIMS_BRANCH_ID'],
      [{ ...FULL_ENV, ETIMS_DEVICE_SERIAL: ' ' }, 'ETIMS_DEVICE_SERIAL'],
      [{ ...FULL_ENV, ETIMS_VSDC_CMC_KEY: undefined! }, 'ETIMS_VSDC_CMC_KEY'],
    ];
    for (const [env, key] of table) {
      expectConfigCode(env, key);
    }
  });

  it('refuses a non-https base URL — credentials never travel in cleartext', () => {
    expectConfigCode({ ...FULL_ENV, ETIMS_VSDC_BASE_URL: 'http://etims-api.kra.go.ke' }, 'https');
  });

  it('refuses malformed taxpayer identity fields', () => {
    const table: Array<[string, string]> = [
      ['P123', 'ETIMS_TIN'], // too short
      ['P051234516', 'ETIMS_TIN'], // no trailing letter
      ['0051234516X', 'ETIMS_TIN'], // digits first
      ['P051234516XX', 'ETIMS_TIN'], // too long
      ['P05123451xX', 'ETIMS_TIN'], // digit position holds a letter
      ['0000', 'ETIMS_BRANCH_ID'], // 4 chars
      ['0 0', 'ETIMS_BRANCH_ID'], // internal space
      ['MO', 'ETIMS_DEVICE_SERIAL'], // too short
      ['device serial with spaces', 'ETIMS_DEVICE_SERIAL'],
    ];
    for (const [value, key] of table) {
      expectConfigCode({ ...FULL_ENV, [key]: value }, key);
    }
    // the 1–3 character branch rule accepts single-digit branches
    expect(etimsConfigFromEnv(envOf({ ...FULL_ENV, ETIMS_BRANCH_ID: '0' })).branchId).toBe('0');
    // any leading uppercase letter is a valid PIN shape
    expect(etimsConfigFromEnv(envOf({ ...FULL_ENV, ETIMS_TIN: 'Q051234516X' })).tin).toBe('Q051234516X');
  });
});

// --- sizing knobs (exact integer discipline) -------------------------------------

describe('etimsConfigFromEnv — exact-integer sizing knobs', () => {
  it('accepts explicit integer knobs', () => {
    const config = etimsConfigFromEnv(
      envOf({
        ...FULL_ENV,
        ETIMS_BAND_SIZE: '1000',
        ETIMS_LOW_WATERMARK: '250',
        ETIMS_MAX_RESERVATION: '500',
      }),
    );
    expect(config.bandSize).toBe(1000);
    expect(config.lowWatermark).toBe(250);
    expect(config.maxReservation).toBe(500);
  });

  it('refuses float, signed, exponential and zero knobs — never rounds', () => {
    const table = ['500.5', '500.0', '-3', '1e3', '0', '1_000', ' fifty '];
    for (const value of table) {
      expectConfigCode({ ...FULL_ENV, ETIMS_BAND_SIZE: value }, 'ETIMS_BAND_SIZE');
    }
  });

  it('refuses self-inconsistent sizing', () => {
    expectConfigCode({ ...FULL_ENV, ETIMS_MAX_RESERVATION: '501' }, 'ETIMS_MAX_RESERVATION'); // > bandSize 500
    expectConfigCode({ ...FULL_ENV, ETIMS_LOW_WATERMARK: '501' }, 'ETIMS_LOW_WATERMARK'); // > bandSize 500
    expectConfigCode({ ...FULL_ENV, ETIMS_BAND_SIZE: '100001' }, 'ETIMS_BAND_SIZE'); // hard cap
    expectConfigCode({ ...FULL_ENV, ETIMS_MAX_RESERVATION: '10001' }, 'ETIMS_MAX_RESERVATION'); // hard cap
  });
});

// --- redaction ------------------------------------------------------------------

describe('redactEtimsConfig — the only sanctioned loggable view', () => {
  it('masks the credential and nothing else', () => {
    const config: EtimsConfig = etimsConfigFromEnv(envOf(FULL_ENV));
    const redacted = redactEtimsConfig(config);
    expect(redacted.cmcKey).toBe('***redacted***');
    expect(redacted.tin).toBe(config.tin);
    expect(redacted.baseUrl).toBe(config.baseUrl);
    expect(redacted.bandSize).toBe(config.bandSize);
  });

  it('never leaks the secret through serialization', () => {
    const config = etimsConfigFromEnv(envOf(FULL_ENV));
    expect(JSON.stringify(redactEtimsConfig(config))).not.toContain(SECRET);
  });
});

// --- clock guard ------------------------------------------------------------------

describe('assertEtimsClock — the injected clock is validated, never bypassed', () => {
  it('accepts a working clock', () => {
    const clock: Clock = { now: () => new Date('2026-06-15T10:00:00.000Z') };
    expect(assertEtimsClock(clock).toISOString()).toBe('2026-06-15T10:00:00.000Z');
  });

  it('refuses broken clocks with the domain-shared code', () => {
    const table: Array<[Clock, string]> = [
      [{ now: () => new Date('never') }, 'valid Date'],
      [{ now: () => undefined as unknown as Date }, 'valid Date'],
      [undefined as unknown as Clock, 'now()'],
      [{} as unknown as Clock, 'now()'],
    ];
    for (const [clock] of table) {
      try {
        assertEtimsClock(clock);
        throw new Error('expected ETIMS_CLOCK_INVALID, but nothing was thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
        expect((err as DomainError).code).toBe(ETIMS_ERRORS.CLOCK_INVALID);
      }
    }
  });
});
