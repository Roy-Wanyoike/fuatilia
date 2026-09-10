/**
 * Portal i18n (issue #149) — client-safe public surface for the payer
 * portal's en/sw dictionaries. Server components additionally import
 * `readPortalLocale` from `./server` (which pulls `next/headers` and must
 * stay out of client bundles).
 *
 * THE PATTERN (tsc-level missing-key safety):
 *   • en.ts is the source of truth — `as const`, every portal string.
 *   • dictionary.ts derives `LocaleKey`, the union of all dot-paths to leaf
 *     strings, and widens `typeof en` into the `Dictionary` shape type.
 *   • sw.ts is `satisfies Dictionary` — a key missing in sw (or extra, or
 *     mistyped) is a build error inside sw.ts itself.
 *   • t.ts types the key parameter as `LocaleKey`, so `t('gate.titel')` (or
 *     any retired/renamed key) fails to compile AT THE CALL SITE; at runtime
 *     it throws `MissingPortalStringError` — never a silent blank.
 *   • The parity test re-asserts en ≡ sw key sets at runtime (see
 *     portal-i18n.test.ts). See README.md in this folder for the full story.
 */
export { PORTAL_DICTIONARIES, PortalI18nProvider, usePortalI18n, usePortalT } from './context';
export type { PortalI18nValue, TranslateFn } from './context';
export { LanguageToggle } from './language-toggle';
export { flattenDictionary } from './dictionary';
export type { Dictionary, DictionaryKey, LocaleKey } from './dictionary';
export { en } from './en';
export { sw } from './sw';
export { MissingPortalStringError, translate } from './t';
export type { TemplateVars } from './t';
export {
  clearPortalLocaleCookie,
  DEFAULT_PORTAL_LOCALE,
  isPortalLocale,
  parsePortalLocaleCookie,
  persistPortalLocale,
  portalLocaleCookieAssignment,
  portalLocaleFromValue,
  PORTAL_LOCALE_COOKIE,
  PORTAL_LOCALE_COOKIE_MAX_AGE_SECONDS,
  PORTAL_LOCALES,
} from './cookie';
export type { PortalLocale } from './cookie';
