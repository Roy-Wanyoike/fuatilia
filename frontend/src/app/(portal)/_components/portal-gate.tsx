'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { AccessRefused } from './access-refused';

/**
 * The portal GATE (issue #86): the payer pastes the portal access code once.
 * The code is POSTed in the request BODY to the same-origin session route,
 * which validates it against the live API and sets the httpOnly
 * SameSite=Strict cookie on success. The code is NEVER placed in a URL,
 * NEVER written to localStorage/sessionStorage, and after validation it
 * lives only in the httpOnly cookie — invisible to this component's JS.
 */

interface GateRefusal {
  code: string;
  message: string | null;
  requestId: string | null;
}

type GatePhase = 'idle' | 'submitting' | 'refused' | 'unreachable';

export function PortalGate() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<GatePhase>('idle');
  const [refusal, setRefusal] = useState<GateRefusal | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setLocalError('Enter the access code you received.');
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    try {
      // The credential travels in the POST body only — never a query string.
      const response = await fetch('/api/portal/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      if (response.ok) {
        // The httpOnly cookie is now set server-side; re-render the server
        // layout so the gate yields to the portal shell.
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
          <h1 className="text-lg font-semibold text-ink">Fuatilia payer portal</h1>
          <p className="mt-2 text-sm text-ink-soft">
            See what you owe, what you have paid, and where your money was applied. Paste the
            access code you received to begin.
          </p>

          <form className="mt-5 flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
            <label htmlFor="portal-access-code" className="text-sm font-medium text-ink">
              Portal access code
            </label>
            <input
              id="portal-access-code"
              type="password"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              className="h-10 rounded-md border border-slate-300 bg-white px-3 font-mono text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
              aria-describedby="portal-access-code-help"
              disabled={phase === 'submitting'}
            />
            <p id="portal-access-code-help" className="text-xs text-ink-soft">
              The code is validated against the live API once, then held in an HTTP-only,
              SameSite=Strict cookie and relayed to the API server-side. It is never placed in a
              URL, never stored in your browser, and never readable by scripts on this page.
            </p>
            {localError !== null && (
              <p role="alert" className="text-sm text-danger" data-testid="gate-local-error">
                {localError}
              </p>
            )}
            <Button type="submit" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? 'Validating…' : 'Open my account'}
            </Button>
          </form>

          {phase === 'refused' && refusal !== null && (
            <div className="mt-5">
              <AccessRefused
                title="This access code was not accepted"
                description="Check the code and try again, or request a new portal access code from the biller."
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
              data-testid="gate-unreachable"
            >
              <p className="text-sm font-medium text-danger">
                The API could not be reached
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                The access code could not be validated, so nothing was unlocked. Try again in a
                moment — no access is granted on an unverifiable code.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
