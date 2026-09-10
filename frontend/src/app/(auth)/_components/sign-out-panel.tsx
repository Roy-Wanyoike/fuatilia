'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Sign-out panel (issue #133): issues DELETE /api/auth/session, whose
 * handler expires the httpOnly `fuatilia_session` cookie server-side. The
 * browser JS here never sees the credential (it is httpOnly) — it only
 * asks the server to clear the cookie, then reports the honest outcome.
 *
 * After a successful sign-out the (dashboard) middleware gate refuses every
 * dashboard route: a fresh visit is redirected to /sign-in.
 */

type SignOutPhase = 'idle' | 'signingOut' | 'signedOut' | 'failed';

export function SignOutPanel() {
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
          You are signed out. The session cookie has been cleared on this browser.
        </p>
        <Link
          href="/sign-in"
          className="text-sm font-medium text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Sign in again
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sign-out-panel">
      {phase === 'failed' && (
        <p role="alert" className="text-sm text-danger" data-testid="sign-out-failed">
          The sign-out request did not complete. The session cookie may still be present — try
          again.
        </p>
      )}
      <p className="text-sm text-ink-soft">
        Signing out expires the HTTP-only session cookie on this browser. The credential itself is
        never readable by this page.
      </p>
      <Button
        className="w-fit"
        onClick={() => {
          void handleSignOut();
        }}
        disabled={phase === 'signingOut'}
      >
        {phase === 'signingOut' ? 'Signing out…' : 'Sign out'}
      </Button>
    </div>
  );
}
