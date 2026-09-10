'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { usePortalT } from '@/lib/portal-i18n/context';
import { LanguageToggle } from '@/lib/portal-i18n/language-toggle';
import { AccessRefused } from './access-refused';

/**
 * The portal GATE (issue #86): the payer pastes the portal access code once.
 * The code is POSTed in the request BODY to the same-origin session route,
 * which validates it against the live API and sets the httpOnly
 * SameSite=Strict cookie on success. The code is NEVER placed in a URL,
 * NEVER written to localStorage/sessionStorage, and after validation it
 * lives only in the httpOnly cookie — invisible to this component's JS.
 * All payer-facing strings resolve through the portal i18n catalogs
 * (issue #149).
 */

interface GateRefusal {
  code: string;
  message: string | null;
  requestId: string | null;
}

type GatePhase = 'idle' | 'submitting' | 'refused' | 'unreachable';

export function PortalGate() {
  const router = useRouter();
  const t = usePortalT();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<GatePhase>('idle');
  const [refusal, setRefusal] = useState<GateRefusal | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed.length === 0) {
      setLocalError(t('gate.emptyCodeError'));
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
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-lg font-semibold text-ink">{t('gate.title')}</h1>
          </div>
          <p className="mt-2 text-sm text-ink-soft">{t('gate.intro')}</p>

          <form className="mt-5 flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)}>
            <label htmlFor="portal-access-code" className="text-sm font-medium text-ink">
              {t('gate.codeLabel')}
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
              {t('gate.codeHelp')}
            </p>
            {localError !== null && (
              <p role="alert" className="text-sm text-danger" data-testid="gate-local-error">
                {localError}
              </p>
            )}
            <Button type="submit" disabled={phase === 'submitting'}>
              {phase === 'submitting' ? t('gate.submitting') : t('gate.submit')}
            </Button>
          </form>

          {phase === 'refused' && refusal !== null && (
            <div className="mt-5">
              <AccessRefused
                title={t('gate.refusedTitle')}
                description={t('gate.refusedDescription')}
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
              <p className="text-sm font-medium text-danger">{t('gate.unreachableTitle')}</p>
              <p className="mt-1 text-sm text-ink-soft">{t('gate.unreachableBody')}</p>
            </div>
          )}
          <div className="mt-5">
            <LanguageToggleRow />
          </div>
        </div>
      </main>
    </div>
  );
}

/** The gate speaks the payer's language before they have an account. */
function LanguageToggleRow(): ReactNode {
  const t = usePortalT();
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
      <span className="text-xs text-ink-soft">{t('language.label')}</span>
      <LanguageToggle />
    </div>
  );
}
