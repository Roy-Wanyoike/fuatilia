import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { registerCorridor, suspendCorridor, type Corridor } from './corridor';
import { computeFeeBreakdown } from './fees';
import {
  appliedRatio,
  assertQuoteUsable,
  convertAcrossCorridor,
  convertWithRatio,
  findActiveRateRow,
  isQuoteExpired,
  quote,
  rateRow,
  reconcileQuoteLegs,
  validateRateTable,
  type RateRow,
  type RateRowInput,
} from './quote';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(801);
const CORRIDOR = uid(803);
const ROW = uid(810);

const T0 = '2026-03-01T09:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const corridorOf = (overrides: Record<string, unknown> = {}): Corridor =>
  registerCorridor(
    {
      orgId: ORG,
      corridorId: CORRIDOR,
      sourceCurrency: 'KES' as const,
      destinationCurrency: 'TZS' as const,
      minAmountMinor: 10_000,
      maxAmountMinor: 10_000_000,
      rails: ['mpesa_ke_tz', 'bank_swift'],
      feeSchedule: { flatMinor: 50n, bps: 150 },
      ...overrides,
    },
    at(T0),
  ).corridor;

/** 1 KES = 19.35 TZS, open-ended from the day start. */
const rowOf = (overrides: Partial<RateRowInput> = {}): RateRowInput => ({
  rowId: ROW,
  sourceCurrency: 'KES',
  destinationCurrency: 'TZS',
  numerator: 1935n,
  denominator: 100n,
  effectiveFrom: '2026-03-01T00:00:00.000Z',
  effectiveTo: null,
  source: 'CBK',
  ...overrides,
});

const quoteOf = (clockIso = T0, options = {}) =>
  quote([corridorOf()], CORRIDOR, 10_000n, [rowOf()], at(clockIso), options);

// --- rate rows -----------------------------------------------------------------

describe('rateRow + validateRateTable — exact, non-overlapping rate windows', () => {
  it('builds a frozen row with bigint numerator/denominator', () => {
    const row = rateRow(rowOf());
    expect(row.numerator).toBe(1935n);
    expect(row.denominator).toBe(100n);
    expect(row.effectiveTo).toBeNull();
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('shape refusal table', () => {
    expectCode(() => rateRow(rowOf({ rowId: 'nope' as Uuid })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ sourceCurrency: 'XXX' as unknown as 'KES' })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ sourceCurrency: 'TZS', destinationCurrency: 'TZS' })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ numerator: 0 })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ denominator: -5n })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ source: '   ' })), 'RATE_TABLE_INVALID');
    expectCode(() => rateRow(rowOf({ effectiveFrom: 'yesterday' })), 'RATE_TABLE_INVALID');
    expectCode(
      () => rateRow(rowOf({ effectiveTo: '2026-02-01T00:00:00.000Z' })),
      'RATE_TABLE_INVALID',
    );
  });

  it('two rows for the same pair may never overlap — not even touch (inclusive windows)', () => {
    const rows = [
      rowOf({ rowId: uid(811), effectiveTo: '2026-03-02T00:00:00.000Z' }),
      rowOf({ rowId: uid(812), effectiveFrom: '2026-03-02T00:00:00.000Z' }), // shares the boundary instant
    ];
    expectCode(() => validateRateTable(rows), 'RATE_TABLE_OVERLAP');
    // one millisecond apart is the closest legal spacing
    const legal = [
      rowOf({ rowId: uid(813), effectiveTo: '2026-03-01T23:59:59.999Z' }),
      rowOf({ rowId: uid(814), effectiveFrom: '2026-03-02T00:00:00.000Z' }),
    ];
    expect(validateRateTable(legal)).toHaveLength(2);
  });

  it('an open-ended row swallows every later row for the pair; different pairs overlap freely', () => {
    expectCode(() => validateRateTable([rowOf(), rowOf({ rowId: uid(815), effectiveFrom: '2026-04-01T00:00:00.000Z' })]), 'RATE_TABLE_OVERLAP');
    const ugxRow = rateRow(
      rowOf({
        rowId: uid(816),
        sourceCurrency: 'KES',
        destinationCurrency: 'UGX',
        numerator: 34n,
        denominator: 10n,
      }),
    );
    expect(validateRateTable([rowOf(), ugxRow])).toHaveLength(2); // different pair — no clash
  });
});

