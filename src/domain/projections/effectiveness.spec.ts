import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { collectionEffectiveness, type CollectedFact, type DisputeRaisedFact, type EffectivenessFacts, type PromiseOutcomeFact } from './effectiveness';
import type { BilledFact } from './effectiveness';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const FROM = '2025-01-01T00:00:00.000Z';
const TO = '2025-03-31T23:59:59.999Z';
const WINDOW = { from: FROM, to: TO };

const billed = (n: number, date: string, amountMinor: bigint | number = 500_000): BilledFact => ({
  ref: uid(n),
  amountMinor,
  date,
});
const collected = (n: number, date: string, amountMinor: bigint | number = 500_000, receivableId: Uuid = uid(1)): CollectedFact => ({
  ref: uid(n),
  receivableId,
  amountMinor,
  date,
});
const promise = (n: number, kept: boolean, date = '2025-02-10'): PromiseOutcomeFact => ({
  ref: uid(n),
  kept,
  date,
});
const dispute = (n: number, date = '2025-02-20', receivableId: Uuid = uid(2)): DisputeRaisedFact => ({
  ref: uid(n),
  receivableId,
  date,
});

/** The standard book: 2 billed, 1 collection of 600k, 2-of-3 promises kept, 1 dispute. */
const facts = (): EffectivenessFacts => ({
  currency: 'KES',
  billed: [billed(1, '2025-01-10', 1_000_000), billed(2, '2025-02-15', 500_000)],
  collected: [collected(10, '2025-03-01', 600_000, uid(1))],
  promises: [promise(20, true), promise(21, false), promise(22, true)],
  disputes: [dispute(30)],
});

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

describe('collectionEffectiveness — the math (SPEC §66)', () => {
  it('computes collected-vs-billed as a money ratio with bigint numerator/denominator', () => {
    const report = collectionEffectiveness(facts(), WINDOW);
    const figure = report.figures.collectedVsBilled;
    expect(figure.kind).toBe('money_ratio');
    expect(figure.numeratorMinor).toBe(600_000n);
    expect(figure.denominatorMinor).toBe(1_500_000n);
    expect(figure.value).toBe(0.4); // 600k / 1.5M — exact
    expect(figure.reason).toBeNull();
  });

  it('computes promise-kept and dispute rates as count ratios', () => {
    const report = collectionEffectiveness(facts(), WINDOW);
    const kept = report.figures.promiseKept;
    expect(kept.kind).toBe('count_ratio');
    expect(kept.numerator).toBe(2);
    expect(kept.denominator).toBe(3);
    expect(kept.value).toBeCloseTo(2 / 3, 12);
    const disputes = report.figures.disputeRate;
    expect(disputes.numerator).toBe(1);
    expect(disputes.denominator).toBe(2);
    expect(disputes.value).toBe(0.5);
  });

  it('never clamps ratios above 1 — collecting pre-window invoices is legal', () => {
    const report = collectionEffectiveness(
      {
        currency: 'KES',
        billed: [billed(1, '2025-01-10', 1_000_000)],
        collected: [collected(10, '2025-02-01', 1_500_000)],
        promises: [],
        disputes: [],
      },
      WINDOW,
    );
    expect(report.figures.collectedVsBilled.value).toBe(1.5);
  });

  it('is an ACTUALS report — kind:"actual", structurally not a projection', () => {
    const report = collectionEffectiveness(facts(), WINDOW);
    expect(report.kind).toBe('actual');
    expect(report).not.toHaveProperty('assumptions');
    expect(report).not.toHaveProperty('horizonDays');
  });

  it('stamps asOf = the window end on the report and on every figure', () => {
    const report = collectionEffectiveness(facts(), WINDOW);
    expect(report.asOf).toBe(new Date(TO).toISOString());
    expect(report.figures.collectedVsBilled.asOf).toBe(report.asOf);
    expect(report.figures.promiseKept.asOf).toBe(report.asOf);
    expect(report.figures.disputeRate.asOf).toBe(report.asOf);
    expect(report.window).toEqual(WINDOW);
    expect(report.currency).toBe('KES');
  });
});

describe('collectionEffectiveness — window bounds (inclusive)', () => {
  it('includes facts dated exactly at from and at to; excludes 1ms outside', () => {
    const report = collectionEffectiveness(
      {
        currency: 'KES',
        billed: [
          billed(1, FROM), // exactly at from — in
          billed(2, TO), // exactly at to — in
          billed(3, '2024-12-31T23:59:59.999Z'), // 1ms before from — out
          billed(4, '2025-04-01T00:00:00.000Z'), // 1ms after to — out
        ],
        collected: [],
        promises: [],
        disputes: [],
      },
      WINDOW,
    );
    expect(report.figures.collectedVsBilled.denominatorMinor).toBe(1_000_000n); // only facts 1 + 2
    expect(report.figures.collectedVsBilled.evidenceRefs).toEqual([uid(1), uid(2)]);
  });

  it('accepts date-only facts (UTC midnight) and zoned timestamps alike', () => {
    const report = collectionEffectiveness(
      {
        currency: 'KES',
        billed: [billed(1, '2025-01-01'), billed(2, '2025-01-01T02:00:00+02:00')], // both 00:00Z-ish, in window
        collected: [],
        promises: [],
        disputes: [],
      },
      WINDOW,
    );
    expect(report.figures.collectedVsBilled.denominatorMinor).toBe(1_000_000n);
  });
});

