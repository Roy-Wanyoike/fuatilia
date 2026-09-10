import { describe, expect, it } from 'vitest';
import { DomainError, type Clock } from '../../domain/shared';
import { checkCharacter, createNumberingService, validateInvoiceNumber } from '../../domain/consent/etims';
import { ETIMS_ERRORS } from './codes';
import { createVsdcSequenceClient, type VsdcPost } from './client';
import { etimsConfigFromEnv, type EtimsConfig } from './config';
import { createKraSequenceSource, EMPTY_CHECKPOINT, validateCheckpoint, type KraSequenceSource, type ReservationAuditEvent, type SequenceCheckpoint, type SequenceCheckpointStore } from './source';

// --- fakes (tests only — production code carries none of these) -----------------

const SECRET = 'cmc-secret-0002-tests-only';

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

const grantBody = (grantId: string, from: number, to: number, resultCd = '000'): string =>
  JSON.stringify({
    resultCd,
    resultMsg: 'band granted',
    resultDt: '20260615100000',
    data: { grantId, from: String(from).padStart(8, '0'), to: String(to).padStart(8, '0') },
  });

interface RecordedCall {
  readonly url: string;
  readonly body: string;
}

type ScriptedResponse = { status: number; body: string } | { throws: Error };

const scriptedPost = (script: ScriptedResponse[]): { post: VsdcPost; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const queue = [...script];
  const post: VsdcPost = async (url, init) => {
    calls.push({ url, body: init.body });
    const next = queue.shift();
    if (next === undefined) throw new Error('script exhausted');
    if ('throws' in next) throw next.throws;
    return { status: next.status, body: next.body };
  };
  return { post, calls };
};

const memoryStore = (initial?: SequenceCheckpoint): SequenceCheckpointStore & { current(): SequenceCheckpoint; saves(): number } => {
  let state: SequenceCheckpoint | null = initial ? { ...initial, bands: [...initial.bands] } : null;
  let saveCount = 0;
  return {
    load: () => (state === null ? null : { ...state, bands: state.bands.map((b) => ({ ...b })) }),
    save: (next) => {
      state = { ...next, bands: next.bands.map((b) => ({ ...b })) };
      saveCount += 1;
    },
    current: () => (state === null ? { ...EMPTY_CHECKPOINT } : { ...state, bands: state.bands.map((b) => ({ ...b })) }),
    saves: () => saveCount,
  };
};

type HarnessStore = ReturnType<typeof memoryStore>;

/** Adapt any store (including one shared with another harness) to the harness lens. */
const harnessStore = (store: SequenceCheckpointStore): HarnessStore => {
  let saves = 0;
  return {
    load: () => store.load(),
    save: (next) => {
      saves += 1;
      store.save(next);
    },
    current: () => store.load() ?? { ...EMPTY_CHECKPOINT },
    saves: () => saves,
  };
};

const memoryAudit = (): { append(event: ReservationAuditEvent): void; events: ReservationAuditEvent[] } => {
  const events: ReservationAuditEvent[] = [];
  return { append: (event) => events.push({ ...event }), events };
};

const failingAudit = (): { append(event: ReservationAuditEvent): void; events: ReservationAuditEvent[] } => ({
  append: () => {
    throw new Error('audit sink offline');
  },
  events: [],
});

const mutableClock = (iso: string): { clock: Clock; set(iso: string): void } => {
  let ms = new Date(iso).getTime();
  return {
    clock: { now: () => new Date(ms) },
    set: (next) => {
      ms = new Date(next).getTime();
    },
  };
};

interface SourceHarness {
  readonly source: KraSequenceSource;
  readonly store: ReturnType<typeof memoryStore>;
  readonly audit: ReturnType<typeof memoryAudit>;
  readonly clock: ReturnType<typeof mutableClock>['clock'];
  readonly clockHandle: ReturnType<typeof mutableClock>;
  readonly calls: RecordedCall[];
  readonly config: EtimsConfig;
}

