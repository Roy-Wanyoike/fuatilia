import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  HIGH_PRIORITY_MIN_SCORE,
  LARGE_EXPOSURE_MINOR,
  RECOMMENDED_CAPABILITIES,
  RECOMMENDATION_RULES,
  collectionRecommendations,
  type RecommendationsQuery,
} from './recommendations';
import type { CustomerFact, DisputeFact, PromiseFact, ReceivableFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(300);
const OTHER_ORG = uid(399);
const CUSTOMER = uid(301);

const R1 = uid(310);
const R2 = uid(311);
const R3 = uid(312);
const PM1 = uid(330);
const D1 = uid(340);

const NOW = new Date('2026-03-15T09:00:00.000Z');
const DAY_MS = 86_400_000;
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const daysAhead = (days: number): string => new Date(NOW.getTime() + days * DAY_MS).toISOString();
const clock: Clock = { now: () => NOW };

const receivable = (overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  orgId: ORG,
  receivableId: R1,
  invoiceId: uid(3310),
  customerId: CUSTOMER,
  currency: 'KES',
  originalMinor: 1_000_000n,
  paidMinor: 0n,
  state: 'open',
  dueDate: daysAgo(45),
  ...overrides,
});

const promise = (overrides: Partial<PromiseFact> = {}): PromiseFact => ({
  orgId: ORG,
  promiseId: PM1,
  receivableId: R1,
  status: 'pending',
  promisedDate: daysAhead(5),
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

const query = (overrides: Partial<RecommendationsQuery> = {}): RecommendationsQuery => ({
  orgId: ORG,
  receivables: [receivable()],
  customers: [],
  promises: [],
  disputes: [],
  ...overrides,
});

/** Run the matrix for exactly one receivable scenario. */
const recommend = (overrides: Partial<ReceivableFact> = {}, q: Partial<RecommendationsQuery> = {}) => {
  const answers = collectionRecommendations(query({ receivables: [receivable(overrides)], ...q }), clock);
  return answers;
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

// --- the published decision surface -----------------------------------------

describe('the recommendation contract', () => {
  it('publishes the capability vocabulary, the rule order and the constants', () => {
    expect(RECOMMENDED_CAPABILITIES).toEqual([
      'offer_payment_plan',
      'send_payment_link',
      'human_review',
      'do_nothing_yet',
    ]);
    expect(RECOMMENDATION_RULES).toEqual([
      'dispute_open',
      'credit_covers_balance',
      'not_yet_due',
      'promise_pending_future',
      'promise_failed',
      'aged_90_plus',
      'customer_unresponsive',
      'large_stale_balance',
      'default_self_serve',
    ]);
    expect(HIGH_PRIORITY_MIN_SCORE).toBe(30);
    expect(LARGE_EXPOSURE_MINOR).toBe(5_000_000n); // KES 50,000.00
  });
});

// --- the matrix -------------------------------------------------------------

describe('the first-match-wins matrix', () => {
  it('rule 1 dispute_open → human_review (a contested debt needs a decision whatever its score)', () => {
    const answers = recommend(
      { dueDate: daysAgo(10), originalMinor: 500_000n }, // score 14 < 30 — surfaced only because disputed
      { disputes: [dispute()] },
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]!.recommended).toBe('human_review');
    expect(answers[0]!.rule).toBe('dispute_open');
  });

  it('rule 2 credit_covers_balance → do_nothing_yet (allocate the C4 credit first)', () => {
    const answers = recommend(
      { dueDate: daysAgo(95) }, // score 38 ≥ 30
      { customers: [customer({ creditBalanceMinor: 2_000_000n, creditCurrency: 'KES' })] },
    );
    expect(answers[0]!.recommended).toBe('do_nothing_yet');
    expect(answers[0]!.rule).toBe('credit_covers_balance');
    expect(answers[0]!.evidenceIds).toContain(CUSTOMER);
  });

  it('rule 2 outranks rule 3 — covering credit wins even before the due date', () => {
    const answers = recommend(
      { dueDate: daysAhead(10) },
      { customers: [customer({ creditBalanceMinor: 2_000_000n, creditCurrency: 'KES' })], options: { highPriorityMinScore: 0 } },
    );
    expect(answers[0]!.rule).toBe('credit_covers_balance');
  });

  it('rule 3 not_yet_due → do_nothing_yet (dunning starts after the due date)', () => {
    const answers = recommend({ dueDate: daysAhead(10) }, { options: { highPriorityMinScore: 0 } });
    expect(answers[0]!.recommended).toBe('do_nothing_yet');
    expect(answers[0]!.rule).toBe('not_yet_due');
  });

  it('rule 4 promise_pending_future → do_nothing_yet (waiting on the commitment)', () => {
    // 90+ bucket (30) + 20M balance band (12) + promised status (−10) = 32 ≥ 30 bar
    const answers = recommend(
      { dueDate: daysAgo(95), originalMinor: 20_000_000n },
      { promises: [promise({ promisedDate: daysAhead(5) })] },
    );
    expect(answers[0]!.recommended).toBe('do_nothing_yet');
    expect(answers[0]!.rule).toBe('promise_pending_future');
    expect(answers[0]!.evidenceIds).toContain(PM1);
  });

  it('rule 5 promise_failed → offer_payment_plan, both for broken and past-due promises', () => {
    const broken = recommend({ dueDate: daysAgo(95) }, { promises: [promise({ status: 'broken' })] });
    expect(broken[0]!.recommended).toBe('offer_payment_plan');
    expect(broken[0]!.rule).toBe('promise_failed');

    // stale promisedDate: status is still 'promised' (−10) → 30+12−10 = 32 ≥ 30 bar
    const stale = recommend(
      { dueDate: daysAgo(95), originalMinor: 20_000_000n },
      { promises: [promise({ promisedDate: daysAgo(2) })] },
    );
    expect(stale[0]!.recommended).toBe('offer_payment_plan');
    expect(stale[0]!.rule).toBe('promise_failed');
  });

  it('rule 5 outranks rule 6 — a failed promise restructures before escalation', () => {
    const answers = recommend({ dueDate: daysAgo(95) }, { promises: [promise({ status: 'broken' })] });
    expect(answers[0]!.rule).toBe('promise_failed'); // not aged_90_plus
  });

  it('rule 6 aged_90_plus → human_review (escalation territory)', () => {
    const answers = recommend({ dueDate: daysAgo(95) });
    expect(answers[0]!.recommended).toBe('human_review');
    expect(answers[0]!.rule).toBe('aged_90_plus');
  });

  it('rule 7 customer_unresponsive → human_review (automated channels exhausted)', () => {
    const answers = recommend(
      { dueDate: daysAgo(45) }, // bucket 31-60
      { customers: [customer({ flags: ['unresponsive', 'slow_payer', 'disputed_history'] })] }, // 10+8+14 = 32
    );
    expect(answers[0]!.recommended).toBe('human_review');
    expect(answers[0]!.rule).toBe('customer_unresponsive');
  });

  it('rule 8 large_stale_balance → offer_payment_plan (restructure, don\u2019t dun)', () => {
    // 61-90 bucket (20) + 20M balance band (12) = 32 ≥ 30 bar — exactly the top size band
    const answers = recommend({ dueDate: daysAgo(61), originalMinor: 20_000_000n });
    expect(answers[0]!.recommended).toBe('offer_payment_plan');
    expect(answers[0]!.rule).toBe('large_stale_balance');
  });

  it('rule 9 default_self_serve → send_payment_link (frictionless self-serve for the rest)', () => {
    // 0-30 bucket (0) + 20M balance band (12) + flags 6+8+3+4 = 21 → 33 ≥ 30 bar
    const answers = recommend(
      { dueDate: daysAgo(10), originalMinor: 20_000_000n },
      { customers: [customer({ flags: ['slow_payer', 'broken_promise', 'disputed_history', 'partial_payer'] })] },
    );
    expect(answers[0]!.recommended).toBe('send_payment_link');
    expect(answers[0]!.rule).toBe('default_self_serve');
  });
});

// --- boundaries -------------------------------------------------------------

describe('matrix boundaries', () => {
  it('credit covers the balance inclusively; one minor unit short falls through (table)', () => {
    const exact = recommend({ dueDate: daysAgo(95) }, { customers: [customer({ creditBalanceMinor: 1_000_000n, creditCurrency: 'KES' })] });
    expect(exact[0]!.rule).toBe('credit_covers_balance');

    const short = recommend({ dueDate: daysAgo(95) }, { customers: [customer({ creditBalanceMinor: 999_999n, creditCurrency: 'KES' })] });
    expect(short[0]!.rule).toBe('aged_90_plus'); // next matching rule

    const wrongCurrency = recommend(
      { dueDate: daysAgo(95) },
      { customers: [customer({ creditBalanceMinor: 9_999_999n, creditCurrency: 'USD' })] }, // R10: never cross-currency
    );
    expect(wrongCurrency[0]!.rule).toBe('aged_90_plus');
  });

  it('not_yet_due boundary: due later than now waits; due at exactly now does not (table)', () => {
    const future = recommend(
      { dueDate: new Date(NOW.getTime() + 1).toISOString() },
      { options: { highPriorityMinScore: 0 } },
    );
    expect(future[0]!.rule).toBe('not_yet_due');

    const exactlyNow = recommend({ dueDate: NOW.toISOString() }, { options: { highPriorityMinScore: 0 } });
    expect(exactlyNow[0]!.rule).toBe('default_self_serve');
  });

  it('promise boundary: promisedDate at exactly now is a FAILED promise; 1ms later it is pending (table)', () => {
    // both scenarios: 30 + 12 − 10 = 32 ≥ 30 bar so the matrix actually fires
    const now = recommend(
      { dueDate: daysAgo(95), originalMinor: 20_000_000n },
      { promises: [promise({ promisedDate: NOW.toISOString() })] },
    );
    expect(now[0]!.rule).toBe('promise_failed');

    const later = recommend(
      { dueDate: daysAgo(95), originalMinor: 20_000_000n },
      { promises: [promise({ promisedDate: new Date(NOW.getTime() + 1).toISOString() })] },
    );
    expect(later[0]!.rule).toBe('promise_pending_future');

    const noDate = recommend(
      { dueDate: daysAgo(95), originalMinor: 20_000_000n },
      { promises: [promise({ promisedDate: undefined })] },
    );
    expect(noDate[0]!.rule).toBe('aged_90_plus'); // nothing to wait on
  });

  it('aged_90_plus boundary: 90 days self-serves, 91 days escalates (table, zero bar)', () => {
    const day90 = recommend({ dueDate: daysAgo(90), originalMinor: 100_000n }, { options: { highPriorityMinScore: 0 } });
    expect(day90[0]!.rule).toBe('default_self_serve'); // bucket 61-90, small balance

    const day91 = recommend({ dueDate: daysAgo(91), originalMinor: 100_000n }, { options: { highPriorityMinScore: 0 } });
    expect(day91[0]!.rule).toBe('aged_90_plus');
  });

  it('large_stale_balance boundary: exactly KES 50,000 counts, below it does not; 0-30d never counts (table)', () => {
    const exact = recommend({ dueDate: daysAgo(61), originalMinor: 5_000_000n }, { options: { highPriorityMinScore: 0 } });
    expect(exact[0]!.rule).toBe('large_stale_balance');

    const below = recommend({ dueDate: daysAgo(61), originalMinor: 4_999_999n }, { options: { highPriorityMinScore: 0 } });
    expect(below[0]!.rule).toBe('default_self_serve');

    const young = recommend({ dueDate: daysAgo(10), originalMinor: 50_000_000n }, { options: { highPriorityMinScore: 0 } });
    expect(young[0]!.rule).toBe('default_self_serve'); // bucket 0-30 — large but fresh

    const tooOld = recommend({ dueDate: daysAgo(95), originalMinor: 50_000_000n });
    expect(tooOld[0]!.rule).toBe('aged_90_plus'); // escalation wins over restructuring
  });
});

// --- the high-priority filter ----------------------------------------------

describe('the high-priority filter', () => {
  it('excludes receivables below the bar (and includes exactly-at-bar scores)', () => {
    const below = recommend(); // 45d, band 2 → 18 < 30
    expect(below).toEqual([]);

    const atBar = recommend(
      { dueDate: daysAgo(61), originalMinor: 100_000n }, // 20 + 4 + 6(slow_payer) = 30
      { customers: [customer({ flags: ['slow_payer'] })] },
    );
    expect(atBar).toHaveLength(1);
    expect(atBar[0]!.priorityScore).toBe(30);
  });

  it('always surfaces disputed receivables, even far below the bar', () => {
    const answers = recommend(
      { dueDate: daysAgo(5), originalMinor: 10_000n }, // score 0
      { disputes: [dispute()] },
    );
    expect(answers).toHaveLength(1);
    expect(answers[0]!.rule).toBe('dispute_open');
    expect(answers[0]!.confidenceBasis).toContain('disputed receivables are always surfaced');
  });

  it('honors a per-query threshold override (table)', () => {
    const everything = recommend({}, { options: { highPriorityMinScore: 0 } });
    expect(everything).toHaveLength(1);

    const disputedOnly = recommend(
      {},
      { disputes: [dispute({ receivableId: R2 })], receivables: [receivable(), receivable({ receivableId: R2, invoiceId: uid(3311), dueDate: daysAgo(45) })], options: { highPriorityMinScore: 999 } },
    );
    expect(disputedOnly.map((a) => a.subject)).toEqual([R2]);
  });

  it('refuses a non-integer threshold (table)', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectCode(
        () => collectionRecommendations(query({ options: { highPriorityMinScore: bad } }), clock),
        'AGENT_THRESHOLD_INVALID',
      );
    }
  });
});

