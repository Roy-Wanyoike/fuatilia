import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import { Money } from './money';

describe('Money', () => {
  it('constructs from non-negative integer minor units', () => {
    expect(Money.ofMinor(1250, 'KES').amount).toBe(1250n);
    expect(Money.ofMinor(0n, 'KES').isZero()).toBe(true);
    expect(() => Money.ofMinor(-1, 'KES')).toThrow(DomainError);
    expect(() => Money.ofMinor(1.5, 'KES')).toThrow(DomainError);
  });

  it('parses decimal strings without float drift', () => {
    expect(Money.parse('1250.50', 'KES').amount).toBe(125050n);
    expect(Money.parse('0.99', 'KES').amount).toBe(99n);
    expect(Money.parse('42', 'KES').amount).toBe(4200n);
  });

  it('refuses cross-currency arithmetic', () => {
    expect(() => Money.ofMinor(100, 'KES').add(Money.ofMinor(100, 'USD'))).toThrow(
      DomainError,
    );
  });

  it('throws UNDERFLOW instead of going negative', () => {
    expect(() => Money.ofMinor(50, 'KES').subtract(Money.ofMinor(51, 'KES'))).toThrow(
      DomainError,
    );
    expect(Money.ofMinor(51, 'KES').subtract(Money.ofMinor(50, 'KES')).amount).toBe(1n);
  });

  it('allocates with largest remainder so no cent is lost', () => {
    const parts = Money.ofMinor(100, 'KES').allocate([1, 1, 1]);
    expect(parts.map((p) => p.amount)).toEqual([34n, 33n, 33n]);
  });

  it('allocation always sums back to the total (awkward weights too)', () => {
    const total = Money.ofMinor(999, 'KES');
    const parts = total.allocate([1, 2, 4]);
    const sum = parts.reduce((acc, p) => acc.add(p), Money.zero('KES'));
    expect(sum.equals(total)).toBe(true);
  });

  it('allocation is deterministic and never negative', () => {
    const a = Money.ofMinor(7, 'KES').allocate([0.3, 0.3, 0.4]);
    const b = Money.ofMinor(7, 'KES').allocate([0.3, 0.3, 0.4]);
    expect(a.map((p) => p.amount)).toEqual(b.map((p) => p.amount));
    expect(a.every((p) => !p.amount.toString().startsWith('-'))).toBe(true);
  });

  it('rejects empty and zero-sum allocations', () => {
    expect(() => Money.ofMinor(10, 'KES').allocate([])).toThrow(DomainError);
    expect(() => Money.ofMinor(10, 'KES').allocate([0, 0])).toThrow(DomainError);
  });
});