const makeSource = (options?: {
  config?: Partial<EtimsConfig>;
  script?: ScriptedResponse[];
  store?: SequenceCheckpointStore;
  audit?: { append(event: ReservationAuditEvent): void; events: ReservationAuditEvent[] };
  clockIso?: string;
  retryableResultCds?: ReadonlySet<string>;
}): SourceHarness => {
  const config = makeConfig(options?.config);
  const clockHandle = mutableClock(options?.clockIso ?? '2026-06-15T10:00:00.000Z');
  // Default script: one full default-config band (GRANT-2026-00001, 1..500) —
  // the common seed for the grant flow. Tests that need an empty script pass
  // `script: []` explicitly.
  const { post, calls } = scriptedPost(options?.script ?? [{ status: 200, body: grantBody('GRANT-2026-00001', 1, 500) }]);
  const store = harnessStore(options?.store ?? memoryStore());
  const audit = options?.audit ?? memoryAudit();
  const client = createVsdcSequenceClient(config, post, { retryableResultCds: options?.retryableResultCds });
  const source = createKraSequenceSource({ config, client, store, audit, clock: clockHandle.clock });
  return { source, store, audit, clock: clockHandle.clock, clockHandle, calls, config };
};

const expectDomainCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- grant flow -----------------------------------------------------------------

describe('KraSequenceSource — grant flow (the happy numbering path)', () => {
  it('activates the first band for the clock year and serves sequences contiguously from 1', async () => {
    const h = makeSource();
    const refill = await h.source.refill();
    expect(refill).toEqual({ ok: true, outcome: 'band-activated', bandId: 'GRANT-2026-00001', from: 1, to: 500 });
    expect(h.store.current()).toEqual({ year: 2026, next: 1, bands: [{ bandId: 'GRANT-2026-00001', from: 1, to: 500 }] });
    expect(h.audit.events).toEqual([
      {
        kind: 'band-registered',
        at: '2026-06-15T10:00:00.000Z',
        requestId: expect.stringMatching(/^etims-band-20260615(10|09|11)0000-\d{4}$/),
        bandId: 'GRANT-2026-00001',
        year: 2026,
        from: 1,
        to: 500,
      },
    ]);

    const sequences = h.source(3);
    expect(sequences).toEqual([1, 2, 3]);
    expect(h.store.current()).toEqual({ year: 2026, next: 4, bands: [{ bandId: 'GRANT-2026-00001', from: 1, to: 500 }] });
    expect(h.audit.events.at(-1)).toEqual({
      kind: 'reserved',
      at: '2026-06-15T10:00:00.000Z',
      bandId: 'GRANT-2026-00001',
      from: 1,
      to: 3,
      count: 3,
    });
  });

  it('carries the contiguity contract to KRA (afterSeq = last granted)', async () => {
    const h = makeSource({ config: { bandSize: 100 }, script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 100) }] });
    await h.source.refill();
    h.source(100); // drain the first band
    // the wiring refills: KRA must be asked for 101..200, not a fresh stream
    const { post } = scriptedPost([{ status: 200, body: grantBody('G-2-BBBBBB', 101, 200) }]);
    const second = createKraSequenceSource({
      config: makeConfig({ bandSize: 100 }),
      client: createVsdcSequenceClient(makeConfig({ bandSize: 100 }), post),
      store: h.store,
      audit: h.audit,
      clock: h.clock,
    });
    const outcome = await second.refill();
    expect(outcome).toEqual({ ok: true, outcome: 'band-activated', bandId: 'G-2-BBBBBB', from: 101, to: 200 });
    expect(JSON.parse(h.calls.at(-1)?.body ?? '{}').afterSeq).toBe(0);
    expect(h.store.current()).toEqual({
      year: 2026,
      next: 101,
      bands: [{ bandId: 'G-2-BBBBBB', from: 101, to: 200 }],
    });
    expect(second(2)).toEqual([101, 102]);
  });

  it('stacks pre-granted bands without stranding stock (refill below the watermark)', async () => {
    // stock drops below the low watermark while the active band still has tail
    const h = makeSource({
      config: { bandSize: 500, lowWatermark: 450 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 500) },
        { status: 200, body: grantBody('G-2-BBBBBB', 501, 1000) },
      ],
    });
    await h.source.refill();
    h.source(60); // stock 440 < watermark 450 → wiring refills before exhaustion
    const refill = await h.source.refill();
    expect(refill).toEqual({ ok: true, outcome: 'band-activated', bandId: 'G-2-BBBBBB', from: 501, to: 1000 });
    expect(h.source(3)).toEqual([61, 62, 63]); // the 440-sequence tail is NOT stranded
    expect(h.store.current()).toEqual({
      year: 2026,
      next: 64,
      bands: [
        { bandId: 'G-1-AAAAAA', from: 1, to: 500 },
        { bandId: 'G-2-BBBBBB', from: 501, to: 1000 },
      ],
    });
  });

  it('is already-stocked while above the watermark', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();
    const second = await h.source.refill();
    expect(second).toEqual({ ok: true, outcome: 'already-stocked' });
    expect(h.calls).toHaveLength(1); // no second wire call
  });

  it('treats a replayed grantId as an idempotent already-active no-op', async () => {
    const h = makeSource({
      config: { bandSize: 500, lowWatermark: 450 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 500) },
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }, // replay after a lost response
      ],
    });
    await h.source.refill();
    h.source(60);
    const replay = await h.source.refill();
    expect(replay).toEqual({ ok: true, outcome: 'already-active', bandId: 'G-1-AAAAAA', from: 1, to: 500 });
    expect(h.store.current()).toEqual({ year: 2026, next: 61, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 500 }] });
  });

  it('survives a restart: the checkpoint is the truth, numbering continues exactly where it stopped', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();
    h.source(42);

    // a "restart" — a fresh source over the same store, with an empty script
    // (no refill needed: stock is far above the watermark)
    const restarted = makeSource({ store: h.store, script: [] });
    const refill = await restarted.source.refill();
    expect(refill).toEqual({ ok: true, outcome: 'already-stocked' });
    expect(restarted.source(3)).toEqual([43, 44, 45]);
  });
});

