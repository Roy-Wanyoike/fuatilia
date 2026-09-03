import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { SEGMENTS, SEGMENT_THRESHOLDS, segmentCustomers, type CustomerFact } from './segments';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

/** A clean, live, unremarkable customer — the `watch` baseline. */
const fact = (n: number, overrides: Partial<CustomerFact> = {}): CustomerFact => ({
  customerId: uid(n),
  currency: 'KES',
  exposureMinor: 1_000_000n,
  worstDaysOverdue: 0,
  promiseKeptRate: null,
  brokenPromiseCount: 0,
  daysSinceLastPayment: 10,
  disputeOpen: false,
  ...overrides,
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

describe('segmentCustomers — the decision matrix (first match wins)', () => {
  it.each([
    ['zero exposure dominates everything', { exposureMinor: 0n, worstDaysOverdue: 120, brokenPromiseCount: 5, disputeOpen: true }, 'dormant'],
    ['payment silence ≥ 180d dominates risk', { daysSinceLastPayment: 180, brokenPromiseCount: 5, worstDaysOverdue: 95 }, 'dormant'],
    ['3 broken promises → chronic_late', { brokenPromiseCount: 3 }, 'chronic_late'],
    ['90d overdue → chronic_late', { worstDaysOverdue: 90 }, 'chronic_late'],
    ['chronic outranks at_risk (dispute live)', { brokenPromiseCount: 3, disputeOpen: true }, 'chronic_late'],
    ['open dispute → at_risk', { disputeOpen: true }, 'at_risk'],
    ['31d overdue → at_risk', { worstDaysOverdue: 31 }, 'at_risk'],
    ['kept rate < 0.5 → at_risk', { promiseKeptRate: 0.49 }, 'at_risk'],
    ['high value + clean + reliable → high_value_reliable', { exposureMinor: 10_000_000n, promiseKeptRate: 0.8 }, 'high_value_reliable'],
    ['high value + no promise history → high_value_reliable', { exposureMinor: 10_000_000n, promiseKeptRate: null }, 'high_value_reliable'],
    ['live exposure, nothing remarkable → watch', {}, 'watch'],
    ['just under the high-value threshold → watch', { exposureMinor: 9_999_999n, promiseKeptRate: 0.9 }, 'watch'],
    ['high value but 1d overdue → watch', { exposureMinor: 10_000_000n, worstDaysOverdue: 1 }, 'watch'],
    ['high value but kept rate 0.79 → watch', { exposureMinor: 10_000_000n, promiseKeptRate: 0.79 }, 'watch'],
    ['silence outranks deep overdue', { daysSinceLastPayment: 200, worstDaysOverdue: 95 }, 'dormant'],
    ['chronic outranks value', { brokenPromiseCount: 3, exposureMinor: 50_000_000n }, 'chronic_late'],
  ])('%s → %s', (_label, overrides, expected) => {
    const [assignment] = segmentCustomers([fact(1, overrides)]);
    expect(assignment!.segment).toBe(expected);
    expect(SEGMENTS).toContain(assignment!.segment); // stable named segment
  });
});

describe('segmentCustomers — thresholds pinned at every boundary (±1)', () => {
  it.each([
    ['daysSinceLastPayment', 179, 'watch'],
    ['daysSinceLastPayment', 180, 'dormant'],
    ['brokenPromiseCount', 2, 'watch'],
    ['brokenPromiseCount', 3, 'chronic_late'],
    ['worstDaysOverdue 89/90', 89, 'at_risk'],
    ['worstDaysOverdue 90/91', 90, 'chronic_late'],
    ['worstDaysOverdue 30/31', 30, 'watch'],
    ['worstDaysOverdue 31/32', 31, 'at_risk'],
    ['promiseKeptRate 0.5 (not below)', 0.5, 'watch'],
    ['promiseKeptRate 0.49', 0.49, 'at_risk'],
  ] as const)('%s = %s → %s', (_label, value, expected) => {
    const overrides: Partial<CustomerFact> =
      _label === 'promiseKeptRate 0.5 (not below)' || _label === 'promiseKeptRate 0.49'
        ? { promiseKeptRate: value }
        : _label.startsWith('daysSince')
          ? { daysSinceLastPayment: value }
          : _label.startsWith('broken')
            ? { brokenPromiseCount: value }
            : { worstDaysOverdue: value };
    const [assignment] = segmentCustomers([fact(1, overrides)]);
    expect(assignment!.segment).toBe(expected);
  });

  it.each([
    [9_999_999n, 'watch'],
    [10_000_000n, 'high_value_reliable'],
  ])('exposure %s minor (kept 0.8, nothing overdue) → %s', (exposureMinor, expected) => {
    const [assignment] = segmentCustomers([fact(1, { exposureMinor, promiseKeptRate: 0.8 })]);
    expect(assignment!.segment).toBe(expected);
  });

  it('exposes the thresholds frozen — callers and agents can read, no one can mutate', () => {
    expect(SEGMENT_THRESHOLDS.DORMANT_SILENCE_DAYS).toBe(180);
    expect(SEGMENT_THRESHOLDS.CHRONIC_BROKEN_PROMISES).toBe(3);
    expect(SEGMENT_THRESHOLDS.CHRONIC_DAYS_OVERDUE).toBe(90);
    expect(SEGMENT_THRESHOLDS.AT_RISK_DAYS_OVERDUE).toBe(31);
    expect(SEGMENT_THRESHOLDS.AT_RISK_KEPT_RATE).toBe(0.5);
    expect(SEGMENT_THRESHOLDS.HIGH_VALUE_EXPOSURE_MINOR).toBe(10_000_000);
    expect(SEGMENT_THRESHOLDS.RELIABLE_KEPT_RATE).toBe(0.8);
    expect(Object.isFrozen(SEGMENT_THRESHOLDS)).toBe(true);
  });
});

describe('segmentCustomers — explainability (VISION §3.7)', () => {
  it('carries the fired conditions as reasons, in matrix order', () => {
    const [chronic] = segmentCustomers([fact(1, { brokenPromiseCount: 5, worstDaysOverdue: 95 })]);
    expect(chronic!.segment).toBe('chronic_late');
    expect(chronic!.reasons).toEqual([
      'brokenPromiseCount=5 >= 3',
      'worstDaysOverdue=95 >= 90',
    ]);

    const [atRisk] = segmentCustomers([fact(2, { disputeOpen: true, worstDaysOverdue: 45, promiseKeptRate: 0.2 })]);
    expect(atRisk!.reasons).toEqual([
      'disputeOpen=true',
      'worstDaysOverdue=45 >= 31',
      'promiseKeptRate=0.2 < 0.5',
    ]);
  });

  it('high_value reasons name exposure, cleanliness and reliability (or the no-history default)', () => {
    const [withHistory] = segmentCustomers([fact(1, { exposureMinor: 20_000_000n, promiseKeptRate: 0.95 })]);
    expect(withHistory!.reasons).toEqual([
      'exposureMinor=20000000 >= 10000000',
      'worstDaysOverdue=0 — nothing overdue',
      'promiseKeptRate=0.95 >= 0.8',
    ]);
    const [noHistory] = segmentCustomers([fact(2, { exposureMinor: 20_000_000n })]);
    expect(noHistory!.reasons).toContain('promiseKeptRate unknown — no promise history');
  });

  it('every assignment in a batch carries at least one reason', () => {
    const assignments = segmentCustomers([
      fact(1, { exposureMinor: 0n }),
      fact(2, { brokenPromiseCount: 3 }),
      fact(3, { disputeOpen: true }),
      fact(4),
      fact(5, { exposureMinor: 10_000_000n, promiseKeptRate: 0.8 }),
    ]);
    for (const assignment of assignments) {
      expect(assignment.reasons.length).toBeGreaterThanOrEqual(1);
      expect(assignment.reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);
    }
  });
});

describe('segmentCustomers — purity + determinism', () => {
  it('preserves input order and customer ids', () => {
    const assignments = segmentCustomers([fact(5), fact(2, { exposureMinor: 0n }), fact(9, { disputeOpen: true })]);
    expect(assignments.map((a) => a.customerId)).toEqual([uid(5), uid(2), uid(9)]);
    expect(assignments.map((a) => a.segment)).toEqual(['watch', 'dormant', 'at_risk']);
  });

  it('is deterministic — identical facts yield identical assignments', () => {
    const facts = [fact(1, { worstDaysOverdue: 33 }), fact(2, { daysSinceLastPayment: 200 })];
    expect(segmentCustomers(facts)).toEqual(segmentCustomers(facts));
  });

  it('never mutates its inputs (frozen pin)', () => {
    const facts = deepFreeze([fact(1, { worstDaysOverdue: 40 }), fact(2, { exposureMinor: 0n })]);
    let assignments: ReturnType<typeof segmentCustomers> | undefined;
    expect(() => (assignments = segmentCustomers(facts))).not.toThrow();
    expect(assignments).toHaveLength(2);
  });
});

describe('segmentCustomers — stable error codes', () => {
  it.each([
    ['customerId not uuid-shaped', () => segmentCustomers([fact(1, { customerId: 'cust-1' as unknown as Uuid })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['negative worstDaysOverdue', () => segmentCustomers([fact(1, { worstDaysOverdue: -1 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['fractional worstDaysOverdue', () => segmentCustomers([fact(1, { worstDaysOverdue: 1.5 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['negative brokenPromiseCount', () => segmentCustomers([fact(1, { brokenPromiseCount: -1 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['fractional brokenPromiseCount', () => segmentCustomers([fact(1, { brokenPromiseCount: 2.5 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['negative daysSinceLastPayment', () => segmentCustomers([fact(1, { daysSinceLastPayment: -1 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['fractional daysSinceLastPayment', () => segmentCustomers([fact(1, { daysSinceLastPayment: 1.5 })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['non-boolean disputeOpen', () => segmentCustomers([fact(1, { disputeOpen: 'yes' as unknown as boolean })]), 'SEG_CUSTOMER_FACT_INVALID'],
    ['unsupported currency', () => segmentCustomers([fact(1, { currency: 'JPY' })]), 'SEG_CURRENCY_INVALID'],
    ['negative exposure', () => segmentCustomers([fact(1, { exposureMinor: -1n })]), 'SEG_EXPOSURE_INVALID'],
    ['fractional exposure', () => segmentCustomers([fact(1, { exposureMinor: 1.5 })]), 'SEG_EXPOSURE_INVALID'],
    ['kept rate above 1', () => segmentCustomers([fact(1, { promiseKeptRate: 1.5 })]), 'SEG_RATE_INVALID'],
    ['kept rate below 0', () => segmentCustomers([fact(1, { promiseKeptRate: -0.1 })]), 'SEG_RATE_INVALID'],
    ['duplicate customer fact', () => segmentCustomers([fact(1), fact(1)]), 'SEG_CUSTOMER_DUPLICATE'],
  ])('%s → %s', (_label, fn, code) => {
    expectCode(fn, code);
  });
});
