import { describe, expect, it } from 'vitest';
import { CURRENCIES, DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  AGE_BUCKETS,
  AGENT_FLAGS,
  ageBucketOf,
  ageDaysOf,
  assertAgentClock,
  assertCurrency,
  assertCustomerFact,
  assertDisputeFact,
  assertIsoDate,
  assertMinorAmount,
  assertPaymentFact,
  assertPromiseFact,
  assertReceivableFact,
  assertUuidRef,
  FLAG_WEIGHTS,
  OPEN_RECEIVABLE_STATES,
  RECEIVABLE_STATES,
  type CustomerFact,
  type DisputeFact,
  type PaymentFact,
  type PromiseFact,
  type ReceivableFact,
} from './facts';

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const NOW = new Date('2026-03-15T09:00:00.000Z');
const DAY_MS = 86_400_000;
/** ISO instant exactly `days` before NOW (whole days — no flooring noise). */
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- primitives -------------------------------------------------------------

describe('id/date/amount primitives', () => {
  it('assertUuidRef accepts a canonical UUID and refuses everything else (table)', () => {
    expect(assertUuidRef('00000000-0000-4000-8000-000000000001', 'x')).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
    expect(assertUuidRef('00000000-0000-4000-8000-00000000000A'.toLowerCase(), 'x')).toBe(
      '00000000-0000-4000-8000-00000000000a',
    );
    const bad: unknown[] = [
      'r-1',
      '',
      '00000000-0000-4000-8000-00000000000',
      '00000000-0000-4000-8000-0000000000012',
      'zzzzzzzz-zzzz-4000-8000-000000000001',
      42,
      null,
      undefined,
      {},
    ];
    for (const value of bad) {
      expectCode(() => assertUuidRef(value, 'field'), 'AGENT_ID_MALFORMED');
    }
  });

  it('assertIsoDate accepts zoned ISO-8601 timestamps (table)', () => {
    const good = [
      '2026-03-01T09:00:00Z',
      '2026-03-01T09:00:00.000Z',
      '2026-03-01T09:00:00.123Z',
      '2026-03-01T12:00:00+03:00',
      '2026-03-01T02:00:00-05:00',
    ];
    for (const value of good) expect(assertIsoDate(value, 'field')).toBe(value);
  });

  it('assertIsoDate refuses date-only, zoneless and garbage strings (table)', () => {
    const bad: unknown[] = [
      '2026-03-01', // date-only
      '2026-03-01T09:00:00', // zoneless — never guessed
      'March 1 2026',
      '2026-13-01T09:00:00.000Z', // pattern fails
      1767225600000,
      null,
      undefined,
    ];
    for (const value of bad) {
      expectCode(() => assertIsoDate(value, 'field'), 'AGENT_DATE_INVALID');
    }
  });

  it('assertMinorAmount takes bigint minor units only — floats are banned (table)', () => {
    expect(assertMinorAmount(0n, 'field')).toBe(0n);
    expect(assertMinorAmount(125_000n, 'field')).toBe(125_000n);
    const bad: unknown[] = [125_000, 125_000.5, -1n, '125000', null, undefined];
    for (const value of bad) {
      expectCode(() => assertMinorAmount(value, 'field'), 'AGENT_AMOUNT_INVALID');
    }
  });

  it('assertCurrency accepts exactly the shared CURRENCIES whitelist (table)', () => {
    for (const currency of CURRENCIES) {
      expect(assertCurrency(currency, 'field')).toBe(currency);
    }
    for (const bad of ['XYZ', 'kes', 'KES ', '', null, 42]) {
      expectCode(() => assertCurrency(bad, 'field'), 'AGENT_CURRENCY_UNSUPPORTED');
    }
  });

  it('assertAgentClock returns the ONE validated instant and refuses broken clocks (table)', () => {
    const clock: Clock = { now: () => NOW };
    expect(assertAgentClock(clock).getTime()).toBe(NOW.getTime());
    expectCode(() => assertAgentClock(undefined), 'AGENT_CLOCK_INVALID');
    expectCode(() => assertAgentClock({} as Clock), 'AGENT_CLOCK_INVALID');
    expectCode(
      () => assertAgentClock({ now: () => 'not-a-date' as unknown as Date }),
      'AGENT_CLOCK_INVALID',
    );
    expectCode(
      () => assertAgentClock({ now: () => new Date('garbage') }),
      'AGENT_CLOCK_INVALID',
    );
  });
});

