import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  ageDaysOf,
  assertAgentClock,
  FLAG_WEIGHTS,
  type CustomerFact,
  type DisputeFact,
  type PaymentFact,
  type PromiseFact,
  type ReceivableFact,
} from './facts';
import { financialStateOf, type FinancialStateQuery } from './financial-state';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(100);
const OTHER_ORG = uid(199);
const CUSTOMER = uid(101);
const OTHER_CUSTOMER = uid(198);

const R1 = uid(110);
const R2 = uid(111);
const R3 = uid(112);
const P1 = uid(120);
const P2 = uid(121);
const PM1 = uid(130);
const D1 = uid(140);
const EV1 = uid(150);
const EV2 = uid(151);

const NOW = new Date('2026-03-15T09:00:00.000Z');
const DAY_MS = 86_400_000;
/** ISO instant exactly `days` before NOW (whole days — no flooring noise). */
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();
const clock: Clock = { now: () => NOW };

const receivable = (overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  orgId: ORG,
  receivableId: R1,
  invoiceId: uid(1110),
  customerId: CUSTOMER,
  currency: 'KES',
  originalMinor: 1_000_000n,
  paidMinor: 0n,
  state: 'open',
  dueDate: daysAgo(45),
  ...overrides,
});

const payment = (overrides: Partial<PaymentFact> = {}): PaymentFact => ({
  orgId: ORG,
  paymentId: P1,
  customerId: CUSTOMER,
  currency: 'KES',
  amountMinor: 400_000n,
  receivedAt: daysAgo(3),
  ...overrides,
});

const promise = (overrides: Partial<PromiseFact> = {}): PromiseFact => ({
  orgId: ORG,
  promiseId: PM1,
  receivableId: R1,
  status: 'pending',
  promisedDate: new Date(NOW.getTime() + 5 * DAY_MS).toISOString(),
  ...overrides,
});

const dispute = (overrides: Partial<DisputeFact> = {}): DisputeFact => ({
  orgId: ORG,
  disputeId: D1,
  receivableId: R1,
  open: true,
  category: 'pricing',
  ...overrides,
});

const customer = (overrides: Partial<CustomerFact> = {}): CustomerFact => ({
  orgId: ORG,
  customerId: CUSTOMER,
  ...overrides,
});

const query = (overrides: Partial<FinancialStateQuery> = {}): FinancialStateQuery => ({
  orgId: ORG,
  customerId: CUSTOMER,
  receivables: [receivable()],
  payments: [],
  promises: [],
  disputes: [],
  ...overrides,
});

