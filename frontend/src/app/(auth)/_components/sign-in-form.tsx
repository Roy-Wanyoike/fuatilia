'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { safeNextPath } from '@/lib/auth/gate';
import { AccessRefused } from './access-refused';

/**
 * The collector SIGN-IN gate (issue #133): the collector pastes the session
 * credential their administrator issued (the bearerSession token itself —
 * an opaque session UUID; the mounted /v1 surface has no username/password
 * issuance yet, and nothing is invented to fake one). The credential is
 * POSTed in the request BODY to the same-origin session route, which
 * validates it against the live API and sets the httpOnly SameSite=Strict
 * cookie on success. The credential is NEVER placed in a URL, NEVER written
 * to localStorage/sessionStorage, and after validation it lives only in the
 * httpOnly cookie — invisible to this component's JS.
 */

interface SignInRefusal {
  code: string;
  message: string | null;
  requestId: string | null;
}

type SignInPhase = 'idle' | 'submitting' | 'refused' | 'unreachable';

export function SignInForm({ nextHint }: { nextHint?: string | null }) {
  const router = useRouter();
  // Open-redirect-safe: only a same-origin relative path survives the
  // sanitizer (lib/auth/gate.ts); the hint never carries a credential.
  const next = safeNextPath(nextHint);
  const [sessionToken, setSessionToken] = useState('');
  const [phase, setPhase] = useState<SignInPhase>('idle');
  const [refusal, setRefusal] = useState<SignInRefusal | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = sessionToken.trim();
    if (trimmed.length === 0) {
      setLocalError('Paste the session credential your administrator issued.');
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    try {
      // The credential travels in the POST body only — never a query string.
      const response = await fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionToken: trimmed }),
      });
      if (response.ok) {
        // The httpOnly cookie is now set server-side; land on the requested
        // dashboard route (or the overview) and re-render the server layout
        // so the gate yields to the shell.
        router.replace(next);
        router.refresh();
        return;
      }
      const parsed = (await response.json().catch(() => null)) as {
        error?: { code?: unknown; message?: unknown };
        requestId?: unknown;
      } | null;
      setRefusal({
        code:
          typeof parsed?.error?.code === 'string' ? parsed.error.code : 'HTTP_INTERNAL_ERROR',
        message: typeof parsed?.error?.message === 'string' ? parsed.error.message : null,
        requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : null,
      });
      setPhase('refused');
    } catch {
      setPhase('unreachable');
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface px-4 py-12">
      <main id="main-content" className="w-full max-w-md">
        <div className="rounded-lg border border-slate-200 bg-surface-raised p-6 shadow-sm sm:p-8">
          <h1 className="text-lg font-semibold text-ink">Sign in to Fuatilia</h1>
          <p className="mt-2 text-sm text-ink-soft">
            The collections console for your team. Paste the session credential your Fuatilia
            administrator issued to begin.
          </p>

          <form className="mt-5 flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
            <label htmlFor="session-credential" className="text-sm font-medium text-ink">
              Session credential
            </label>
            <input
              id="session-credential"
              type="password"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-md border border-slate-300 bg-white px-3 font-mono text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              value={sessionToken}
              onChange={(event) => {
                setSessionToken(event.target.value);
              }}
              aria-describedby="session-credential-help"
              disabled={phase === 'submitting'}
            />
            <p id="session-credential-help" className="text-xs text-ink-soft">
              The credential is validated against the live API once, then held in an HTTP-only,
              SameSite=Strict cookie and relayed to the API server-side. It is never placed in a
              URL, never stored in your browser, and never readable by scripts on this page.
            </p>
            {localError !== null && (
              <p role="alert" className="text-sm text-danger" data-testid="sign-in-local-error">
                {localError}
              </p>
            )}
            <Button type="submit" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? 'Validating…' : 'Open the console'}
            </Button>
          </form>

          {phase === 'refused' && refusal !== null && (
            <div className="mt-5">
              <AccessRefused
                title="This session credential was not accepted"
                description="Check the credential and try again, or ask your Fuatilia administrator for a fresh session."
                code={refusal.code}
                requestId={refusal.requestId}
                message={refusal.message}
              />
            </div>
          )}
          {phase === 'unreachable' && (
            <div
              role="alert"
              className="mt-5 rounded-md border border-danger-soft bg-danger-soft/40 px-4 py-4"
              data-testid="sign-in-unreachable"
            >
              <p className="text-sm font-medium text-danger">The API could not be reached</p>
              <p className="mt-1 text-sm text-ink-soft">
                The credential could not be validated, so nothing was unlocked. Try again in a
                moment — no access is granted on an unverifiable credential.
              </p>
            </div>
          )}

          <p className="mt-6 rounded-md border border-dashed border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft">
            <strong className="font-semibold text-ink">How sign-in works today:</strong> the
            mounted /v1 contract issues sessions through the auth admin lane, not through a
            username/password form — so this screen accepts the session credential itself and
            proves it against a live protected operation before the console opens. Nothing here is
            simulated.
          </p>
        </div>
      </main>
    </div>
  );
}
