import { describe, expect, it } from 'vitest';
import type { Clock } from '../../domain/shared';
import { DomainError } from '../../domain/shared';
import { ETIMS_ERRORS } from './codes';
import { buildBandGrantRequest, createRequestIdMinter, createVsdcSequenceClient, vsdcPostFromGlobalFetch, type VsdcBandRequest, type VsdcPost } from './client';
import { etimsConfigFromEnv, type EtimsConfig } from './config';

// --- fixtures ---------------------------------------------------------------

const SECRET = 'cmc-secret-0001-never-leak';

const makeConfig = (overrides?: Partial<EtimsConfig>): EtimsConfig => ({
  baseUrl: 'https://etims-api-sbx.kra.go.ke',
  tin: 'P000000045R',
  branchId: '00',
  deviceSerial: 'MOVA22',
  cmcKey: SECRET,
  bandSize: 500,
  lowWatermark: 100,
  maxReservation: 100,
  ...overrides,
});

const BAND_REQ: VsdcBandRequest = { year: 2026, count: 500, afterSeq: 0, requestId: 'etims-band-20260615100000-0001' };

const grantBody = (from: number | string, to: number | string, resultCd = '000'): string =>
  JSON.stringify({
    resultCd,
    resultMsg: 'band granted',
    resultDt: '20260615100000',
    data: { grantId: 'GRANT-2026-00001', from: String(from), to: String(to) },
  });

interface RecordedCall {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

type ScriptedResponse = { status: number; body: string } | { throws: Error };

const scriptedPost = (script: ScriptedResponse[]): { post: VsdcPost; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const queue = [...script];
  const post: VsdcPost = async (url, init) => {
    calls.push({ url, headers: { ...init.headers }, body: init.body });
    const next = queue.shift();
    if (next === undefined) throw new Error('script exhausted');
    if ('throws' in next) throw next.throws;
    return { status: next.status, body: next.body };
  };
  return { post, calls };
};

const CLOCK: Clock = { now: () => new Date('2026-06-15T10:00:00.000Z') };

// --- request building -----------------------------------------------------------

describe('buildBandGrantRequest — the wire ask (pure)', () => {
  it('posts JSON to the VSDC sequence-band endpoint with bearer credential', () => {
    const config = makeConfig();
    const { url, init } = buildBandGrantRequest(config, BAND_REQ);
    expect(url).toBe('https://etims-api-sbx.kra.go.ke/vsdc/sequenceBandReserve');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['Accept']).toBe('application/json');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);

    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toEqual({
      tin: 'P000000045R',
      bhfId: '00',
      dvcSrlNo: 'MOVA22',
      year: 2026,
      count: 500,
      afterSeq: 0,
      requestId: BAND_REQ.requestId,
    });
  });

  it('never puts the credential in the body or URL', () => {
    const { url, init } = buildBandGrantRequest(makeConfig(), BAND_REQ);
    expect(url).not.toContain(SECRET);
    expect(init.body).not.toContain(SECRET);
  });

  it('refuses malformed band requests before anything leaves the process', () => {
    const table: Array<[VsdcBandRequest, string]> = [
      [{ ...BAND_REQ, year: 999 }, 'year'],
      [{ ...BAND_REQ, year: 2026.5 }, 'year'],
      [{ ...BAND_REQ, count: 0 }, 'band count'],
      [{ ...BAND_REQ, count: 501 }, 'band count'], // > bandSize 500
      [{ ...BAND_REQ, count: 100.5 }, 'band count'],
      [{ ...BAND_REQ, afterSeq: -1 }, 'afterSeq'],
      [{ ...BAND_REQ, afterSeq: 100000000 }, 'afterSeq'],
      [{ ...BAND_REQ, requestId: 'x' }, 'requestId'],
      [{ ...BAND_REQ, requestId: 'has space' }, 'requestId'],
    ];
    for (const [req] of table) {
      try {
        buildBandGrantRequest(makeConfig(), req);
        throw new Error('expected refusal, but nothing was thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DomainError);
      }
    }
  });
});

// --- the boundary client ---------------------------------------------------------

