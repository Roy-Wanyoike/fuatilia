import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import { ETIMS_ERRORS, refusedResultCode } from './codes';
import { parseVsdcBandGrantResponse, resultDtToDate, sequenceFromWire } from './wire';

// --- fixtures ---------------------------------------------------------------

const ISO = (from: number | string, to: number | string): string =>
  JSON.stringify({
    resultCd: '000',
    resultMsg: 'band granted',
    resultDt: '20260615100000',
    data: { grantId: 'GRANT-2026-00001', from: String(from), to: String(to) },
  });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- transport status gate ----------------------------------------------------

describe('parseVsdcBandGrantResponse — transport status mapping', () => {
  it('maps credential rejection, rate limiting and outage to stable retryability', () => {
    expectCode(() => parseVsdcBandGrantResponse(401, '{}', 500), ETIMS_ERRORS.VSDC_AUTH_REJECTED);
    expectCode(() => parseVsdcBandGrantResponse(403, '{}', 500), ETIMS_ERRORS.VSDC_AUTH_REJECTED);
    expectCode(() => parseVsdcBandGrantResponse(429, '{}', 500), ETIMS_ERRORS.VSDC_RATE_LIMITED);
    expectCode(() => parseVsdcBandGrantResponse(500, '{}', 500), ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE);
    expectCode(() => parseVsdcBandGrantResponse(503, '{}', 500), ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE);
  });

  it('never inspects a body that failed at the transport layer', () => {
    // a credential rejection with garbage in the body is still AUTH_REJECTED
    expectCode(() => parseVsdcBandGrantResponse(401, '<html>login</html>', 500), ETIMS_ERRORS.VSDC_AUTH_REJECTED);
  });
});

// --- the K1 gate ----------------------------------------------------------------

describe('parseVsdcBandGrantResponse — K1 untrusted-input refusal table', () => {
  it('accepts the pinned success vector (resultCd 000, padded decimal strings)', () => {
    const success = parseVsdcBandGrantResponse(200, ISO(1, 500), 500);
    expect(success.grant).toEqual({ grantId: 'GRANT-2026-00001', from: 1, to: 500 });
    expect(success.resultCd).toBe('000');
    expect(success.resultMsg).toBe('band granted');
    expect(success.resultDt).toBe('20260615100000');
    // 10:00:00 EAT == 07:00:00Z
    expect(success.resultDate.toISOString()).toBe('2026-06-15T07:00:00.000Z');
  });

  it('accepts both documented success result codes (000 and 0000)', () => {
    const legacy = JSON.stringify({
      resultCd: '0000',
      resultMsg: 'ok',
      resultDt: '20260101000000',
      data: { grantId: 'GRANT-7-ABCDEF', from: '1', to: '100' },
    });
    expect(parseVsdcBandGrantResponse(200, legacy, 100).grant.from).toBe(1);
  });

  it('refuses KRA business result codes with a stable per-code identity', () => {
    const body = JSON.stringify({ resultCd: '013', resultMsg: 'device not active', resultDt: '20260615100000' });
    expectCode(() => parseVsdcBandGrantResponse(200, body, 500), refusedResultCode('013'));
    expect(refusedResultCode('013')).toBe('ETIMS_VSDC_REFUSED_013');
  });

  it('refuses the whole malformed-envelope table (never half-trusted)', () => {
    const table: Array<[string, string]> = [
      ['non-JSON body', '<html>gateway error</html>'],
      ['JSON array envelope', '[1,2,3]'],
      ['missing resultCd', JSON.stringify({ resultMsg: 'x', resultDt: '20260615100000' })],
      ['two-digit resultCd', JSON.stringify({ resultCd: '00', resultMsg: 'x', resultDt: '20260615100000' })],
      ['five-digit resultCd', JSON.stringify({ resultCd: '00000', resultMsg: 'x', resultDt: '20260615100000' })],
      ['numeric resultCd', JSON.stringify({ resultCd: 0, resultMsg: 'x', resultDt: '20260615100000' })],
      ['missing resultMsg', JSON.stringify({ resultCd: '000', resultDt: '20260615100000' })],
      ['numeric resultMsg', JSON.stringify({ resultCd: '000', resultMsg: 7, resultDt: '20260615100000' })],
      ['missing resultDt', JSON.stringify({ resultCd: '000', resultMsg: 'x' })],
      ['short resultDt', JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615' })],
      ['month 13', JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20261301100000' })],
      ['Feb 30 rolls over', JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260230100000' })],
      ['second 60', JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100060' })],
      ['success without data', JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000' })],
      [
        'data not an object',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: [1] }),
      ],
      [
        'missing grantId',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: { from: '1', to: '500' } }),
      ],
      [
        'grantId too short',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: { grantId: 'ab', from: '1', to: '500' } }),
      ],
      [
        'grantId with space',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: { grantId: 'GRANT 1', from: '1', to: '500' } }),
      ],
      [
        'missing from',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: { grantId: 'GRANT-1-ABCDEF', to: '500' } }),
      ],
      [
        'inverted band',
        JSON.stringify({ resultCd: '000', resultMsg: 'x', resultDt: '20260615100000', data: { grantId: 'GRANT-1-ABCDEF', from: '500', to: '1' } }),
      ],
    ];
    for (const [label, body] of table) {
      try {
        parseVsdcBandGrantResponse(200, body, 500);
        throw new Error(`expected refusal for: ${label}`);
      } catch (err) {
        expect(err, label).toBeInstanceOf(DomainError);
        expect((err as DomainError).code, label).toBe(ETIMS_ERRORS.VSDC_WIRE_MALFORMED);
      }
    }
  });

  it('refuses a grant that does not cover exactly the requested count', () => {
    expectCode(() => parseVsdcBandGrantResponse(200, ISO(1, 300), 500), ETIMS_ERRORS.VSDC_BAND_SIZE_MISMATCH);
    expectCode(() => parseVsdcBandGrantResponse(200, ISO(1, 501), 500), ETIMS_ERRORS.VSDC_BAND_SIZE_MISMATCH);
  });

  it('refuses float-shaped and out-of-field grant sequences (exact integer discipline)', () => {
    const table: Array<string | number> = [
      1, // JSON number, not a decimal string
      '1.0', // fractional form
      '1.5', // float
      '1e3', // exponent
      ' 1', // leading space
      '1 ', // trailing space
      '+1', // sign
      '-1', // sign
      '', // empty
      '0', // below the 1-based sequence field
      '100000000', // 9 digits — past the 8-digit field
      '000000001', // 9 digits with padding
      '12a', // non-decimal
    ];
    for (const from of table) {
      const body = JSON.stringify({
        resultCd: '000',
        resultMsg: 'x',
        resultDt: '20260615100000',
        data: { grantId: 'GRANT-1-ABCDEF', from, to: '500' },
      });
      expectCode(() => parseVsdcBandGrantResponse(200, body, 500), ETIMS_ERRORS.VSDC_WIRE_MALFORMED);
    }
  });

  it('refuses an out-of-range requestedCount without touching the body', () => {
    for (const count of [0, -1, 1.5, Number.NaN]) {
      expectCode(() => parseVsdcBandGrantResponse(200, ISO(1, 500), count), ETIMS_ERRORS.VSDC_WIRE_MALFORMED);
    }
  });
});

