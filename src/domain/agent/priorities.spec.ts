import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  ageBucketOf,
  ageDaysOf,
  FLAG_WEIGHTS,
  type CustomerFact,
  type DisputeFact,
  type PromiseFact,
  type ReceivableFact,
} from './facts';
import {
  AGE_POINTS_PER_BUCKET,
  DEFAULT_SIZE_BANDS,
  PRIORITY_EXPRESSION,
  receivablePriorities,
  STATUS_POINTS,
  type PrioritiesQuery,
} from './priorities';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(200);
const OTHER_ORG = uid(299);
const CUSTOMER = uid(201);

const R1 = uid(210);
const R2 = uid(211);
const R3 = uid(212);
const PM1 = uid(230);
const D1 = uid(240);
const EV1 = uid(250);

const NOW = new Date('2026-03-15T09:00:00.000Z');
const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const clock: Clock = { now: () => NOW };

const receivable = (overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  orgId: ORG,
  receivableId: R1,
  invoiceId: uid(2210),
  customerId: CUSTOMER,
  currency: 'KES',
  originalMinor: 1_000_000n, // KES 10,000.00 → size band 1 (4 points)
  paidMinor: 0n,
  state: 'open',
  dueDate: daysAgo(45), // 31-60 → 10 age points
  ...overrides,
});

const promise = (overrides: Partial<PromiseFact> = {}): PromiseFact => ({
  orgId: ORG,
  promiseId: PM1,
  receivableId: R1,
  status: 'pending',
  promisedDate: daysAgo(-5), // five days from NOW
  ...overrides,
});

const dispute = (overrides: Partial<DisputeFact> = {}): DisputeFact => ({
  orgId: ORG,
  disputeId: D1,
  receivableId: R1,
  open: true,
  ...overrides,
});

const customer = (overrides: Partial<CustomerFact> = {}): CustomerFact => ({
  orgId: ORG,
  customerId: CUSTOMER,
  ...overrides,
});

const query = (overrides: Partial<PrioritiesQuery> = {}): PrioritiesQuery => ({
  orgId: ORG,
  receivables: [receivable()],
  customers: [],
  promises: [],
  disputes: [],
  ...overrides,
});

/** One default scored item — the harness for component-isolation tables. */
const scoreOf = (overrides: Partial<ReceivableFact> = {}, q: Partial<PrioritiesQuery> = {}) => {
  const answers = receivablePriorities(query({ receivables: [receivable(overrides)], ...q }), clock);
  expect(answers).toHaveLength(1);
  return answers[0]!;
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
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
};

// --- the published expression ----------------------------------------------

describe('the transparent scoring expression — public contract', () => {
  it('publishes the constants that make every score re-derivable', () => {
    expect(AGE_POINTS_PER_BUCKET).toBe(10);
    expect(DEFAULT_SIZE_BANDS).toEqual([
      { minMinor: 0n, points: 0 },
      { minMinor: 100_000n, points: 4 }, // KES 1,000.00
      { minMinor: 1_000_000n, points: 8 }, // KES 10,000.00
      { minMinor: 10_000_000n, points: 12 }, // KES 100,000.00
    ]);
    expect(Object.isFrozen(DEFAULT_SIZE_BANDS)).toBe(true);
    expect(STATUS_POINTS).toEqual({ disputed: 12, broken_promise: 12, promised: -10, open: 0 });
    expect(FLAG_WEIGHTS.slow_payer).toBe(6);
    expect(PRIORITY_EXPRESSION).toContain('agePoints');
    expect(PRIORITY_EXPRESSION).toContain('statusPoints');
  });
});

// --- components in isolation ------------------------------------------------

