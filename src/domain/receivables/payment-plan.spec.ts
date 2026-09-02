import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  buildSchedule,
  cancelPaymentPlan,
  createPaymentPlan,
  markPlanDefaulted,
  recordPlanPayment,
  unpaidInstallmentsOf,
  type PaymentPlan,
} from './payment-plan';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const PLAN = uid(9);
const CUST = uid(2);
const R1 = uid(21);
const R2 = uid(22);
const R3 = uid(23);

const CREATED_AT = '2025-01-15T09:00:00.000Z';
const createClock: Clock = { now: () => new Date(CREATED_AT) };
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const planArgs = {
  id: PLAN,
  customerId: CUST,
  receivableIds: [R1, R2],
  currency: 'KES' as const,
  totalMinor: 10_000,
  installmentCount: 3,
};

/** Fresh ACTIVE plan, schedule not yet built. */
const freshPlan = (): PaymentPlan => createPaymentPlan(planArgs, createClock);

/** Active plan with a Jan 31 2025 anchored schedule → due Feb 28 / Mar 31 / Apr 30. */
const scheduledPlan = (): PaymentPlan =>
  buildSchedule(freshPlan(), { startDate: new Date('2025-01-31T00:00:00.000Z'), clock: createClock }).plan;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- creation ---------------------------------------------------------------

describe('createPaymentPlan', () => {
  it.each([
    ['totalMinor is zero', { totalMinor: 0 }, 'PAYMENT_PLAN_TOTAL_INVALID'],
    ['totalMinor is negative', { totalMinor: -5_000 }, 'PAYMENT_PLAN_TOTAL_INVALID'],
    ['totalMinor is not an integer', { totalMinor: 10_000.5 }, 'PAYMENT_PLAN_TOTAL_INVALID'],
    ['installmentCount is zero', { installmentCount: 0 }, 'PAYMENT_PLAN_INSTALLMENT_COUNT_INVALID'],
    ['installmentCount is not an integer', { installmentCount: 2.5 }, 'PAYMENT_PLAN_INSTALLMENT_COUNT_INVALID'],
    ['total cannot fund one minor unit per installment', { totalMinor: 2, installmentCount: 3 }, 'PAYMENT_PLAN_TOTAL_TOO_SMALL'],
    ['no receivables referenced (H5)', { receivableIds: [] }, 'PAYMENT_PLAN_RECEIVABLES_REQUIRED'],
    ['the same receivable referenced twice', { receivableIds: [R1, R1] }, 'PAYMENT_PLAN_RECEIVABLE_DUPLICATED'],
  ] as const)('refuses a plan when %s', (_why, override, code) => {
    expectCode(() => createPaymentPlan({ ...planArgs, ...override }, createClock), code);
  });

  it('creates an ACTIVE plan owned by the customer and referencing the receivables', () => {
    const plan = freshPlan();
    expect(plan.state).toBe('active');
    expect(plan.customerId).toBe(CUST);
    expect(plan.receivableIds).toEqual([R1, R2]);
    expect(plan.totalMinor).toBe(10_000n);
    expect(plan.installmentCount).toBe(3);
    expect(plan.installments).toEqual([]);
    expect(plan.paymentLog).toEqual([]);
    expect(plan.createdAt).toEqual(new Date(CREATED_AT));
    expect(plan.completedAt).toBeNull();
    expect(plan.cancelReason).toBeNull();
  });

  it('accepts bigint minor units at the smallest legal boundary', () => {
    const plan = createPaymentPlan(
      { ...planArgs, receivableIds: [R1, R2, R3], totalMinor: 3n, installmentCount: 3 },
      createClock,
    );
    expect(plan.totalMinor).toBe(3n);
  });
});

// --- schedule: cent-exact split ---------------------------------------------

