import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  appendMovement,
  applyCreditBalance,
  availableOf,
  openCreditBalance,
  recordOverpayment,
} from './credit-balance';
import type { CreditBalanceMovement, CustomerCreditBalance } from './credit-balance';
import { applyExcessToCreditBalance, draftCreditNote, issueCreditNote } from './credit-note';

const clock: Clock = { now: () => new Date('2025-06-01T09:30:00.000Z') };

/** Deterministic 36-char hex ids for table-driven tests. */
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const customerId = uid('e0000000001');
const receivableId = uid('10000000001');

const balanceWith = (minor: bigint, currency: 'KES' | 'USD' = 'KES'): CustomerCreditBalance =>
  recordOverpayment(
    openCreditBalance(customerId, currency),
    'SBX-ovp-1',
    Money.ofMinor(minor, currency),
    clock,
    uid('cc000000001'),
  ).balance;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

describe('CustomerCreditBalance overpayments (C4, R3)', () => {
  it('records an overpayment as an appended movement and increases available', () => {
    const empty = openCreditBalance(customerId, 'KES');
    expect(availableOf(empty).isZero()).toBe(true);

    const { balance, movement } = recordOverpayment(
      empty,
      'SBX123XY91',
      Money.ofMinor(75_000, 'KES'),
      clock,
      uid('cc000000001'),
    );
    expect(movement.kind).toBe('overpayment');
    expect(movement.direction).toBe('increase');
    expect(movement.paymentRef).toBe('SBX123XY91');
    expect(balance.movements).toHaveLength(1); // append-only log (R3)
    expect(availableOf(balance).amount).toBe(75_000n); // recomputed from the log
  });

  it('never mutates the prior balance object (append-only, R3)', () => {
    const before = balanceWith(10_000n);
    recordOverpayment(before, 'SBX-2', Money.ofMinor(5_000, 'KES'), clock, uid('cc000000002'));
    expect(before.movements).toHaveLength(1); // untouched
    expect(availableOf(before).amount).toBe(10_000n);
  });

  it.each([
    ['empty payment ref', '  ', Money.ofMinor(1_000, 'KES'), 'CREDIT_BALANCE_PAYMENT_REF_REQUIRED'],
    ['zero amount', 'SBX-1', Money.ofMinor(0, 'KES'), 'CREDIT_BALANCE_AMOUNT_INVALID'],
    ['cross-currency amount', 'SBX-1', Money.ofMinor(1_000, 'USD'), 'CURRENCY_MISMATCH'],
  ])('refuses %s with %s', (_label, paymentRef, amount, code) => {
    expectCode(
      () => recordOverpayment(openCreditBalance(customerId, 'KES'), paymentRef, amount, clock, uid('cc000000001')),
      code,
    );
  });
});

describe('applyCreditBalance (C4, R7)', () => {
  it('applies consented credit to a receivable and emits adjustment.creditBalanceApplied', () => {
    const funded = balanceWith(50_000n);
    const { balance, movement, event } = applyCreditBalance(
      funded,
      receivableId,
      Money.ofMinor(20_000, 'KES'),
      clock,
      { movementId: uid('cc000000002'), consent: true },
    );
    expect(movement.kind).toBe('applied_to_receivable');
    expect(movement.direction).toBe('decrease');
    expect(movement.receivableId).toBe(receivableId);
    expect(balance.movements).toHaveLength(2);
    expect(availableOf(balance).amount).toBe(30_000n); // never mutated — recomputed
    expect(event.name).toBe('adjustment.creditBalanceApplied');
    expect(event.aggregateId).toBe(customerId);
    expect(event.payload).toEqual({ customerId, amountMinor: 20_000n, receivableId });
  });

  it('defaults consent to true per issue #4, but gates when consent is false', () => {
    const funded = balanceWith(50_000n);
    // default path (consent omitted) is legal
    const applied = applyCreditBalance(funded, receivableId, Money.ofMinor(1_000, 'KES'), clock, {
      movementId: uid('cc000000002'),
    });
    expect(availableOf(applied.balance).amount).toBe(49_000n);
    // explicit consent=false is blocked even with sufficient funds
    expectCode(
      () =>
        applyCreditBalance(funded, receivableId, Money.ofMinor(1_000, 'KES'), clock, {
          movementId: uid('cc000000003'),
          consent: false,
        }),
      'CONSENT_REQUIRED',
    );
  });

  it('never allows the balance to go negative (INSUFFICIENT_CREDIT_BALANCE)', () => {
    const funded = balanceWith(10_000n);
    expectCode(
      () =>
        applyCreditBalance(funded, receivableId, Money.ofMinor(10_001, 'KES'), clock, {
          movementId: uid('cc000000002'),
        }),
      'INSUFFICIENT_CREDIT_BALANCE',
    );
    expectCode(
      () =>
        applyCreditBalance(openCreditBalance(customerId, 'KES'), receivableId, Money.ofMinor(1, 'KES'), clock, {
          movementId: uid('cc000000002'),
        }),
      'INSUFFICIENT_CREDIT_BALANCE',
    );
  });

  it.each([
    ['zero amount', Money.ofMinor(0, 'KES'), 'CREDIT_BALANCE_AMOUNT_INVALID'],
    ['cross-currency application', Money.ofMinor(1_000, 'USD'), 'CURRENCY_MISMATCH'],
  ])('refuses %s with %s', (_label, amount, code) => {
    expectCode(
      () =>
        applyCreditBalance(balanceWith(50_000n), receivableId, amount, clock, {
          movementId: uid('cc000000002'),
        }),
      code,
    );
  });

  it('supports a mixed overpay/apply sequence down to exactly zero', () => {
    let balance = openCreditBalance(customerId, 'KES');
    balance = recordOverpayment(balance, 'SBX-1', Money.ofMinor(100_000, 'KES'), clock, uid('cc000000001')).balance;
    balance = applyCreditBalance(balance, receivableId, Money.ofMinor(40_000, 'KES'), clock, {
      movementId: uid('cc000000002'),
    }).balance;
    balance = recordOverpayment(balance, 'SBX-2', Money.ofMinor(30_000, 'KES'), clock, uid('cc000000003')).balance;
    balance = applyCreditBalance(balance, receivableId, Money.ofMinor(90_000, 'KES'), clock, {
      movementId: uid('cc000000004'),
    }).balance;
    expect(balance.movements).toHaveLength(4);
    expect(availableOf(balance).isZero()).toBe(true);
  });

  it('is keyed per (customerId, currency) — another currency is a separate balance', () => {
    const usd = balanceWith(5_000n, 'USD');
    expect(availableOf(usd).amount).toBe(5_000n);
    expectCode(
      () =>
        applyCreditBalance(usd, receivableId, Money.ofMinor(1_000, 'KES'), clock, {
          movementId: uid('cc000000002'),
        }),
      'CURRENCY_MISMATCH',
    );
  });
});

