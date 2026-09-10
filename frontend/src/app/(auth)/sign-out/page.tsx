import { SignOutPanel } from '../_components/sign-out-panel';
import { PORTAL_DICTIONARIES } from '@/lib/portal-i18n';
import { readPortalLocale } from '@/lib/portal-i18n/server';
import { translate } from '@/lib/portal-i18n/t';

/**
 * /sign-out — ends the collector session (issue #133). The panel issues
 * DELETE /api/auth/session; the route handler expires the httpOnly
 * SameSite=Strict cookie server-side. No credential ever appears in a URL,
 * in storage, or in client-visible state. The server-rendered heading
 * follows the same locale cookie as the panel below it (issue #180).
 */

export const dynamic = 'force-dynamic';

export default async function SignOutPage() {
  const dict = PORTAL_DICTIONARIES[await readPortalLocale()];
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <main id="main-content" className="w-full max-w-md">
        <div className="rounded-lg border border-slate-200 bg-surface-raised p-6 shadow-sm sm:p-8">
          <h1 className="text-lg font-semibold text-ink">{translate(dict, 'auth.signOut.title')}</h1>
          <div className="mt-4">
            <SignOutPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