describe('buildSchedule — cent-exact split via Money.allocate (equal weights)', () => {
  it.each([
    [10_000, 3, [3334, 3333, 3333]], // first installment carries the extra cent
    [101, 4, [26, 25, 25, 25]],
    [5, 3, [2, 2, 1]],
    [1, 1, [1]],
  ] as const)('splits total %d into %d installments summing EXACTLY to the total', (total, count, expected) => {
    const plan = buildSchedule(
      createPaymentPlan({ ...planArgs, totalMinor: total, installmentCount: count }, createClock),
      { startDate: new Date('2025-01-31T00:00:00.000Z'), clock: createClock },
    ).plan;
    expect(plan.installments.map((inst) => inst.amountMinor)).toEqual(expected.map((m) => BigInt(m)));
    expect(plan.installments.reduce((sum, inst) => sum + inst.amountMinor, 0n)).toBe(BigInt(total));
    expect(unpaidInstallmentsOf(plan)).toHaveLength(count);
  });

  it('starts every installment unpaid with no paidAt', () => {
    const plan = scheduledPlan();
    for (const inst of plan.installments) {
      expect(inst.paidMinor).toBe(0n);
      expect(inst.paidAt).toBeNull();
    }
  });

  it('refuses to build a schedule twice', () => {
    expectCode(() => buildSchedule(scheduledPlan(), { startDate: new Date('2025-02-01T00:00:00.000Z'), clock: createClock }), 'PAYMENT_PLAN_SCHEDULE_EXISTS');
  });

  it('refuses to build a schedule on a non-active plan', () => {
    const cancelled = cancelPaymentPlan(freshPlan(), { reason: 'customer withdrew' }, createClock).plan;
    expectCode(
      () => buildSchedule(cancelled, { startDate: new Date('2025-02-01T00:00:00.000Z'), clock: createClock }),
      'INVALID_PAYMENT_PLAN_TRANSITION',
    );
  });
});

// --- schedule: calendar-aware due dates -------------------------------------

describe('buildSchedule — calendar-aware due dates (same day-of-month, month-end clamped)', () => {
  it.each([
    ['2025-01-31T00:00:00.000Z', ['2025-02-28T00:00:00.000Z', '2025-03-31T00:00:00.000Z', '2025-04-30T00:00:00.000Z', '2025-05-31T00:00:00.000Z']],
    ['2024-01-31T00:00:00.000Z', ['2024-02-29T00:00:00.000Z']], // leap year
    ['2025-01-30T00:00:00.000Z', ['2025-02-28T00:00:00.000Z', '2025-03-30T00:00:00.000Z']],
    ['2025-08-31T00:00:00.000Z', ['2025-09-30T00:00:00.000Z', '2025-10-31T00:00:00.000Z']],
  ] as const)('clamps anchor %s to each month end', (anchor, expected) => {
    const plan = buildSchedule(
      createPaymentPlan({ ...planArgs, installmentCount: expected.length }, createClock),
      { startDate: new Date(anchor), clock: createClock },
    ).plan;
    expect(plan.installments.map((inst) => inst.dueDate.toISOString())).toEqual([...expected]);
  });

  it('preserves the anchor time-of-day in UTC', () => {
    const plan = buildSchedule(
      createPaymentPlan({ ...planArgs, installmentCount: 2 }, createClock),
      { startDate: new Date('2025-01-31T13:45:30.500Z'), clock: createClock },
    ).plan;
    expect(plan.installments[0]!.dueDate.toISOString()).toBe('2025-02-28T13:45:30.500Z');
    expect(plan.installments[1]!.dueDate.toISOString()).toBe('2025-03-31T13:45:30.500Z');
  });
});

// --- payments ---------------------------------------------------------------

