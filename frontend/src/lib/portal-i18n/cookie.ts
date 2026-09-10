/**
 * Portal locale cookie (issue #149): the language toggle persists the payer's
 * choice here. Isomorphic module — imported by client components (toggle),
 * server components (layout/metadata) and tests alike; it must never import
 * `next/headers` (that is `server.ts`'s job) so the client bundle stays clean.
 *
 * The cookie is a UI preference only — never a credential: not httpOnly, not
 * signed, SameSite=Lax, one year, path-scoped to the whole app so the portal
 * route group reads it in layout + metadata.
 */
export const PORTAL_LOCALES = ['en', 'sw'] as const;

export type PortalLocale = (typeof PORTAL_LOCALES)[number];

/** en is the default (issue #149: "en default"). */
export const DEFAULT_PORTAL_LOCALE: PortalLocale = 'en';

export const PORTAL_LOCALE_COOKIE = 'fuatilia_portal_locale';

export const PORTAL_LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Narrow an unknown value (cookie payload, query param) to a portal locale. */
export function isPortalLocale(value: unknown): value is PortalLocale {
  return value === 'en' || value === 'sw';
}

/** Strict read: null when the cookie is absent OR holds an unlisted locale. */
export function parsePortalLocaleCookie(cookieHeader: string | null | undefined): PortalLocale | null {
  if (cookieHeader === null || cookieHeader === undefined || cookieHeader.length === 0) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== PORTAL_LOCALE_COOKIE) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return isPortalLocale(value) ? value : null;
  }
  return null;
}

/**
 * Resolve a single cookie value (as `cookies().get(name)?.value` yields) to a
 * locale, falling back to the default. Garbage in → en out; never a throw on
 * the render path.
 */
export function portalLocaleFromValue(value: string | null | undefined): PortalLocale {
  return value !== null && value !== undefined && isPortalLocale(value) ? value : DEFAULT_PORTAL_LOCALE;
}

/** The exact Set-Cookie-style assignment the client toggle writes. */
export function portalLocaleCookieAssignment(locale: PortalLocale): string {
  return `${PORTAL_LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${PORTAL_LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** Client-side persistence for the language toggle (browser only). */
export function persistPortalLocale(locale: PortalLocale): void {
  document.cookie = portalLocaleCookieAssignment(locale);
}

/** Clears the preference (tests + "reset to default" paths). */
export function clearPortalLocaleCookie(): void {
  document.cookie = `${PORTAL_LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
