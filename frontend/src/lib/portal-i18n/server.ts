import { cookies } from 'next/headers';
import type { PortalLocale } from './cookie';
import { portalLocaleFromValue, PORTAL_LOCALE_COOKIE } from './cookie';

/**
 * Server-side locale read for the (portal) route group (issue #149). The
 * layout and `generateMetadata` call this; the locale cookie is a plain UI
 * preference (see `cookie.ts`), so an absent or garbage cookie silently
 * yields the default (en). Server-only: imports `next/headers` and must
 * never be pulled into the client bundle — client code uses the provider.
 */
export async function readPortalLocale(): Promise<PortalLocale> {
  const cookieStore = await cookies();
  return portalLocaleFromValue(cookieStore.get(PORTAL_LOCALE_COOKIE)?.value);
}