describe('priority components in isolation', () => {
  it('age points step by bucket, with the receivables-lane boundaries (table)', () => {
    const cases: Array<[number, number, string, number]> = [
      // [days past due, agePoints, bucket, bucketIndex*10]
      [0, 0, '0-30', 0],
      [30, 0, '0-30', 0],
      [31, 10, '31-60', 1],
      [60, 10, '31-60', 1],
      [61, 20, '61-90', 2],
      [90, 20, '61-90', 2],
      [91, 30, '90+', 3],
      [400, 30, '90+', 3],
    ];
    for (const [days, points, bucket, index] of cases) {
      const item = scoreOf({ dueDate: daysAgo(days) });
      expect(item.components.ageDays, `${days}d`).toBe(days);
      expect(item.components.ageBucket, `${days}d`).toBe(bucket);
      expect(item.components.agePoints, `${days}d`).toBe(points);
      expect(item.components.agePoints).toBe(AGE_POINTS_PER_BUCKET * index);
    }
  });

  it('size points follow the KES-calibrated bands, boundary-inclusive (table)', () => {
    const cases: Array<[bigint, number, number]> = [
      [99_999n, 0, 0], // < KES 1,000
      [100_000n, 1, 4], // == KES 1,000 (inclusive lower bound)
      [999_999n, 1, 4],
      [1_000_000n, 2, 8], // == KES 10,000
      [9_999_999n, 2, 8],
      [10_000_000n, 3, 12], // == KES 100,000
      [10_000_001n, 3, 12],
    ];
    for (const [balance, band, points] of cases) {
      const item = scoreOf({ originalMinor: balance });
      expect(item.components.sizeBand, `${balance}`).toBe(band);
      expect(item.components.sizePoints, `${balance}`).toBe(points);
      expect(item.balanceMinor).toBe(balance);
    }
  });

  it('flag points sum the published weights; duplicates count once; no fact means 0', () => {
    expect(scoreOf({}, { customers: [customer({ flags: ['slow_payer', 'partial_payer'] })] }).components.flagPoints).toBe(
      FLAG_WEIGHTS.slow_payer + FLAG_WEIGHTS.partial_payer,
    );
    expect(scoreOf({}, { customers: [customer({ flags: ['unresponsive', 'unresponsive'] })] }).components.flagPoints).toBe(
      FLAG_WEIGHTS.unresponsive,
    );
    expect(scoreOf({}, { customers: [customer({ flags: ['reliable_payer'] })] }).components.flagPoints).toBe(-6);
    expect(scoreOf().components.flagPoints).toBe(0); // no customer fact supplied
    expect(scoreOf({ customerId: uid(297) }).components.flagPoints).toBe(0); // customer not among the facts
  });

  it('status points take the first match: disputed > broken_promise > promised > open (table)', () => {
    const cases: Array<{ name: string; promises: PromiseFact[]; disputes: DisputeFact[]; status: string; points: number }> = [
      { name: 'plain open', promises: [], disputes: [], status: 'open', points: 0 },
      { name: 'pending promise', promises: [promise()], disputes: [], status: 'promised', points: -10 },
      { name: 'broken promise', promises: [promise({ status: 'broken' })], disputes: [], status: 'broken_promise', points: 12 },
      { name: 'open dispute', promises: [], disputes: [dispute()], status: 'disputed', points: 12 },
      { name: 'dispute beats broken promise', promises: [promise({ status: 'broken' })], disputes: [dispute()], status: 'disputed', points: 12 },
      { name: 'broken beats pending', promises: [promise(), promise({ promiseId: uid(231), status: 'broken' })], disputes: [], status: 'broken_promise', points: 12 },
      { name: 'closed dispute is plain', promises: [], disputes: [dispute({ open: false })], status: 'open', points: 0 },
      { name: 'fulfilled promise is plain', promises: [promise({ status: 'fulfilled' })], disputes: [], status: 'open', points: 0 },
    ];
    for (const c of cases) {
      const item = scoreOf({}, { promises: c.promises, disputes: c.disputes });
      expect(item.components.status, c.name).toBe(c.status);
      expect(item.components.statusPoints, c.name).toBe(c.points);
    }
  });
});

