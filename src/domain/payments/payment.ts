/**
 * Payment aggregate — the system's fund truth for inflows (docs/02, docs/03, docs/05).
 *
 * Rules enforced here:
 *  - Pure functions only; time comes from an injected Clock, ids from callers
 *    (or deterministic derivation) — never Date.now()/RNG.
 *  - Money only via `Money` (minor units, bigint) — floats are banned (R10).
 *  - Daraja callbacks are untrusted and at-least-once (K1): intake (intake.ts)
 *    is idempotent on (channel, externalRef) / idempotencyKey (R9, C5).
 *  - `confirmedMinor` is set exactly ONCE; a replay of the same success callback
 *    is a no-op, a different amount is a hard error (CONFIRMED_AMOUNT_MISMATCH).
 *  - failed/reversed/refunded are terminal (docs/03: Failed --> [*], Reversed --> [*],
 *    Refunded --> [*]).
 *  - Post-confirmation immutability: the only correction path is an explicit
 *    `reversePayment(reason)`; correction rows are appended, never edited/deleted (R3).
 *  - Ceilings (R2 payment-side): Σ(allocations) + Σ(refunds) ≤ confirmedMinor;
 *    the remainder is derivable `unappliedMinor` and parks on the customer —
 *    confirmed money is never dropped (C4 feeds off this).
 *
 * Wave-1 note: allocation/refund entries recorded here are simple append-only
 * *reservations* referencing the payment id. The real allocation engine
 * (funding receivable states, strategies, sequence numbers) is wave 2 (#5),
 * and the Refund aggregate lifecycle is the adjustments lane (#4).
 */
import { DomainError, Money } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import {
  paymentConfirmedEvent,
  paymentFailedEvent,
  paymentReversedEvent,
} from './events';
import type { PaymentEvent } from './events';
import { uuidFromSeed } from './ids';

export type PaymentChannel = 'c2b' | 'stk';

/** docs/05 data dictionary state enum. */
export type PaymentState =
  | 'initiated'
  | 'pending_confirmation'
  | 'confirmed'
  | 'partially_allocated'
  | 'allocated'
  | 'unapplied'
  | 'failed'
  | 'reversed'
  | 'partially_refunded'
  | 'refunded';

/** Terminal states per docs/03 (edges to [*]). */
export const TERMINAL_STATES: readonly PaymentState[] = ['failed', 'reversed', 'refunded'];

/**
 * States that imply the money has actually landed (a Daraja success callback
 * was processed). Matching and parking apply only to this family.
 */
export const CONFIRMED_FAMILY: readonly PaymentState[] = [
  'confirmed',
  'partially_allocated',
  'allocated',
  'unapplied',
  'partially_refunded',
  'refunded',
];

export const isTerminal = (payment: Payment): boolean =>
  TERMINAL_STATES.includes(payment.state);

export const isConfirmedFamily = (payment: Payment): boolean =>
  CONFIRMED_FAMILY.includes(payment.state);

/**
 * Append-only allocation reservation row (wave 1). The real Allocation entity
 * (strategy, sequenceNo, idempotent replay keys) lands with issue #5; this row
 * is the payment-side truth that keeps Σ allocations computable (R2).
 */
export interface PaymentAllocationRow {
  readonly id: Uuid;
  readonly paymentId: Uuid;
  readonly receivableId: Uuid; // opaque reference — receivables are another lane
  readonly amount: Money;
  readonly recordedAt: Date;
}

/** Append-only refund reservation row (wave 1) — feeds the refund ceiling (R6). */
export interface PaymentRefundRow {
  readonly id: Uuid;
  readonly paymentId: Uuid;
  readonly amount: Money;
  readonly reason: string;
  readonly recordedAt: Date;
}

