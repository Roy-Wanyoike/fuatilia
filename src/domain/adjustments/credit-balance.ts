/**
 * CustomerCreditBalance — review finding C4, invariants R3 + R7 (docs/07).
 *
 * Overpayments (and consented credit-note excess) must live somewhere: one
 * balance per (customerId, currency). The movement log is append-only (R3) —
 * every operation APPENDS a row and the available balance is always RECOMPUTED
 * from the log, never mutated in place. Applying from the balance never drives
 * it negative (INSUFFICIENT_CREDIT_BALANCE) and is consent-gated (R7 / DPA 2019).
 *
 * Pure functions only; money is Money (bigint minor units).
 */
import { DomainError, Money } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import type { AdjustmentEvent, CreditBalanceAppliedPayload } from './events';
import { creditBalanceAppliedEvent } from './events';

export type CreditBalanceMovementKind =
  | 'overpayment' // money in: unidentified/overpaid payment parked on the customer (C4)
  | 'credit_note_excess' // money in: consented routing of unapplied credit-note value (R7)
  | 'applied_to_receivable'; // money out: consented settlement of a receivable

export type CreditBalanceDirection = 'increase' | 'decrease';

export interface CreditBalanceMovement {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly kind: CreditBalanceMovementKind;
  readonly direction: CreditBalanceDirection;
  /** > 0 — direction carries the sign; a negative movement amount is a modelling bug. */
  readonly amount: Money;
  readonly currency: Currency;
  /** overpayment: reference of the source payment (Daraja externalRef or payment id). */
  readonly paymentRef?: string;
  /** applied_to_receivable: the receivable being settled. */
  readonly receivableId?: Uuid;
  /** credit_note_excess: originating credit note id. */
  readonly sourceId?: Uuid;
  readonly occurredAt: Date;
}

export interface CustomerCreditBalance {
  readonly customerId: Uuid;
  readonly currency: Currency;
  /** Append-only movement log (R3). Available is derived: Σ(increase) − Σ(decrease). */
  readonly movements: readonly CreditBalanceMovement[];
}

const MOVEMENT_CONTRACT: Record<
  CreditBalanceMovementKind,
  { direction: CreditBalanceDirection; requires: 'paymentRef' | 'sourceId' | 'receivableId' }
> = {
  overpayment: { direction: 'increase', requires: 'paymentRef' },
  credit_note_excess: { direction: 'increase', requires: 'sourceId' },
  applied_to_receivable: { direction: 'decrease', requires: 'receivableId' },
};

/** Open a zero balance for (customerId, currency) — composite PK per docs/05. */
export const openCreditBalance = (
  customerId: Uuid,
  currency: Currency,
): CustomerCreditBalance => ({ customerId, currency, movements: [] });

/** Recompute the available balance from the append-only log. Never mutates. */
export const availableOf = (balance: CustomerCreditBalance): Money => {
  let minor = 0n;
  for (const movement of balance.movements) {
    if (movement.currency !== balance.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `movement ${movement.id} is ${movement.currency} but balance is ${balance.currency}`,
      );
    }
    minor += movement.direction === 'increase' ? movement.amount.amount : -movement.amount.amount;
  }
  if (minor < 0n) {
    throw new DomainError(
      'CREDIT_BALANCE_CORRUPT',
      'movement log sums to a negative balance — an applied movement was never covered (R3 violation)',
    );
  }
  return Money.ofMinor(minor, balance.currency);
};

/**
 * Append a movement to the log (R3) and return a NEW balance object — the input
 * balance is never mutated. Validates customer, currency, positivity and the
 * kind/direction/reference contract so the log stays self-describing for the ledger.
 */
export const appendMovement = (
  balance: CustomerCreditBalance,
  movement: CreditBalanceMovement,
): CustomerCreditBalance => {
  if (movement.customerId !== balance.customerId) {
    throw new DomainError(
      'CREDIT_BALANCE_CUSTOMER_MISMATCH',
      `movement belongs to customer ${movement.customerId}, balance to ${balance.customerId}`,
    );
  }
  if (movement.currency !== balance.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `movement ${movement.amount.toString()} does not match balance currency ${balance.currency}`,
    );
  }
  if (!movement.amount.isPositive()) {
    throw new DomainError('CREDIT_BALANCE_AMOUNT_INVALID', 'movement amount must be positive');
  }
  const contract = MOVEMENT_CONTRACT[movement.kind];
  if (
    movement.direction !== contract.direction ||
    !movement[contract.requires]
  ) {
    throw new DomainError(
      'CREDIT_BALANCE_MOVEMENT_INCONSISTENT',
      `movement of kind '${movement.kind}' must be direction '${contract.direction}' and carry '${contract.requires}'`,
      { movementId: movement.id, kind: movement.kind, direction: movement.direction },
    );
  }
  return { ...balance, movements: [...balance.movements, movement] };
};

