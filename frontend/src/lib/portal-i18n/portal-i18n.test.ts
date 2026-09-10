import { describe, expect, it } from 'vitest';
import { flattenDictionary, type Dictionary } from '@/lib/portal-i18n/dictionary';
import { en } from '@/lib/portal-i18n/en';
import { sw } from '@/lib/portal-i18n/sw';
import {
  isPortalLocale,
  parsePortalLocaleCookie,
  portalLocaleCookieAssignment,
  portalLocaleFromValue,
  PORTAL_LOCALE_COOKIE,
  PORTAL_LOCALES,
} from '@/lib/portal-i18n/cookie';
import { MissingPortalStringError, translate } from '@/lib/portal-i18n/t';

/** Test tooling: raw leaf read (no interpolation) for raw-value assertions. */
function catalogLeaf(dictionary: Dictionary, path: string): string {
  let node: unknown = dictionary;
  for (const segment of path.split('.')) {
    node = (node as Record<string, unknown>)[segment];
  }
  return node as string;
}

// =============================================================================
// PORTAL I18N (issue #149): the en catalog is the source of truth for keys;
// sw must be COMPLETE (en ≡ sw key parity); a missing key must be a tsc
// error at the call site AND a loud runtime refusal — never a silent blank.
// =============================================================================

describe('catalog parity (en ≡ sw)', () => {
  it('sw carries exactly the same key set as en — no gaps, no extras', () => {
    const enKeys = flattenDictionary(en).sort();
    const swKeys = flattenDictionary(sw).sort();
    expect(swKeys).toEqual(enKeys);
    expect(new Set(swKeys).size).toBe(swKeys.length); // no duplicated paths
  });

  it('every sw leaf is a non-empty string — no lazy placeholders', () => {
    for (const key of flattenDictionary(sw)) {
      expect(catalogLeaf(sw, key).length).toBeGreaterThan(0);
    }
  });

  it('every sw value that en interpolates interpolates too (same {vars})', () => {
    for (const key of flattenDictionary(en)) {
      const enVars = [...catalogLeaf(en, key).matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)]
        .map((m) => m[1])
        .sort();
      const swVars = [...catalogLeaf(sw, key).matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)]
        .map((m) => m[1])
        .sort();
      expect(swVars).toEqual(enVars);
    }
  });
});

describe('missing-key refusal (tsc level — the documented pattern)', () => {
  it('a key absent from the catalog is a TYPE error; these lines must not compile if the safety breaks', () => {
    // `translate(en, 'gate.doesNotExist')` is rejected by tsc because the
    // key parameter is the derived LocaleKey union. `@ts-expect-error`
    // makes THE PATTERN ITSELF load-bearing: if key derivation ever stops
    // catching unknown keys, this file fails `npm run typecheck`.
    expect(() =>
      // @ts-expect-error — unknown keys must be a tsc error at the call site
      translate(en, 'gate.doesNotExist' as string),
    ).toThrow(MissingPortalStringError);

    expect(() =>
      // @ts-expect-error — typo'd keys must be a tsc error at the call site
      translate(en, 'balence.title' as string),
    ).toThrow(MissingPortalStringError);

    expect(() =>
      // @ts-expect-error — a mid-path (non-leaf) key must be refused too
      translate(en, 'balance.cards' as string),
    ).toThrow(MissingPortalStringError);
  });

  it('key derivation reaches every leaf — sample keys from each view resolve', () => {
    expect(typeof translate(en, 'gate.title')).toBe('string');
    expect(typeof translate(en, 'shell.nav.balance')).toBe('string');
    expect(typeof translate(en, 'balance.cards.heldOnAccount.caption')).toBe('string');
    expect(translate(en, 'invoices.pageOf', { page: 1, pages: 1 })).toBe('page 1 of ≤ 1');
    expect(typeof translate(en, 'statement.kinds.confirmation')).toBe('string');
    expect(typeof translate(en, 'states.partially_paid')).toBe('string');
    expect(typeof translate(en, 'common.returnToGate')).toBe('string');
    expect(typeof translate(en, 'language.kiswahili')).toBe('string');
  });
});

describe('interpolation', () => {
  it('fills {vars} with strings and numbers', () => {
    expect(translate(en, 'invoices.pageOf', { page: 2, pages: 3 })).toBe('page 2 of ≤ 3');
    expect(translate(en, 'balance.cardUnavailable', { card: 'Overdue' })).toBe(
      'Overdue is unavailable',
    );
    expect(translate(en, 'invoices.daysPastDue', { days: 126 })).toBe('126 days past due');
  });

  it('refuses a template whose variable was not supplied', () => {
    expect(() => translate(en, 'invoices.pageOf')).toThrow(MissingPortalStringError);
    expect(() => translate(en, 'invoices.pageOf', { page: 1 })).toThrow(
      MissingPortalStringError,
    );
  });

  it('sw interpolates identically', () => {
    expect(translate(sw, 'invoices.pageOf', { page: 1, pages: 1 })).toBe('ukurasa 1 wa ≤ 1');
  });
});

describe('locale cookie', () => {
  it('round-trips the assignment the toggle writes', () => {
    const assignment = portalLocaleCookieAssignment('sw');
    expect(assignment.startsWith(`${PORTAL_LOCALE_COOKIE}=sw;`)).toBe(true);
    expect(assignment).toContain('Path=/;');
    expect(assignment).toContain('SameSite=Lax');
    expect(parsePortalLocaleCookie(assignment)).toBe('sw');
  });

  it('refuses unlisted locales instead of leaking them into the UI', () => {
    expect(isPortalLocale('fr')).toBe(false);
    expect(parsePortalLocaleCookie(`${PORTAL_LOCALE_COOKIE}=fr`)).toBeNull();
    expect(parsePortalLocaleCookie(`${PORTAL_LOCALE_COOKIE}=en`)).toBe('en');
    expect(parsePortalLocaleCookie(`other=1; ${PORTAL_LOCALE_COOKIE}=sw`)).toBe('sw');
    expect(parsePortalLocaleCookie(null)).toBeNull();
    expect(parsePortalLocaleCookie('')).toBeNull();
  });

  it('falls back to en for absent or garbage values — never throws on the render path', () => {
    expect(portalLocaleFromValue(undefined)).toBe('en');
    expect(portalLocaleFromValue(null)).toBe('en');
    expect(portalLocaleFromValue('42')).toBe('en');
    expect(portalLocaleFromValue('sw')).toBe('sw');
  });

  it('exposes exactly en and sw (issue #149 scope)', () => {
    expect([...PORTAL_LOCALES]).toEqual(['en', 'sw']);
  });
});