// --- published vocabulary ---------------------------------------------------

describe('published scoring vocabulary', () => {
  it('FLAG_WEIGHTS pins the exact fixed weights', () => {
    expect(FLAG_WEIGHTS).toEqual({
      slow_payer: 6,
      broken_promise: 8,
      disputed_history: 3,
      partial_payer: 4,
      unresponsive: 5,
      reliable_payer: -6,
    });
    expect(Object.isFrozen(FLAG_WEIGHTS)).toBe(true);
  });

  it('AGENT_FLAGS, AGE_BUCKETS and the receivable-state vocabulary are exact + frozen', () => {
    expect(AGENT_FLAGS).toEqual([
      'slow_payer',
      'broken_promise',
      'disputed_history',
      'partial_payer',
      'unresponsive',
      'reliable_payer',
    ]);
    expect(Object.isFrozen(AGENT_FLAGS)).toBe(true);
    expect(AGE_BUCKETS).toEqual(['0-30', '31-60', '61-90', '90+']);
    expect(Object.isFrozen(AGE_BUCKETS)).toBe(true);
    expect(RECEIVABLE_STATES).toEqual([
      'draft',
      'open',
      'partially_paid',
      'settled',
      'written_off',
      'recovered',
      'uncollectible',
      'voided',
    ]);
    expect(OPEN_RECEIVABLE_STATES).toEqual(['open', 'partially_paid']);
  });
});

// --- fact validation --------------------------------------------------------