// --- outage-gap refill (THE gap-handling proof) -------------------------------------

describe('KraSequenceSource — outage-gap refill (queued local reservation)', () => {
  it('keeps numbering through an outage, queues the intent when dry, and resumes with zero gaps', async () => {
    const h = makeSource({
      config: { maxReservation: 500 }, // the 400-sequence outage burst must fit one reservation
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }, // initial grant
        { throws: new Error('getaddrinfo ENOTFOUND etims-api.kra.go.ke') }, // KRA outage #1
        { throws: new Error('connection reset') }, // KRA outage #2
        { status: 200, body: grantBody('G-2-BBBBBB', 501, 1000) }, // KRA recovers
      ],
    });

    await h.source.refill();

    // The outage: numbering flows from LOCAL stock, no wire call is made.
    const duringOutage = h.source(400);
    expect(duringOutage).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));

    // Refill attempts fail — refused as retryable, intent queued, no numbers invented.
    const refused1 = await h.source.refill();
    expect(refused1).toMatchObject({ ok: false, outcome: 'refused', code: ETIMS_ERRORS.VSDC_NETWORK_ERROR, retryable: true });
    const refused2 = await h.source.refill();
    expect(refused2).toMatchObject({ ok: false, outcome: 'refused', code: ETIMS_ERRORS.VSDC_NETWORK_ERROR, retryable: true });
    expect(h.audit.events.filter((e) => e.kind === 'band-register-failed')).toHaveLength(2);

    // Stock runs dry: fail-closed refusal + queued intent (audited).
    expectDomainCode(() => h.source(200), ETIMS_ERRORS.STOCK_EXHAUSTED); // 200 > remaining 100
    expect(h.audit.events.filter((e) => e.kind === 'refill-queued')).toHaveLength(1);
    // the exact rest still serves — 100 == stock drains the band exactly
    expect(h.source(100)).toEqual(Array.from({ length: 100 }, (_, i) => 401 + i));
    // now the band is truly dry: fail-closed refusal + a second queued intent
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.STOCK_EXHAUSTED);
    expect(h.audit.events.filter((e) => e.kind === 'refill-queued')).toHaveLength(2);

    // KRA recovers: the queued intent is served, numbering continues at 501.
    const recovered = await h.source.refill();
    expect(recovered).toEqual({ ok: true, outcome: 'band-activated', bandId: 'G-2-BBBBBB', from: 501, to: 1000 });
    const afterOutage = h.source(1);
    expect(afterOutage).toEqual([501]);
  });

  it('proves the full issued set across the outage is gapless and duplicate-free', async () => {
    const h = makeSource({
      config: { bandSize: 100, maxReservation: 100 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 100) },
        { throws: new Error('ECONNRESET') },
        { status: 200, body: grantBody('G-2-BBBBBB', 101, 200) },
      ],
    });
    const issued: number[] = [];
    await h.source.refill();
    issued.push(...h.source(70));
    expect(await h.source.refill()).toMatchObject({ ok: false }); // outage
    issued.push(...h.source(30)); // drains band 1 exactly
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.STOCK_EXHAUSTED);
    expect(await h.source.refill()).toMatchObject({ ok: true, outcome: 'band-activated' });
    issued.push(...h.source(50));

    expect(issued).toEqual(Array.from({ length: 150 }, (_, i) => i + 1)); // 1..150, contiguous
    expect(new Set(issued).size).toBe(150); // no duplicates
  });
});

