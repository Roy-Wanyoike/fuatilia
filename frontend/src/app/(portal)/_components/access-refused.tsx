'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Refusal } from '@/lib/api/client';

/**
 * The clean REFUSED surface for the payer portal (issue #86): rendered both
 * at the gate (the pasted code was not accepted) and in every view when the
 * API answers 401/403 contract envelopes (session expired/revoked, or the
 * credential lacks the view's permission). It surfaces the contract code +
 * requestId — never invented copy pretending the data is merely "loading".
 */

/** True when a tagged refusal is an access refusal (401/403 status). */
export function isAccessRefusal(refusal: Refusal): boolean {
  return (
    (refusal.tag === 'api-error' || refusal.tag === 'unknown-error') &&
    (refusal.status === 401 || refusal.status === 403)
  );
}

export interface AccessRefusedProps {
  /** Short human title, e.g. "This portal session is not valid". */
  title: string;
  /** One-line human explanation of what was refused. */
  description: string;
  /** Contract error code from the refusal envelope. */
  code: string;
  requestId: string | null;
  /** Server-supplied detail message, when the envelope carried one. */
  message?: string | null;
}

export function AccessRefused({
  title,
  description,
  code,
  requestId,
  message,
}: AccessRefusedProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function returnToGate(): Promise<void> {
    setSigningOut(true);
    try {
      await fetch('/api/portal/session', { method: 'DELETE' });
    } catch {
      // The cookie expiry is best-effort; the gate still renders — and a
      // dead API here is surfaced by the gate's own honest states.
    }
    router.refresh();
  }

  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-danger-soft bg-danger-soft/40 px-4 py-4"
      data-testid="access-refused"
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      <p className="text-sm text-ink-soft">{description}</p>
      {message !== undefined && message !== null && message.length > 0 && (
        <p className="text-xs text-ink-soft">{message}</p>
      )}
      <p className="font-mono text-xs text-ink-soft">
        code: <span className="font-semibold">{code}</span>
      </p>
      {requestId !== null && requestId.length > 0 && (
        <p className="font-mono text-xs text-ink-soft">
          requestId: <span>{requestId}</span>
        </p>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="w-fit"
        onClick={() => {
          void returnToGate();
        }}
        disabled={signingOut}
      >
        Return to access-code gate
      </Button>
    </div>
  );
}
