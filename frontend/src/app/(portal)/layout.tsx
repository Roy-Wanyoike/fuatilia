import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import {
  looksLikePortalSessionToken,
  PORTAL_SESSION_COOKIE_NAME,
} from '@/lib/portal/session';
import { portalLocaleFromValue, PORTAL_LOCALE_COOKIE, PORTAL_DICTIONARIES } from '@/lib/portal-i18n';
import { translate } from '@/lib/portal-i18n/t';
import { PortalI18nProvider } from '@/lib/portal-i18n/context';
import { PortalGate } from './_components/portal-gate';
import { PortalShell } from './_components/portal-shell';

/**
 * Portal gate + shell (issue #86).
 *
 * Server-component gate: the payer portal renders only when the httpOnly
 * SameSite=Strict `fuatilia_portal_session` cookie is present with the
 * contract's opaque session-UUID shape — the cookie the gate set AFTER the
 * pasted access code was validated against the live API. Without it, the
 * payer sees the designed access-code gate, never the data.
 *
 * The cookie is invisible to client JS by design; the dedicated portal BFF
 * (app/(portal)/api/portal/v1/[...path]) relays it as the Bearer header
 * server-side. When the credential later fails upstream (expired/revoked
 * session, missing permission), every view renders the contract's 401/403
 * refusal as a clean refused state with code + requestId.
 *
 * Language (issue #149): the locale is read from the
 * `fuatilia_portal_locale` cookie (a UI preference, never a credential) and
 * handed to PortalI18nProvider, so the server-rendered tree and the client
 * dictionaries agree on first paint — no hydration mismatch. Translated
 * metadata follows the same cookie via generateMetadata.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(PORTAL_SESSION_COOKIE_NAME)?.value ?? null;
  const sessionPresent = looksLikePortalSessionToken(token);
  const locale = portalLocaleFromValue(cookieStore.get(PORTAL_LOCALE_COOKIE)?.value);

  if (!sessionPresent) {
    return (
      <PortalI18nProvider initialLocale={locale}>
        <PortalGate />
      </PortalI18nProvider>
    );
  }

  return (
    <PortalI18nProvider initialLocale={locale}>
      <PortalShell>{children}</PortalShell>
    </PortalI18nProvider>
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const locale = portalLocaleFromValue(cookieStore.get(PORTAL_LOCALE_COOKIE)?.value);
  const dict = PORTAL_DICTIONARIES[locale];
  return {
    title: translate(dict, 'meta.title'),
    description: translate(dict, 'meta.description'),
    // A private, credential-gated surface — keep it out of search indexes.
    robots: { index: false, follow: false },
  };
}
