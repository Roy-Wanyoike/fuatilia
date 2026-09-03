import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { AGING_BUCKETS, arAgingByBucket, agingBucketFor, daysOverdue } from './aging';
import type { ReceivableFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const DUE = '2025-03-01T00:00:00.000Z'; // aging day 0
const DAY_MS = 86_400_000;
const asOfDay = (days: number, offsetMs = 0): string =>
  new Date(new Date(DUE).getTime() + days * DAY_MS + offsetMs).toISOString();

const rec = (n: number, overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  receivableId: uid(n),
  customerId: uid(900),
  currency: 'KES',
  balanceMinor: 1_000_000n,
  dueDate: DUE,
  ...overrides,
});

const bucketOf = (snapshot: ReturnType<typeof arAgingByBucket>, currency: string, bucket: string) => {
  const view = snapshot.currencies.find((c) => c.currency === currency);
  if (!view) throw new Error(`no ${currency} view`);
  return view.buckets.find((b) => b.bucket === bucket)!;
};

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// --- tests ------------------------------------------------------------------

describe('aging bucket boundaries (±1 day past due)', () => {
  it.each([
    [-28, 'current'], // far before the due date
    [0, 'current'], // due exactly now — nothing past due yet
    [1, '1-30'], // day 1 crosses into the first bucket
    [30, '1-30'], // last day of the first bucket
    [31, '31-60'], // day 31 crosses
    [60, '31-60'],
    [61, '61-90'],
    [90, '61-90'],
    [91, '90+'],
    [365, '90+'],
  ])('day %+d past due → %s', (days, expected) => {
    expect(agingBucketFor(days)).toBe(expected);
  });

  it.each([
    [0, 1, 'current'], // 1ms past the due instant is still day 0
    [0, 0, 'current'], // exactly the due instant
    [1, 0, '1-30'], // exactly one full day late
    [30, DAY_MS - 1, '1-30'], // 30d 23:59:59.999 is still day 30
    [31, 0, '31-60'], // 31 full days crosses
    [60, DAY_MS - 1, '31-60'],
    [61, 0, '61-90'],
    [90, DAY_MS - 1, '61-90'],
    [91, 0, '90+'],
  ])('asOf due %+dd %dms → bucket %s', (days, offsetMs, expected) => {
    const snapshot = arAgingByBucket([rec(1)], asOfDay(days, offsetMs));
    const aged = snapshot.currencies[0]!.buckets.filter((b) => b.receivableCount > 0);
    expect(aged).toHaveLength(1);
    expect(aged[0]!.bucket).toBe(expected);
  });

  it('floors whole days past due and clamps future dues at 0', () => {
    expect(daysOverdue(new Date(DUE).getTime(), new Date(DUE).getTime() - 1)).toBe(0); // not yet due
    expect(daysOverdue(new Date(DUE).getTime(), new Date(DUE).getTime() + DAY_MS - 1)).toBe(0);
    expect(daysOverdue(new Date(DUE).getTime(), new Date(DUE).getTime() + DAY_MS)).toBe(1);
  });
});