// --- the composite score + expression ---------------------------------------

describe('the composite score and its rendered expression', () => {
  it('a hand-computed composite: 45d + band1 + slow/partial flags + broken promise = 40', () => {
    const item = scoreOf(
      { dueDate: daysAgo(45) },
      {
        customers: [customer({ flags: ['slow_payer', 'partial_payer'] })],
        promises: [promise({ status: 'broken' })],
      },
    );
    // age 45d → bucket 1 → 10 | balance 1,000,000n → band 2 → 8 | flags 6+4=10 | broken +12
    expect(item.score).toBe(10 + 8 + 10 + 12);
    expect(item.components).toEqual({
      ageDays: 45,
      ageBucket: '31-60',
      agePoints: 10,
      sizeBand: 2,
      sizePoints: 8,
      flags: ['slow_payer', 'partial_payer'], // canonical AGENT_FLAGS order
      flagPoints: 10,
      status: 'broken_promise',
      statusPoints: 12,
    });
    expect(item.expression).toBe(
      `priority = age:31-60(1*10)=10 + size:band2=8 + flags:slow_payer(+6),partial_payer(+4)=10 + status:broken_promise(+12)=12 | total 40`,
    );
  });

  it('renders the same expression whatever order the flags were supplied in', () => {
    const a = scoreOf({}, { customers: [customer({ flags: ['slow_payer', 'partial_payer'] })] });
    const b = scoreOf({}, { customers: [customer({ flags: ['partial_payer', 'slow_payer'] })] });
    expect(a.expression).toBe(b.expression);
    expect(a.components.flags).toEqual(['slow_payer', 'partial_payer']);
  });

  it('renders negative status/flag terms without a plus sign', () => {
    const item = scoreOf({}, { customers: [customer({ flags: ['reliable_payer'] })], promises: [promise()] });
    expect(item.expression).toContain('flags:reliable_payer(-6)=-6');
    expect(item.expression).toContain('status:promised(-10)=-10');
    expect(item.score).toBe(10 + 8 - 6 - 10);
  });

  it('reasons expose the component story per item', () => {
    const item = scoreOf(
      { overdue: true },
      { customers: [customer({ flags: ['unresponsive'] })], disputes: [dispute()] },
    );
    expect(item.reasons).toContain('age 45d past due (bucket 31-60)');
    expect(item.reasons).toContain(`open balance 1000000 minor KES (size band 2)`);
    expect(item.reasons).toContain(`behavior flags: unresponsive(5)`);
    expect(item.reasons.some((r) => r.startsWith('open dispute '))).toBe(true);
    expect(item.reasons).toContain('flagged overdue by the receivables lane');
  });

  it('every answer item carries the issue-#35 shape', () => {
    const item = scoreOf();
    expect(item.subject).toBe(R1);
    expect(item.capability).toBe('receivable_priority');
    expect(item.orgId).toBe(ORG);
    expect(item.customerId).toBe(CUSTOMER);
    expect(item.currency).toBe('KES');
    expect(item.rank).toBe(1);
    expect(typeof item.score).toBe('number');
    expect(typeof item.confidenceBasis).toBe('string');
    expect(item.evidenceIds).toEqual([R1]);
  });
});

// --- ranking + tie-breaks ---------------------------------------------------