// --- primitives -----------------------------------------------------------------

describe('sequenceFromWire — the exact-integer gate', () => {
  it('parses strict decimal strings exactly', () => {
    const table: Array<[string, number]> = [
      ['1', 1],
      ['00000042', 42],
      ['99999999', 99_999_999],
      ['00000001', 1],
    ];
    for (const [raw, value] of table) {
      expect(sequenceFromWire(raw, 'data.from')).toBe(value);
    }
  });

  it('refuses everything that is not a 1–8 digit decimal string in field', () => {
    const table: Array<unknown> = [
      42, // number
      null,
      undefined,
      true,
      '1.5',
      '1e3',
      '0',
      '-1',
      '+1',
      ' 1',
      '100000000',
      '',
      '000000001',
      'abc',
    ];
    for (const raw of table) {
      expectCode(() => sequenceFromWire(raw, 'data.from'), ETIMS_ERRORS.VSDC_WIRE_MALFORMED);
    }
  });
});

describe('resultDtToDate — EAT decode with calendar verification', () => {
  it('decodes Kenyan-local (EAT, UTC+3) timestamps to instants', () => {
    expect(resultDtToDate('20260615100000').toISOString()).toBe('2026-06-15T07:00:00.000Z');
    expect(resultDtToDate('20260101023005').toISOString()).toBe('2025-12-31T23:30:05.000Z');
  });

  it('refuses malformed and calendar-invalid timestamps', () => {
    const table: Array<unknown> = [
      undefined,
      null,
      20260615,
      '20260615', // too short
      '202606151000001', // too long
      '20261301100000', // month 13
      '20260001100000', // month 0
      '20260132100000', // day 32
      '20260231100000', // Feb 31 rolls over
      '20260615240000', // hour 24
      '20260615106000', // minute 60
      '20260615100060', // second 60
    ];
    for (const raw of table) {
      expectCode(() => resultDtToDate(raw), ETIMS_ERRORS.VSDC_WIRE_MALFORMED);
    }
  });
});