// --- answer shape, ordering, evidence ---------------------------------------

describe('answer shape, ordering and evidence', () => {
  it('keeps priority-rank order and carries rank/score through', () => {
    const answers = collectionRecommendations(
      query({
        receivables: [
          receivable({ receivableId: R1, invoiceId: uid(3310), dueDate: daysAgo(45) }), // 18 — below bar
          receivable({ receivableId: R2, invoiceId: uid(3311), dueDate: daysAgo(95) }), // 38 — aged_90_plus
          receivable({ receivableId: R3, invoiceId: uid(3312), dueDate: daysAgo(120), originalMinor: 20_000_000n }), // 30+12=42
        ],
      }),
      clock,
    );
    expect(answers.map((a) => [a.priorityRank, a.subject, a.rule])).toEqual([
      [1, R3, 'aged_90_plus'],
      [2, R2, 'aged_90_plus'],
    ]);
  });

  it('carries the issue-#35 answer shape with rule-specific reasons and evidence', () => {
    const answers = recommend({ dueDate: daysAgo(95) }, { promises: [promise({ status: 'broken' })] });
    const answer = answers[0]!;
    expect(answer.subject).toBe(R1);
    expect(answer.capability).toBe('collection_recommendation');
    expect(answer.orgId).toBe(ORG);
    expect(answer.customerId).toBe(CUSTOMER);
    expect(answer.recommended).toBe('offer_payment_plan');
    expect(answer.priorityRank).toBe(1);
    expect(answer.confidenceBasis).toContain('high-priority bar 30');
    expect(answer.reasons[0]).toContain('ranked #1 with priority score 50'); // 30 age + 8 size + 12 broken_promise
    expect(answer.reasons.some((r) => r.includes('broken — the commitment to pay failed'))).toBe(true);
    expect(answer.reasons.some((r) => r.includes('structured payment plan'))).toBe(true);
    expect(answer.evidenceIds).toContain(PM1);
    expect(answer.evidenceIds).toContain(R1);
  });

  it('every evidence id resolves to a supplied input (issue #35 acceptance)', () => {
    const q = query({
      receivables: [receivable({ dueDate: daysAgo(95) })],
      customers: [customer({ flags: ['slow_payer'] })],
      promises: [promise({ status: 'broken', promisedDate: undefined })],
      disputes: [dispute()],
    });
    const universe = new Set<string>([q.orgId]);
    for (const r of q.receivables) {
      universe.add(r.receivableId);
      universe.add(r.invoiceId);
      (r.evidenceIds ?? []).forEach((e) => universe.add(e));
    }
    for (const p of q.promises ?? []) universe.add(p.promiseId);
    for (const d of q.disputes ?? []) universe.add(d.disputeId);
    for (const item of collectionRecommendations(q, clock)) {
      for (const id of item.evidenceIds) expect(universe.has(id), id).toBe(true);
    }
  });
});