describe('ranking — deterministic order with documented tie-breaks', () => {
  it('orders by score descending and assigns ranks 1..n', () => {
    const answers = receivablePriorities(
      query({
        receivables: [
          receivable({ receivableId: R1, invoiceId: uid(2210), dueDate: daysAgo(10) }), // 0+8+0+0 = 8
          receivable({ receivableId: R2, invoiceId: uid(2211), dueDate: daysAgo(95) }), // 30+8+0+0 = 38
          receivable({ receivableId: R3, invoiceId: uid(2212), dueDate: daysAgo(45), originalMinor: 500_000n }), // 10+4+0+0 = 14
        ],
      }),
      clock,
    );
    expect(answers.map((a) => [a.rank, a.subject, a.score])).toEqual([
      [1, R2, 38],
      [2, R3, 14],
      [3, R1, 8],
    ]);
  });

  it('ties break on larger balance first', () => {
    const SMALL = uid(215);
    const LARGE = uid(216);
    const answers = receivablePriorities(
      query({
        receivables: [
          receivable({ receivableId: SMALL, invoiceId: uid(2215), originalMinor: 100_000n }), // band 1 → 10+4
          receivable({ receivableId: LARGE, invoiceId: uid(2216), originalMinor: 999_999n }), // band 1 → same score
        ],
      }),
      clock,
    );
    expect(answers.map((a) => [a.subject, a.score])).toEqual([
      [LARGE, 14],
      [SMALL, 14],
    ]);
  });

  it('ties on score AND balance break on the older due date, then receivable id', () => {
    const A = uid(211);
    const B = uid(212);
    const bands = [{ minMinor: 0n, points: 0 }]; // everything scores by age only → forced ties
    const answers = receivablePriorities(
      query({
        receivables: [
          receivable({ receivableId: B, invoiceId: uid(2211), dueDate: daysAgo(40), originalMinor: 5_000n }),
          receivable({ receivableId: A, invoiceId: uid(2210), dueDate: daysAgo(40), originalMinor: 9_000n }),
        ],
        options: { sizeBands: bands },
      }),
      clock,
    );
    // identical score (10) and identical balance? no — balance breaks the tie first
    expect(answers.map((a) => a.subject)).toEqual([A, B]); // 9,000n before 5,000n

    const tied = receivablePriorities(
      query({
        receivables: [
          receivable({ receivableId: B, invoiceId: uid(2211), dueDate: daysAgo(40), originalMinor: 7_000n }),
          receivable({ receivableId: A, invoiceId: uid(2210), dueDate: daysAgo(40), originalMinor: 7_000n }),
          receivable({ receivableId: R1, invoiceId: uid(2212), dueDate: daysAgo(40), originalMinor: 7_000n }),
        ],
        options: { sizeBands: bands },
      }),
      clock,
    );
    expect(tied.map((a) => a.subject)).toEqual([R1, A, B]); // pure id tie-break (uid 210 < 211 < 212)
    expect(tied.map((a) => a.rank)).toEqual([1, 2, 3]);
  });

  it('is deterministic across runs (same inputs → same ranked list)', () => {
    const make = (): PrioritiesQuery => ({
      orgId: ORG,
      receivables: [
        receivable({ receivableId: R1, invoiceId: uid(2210) }),
        receivable({ receivableId: R2, invoiceId: uid(2211), dueDate: daysAgo(80), originalMinor: 12_000_000n }),
      ],
      customers: [customer({ flags: ['slow_payer'] })],
      promises: [],
      disputes: [],
    });
    expect(receivablePriorities(make(), clock)).toEqual(receivablePriorities(make(), clock));
  });

  it('never mutates the supplied facts (deep-freeze pin)', () => {
    const frozen = deepFreeze(
      query({
        receivables: [
          receivable({ receivableId: R1, invoiceId: uid(2210) }),
          receivable({ receivableId: R2, invoiceId: uid(2211), dueDate: daysAgo(80) }),
        ],
      }),
    );
    expect(receivablePriorities(frozen, clock)).toHaveLength(2);
  });
});

// --- scope: what gets ranked ------------------------------------------------

