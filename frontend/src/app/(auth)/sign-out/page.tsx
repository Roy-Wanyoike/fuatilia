import { SignOutPanel } from '../_components/sign-out-panel';

/**
 * /sign-out — ends the collector session (issue #133). The panel issues
 * DELETE /api/auth/session; the route handler expires the httpOnly
 * SameSite=Strict cookie server-side. No credential ever appears in a URL,
 * in storage, or in client-visible state.
 */

export const dynamic = 'force-dynamic';

export default function SignOutPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <main id="main-content" className="w-full max-w-md">
        <div className="rounded-lg border border-slate-200 bg-surface-raised p-6 shadow-sm sm:p-8">
          <h1 className="text-lg font-semibold text-ink">Sign out of Fuatilia</h1>
          <div className="mt-4">
            <SignOutPanel />
          </div>
        </div>
      </main>
    </div>
  );
}
