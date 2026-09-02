import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Uuid } from '../shared';
import type { AllocatableReceivable } from './allocation';
import { allocateExplicit, allocateOldestFirst, allocateProRata } from './strategies';

const clockNow = new Date('2025-07-01T10:00:00.000Z');
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const recv = (tail: string, balanceMinor: bigint | number | Money, due?: string): AllocatableReceivable => ({
  receivableId: uid(tail),
  currency: 'KES',
  balanceMinor: balanceMinor instanceof Money ? balanceMinor : BigInt(balanceMinor),
  ...(due ? { dueDate: new Date(due) } : {}),
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

/** KES money helper. */
const kes = (minor: bigint): Money => Money.ofMinor(minor, 'KES');

describe('allocateOldestFirst (fifo — H3 default)', () => {
  it('settles the oldest receivable fully, then partially, cent-exact with leftover unapplied', () => {
    const plans = allocateOldestFirst(kes(12_000n), [
      recv('...b00000001', 5_000n, '2025-02-01'),
      recv('...a00000001', 10_000n, '2025-01-10'),
      recv('...c00000001', 7_000n, '2025-01-15'),
    ]);
    expect(plans).toEqual([
      { receivableId: uid('...a00000001'), amount: kes(10_000n) },
      { receivableId: uid('...c00000001'), amount: kes(2_000n) },
    ]);
    expect(plans.reduce((s, p) => s + p.amount.amount, 0n)).toBe(12_000n); // sum === payment
  });

  it('breaks dueDate ties by receivableId', () => {
    const plans = allocateOldestFirst(kes(300n), [
      recv('...b00000002', 300n, '2025-01-10'),
      recv('...a00000002', 300n, '2025-01-10'),
    ]);
    expect(plans.map((p) => p.receivableId)).toEqual([uid('...a00000002')]);
  });

  it('sorts undated receivables last', () => {
    const plans = allocateOldestFirst(kes(350n), [
      recv('...a00000003', 100n), // no dueDate
      recv('...b00000003', 100n, '2025-03-01'),
    ]);
    expect(plans).toEqual([
      { receivableId: uid('...b00000003'), amount: kes(100n) },
      { receivableId: uid('...a00000003'), amount: kes(100n) },
    ]);
  });

  it('never allocates more than a receivable balance (payment exceeds total debt)', () => {
    const plans = allocateOldestFirst(kes(1_000n), [recv('...a00000004', 300n), recv('...b00000004', 200n)]);
    expect(plans).toEqual([
      { receivableId: uid('...a00000004'), amount: kes(300n) },
      { receivableId: uid('...b00000004'), amount: kes(200n) },
    ]); // 500 allocated, 500 stays unapplied
  });

  it('skips zero-balance receivables (rows must carry amount > 0)', () => {
    const plans = allocateOldestFirst(kes(1_000n), [recv('...a00000005', 0n), recv('...b00000005', 4_000n)]);
    expect(plans).toEqual([{ receivableId: uid('...b00000005'), amount: kes(1_000n) }]); // capped by funds
  });

  it('throws CURRENCY_MISMATCH on a foreign-currency receivable (R10)', () => {
    expectCode(() =>
      allocateOldestFirst(kes(1_000n), [
        { receivableId: uid('...a00000006'), currency: 'USD', balanceMinor: 100n },
      ]),
    'CURRENCY_MISMATCH');
  });

  it('throws ALLOCATION_DUPLICATE_RECEIVABLE when one receivable appears twice', () => {
    expectCode(
      () => allocateOldestFirst(kes(1_000n), [recv('...a00000007', 300n), recv('...a00000007', 300n)]),
      'ALLOCATION_DUPLICATE_RECEIVABLE',
    );
  });
});

describe('allocateExplicit', () => {
  const receivables = [
    recv('...a00000010', 10_000n, '2025-01-10'),
    recv('...b00000010', 5_000n, '2025-02-01'),
  ];

  it('applies the declared split exactly (canonical id order); leftover stays unapplied', () => {
    const plans = allocateExplicit(kes(12_000n), receivables, new Map([
      [uid('...b00000010'), kes(5_000n)],
      [uid('...a00000010'), kes(3_000n)],
    ]));
    expect(plans).toEqual([
      { receivableId: uid('...a00000010'), amount: kes(3_000n) },
      { receivableId: uid('...b00000010'), amount: kes(5_000n) },
    ]); // 4_000 left unapplied
  });

  it('rejects unknown receivable ids', () => {
    expectCode(
      () => allocateExplicit(kes(1_000n), receivables, new Map([[uid('...f00000010'), kes(100n)]])),
      'ALLOCATION_UNKNOWN_RECEIVABLE',
    );
  });

  it('rejects over-declaration against the payment (R2)', () => {
    expectCode(
      () =>
        allocateExplicit(kes(12_000n), receivables, new Map([
          [uid('...a00000010'), kes(10_000n)],
          [uid('...b00000010'), kes(5_000n)],
        ])),
      'ALLOCATION_EXCEEDS_AVAILABLE',
    );
  });

  it('rejects a declaration above the receivable outstanding balance', () => {
    expectCode(
      () => allocateExplicit(kes(12_000n), receivables, new Map([[uid('...a00000010'), kes(10_001n)]])),
      'ALLOCATION_EXCEEDS_BALANCE',
    );
  });

  it('rejects declarations in a foreign currency (R10)', () => {
    expectCode(
      () =>
        allocateExplicit(kes(1_000n), receivables, new Map([
          [uid('...a00000010'), Money.ofMinor(100n, 'USD')],
        ])),
      'CURRENCY_MISMATCH',
    );
  });

  it('silently drops zero declarations (no row can carry 0)', () => {
    const plans = allocateExplicit(kes(1_000n), receivables, new Map([[uid('...b00000010'), kes(0n)]]));
    expect(plans).toEqual([]);
  });
});

describe('allocateProRata (largest remainder on Money.allocate)', () => {
  it('is cent-exact with deterministic remainder bumping (1000 over [500,300,300] → [454,273,273])', () => {
    const plans = allocateProRata(kes(1_000n), [
      recv('...c00000020', 300n),
      recv('...a00000020', 500n),
      recv('...b00000020', 300n),
    ]);
    expect(plans).toEqual([
      { receivableId: uid('...a00000020'), amount: kes(454n) },
      { receivableId: uid('...b00000020'), amount: kes(273n) },
      { receivableId: uid('...c00000020'), amount: kes(273n) },
    ]);
    expect(plans.reduce((s, p) => s + p.amount.amount, 0n)).toBe(1_000n);
  });

  it('pins the remainder to canonical order (999 over [500,500] → [500,499])', () => {
    const plans = allocateProRata(kes(999n), [recv('...b00000021', 500n), recv('...a00000021', 500n)]);
    expect(plans).toEqual([
      { receivableId: uid('...a00000021'), amount: kes(500n) },
      { receivableId: uid('...b00000021'), amount: kes(499n) },
    ]);
  });

  it('skips zero-balance receivables (no weight, no row)', () => {
    const plans = allocateProRata(kes(1_000n), [
      recv('...a00000022', 0n),
      recv('...b00000022', 600n),
      recv('...c00000022', 400n),
    ]);
    expect(plans.map((p) => p.receivableId)).toEqual([uid('...b00000022'), uid('...c00000022')]);
  });

  it('returns an empty plan when every balance is zero', () => {
    expect(allocateProRata(kes(1_000n), [recv('...a00000023', 0n)])).toEqual([]);
  });

  it('caps at balances when funds exceed total debt; surplus stays unapplied', () => {
    const plans = allocateProRata(kes(1_000n), [recv('...a00000024', 300n), recv('...b00000024', 200n)]);
    expect(plans).toEqual([
      { receivableId: uid('...a00000024'), amount: kes(300n) },
      { receivableId: uid('...b00000024'), amount: kes(200n) },
    ]);
  });

  it('is deterministic and order-insensitive (replay-safe)', () => {
    const set = [recv('...c00000025', 7_000n), recv('...a00000025', 10_000n), recv('...b00000025', 5_000n)];
    const shuffled = [set[1]!, set[2]!, set[0]!];
    expect(allocateProRata(kes(12_345n), shuffled)).toEqual(allocateProRata(kes(12_345n), set));
  });

  it('never allocates more than a receivable balance across odd remainders', () => {
    const plans = allocateProRata(kes(12_345n), [
      recv('...a00000026', 10_000n),
      recv('...b00000026', 5_000n),
      recv('...c00000026', 7_000n),
    ]);
    const balances = new Map([
      [uid('...a00000026'), 10_000n],
      [uid('...b00000026'), 5_000n],
      [uid('...c00000026'), 7_000n],
    ]);
    for (const plan of plans) {
      expect(plan.amount.isPositive()).toBe(true);
      expect(plan.amount.amount).toBeLessThanOrEqual(balances.get(plan.receivableId)!);
    }
    expect(plans.reduce((s, p) => s + p.amount.amount, 0n)).toBe(12_345n); // cent-exact
  });

  it('throws CURRENCY_MISMATCH on a foreign-currency receivable (R10)', () => {
    expectCode(
      () =>
        allocateProRata(kes(1_000n), [
          { receivableId: uid('...a00000027'), currency: 'GBP', balanceMinor: 5n },
        ]),
      'CURRENCY_MISMATCH',
    );
  });
});