describe('movement log guards (R3)', () => {
  const movement = (overrides: Partial<CreditBalanceMovement>): CreditBalanceMovement => ({
    id: uid('cc000000001'),
    customerId,
    kind: 'overpayment',
    direction: 'increase',
    amount: Money.ofMinor(1_000, 'KES'),
    currency: 'KES',
    paymentRef: 'SBX-1',
    occurredAt: clock.now(),
    ...overrides,
  });

  it('appends a valid movement and grows the log', () => {
    const balance = appendMovement(openCreditBalance(customerId, 'KES'), movement({}));
    expect(balance.movements).toHaveLength(1);
  });

  it.each([
    [
      'a movement from another customer',
      movement({ customerId: uid('e0000000002') }),
      'CREDIT_BALANCE_CUSTOMER_MISMATCH',
    ],
    [
      'a cross-currency movement',
      movement({ currency: 'USD', amount: Money.ofMinor(1_000, 'USD') }),
      'CURRENCY_MISMATCH',
    ],
    [
      'a non-positive movement',
      movement({ amount: Money.ofMinor(0, 'KES') }),
      'CREDIT_BALANCE_AMOUNT_INVALID',
    ],
    [
      'an overpayment movement without paymentRef',
      movement({ paymentRef: undefined }),
      'CREDIT_BALANCE_MOVEMENT_INCONSISTENT',
    ],
    [
      'a decrease movement of kind overpayment',
      movement({ direction: 'decrease' }),
      'CREDIT_BALANCE_MOVEMENT_INCONSISTENT',
    ],
    [
      'an applied movement without receivableId',
      movement({
        kind: 'applied_to_receivable',
        direction: 'decrease',
        paymentRef: undefined,
        receivableId: undefined,
      }),
      'CREDIT_BALANCE_MOVEMENT_INCONSISTENT',
    ],
  ])('refuses %s with %s', (_label, bad, code) => {
    expectCode(() => appendMovement(openCreditBalance(customerId, 'KES'), bad), code);
  });

  it('detects a corrupt log that sums negative (defensive)', () => {
    const corrupt: CustomerCreditBalance = {
      customerId,
      currency: 'KES',
      movements: [
        movement({
          id: uid('cc000000002'),
          kind: 'applied_to_receivable',
          direction: 'decrease',
          paymentRef: undefined,
          receivableId,
        }),
      ],
    };
    expectCode(() => availableOf(corrupt), 'CREDIT_BALANCE_CORRUPT');
  });

  it('lands credit-note excess on the balance via appendMovement (C3 → C4 flow)', () => {
    const note = issueCreditNote(
      draftCreditNote({
        id: uid('d0000000001'),
        customerId,
        reason: 'goodwill credit',
        total: Money.ofMinor(8_000, 'KES'),
      }).note,
      clock,
    ).note;
    const { movement } = applyExcessToCreditBalance(note, Money.ofMinor(8_000, 'KES'), true, clock, uid('cc000000001'));
    const balance = appendMovement(openCreditBalance(customerId, 'KES'), movement);
    expect(balance.movements[0]!.kind).toBe('credit_note_excess');
    expect(balance.movements[0]!.sourceId).toBe(note.id);
    expect(availableOf(balance).amount).toBe(8_000n);
  });
});
