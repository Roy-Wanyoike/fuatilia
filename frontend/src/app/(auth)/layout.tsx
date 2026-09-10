import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PORTAL_DICTIONARIES, PortalI18nProvider } from '@/lib/portal-i18n';
import { readPortalLocale } from '@/lib/portal-i18n/server';
import { translate } from '@/lib/portal-i18n/t';

/**
 * (auth) route group — the credential surfaces (sign-in, sign-out) plus the
 * same-origin session BFF route (api/auth/session). Private screens: kept
 * out of search indexes; the dashboard-facing gate lives in
 * src/middleware.ts + app/(dashboard)/layout.tsx (issue #133).
 *
 * Language (issue #180): the same locale cookie the portal reads drives the
 * metadata AND the client components — the layout reads it server-side and
 * mounts PortalI18nProvider so server and client agree on first paint, and
 * the copy resolves through the shared catalog (translate() here,
 * usePortalT() below). No provider still renders English — en is the
 * default, never a crash.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const locale = await readPortalLocale();
  return <PortalI18nProvider initialLocale={locale}>{children}</PortalI18nProvider>;
}

export async function generateMetadata(): Promise<Metadata> {
  const dict = PORTAL_DICTIONARIES[await readPortalLocale()];
  return {
    title: translate(dict, 'auth.meta.title'),
    description: translate(dict, 'auth.meta.description'),
    robots: { index: false, follow: false },
  };
}
