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

  it('key derivation reaches every #180 leaf — dashboard + auth samples resolve', () => {
    // (dashboard) — one sample per section, proving the union grew with the
    // catalog and every new view is addressable at tsc level.
    expect(typeof translate(en, 'dashboard.overview.title')).toBe('string');
    expect(typeof translate(en, 'dashboard.payments.col.receipt')).toBe('string');
    expect(typeof translate(en, 'dashboard.collections.statusLabels.in_progress')).toBe('string');
    expect(typeof translate(en, 'dashboard.collections.open.toggle')).toBe('string');
    expect(
      typeof translate(en, 'dashboard.collections.log.sealedNote', { status: 'Resolved' }),
    ).toBe('string');
    expect(typeof translate(en, 'dashboard.customers.directory.col.lastActivity')).toBe('string');
    expect(typeof translate(en, 'dashboard.customers.c360.promises.dueNow')).toBe('string');
    expect(typeof translate(en, 'dashboard.reconciliation.capabilities')).toBe('string');
    expect(typeof translate(en, 'dashboard.settings.scope')).toBe('string');
    // (auth) — the credential surfaces.
    expect(typeof translate(en, 'auth.meta.title')).toBe('string');
    expect(typeof translate(en, 'auth.signIn.credentialLabel')).toBe('string');
    expect(typeof translate(en, 'auth.signOut.submit')).toBe('string');
  });

  it('a key absent from the #180 sections is a TYPE error too — the pattern extends', () => {
    // Same load-bearing contract as above, now pinning the dashboard/auth
    // sections: if key derivation ever stops rejecting unknown keys there,
    // `npm run typecheck` fails on these lines.
    expect(() =>
      // @ts-expect-error — unknown dashboard keys must be a tsc error too
      translate(en, 'dashboard.collections.doesNotExist' as string),
    ).toThrow(MissingPortalStringError);

    expect(() =>
      // @ts-expect-error — a typo'd auth key must be a tsc error too
      translate(en, 'auth.singIn.title' as string),
    ).toThrow(MissingPortalStringError);

    expect(() =>
      // @ts-expect-error — a retired #180 key must be refused like a portal one
      translate(en, 'dashboard.overview.cardTitle' as string),
    ).toThrow(MissingPortalStringError);
  });
});