describe('what gets ranked', () => {
  it('ranks only receivables with a collectible balance; closed history is excluded', () => {
    const answers = receivablePriorities(
      query({
        receivables: [
          receivable(),
          receivable({ receivableId: R2, invoiceId: uid(2211), state: 'settled' }),
          receivable({ receivableId: R3, invoiceId: uid(2212), state: 'partially_paid', paidMinor: 1_000_000n }),
        ],
      }),
      clock,
    );
    expect(answers.map((a) => a.subject)).toEqual([R1]);
  });

  it('returns an empty ranking (not an error) when every receivable is closed history', () => {
    const answers = receivablePriorities(query({ receivables: [receivable({ state: 'settled' })] }), clock);
    expect(answers).toEqual([]);
  });

  it('carries evidence from the receivable, its dispute/promise facts and the customer fact', () => {
    const item = scoreOf(
      { evidenceIds: [EV1] },
      { customers: [customer({ flags: ['slow_payer'], evidenceIds: [EV1] })], promises: [promise()] },
    );
    expect(item.evidenceIds).toEqual([R1, EV1, PM1]);
  });

  it('every evidence id resolves to a supplied input (issue #35 acceptance)', () => {
    const q = query({
      receivables: [receivable({ evidenceIds: [EV1] })],
      customers: [customer({ flags: ['slow_payer'], evidenceIds: [EV1] })],
      promises: [promise()],
      disputes: [dispute()],
    });
    const universe = new Set<string>([q.orgId]);
    for (const r of q.receivables) {
      universe.add(r.receivableId);
      universe.add(r.invoiceId);
      (r.evidenceIds ?? []).forEach((e) => universe.add(e));
    }
    for (const c of q.customers ?? []) (c.evidenceIds ?? []).forEach((e) => universe.add(e));
    for (const p of q.promises ?? []) universe.add(p.promiseId);
    for (const d of q.disputes ?? []) universe.add(d.disputeId);
    for (const item of receivablePriorities(q, clock)) {
      for (const id of item.evidenceIds) expect(universe.has(id), id).toBe(true);
    }
  });

  it('ignores promise/dispute facts whose receivable was not supplied (another scope)', () => {
    const item = scoreOf({}, { promises: [promise({ receivableId: uid(999) })], disputes: [dispute({ receivableId: uid(999) })] });
    expect(item.components.status).toBe('open');
    expect(item.evidenceIds).not.toContain(PM1);
  });
});

// --- options ----------------------------------------------------------------

describe('options — per-query size bands', () => {
  it('uses the supplied bands instead of the KES-calibrated defaults', () => {
    const item = scoreOf({ originalMinor: 5_000n }, { options: { sizeBands: [{ minMinor: 0n, points: 0 }, { minMinor: 5_000n, points: 7 }] } });
    expect(item.components.sizeBand).toBe(1);
    expect(item.components.sizePoints).toBe(7);
    expect(item.score).toBe(10 + 7); // age 45d + band 1
  });

  it('refuses malformed size bands (table)', () => {
    const bad: unknown[] = [
      [], // empty
      [{ minMinor: 1n, points: 0 }], // first band must start at 0
      [{ minMinor: 0n, points: 0 }, { minMinor: 0n, points: 1 }], // not ascending
      [{ minMinor: 0n, points: 0 }, { minMinor: 100n, points: 1 }, { minMinor: 50n, points: 2 }], // descending
      [{ minMinor: -1n, points: 0 }], // negative bound
      [{ minMinor: 0n, points: 1.5 }], // fractional points
      [{ minMinor: 0n, points: -2 }], // negative points
      [{ minMinor: 5 as unknown as bigint, points: 0 }], // bound not a bigint
    ];
    for (const bands of bad) {
      expectCode(
        () =>
          scoreOf(
            {},
            { options: { sizeBands: bands as NonNullable<PrioritiesQuery['options']>['sizeBands'] } },
          ),
        'AGENT_SIZE_BANDS_INVALID',
      );
    }
  });
});

// --- refusals ---------------------------------------------------------------

