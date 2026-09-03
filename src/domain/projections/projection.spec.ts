import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { PROJECTION_RULES, overdueHaircut, projectCollections } from './projection';
import { arAgingByBucket } from './aging';
import type { BehaviorFact, ReceivableFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const NOW = '2025-06-01T00:00:00.000Z';
const DAY_MS = 86_400_000;
const clock: Clock = { now: () => new Date(NOW) };
const HORIZON = 30;
const dayFromNow = (days: number, offsetMs = 0): string =>
  new Date(new Date(NOW).getTime() + days * DAY_MS + offsetMs).toISOString();

const CUST_A = uid(900);
const CUST_B = uid(901);

const rec = (n: number, overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  receivableId: uid(n),
  customerId: CUST_A,
  currency: 'KES',
  balanceMinor: 1_000_000n,
  dueDate: NOW, // due exactly now — day 0 past due
  ...overrides,
});

const propensity = (customerId: Uuid, collectionPropensity: number): BehaviorFact => ({ customerId, collectionPropensity });

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

describe('projection rules (frozen, transparent knobs)', () => {
  it('exposes the documented constants', () => {
    expect(PROJECTION_RULES.DEFAULT_PROPENSITY).toBe(0.5);
    expect(PROJECTION_RULES.OPTIMISTIC_LIFT).toBe(1.25);
    expect(PROJECTION_RULES.PESSIMISTIC_DISCOUNT).toBe(0.75);
    expect(PROJECTION_RULES.OVERDUE_HAIRCUTS.map((t) => t.factor)).toEqual([0.8, 0.6, 0.4, 0.2]);
    expect(Object.isFrozen(PROJECTION_RULES)).toBe(true);
    expect(Object.isFrozen(PROJECTION_RULES.OVERDUE_HAIRCUTS)).toBe(true);
  });

  it.each([
    [0, 0.8], // not overdue (or due today) — the <=30d aging tier
    [30, 0.8],
    [31, 0.6],
    [60, 0.6],
    [61, 0.4],
    [90, 0.4],
    [91, 0.2],
    [1_000, 0.2],
  ])('haircut for %d days past due → ×%s', (daysPastDue, factor) => {
    expect(overdueHaircut(daysPastDue)).toBe(factor);
  });
});

describe('projectCollections — band construction (hand-pinned math)', () => {
  it('propensity 0.5, due today (haircut ×0.8): bands 300k / 400k / 500k', () => {
    const projection = projectCollections([rec(1)], [propensity(CUST_A, 0.5)], HORIZON, clock);
    expect(projection.currencies[0]).toMatchObject({
      currency: 'KES',
      pessimisticMinor: 300_000n, // 0.5 × 0.75 × 0.8
      expectedMinor: 400_000n, // 0.5 × 0.8
      optimisticMinor: 500_000n, // min(1, 0.5 × 1.25) × 0.8
      inScopeCount: 1,
    });
  });

  it('propensity 1.0, 45 days overdue (haircut ×0.6): 900k / 1.2M / 1.2M on a 2M balance', () => {
    const projection = projectCollections(
      [rec(1, { balanceMinor: 2_000_000n, dueDate: dayFromNow(-45) })],
      [propensity(CUST_A, 1.0)],
      HORIZON,
      clock,
    );
    expect(projection.currencies[0]).toMatchObject({
      pessimisticMinor: 900_000n, // 1.0 × 0.75 × 0.6
      expectedMinor: 1_200_000n, // 1.0 × 0.6
      optimisticMinor: 1_200_000n, // optimism caps at propensity 1 — never exceeds certainty
    });
  });

  it('propensity 0.5, 100 days overdue (haircut ×0.2): 75k / 100k / 125k', () => {
    const projection = projectCollections(
      [rec(1, { dueDate: dayFromNow(-100) })],
      [propensity(CUST_A, 0.5)],
      HORIZON,
      clock,
    );
    expect(projection.currencies[0]).toMatchObject({
      pessimisticMinor: 75_000n,
      expectedMinor: 100_000n,
      optimisticMinor: 125_000n,
    });
  });

  it('customers with no behavior fact get DEFAULT_PROPENSITY (0.5) and the assumption says so', () => {
    const projection = projectCollections([rec(1)], [], HORIZON, clock); // no facts at all
    expect(projection.currencies[0]!.expectedMinor).toBe(400_000n); // default propensity, haircut 0.8
    expect(projection.assumptions).toContainEqual(
      expect.stringContaining('default propensity 0.5 assumed for 1 customer(s) with no behavior fact'),
    );
  });

  it('customers WITH a behavior fact never trigger the default assumption', () => {
    const projection = projectCollections([rec(1)], [propensity(CUST_A, 0.5)], HORIZON, clock);
    expect(projection.assumptions.some((a) => a.includes('default propensity'))).toBe(false);
  });

  it('bands stay ordered pessimistic ≤ expected ≤ optimistic across the propensity × age grid', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      for (const daysOverdue of [-5, 0, 15, 30, 31, 45, 60, 61, 90, 91, 200]) {
        const projection = projectCollections(
          [rec(1, { dueDate: dayFromNow(-daysOverdue) })],
          [propensity(CUST_A, p)],
          HORIZON,
          clock,
        );
        const view = projection.currencies[0]!;
        expect(view.pessimisticMinor).toBeLessThanOrEqual(view.expectedMinor);
        expect(view.expectedMinor).toBeLessThanOrEqual(view.optimisticMinor);
      }
    }
  });
});

