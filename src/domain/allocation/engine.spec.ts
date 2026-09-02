import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import { validateAllocations, type AllocatableReceivable } from './allocation';
import { executeAllocation, reverseAllocation } from './engine';
import type { AllocationExecution } from './engine';

const clock: Clock = { now: () => new Date('2025-07-01T10:00:00.000Z') };
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;
const kes = (minor: bigint): Money => Money.ofMinor(minor, 'KES');

const source = (available: bigint, sourceType: 'payment' | 'credit_balance' = 'payment') => ({
  sourceType,
  sourceId: uid('...p0000001'),
  currency: 'KES' as const,
  available: kes(available),
});

const recv = (tail: string, balanceMinor: bigint, due?: string): AllocatableReceivable => ({
  receivableId: uid(tail),
  currency: 'KES',
  balanceMinor,
  ...(due ? { dueDate: new Date(due) } : {}),
});

const RECEIVABLES = [
  recv('...a00000001', 10_000n, '2025-01-10'),
  recv('...b00000001', 5_000n, '2025-02-01'),
  recv('...c00000001', 7_000n, '2025-01-15'),
];

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

describe('executeAllocation', () => {
  it('builds append-only rows with monotonic sequenceNos, one batch timestamp, and E24 events', () => {
    const result = executeAllocation({
      source: source(12_000n),
      receivables: RECEIVABLES,
      strategy: 'fifo',
      clock,
    });
    expect(result.allocations.map((a) => [a.receivableId, a.amountMinor.amount])).toEqual([
      [uid('...a00000001'), 10_000n],
      [uid('...c00000001'), 2_000n],
    ]);
    expect(result.allocations.map((a) => a.sequenceNo)).toEqual([1n, 2n]);
    expect(result.allocations.every((a) => a.sourceType === 'payment')).toBe(true);
    expect(result.allocations.every((a) => a.allocatedAt.getTime() === clock.now().getTime())).toBe(true);
    expect(result.allocations.every((a) => a.reversedAt === null && a.reversalOf === null)).toBe(true);
    expect(result.allocations.every((a) => a.strategy === 'fifo')).toBe(true);

    expect(result.events).toHaveLength(result.allocations.length);
    expect(result.events[0]).toEqual({
      name: 'allocation.executed',
      version: 1,
      aggregateId: result.allocations[0]!.id,
      payload: {
        allocationId: result.allocations[0]!.id,
        sourceType: 'payment',
        sourceId: uid('...p0000001'),
        receivableId: uid('...a00000001'),
        amountMinor: 10_000n,
        strategy: 'fifo',
      },
      occurredAt: '2025-07-01T10:00:00.000Z',
    });
    expect(result.unapplied).toEqual(kes(0n)); // debt absorbed the payment exactly
  });

  it('keeps the leftover unapplied when the debt cannot absorb the payment (R2)', () => {
    const result = executeAllocation({
      source: source(25_000n),
      receivables: RECEIVABLES,
      strategy: 'fifo',
      clock,
    });
    expect(result.unapplied).toEqual(kes(3_000n)); // 25_000 − 22_000 outstanding
  });

  it('requires a declared split for the explicit strategy', () => {
    expectCode(
      () => executeAllocation({ source: source(1_000n), receivables: RECEIVABLES, strategy: 'explicit', clock }),
      'ALLOCATION_DECLARATION_REQUIRED',
    );
  });

  it('rejects a declared split for fifo/pro_rata', () => {
    expectCode(
      () =>
        executeAllocation({
          source: source(1_000n),
          receivables: RECEIVABLES,
          strategy: 'fifo',
          clock,
          declared: new Map([[uid('...a00000001'), kes(100n)]]),
        }),
      'ALLOCATION_DECLARATION_NOT_ALLOWED',
    );
  });

  it('rejects source funds whose currency disagrees with the declared source currency (R10)', () => {
    expectCode(
      () =>
        executeAllocation({
          source: { sourceType: 'payment', sourceId: uid('...p0000001'), currency: 'KES', available: Money.ofMinor(1_000n, 'USD') },
          receivables: RECEIVABLES,
          strategy: 'fifo',
          clock,
        }),
      'CURRENCY_MISMATCH',
    );
  });

  it('works for a credit_balance source and emits sourceType credit_balance', () => {
    const result = executeAllocation({
      source: source(4_000n, 'credit_balance'),
      receivables: [recv('...a00000001', 10_000n, '2025-01-10')],
      strategy: 'fifo',
      clock,
    });
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]!.sourceType).toBe('credit_balance');
    expect(result.events[0]!.payload.sourceType).toBe('credit_balance');
    expect(result.unapplied).toEqual(kes(0n));
  });

  it('is a no-op with no receivables: no rows, no events, everything unapplied', () => {
    const result = executeAllocation({ source: source(1_000n), receivables: [], strategy: 'pro_rata', clock });
    expect(result.allocations).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.unapplied).toEqual(kes(1_000n));
  });

  it('continues sequenceNos monotonically per source after existing rows (docs/05)', () => {
    const first = executeAllocation({ source: source(500n), receivables: [RECEIVABLES[0]!], strategy: 'fifo', clock });
    const second = executeAllocation({
      source: source(400n),
      receivables: [RECEIVABLES[1]!],
      strategy: 'fifo',
      clock,
      existingAllocations: first.allocations,
    });
    expect(second.allocations.map((a) => a.sequenceNo)).toEqual([2n]);
  });

  it('is idempotent on replay: identical inputs → identical rows, ids and sequenceNos', () => {
    const args = {
      source: source(12_345n),
      receivables: RECEIVABLES,
      strategy: 'pro_rata' as const,
      clock,
      existingAllocations: [
        {
          id: uid('...e0000001'),
          sourceType: 'payment' as const,
          sourceId: uid('...p0000001'),
          receivableId: uid('...z0000001'),
          amountMinor: kes(1_000n),
          strategy: 'fifo' as const,
          sequenceNo: 5n,
          allocatedAt: clock.now(),
          reversedAt: null,
          reversalOf: null,
        },
      ],
    };
    const run1: AllocationExecution = executeAllocation(args);
    const run2: AllocationExecution = executeAllocation(args);
    expect(run1.allocations).toEqual(run2.allocations);
    expect(run1.events).toEqual(run2.events);
    expect(run1.allocations.map((a) => a.sequenceNo)).toEqual([6n, 7n, 8n]);
  });
});