export interface Payment {
  readonly id: Uuid;
  readonly channel: PaymentChannel;
  readonly externalRef: string; // Daraja transaction id
  readonly idempotencyKey: string; // U(channel, externalRef) and U(idempotencyKey) — R9/C5
  readonly customerId?: Uuid; // null until identified; required when unapplied parking
  readonly state: PaymentState;
  readonly currency: Currency;
  readonly requestedMinor: Money; // what was asked for at intake (E11 requestedMinor)
  readonly declaredRefs: readonly string[]; // payer-typed invoice/receipt refs, if any
  readonly confirmedMinor?: Money; // set exactly once at confirmation (docs/05)
  readonly initiatedAt: Date;
  readonly confirmedAt?: Date;
  readonly failedAt?: Date;
  readonly failureCode?: string;
  readonly reversedAt?: Date;
  readonly reversalReason?: string;
  readonly allocations: readonly PaymentAllocationRow[]; // append-only (R3)
  readonly refunds: readonly PaymentRefundRow[]; // append-only (R3)
}

export interface TransitionResult {
  readonly payment: Payment;
  readonly events: readonly PaymentEvent[];
}

/** Σ of everything already committed against the confirmed funds. */
const committedOf = (payment: Payment): Money =>
  [...payment.allocations, ...payment.refunds].reduce(
    (acc, row) => acc.add(row.amount),
    Money.zero(payment.currency),
  );

/**
 * Derivable unapplied balance (docs/05): confirmedMinor − Σ allocations − Σ refunds.
 * Ceilings (R2/R6) make the negative case unreachable through the transitions;
 * a derivation reports (clamps at zero) rather than throwing on hand-built data.
 */
export const unappliedMinorOf = (payment: Payment): Money => {
  if (!payment.confirmedMinor) return Money.zero(payment.currency);
  const committed = committedOf(payment);
  if (committed.compareTo(payment.confirmedMinor) >= 0) return Money.zero(payment.currency);
  return payment.confirmedMinor.subtract(committed);
};

const assertSameCurrency = (payment: Payment, amount: Money, op: string): void => {
  if (amount.currency !== payment.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `cannot ${op} ${amount.currency} against a ${payment.currency} payment (R10)`,
    );
  }
};

const assertPositive = (amount: Money, op: string): void => {
  if (amount.amount <= 0n) {
    throw new DomainError('AMOUNT_MUST_BE_POSITIVE', `${op} amounts must be > 0`);
  }
};

const assertNotTerminal = (payment: Payment, attempt: string): void => {
  if (isTerminal(payment)) {
    throw new DomainError(
      'PAYMENT_TERMINAL',
      `payment ${payment.id} is ${payment.state} (terminal); ${attempt} is not allowed`,
    );
  }
};

const assertConfirmedMinor = (payment: Payment): Money => {
  const confirmed = payment.confirmedMinor;
  if (!confirmed) {
    throw new DomainError(
      'PAYMENT_STATE_CORRUPT',
      `payment ${payment.id} is ${payment.state} but has no confirmedMinor`,
    );
  }
  return confirmed;
};

/** Initiated → PendingConfirmation: awaiting the Daraja result. No catalog event (docs/04). */
export const awaitConfirmation = (payment: Payment): TransitionResult => {
  assertNotTerminal(payment, 'awaiting confirmation');
  if (payment.state !== 'initiated') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `awaitConfirmation applies to initiated payments, got ${payment.state}`,
    );
  }
  return { payment: { ...payment, state: 'pending_confirmation' }, events: [] };
};

/**
 * PendingConfirmation → Confirmed (docs/03: "Daraja success callback (idempotent)").
 * Sets confirmedMinor exactly once:
 *  - replay with the SAME amount → no-op, no events (at-least-once channel, K1);
 *  - replay with a DIFFERENT amount → CONFIRMED_AMOUNT_MISMATCH (untrusted input).
 */