describe('projectCollections — scope, labeling and assumptions', () => {
  it('labels the result kind:"projection" and never carries an actual-balance field', () => {
    const projection = projectCollections([rec(1)], [], HORIZON, clock);
    expect(projection.kind).toBe('projection');
    // Structural separation from actuals: exactly these top-level keys — no balances, no buckets.
    expect(Object.keys(projection).sort()).toEqual(
      ['asOf', 'assumptions', 'currencies', 'evidenceRefs', 'horizonDays', 'horizonEnd', 'kind'].sort(),
    );
    expect(Object.keys(projection.currencies[0]!).sort()).toEqual(
      ['currency', 'excludedDisputedCount', 'expectedMinor', 'inScopeCount', 'optimisticMinor', 'pessimisticMinor'].sort(),
    );
    // …while the ACTUAL snapshot is a different structure family entirely.
    expect(arAgingByBucket([rec(1)], NOW).kind).toBe('actual');
  });

  it('scopes to receivables with balance > 0 and dueDate ≤ horizonEnd; the rule is assumption #1', () => {
    const projection = projectCollections(
      [
        rec(1, { dueDate: dayFromNow(HORIZON) }), // exactly at horizonEnd — in scope
        rec(2, { dueDate: dayFromNow(HORIZON, 1) }), // 1ms past horizonEnd — out
        rec(3, { dueDate: dayFromNow(365) }), // far future — out
        rec(4, { dueDate: dayFromNow(-10) }), // overdue — in (collections chases it)
        rec(5, { balanceMinor: 0n }), // settled — nothing to collect
      ],
      [propensity(CUST_A, 0.5)],
      HORIZON,
      clock,
    );
    expect(projection.evidenceRefs).toEqual([uid(1), uid(4)]); // input order
    expect(projection.currencies[0]!.inScopeCount).toBe(2);
    expect(projection.assumptions[0]).toBe(
      `scope: receivables with balance > 0 and dueDate <= ${dayFromNow(HORIZON)} (asOf ${NOW} + ${HORIZON}d)`,
    );
    expect(projection.assumptions).toContainEqual(expect.stringContaining('1 zero-balance receivable(s) skipped'));
  });

  it('excludes disputed receivables from ALL bands and surfaces the exclusion as an assumption', () => {
    const projection = projectCollections(
      [rec(1), rec(2, { disputed: true })],
      [propensity(CUST_A, 0.5)],
      HORIZON,
      clock,
    );
    expect(projection.evidenceRefs).toEqual([uid(1)]);
    expect(projection.currencies[0]).toMatchObject({ inScopeCount: 1, excludedDisputedCount: 1 });
    expect(projection.assumptions).toContainEqual('1 disputed receivable(s) excluded from all bands (dispute pause)');
  });

  it('a disputed-only currency opens no view but still counts in the assumptions', () => {
    const projection = projectCollections(
      [rec(1, { currency: 'USD', disputed: true })],
      [],
      HORIZON,
      clock,
    );
    expect(projection.currencies).toEqual([]); // nothing in scope → no view
    expect(projection.assumptions).toContainEqual('1 disputed receivable(s) excluded from all bands (dispute pause)');
  });

  it('surfaces the haircut and band rules as assumptions whenever anything is in scope', () => {
    const projection = projectCollections([rec(1)], [], HORIZON, clock);
    expect(projection.assumptions).toContainEqual(expect.stringContaining('overdue haircuts on days past due: <=30d x0.8'));
    expect(projection.assumptions).toContainEqual(expect.stringContaining('bands: optimistic propensity x1.25 (capped at 1)'));
  });

  it('an empty in-scope book carries only the scope assumption and empty views', () => {
    const projection = projectCollections([], [], HORIZON, clock);
    expect(projection.assumptions).toHaveLength(1);
    expect(projection.assumptions[0]).toContain('scope:');
    expect(projection.currencies).toEqual([]);
    expect(projection.evidenceRefs).toEqual([]);
  });

  it('stamps asOf from the injected Clock and derives horizonEnd = asOf + horizonDays', () => {
    const projection = projectCollections([], [], 14, clock);
    expect(projection.asOf).toBe(NOW);
    expect(projection.horizonDays).toBe(14);
    expect(projection.horizonEnd).toBe(dayFromNow(14));
  });

  it('is deterministic — identical inputs + clock yield identical projections', () => {
    const receivables = [rec(1), rec(2, { dueDate: dayFromNow(-45) }), rec(3, { currency: 'USD' })];
    const behavior = [propensity(CUST_A, 0.5), propensity(CUST_B, 0.9)];
    expect(projectCollections(receivables, behavior, HORIZON, clock)).toEqual(
      projectCollections(receivables, behavior, HORIZON, clock),
    );
  });

  it('never mutates its inputs (frozen pin)', () => {
    const receivables = deepFreeze([rec(1), rec(2, { disputed: true })]);
    const behavior = deepFreeze([propensity(CUST_A, 0.5)]);
    let projection: ReturnType<typeof projectCollections> | undefined;
    expect(() => (projection = projectCollections(receivables, behavior, HORIZON, clock))).not.toThrow();
    expect(projection!.currencies[0]!.inScopeCount).toBe(1);
  });
});