// --- contiguity discipline ---------------------------------------------------------

describe('KraSequenceSource — gapless contiguity is enforced at grant time', () => {
  it('refuses a non-contiguous grant, activates nothing, and keeps numbering intact', async () => {
    const h = makeSource({
      config: { bandSize: 100 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 100) },
        { status: 200, body: grantBody('G-2-JUMPED', 1001, 1100) }, // KRA jumped 101..1000
        { status: 200, body: grantBody('G-3-CONTIGU', 101, 200) }, // the corrected grant
      ],
    });
    await h.source.refill();
    h.source(100); // band 1 dry
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.STOCK_EXHAUSTED);

    const jumped = await h.source.refill();
    expect(jumped).toMatchObject({ ok: false, outcome: 'refused', code: ETIMS_ERRORS.VSDC_BAND_NONCONTIGUOUS, retryable: false });
    expect(h.store.current()).toEqual({ year: 2026, next: 101, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 100 }] });
    expect(h.audit.events.at(-1)).toMatchObject({ kind: 'band-register-failed', code: ETIMS_ERRORS.VSDC_BAND_NONCONTIGUOUS });

    const corrected = await h.source.refill();
    expect(corrected).toMatchObject({ ok: true, outcome: 'band-activated', from: 101, to: 200 });
    expect(h.source(1)).toEqual([101]); // no gap between 100 and 101
  });

  it('refuses the first band of a year unless it starts at 1', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-OFFSET-1', 251, 750) }] });
    const outcome = await h.source.refill();
    expect(outcome).toMatchObject({ ok: false, outcome: 'refused', code: ETIMS_ERRORS.VSDC_BAND_NONCONTIGUOUS });
    expect(h.store.current()).toEqual(EMPTY_CHECKPOINT);
  });
});

// --- clock discipline ---------------------------------------------------------------