export const confirmPayment = (payment: Payment, amount: Money, clock: Clock): TransitionResult => {
  assertSameCurrency(payment, amount, 'confirm');
  assertNotTerminal(payment, 'confirmation');
  if (payment.state === 'confirmed') {
    const confirmed = assertConfirmedMinor(payment);
    if (!confirmed.equals(amount)) {
      throw new DomainError(
        'CONFIRMED_AMOUNT_MISMATCH',
        `payment ${payment.id} already confirmed for ${confirmed.toString()}, cannot re-confirm for ${amount.toString()}`,
      );
    }
    return { payment, events: [] };
  }
  if (payment.state !== 'pending_confirmation') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `confirmation applies to pending_confirmation payments, got ${payment.state}`,
    );
  }
  const confirmedAt = clock.now();
  return {
    payment: { ...payment, state: 'confirmed', confirmedMinor: amount, confirmedAt },
    events: [
      paymentConfirmedEvent(
        {
          paymentId: payment.id,
          confirmedMinor: amount,
          externalRef: payment.externalRef,
          confirmedAt,
        },
        clock,
      ),
    ],
  };
};

/**
 * Initiated|PendingConfirmation → Failed (docs/03). Failed is terminal; a
 * duplicate failure callback is a no-op (append-only: the original code stands).
 */
export const failPayment = (payment: Payment, failureCode: string, clock: Clock): TransitionResult => {
  const code = failureCode.trim();
  if (!code) {
    throw new DomainError('FAILURE_CODE_REQUIRED', 'a failure transition requires a failure code');
  }
  if (payment.state === 'failed') return { payment, events: [] };
  assertNotTerminal(payment, 'failure');
  if (payment.state !== 'initiated' && payment.state !== 'pending_confirmation') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `failure applies to initiated/pending_confirmation payments, got ${payment.state}`,
    );
  }
  const failedAt = clock.now();
  return {
    payment: { ...payment, state: 'failed', failedAt, failureCode: code },
    events: [paymentFailedEvent({ paymentId: payment.id, failureCode: code }, clock)],
  };
};

/**
 * Confirmed → Reversed (docs/03 edge "duplicate/reversal entry"). Explicit,
 * reasoned, append-only (R3): recorded rows stay put, the state flips once.
 * Reversing allocated money first requires reversing the allocations (wave 2, #5).
 */
export const reversePayment = (payment: Payment, reason: string, clock: Clock): TransitionResult => {
  const why = reason.trim();
  if (!why) {
    throw new DomainError('REVERSAL_REASON_REQUIRED', 'a reversal requires an explicit reason (R3)');
  }
  assertNotTerminal(payment, 'reversal');
  if (payment.state !== 'confirmed') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `docs/03 allows reversal only from confirmed, got ${payment.state} (reverse allocations first — wave 2)`,
    );
  }
  const reversedAt = clock.now();
  return {
    payment: { ...payment, state: 'reversed', reversedAt, reversalReason: why },
    events: [
      paymentReversedEvent({ paymentId: payment.id, reason: why, reversalOf: payment.id }, clock),
    ],
  };
};

/**
 * Unapplied parking (docs/03 "Confirmed --> Unapplied: unidentified (parked on customer)").
 * Confirmed money that cannot be matched to an invoice is NEVER dropped: it parks
 * against a customer and feeds the credit-balance decision (C4). Re-parking the
 * same customer is idempotent; silently re-assigning is not allowed.
 */
export const identifyPayment = (payment: Payment, customerId: Uuid): TransitionResult => {
  assertNotTerminal(payment, 'unapplied parking');
  if (payment.state === 'unapplied') {
    if (payment.customerId === customerId) return { payment, events: [] };
    throw new DomainError(
      'PAYMENT_ALREADY_IDENTIFIED',
      `unapplied payment ${payment.id} already parks on customer ${payment.customerId ?? '∅'}`,
    );
  }
  if (payment.state !== 'confirmed') {
    throw new DomainError(
      'INVALID_TRANSITION',
      `unapplied parking applies to confirmed money, got ${payment.state}`,
    );
  }
  return { payment: { ...payment, state: 'unapplied', customerId }, events: [] };
};

export interface AllocationReservation {
  readonly receivableId: Uuid; // opaque — the receivables lane is never imported
  readonly amount: Money;
  readonly allocationId?: Uuid; // caller-supplied (preferred); deterministic fallback otherwise
}