describe('adoption byte-identity (issue #180 — en copy pinned verbatim)', () => {
  // The (dashboard)/(auth) components previously rendered these literals
  // inline; existing component tests pin them. Adoption moved the strings
  // into the catalog — this suite makes the byte-identity load-bearing at
  // the catalog level too, so a casual copy edit shows up here first.
  it('dashboard strings that component tests pin resolve byte-identically', () => {
    expect(translate(en, 'dashboard.overview.title')).toBe('Overview');
    expect(translate(en, 'dashboard.overview.emptyTitle')).toBe('Nothing here yet');
    expect(translate(en, 'dashboard.payments.refusedTitle')).toBe('Payments are unavailable');
    expect(translate(en, 'dashboard.payments.pageOf', { page: 1, pages: 3 })).toBe(
      'page 1 of ≤ 3',
    );
    expect(translate(en, 'dashboard.collections.list.emptyTitle')).toBe(
      'No collections cases yet',
    );
    expect(translate(en, 'dashboard.collections.list.shownOfTotal', { shown: 3, total: 3 })).toBe(
      '3 of 3 case(s) shown',
    );
    expect(translate(en, 'dashboard.collections.statusLabels.in_progress')).toBe('In progress');
    expect(translate(en, 'dashboard.collections.actionTypeLabels.call')).toBe('Call');
    expect(translate(en, 'dashboard.collections.open.success', { caseNumber: 'CASE-000007' })).toBe(
      'Case CASE-000007 opened.',
    );
    expect(translate(en, 'dashboard.collections.detail.heading', { caseNumber: 'CASE-000007' })).toBe(
      'Case CASE-000007',
    );
    expect(translate(en, 'dashboard.collections.transition.submit', { to: 'In progress' })).toBe(
      'Move to In progress',
    );
    expect(translate(en, 'dashboard.collections.escalation.submit', { to: 'urgent' })).toBe(
      'Escalate to urgent',
    );
    expect(translate(en, 'dashboard.collections.summary.overdueSuffix')).toBe('· overdue');
    expect(translate(en, 'dashboard.collections.record.title')).toBe('Record an action');
    expect(
      translate(en, 'dashboard.collections.record.success', {
        type: 'Call',
        when: '2026-09-02 12:00',
      }),
    ).toBe('Call recorded — scheduled for 2026-09-02 12:00.');
    expect(translate(en, 'dashboard.collections.record.scheduledLabel')).toBe(
      'Scheduled for (Nairobi time)',
    );
    expect(translate(en, 'dashboard.collections.complete.title')).toBe('Complete an action');
    expect(
      translate(en, 'dashboard.collections.complete.optionLabel', {
        type: 'Call',
        when: '2026-09-02 12:00',
      }),
    ).toBe('Call — scheduled 2026-09-02 12:00');
    expect(translate(en, 'dashboard.customers.directory.derivedCount', { count: 1 })).toBe(
      '· 1 derived',
    );
    expect(translate(en, 'dashboard.customers.directory.overdueCount', { count: 1 })).toBe(
      '1 overdue',
    );
    expect(translate(en, 'dashboard.customers.c360.overdueBadge')).toBe('overdue');
    expect(translate(en, 'dashboard.customers.c360.promises.dueNow')).toBe('due now');
  });

  it('auth strings that component tests pin resolve byte-identically', () => {
    expect(translate(en, 'auth.meta.title')).toBe('Fuatilia — Sign in');
    expect(translate(en, 'auth.signIn.title')).toBe('Sign in to Fuatilia');
    expect(translate(en, 'auth.signIn.credentialLabel')).toBe('Session credential');
    expect(translate(en, 'auth.signIn.submit')).toBe('Open the console');
    expect(translate(en, 'auth.signIn.submitting')).toBe('Validating…');
    expect(translate(en, 'auth.signIn.emptyCredentialError')).toBe(
      'Paste the session credential your administrator issued.',
    );
    expect(translate(en, 'auth.signIn.refusedTitle')).toBe(
      'This session credential was not accepted',
    );
    expect(translate(en, 'auth.signIn.unreachableTitle')).toBe('The API could not be reached');
    expect(translate(en, 'auth.signOut.submit')).toBe('Sign out');
    expect(translate(en, 'auth.signOut.signInAgain')).toBe('Sign in again');
  });

  it('the shared refusal-envelope labels match the (auth) AccessRefused rendering', () => {
    // (auth)/access-refused.tsx adopts the #149 shared `common` labels —
    // they render byte-identically ('code:' / 'requestId:').
    expect(translate(en, 'common.codeLabel')).toBe('code:');
    expect(translate(en, 'common.requestIdLabel')).toBe('requestId:');
  });

  it('sw carries every #180 string too — sample translations resolve', () => {
    expect(translate(sw, 'dashboard.overview.title')).toBe('Muhtasari');
    expect(translate(sw, 'dashboard.payments.title')).toBe('Malipo');
    expect(translate(sw, 'dashboard.collections.statusLabels.in_progress')).toBe('Inaendelea');
    expect(translate(sw, 'dashboard.collections.open.toggle')).toBe('Fungua kesa…');
    expect(translate(sw, 'dashboard.collections.record.submit')).toBe('Rekodi hatua');
    expect(
      translate(sw, 'dashboard.collections.complete.optionLabel', {
        type: 'Simu',
        when: '2026-09-02 12:00',
      }),
    ).toBe('Simu — imepangwa 2026-09-02 12:00');
    expect(translate(sw, 'dashboard.customers.directory.title')).toBe('Wateja');
    expect(translate(sw, 'auth.signIn.title')).toBe('Ingia kwenye Fuatilia');
    expect(translate(sw, 'auth.signOut.submit')).toBe('Toka');
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