// --- refusals + purity ------------------------------------------------------

describe('refusals and purity', () => {
  it('inherits the shared validation refusals (table)', () => {
    expectCode(() => collectionRecommendations(query({ receivables: [] }), clock), 'AGENT_INPUT_EMPTY');
    expectCode(() => collectionRecommendations(query({ receivables: [receivable({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(
      () =>
        collectionRecommendations(
          query({ receivables: [receivable(), receivable({ receivableId: R2, invoiceId: uid(3311), currency: 'USD' })] }),
          clock,
        ),
      'AGENT_CURRENCY_MISMATCH',
    );
    expectCode(() => collectionRecommendations(query({ customers: [customer({ flags: ['wizard'] })] }), clock), 'AGENT_FLAG_UNKNOWN');
  });

  it('refuses broken clocks and reads the clock exactly once', () => {
    expectCode(() => collectionRecommendations(query(), undefined as unknown as Clock), 'AGENT_CLOCK_INVALID');

    let reads = 0;
    const counting: Clock = {
      now: () => {
        reads += 1;
        return NOW;
      },
    };
    collectionRecommendations(query({ receivables: [receivable({ dueDate: daysAgo(95) })] }), counting);
    expect(reads).toBe(1);
  });

  it('is deterministic across runs', () => {
    const make = (): RecommendationsQuery => ({
      orgId: ORG,
      receivables: [receivable({ dueDate: daysAgo(95) })],
      customers: [customer({ flags: ['slow_payer'] })],
      promises: [promise({ status: 'broken', promisedDate: undefined })],
      disputes: [],
    });
    expect(collectionRecommendations(make(), clock)).toEqual(collectionRecommendations(make(), clock));
  });

  it('never mutates the supplied facts (deep-freeze pin)', () => {
    const frozen = deepFreeze(
      query({
        receivables: [receivable({ dueDate: daysAgo(95) })],
        customers: [customer({ flags: ['slow_payer'] })],
        promises: [promise({ status: 'broken', promisedDate: undefined })],
      }),
    );
    expect(collectionRecommendations(frozen, clock)).toHaveLength(1);
  });

  it('advises only — do_nothing_yet is a real, reachable recommendation (no fund-truth writes)', () => {
    const answers = recommend({ dueDate: daysAgo(95) }, { customers: [customer({ creditBalanceMinor: 2_000_000n, creditCurrency: 'KES' })] });
    expect(RECOMMENDED_CAPABILITIES).toContain(answers[0]!.recommended);
    expect(answers[0]!.recommended).toBe('do_nothing_yet');
  });
});