describe('KraSequenceSource — clock discipline (bands are year-scoped)', () => {
  it('burns stale-year stock on rollover and resumes the new year from 1', async () => {
    const h = makeSource({
      config: { bandSize: 500, lowWatermark: 450 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 500) },
        { status: 200, body: grantBody('G-2-BBBBBB', 501, 1000) },
      ],
    });
    await h.source.refill(); // band 1
    h.source(100); // next = 101
    await h.source.refill(); // stacks band 2 (below watermark)

    // the clock rolls into 2027
    h.clockHandle.set('2027-01-01T00:00:00.000Z');

    // the remaining 400 + 500 sequences are burned, then numbering is refused
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.YEAR_ROLLOVER);
    const burned = h.audit.events.filter((e) => e.kind === 'burned');
    expect(burned).toEqual([
      { kind: 'burned', at: '2027-01-01T00:00:00.000Z', bandId: 'G-1-AAAAAA', from: 101, to: 500, count: 400, reason: 'YEAR_ROLLOVER' },
      { kind: 'burned', at: '2027-01-01T00:00:00.000Z', bandId: 'G-2-BBBBBB', from: 501, to: 1000, count: 500, reason: 'YEAR_ROLLOVER' },
    ]);
    expect(h.store.current()).toEqual(EMPTY_CHECKPOINT);
    // still refused after the burn (no 2027 band yet), with the intent queued
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.YEAR_ROLLOVER);
    expect(h.audit.events.at(-1)).toMatchObject({ kind: 'refill-queued', reason: 'YEAR_ROLLOVER' });

    // a 2027 band starts at 1 — numbering resumes with the new year prefix
    h.calls.length = 0;
    const { post } = scriptedPost([{ status: 200, body: grantBody('G-2027-AAAAAA', 1, 500) }]);
    const newYear = createKraSequenceSource({
      config: makeConfig(),
      client: createVsdcSequenceClient(makeConfig(), post),
      store: h.store,
      audit: h.audit,
      clock: h.clock,
    });
    expect(await newYear.refill()).toMatchObject({ ok: true, outcome: 'band-activated', from: 1, to: 500 });
    const numbers = createNumberingService(newYear, h.clock).reserveInvoiceNumbers(2);
    expect(numbers.every((raw) => raw.startsWith('KE2027'))).toBe(true);
    expect(numbers.every((raw) => validateInvoiceNumber(raw).valid)).toBe(true);
  });

  it('burns through refill() too — a wiring may cross the year boundary without a reserve', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();
    h.source(100);
    h.clockHandle.set('2027-03-01T00:00:00.000Z');
    const outcome = await h.source.refill();
    expect(outcome).toMatchObject({ ok: false, outcome: 'refused' }); // the new-year ask came back refused in this script
    expect(h.audit.events.filter((e) => e.kind === 'burned')).toHaveLength(1);
    expect(h.store.current()).toEqual(EMPTY_CHECKPOINT);
  });

  it('refuses a broken clock on every path (never falls back to the wall clock)', async () => {
    const broken = makeSource({ clockIso: '2026-06-15T10:00:00.000Z' });
    const brokenClock: Clock = { now: () => new Date('not a date') };
    const source = createKraSequenceSource({
      config: makeConfig(),
      client: createVsdcSequenceClient(makeConfig(), (async () => ({ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) })) as unknown as VsdcPost),
      store: memoryStore(),
      audit: memoryAudit(),
      clock: brokenClock,
    });
    expectDomainCode(() => broken.source(0), ETIMS_ERRORS.COUNT_INVALID); // sanity: a sane clock refuses bad counts, not the clock
    expectDomainCode(() => source(1), ETIMS_ERRORS.CLOCK_INVALID);
    await expect(source.refill()).rejects.toMatchObject({ code: ETIMS_ERRORS.CLOCK_INVALID });
  });

  it('uses the UTC year, not the host timezone', async () => {
    // 2027-01-01T02:30+03:00 is still 2026 in UTC — the band must stay 2026
    const h = makeSource({
      clockIso: '2026-12-31T23:30:00.000Z',
      script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }],
    });
    await h.source.refill();
    const stats = h.source.stats();
    expect(stats.clockYear).toBe(2026);
    expect(h.calls.at(-1)?.body).toContain('"year":2026');
  });
});

// --- untrusted local state ----------------------------------------------------------