/** Every id the caller supplied — the evidence-resolution universe (issue #35). */
const suppliedIds = (q: FinancialStateQuery): ReadonlySet<string> => {
  const ids = new Set<string>([q.orgId, q.customerId]);
  for (const r of q.receivables ?? []) {
    ids.add(r.receivableId);
    ids.add(r.invoiceId);
    (r.evidenceIds ?? []).forEach((e) => ids.add(e));
  }
  for (const p of q.payments ?? []) {
    ids.add(p.paymentId);
    (p.evidenceIds ?? []).forEach((e) => ids.add(e));
  }
  for (const p of q.promises ?? []) {
    ids.add(p.promiseId);
    (p.evidenceIds ?? []).forEach((e) => ids.add(e));
  }
  for (const d of q.disputes ?? []) {
    ids.add(d.disputeId);
    (d.evidenceIds ?? []).forEach((e) => ids.add(e));
  }
  if (q.customer) {
    ids.add(q.customer.customerId);
    (q.customer.evidenceIds ?? []).forEach((e) => ids.add(e));
  }
  return ids;
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

/** Recursively freeze — any in-place mutation by the lane throws in strict mode. */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((child) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
};

// --- exposure ---------------------------------------------------------------

describe('financialStateOf — exposure per currency', () => {
  it('sums open balances per currency with receivable evidence', () => {
    const answer = financialStateOf(
      query({
        receivables: [
          receivable(),
          receivable({ receivableId: R2, invoiceId: uid(1111), originalMinor: 500_000n, state: 'partially_paid', paidMinor: 100_000n }),
        ],
      }),
      clock,
    );
    expect(answer.exposure).toEqual([
      { currency: 'KES', exposureMinor: 1_400_000n, receivableCount: 2, evidenceIds: [R1, R2] },
    ]);
  });

  it('derives balance = original − paid (R1) for a partially paid receivable', () => {
    const answer = financialStateOf(query({ receivables: [receivable({ paidMinor: 400_000n, state: 'partially_paid' })] }), clock);
    expect(answer.openReceivables[0]!.balanceMinor).toBe(600_000n);
    expect(answer.exposure[0]!.exposureMinor).toBe(600_000n);
  });

  it('never sums across currencies — one row per currency, ordered by the shared currency list', () => {
    const answer = financialStateOf(
      query({
        receivables: [
          receivable({ receivableId: R2, invoiceId: uid(1111), currency: 'USD', originalMinor: 2_000n }),
          receivable({ receivableId: R3, invoiceId: uid(1112), originalMinor: 1_000_000n }),
        ],
      }),
      clock,
    );
    expect(answer.exposure.map((row) => [row.currency, row.exposureMinor])).toEqual([
      ['KES', 1_000_000n],
      ['USD', 2_000n],
    ]);
  });

  it('excludes settled / written-off / fully-paid receivables from exposure', () => {
    const answer = financialStateOf(
      query({
        receivables: [
          receivable(),
          receivable({ receivableId: R2, invoiceId: uid(1111), state: 'settled' }),
          receivable({ receivableId: R3, invoiceId: uid(1112), state: 'written_off' }),
        ],
        payments: [],
      }),
      clock,
    );
    expect(answer.exposure).toEqual([
      { currency: 'KES', exposureMinor: 1_000_000n, receivableCount: 1, evidenceIds: [R1] },
    ]);
    expect(answer.openReceivables.map((v) => v.receivableId)).toEqual([R1]);
  });

  it('excludes a zero-balance open receivable (nothing collectible to age)', () => {
    const answer = financialStateOf(query({ receivables: [receivable({ paidMinor: 1_000_000n, state: 'partially_paid' })] }), clock);
    expect(answer.openReceivables).toEqual([]);
    expect(answer.exposure).toEqual([]);
  });

  it('exposure evidence merges the adapter-attached event ids per receivable', () => {
    const answer = financialStateOf(
      query({ receivables: [receivable({ evidenceIds: [EV1] }), receivable({ receivableId: R2, invoiceId: uid(1111), evidenceIds: [EV2] })] }),
      clock,
    );
    expect(answer.exposure[0]!.evidenceIds).toEqual([R1, EV1, R2, EV2]);
  });
});

// --- open receivables: age + relation split ---------------------------------

describe('financialStateOf — open receivables, age and the disputed/promised/plain split', () => {
  it('derives whole-day age and bucket from the due date; overdue defaults false', () => {
    const answer = financialStateOf(query({ receivables: [receivable({ dueDate: daysAgo(45) })] }), clock);
    const view = answer.openReceivables[0]!;
    expect(view.ageDays).toBe(45);
    expect(view.ageBucket).toBe('31-60');
    expect(view.overdue).toBe(false);
  });

  it('honors an adapter-supplied overdue flag', () => {
    const answer = financialStateOf(query({ receivables: [receivable({ dueDate: daysAgo(10), overdue: true })] }), clock);
    expect(answer.openReceivables[0]!.overdue).toBe(true);
    expect(answer.openReceivables[0]!.ageBucket).toBe('0-30');
  });

  it('orders open receivables oldest first, then larger balance, then id', () => {
    const answer = financialStateOf(
      query({
        receivables: [
          receivable({ receivableId: R1, invoiceId: uid(1110), dueDate: daysAgo(20), originalMinor: 300_000n }),
          receivable({ receivableId: R2, invoiceId: uid(1111), dueDate: daysAgo(80), originalMinor: 100_000n }),
          receivable({ receivableId: R3, invoiceId: uid(1112), dueDate: daysAgo(20), originalMinor: 900_000n }),
        ],
      }),
      clock,
    );
    expect(answer.openReceivables.map((v) => v.receivableId)).toEqual([R2, R3, R1]);
  });

  it('relation split table — disputed vs promised vs plain (dispute outranks promise)', () => {
    const cases: Array<{ name: string; promises: PromiseFact[]; disputes: DisputeFact[]; relation: string }> = [
      { name: 'open dispute → disputed', promises: [], disputes: [dispute()], relation: 'disputed' },
      { name: 'pending promise → promised', promises: [promise()], disputes: [], relation: 'promised' },
      { name: 'no attachment → plain', promises: [], disputes: [], relation: 'plain' },
      { name: 'dispute beats pending promise', promises: [promise()], disputes: [dispute()], relation: 'disputed' },
      { name: 'broken promise is not a promise → plain', promises: [promise({ status: 'broken' })], disputes: [], relation: 'plain' },
      { name: 'fulfilled promise is over → plain', promises: [promise({ status: 'fulfilled' })], disputes: [], relation: 'plain' },
      { name: 'closed dispute does not pause → plain', promises: [], disputes: [dispute({ open: false })], relation: 'plain' },
    ];
    for (const c of cases) {
      const answer = financialStateOf(query({ promises: c.promises, disputes: c.disputes }), clock);
      expect(answer.openReceivables[0]!.relation, c.name).toBe(c.relation);
    }
  });

  it('projects the split into per-relation id lists in view order', () => {
    const answer = financialStateOf(
      query({
        receivables: [
          receivable({ receivableId: R1, invoiceId: uid(1110) }),
          receivable({ receivableId: R2, invoiceId: uid(1111), dueDate: daysAgo(50) }),
          receivable({ receivableId: R3, invoiceId: uid(1112), dueDate: daysAgo(10) }),
        ],
        promises: [promise({ receivableId: R2 })],
        disputes: [dispute({ receivableId: R3 })],
      }),
      clock,
    );
    expect(answer.disputedReceivableIds).toEqual([R3]);
    expect(answer.promisedReceivableIds).toEqual([R2]);
    expect(answer.plainReceivableIds).toEqual([R1]);
  });

  it('disputed views cite the dispute; promised views cite the pending promise', () => {
    const disputed = financialStateOf(query({ disputes: [dispute({ evidenceIds: [EV1] })] }), clock);
    expect(disputed.openReceivables[0]!.evidenceIds).toEqual([R1, D1, EV1]);

    const promised = financialStateOf(query({ promises: [promise()] }), clock);
    expect(promised.openReceivables[0]!.evidenceIds).toEqual([R1, PM1]);
  });
});

// --- payments ---------------------------------------------------------------

describe('financialStateOf — last payment and unallocated remainder', () => {
  it('reports the most recent payment', () => {
    const answer = financialStateOf(
      query({
        payments: [payment(), payment({ paymentId: P2, amountMinor: 90_000n, receivedAt: daysAgo(1), currency: 'KES' })],
      }),
      clock,
    );
    expect(answer.lastPayment).toEqual({
      paymentId: P2,
      currency: 'KES',
      amountMinor: 90_000n,
      receivedAt: daysAgo(1),
      evidenceIds: [P2],
    });
  });

  it('breaks receivedAt ties deterministically on payment id', () => {
    const answer = financialStateOf(
      query({ payments: [payment({ paymentId: P2 }), payment({ paymentId: P1, receivedAt: daysAgo(3) })] }),
      clock,
    );
    expect(answer.lastPayment!.paymentId).toBe(P1);
  });

  it('has no last payment when no payments were supplied', () => {
    const answer = financialStateOf(query(), clock);
    expect(answer.lastPayment).toBeNull();
    expect(answer.reasons).toContain('no payments on record');
  });

  it('parks the unallocated remainder per currency (R2), defaulting to fully allocated', () => {
    const fullyAllocated = financialStateOf(query({ payments: [payment()] }), clock);
    expect(fullyAllocated.unallocatedPayments).toEqual([]);

    const parked = financialStateOf(
      query({
        payments: [payment({ amountMinor: 400_000n, allocatedMinor: 300_000n }), payment({ paymentId: P2, amountMinor: 10_000n, allocatedMinor: 0n })],
      }),
      clock,
    );
    expect(parked.unallocatedPayments).toEqual([
      { currency: 'KES', amountMinor: 110_000n, paymentIds: [P1, P2], evidenceIds: [P1, P2] },
    ]);
  });

  it('reports unallocated payments and the C4 credit balance separately — no double counting', () => {
    const answer = financialStateOf(
      query({
        payments: [payment({ allocatedMinor: 0n })],
        customer: customer({ creditBalanceMinor: 55_000n, creditCurrency: 'KES' }),
      }),
      clock,
    );
    expect(answer.unallocatedPayments).toEqual([
      { currency: 'KES', amountMinor: 400_000n, paymentIds: [P1], evidenceIds: [P1] },
    ]);
    expect(answer.creditBalance).toEqual({ currency: 'KES', amountMinor: 55_000n, evidenceIds: [CUSTOMER] });
  });
});

// --- customer facts ---------------------------------------------------------

describe('financialStateOf — customer credit balance and behavior flags', () => {
  it('surfaces the C4 credit balance; absent without a customer fact', () => {
    const withCredit = financialStateOf(query({ customer: customer({ creditBalanceMinor: 55_000n, creditCurrency: 'KES' }) }), clock);
    expect(withCredit.creditBalance).toEqual({ currency: 'KES', amountMinor: 55_000n, evidenceIds: [CUSTOMER] });

    const bare = financialStateOf(query(), clock);
    expect(bare.creditBalance).toBeNull();
  });

  it('flags carry the published weights, deduped and alphabetically ordered', () => {
    const answer = financialStateOf(
      query({ customer: customer({ flags: ['slow_payer', 'unresponsive', 'slow_payer'], evidenceIds: [EV1] }) }),
      clock,
    );
    expect(answer.flags).toEqual([
      { flag: 'slow_payer', weight: FLAG_WEIGHTS.slow_payer, evidenceIds: [CUSTOMER, EV1] },
      { flag: 'unresponsive', weight: FLAG_WEIGHTS.unresponsive, evidenceIds: [CUSTOMER, EV1] },
    ]);
  });

  it('a credit balance in another currency is still reported separately (never mixed into exposure)', () => {
    const answer = financialStateOf(
      query({ customer: customer({ creditBalanceMinor: 5_000n, creditCurrency: 'USD' }) }),
      clock,
    );
    expect(answer.creditBalance!.currency).toBe('USD');
    expect(answer.exposure).toEqual([
      { currency: 'KES', exposureMinor: 1_000_000n, receivableCount: 1, evidenceIds: [R1] },
    ]);
  });
});

// --- the answer item --------------------------------------------------------

describe('financialStateOf — the answer item', () => {
  it('carries subject, capability, asOf (the ONE clock read) and a confidence basis', () => {
    let reads = 0;
    const countingClock: Clock = {
      now: () => {
        reads += 1;
        return NOW;
      },
    };
    const answer = financialStateOf(query(), countingClock);
    expect(answer.subject).toBe(CUSTOMER);
    expect(answer.orgId).toBe(ORG);
    expect(answer.capability).toBe('financial_state');
    expect(answer.asOf).toBe(NOW.toISOString());
    expect(typeof answer.confidenceBasis).toBe('string');
    expect(reads).toBe(1); // single-instant guarantee: ages + asOf agree by construction
  });

  it('reasons narrate the state with the exact figures (spot table)', () => {
    const answer = financialStateOf(
      query({
        receivables: [receivable({ dueDate: daysAgo(95) })],
        payments: [payment({ allocatedMinor: 0n })],
        promises: [promise()],
        customer: customer({ flags: ['slow_payer'], creditBalanceMinor: 55_000n, creditCurrency: 'KES' }),
      }),
      clock,
    );
    expect(answer.reasons).toContain('exposure 1000000 minor KES across 1 open receivable(s)');
    expect(answer.reasons).toContain('oldest open receivable ' + R1 + ' is 95d past due (90+)');
    expect(answer.reasons).toContain('1 open receivable(s) covered by a pending promise');
    expect(answer.reasons).toContain(`last payment 400000 minor KES received ${daysAgo(3)}`);
    expect(answer.reasons).toContain('unallocated payments parked: 400000 minor KES');
    expect(answer.reasons).toContain('customer credit balance available: 55000 minor KES');
    expect(answer.reasons).toContain('risk flags: slow_payer(6)');
  });

  it('narrates a dispute pause in the reasons when a receivable is disputed', () => {
    const answer = financialStateOf(query({ disputes: [dispute()], promises: [promise()] }), clock);
    // the dispute outranks the pending promise, so the pause — not the promise — is narrated
    expect(answer.reasons).toContain('1 open receivable(s) disputed — automated collection is paused (SPEC §29)');
    expect(answer.reasons).not.toContain('covered by a pending promise');
  });

  it('every evidence id resolves to a supplied input (issue #35 acceptance)', () => {
    const q = query({
      receivables: [receivable({ evidenceIds: [EV1] })],
      payments: [payment({ allocatedMinor: 0n })],
      promises: [promise()],
      disputes: [dispute()],
      customer: customer({ flags: ['slow_payer'], creditBalanceMinor: 55_000n, creditCurrency: 'KES', evidenceIds: [EV2] }),
    });
    const answer = financialStateOf(q, clock);
    const universe = suppliedIds(q);
    expect(answer.evidenceIds.length).toBeGreaterThan(0);
    for (const id of answer.evidenceIds) expect(universe.has(id), `evidence ${id} must resolve to a supplied input`).toBe(true);
  });

  it('is deterministic — identical inputs, identical answer', () => {
    const q = (): FinancialStateQuery => ({
      orgId: ORG,
      customerId: CUSTOMER,
      receivables: [receivable({ evidenceIds: [EV1] })],
      payments: [payment()],
      promises: [promise()],
      disputes: [dispute()],
      customer: customer({ flags: ['slow_payer'] }),
    });
    expect(financialStateOf(q(), clock)).toEqual(financialStateOf(q(), clock));
  });

  it('never mutates the supplied facts (deep-freeze pin)', () => {
    const frozen = deepFreeze(query({
      receivables: [receivable({ evidenceIds: [EV1] })],
      payments: [payment()],
      promises: [promise()],
      disputes: [dispute()],
      customer: customer({ flags: ['slow_payer'] }),
    }));
    const answer = financialStateOf(frozen, clock);
    expect(answer.openReceivables).toHaveLength(1);
  });
});

// --- refusals ---------------------------------------------------------------

describe('financialStateOf — refusals with stable AGENT_* codes', () => {
  it('refuses empty inputs — nothing to reason over (table)', () => {
    expectCode(() => financialStateOf(query({ receivables: [], payments: [] }), clock), 'AGENT_INPUT_EMPTY');
    expectCode(() => financialStateOf(query({ receivables: undefined }), clock), 'AGENT_INPUT_EMPTY');
    // a customer fact / promises alone are not financial state
    expectCode(
      () => financialStateOf(query({ receivables: [], payments: [], customer: customer(), promises: [promise()] }), clock),
      'AGENT_INPUT_EMPTY',
    );
  });

  it('refuses cross-org facts of every kind (table)', () => {
    expectCode(() => financialStateOf(query({ customer: customer({ orgId: OTHER_ORG }) }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => financialStateOf(query({ receivables: [receivable({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => financialStateOf(query({ payments: [payment({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => financialStateOf(query({ promises: [promise({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    expectCode(() => financialStateOf(query({ disputes: [dispute({ orgId: OTHER_ORG })] }), clock), 'AGENT_ORG_MISMATCH');
    // wrong-org facts are refused even when they are orphans for this scope
    expectCode(
      () => financialStateOf(query({ promises: [promise({ orgId: OTHER_ORG, receivableId: uid(999) })] }), clock),
      'AGENT_ORG_MISMATCH',
    );
  });

  it('refuses facts about a different customer than the query subject (table)', () => {
    expectCode(
      () => financialStateOf(query({ customer: customer({ customerId: OTHER_CUSTOMER }) }), clock),
      'AGENT_CUSTOMER_MISMATCH',
    );
    expectCode(
      () => financialStateOf(query({ receivables: [receivable({ customerId: OTHER_CUSTOMER })] }), clock),
      'AGENT_CUSTOMER_MISMATCH',
    );
    expectCode(
      () => financialStateOf(query({ receivables: [], payments: [payment({ customerId: OTHER_CUSTOMER })] }), clock),
      'AGENT_CUSTOMER_MISMATCH',
    );
  });

  it('refuses duplicate fact ids of every kind (table)', () => {
    expectCode(
      () => financialStateOf(query({ receivables: [receivable(), receivable()] }), clock),
      'AGENT_RECEIVABLE_DUPLICATE',
    );
    expectCode(
      () => financialStateOf(query({ payments: [payment(), payment()] }), clock),
      'AGENT_PAYMENT_DUPLICATE',
    );
    expectCode(
      () => financialStateOf(query({ promises: [promise(), promise()] }), clock),
      'AGENT_PROMISE_DUPLICATE',
    );
    expectCode(
      () => financialStateOf(query({ disputes: [dispute(), dispute()] }), clock),
      'AGENT_DISPUTE_DUPLICATE',
    );
  });

  it('ignores promise/dispute facts whose receivable was not supplied (another scope)', () => {
    const answer = financialStateOf(
      query({ promises: [promise({ receivableId: uid(999) })], disputes: [dispute({ receivableId: uid(999), open: false })] }),
      clock,
    );
    expect(answer.openReceivables[0]!.relation).toBe('plain');
    expect(answer.evidenceIds).not.toContain(uid(999));
    expect(answer.evidenceIds).not.toContain(PM1);
  });

  it('surfaces the fact validators\u2019 stable codes through the query (table)', () => {
    const cases: Array<[string, FinancialStateQuery]> = [
      ['number amount', query({ receivables: [receivable({ originalMinor: 10 as unknown as bigint })] })],
      ['negative amount', query({ receivables: [receivable({ paidMinor: -1n })] })],
      ['paid > original (R1)', query({ receivables: [receivable({ paidMinor: 2_000_000n })] })],
      ['bad state', query({ receivables: [receivable({ state: 'archived' as unknown as ReceivableFact['state'] })] })],
      ['bad due date', query({ receivables: [receivable({ dueDate: '2026-03-01' })] })],
      ['bad currency', query({ receivables: [receivable({ currency: 'XYZ' as unknown as ReceivableFact['currency'] })] })],
      ['allocated > amount (R2)', query({ receivables: [], payments: [payment({ allocatedMinor: 999_999_999n })] })],
      ['bad promise status', query({ promises: [promise({ status: 'expired' as unknown as PromiseFact['status'] })] })],
      ['non-boolean dispute open', query({ disputes: [dispute({ open: 'yes' as unknown as boolean })] })],
      ['unknown flag', query({ customer: customer({ flags: ['wizard'] }) })],
      ['credit amount without currency', query({ customer: customer({ creditBalanceMinor: 5n }) })],
      ['bad query orgId', query({ orgId: 'org-1' as unknown as Uuid })],
      ['bad query customerId', query({ customerId: 'cust-1' as unknown as Uuid })],
    ];
    const expected = [
      'AGENT_AMOUNT_INVALID',
      'AGENT_AMOUNT_INVALID',
      'AGENT_BALANCE_INVALID',
      'AGENT_RECEIVABLE_STATE_INVALID',
      'AGENT_DATE_INVALID',
      'AGENT_CURRENCY_UNSUPPORTED',
      'AGENT_ALLOCATION_INVALID',
      'AGENT_PROMISE_STATUS_INVALID',
      'AGENT_DISPUTE_FACT_INVALID',
      'AGENT_FLAG_UNKNOWN',
      'AGENT_CREDIT_FACT_INVALID',
      'AGENT_ID_MALFORMED',
      'AGENT_ID_MALFORMED',
    ];
    cases.forEach(([, q], i) => {
      expectCode(() => financialStateOf(q, clock), expected[i]!);
    });
    expect(cases).toHaveLength(expected.length); // every row is asserted
  });

  it('refuses broken clocks (table)', () => {
    expectCode(() => financialStateOf(query(), undefined as unknown as Clock), 'AGENT_CLOCK_INVALID');
    expectCode(() => financialStateOf(query(), {} as Clock), 'AGENT_CLOCK_INVALID');
    expectCode(() => financialStateOf(query(), { now: () => 42 as unknown as Date }), 'AGENT_CLOCK_INVALID');
  });

  it('uses the clock instant for ages (assertAgentClock returns the validated read)', () => {
    const otherInstant = new Date('2026-06-01T00:00:00.000Z');
    const answer = financialStateOf(query(), { now: () => otherInstant });
    const expectedAge = ageDaysOf(receivable().dueDate, otherInstant);
    expect(answer.openReceivables[0]!.ageDays).toBe(expectedAge);
    expect(answer.asOf).toBe(otherInstant.toISOString());
    // and the clock guard itself still refuses garbage
    expectCode(() => assertAgentClock(undefined), 'AGENT_CLOCK_INVALID');
  });
});
