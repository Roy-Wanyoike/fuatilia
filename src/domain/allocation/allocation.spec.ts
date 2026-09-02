import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Uuid } from '../shared';
import {
  ALLOCATION_ERRORS,
  activeAllocations,
  allocatedMinorTo,
  allocationOf,
  balanceAfter,
  balanceOf,
  unappliedRemainder,
  validateAllocations,
  type Allocation,
} from './allocation';

const at = new Date('2025-07-01T10:00:00.000Z');
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;
const kes = (minor: bigint): Money => Money.ofMinor(minor, 'KES');

const row = (overrides?: Partial<Parameters<typeof allocationOf>[0]>): Allocation =>
  allocationOf({
    id: uid('...000000001'),
    sourceType: 'payment',
    sourceId: uid('...p0000001'),
    receivableId: uid('...r0000001'),
    amount: kes(600n),
    strategy: 'fifo',
    sequenceNo: 1n,
    allocatedAt: at,
    ...overrides,
  });

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

describe('allocationOf (row factory guards)', () => {
  it('rejects a non-positive amount (docs/05: amountMinor > 0)', () => {
    expectCode(() => row({ amount: Money.zero('KES') }), ALLOCATION_ERRORS.AMOUNT_NOT_POSITIVE);
  });

  it('rejects sequenceNo < 1 (monotonic per source)', () => {
    expectCode(() => row({ sequenceNo: 0n }), ALLOCATION_ERRORS.SEQUENCE_INVALID);
  });

  it('defaults reversedAt/reversalOf to null (fresh active row)', () => {
    const fresh = row();
    expect(fresh.reversedAt).toBeNull();
    expect(fresh.reversalOf).toBeNull();
  });
});

describe('balanceOf / balanceAfter / allocatedMinorTo (R1 math)', () => {
  it('normalizes bigint balances to Money in the receivable currency', () => {
    const balance = balanceOf({ receivableId: uid('...r0000002'), currency: 'KES', balanceMinor: 250n });
    expect(balance).toEqual(kes(250n));
  });

  it('throws CURRENCY_MISMATCH when a Money balance disagrees with the declared currency (R10)', () => {
    expectCode(
      () =>
        balanceOf({
          receivableId: uid('...r0000002'),
          currency: 'KES',
          balanceMinor: Money.ofMinor(250n, 'USD'),
        }),
      'CURRENCY_MISMATCH',
    );
  });

  it('computes the remaining balance after active allocations', () => {
    const receivable = { receivableId: uid('...r0000003'), currency: 'KES' as const, balanceMinor: 10_000n };
    const rows = [row({ receivableId: receivable.receivableId, amount: kes(7_000n) })];
    expect(balanceAfter(receivable, rows)).toEqual(kes(3_000n));
  });

  it('trips BALANCE_OVER_ALLOCATED instead of returning a negative balance (R1)', () => {
    const receivable = { receivableId: uid('...r0000003'), currency: 'KES' as const, balanceMinor: 1_000n };
    const rows = [row({ receivableId: receivable.receivableId, amount: kes(1_001n) })];
    expectCode(() => balanceAfter(receivable, rows), ALLOCATION_ERRORS.BALANCE_OVER_ALLOCATED);
  });

  it('ignores reversed rows and compensating rows when recomputing (R3 + R1)', () => {
    const receivable = { receivableId: uid('...r0000003'), currency: 'KES' as const, balanceMinor: 10_000n };
    const original = row({ receivableId: receivable.receivableId, amount: kes(4_000n) });
    const reversedOriginal: Allocation = { ...original, reversedAt: at };
    const compensating = row({
      id: uid('...000000002'),
      receivableId: receivable.receivableId,
      amount: kes(4_000n),
      reversalOf: original.id,
    });
    const live = row({ id: uid('...000000003'), receivableId: receivable.receivableId, amount: kes(2_500n) });
    expect(allocatedMinorTo([reversedOriginal, compensating, live], receivable.receivableId)).toBe(2_500n);
    expect(balanceAfter(receivable, [reversedOriginal, compensating, live])).toEqual(kes(7_500n));
    expect(activeAllocations([reversedOriginal, compensating, live]).map((r) => r.id)).toEqual([live.id]);
  });
});

describe('unappliedRemainder / validateAllocations (R2 ceiling per source)', () => {
  const sourceId = uid('...p0000001');

  it('computes confirmed − Σ active allocations', () => {
    const rows = [row({ amount: kes(600n) }), row({ id: uid('...000000004'), amount: kes(150n), sequenceNo: 2n })];
    expect(unappliedRemainder(kes(1_000n), rows)).toEqual(kes(250n));
  });

  it('passes at the exact ceiling (Σ === available)', () => {
    const rows = [row({ amount: kes(1_000n) })];
    expect(validateAllocations(rows, kes(1_000n))).toBeUndefined();
  });

  it('rejects Σ > available (over-allocation)', () => {
    const rows = [row({ amount: kes(600n) }), row({ id: uid('...000000005'), amount: kes(500n), sequenceNo: 2n })];
    expectCode(() => validateAllocations(rows, kes(1_000n)), ALLOCATION_ERRORS.EXCEEDS_AVAILABLE);
  });

  it('rejects rows spanning multiple sources', () => {
    const rows = [row(), row({ id: uid('...000000006'), sourceId: uid('...p0000009') })];
    expectCode(() => validateAllocations(rows, kes(1_000n)), ALLOCATION_ERRORS.SOURCE_MISMATCH);
  });

  it('rejects a zero amount row (no negatives can exist — Money is non-negative)', () => {
    expectCode(
      () => validateAllocations([row({ amount: Money.zero('KES') })], kes(1_000n)),
      ALLOCATION_ERRORS.AMOUNT_NOT_POSITIVE,
    );
  });

  it('rejects cross-currency rows (R10)', () => {
    expectCode(
      () => validateAllocations([row({ amount: Money.ofMinor(600n, 'USD') })], kes(1_000n)),
      'CURRENCY_MISMATCH',
    );
  });

  it('frees capacity after a reversal: only active rows count toward Σ (R2 + R3)', () => {
    const original = row({ amount: kes(600n) });
    const reversed: Allocation = { ...original, reversedAt: at };
    const compensating = row({ id: uid('...000000007'), amount: kes(600n), reversalOf: original.id });
    // active Σ = 0 → the full 1_000 is allocatable again
    expect(unappliedRemainder(kes(1_000n), [reversed, compensating])).toEqual(kes(1_000n));
    expect(validateAllocations([reversed, compensating], kes(1_000n))).toBeUndefined();
  });
});
