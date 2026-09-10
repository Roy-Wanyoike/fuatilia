'use client';

import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Dictionary, LocaleKey } from './dictionary';
import type { PortalLocale } from './cookie';
import { DEFAULT_PORTAL_LOCALE } from './cookie';
import { en } from './en';
import { sw } from './sw';
import { translate, type TemplateVars } from './t';

/**
 * React bindings for the portal dictionaries (issue #149). The provider is
 * mounted by the (portal) layout with the locale read from the cookie
 * server-side; the language toggle flips it client-side (instant re-render)
 * and persists to the cookie. Every consumer resolves strings through
 * `usePortalT()` — no raw literals in (portal) views.
 *
 * Rendered WITHOUT a provider (as the existing view-level unit tests do),
 * `usePortalT` falls back to the en catalog: en is the default, and a
 * missing provider can never crash the portal — it can only speak English.
 */
export const PORTAL_DICTIONARIES: Record<PortalLocale, Dictionary> = { en, sw };

export type TranslateFn = (key: LocaleKey, vars?: TemplateVars) => string;

export interface PortalI18nValue {
  locale: PortalLocale;
  setLocale: (locale: PortalLocale) => void;
  t: TranslateFn;
}

function translateIn(locale: PortalLocale, key: LocaleKey, vars?: TemplateVars): string {
  return translate(PORTAL_DICTIONARIES[locale], key, vars);
}

/** en fallback for consumers rendered outside the provider (en default). */
const EN_FALLBACK: PortalI18nValue = {
  locale: DEFAULT_PORTAL_LOCALE,
  setLocale: () => {
    // No provider above — the toggle is inert; nothing to re-render.
  },
  t: (key, vars) => translateIn(DEFAULT_PORTAL_LOCALE, key, vars),
};

const PortalI18nContext = createContext<PortalI18nValue | null>(null);

export function PortalI18nProvider({
  initialLocale = DEFAULT_PORTAL_LOCALE,
  children,
}: {
  initialLocale?: PortalLocale;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState<PortalLocale>(initialLocale);
  const value = useMemo<PortalI18nValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translateIn(locale, key, vars),
    }),
    [locale],
  );
  return <PortalI18nContext.Provider value={value}>{children}</PortalI18nContext.Provider>;
}

/** Full i18n context (locale + setter + t); en fallback outside a provider. */
export function usePortalI18n(): PortalI18nValue {
  return useContext(PortalI18nContext) ?? EN_FALLBACK;
}

/** The portal translate function, bound to the current locale. */
export function usePortalT(): TranslateFn {
  return usePortalI18n().t;
}
