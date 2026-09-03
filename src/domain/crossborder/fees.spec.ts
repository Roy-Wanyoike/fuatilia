import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import {
  MAX_FEE_BPS,
  computeFeeBreakdown,
  divideBankers,
  feeSchedulesEqual,
  validateFeeSchedule,
  type FeeBreakdown,
} from './fees';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- schedule validation ------------------------------------------------------

describe('validateFeeSchedule', () => {
  it('resolves defaults (both components missing = a free corridor is legal)', () => {
    expect(validateFeeSchedule({})).toEqual({ flatMinor: 0n, bps: 0 });
  });

  it('canonicalizes number inputs to bigint minor units', () => {
    expect(validateFeeSchedule({ flatMinor: 250, bps: 75 })).toEqual({ flatMinor: 250n, bps: 75 });
  });

  it('rejects malformed schedules (stable FEE_SCHEDULE_INVALID)', () => {
    const table: readonly [Record<string, unknown>, string][] = [
      [{ flatMinor: -1n }, 'flatMinor negative bigint'],
      [{ flatMinor: -250 }, 'flatMinor negative number'],
      [{ flatMinor: 1.5 }, 'flatMinor fractional'],
      [{ bps: -1 }, 'bps negative'],
      [{ bps: 1.5 }, 'bps fractional'],
      [{ bps: MAX_FEE_BPS + 1 }, 'bps above 100%'],
    ];
    for (const [schedule, why] of table) {
      expectCode(() => validateFeeSchedule(schedule), 'FEE_SCHEDULE_INVALID');
      void why;
    }
  });

  it('accepts the boundary schedules: zero fee and a full-amount fee (MAX_FEE_BPS)', () => {
    expect(validateFeeSchedule({ flatMinor: 0n, bps: 0 })).toEqual({ flatMinor: 0n, bps: 0 });
    expect(validateFeeSchedule({ bps: MAX_FEE_BPS })).toEqual({ flatMinor: 0n, bps: 10_000 });
  });
});

// --- banker's rounding ----------------------------------------------------------

describe('divideBankers', () => {
  it('rounds exact halves to the EVEN neighbour (no drift, deterministic)', () => {
    const table: readonly [bigint, bigint, bigint][] = [
      [5n, 2n, 2n], // 2.5 → 2 (even down)
      [7n, 2n, 4n], // 3.5 → 4 (even up)
      [1n, 2n, 0n], // 0.5 → 0
      [3n, 2n, 2n], // 1.5 → 2
      [25_000n, 10_000n, 2n], // 2.5
      [75_000n, 10_000n, 8n], // 7.5 → 8
      [10_000n, 10_000n, 1n], // exact — no rounding at all
      [10_001n, 10_000n, 1n], // 1.0001 → 1
    ];
    for (const [p, q, expected] of table) {
      expect(divideBankers(p, q)).toBe(expected);
    }
  });
});

// --- fee breakdown ----------------------------------------------------------------

describe('computeFeeBreakdown', () => {
  it('computes flat-only fees exactly', () => {
    const fee = computeFeeBreakdown({ flatMinor: 500n, bps: 0 }, 123_456n);
    expect(fee).toMatchObject({ amountMinor: 123_456n, flatMinor: 500n, bpsMinor: 0n, totalMinor: 500n });
  });

  it('computes bps-only fees with ONE banker’s rounding (rounding-edge table)', () => {
    const schedule = validateFeeSchedule({ bps: 1 });
    const table: readonly [bigint, bigint][] = [
      [25_000n, 2n], // 2.5 → 2 (even)
      [75_000n, 8n], // 7.5 → 8 (even up)
      [5_000n, 0n], // 0.5 → 0 (even)
      [15_000n, 2n], // 1.5 → 2
      [1n, 0n], // 0.0001 → 0
      [9_999_999n, 1000n], // 999.9999 → 1000
    ];
    for (const [amountMinor, expected] of table) {
      expect(computeFeeBreakdown(schedule, amountMinor).bpsMinor).toBe(expected);
    }
  });

  it('breakdown components sum EXACTLY to the total fee — no cent created or destroyed', () => {
    const amounts: readonly bigint[] = [
      1n, 4_999n, 5_000n, 5_001n, 12_500n, 37_500n, 100_000n, 123_457n, 9_999_999n, 1_000_000_000n,
    ];
    const schedules = [
      validateFeeSchedule({ flatMinor: 50n, bps: 150 }),
      validateFeeSchedule({ bps: 1 }),
      validateFeeSchedule({ bps: 333 }),
      validateFeeSchedule({ flatMinor: 0n, bps: 9_999 }),
      validateFeeSchedule({ flatMinor: 2_500n, bps: 0 }),
      validateFeeSchedule({}),
    ];
    for (const schedule of schedules) {
      for (const amount of amounts) {
        const fee: FeeBreakdown = computeFeeBreakdown(schedule, amount);
        expect(fee.flatMinor + fee.bpsMinor).toBe(fee.totalMinor);
        expect(fee.bpsMinor).toBe(divideBankers(amount * BigInt(schedule.bps), 10_000n));
      }
    }
  });

  it('combines flat + bps deterministically (same inputs → identical breakdown)', () => {
    const schedule = validateFeeSchedule({ flatMinor: 50n, bps: 150 });
    const a = computeFeeBreakdown(schedule, 1_000_000n); // bps 150 → exactly 15_000
    const b = computeFeeBreakdown(schedule, 1_000_000n);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      amountMinor: 1_000_000n,
      flatMinor: 50n,
      bpsMinor: 15_000n,
      totalMinor: 15_050n,
      bps: 150,
    });
  });

  it('accepts number or bigint amounts interchangeably and refuses floats/negatives', () => {
    const schedule = validateFeeSchedule({ flatMinor: 50n, bps: 150 });
    expect(computeFeeBreakdown(schedule, 1_000_000).totalMinor).toBe(
      computeFeeBreakdown(schedule, 1_000_000n).totalMinor,
    );
    expectCode(() => computeFeeBreakdown(schedule, 10.5), 'MONEY_NOT_INTEGER');
    expectCode(() => computeFeeBreakdown(schedule, -1n), 'MONEY_NEGATIVE');
    expectCode(() => computeFeeBreakdown(schedule, -5), 'MONEY_NEGATIVE');
  });

  it('charges the flat component even on a zero amount; a free schedule stays free', () => {
    const fee = computeFeeBreakdown(validateFeeSchedule({ flatMinor: 50n, bps: 150 }), 0n);
    expect(fee.totalMinor).toBe(50n); // flat applies; bps on 0 is 0
    expect(fee.bpsMinor).toBe(0n);
    const free = computeFeeBreakdown(validateFeeSchedule({}), 100_000n);
    expect(free.totalMinor).toBe(0n);
  });

  it('returns frozen, immutable breakdowns', () => {
    const fee = computeFeeBreakdown(validateFeeSchedule({ flatMinor: 50n, bps: 150 }), 100_000n);
    expect(Object.isFrozen(fee)).toBe(true);
  });
});

describe('feeSchedulesEqual', () => {
  it('compares resolved schedules structurally (fee-freeze comparisons)', () => {
    const a = validateFeeSchedule({ flatMinor: 50n, bps: 150 });
    expect(feeSchedulesEqual(a, validateFeeSchedule({ flatMinor: 50, bps: 150 }))).toBe(true);
    expect(feeSchedulesEqual(a, validateFeeSchedule({ flatMinor: 51n, bps: 150 }))).toBe(false);
    expect(feeSchedulesEqual(a, validateFeeSchedule({ flatMinor: 50n, bps: 151 }))).toBe(false);
  });
});