describe('reverseAllocation (R3 compensating pattern)', () => {
  const execution = () =>
    executeAllocation({
      source: source(500n),
      receivables: [recv('...a00000001', 300n, '2025-01-01'), recv('...b00000001', 400n, '2025-02-01')],
      strategy: 'fifo',
      clock,
    });

  it('appends a compensating row, stamps reversedAt on the original, and emits E25', () => {
    const { allocations } = execution();
    const original = allocations[0]!; // 300 to a
    const reversal = reverseAllocation(original, 'payer dispute — wrong account', clock);

    expect(reversal.original).toEqual({ ...original, reversedAt: clock.now() });
    expect(reversal.compensating).toEqual({
      id: reversal.compensating.id,
      sourceType: 'payment',
      sourceId: original.sourceId,
      receivableId: original.receivableId,
      amountMinor: kes(300n),
      strategy: 'fifo',
      sequenceNo: 1n,
      allocatedAt: clock.now(),
      reversedAt: null,
      reversalOf: original.id,
    });
    expect(reversal.events).toEqual([
      {
        name: 'allocation.reversed',
        version: 1,
        aggregateId: original.id,
        payload: {
          allocationId: original.id,
          reason: 'payer dispute — wrong account',
          compensatingId: reversal.compensating.id,
        },
        occurredAt: '2025-07-01T10:00:00.000Z',
      },
    ]);
  });

  it('rejects reversing an already reversed row', () => {
    const { allocations } = execution();
    const once = reverseAllocation(allocations[0]!, 'duplicate posting', clock);
    expectCode(() => reverseAllocation(once.original, 'again', clock), 'ALLOCATION_ALREADY_REVERSED');
  });

  it('requires a non-blank reason (R3 corrections carry a reason)', () => {
    const { allocations } = execution();
    expectCode(() => reverseAllocation(allocations[0]!, '   ', clock), 'REVERSAL_REASON_REQUIRED');
  });

  it('refuses to reverse a compensating row', () => {
    const { allocations } = execution();
    const once = reverseAllocation(allocations[0]!, 'duplicate posting', clock);
    expectCode(() => reverseAllocation(once.compensating, 'undo the undo', clock), 'ALLOCATION_REVERSAL_NOT_ALLOWED');
  });

  it('frees the funds: after reversal the source validates again and re-allocation continues the ledger', () => {
    const { allocations } = execution(); // a: 300 (seq 1), b: 200 (seq 2); unapplied 0
    const reversal = reverseAllocation(allocations[0]!, 'payer dispute — wrong account', clock);

    const ledger = [reversal.original, allocations[1]!, reversal.compensating];
    // active Σ = 200 ≤ 500 — the reversed 300 is allocatable again
    expect(() => validateAllocations(ledger, kes(500n))).not.toThrow();

    // balances: a is back to 300, b still owes 200
    const second = executeAllocation({
      source: source(500n),
      receivables: [recv('...a00000001', 300n, '2025-01-01'), recv('...b00000001', 200n, '2025-02-01')],
      strategy: 'fifo',
      clock,
      existingAllocations: ledger,
    });
    expect(second.allocations.map((a) => [a.sequenceNo, a.receivableId, a.amountMinor.amount])).toEqual([
      [3n, uid('...a00000001'), 300n],
      [4n, uid('...b00000001'), 200n],
    ]);
    expect(second.unapplied).toEqual(kes(0n));
  });

  it('places the compensating row at a caller-supplied ledger position', () => {
    const { allocations } = execution();
    const reversal = reverseAllocation(allocations[0]!, 'tip of ledger', clock, { sequenceNo: 9n });
    expect(reversal.compensating.sequenceNo).toBe(9n);
  });
});