describe('recordPlanPayment', () => {
  it('appends a payment record and updates the installment paid status', () => {
    const paid = recordPlanPayment(scheduledPlan(), 1, 1_000, at('2025-02-10T08:00:00.000Z')).plan;
    expect(paid.paymentLog).toHaveLength(1);
    expect(paid.paymentLog[0]).toEqual({
      installmentNo: 1,
      amountMinor: 1_000n,
      recordedAt: new Date('2025-02-10T08:00:00.000Z'),
    });
    expect(paid.installments[0]!.paidMinor).toBe(1_000n);
    expect(paid.installments[0]!.paidAt).toBeNull(); // partial — not yet settled
    expect(paid.state).toBe('active');
    expect(unpaidInstallmentsOf(paid).map((inst) => inst.no)).toEqual([1, 2, 3]);
  });

  it('sets paidAt only when the installment becomes fully paid', () => {
    const half = recordPlanPayment(scheduledPlan(), 1, 1_000, at('2025-02-10T08:00:00.000Z')).plan;
    const full = recordPlanPayment(half, 1, 2_334, at('2025-02-20T08:00:00.000Z')).plan;
    expect(full.installments[0]!.paidMinor).toBe(3_334n);
    expect(full.installments[0]!.paidAt).toEqual(new Date('2025-02-20T08:00:00.000Z'));
    expect(full.paymentLog).toHaveLength(2); // append-only: both rows remain
  });

  it('completes the plan when the last installment is fully paid, emitting recorded + completed', () => {
    let plan = recordPlanPayment(scheduledPlan(), 1, 3_334, at('2025-02-20T08:00:00.000Z')).plan;
    plan = recordPlanPayment(plan, 2, 3_333, at('2025-03-25T08:00:00.000Z')).plan;
    const done = recordPlanPayment(plan, 3, 3_333, at('2025-04-28T08:00:00.000Z'));
    expect(done.plan.state).toBe('completed');
    expect(done.plan.completedAt).toEqual(new Date('2025-04-28T08:00:00.000Z'));
    expect(done.plan.installments.every((inst) => inst.paidMinor === inst.amountMinor)).toBe(true);
    expect(done.plan.paymentLog.reduce((sum, row) => sum + row.amountMinor, 0n)).toBe(10_000n);
    expect(done.events.map((event) => event.name)).toEqual([
      'paymentplan.paymentRecorded',
      'paymentplan.completed',
    ]);
    expect(done.events[1]!.payload).toEqual({
      planId: PLAN,
      customerId: CUST,
      currency: 'KES',
      completedAt: '2025-04-28T08:00:00.000Z',
    });
  });

  it.each([
    ['zero', 0, 'PAYMENT_PLAN_PAYMENT_AMOUNT_INVALID'],
    ['below the installment balance', -5, 'MONEY_NEGATIVE'], // kernel guard propagates
    ['non-integer minor units', 10.5, 'MONEY_NOT_INTEGER'], // kernel guard propagates
  ] as const)('refuses a %s payment', (_why, amountMinor, code) => {
    expectCode(() => recordPlanPayment(scheduledPlan(), 1, amountMinor, createClock), code);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['beyond the schedule', 4],
    ['non-integer', 1.5],
  ] as const)('refuses an unknown installment number (%s)', (_why, installmentNo) => {
    expectCode(
      () => recordPlanPayment(scheduledPlan(), installmentNo, 1_000, createClock),
      'PAYMENT_PLAN_INSTALLMENT_UNKNOWN',
    );
  });

  it('refuses overpaying an installment (no over-allocation at installment level)', () => {
    expectCode(() => recordPlanPayment(scheduledPlan(), 1, 4_000, createClock), 'PAYMENT_PLAN_INSTALLMENT_OVERPAID');
    const full = recordPlanPayment(scheduledPlan(), 1, 3_334, createClock).plan;
    expectCode(() => recordPlanPayment(full, 1, 1, createClock), 'PAYMENT_PLAN_INSTALLMENT_OVERPAID');
  });

  it('refuses payments before the schedule is built', () => {
    expectCode(() => recordPlanPayment(freshPlan(), 1, 1_000, createClock), 'PAYMENT_PLAN_SCHEDULE_MISSING');
  });

  it.each([
    ['completed', (): PaymentPlan => {
      let plan = recordPlanPayment(scheduledPlan(), 1, 3_334, createClock).plan;
      plan = recordPlanPayment(plan, 2, 3_333, createClock).plan;
      return recordPlanPayment(plan, 3, 3_333, createClock).plan;
    }],
    ['defaulted', (): PaymentPlan => markPlanDefaulted(scheduledPlan(), { defaultAfterDays: 1 }, at('2025-03-10T00:00:00.000Z')).plan],
    ['cancelled', (): PaymentPlan => cancelPaymentPlan(scheduledPlan(), { reason: 'restructured offline' }, createClock).plan],
  ])('refuses payments on a %s plan', (_state, build) => {
    expectCode(() => recordPlanPayment(build(), 1, 1_000, createClock), 'INVALID_PAYMENT_PLAN_TRANSITION');
  });
});