describe('collectionEffectiveness — evidence + honest nulls', () => {
  it('lists evidence refs: numerator contributors first, then denominator-only, deduped', () => {
    const report = collectionEffectiveness(facts(), WINDOW);
    // collectedVsBilled: collected ref 10 first, then billed refs 1, 2
    expect(report.figures.collectedVsBilled.evidenceRefs).toEqual([uid(10), uid(1), uid(2)]);
    // disputeRate: dispute ref 30 first, then billed refs 1, 2
    expect(report.figures.disputeRate.evidenceRefs).toEqual([uid(30), uid(1), uid(2)]);
  });

  it('dedupes evidence refs shared between numerator and denominator', () => {
    const report = collectionEffectiveness(
      {
        currency: 'KES',
        billed: [billed(1, '2025-01-10', 1_000_000)],
        collected: [],
        promises: [],
        disputes: [dispute(1)], // same opaque id value as the billed fact — deduped
      },
      WINDOW,
    );
    expect(report.figures.disputeRate.evidenceRefs).toEqual([uid(1)]);
    expect(report.figures.disputeRate.value).toBe(1);
  });

  it('returns value:null WITH a reason when a figure cannot be computed honestly', () => {
    const report = collectionEffectiveness(
      { currency: 'KES', billed: [], collected: [], promises: [], disputes: [] },
      WINDOW,
    );
    expect(report.figures.collectedVsBilled).toMatchObject({
      value: null,
      reason: 'no billed amount in window',
      numeratorMinor: 0n,
      denominatorMinor: 0n,
    });
    expect(report.figures.promiseKept).toMatchObject({
      value: null,
      reason: 'no promise outcomes in window',
    });
    expect(report.figures.disputeRate).toMatchObject({
      value: null,
      reason: 'no billed invoices in window',
    });
  });

  it('never fakes a 0: a billed-only window keeps disputeRate computable but promiseKept null', () => {
    const report = collectionEffectiveness(
      { currency: 'KES', billed: [billed(1, '2025-01-10')], collected: [], promises: [], disputes: [] },
      WINDOW,
    );
    expect(report.figures.disputeRate.value).toBe(0); // 0 disputes / 1 invoice — a real zero
    expect(report.figures.promiseKept.value).toBeNull(); // no outcomes — not computable
    expect(report.figures.collectedVsBilled.value).toBe(0); // 0 collected / 1 billed — a real zero
  });
});

describe('collectionEffectiveness — stable error codes', () => {
  it.each([
    ['window.from after window.to', () => collectionEffectiveness(facts(), { from: '2025-04-01', to: '2025-01-01' }), 'PROJ_WINDOW_INVALID'],
    ['malformed window bound', () => collectionEffectiveness(facts(), { from: 'Jan 2025', to: TO }), 'PROJ_WINDOW_INVALID'],
    ['unsupported currency', () => collectionEffectiveness({ ...facts(), currency: 'JPY' as unknown as 'KES' }, WINDOW), 'PROJ_CURRENCY_INVALID'],
    ['non-uuid ref', () => collectionEffectiveness({ ...facts(), billed: [{ ref: 'not-a-uuid' as unknown as Uuid, amountMinor: 500_000, date: '2025-01-10' }] }, WINDOW), 'PROJ_EFFECTIVENESS_FACT_INVALID'],
    ['duplicate billed ref', () => collectionEffectiveness({ ...facts(), billed: [billed(1, '2025-01-10'), billed(1, '2025-01-11')] }, WINDOW), 'PROJ_FACT_REF_DUPLICATE'],
    ['duplicate collected ref', () => collectionEffectiveness({ ...facts(), collected: [collected(10, '2025-01-10'), collected(10, '2025-01-11')] }, WINDOW), 'PROJ_FACT_REF_DUPLICATE'],
    ['unparseable fact date', () => collectionEffectiveness({ ...facts(), billed: [billed(1, 'yesterday')] }, WINDOW), 'PROJ_FACT_DATE_INVALID'],
    ['zoneless fact timestamp', () => collectionEffectiveness({ ...facts(), billed: [billed(1, '2025-01-10T10:00:00')] }, WINDOW), 'PROJ_FACT_DATE_INVALID'],
    ['negative amount', () => collectionEffectiveness({ ...facts(), billed: [billed(1, '2025-01-10', -5n)] }, WINDOW), 'PROJ_AMOUNT_INVALID'],
    ['fractional amount', () => collectionEffectiveness({ ...facts(), billed: [billed(1, '2025-01-10', 10.5)] }, WINDOW), 'PROJ_AMOUNT_INVALID'],
  ])('%s → %s', (_label, fn, code) => {
    expectCode(fn, code);
  });

  it('validates fact shapes even for facts outside the window (never silently drops garbage)', () => {
    expectCode(
      () =>
        collectionEffectiveness(
          { ...facts(), billed: [billed(1, '2025-01-10'), billed(2, '12/12/2024')] }, // bad date, outside window
          WINDOW,
        ),
      'PROJ_FACT_DATE_INVALID',
    );
  });
});

describe('collectionEffectiveness — purity + determinism', () => {
  it('is deterministic — identical inputs yield identical reports', () => {
    expect(collectionEffectiveness(facts(), WINDOW)).toEqual(collectionEffectiveness(facts(), WINDOW));
  });

  it('never mutates its inputs (frozen pin)', () => {
    const frozen = deepFreeze(facts());
    let report: ReturnType<typeof collectionEffectiveness> | undefined;
    expect(() => (report = collectionEffectiveness(frozen, WINDOW))).not.toThrow();
    expect(report!.figures.collectedVsBilled.value).toBe(0.4);
  });
});
