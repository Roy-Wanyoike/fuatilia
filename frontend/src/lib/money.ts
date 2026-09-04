import type { Money } from '@/lib/api/envelope';

/**
 * Money rendering — integer minor units → human string. Float math is
 * banned from money (R10 / house rules): the conversion below is exact
 * integer/string arithmetic (BigInt quotient + remainder); Intl is used
 * ONLY for locale digit-grouping of the integer major part, never for the
 * minor fraction.
 *
 * Rendering style: currency CODE prefix, e.g. `KES 12,500.00` — unambiguous
 * across locales (the "KSh" symbol varies; the ISO code does not).
 */

const MINOR_PER_MAJOR = 100n;

function groupDigits(integerString: string, locale: string): string {
  // Fast path: safe-integer majors go through the locale-aware formatter
  // (exact — the value is an integer well inside 2^53).
  const asNumber = Number(integerString);
  if (integerString.length <= 15 && Number.isSafeInteger(asNumber)) {
    return new Intl.NumberFormat(locale, {
      useGrouping: true,
      maximumFractionDigits: 0,
    }).format(asNumber);
  }
  // Fallback: manual 3-3 grouping (locale-independent commas) — exact for
  // arbitrarily large amounts. Intl cannot accept numbers this large
  // without precision loss, and money never loses precision.
  return integerString.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatMoney(money: Money, locale = 'en'): string {
  const minor = BigInt(money.minor);
  const negative = minor < 0n; // Contract money is non-negative; defensive.
  const abs = negative ? -minor : minor;
  const major = abs / MINOR_PER_MAJOR;
  const cents = abs % MINOR_PER_MAJOR;

  const majorText = groupDigits(major.toString(), locale);
  const fraction = cents.toString().padStart(2, '0');
  return `${negative ? '-' : ''}${money.currency} ${majorText}.${fraction}`;
}

/**
 * Sum a homogeneous list of Money (same currency only). Cross-currency
 * arithmetic is forbidden (R10) — a mixed-currency list refuses to be
 * totaled: the caller gets `null` and must present count-only. The same
 * refusal covers sums beyond Number.MAX_SAFE_INTEGER: Number cannot carry
 * them exactly, and money never rounds silently — count-only beats an
 * inexact total.
 */
export function sumMoney(list: readonly Money[]): Money | null {
  if (list.length === 0) return null;
  const currency = list[0]?.currency;
  if (currency === undefined) return null;
  for (const item of list) {
    if (item.currency !== currency) return null;
  }
  let total = 0n;
  for (const item of list) {
    total += BigInt(item.minor);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { minor: Number(total), currency };
}