describe('createVsdcSequenceClient — every wire failure is a typed refusal value', () => {
  it('folds a successful grant into the typed success value', async () => {
    const { post } = scriptedPost([{ status: 200, body: grantBody('00000001', '00000500') }]);
    const client = createVsdcSequenceClient(makeConfig(), post);
    const result = await client.registerSequenceBand(BAND_REQ);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.grant).toEqual({ grantId: 'GRANT-2026-00001', from: 1, to: 500 });
      expect(result.resultCd).toBe('000');
      expect(result.resultDate.toISOString()).toBe('2026-06-15T07:00:00.000Z');
    }
  });

  it('maps transport statuses to stable retryability', async () => {
    const table: Array<[ScriptedResponse, string, boolean]> = [
      [{ status: 401, body: 'denied' }, ETIMS_ERRORS.VSDC_AUTH_REJECTED, false],
      [{ status: 403, body: 'forbidden' }, ETIMS_ERRORS.VSDC_AUTH_REJECTED, false],
      [{ status: 429, body: 'slow down' }, ETIMS_ERRORS.VSDC_RATE_LIMITED, true],
      [{ status: 500, body: 'boom' }, ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE, true],
      [{ status: 503, body: 'maintenance' }, ETIMS_ERRORS.VSDC_PROVIDER_OUTAGE, true],
      [{ status: 200, body: 'not json' }, ETIMS_ERRORS.VSDC_WIRE_MALFORMED, false],
    ];
    for (const [response, code, retryable] of table) {
      const { post } = scriptedPost([response]);
      const client = createVsdcSequenceClient(makeConfig(), post);
      const result = await client.registerSequenceBand(BAND_REQ);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(code);
        expect(result.retryable).toBe(retryable);
      }
    }
  });

  it('maps a thrown transport to a retryable network refusal', async () => {
    const { post } = scriptedPost([{ throws: new Error('getaddrinfo ENOTFOUND etims-api.kra.go.ke') }]);
    const client = createVsdcSequenceClient(makeConfig(), post);
    const result = await client.registerSequenceBand(BAND_REQ);
    expect(result).toMatchObject({
      ok: false,
      code: ETIMS_ERRORS.VSDC_NETWORK_ERROR,
      retryable: true,
      resultMsg: 'getaddrinfo ENOTFOUND etims-api.kra.go.ke',
    });
  });

  it('classifies KRA business refusals as permanent unless configured transient', async () => {
    const refused = (resultCd: string): ScriptedResponse => ({ status: 200, body: grantBody(1, 500, resultCd) });

    const { post: strictPost } = scriptedPost([refused('013')]);
    const strictClient = createVsdcSequenceClient(makeConfig(), strictPost);
    const strict = await strictClient.registerSequenceBand(BAND_REQ);
    expect(strict).toMatchObject({ ok: false, code: 'ETIMS_VSDC_REFUSED_013', retryable: false, resultCd: '013' });

    const { post: lenientPost } = scriptedPost([refused('099')]);
    const lenientClient = createVsdcSequenceClient(makeConfig(), lenientPost, { retryableResultCds: new Set(['099']) });
    const lenient = await lenientClient.registerSequenceBand(BAND_REQ);
    expect(lenient).toMatchObject({ ok: false, code: 'ETIMS_VSDC_REFUSED_099', retryable: true });
  });

  it('carries a size-mismatched grant as a permanent refusal', async () => {
    const { post } = scriptedPost([{ status: 200, body: grantBody('00000001', '00000300') }]); // 300 ≠ 500
    const client = createVsdcSequenceClient(makeConfig(), post);
    const result = await client.registerSequenceBand(BAND_REQ);
    expect(result).toMatchObject({ ok: false, code: ETIMS_ERRORS.VSDC_BAND_SIZE_MISMATCH, retryable: false });
  });

  it('never leaks the credential through any refusal path', async () => {
    const scripts: ScriptedResponse[][] = [
      [{ status: 401, body: 'denied' }],
      [{ status: 200, body: '<html>' }],
      [{ throws: new Error('socket hang up') }],
      [{ status: 200, body: grantBody(1, 500, '013') }],
    ];
    for (const script of scripts) {
      const { post } = scriptedPost(script);
      const client = createVsdcSequenceClient(makeConfig(), post);
      const result = await client.registerSequenceBand(BAND_REQ);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });
});

// --- production wiring ------------------------------------------------------------

describe('vsdcPostFromGlobalFetch — the global-fetch wiring (no new deps)', () => {
  it('posts JSON bodies through fetch and unwraps status+text', async () => {
    const calls: Array<{ input: unknown; init: unknown }> = [];
    const fakeFetch = (async (input: unknown, init: unknown) => {
      calls.push({ input, init });
      return { status: 200, text: async () => grantBody(1, 500) };
    }) as unknown as typeof fetch;
    const post = vsdcPostFromGlobalFetch(fakeFetch, 5_000);
    const wire = await post('https://etims-api-sbx.kra.go.ke/vsdc/sequenceBandReserve', {
      headers: { 'Content-Type': 'application/json' },
      body: '{"tin":"P000000045R"}',
    });
    expect(wire.status).toBe(200);
    expect(wire.body).toContain('band granted');
    const init = calls[0]?.init as { method: string; body: string };
    expect(init.method).toBe('POST');
    expect(init.body).toContain('P000000045R');
  });

  it('refuses a runtime without fetch', () => {
    expect(() => vsdcPostFromGlobalFetch(42 as unknown as typeof fetch)).toThrow(DomainError);
  });
});

// --- request-id minting ------------------------------------------------------------

describe('createRequestIdMinter — deterministic, clock-driven idempotency keys', () => {
  it('mints monotonic ids from the injected clock', () => {
    const mint = createRequestIdMinter(CLOCK);
    const first = mint();
    const second = mint();
    expect(first).toBe('etims-band-20260615100000-0001');
    expect(second).toBe('etims-band-20260615100000-0002');
    expect(new Set([first, second]).size).toBe(2);
  });

  it('refuses a broken clock at construction', () => {
    expect(() => createRequestIdMinter({ now: () => new Date('nope') })).toThrow(DomainError);
  });
});

// --- config smoke (the client consumes etimsConfigFromEnv) ---------------------------

describe('config → client integration', () => {
  it('builds the client from env config and reaches the configured base URL', async () => {
    const config = etimsConfigFromEnv((key) =>
      key === 'ETIMS_VSDC_BASE_URL'
        ? 'https://etims-api.kra.go.ke/etims-api'
        : key === 'ETIMS_TIN'
          ? 'P051234516X'
          : key === 'ETIMS_BRANCH_ID'
            ? '00'
            : key === 'ETIMS_DEVICE_SERIAL'
              ? 'MOVA22'
              : key === 'ETIMS_VSDC_CMC_KEY'
                ? SECRET
                : '',
    );
    const { post, calls } = scriptedPost([{ status: 200, body: grantBody(1, 500) }]);
    const client = createVsdcSequenceClient(config, post);
    const result = await client.registerSequenceBand({ ...BAND_REQ, count: 500 });
    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe('https://etims-api.kra.go.ke/etims-api/vsdc/sequenceBandReserve');
  });
});