describe('fact validators — stable AGENT_* refusals', () => {
  const customerFact = (overrides: Partial<CustomerFact> = {}): CustomerFact => ({
    orgId: uid(1),
    customerId: uid(2),
    ...overrides,
  });
  const receivableFact = (overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
    orgId: uid(1),
    receivableId: uid(11),
    invoiceId: uid(12),
    customerId: uid(2),
    currency: 'KES',
    originalMinor: 1_000_000n,
    paidMinor: 400_000n,
    state: 'partially_paid',
    dueDate: daysAgo(45),
    ...overrides,
  });
  const paymentFact = (overrides: Partial<PaymentFact> = {}): PaymentFact => ({
    orgId: uid(1),
    paymentId: uid(21),
    customerId: uid(2),
    currency: 'KES',
    amountMinor: 500_000n,
    receivedAt: daysAgo(3),
    ...overrides,
  });
  const promiseFact = (overrides: Partial<PromiseFact> = {}): PromiseFact => ({
    orgId: uid(1),
    promiseId: uid(31),
    receivableId: uid(11),
    status: 'pending',
    ...overrides,
  });
  const disputeFact = (overrides: Partial<DisputeFact> = {}): DisputeFact => ({
    orgId: uid(1),
    disputeId: uid(41),
    receivableId: uid(11),
    open: true,
    ...overrides,
  });

  it('customer credit requires BOTH creditBalanceMinor and creditCurrency (table)', () => {
    expectCode(
      () => assertCustomerFact(customerFact({ creditBalanceMinor: 500n })),
      'AGENT_CREDIT_FACT_INVALID',
    );
    expectCode(
      () => assertCustomerFact(customerFact({ creditCurrency: 'KES' })),
      'AGENT_CREDIT_FACT_INVALID',
    );
    expect(
      assertCustomerFact(customerFact({ creditBalanceMinor: 500n, creditCurrency: 'KES' }))
        .creditBalanceMinor,
    ).toBe(500n);
  });

  it('customer flags and evidence ids are validated against the vocabulary', () => {
    expectCode(
      () => assertCustomerFact(customerFact({ flags: ['slow_payer', 'wizard'] })),
      'AGENT_FLAG_UNKNOWN',
    );
    expectCode(
      () => assertCustomerFact(customerFact({ flags: 'slow_payer' as unknown as string[] })),
      'AGENT_FLAG_UNKNOWN',
    );
    expectCode(
      () =>
        assertCustomerFact(
          customerFact({ evidenceIds: ['not-a-uuid'] as unknown as Uuid[] }),
        ),
      'AGENT_ID_MALFORMED',
    );
  });

  it('receivable R1 balance integrity, state, overdue and date guards (table)', () => {
    expectCode(
      () => assertReceivableFact(receivableFact({ paidMinor: 1_000_001n })),
      'AGENT_BALANCE_INVALID',
    );
    expectCode(
      () => assertReceivableFact(receivableFact({ state: 'closed' as unknown as ReceivableFact['state'] })),
      'AGENT_RECEIVABLE_STATE_INVALID',
    );
    expectCode(
      () => assertReceivableFact(receivableFact({ overdue: 'yes' as unknown as boolean })),
      'AGENT_RECEIVABLE_STATE_INVALID',
    );
    expectCode(
      () => assertReceivableFact(receivableFact({ dueDate: '2026-03-01' })),
      'AGENT_DATE_INVALID',
    );
    expectCode(
      () => assertReceivableFact(receivableFact({ originalMinor: 10 as unknown as bigint })),
      'AGENT_AMOUNT_INVALID',
    );
  });

  it('payment R2 guard: allocatedMinor may equal but never exceed amountMinor', () => {
    expect(assertPaymentFact(paymentFact({ allocatedMinor: 500_000n })).allocatedMinor).toBe(500_000n);
    expectCode(
      () => assertPaymentFact(paymentFact({ allocatedMinor: 500_001n })),
      'AGENT_ALLOCATION_INVALID',
    );
  });

  it('promise status whitelist is pending | fulfilled | broken', () => {
    for (const status of ['pending', 'fulfilled', 'broken'] as const) {
      expect(assertPromiseFact(promiseFact({ status })).status).toBe(status);
    }
    expectCode(
      () => assertPromiseFact(promiseFact({ status: 'expired' as unknown as PromiseFact['status'] })),
      'AGENT_PROMISE_STATUS_INVALID',
    );
    expectCode(
      () => assertPromiseFact(promiseFact({ promisedDate: 'soon' })),
      'AGENT_DATE_INVALID',
    );
  });

  it('dispute open must be a real boolean', () => {
    expect(assertDisputeFact(disputeFact()).open).toBe(true);
    expectCode(
      () => assertDisputeFact(disputeFact({ open: 1 as unknown as boolean })),
      'AGENT_DISPUTE_FACT_INVALID',
    );
    expectCode(
      () => assertDisputeFact(disputeFact({ open: 'true' as unknown as boolean })),
      'AGENT_DISPUTE_FACT_INVALID',
    );
  });
});

// --- aging ------------------------------------------------------------------

describe('aging — same whole-day semantics as the receivables lane', () => {
  it('ageDaysOf floors partial days and clamps not-yet-due at 0 (table)', () => {
    const cases: Array<[string, number]> = [
      [daysAgo(45), 45],
      [daysAgo(0), 0],
      [new Date(NOW.getTime() + DAY_MS).toISOString(), 0], // due tomorrow → 0
      [new Date(NOW.getTime() - 30.5 * DAY_MS).toISOString(), 30], // partial day floors
      [new Date(NOW.getTime() - 1).toISOString(), 0], // 1ms late is not a day
    ];
    for (const [due, expected] of cases) {
      expect(ageDaysOf(due, NOW)).toBe(expected);
    }
  });

  it('ageBucketOf pins the 30/60/90 boundaries (table)', () => {
    const cases: Array<[number, string]> = [
      [0, '0-30'],
      [30, '0-30'],
      [31, '31-60'],
      [60, '31-60'],
      [61, '61-90'],
      [90, '61-90'],
      [91, '90+'],
      [1_000, '90+'],
    ];
    for (const [days, bucket] of cases) {
      expect(ageBucketOf(days)).toBe(bucket);
    }
  });
});
