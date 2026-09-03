import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Currency, type Uuid, uuid } from '../shared';
import {
  AGE_BUCKET_POINTS,
  AMOUNT_TIERS,
  computePriorities,
  rankPriorities,
  scoreReceivable,
  amountTierOf,
  bandFor,
  bucketForAgeDays,
  type CustomerFacts,
  type ReceivableFacts,
  type ReceivableScore,
} from './scoring';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const CUSTOMER = uid(902);
const NOW = '2026-06-15T00:00:00.000Z';
const at = (iso: string = NOW): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const facts = (overrides: Partial<ReceivableFacts> = {}): ReceivableFacts => ({
  receivableId: uid(903),
  orgId: ORG,
  customerId: CUSTOMER,
  amountMinor: 500_000,
  currency: 'KES',
  status: 'open',
  agingBucket: '31-60',
  ageDays: 45,
  disputed: false,
  ...overrides,
});

const componentKeys = (score: ReceivableScore): string[] => score.components.map((c) => c.key);

// --- the scoring tables are configuration -----------------------------------------------

describe('scoring tables — the expression is published config, not hidden math', () => {
  it('AGE_BUCKET_POINTS covers every bucket exactly (table)', () => {
    expect(AGE_BUCKET_POINTS).toEqual({ '0-30': 10, '31-60': 25, '61-90': 40, '90+': 60 });
  });

  it('bucketForAgeDays matches the receivables-lane bucketing rules (boundaries)', () => {
    const table: Array<[number, string]> = [
      [0, '0-30'],
      [30, '0-30'],
      [31, '31-60'],
      [60, '31-60'],
      [61, '61-90'],
      [90, '61-90'],
      [91, '90+'],
      [365, '90+'],
    ];
    for (const [days, bucket] of table) {
      expect(bucketForAgeDays(days), `${days} days`).toBe(bucket);
    }
  });

  it('AMOUNT_TIERS are ordered, bounded and deterministic (table)', () => {
    const expected: Array<[string, number | null, number]> = [
      ['<10k_minor', 1_000_000, 0],
      ['10k-50k_minor', 5_000_000, 5],
      ['50k-200k_minor', 20_000_000, 10],
      ['200k+_minor', null, 20],
    ];
    expect(AMOUNT_TIERS.map((t) => [t.label, t.maxMinor, t.points])).toEqual(expected);
    for (const [i, tier] of AMOUNT_TIERS.entries()) {
      const previous = AMOUNT_TIERS[i - 1];
      // contiguous bands: every bounded tier's bound is strictly past the previous tier's bound
      if (previous && tier.maxMinor !== null) {
        expect(tier.maxMinor, `tier ${tier.label}`).toBeGreaterThan(previous.maxMinor ?? 0);
      }
    }
  });

  it('amountTierOf fires the right tier at every boundary (table)', () => {
    const table: Array<[number, string]> = [
      [999_999, '<10k_minor'],
      [1_000_000, '10k-50k_minor'],
      [4_999_999, '10k-50k_minor'],
      [5_000_000, '50k-200k_minor'],
      [19_999_999, '50k-200k_minor'],
      [20_000_000, '200k+_minor'],
    ];
    for (const [minor, label] of table) {
      expect(amountTierOf(minor).label, `${minor} minor`).toBe(label);
    }
  });

  it('bandFor maps the published thresholds exactly (boundaries)', () => {
    const table: Array<[number, string]> = [
      [-100, 'low'],
      [0, 'low'],
      [19, 'low'],
      [20, 'medium'],
      [44, 'medium'],
      [45, 'high'],
      [69, 'high'],
      [70, 'critical'],
      [130, 'critical'],
    ];
    for (const [score, band] of table) {
      expect(bandFor(score), `score ${score}`).toBe(band);
    }
  });
});

// --- scoreReceivable: every component is exposed ------------------------------------------

