'use client';

import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { usePortalT } from '@/lib/portal-i18n/context';

/**
 * The designed "sign-in required" screen shown by the dashboard layout when
 * the httpOnly session cookie is absent. NOT an error state — the gate is
 * working as designed. It documents the seam honestly: the /v1 contract has
 * no session-issuance (login) operation yet, so there is nothing to render
 * a login form against. Strings resolve through the shared i18n catalogs
 * (issue #180); the cookie name and the Authorization scheme stay wire
 * vocabulary, rendered in <code>.
 */
export function SignInRequired() {
  const t = usePortalT();
  return (
    <div className="min-h-screen bg-surface">
      <main
        id="main-content"
        className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-12"
      >
        <div className="rounded-lg border border-slate-200 bg-surface-raised p-8 shadow-sm">
          <h1 className="text-lg font-semibold text-ink">{t('auth.signInRequired.title')}</h1>
          <p className="mt-2 text-sm text-ink-soft">
            {t('auth.signInRequired.bodyLeadIn')}
            <code className="font-mono text-xs">{SESSION_COOKIE_NAME}</code>
            {t('auth.signInRequired.bodyRelay')}
            <code className="font-mono text-xs">Authorization: Bearer &lt;session&gt;</code>
            {t('auth.signInRequired.bodyRest')}
          </p>
          <p className="mt-3 rounded-md border border-dashed border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft">
            <strong className="font-semibold text-ink">
              {t('auth.signInRequired.seamStatusLabel')}
            </strong>{' '}
            {t('auth.signInRequired.seamNote')}
          </p>
          <p className="mt-4 text-xs text-ink-faint">{t('auth.signInRequired.devNote')}</p>
        </div>
      </main>
    </div>
  );
}
