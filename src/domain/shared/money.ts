/**
 * Money — value object in integer minor units (bigint).
 *
 * Rules (docs/07-invariants.md R10):
 *  - Floats are BANNED from ledger math. Everything is minor units (cents).
 *  - Money is non-negative: postings carry a direction (debit/credit) in the
 *    ledger module; a negative Money is always a modelling bug, so we throw.
 *  - Cross-currency arithmetic is forbidden. Allocation only splits, never
 *    converts (FX postings are a wave-2 concern, issue #9).
 */
import { DomainError } from './errors';

export const CURRENCIES = ['KES', 'USD', 'GBP', 'EUR', 'TZS', 'UGX'] as const;
export type Currency = (typeof CURRENCIES)[number];

export type MoneyInput = bigint | number;

const toMinor = (amount: MoneyInput): bigint => {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
      throw new DomainError('MONEY_NOT_INTEGER', `minor units must be an integer, got ${amount}`);
    }
    return BigInt(amount);
  }
  return amount;
};

export class Money {
  private constructor(
    readonly amount: bigint,
    readonly currency: Currency,
  ) {}

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  static ofMinor(amount: MoneyInput, currency: Currency): Money {
    const minor = toMinor(amount);
    if (minor < 0n) {
      throw new DomainError('MONEY_NEGATIVE', `money cannot be negative, got ${minor}`);
    }
    return new Money(minor, currency);
  }

  /** Parse a human/decimal string like "1250.50" into Money (safe from float drift). */
  static parse(text: string, currency: Currency): Money {
    const m = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(text.trim());
    if (!m) throw new DomainError('MONEY_UNPARSEABLE', `cannot parse money: ${text}`);
    const whole = BigInt(m[1]!);
    const frac = (m[2] ?? '').padEnd(2, '0');
    const cents = frac === '' ? 0n : BigInt(frac === '00' ? '0' : frac);
    return new Money(whole * 100n + cents, currency);
  }

  private assertSame(other: Money, op: string): void {
    if (this.currency !== other.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `cannot ${op} ${this.currency} with ${other.currency}`,
      );
    }
  }

  add(other: Money): Money {
    this.assertSame(other, 'add');
    return new Money(this.amount + other.amount, this.currency);
  }

  /** Throws UNDERFLOW instead of returning a negative Money. */
  subtract(other: Money): Money {
    this.assertSame(other, 'subtract');
    if (other.amount > this.amount) {
      throw new DomainError('UNDERFLOW', `${other.amount} exceeds available ${this.amount}`);
    }
    return new Money(this.amount - other.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0n;
  }

  isPositive(): boolean {
    return this.amount > 0n;
  }

  compareTo(other: Money): -1 | 0 | 1 {
    this.assertSame(other, 'compare');
    return this.amount === other.amount ? 0 : this.amount > other.amount ? 1 : -1;
  }

  equals(other: Money): boolean {
    return this.compareTo(other) === 0;
  }

  /**
   * Split this amount across weights using the largest-remainder method.
   * Guarantees (docs/07-invariants.md R1/R2 depend on this):
   *   1. sum(parts) === this.amount  (no cent is created or destroyed)
   *   2. every part >= 0
   *   3. deterministic given identical inputs
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0) {
      throw new DomainError('ALLOCATION_EMPTY', 'at least one weight is required');
    }
    if (weights.some((w) => !Number.isFinite(w) || w < 0)) {
      throw new DomainError('ALLOCATION_WEIGHT_INVALID', 'weights must be finite and >= 0');
    }
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      throw new DomainError('ALLOCATION_WEIGHTS_SUM_ZERO', 'sum of weights must be > 0');
    }
    const sumW = BigInt(Math.round(total * 1e9));
    const raw: { index: number; base: bigint; rem: bigint }[] = weights.map((w, index) => {
      const scaled = BigInt(Math.round(w * 1e9));
      const base = (this.amount * scaled) / sumW;
      const rem = (this.amount * scaled) % sumW;
      return { index, base, rem };
    });
    let distributed = raw.reduce((acc, r) => acc + r.base, 0n);
    const leftover = this.amount - distributed;
    const order = [...raw].sort((a, b) =>
      b.rem === a.rem ? a.index - b.index : b.rem > a.rem ? 1 : -1,
    );
    const bumped = new Set<number>();
    for (let i = 0n; i < leftover; i += 1n) {
      const slot = order[Number(i)];
      if (slot) bumped.add(slot.index);
    }
    distributed = 0n;
    return raw.map((r) => {
      const amt = bumped.has(r.index) ? r.base + 1n : r.base;
      distributed += amt;
      return new Money(amt, this.currency);
    });
  }

  toString(): string {
    const whole = this.amount / 100n;
    const cents = this.amount % 100n;
    return `${whole}.${cents.toString().padStart(2, '0')} ${this.currency}`;
  }
}