/**
 * Record an append-only allocation reservation row (wave-1 stand-in for the
 * allocation engine, issue #5). Enforces the payment side of R2:
 * Σ(allocations) + Σ(refunds) ≤ confirmedMinor, never over-allocated.
 * State edges per docs/03: Confirmed/Unapplied → PartiallyAllocated | Allocated,
 * PartiallyAllocated → Allocated. (Unapplied → PartiallyAllocated is the honest
 * landing state for a partial draw on parked money; full draws land on Allocated.)
 */
export const recordAllocationReservation = (
  payment: Payment,
  cmd: AllocationReservation,
  clock: Clock,
): TransitionResult => {
  assertSameCurrency(payment, cmd.amount, 'allocate');
  assertPositive(cmd.amount, 'allocation');
  assertNotTerminal(payment, 'allocation');
  if (!isConfirmedFamily(payment)) {
    throw new DomainError(
      'PAYMENT_NOT_CONFIRMED',
      `allocations draw on confirmed funds; payment ${payment.id} is ${payment.state} (R2)`,
    );
  }
  const confirmed = assertConfirmedMinor(payment);
  const next = committedOf(payment).add(cmd.amount);
  if (next.compareTo(confirmed) > 0) {
    throw new DomainError(
      'ALLOCATION_EXCEEDS_CONFIRMED',
      `Σ allocations+refunds ${next.toString()} would exceed confirmed ${confirmed.toString()} (R2)`,
    );
  }
  const recordedAt = clock.now();
  const row: PaymentAllocationRow = {
    id:
      cmd.allocationId ??
      uuidFromSeed(
        `allocation:${payment.id}:${cmd.receivableId}:${cmd.amount.amount}:${recordedAt.toISOString()}`,
      ),
    paymentId: payment.id,
    receivableId: cmd.receivableId,
    amount: cmd.amount,
    recordedAt,
  };
  const remaining = confirmed.subtract(next);
  return {
    payment: {
      ...payment,
      allocations: [...payment.allocations, row],
      state: remaining.isZero() ? 'allocated' : 'partially_allocated',
    },
    events: [], // allocation.executed (E24) belongs to the allocation lane (wave 2)
  };
};

export interface RefundReservation {
  readonly amount: Money;
  readonly reason: string;
  readonly refundId?: Uuid; // caller-supplied (preferred); deterministic fallback otherwise
}

/**
 * Record an append-only refund reservation row (wave 1). Enforces the payment
 * side of R6: refunds draw only on funds not already allocated/refunded.
 * State-neutral by design: the Refunded/PartiallyRefunded edges belong to the
 * Refund aggregate lifecycle owned by the adjustments lane (issue #4); this row
 * keeps the payment-side ceiling and the unapplied derivation honest.
 */
export const recordRefundReservation = (
  payment: Payment,
  cmd: RefundReservation,
  clock: Clock,
): TransitionResult => {
  const why = cmd.reason.trim();
  if (!why) {
    throw new DomainError('REFUND_REASON_REQUIRED', 'a refund reservation requires a reason');
  }
  assertSameCurrency(payment, cmd.amount, 'refund');
  assertPositive(cmd.amount, 'refund');
  assertNotTerminal(payment, 'refund');
  if (!isConfirmedFamily(payment)) {
    throw new DomainError(
      'PAYMENT_NOT_CONFIRMED',
      `refunds draw on confirmed funds; payment ${payment.id} is ${payment.state} (R6)`,
    );
  }
  const confirmed = assertConfirmedMinor(payment);
  const next = committedOf(payment).add(cmd.amount);
  if (next.compareTo(confirmed) > 0) {
    throw new DomainError(
      'REFUND_EXCEEDS_AVAILABLE',
      `Σ allocations+refunds ${next.toString()} would exceed confirmed ${confirmed.toString()} (R6)`,
    );
  }
  const recordedAt = clock.now();
  const row: PaymentRefundRow = {
    id:
      cmd.refundId ??
      uuidFromSeed(`refund:${payment.id}:${cmd.amount.amount}:${recordedAt.toISOString()}`),
    paymentId: payment.id,
    amount: cmd.amount,
    reason: why,
    recordedAt,
  };
  return { payment: { ...payment, refunds: [...payment.refunds, row] }, events: [] };
};