describe('arAgingByBucket — ACTUALS snapshot', () => {
  it('labels the snapshot kind:"actual" and stamps asOf on the report AND every figure', () => {
    const snapshot = arAgingByBucket([rec(1), rec(2, { dueDate: asOfDay(-45) })], DUE);
    expect(snapshot.kind).toBe('actual');
    expect(snapshot.asOf).toBe(new Date(DUE).toISOString());
    for (const view of snapshot.currencies) {
      for (const bucket of view.buckets) {
        expect(bucket.asOf).toBe(snapshot.asOf); // each figure carries its asOf
      }
    }
  });

  it('totals per currency in bigint minor units (multi-currency, first-seen order)', () => {
    const snapshot = arAgingByBucket(
      [
        rec(1, { currency: 'KES', balanceMinor: 1_000_000n }), // current
        rec(2, { currency: 'KES', balanceMinor: 500_000n, dueDate: asOfDay(-45) }), // 31-60
        rec(3, { currency: 'USD', balanceMinor: 250_000n, dueDate: asOfDay(-120) }), // 90+
      ],
      DUE,
    );
    expect(snapshot.currencies.map((c) => c.currency)).toEqual(['KES', 'USD']); // first-seen order
    const [kes, usd] = snapshot.currencies;
    expect(kes!.totalMinor).toBe(1_500_000n);
    expect(usd!.totalMinor).toBe(250_000n);
    expect(bucketOf(snapshot, 'KES', 'current').amountMinor).toBe(1_000_000n);
    expect(bucketOf(snapshot, 'KES', '31-60').amountMinor).toBe(500_000n);
    expect(bucketOf(snapshot, 'USD', '90+').amountMinor).toBe(250_000n);
    // buckets are always zero-filled, in AGING_BUCKETS order
    expect(kes!.buckets.map((b) => b.bucket)).toEqual(AGING_BUCKETS);
    expect(bucketOf(snapshot, 'KES', '90+').amountMinor).toBe(0n);
    expect(bucketOf(snapshot, 'KES', '90+').receivableCount).toBe(0);
  });

  it('carries evidence refs per bucket, in input order', () => {
    const snapshot = arAgingByBucket(
      [rec(7), rec(8), rec(9, { dueDate: asOfDay(-45) })],
      DUE,
    );
    const current = bucketOf(snapshot, 'KES', 'current');
    expect(current.evidenceRefs).toEqual([uid(7), uid(8)]); // input order
    expect(current.receivableCount).toBe(2);
    expect(bucketOf(snapshot, 'KES', '31-60').evidenceRefs).toEqual([uid(9)]);
  });

  it('skips zero-balance facts (settled debt has nothing to age) but counts them', () => {
    const snapshot = arAgingByBucket([rec(1), rec(2, { balanceMinor: 0n })], DUE);
    expect(snapshot.receivablesAged).toBe(1);
    expect(snapshot.zeroBalanceCount).toBe(1);
    expect(snapshot.currencies).toHaveLength(1); // the zero-balance fact never opens a view
    expect(bucketOf(snapshot, 'KES', 'current').evidenceRefs).toEqual([uid(1)]);
  });

  it('returns an empty snapshot for an empty book', () => {
    const snapshot = arAgingByBucket([], DUE);
    expect(snapshot.currencies).toEqual([]);
    expect(snapshot.receivablesAged).toBe(0);
    expect(snapshot.zeroBalanceCount).toBe(0);
    expect(snapshot.kind).toBe('actual');
  });

  it('accepts a Date or an ISO string for asOf — same snapshot', () => {
    const fromString = arAgingByBucket([rec(1)], DUE);
    const fromDate = arAgingByBucket([rec(1)], new Date(DUE));
    expect(fromString).toEqual(fromDate);
  });

  it('is deterministic — identical inputs yield identical snapshots', () => {
    const receivables = [rec(1), rec(2, { dueDate: asOfDay(-70) }), rec(3, { currency: 'USD' })];
    expect(arAgingByBucket(receivables, DUE)).toEqual(arAgingByBucket(receivables, DUE));
  });

  it('never mutates its inputs (frozen pin)', () => {
    const receivables = deepFreeze([rec(1), rec(2, { dueDate: asOfDay(-45), disputed: true })]);
    let snapshot: ReturnType<typeof arAgingByBucket> | undefined;
    expect(() => (snapshot = arAgingByBucket(receivables, DUE))).not.toThrow();
    expect(snapshot!.currencies).toHaveLength(1); // disputed flag is read, not written
  });
});

describe('arAgingByBucket — stable error codes', () => {
  const NOW = asOfDay(10);
  it.each([
    ['asOf is garbage', () => arAgingByBucket([], 'not-a-date'), 'PROJ_AS_OF_INVALID'],
    ['asOf is a zoneless local timestamp', () => arAgingByBucket([], '2025-03-01T10:00:00'), 'PROJ_AS_OF_INVALID'],
    ['receivableId is not uuid-shaped', () => arAgingByBucket([rec(1, { receivableId: 'rec-1' as unknown as Uuid })], NOW), 'PROJ_RECEIVABLE_INVALID'],
    ['duplicate receivableId', () => arAgingByBucket([rec(1), rec(1)], NOW), 'PROJ_RECEIVABLE_DUPLICATE'],
    ['customerId is not uuid-shaped', () => arAgingByBucket([rec(1, { customerId: 'cust' as unknown as Uuid })], NOW), 'PROJ_RECEIVABLE_INVALID'],
    ['unsupported currency', () => arAgingByBucket([rec(1, { currency: 'JPY' as unknown as 'KES' })], NOW), 'PROJ_CURRENCY_INVALID'],
    ['negative balance', () => arAgingByBucket([rec(1, { balanceMinor: -1n })], NOW), 'PROJ_BALANCE_INVALID'],
    ['fractional balance', () => arAgingByBucket([rec(1, { balanceMinor: 1.5 })], NOW), 'PROJ_BALANCE_INVALID'],
    ['unparseable dueDate', () => arAgingByBucket([rec(1, { dueDate: '01/03/2025' })], NOW), 'PROJ_DUE_DATE_INVALID'],
    ['zoneless dueDate timestamp', () => arAgingByBucket([rec(1, { dueDate: '2025-03-01T10:00:00' })], NOW), 'PROJ_DUE_DATE_INVALID'],
    ['non-boolean disputed flag', () => arAgingByBucket([rec(1, { disputed: 'yes' as unknown as boolean })], NOW), 'PROJ_RECEIVABLE_INVALID'],
  ])('%s → %s', (_label, fn, code) => {
    expectCode(fn, code);
  });
});