describe('refusals with stable AGENT_* codes', () => {
  it('refuses empty input — nothing to rank', () => {
    expectCode(() => receivablePriorities(query({ receivables: [] }), clock), 'AGENT_INPUT_EMPTY');
    expectCode(() => receivablePriorities(query({ receivables: undefined }), clock), 'AGENT_INPUT_EMPTY');
  });

  it('refuses mixed currencies in the ranked set (R10 — no cross-currency comparison)', () => {
    expectCode(
      () =>
        receivablePriorities(
          query({
            receivables: [receivable(), receivable({ receivableId: R2, invoiceId: uid(2211), currency: 'USD', originalMinor: 2_000n })],
          }),
          clock,
        ),
      'AGENT_CURRENCY_MISMATCH',
    );
  });

  it('a closed receivable in another currency does not trip the currency guard (history is never ranked)', () => {
    const answers = receivablePriorities(
      query({ receivables: [receivable(), receivable({ receivableId: R2, invoiceId: uid(2211), currency: 'USD', state: 'settled' })] }),
      clock,
    );
    expect(answers.map((a) => a.subject)).toEqual([R1]);
  });

  it('refuses duplicate fact ids (table)', () => {
    expectCode(() => receivablePriorities(query({ receivables: [receivable(), receivable()] }), clock), 'AGENT_RECEIVABLE_DUPLICATE');
    expectCode(
      () => receivablePriorities(query({ customers: [customer(), customer({ customerId: CUSTOMER })] }), clock),
      'AGENT_CUSTOMER_DUPLICATE',
    );
    expectCode(() => receivablePriorities(query({ promises: [promise(), promise()] }), clock), 'AGENT_PROMISE_DUPLICATE');
    expectCode(() => receivablePriorities(query({ disputes: [dispute(), dispute()] }), clock), 'AGENT_DISPUTE_DUPLICATE');
  });

  it('refuses cross-org facts of every kind (table)', () => {
    expectCode(() => receivablePriorities(query({ receivables: [receivable({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => receivablePriorities(query({ customers: [customer({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => receivablePriorities(query({ promises: [promise({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => receivablePriorities(query({ disputes: [dispute({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => receivablePriorities(query({ orgId: 'nope' as unknown as Uuid }), clock), 'AGENT_ID_MALFORMED');
  });

  it('surfaces the fact validators\u2019 stable codes through the query (table)', () => {
    expectCode(() => receivablePriorities(query({ receivables: [receivable({ paidMinor: 9_999_999_999n })] }), clock), 'AGENT_BALANCE_INVALID');
    expectCode(() => receivablePriorities(query({ receivables: [receivable({ dueDate: '2026-03-01' })] }), clock), 'AGENT_DATE_INVALID');
    expectCode(
      () => receivablePriorities(query({ receivables: [receivable({ currency: 'GBPX' as unknown as ReceivableFact['currency'] })] }), clock),
      'AGENT_CURRENCY_UNSUPPORTED',
    );
    expectCode(() => receivablePriorities(query({ customers: [customer({ flags: ['wizard'] })] }), clock), 'AGENT_FLAG_UNKNOWN');
  });

  it('refuses broken clocks and reads the clock exactly once', () => {
    expectCode(() => receivablePriorities(query(), undefined as unknown as Clock), 'AGENT_CLOCK_INVALID');
    expectCode(() => receivablePriorities(query(), { now: () => undefined as unknown as Date }), 'AGENT_CLOCK_INVALID');

    let reads = 0;
    const counting: Clock = {
      now: () => {
        reads += 1;
        return NOW;
      },
    };
    receivablePriorities(query(), counting);
    expect(reads).toBe(1);
  });

  it('derives ages from the injected instant only (determinism vs wall clock)', () => {
    const otherInstant = new Date('2026-04-01T09:00:00.000Z');
    const item = receivablePriorities(query(), { now: () => otherInstant })[0]!;
    expect(item.components.ageDays).toBe(ageDaysOf(receivable().dueDate, otherInstant));
    expect(item.components.ageBucket).toBe(ageBucketOf(item.components.ageDays));
  });
});
