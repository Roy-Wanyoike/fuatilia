/**
 * Fee schedules — deterministic corridor fee computation (issue #48, SPEC §33
 * cross-border deferral, R1/R2 no-cent-created-or-destroyed).
 *
 * A corridor fee schedule has exactly two components, both expressed in the
 * corridor's SOURCE currency minor units (fees are charged on top of the
 * source amount — the recipient always receives the full converted amount):
 *
 *   flat  — a fixed minor-unit amount per transfer;
 *   bps   — basis points of the source amount (150 bps = 1.5 %).
 *
 * Rules this module guarantees:
 *  - Money is `bigint` minor units. Floats are BANNED from fee math (same
 *    discipline as shared/money.ts and shared/fx.ts).
 *  - The bps component is rounded with ONE banker's rounding (half-to-even)
 *    — the only rounding point in fee computation. The flat component is an
 *    exact integer and the total is an exact sum, so the breakdown is
 *    penny-perfect by construction:
 *
 *        flatMinor + bpsMinor === totalMinor      (no cent created or destroyed)
 *
 *  - Everything is a pure function: no I/O, no RNG, no Date.now(). Breakdowns
 *    are frozen, immutable records.
 *  - Errors are DomainError with stable SCREAMING_SNAKE codes.
 */
import { DomainError } from '../shared';

/** 10000 bps === 100 % — a fee can never exceed the amount it is computed on. */
export const MAX_FEE_BPS = 10_000;

/** Caller-supplied schedule; both components optional (a free corridor is legal). */
export interface FeeScheduleInput {
  readonly flatMinor?: bigint | number;
  readonly bps?: number;
}

/** Resolved, canonical schedule (bigint minor units, validated bps range). */
export interface FeeSchedule {
  readonly flatMinor: bigint;
  readonly bps: number;
}

/**
 * Validate a fee schedule (stable codes):
 *   FEE_SCHEDULE_INVALID — flatMinor negative / non-integer, or bps negative /
 *   non-integer / above MAX_FEE_BPS.
 */
export function validateFeeSchedule(input: FeeScheduleInput): FeeSchedule {
  let flatMinor = 0n;
  if (input.flatMinor !== undefined) {
    const raw = input.flatMinor;
    if (typeof raw === 'number') {
      if (!Number.isSafeInteger(raw) || raw < 0) {
        throw new DomainError(
          'FEE_SCHEDULE_INVALID',
          `fee flatMinor must be a non-negative safe integer, got ${String(raw)}`,
          { field: 'flatMinor', value: String(raw) },
        );
      }
      flatMinor = BigInt(raw);
    } else {
      if (raw < 0n) {
        throw new DomainError(
          'FEE_SCHEDULE_INVALID',
          `fee flatMinor must be non-negative, got ${raw}`,
          { field: 'flatMinor', value: raw.toString() },
        );
      }
      flatMinor = raw;
    }
  }
  let bps = 0;
  if (input.bps !== undefined) {
    const raw = input.bps;
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > MAX_FEE_BPS) {
      throw new DomainError(
        'FEE_SCHEDULE_INVALID',
        `fee bps must be an integer in [0, ${MAX_FEE_BPS}], got ${String(raw)}`,
        { field: 'bps', value: String(raw) },
      );
    }
    bps = raw;
  }
  return { flatMinor, bps };
}

/**
 * Round the exact non-negative rational p/q to the nearest integer with
 * banker's rounding (exact halves go to the even neighbour). This helper is
 * the ONLY rounding in fee computation, and the conversion in quote.ts uses
 * it as the ONLY rounding in cross-currency conversion — one rounding point
 * per pipeline, never more (R10 discipline, mirrors shared/fx.ts semantics;
 * lanes never import lanes, so the semantics are re-declared here).
 */
export function divideBankers(p: bigint, q: bigint): bigint {
  const whole = p / q;
  const remainder = p % q;
  const twice = remainder * 2n;
  if (twice > q) return whole + 1n;
  if (twice < q) return whole;
  return whole % 2n === 0n ? whole : whole + 1n;
}

/** Minor units in, bigint out — floats and negatives are modelling bugs. */
export function toMinorUnits(value: bigint | number, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DomainError(
        'MONEY_NOT_INTEGER',
        `${field} must be an integer minor unit, got ${String(value)}`,
        { field, value: String(value) },
      );
    }
    const v = BigInt(value);
    if (v < 0n) {
      throw new DomainError('MONEY_NEGATIVE', `${field} cannot be negative, got ${value}`, {
        field,
        value: String(value),
      });
    }
    return v;
  }
  if (value < 0n) {
    throw new DomainError('MONEY_NEGATIVE', `${field} cannot be negative, got ${value}`, {
      field,
      value: value.toString(),
    });
  }
  return value;
}

/**
 * The frozen fee breakdown for one source amount. `totalMinor` is an exact
 * sum of the components — the no-cent-created-or-destroyed pin asserts this
 * identity on every breakdown the lane ever produces.
 */
export interface FeeBreakdown {
  /** The source amount the fee was computed on. */
  readonly amountMinor: bigint;
  readonly flatMinor: bigint;
  /** bps × amount / 10000 — ONE banker's rounding. */
  readonly bpsMinor: bigint;
  /** flatMinor + bpsMinor — exact, never re-rounded. */
  readonly totalMinor: bigint;
  readonly bps: number;
}

/**
 * Compute the fee breakdown for a source amount: flat + bps with banker's
 * rounding at exactly ONE point (the bps component). Deterministic: identical
 * inputs always produce identical breakdowns.
 */
export function computeFeeBreakdown(schedule: FeeSchedule, amountMinor: bigint | number): FeeBreakdown {
  const amount = toMinorUnits(amountMinor, 'amountMinor');
  const bpsMinor = divideBankers(amount * BigInt(schedule.bps), 10_000n);
  return Object.freeze({
    amountMinor: amount,
    flatMinor: schedule.flatMinor,
    bpsMinor,
    totalMinor: schedule.flatMinor + bpsMinor,
    bps: schedule.bps,
  });
}

/** Structural equality of two resolved schedules (fee-freeze comparisons). */
export function feeSchedulesEqual(a: FeeSchedule, b: FeeSchedule): boolean {
  return a.flatMinor === b.flatMinor && a.bps === b.bps;
}