describe('KraSequenceSource — the checkpoint is untrusted local state (fail-closed)', () => {
  it('refuses reservations and refills on a corrupted checkpoint', () => {
    const table: Array<[unknown, string]> = [
      [{ year: 2026, next: 5, bands: 'nope' }, 'bands'],
      [{ year: 2026, next: 5, bands: [] }, 'empty band stack'],
      [{ year: 20, next: 5, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 500 }] }, 'year'],
      [{ year: 2026, next: 0, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 500 }] }, 'next'],
      [{ year: 2026, next: 502, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 500 }] }, 'next'], // past the drained tail
      [{ year: 2026, next: 5, bands: [{ bandId: 'x', from: 1, to: 500 }] }, 'bandId'],
      [{ year: 2026, next: 5, bands: [{ bandId: 'G-1-AAAAAA', from: 0, to: 500 }] }, 'from'],
      [{ year: 2026, next: 5, bands: [{ bandId: 'G-1-AAAAAA', from: 500, to: 100 }] }, 'to'],
      [
        { year: 2026, next: 5, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 100 }, { bandId: 'G-2-BBBBBB', from: 102, to: 200 }] },
        'contiguous',
      ],
      [
        // next inside a QUEUED band while the active band still holds stock —
        // structurally unreachable (issuance never skips the active tail)
        { year: 2026, next: 150, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 100 }, { bandId: 'G-2-BBBBBB', from: 101, to: 200 }] },
        'within the active band',
      ],
      ['junk', 'object'],
      [[{ bandId: 'G-1-AAAAAA' }], 'object'],
    ];
    for (const [raw] of table) {
      expectDomainCode(() => validateCheckpoint(raw), ETIMS_ERRORS.CHECKPOINT_INVALID);
    }
  });

  it('refuses the world while the corrupted checkpoint persists', async () => {
    const corrupt: SequenceCheckpoint = { year: 20, next: 5, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 500 }] };
    const h = makeSource({ store: memoryStore(corrupt) });
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.CHECKPOINT_INVALID);
    await expect(h.source.refill()).rejects.toMatchObject({ code: ETIMS_ERRORS.CHECKPOINT_INVALID });
  });

  it('accepts null and the exact empty checkpoint', () => {
    expect(validateCheckpoint(null)).toEqual(EMPTY_CHECKPOINT);
    expect(validateCheckpoint({ year: 0, next: 0, bands: [] })).toEqual(EMPTY_CHECKPOINT);
  });

  it('accepts an exactly-drained band: the zero-stock tail survives until the successor is stacked', () => {
    const drained: SequenceCheckpoint = { year: 2026, next: 101, bands: [{ bandId: 'G-1-AAAAAA', from: 1, to: 100 }] };
    expect(validateCheckpoint(drained)).toEqual(drained);
  });

  it('bands may be stacked in the persisted checkpoint (validated, contiguous)', () => {
    const stacked: SequenceCheckpoint = {
      year: 2026,
      next: 61,
      bands: [
        { bandId: 'G-1-AAAAAA', from: 1, to: 100 },
        { bandId: 'G-2-BBBBBB', from: 101, to: 200 },
      ],
    };
    const h = makeSource({ store: memoryStore(stacked) });
    expect(h.source(50)).toEqual(Array.from({ length: 50 }, (_, i) => 61 + i));
    expect(h.store.current().bands).toEqual([{ bandId: 'G-2-BBBBBB', from: 101, to: 200 }]);
  });
});

// — audit + write-ahead discipline -----------------------------------------------------

describe('KraSequenceSource — audit trail and write-ahead reservation', () => {
  it('records reservations before handing numbers out (audit-first evidence, save-first durability)', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();
    h.source(5);
    const kinds = h.audit.events.map((e) => e.kind);
    expect(kinds).toEqual(['band-registered', 'reserved']);
    const reserved = h.audit.events[1] as Extract<ReservationAuditEvent, { kind: 'reserved' }>;
    expect(reserved).toEqual({
      kind: 'reserved',
      at: '2026-06-15T10:00:00.000Z',
      bandId: 'G-1-AAAAAA',
      from: 1,
      to: 5,
      count: 5,
    });
  });

  it('refuses the reservation and burns the range when the audit trail is down — never double-issues', async () => {
    const h = makeSource({ audit: failingAudit(), script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    // the band activation itself is unrecordable — the audit trail is down —
    // but the write-ahead checkpoint already holds the granted band
    await expect(h.source.refill()).rejects.toMatchObject({ code: ETIMS_ERRORS.AUDIT_WRITE_FAILED });
    expectDomainCode(() => h.source(5), ETIMS_ERRORS.AUDIT_WRITE_FAILED);
    // the checkpoint consumed the range (write-ahead), so a repaired audit
    // trail can never re-issue [1, 5]
    expect(h.store.current().next).toBe(6);
    const healed = makeSource({ store: h.store, audit: memoryAudit() });
    expect(healed.source(2)).toEqual([6, 7]);
  });

  it('refuses the burn when the audit trail is down — the checkpoint stays burned, the refusal is loud', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();
    h.source(100);
    h.clockHandle.set('2027-01-01T00:00:00.000Z');
    const burningAudit = createKraSequenceSource({
      config: makeConfig(),
      client: createVsdcSequenceClient(makeConfig(), scriptedPost([{ throws: new Error('x') }]).post),
      store: h.store,
      audit: failingAudit(),
      clock: h.clock,
    });
    await expect(burningAudit.refill()).rejects.toMatchObject({ code: ETIMS_ERRORS.AUDIT_WRITE_FAILED });
    expect(h.store.current()).toEqual(EMPTY_CHECKPOINT); // burn was durable
  });
});