describe('findActiveRateRow — one row per pair per instant', () => {
  it('refuses an unknown pair, a gap, and an ambiguous table', () => {
    const rows = validateRateTable([rowOf()]);
    expectCode(
      () => findActiveRateRow(rows, 'KES', 'UGX', new Date(T0)),
      'RATE_TABLE_PAIR_MISMATCH',
    );
    expectCode(
      () => findActiveRateRow(rows, 'KES', 'TZS', new Date('2026-02-01T00:00:00.000Z')),
      'RATE_TABLE_NO_ACTIVE_ROW',
    );
    const built = [
      rateRow(rowOf({ rowId: uid(817), effectiveTo: '2026-03-01T12:00:00.000Z' })),
      rateRow(rowOf({ rowId: uid(818), effectiveFrom: '2026-03-01T10:00:00.000Z' })),
    ];
    // windows overlap 10:00–12:00 — resolve would be ambiguous, so it refuses
    expectCode(() => findActiveRateRow(built, 'KES', 'TZS', new Date('2026-03-01T11:00:00.000Z')), 'RATE_TABLE_OVERLAP');
  });

  it('window boundaries are inclusive on both ends', () => {
    const rows = validateRateTable([
      rowOf({ effectiveFrom: '2026-03-01T00:00:00.000Z', effectiveTo: '2026-03-01T12:00:00.000Z' }),
    ]);
    expect(findActiveRateRow(rows, 'KES', 'TZS', new Date('2026-03-01T12:00:00.000Z')).rowId).toBe(ROW);
    expectCode(
      () => findActiveRateRow(rows, 'KES', 'TZS', new Date('2026-03-01T12:00:00.001Z')),
      'RATE_TABLE_NO_ACTIVE_ROW',
    );
  });
});

// --- exact conversion -----------------------------------------------------------

describe('appliedRatio + conversion — exact rational, ONE banker\'s rounding', () => {
  it('folds the minor-scale gap into the rational (UGX zero-decimal stays exact)', () => {
    const row = rateRow(rowOf()); // KES(2) → TZS(2), gap 0
    expect(appliedRatio(row)).toEqual({ num: 1935n, den: 100n });
    const ugx = rateRow({
      rowId: uid(820),
      sourceCurrency: 'KES',
      destinationCurrency: 'UGX',
      numerator: 34n,
      denominator: 10n,
      effectiveFrom: '2026-03-01T00:00:00.000Z',
      source: 'CBK',
    }); // KES(2) → UGX(0), gap −2 → den × 100
    expect(appliedRatio(ugx)).toEqual({ num: 34n, den: 1000n });
  });

  it('exact case: 10,000 KES-minor at 1935/100 → 1,935,000… exactly 193,500 TZS-minor', () => {
    expect(convertAcrossCorridor(10_000n, rateRow(rowOf()))).toBe(193_500n);
  });

  it('banker\'s rounding pins: 15.5 → 16 (even), 14.5 → 14 (even), 15.4 → 15', () => {
    expect(convertWithRatio(15_500n, 1n, 1000n)).toBe(16n);
    expect(convertWithRatio(14_500n, 1n, 1000n)).toBe(14n);
    expect(convertWithRatio(15_400n, 1n, 1000n)).toBe(15n);
  });
});

// --- the quote --------------------------------------------------------------------

