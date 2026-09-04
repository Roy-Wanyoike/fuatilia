import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * The designed "sign-in required" screen shown by the dashboard layout when
 * the httpOnly session cookie is absent. NOT an error state — the gate is
 * working as designed. It documents the seam honestly: the /v1 contract has
 * no session-issuance (login) operation yet, so there is nothing to render
 * a login form against.
 */
export function SignInRequired() {
  return (
    <div className="min-h-screen bg-surface">
      <main
        id="main-content"
        className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-12"
      >
        <div className="rounded-lg border border-slate-200 bg-surface-raised p-8 shadow-sm">
          <h1 className="text-lg font-semibold text-ink">Sign in to Fuatilia</h1>
          <p className="mt-2 text-sm text-ink-soft">
            This console reads its bearer credential from an HTTP-only session cookie (
            <code className="font-mono text-xs">{SESSION_COOKIE_NAME}</code>), which the API
            relays as <code className="font-mono text-xs">Authorization: Bearer &lt;session&gt;</code>.
            The cookie is never readable from browser JavaScript and is never stored in
            localStorage.
          </p>
          <p className="mt-3 rounded-md border border-dashed border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft">
            <strong className="font-semibold text-ink">Seam status:</strong> the mounted /v1
            contract (api/openapi/fuatilia.v1.yaml) exposes session revocation but not session
            issuance — the login operation lands with the backend auth lane. Until then the gate
            enforces the cookie contract&apos;s presence check only, and no dashboard data can be
            fabricated in its place.
          </p>
          <p className="mt-4 text-xs text-ink-faint">
            In development, seed the cookie with a real auth-lane session id to exercise the read
            path; see frontend/README.md &quot;Auth at the seam&quot;.
          </p>
        </div>
      </main>
    </div>
  );
}