// --- state machine ----------------------------------------------------------

describe('plan state machine — defaults', () => {
  it('defaults an active plan once an unpaid installment is overdue by the policy days', () => {
    const clock = at('2025-03-10T00:00:00.000Z'); // installment 1 due Feb 28 → 10 days late
    const result = markPlanDefaulted(scheduledPlan(), { defaultAfterDays: 7 }, clock);
    expect(result.plan.state).toBe('defaulted');
    expect(result.plan.defaultedAt).toEqual(new Date('2025-03-10T00:00:00.000Z'));
    expect(result.event.name).toBe('paymentplan.defaulted');
    expect(result.event.aggregateId).toBe(PLAN);
    expect(result.event.occurredAt).toBe('2025-03-10T00:00:00.000Z');
    expect(result.event.payload).toEqual({
      planId: PLAN,
      customerId: CUST,
      installmentNo: 1,
      daysOverdue: 10,
      defaultAfterDays: 7,
    });
  });

  it('defaults at exactly N overdue days and refuses at N−1', () => {
    const atThreshold = markPlanDefaulted(scheduledPlan(), { defaultAfterDays: 7 }, at('2025-03-07T00:00:00.000Z'));
    expect(atThreshold.plan.state).toBe('defaulted');
    expect(atThreshold.event.payload.daysOverdue).toBe(7);
    expectCode(
      () => markPlanDefaulted(scheduledPlan(), { defaultAfterDays: 7 }, at('2025-03-06T23:59:59.999Z')),
      'PAYMENT_PLAN_NOT_DEFAULTABLE',
    );
  });

  it('ignores fully-paid (even very late) installments when looking for a default trigger', () => {
    const partiallyPaid = recordPlanPayment(scheduledPlan(), 1, 3_334, at('2025-03-02T08:00:00.000Z')).plan;
    // Installment 1 went 2 days late but is fully paid; installment 2 (due Mar 31) is only 2 days late on Apr 2.
    expectCode(
      () => markPlanDefaulted(partiallyPaid, { defaultAfterDays: 7 }, at('2025-04-02T00:00:00.000Z')),
      'PAYMENT_PLAN_NOT_DEFAULTABLE',
    );
    // Once installment 2 crosses the threshold, the plan defaults on IT:
    const defaulted = markPlanDefaulted(partiallyPaid, { defaultAfterDays: 7 }, at('2025-04-08T00:00:00.000Z'));
    expect(defaulted.event.payload.installmentNo).toBe(2);
    expect(unpaidInstallmentsOf(partiallyPaid).map((inst) => inst.no)).toEqual([2, 3]);
  });

  it.each([
    ['negative', -1],
    ['non-integer', 0.5],
  ] as const)('refuses a %s defaultAfterDays policy', (_why, days) => {
    expectCode(
      () => markPlanDefaulted(scheduledPlan(), { defaultAfterDays: days }, at('2025-03-10T00:00:00.000Z')),
      'PAYMENT_PLAN_DEFAULT_POLICY_INVALID',
    );
  });

  it('refuses defaulting before the schedule is built', () => {
    expectCode(
      () => markPlanDefaulted(freshPlan(), { defaultAfterDays: 7 }, at('2025-03-10T00:00:00.000Z')),
      'PAYMENT_PLAN_SCHEDULE_MISSING',
    );
  });
});