export interface OverpaymentRecorded {
  readonly balance: CustomerCreditBalance;
  readonly movement: CreditBalanceMovement;
}

/**
 * Record an overpayment (C4): append an 'overpayment' movement (R3) and
 * increase the available balance. paymentRef keeps the parked money traceable
 * to its source payment.
 */
export const recordOverpayment = (
  balance: CustomerCreditBalance,
  paymentRef: string,
  amount: Money,
  clock: Clock,
  movementId: Uuid,
): OverpaymentRecorded => {
  if (!paymentRef.trim()) {
    throw new DomainError(
      'CREDIT_BALANCE_PAYMENT_REF_REQUIRED',
      'an overpayment movement requires a source payment reference (C4 traceability)',
    );
  }
  if (!amount.isPositive()) {
    throw new DomainError('CREDIT_BALANCE_AMOUNT_INVALID', 'overpayment amount must be positive');
  }
  if (amount.currency !== balance.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `overpayment ${amount.toString()} does not match balance currency ${balance.currency}`,
    );
  }
  const movement: CreditBalanceMovement = {
    id: movementId,
    customerId: balance.customerId,
    kind: 'overpayment',
    direction: 'increase',
    amount,
    currency: balance.currency,
    paymentRef,
    occurredAt: clock.now(),
  };
  return { balance: appendMovement(balance, movement), movement };
};

export interface ApplyCreditBalanceOptions {
  /**
   * Consent gate (R7 / DPA 2019). Defaults to true per issue #4; pass false to
   * model a customer without an active consent grant.
   */
  readonly consent?: boolean;
  readonly movementId: Uuid;
}

export interface CreditBalanceApplied {
  readonly balance: CustomerCreditBalance;
  readonly movement: CreditBalanceMovement;
  readonly event: AdjustmentEvent<'adjustment.creditBalanceApplied', CreditBalanceAppliedPayload>;
}

/**
 * Apply customer credit to a receivable (C4): appends an 'applied_to_receivable'
 * movement and recomputes the balance. NEVER negative — over-applying throws
 * INSUFFICIENT_CREDIT_BALANCE. Emits E23 adjustment.creditBalanceApplied.
 */
export const applyCreditBalance = (
  balance: CustomerCreditBalance,
  receivableId: Uuid,
  amount: Money,
  clock: Clock,
  options: ApplyCreditBalanceOptions,
): CreditBalanceApplied => {
  const { consent = true, movementId } = options;
  if (!consent) {
    throw new DomainError(
      'CONSENT_REQUIRED',
      'applying customer credit balance to a receivable requires explicit consent (R7 / DPA 2019)',
      { customerId: balance.customerId },
    );
  }
  if (!amount.isPositive()) {
    throw new DomainError('CREDIT_BALANCE_AMOUNT_INVALID', 'applied amount must be positive');
  }
  if (amount.currency !== balance.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `application ${amount.toString()} does not match balance currency ${balance.currency}`,
    );
  }
  const available = availableOf(balance);
  if (amount.compareTo(available) > 0) {
    throw new DomainError(
      'INSUFFICIENT_CREDIT_BALANCE',
      `requested ${amount.toString()} exceeds available ${available.toString()} — balance can never go negative`,
      { requestedMinor: amount.amount, availableMinor: available.amount, customerId: balance.customerId },
    );
  }
  const movement: CreditBalanceMovement = {
    id: movementId,
    customerId: balance.customerId,
    kind: 'applied_to_receivable',
    direction: 'decrease',
    amount,
    currency: balance.currency,
    receivableId,
    occurredAt: clock.now(),
  };
  return {
    balance: appendMovement(balance, movement),
    movement,
    event: creditBalanceAppliedEvent(
      { customerId: balance.customerId, amountMinor: amount.amount, receivableId },
      clock,
    ),
  };
};
