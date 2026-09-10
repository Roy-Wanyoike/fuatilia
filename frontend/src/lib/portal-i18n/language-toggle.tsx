'use client';

import { useRouter } from 'next/navigation';
import type { PortalLocale } from './cookie';
import { persistPortalLocale } from './cookie';
import { usePortalI18n } from './context';

/**
 * The portal language toggle (issue #149): English ⇄ Kiswahili. Choosing a
 * language (1) persists it to the `fuatilia_portal_locale` cookie so the
 * choice survives reloads and is visible to server components (metadata),
 * (2) flips the client context so every mounted portal view re-renders in
 * the new language immediately, and (3) refreshes the router so the server
 * tree (page metadata) follows. The cookie is a UI preference, not a
 * credential — SameSite=Lax, path=/, one year (see `cookie.ts`).
 */
export function LanguageToggle() {
  const { locale, setLocale, t } = usePortalI18n();
  const router = useRouter();

  function choose(next: PortalLocale): void {
    if (next === locale) {
      return;
    }
    persistPortalLocale(next);
    setLocale(next);
    router.refresh();
  }

  const options: ReadonlyArray<{ locale: PortalLocale; label: string }> = [
    { locale: 'en', label: t('language.english') },
    { locale: 'sw', label: t('language.kiswahili') },
  ];

  return (
    <div
      role="group"
      aria-label={t('language.label')}
      data-testid="portal-language-toggle"
      className="inline-flex items-center gap-1"
    >
      {options.map((option) => {
        const active = option.locale === locale;
        return (
          <button
            key={option.locale}
            type="button"
            aria-pressed={active}
            data-locale={option.locale}
            data-testid={`portal-language-${option.locale}`}
            onClick={() => {
              choose(option.locale);
            }}
            className={`rounded-md px-2 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
              active
                ? 'bg-accent-soft text-accent'
                : 'text-ink-soft hover:bg-surface-sunk hover:text-ink'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
