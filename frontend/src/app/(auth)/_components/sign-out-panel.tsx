'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePortalT } from '@/lib/portal-i18n/context';

/**
 * Sign-out panel (issue #133): issues DELETE /api/auth/session, whose
 * handler expires the httpOnly `fuatilia_session` cookie server-side. The
 * browser JS here never sees the credential (it is httpOnly) — it only
 * asks the server to clear the cookie, then reports the honest outcome.
 *
 * After a successful sign-out the (dashboard) middleware gate refuses every
 * dashboard route: a fresh visit is redirected to /sign-in. Strings resolve
 * through the shared i18n catalogs (issue #180).
 */

type SignOutPhase = 'idle' | 'signingOut' | 'signedOut' | 'failed';

export function SignOutPanel() {
  const t = usePortalT();
  const [phase, setPhase] = useState<SignOutPhase>('idle');

  async function handleSignOut(): Promise<void> {
    setPhase('signingOut');
    try {
      const response = await fetch('/api/auth/session', { method: 'DELETE' });
      if (response.ok) {
        setPhase('signedOut');
        return;
      }
      setPhase('failed');
    } catch {
      setPhase('failed');
    }
  }

  if (phase === 'signedOut') {
    return (
      <div className="flex flex-col gap-3" data-testid="sign-out-done">
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.signOut.done')}
        </p>
        <Link
          href="/sign-in"
          className="text-sm font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('auth.signOut.signInAgain')}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sign-out-panel">
      {phase === 'failed' && (
        <p role="alert" className="text-sm text-danger" data-testid="sign-out-failed">
          {t('auth.signOut.failed')}
        </p>
      )}
      <p className="text-sm text-ink-soft">{t('auth.signOut.help')}</p>
      <Button
        className="w-fit"
        onClick={() => {
          void handleSignOut();
        }}
        disabled={phase === 'signingOut'}
      >
        {phase === 'signingOut' ? t('auth.signOut.submitting') : t('auth.signOut.submit')}
      </Button>
    </div>
  );
}