describe('plan state machine — cancellation', () => {
  it('cancels an active plan with a recorded reason', () => {
    const result = cancelPaymentPlan(scheduledPlan(), { reason: 'customer settled in full' }, at('2025-02-05T00:00:00.000Z'));
    expect(result.plan.state).toBe('cancelled');
    expect(result.plan.cancelledAt).toEqual(new Date('2025-02-05T00:00:00.000Z'));
    expect(result.plan.cancelReason).toBe('customer settled in full');
    expect(result.event.name).toBe('paymentplan.cancelled');
    expect(result.event.payload).toEqual({ planId: PLAN, customerId: CUST, reason: 'customer settled in full' });
  });

  it('requires a non-blank reason', () => {
    expectCode(() => cancelPaymentPlan(scheduledPlan(), { reason: '   ' }, createClock), 'PAYMENT_PLAN_CANCEL_REASON_REQUIRED');
  });

  it.each([
    ['completed', (): PaymentPlan => {
      let plan = recordPlanPayment(scheduledPlan(), 1, 3_334, createClock).plan;
      plan = recordPlanPayment(plan, 2, 3_333, createClock).plan;
      return recordPlanPayment(plan, 3, 3_333, createClock).plan;
    }],
    ['defaulted', (): PaymentPlan => markPlanDefaulted(scheduledPlan(), { defaultAfterDays: 1 }, at('2025-03-10T00:00:00.000Z')).plan],
    ['cancelled', (): PaymentPlan => cancelPaymentPlan(scheduledPlan(), { reason: 'already cancelled' }, createClock).plan],
  ])('refuses cancelling from %s (active → cancelled only)', (_state, build) => {
    expectCode(() => cancelPaymentPlan(build(), { reason: 'too late' }, createClock), 'INVALID_PAYMENT_PLAN_TRANSITION');
  });
});

// --- end-to-end scenario ----------------------------------------------------

describe('plan lifecycle scenario (H5)', () => {
  it('create → schedule → staggered payments → completed, with an append-only log', () => {
    const scheduled = buildSchedule(
      createPaymentPlan({ ...planArgs, receivableIds: [R1, R2, R3] }, createClock),
      { startDate: new Date('2025-01-31T00:00:00.000Z'), clock: createClock },
    ).plan;
    expect(scheduled.installments.map((inst) => inst.no)).toEqual([1, 2, 3]);
    expect(scheduled.installments.map((inst) => inst.dueDate.toISOString())).toEqual([
      '2025-02-28T00:00:00.000Z',
      '2025-03-31T00:00:00.000Z',
      '2025-04-30T00:00:00.000Z',
    ]);

    let plan = recordPlanPayment(scheduled, 1, 1_500, at('2025-02-14T08:00:00.000Z')).plan;
    plan = recordPlanPayment(plan, 1, 1_834, at('2025-02-27T08:00:00.000Z')).plan;
    plan = recordPlanPayment(plan, 2, 3_333, at('2025-03-30T08:00:00.000Z')).plan;
    plan = recordPlanPayment(plan, 3, 1_000, at('2025-04-15T08:00:00.000Z')).plan;
    const done = recordPlanPayment(plan, 3, 2_333, at('2025-04-29T08:00:00.000Z'));

    expect(done.plan.state).toBe('completed');
    expect(done.plan.paymentLog.map((row) => row.installmentNo)).toEqual([1, 1, 2, 3, 3]);
    expect(done.plan.paymentLog.reduce((sum, row) => sum + row.amountMinor, 0n)).toBe(10_000n);
    const allNames = done.events.map((event) => event.name);
    expect(allNames[allNames.length - 1]).toBe('paymentplan.completed');
  });
});