describe('scoreReceivable — transparent components (H7: no opaque numbers)', () => {
  it('scores the age leg per bucket (table)', () => {
    const table: Array<[ReceivableFacts['agingBucket'], number, number]> = [
      ['0-30', 5, 10],
      ['31-60', 45, 25],
      ['61-90', 75, 40],
      ['90+', 120, 60],
    ];
    for (const [bucket, ageDays, points] of table) {
      const score = scoreReceivable(facts({ agingBucket: bucket, ageDays }));
      expect(componentKeys(score)).toEqual(['age', 'amount']);
      const age = score.components.find((c) => c.key === 'age')!;
      expect(age.points).toBe(points);
      expect(age.reason).toContain(bucket);
      expect(score.score).toBe(points); // 500_000 minor → amount tier 0
    }
  });

  it('scores the amount leg per tier (table)', () => {
    const table: Array<[number, number]> = [
      [500_000, 0],
      [1_000_000, 5],
      [5_000_000, 10],
      [20_000_000, 20],
      [95_000_000, 20],
    ];
    for (const [amountMinor, points] of table) {
      const score = scoreReceivable(facts({ amountMinor }));
      const amount = score.components.find((c) => c.key === 'amount')!;
      expect(amount.points, `${amountMinor} minor`).toBe(points);
      expect(amount.reason).toContain(String(amountMinor));
    }
  });

  it('boosts a broken promise (+15, the E27 boost) with an evidence reason', () => {
    const score = scoreReceivable(facts({ promiseState: 'broken' }));
    const boost = score.components.find((c) => c.key === 'brokenPromise')!;
    expect(boost.points).toBe(15);
    expect(boost.reason).toContain('broke a promise');
    expect(score.score).toBe(25 + 15);
  });

  it('flags unresponsive prior actions only at ≥3 touches with zero responses (table)', () => {
    const table: Array<[number | undefined, number | undefined, boolean]> = [
      [undefined, undefined, false],
      [3, 0, true],
      [5, 0, true],
      [2, 0, false],
      [3, 1, false],
      [10, 10, false],
    ];
    for (const [total, withResponse, expected] of table) {
      const score = scoreReceivable(
        facts({
          priorActionCounts:
            total === undefined ? undefined : { total, withResponse: withResponse ?? 0 },
        }),
      );
      const flag = score.components.find((c) => c.key === 'unresponsivePriorActions');
      expect(flag !== undefined, `total=${String(total)} withResponse=${String(withResponse)}`).toBe(expected);
      if (flag) expect(flag.points).toBe(8);
    }
  });

  it('rewards a recent payment (+5) only inside the 30-day window against the injected now', () => {
    const base = { lastPaymentAt: '2026-06-01T00:00:00.000Z' };
    const withNow = { now: new Date(NOW) };
    expect(scoreReceivable(facts(base), undefined, withNow).components.some((c) => c.key === 'recentPayment')).toBe(true);
    // 31 days back → outside the window
    expect(
      scoreReceivable(facts({ lastPaymentAt: '2026-05-15T00:00:00.000Z' }), undefined, withNow).components.some(
        (c) => c.key === 'recentPayment',
      ),
    ).toBe(false);
    // exactly 30 days → still inside
    expect(
      scoreReceivable(facts({ lastPaymentAt: '2026-05-16T00:00:00.000Z' }), undefined, withNow).components.some(
        (c) => c.key === 'recentPayment',
      ),
    ).toBe(true);
    // no `now` supplied → recency is not scored at all (no hidden clock)
    expect(scoreReceivable(facts(base)).components.some((c) => c.key === 'recentPayment')).toBe(false);
  });

  it('bumps unreliable promisers (+10) below the 50% threshold from customer facts only', () => {
    const customer: CustomerFacts = { customerId: CUSTOMER, promiseReliabilityPct: 40 };
    const score = scoreReceivable(facts(), customer);
    const flag = score.components.find((c) => c.key === 'unreliablePromiser')!;
    expect(flag.points).toBe(10);
    expect(flag.reason).toContain('40%');

    expect(
      scoreReceivable(facts(), { customerId: CUSTOMER, promiseReliabilityPct: 50 }).components.some(
        (c) => c.key === 'unreliablePromiser',
      ),
    ).toBe(false); // threshold is exclusive
    // customer facts for a DIFFERENT customer never touch this receivable
    expect(
      scoreReceivable(facts(), { customerId: uid(999), promiseReliabilityPct: 10 }).components.some(
        (c) => c.key === 'unreliablePromiser',
      ),
    ).toBe(false);
  });

  it('applies the dispute adjustment (−100): disputes sink, reasons say why', () => {
    const score = scoreReceivable(facts({ disputed: true }));
    const adjustment = score.components.find((c) => c.key === 'openDispute')!;
    expect(adjustment.points).toBe(-100);
    expect(adjustment.reason).toContain('SPEC §29');
    expect(score.score).toBe(25 + 0 - 100);
    expect(score.band).toBe('low');
  });

  it('applies the pending-promise adjustment (−25): back off a live promise', () => {
    const score = scoreReceivable(facts({ promiseState: 'pending' }));
    const adjustment = score.components.find((c) => c.key === 'pendingPromise')!;
    expect(adjustment.points).toBe(-25);
    expect(score.score).toBe(25 - 25);
    expect(score.band).toBe('low');
  });

  it('the total is always the plain sum of the exposed components (re-derivable)', () => {
    const batches: ReceivableFacts[][] = [
      [facts({ promiseState: 'broken', amountMinor: 25_000_000, agingBucket: '90+', ageDays: 120 })],
      [facts({ disputed: true, priorActionCounts: { total: 4, withResponse: 0 } })],
      [facts({ promiseState: 'pending', lastPaymentAt: '2026-06-10T00:00:00.000Z' })],
    ];
    for (const batch of batches) {
      for (const score of batch.map((f) => scoreReceivable(f, { customerId: CUSTOMER, promiseReliabilityPct: 20 }, { now: new Date(NOW) }))) {
        expect(score.score).toBe(score.components.reduce((sum, c) => sum + c.points, 0));
        expect(score.reasons.length).toBe(score.components.length);
        for (const reason of score.reasons) expect(reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('non-collectible receivables score 0 with a single explanatory component', () => {
    const table: ReceivableFacts['status'][] = ['settled', 'written_off', 'uncollectible', 'voided'];
    for (const status of table) {
      const score = scoreReceivable(facts({ status, disputed: true, promiseState: 'broken' }));
      expect(score.collectible).toBe(false);
      expect(score.score).toBe(0);
      expect(score.band).toBe('low');
      expect(componentKeys(score)).toEqual(['notCollectible']);
      expect(score.reasons[0]).toContain(status);
    }
  });
});

// --- corrupt facts fail loudly --------------------------------------------------------------

describe('scoreReceivable — corrupt projections are rejected (stable INTEL_* codes)', () => {
  it('rejects malformed receivable facts (table)', () => {
    const table: Array<[Partial<ReceivableFacts>, string]> = [
      [{ receivableId: '  ' as unknown as Uuid }, 'blank receivableId'],
      [{ orgId: '' as unknown as Uuid }, 'blank orgId'],
      [{ customerId: undefined as unknown as Uuid }, 'missing customerId'],
      [{ amountMinor: 0 }, 'zero amount'],
      [{ amountMinor: -5 }, 'negative amount'],
      [{ amountMinor: 1.5 }, 'fractional amount'],
      [{ currency: undefined as unknown as Currency }, 'missing currency'],
      [{ status: 'draft' as ReceivableFacts['status'] }, 'draft is not a projectable status'],
      [{ agingBucket: 'current' as ReceivableFacts['agingBucket'] }, 'unknown bucket'],
      [{ ageDays: -1 }, 'negative ageDays'],
      [{ agingBucket: '90+', ageDays: 45 }, 'bucket/ageDays mismatch'],
      [{ disputed: undefined as unknown as boolean }, 'missing disputed flag'],
      [{ promiseState: 'cancelled' as ReceivableFacts['promiseState'] }, 'unknown promiseState'],
      [{ lastPaymentAt: 'not-a-date' }, 'bad lastPaymentAt'],
      [{ consentPresent: 'yes' as unknown as boolean }, 'non-boolean consentPresent'],
      [{ priorActionCounts: { total: 2, withResponse: 3 } }, 'responses exceed touches'],
    ];
    for (const [overrides, label] of table) {
      try {
        scoreReceivable(facts(overrides));
      } catch (error) {
        expect(error, label).toBeInstanceOf(DomainError);
        expect((error as DomainError).code, label).toBe('INTEL_FACTS_INVALID');
        continue;
      }
      throw new Error(`expected INTEL_FACTS_INVALID for: ${label}`);
    }
  });

  it('rejects malformed customer facts (table)', () => {
    const table: CustomerFacts[] = [
      { customerId: ' ' as unknown as Uuid },
      { customerId: CUSTOMER, promiseReliabilityPct: -1 },
      { customerId: CUSTOMER, promiseReliabilityPct: 101 },
      { customerId: CUSTOMER, promiseReliabilityPct: Number.NaN },
    ];
    for (const customer of table) {
      expectCode(() => scoreReceivable(facts(), customer), 'INTEL_CUSTOMER_FACTS_INVALID');
    }
  });

  it('rejects a broken injected now (INTEL_CLOCK_INVALID)', () => {
    expectCode(
      () => scoreReceivable(facts(), undefined, { now: new Date('nope') }),
      'INTEL_CLOCK_INVALID',
    );
  });
});

// --- ranking: deterministic total order ------------------------------------------------------

describe('rankPriorities — deterministic ranking with documented tie-breaks', () => {
  it('orders by score descending across bands (table)', () => {
    const ranked = rankPriorities([
      facts({ receivableId: uid(1), agingBucket: '0-30', ageDays: 10 }), // 10 → low
      facts({ receivableId: uid(2), agingBucket: '90+', ageDays: 120, amountMinor: 25_000_000 }), // 80 → critical
      facts({ receivableId: uid(3), agingBucket: '61-90', ageDays: 70, amountMinor: 8_000_000 }), // 50 → high
      facts({ receivableId: uid(4), agingBucket: '31-60', ageDays: 45, amountMinor: 3_000_000 }), // 30 → medium
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(3), uid(4), uid(1)]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(ranked.map((r) => r.band)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('tie-break 1: equal score → larger exposure first', () => {
    // both score 30: '31-60'(25)+5M-tier(5) vs '0-30'(10)+200k+-tier(20)
    const ranked = rankPriorities([
      facts({ receivableId: uid(1), agingBucket: '0-30', ageDays: 10, amountMinor: 25_000_000 }),
      facts({ receivableId: uid(2), agingBucket: '31-60', ageDays: 45, amountMinor: 3_000_000 }),
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(1), uid(2)]);
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
  });

  it('tie-break 2: equal score + amount → older first (within the same bucket)', () => {
    const ranked = rankPriorities([
      facts({ receivableId: uid(1), ageDays: 45 }),
      facts({ receivableId: uid(2), ageDays: 50 }),
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(1)]);
  });

  it('tie-break 3: fully identical facts → receivableId ascending (stable total order)', () => {
    const ranked = rankPriorities([
      facts({ receivableId: uid(7) }),
      facts({ receivableId: uid(2) }),
      facts({ receivableId: uid(5) }),
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(5), uid(7)]);
    // and the run is repeatable — same input, same order, always
    expect(rankPriorities(ranked.map((r) => facts({ receivableId: r.receivableId }))).map((r) => r.receivableId)).toEqual(
      ranked.map((r) => r.receivableId),
    );
  });

  it('non-collectible receivables always sort last, whatever their would-be facts', () => {
    const ranked = rankPriorities([
      facts({ receivableId: uid(1), status: 'settled', agingBucket: '90+', ageDays: 120 }),
      facts({ receivableId: uid(2), agingBucket: '0-30', ageDays: 5 }),
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(1)]);
    expect(ranked[1]!.collectible).toBe(false);
  });

  it('a dispute sinks a receivable below its peers but keeps it collectible', () => {
    const ranked = rankPriorities([
      facts({ receivableId: uid(1), disputed: true }),
      facts({ receivableId: uid(2), agingBucket: '0-30', ageDays: 10 }),
    ]);
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(1)]);
    expect(ranked[1]!.score).toBeLessThan(0);
  });

  it('refuses duplicate receivable facts in one run (INTEL_FACTS_DUPLICATE)', () => {
    expectCode(() => rankPriorities([facts(), facts({ customerId: uid(9) })]), 'INTEL_FACTS_DUPLICATE');
  });

  it('refuses mixed-currency batches (INTEL_CURRENCY_MISMATCH — R10 discipline)', () => {
    expectCode(
      () =>
        rankPriorities([
          facts({ currency: 'KES' }),
          facts({ receivableId: uid(2), currency: 'USD' }),
        ]),
      'INTEL_CURRENCY_MISMATCH',
    );
  });

  it('refuses duplicate customer facts (INTEL_CUSTOMER_FACTS_DUPLICATE)', () => {
    expectCode(
      () =>
        rankPriorities(
          [facts(), facts({ receivableId: uid(2) })],
          [
            { customerId: CUSTOMER, promiseReliabilityPct: 10 },
            { customerId: CUSTOMER, promiseReliabilityPct: 90 },
          ],
        ),
      'INTEL_CUSTOMER_FACTS_DUPLICATE',
    );
  });

  it('never mutates the inputs (no-mutation pin)', () => {
    const batch = [
      facts({ receivableId: uid(1), agingBucket: '90+', ageDays: 120, amountMinor: 25_000_000 }),
      facts({ receivableId: uid(2), status: 'settled' }),
      facts({ receivableId: uid(3), disputed: true }),
    ];
    const customers: readonly CustomerFacts[] = [{ customerId: CUSTOMER, promiseReliabilityPct: 15 }];
    const before = JSON.stringify([batch, customers]);
    Object.freeze(batch);
    Object.freeze(customers);
    rankPriorities(batch, customers, { now: new Date(NOW) });
    expect(JSON.stringify([batch, customers])).toBe(before);
  });
});

// --- the catalog event wrapper ---------------------------------------------------------------

describe('computePriorities — emits intelligence.priorityComputed (docs/04 deferred list)', () => {
  it('ranks and emits one run-level event with the ranked ids', () => {
    const { ranked, events } = computePriorities(
      {
        orgId: ORG,
        receivables: [
          facts({ receivableId: uid(1), agingBucket: '0-30', ageDays: 10 }),
          facts({ receivableId: uid(2), agingBucket: '90+', ageDays: 120, amountMinor: 25_000_000 }),
        ],
      },
      at('2026-06-15T09:30:00.000Z'),
    );
    expect(ranked.map((r) => r.receivableId)).toEqual([uid(2), uid(1)]);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.name).toBe('intelligence.priorityComputed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(ORG);
    expect(new Date(event.occurredAt).toISOString()).toBe('2026-06-15T09:30:00.000Z');
    expect(event.payload).toEqual({
      orgId: ORG,
      receivableCount: 2,
      rankedReceivableIds: [uid(2), uid(1)],
      computedAt: '2026-06-15T09:30:00.000Z',
    });
  });

  it('propagates scoring validation (malformed facts never emit events)', () => {
    expectCode(() => computePriorities({ orgId: ORG, receivables: [facts({ ageDays: 400 })] }, at()), 'INTEL_FACTS_INVALID');
    expectCode(() => computePriorities({ orgId: ' ' as unknown as Uuid, receivables: [] }, at()), 'INTEL_FACTS_INVALID');
  });

  it('rejects a broken clock (INTEL_CLOCK_INVALID)', () => {
    expectCode(
      () => computePriorities({ orgId: ORG, receivables: [] }, { now: () => new Date('nope') }),
      'INTEL_CLOCK_INVALID',
    );
  });
});
