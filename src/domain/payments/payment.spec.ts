import { describe, expect, it } from 'vitest';
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import { intakePayment } from './intake';
import {
  awaitConfirmation,
  confirmPayment,
  failPayment,
  identifyPayment,
  recordAllocationReservation,
  recordRefundReservation,
  reversePayment,
  unappliedMinorOf,
  type Payment,
  type PaymentState,
} from './payment';

const T0 = Date.UTC(2025, 2, 15, 8, 0, 0);
let tick = 0;
const clock: Clock = { now: () => new Date(T0 + tick++ * 1_000) };

const expectCode = (act: () => unknown, code: string): void => {
  try {
    act();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const AMOUNT = Money.ofMinor(100_000, 'KES'); // KES 1,000.00
const CUST = rid(101);

const initiatedPayment = (): Payment =>
  intakePayment(
    {
      channel: 'c2b',
      externalRef: 'QGH7XK21PL',
      idempotencyKey: 'idem-001',
      amount: AMOUNT,
      paymentId: rid(1),
    },
    { clock },
  ).payment;

const pendingPayment = (): Payment => awaitConfirmation(initiatedPayment()).payment;
const confirmedPayment = (): Payment => confirmPayment(pendingPayment(), AMOUNT, clock).payment;
const failedPayment = (): Payment => failPayment(initiatedPayment(), 'CX103', clock).payment;
const reversedPayment = (): Payment =>
  reversePayment(confirmedPayment(), 'duplicate posting', clock).payment;
const partiallyAllocatedPayment = (): Payment =>
  recordAllocationReservation(
    confirmedPayment(),
    { receivableId: rid(201), amount: Money.ofMinor(40_000, 'KES') },
    clock,
  ).payment;

describe('Payment state machine (docs/03) — legal paths', () => {
  const legalRows: { name: string; run: () => Payment; state: PaymentState }[] = [
    {
      name: 'initiated → pending_confirmation',
      run: () => awaitConfirmation(initiatedPayment()).payment,
      state: 'pending_confirmation',
    },
    {
      name: 'initiated → failed (user cancelled / timeout)',
      run: () => failPayment(initiatedPayment(), 'CX103', clock).payment,
      state: 'failed',
    },
    {
      name: 'pending_confirmation → confirmed (Daraja success callback)',
      run: () => confirmPayment(pendingPayment(), AMOUNT, clock).payment,
      state: 'confirmed',
    },
    {
      name: 'confirmed → unapplied (unidentified money parks on the customer)',
      run: () => identifyPayment(confirmedPayment(), CUST).payment,
      state: 'unapplied',
    },
    {
      name: 'confirmed → partially_allocated (partial reservation)',
      run: () => partiallyAllocatedPayment(),
      state: 'partially_allocated',
    },
    {
      name: 'partially_allocated → allocated (remainder reserved)',
      run: () => {
        const partial = partiallyAllocatedPayment();
        return recordAllocationReservation(
          partial,
          { receivableId: rid(202), amount: Money.ofMinor(60_000, 'KES') },
          clock,
        ).payment;
      },
      state: 'allocated',
    },
    {
      name: 'confirmed → reversed (explicit, reasoned)',
      run: () => reversedPayment(),
      state: 'reversed',
    },
  ];

  it.each(legalRows)('$name', ({ run, state }) => {
    expect(run().state).toBe(state);
  });

  it('confirmation emits payment.confirmed with the E12 payload', () => {
    const { payment, events } = confirmPayment(pendingPayment(), AMOUNT, clock);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.name).toBe('payment.confirmed');
    if (evt?.name !== 'payment.confirmed') throw new Error('unexpected event');
    expect(evt.version).toBe(1);
    expect(evt.aggregateId).toBe(payment.id);
    expect(evt.payload).toMatchObject({
      paymentId: payment.id,
      confirmedMinor: 100_000n,
      externalRef: 'QGH7XK21PL',
    });
    expect(evt.payload.confirmedAt).toBeInstanceOf(Date);
    expect(payment.confirmedMinor?.amount).toBe(100_000n);
    expect(payment.confirmedAt).toBeInstanceOf(Date);
  });
});

describe('Payment state machine (docs/03) — illegal paths', () => {
  const illegalRows: { name: string; act: () => unknown; code: string }[] = [
    {
      name: 'confirm straight from initiated (must pass pending_confirmation)',
      act: () => confirmPayment(initiatedPayment(), AMOUNT, clock),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'awaitConfirmation from pending_confirmation',
      act: () => awaitConfirmation(pendingPayment()),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'awaitConfirmation from confirmed',
      act: () => awaitConfirmation(confirmedPayment()),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'confirm from failed',
      act: () => confirmPayment(failedPayment(), AMOUNT, clock),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'confirm from reversed',
      act: () => confirmPayment(reversedPayment(), AMOUNT, clock),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'fail from confirmed (failure is not a correction path)',
      act: () => failPayment(confirmedPayment(), 'CX1', clock),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'fail from reversed',
      act: () => failPayment(reversedPayment(), 'CX1', clock),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'failPayment without a failure code',
      act: () => failPayment(initiatedPayment(), '   ', clock),
      code: 'FAILURE_CODE_REQUIRED',
    },
    {
      name: 'reverse from initiated',
      act: () => reversePayment(initiatedPayment(), 'x', clock),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'reverse from partially_allocated (allocations must reverse first — wave 2)',
      act: () => reversePayment(partiallyAllocatedPayment(), 'x', clock),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'reverse from failed',
      act: () => reversePayment(failedPayment(), 'x', clock),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'reverse without a reason',
      act: () => reversePayment(confirmedPayment(), '   ', clock),
      code: 'REVERSAL_REASON_REQUIRED',
    },
    {
      name: 'identify from initiated',
      act: () => identifyPayment(initiatedPayment(), CUST),
      code: 'INVALID_TRANSITION',
    },
    {
      name: 'identify from reversed',
      act: () => identifyPayment(reversedPayment(), CUST),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'allocation reservation on unconfirmed (initiated) money',
      act: () =>
        recordAllocationReservation(
          initiatedPayment(),
          { receivableId: rid(9), amount: Money.ofMinor(1, 'KES') },
          clock,
        ),
      code: 'PAYMENT_NOT_CONFIRMED',
    },
    {
      name: 'allocation reservation on failed money',
      act: () =>
        recordAllocationReservation(
          failedPayment(),
          { receivableId: rid(9), amount: Money.ofMinor(1, 'KES') },
          clock,
        ),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'refund reservation on unconfirmed (pending) money',
      act: () =>
        recordRefundReservation(
          pendingPayment(),
          { amount: Money.ofMinor(1, 'KES'), reason: 'oops' },
          clock,
        ),
      code: 'PAYMENT_NOT_CONFIRMED',
    },
    {
      name: 'refund reservation on reversed money',
      act: () =>
        recordRefundReservation(
          reversedPayment(),
          { amount: Money.ofMinor(1, 'KES'), reason: 'oops' },
          clock,
        ),
      code: 'PAYMENT_TERMINAL',
    },
    {
      name: 'refund reservation without a reason',
      act: () =>
        recordRefundReservation(confirmedPayment(), { amount: Money.ofMinor(1, 'KES'), reason: ' ' }, clock),
      code: 'REFUND_REASON_REQUIRED',
    },
  ];

  it.each(illegalRows)('rejects: $name ($code)', ({ act, code }) => {
    expectCode(act, code);
  });
});

describe('Confirmation sets confirmedMinor exactly once (R9/K1 idempotency)', () => {
  it('a replayed success callback with the SAME amount is a no-op (no new events)', () => {
    const payment = confirmedPayment();
    const replay = confirmPayment(payment, AMOUNT, clock);
    expect(replay.payment).toBe(payment);
    expect(replay.events).toHaveLength(0);
  });

  it('a replayed success callback with a DIFFERENT amount throws CONFIRMED_AMOUNT_MISMATCH', () => {
    expectCode(
      () => confirmPayment(confirmedPayment(), Money.ofMinor(99_999, 'KES'), clock),
      'CONFIRMED_AMOUNT_MISMATCH',
    );
  });

  it('confirmation must match the payment currency (R10)', () => {
    expectCode(
      () => confirmPayment(pendingPayment(), Money.ofMinor(100_000, 'USD'), clock),
      'CURRENCY_MISMATCH',
    );
  });

  it('confirmedMinor never changes after later transitions', () => {
    const payment = confirmedPayment();
    const parked = identifyPayment(payment, CUST).payment;
    expect(parked.confirmedMinor?.amount).toBe(100_000n);
    expect(parked.confirmedAt).toBe(payment.confirmedAt);
  });
});

describe('Failed is terminal (docs/03: Failed --> [*])', () => {
  it('a duplicate failure callback is an idempotent no-op (at-least-once, K1)', () => {
    const payment = failedPayment();
    const replay = failPayment(payment, 'CX103', clock);
    expect(replay.payment).toBe(payment);
    expect(replay.events).toHaveLength(0);
  });
});

describe('Reversal (R3 — append-only corrections)', () => {
  it('reversal keeps recorded rows and never deletes history', () => {
    // Refund reservations are state-neutral (the Refund lifecycle is issue #4),
    // so the payment is still `confirmed` — the legal source state for reversal.
    const refunded = recordRefundReservation(
      confirmedPayment(),
      { amount: Money.ofMinor(10_000, 'KES'), reason: 'overpayment' },
      clock,
    ).payment;
    const reversed = reversePayment(refunded, 'wrong paybill', clock).payment;
    expect(reversed.state).toBe('reversed');
    expect(reversed.refunds).toHaveLength(1);
    expect(reversed.refunds[0]?.id).toBe(refunded.refunds[0]?.id);
    expect(reversed.reversalReason).toBe('wrong paybill');
    expect(reversed.reversedAt).toBeInstanceOf(Date);
    expect(unappliedMinorOf(reversed).amount).toBe(90_000n); // rows still count
  });
});

describe('Unapplied parking (confirmed money is never dropped — C4)', () => {
  it('identifyPayment parks confirmed-but-unidentified money on the customer', () => {
    const { payment } = identifyPayment(confirmedPayment(), CUST);
    expect(payment.state).toBe('unapplied');
    expect(payment.customerId).toBe(CUST);
    expect(unappliedMinorOf(payment).amount).toBe(100_000n);
  });

  it('re-parking on the same customer is idempotent; a different customer is rejected', () => {
    const parked = identifyPayment(confirmedPayment(), CUST).payment;
    expect(identifyPayment(parked, CUST).payment).toBe(parked);
    expectCode(() => identifyPayment(parked, rid(999)), 'PAYMENT_ALREADY_IDENTIFIED');
  });
});

describe('unappliedMinor derivation (docs/05: confirmed − Σ allocations − Σ refunds)', () => {
  it('derives the remainder across both reservation kinds', () => {
    let payment = confirmedPayment();
    expect(unappliedMinorOf(payment).amount).toBe(100_000n);
    payment = recordAllocationReservation(
      payment,
      { receivableId: rid(401), amount: Money.ofMinor(45_000, 'KES') },
      clock,
    ).payment;
    payment = recordRefundReservation(
      payment,
      { amount: Money.ofMinor(15_000, 'KES'), reason: 'overpayment' },
      clock,
    ).payment;
    expect(unappliedMinorOf(payment).amount).toBe(40_000n);
    expect(payment.state).toBe('partially_allocated');
  });

  it('fully committed money leaves zero unapplied and lands on allocated', () => {
    let payment = confirmedPayment();
    payment = recordAllocationReservation(
      payment,
      { receivableId: rid(402), amount: Money.ofMinor(70_000, 'KES') },
      clock,
    ).payment;
    payment = recordAllocationReservation(
      payment,
      { receivableId: rid(403), amount: Money.ofMinor(30_000, 'KES') },
      clock,
    ).payment;
    expect(payment.state).toBe('allocated');
    expect(unappliedMinorOf(payment).amount).toBe(0n);
  });

  it('money that never confirmed has no unapplied balance', () => {
    expect(unappliedMinorOf(initiatedPayment()).amount).toBe(0n);
    expect(unappliedMinorOf(failedPayment()).amount).toBe(0n);
  });
});

describe('Ceilings — R2/R6 payment-side', () => {
  it('a single reservation above confirmed throws ALLOCATION_EXCEEDS_CONFIRMED', () => {
    expectCode(
      () =>
        recordAllocationReservation(
          confirmedPayment(),
          { receivableId: rid(501), amount: Money.ofMinor(100_001, 'KES') },
          clock,
        ),
      'ALLOCATION_EXCEEDS_CONFIRMED',
    );
  });

  it('a reservation crossing the ceiling after earlier rows throws (R2)', () => {
    let payment = partiallyAllocatedPayment(); // 40,000 allocated
    payment = recordRefundReservation(
      payment,
      { amount: Money.ofMinor(10_000, 'KES'), reason: 'partial refund' },
      clock,
    ).payment;
    expectCode(
      () =>
        recordAllocationReservation(
          payment,
          { receivableId: rid(502), amount: Money.ofMinor(50_001, 'KES') },
          clock,
        ),
      'ALLOCATION_EXCEEDS_CONFIRMED',
    );
  });

  it('refunds beyond unallocated funds throw REFUND_EXCEEDS_AVAILABLE (R6)', () => {
    const payment = partiallyAllocatedPayment(); // 40,000 allocated, 60,000 free
    expectCode(
      () =>
        recordRefundReservation(
          payment,
          { amount: Money.ofMinor(60_001, 'KES'), reason: 'overpayment' },
          clock,
        ),
      'REFUND_EXCEEDS_AVAILABLE',
    );
  });

  const invalidRows: { name: string; act: () => unknown; code: string }[] = [
    {
      name: 'zero allocation amount',
      act: () =>
        recordAllocationReservation(
          confirmedPayment(),
          { receivableId: rid(510), amount: Money.ofMinor(0, 'KES') },
          clock,
        ),
      code: 'AMOUNT_MUST_BE_POSITIVE',
    },
    {
      name: 'zero refund amount',
      act: () =>
        recordRefundReservation(confirmedPayment(), { amount: Money.ofMinor(0, 'KES'), reason: 'r' }, clock),
      code: 'AMOUNT_MUST_BE_POSITIVE',
    },
    {
      name: 'cross-currency allocation',
      act: () =>
        recordAllocationReservation(
          confirmedPayment(),
          { receivableId: rid(511), amount: Money.ofMinor(1, 'USD') },
          clock,
        ),
      code: 'CURRENCY_MISMATCH',
    },
    {
      name: 'cross-currency refund',
      act: () =>
        recordRefundReservation(confirmedPayment(), { amount: Money.ofMinor(1, 'TZS'), reason: 'r' }, clock),
      code: 'CURRENCY_MISMATCH',
    },
  ];
  it.each(invalidRows)('rejects $name ($code)', ({ act, code }) => {
    expectCode(act, code);
  });
});

describe('Append-only semantics (R3)', () => {
  it('transitions never mutate the input aggregate', () => {
    const before = confirmedPayment();
    const after = recordAllocationReservation(
      before,
      { receivableId: rid(601), amount: Money.ofMinor(25_000, 'KES') },
      clock,
    ).payment;
    expect(after).not.toBe(before);
    expect(before.state).toBe('confirmed');
    expect(before.allocations).toHaveLength(0);
    expect(after.allocations).toHaveLength(1);
  });

  it('reservation rows are append-only rows referencing the payment id', () => {
    const first = recordAllocationReservation(
      confirmedPayment(),
      { receivableId: rid(602), amount: Money.ofMinor(10_000, 'KES') },
      clock,
    ).payment;
    const second = recordRefundReservation(
      first,
      { amount: Money.ofMinor(5_000, 'KES'), reason: 'overpayment' },
      clock,
    ).payment;
    expect(second.allocations).toHaveLength(1);
    expect(second.refunds).toHaveLength(1);
    expect(second.allocations[0]?.paymentId).toBe(second.id);
    expect(second.refunds[0]?.paymentId).toBe(second.id);
    expect(second.allocations[0]?.receivableId).toBe(rid(602));
  });
});