describe('R1 balance-integrity chain across strategies (cent conservation)', () => {
  const strategies = ['fifo', 'explicit', 'pro_rata'] as const;
  /** Outstanding balances (receivables are fresh, so balance === original). */
  const originalBalances: ReadonlyMap<Uuid, bigint> = new Map([
    [uid('...a00000001'), 10_000n],
    [uid('...b00000001'), 5_000n],
    [uid('...c00000001'), 7_000n],
  ]);

  it.each(strategies)('never loses or invents a cent under %s', (strategy) => {
    const payment = 12_345n;
    const originals = [...originalBalances.values()].reduce((sum, minor) => sum + minor, 0n); // 22_000

    const result = executeAllocation({
      source: source(payment),
      receivables: RECEIVABLES,
      strategy,
      clock,
      declared:
        strategy === 'explicit'
          ? new Map([
              [uid('...a00000001'), kes(10_000n)],
              [uid('...b00000001'), kes(2_000n)],
            ])
          : undefined,
    });

    // R2 — Σ allocations + unapplied === payment, exactly.
    const allocated = result.allocations.reduce((sum, a) => sum + a.amountMinor.amount, 0n);
    expect(allocated + result.unapplied.amount).toBe(payment);

    // R1 — per receivable: balance never negative; Σ(after) + unapplied === Σ(original).
    let after = 0n;
    for (const [receivableId, balanceMinor] of originalBalances) {
      const remaining = result.allocations
        .filter((a) => a.receivableId === receivableId)
        .reduce((sum, a) => sum + a.amountMinor.amount, 0n);
      expect(remaining).toBeLessThanOrEqual(balanceMinor);
      after += balanceMinor - remaining;
    }
    // R1 chain: Σ balances after + Σ allocated === Σ balances before (no cent invented or destroyed).
    expect(after + allocated).toBe(originals);
  });
});