describe('quote — the immutable, auditable offer', () => {
  it('issues a quote with the fee charged on top and the rate frozen in', () => {
    const { quote: q, events } = quoteOf();
    expect(q.sourceAmountMinor).toBe(10_000n);
    expect(q.fee).toEqual({ amountMinor: 10_000n, flatMinor: 50n, bpsMinor: 150n, totalMinor: 200n, bps: 150 });
    expect(q.sourceDebitMinor).toBe(10_200n); // amount + fee (fee on top)
    expect(q.destinationCreditMinor).toBe(193_500n);
    expect(q.rate.rowId).toBe(ROW);
    expect(q.ttlSeconds).toBe(120);
    expect(q.expiresAt).toBe('2026-03-01T09:02:00.000Z');
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('crossborder.quoteIssued');
    expect(events[0]!.aggregateId).toBe(q.quoteId);
  });

  it('a requote produces a NEW quote id — quotes are never edited in place', () => {
    const a = quoteOf(T0).quote;
    const b = quoteOf('2026-03-01T09:00:01.000Z').quote;
    expect(b.quoteId).not.toBe(a.quoteId);
    expect(b.issuedAt).not.toBe(a.issuedAt);
  });

  it('refusal order table', () => {
    expectCode(() => quote([corridorOf()], uid(899), 10_000n, [rowOf()], at(T0)), 'CORRIDOR_UNKNOWN');
    const suspended = suspendCorridor(corridorOf(), 'compliance hold', at(T0)).corridor;
    expectCode(() => quote([suspended], CORRIDOR, 10_000n, [rowOf()], at(T0)), 'CORRIDOR_SUSPENDED');
    expectCode(() => quoteOf(T0, { ttlSeconds: 0 }), 'QUOTE_TTL_INVALID');
    expectCode(() => quote([corridorOf()], CORRIDOR, 0n, [rowOf()], at(T0)), 'AMOUNT_OUT_OF_BOUNDS');
    expectCode(() => quoteOf(T0, { ttlSeconds: 1.5 }), 'QUOTE_TTL_INVALID');
    expectCode(
      () => quote([corridorOf()], CORRIDOR, 10_000n, [rowOf({ effectiveFrom: '2026-04-01T00:00:00.000Z' })], at(T0)),
      'RATE_TABLE_NO_ACTIVE_ROW',
    );
    expectCode(
      () => quote([corridorOf()], CORRIDOR, 10_000n, [rowOf({ sourceCurrency: 'KES', destinationCurrency: 'UGX' })], at(T0)),
      'RATE_TABLE_PAIR_MISMATCH',
    );
  });

  it('corridor bounds gate quoting (AMOUNT_OUT_OF_BOUNDS)', () => {
    const corridor = corridorOf();
    expectCode(() => quote([corridor], CORRIDOR, 9_999n, [rowOf()], at(T0)), 'AMOUNT_OUT_OF_BOUNDS');
    expectCode(() => quote([corridor], CORRIDOR, 10_000_001n, [rowOf()], at(T0)), 'AMOUNT_OUT_OF_BOUNDS');
  });
});

// --- expiry + reconciliation -----------------------------------------------------------

describe('expiry — usable strictly BEFORE expiresAt (±1ms)', () => {
  it('boundary table', () => {
    const { quote: q } = quoteOf();
    expect(isQuoteExpired(q, new Date('2026-03-01T09:01:59.999Z'))).toBe(false);
    expect(isQuoteExpired(q, new Date('2026-03-01T09:02:00.000Z'))).toBe(true);
    expectCode(() => assertQuoteUsable(q, new Date('2026-03-01T09:02:00.000Z')), 'QUOTE_EXPIRED');
    expectCode(() => assertQuoteUsable(q, new Date('2026-03-01T09:03:00.000Z')), 'QUOTE_EXPIRED');
    expect(() => assertQuoteUsable(q, new Date('2026-03-01T09:01:59.999Z'))).not.toThrow();
  });
});

describe('reconcileQuoteLegs — no cent created or destroyed (R1/R2)', () => {
  it('a fresh quote reconciles: fee parts sum, debit = amount + fee, credit = exact conversion', () => {
    const { quote: q } = quoteOf();
    expect(reconcileQuoteLegs(q)).toEqual({ ok: true, problems: [] });
  });

  it('detects tampering on any of the three identities', () => {
    const { quote: q } = quoteOf();
    const badFee = reconcileQuoteLegs({ ...q, fee: { ...q.fee, totalMinor: 250n } });
    expect(badFee.ok).toBe(false);
    expect(badFee.problems.length).toBeGreaterThanOrEqual(2); // fee sum + debit identities both break

    const badDebit = reconcileQuoteLegs({ ...q, sourceDebitMinor: 10_205n });
    expect(badDebit.ok).toBe(false);
    expect(badDebit.problems[0]).toContain('source debit');

    const badCredit = reconcileQuoteLegs({ ...q, destinationCreditMinor: 193_501n });
    expect(badCredit.ok).toBe(false);
    expect(badCredit.problems[0]).toContain('destination credit');
  });

  it('the fee engine itself is pinned (spot-check against computeFeeBreakdown)', () => {
    expect(computeFeeBreakdown({ flatMinor: 50n, bps: 150 }, 10_000n)).toEqual({
      amountMinor: 10_000n,
      flatMinor: 50n,
      bpsMinor: 150n,
      totalMinor: 200n,
      bps: 150,
    });
  });
});