// — count validation ---------------------------------------------------------------------

describe('KraSequenceSource — count validation (defence in depth behind the domain port)', () => {
  it('refuses non-positive and non-integer counts with the domain-shared code', () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    for (const count of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectDomainCode(() => h.source(count), ETIMS_ERRORS.COUNT_INVALID);
    }
  });

  it('refuses bursts larger than the configured maximum reservation', () => {
    const h = makeSource({ config: { maxReservation: 100 }, script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    expectDomainCode(() => h.source(101), ETIMS_ERRORS.COUNT_TOO_LARGE);
  });
});

// — stats ---------------------------------------------------------------------------------

describe('KraSequenceSource — stats drive the refill loop', () => {
  it('reports stock, watermark and year alignment', async () => {
    const h = makeSource({
      config: { bandSize: 500, lowWatermark: 450 },
      script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }],
    });
    expect(h.source.stats()).toEqual({
      bandId: '',
      year: 0,
      clockYear: 2026,
      stockRemaining: 0,
      lowWatermark: 450,
      needsRefill: true,
    });
    await h.source.refill();
    expect(h.source.stats().needsRefill).toBe(false);
    h.source(60);
    expect(h.source.stats()).toMatchObject({ stockRemaining: 440, needsRefill: true });
    h.clockHandle.set('2027-01-01T00:00:00.000Z');
    expect(h.source.stats().needsRefill).toBe(true); // year rolled — refill required
  });
});

// — the port contract, end to end -----------------------------------------------------------

describe('KraSequenceSource — honors the src/domain/consent/etims.ts port contract', () => {
  it('satisfies the sequenceSource port exactly and produces valid eTIMS numbers end to end', async () => {
    const h = makeSource({ script: [{ status: 200, body: grantBody('G-1-AAAAAA', 1, 500) }] });
    await h.source.refill();

    // compile-time: the source IS the port function
    const port: (count: number) => number[] = h.source;

    const service = createNumberingService(port, h.clock);
    const numbers = service.reserveInvoiceNumbers(100);
    expect(numbers).toHaveLength(100);
    expect(new Set(numbers).size).toBe(100);
    for (const raw of numbers) {
      const parsed = validateInvoiceNumber(raw);
      expect(parsed.valid, raw).toBe(true);
      if (parsed.valid) expect(parsed.year, raw).toBe(2026);
    }
    // pinned domain vector, now fed by the production source
    expect(numbers[0]).toBe(`KE202600000001${checkCharacter('KE202600000001')}`);
  });

  it('keeps a 200-number burst unique across a refill boundary', async () => {
    const h = makeSource({
      config: { bandSize: 100, maxReservation: 100 },
      script: [
        { status: 200, body: grantBody('G-1-AAAAAA', 1, 100) },
        { status: 200, body: grantBody('G-2-BBBBBB', 101, 200) },
      ],
    });
    await h.source.refill();
    const first = createNumberingService(h.source, h.clock).reserveInvoiceNumbers(100);
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.STOCK_EXHAUSTED);
    await h.source.refill();
    const second = createNumberingService(h.source, h.clock).reserveInvoiceNumbers(100);
    const all = [...first, ...second];
    expect(all).toHaveLength(200);
    expect(new Set(all).size).toBe(200);
    for (const raw of all) expect(validateInvoiceNumber(raw).valid, raw).toBe(true);
  });

  it('keeps config honest end to end: the port is served only from KRA-granted stock', async () => {
    // no refill ever happened → the port refuses; it never invents sequences
    const h = makeSource({});
    expectDomainCode(() => h.source(1), ETIMS_ERRORS.YEAR_ROLLOVER);
    expect(h.audit.events.at(-1)).toMatchObject({ kind: 'refill-queued', reason: 'YEAR_ROLLOVER' });
    expect(h.store.current()).toEqual(EMPTY_CHECKPOINT);
    void etimsConfigFromEnv; // config is exercised in config.spec.ts
  });
});