describe('projectCollections — multi-currency', () => {
  it('bands stay per-currency in first-seen order; cross-currency sums are structurally impossible', () => {
    const projection = projectCollections(
      [
        rec(1, { currency: 'KES' }), // propensity 0.5 → expected 400k
        rec(2, { currency: 'USD', balanceMinor: 2_000_000n, dueDate: dayFromNow(-45), customerId: CUST_B }),
      ],
      [propensity(CUST_A, 0.5), propensity(CUST_B, 1.0)],
      HORIZON,
      clock,
    );
    expect(projection.currencies.map((c) => c.currency)).toEqual(['KES', 'USD']);
    expect(projection.currencies[0]).toMatchObject({ expectedMinor: 400_000n });
    expect(projection.currencies[1]).toMatchObject({
      pessimisticMinor: 900_000n,
      expectedMinor: 1_200_000n,
      optimisticMinor: 1_200_000n,
    });
  });
});

describe('projectCollections — stable error codes', () => {
  const brokenClock: Clock = { now: () => new Date('not-a-date') };
  it.each([
    ['horizonDays 0', (c: Clock) => projectCollections([], [], 0, c), 'PROJ_HORIZON_INVALID'],
    ['horizonDays negative', (c: Clock) => projectCollections([], [], -5, c), 'PROJ_HORIZON_INVALID'],
    ['horizonDays fractional', (c: Clock) => projectCollections([], [], 1.5, c), 'PROJ_HORIZON_INVALID'],
    ['horizonDays not a number', (c: Clock) => projectCollections([], [], '30' as unknown as number, c), 'PROJ_HORIZON_INVALID'],
    ['broken clock', (c: Clock) => projectCollections([], [], 30, brokenClock), 'PROJ_CLOCK_INVALID'],
    ['behavior fact propensity > 1', (c: Clock) => projectCollections([], [propensity(CUST_A, 1.5)], 30, c), 'PROJ_PROPENSITY_INVALID'],
    ['behavior fact propensity < 0', (c: Clock) => projectCollections([], [propensity(CUST_A, -0.1)], 30, c), 'PROJ_PROPENSITY_INVALID'],
    ['behavior fact propensity NaN', (c: Clock) => projectCollections([], [propensity(CUST_A, NaN)], 30, c), 'PROJ_PROPENSITY_INVALID'],
    ['behavior fact customerId not uuid', (c: Clock) => projectCollections([], [propensity('cust' as unknown as Uuid, 0.5)], 30, c), 'PROJ_BEHAVIOR_FACT_INVALID'],
    ['duplicate behavior fact', (c: Clock) => projectCollections([], [propensity(CUST_A, 0.5), propensity(CUST_A, 0.9)], 30, c), 'PROJ_BEHAVIOR_FACT_DUPLICATE'],
    ['duplicate receivable', (c: Clock) => projectCollections([rec(1), rec(1)], [], 30, c), 'PROJ_RECEIVABLE_DUPLICATE'],
    ['bad balance', (c: Clock) => projectCollections([rec(1, { balanceMinor: -1n })], [], 30, c), 'PROJ_BALANCE_INVALID'],
    ['bad dueDate', (c: Clock) => projectCollections([rec(1, { dueDate: 'tomorrow' })], [], 30, c), 'PROJ_DUE_DATE_INVALID'],
  ])('%s → %s', (_label, fn, code) => {
    expectCode(() => fn(clock), code);
  });
});
