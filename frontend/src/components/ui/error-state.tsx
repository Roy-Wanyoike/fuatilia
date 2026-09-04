import { Button } from './button';
import type { Refusal } from '@/lib/api/client';

/**
 * Renders a tagged refusal from the typed client (lib/api). Surfaces the
 * error CODE (clients branch on codes, never prose — contract rule) plus
 * the correlation requestId for traceability (SPEC §47), and an optional
 * retry affordance.
 */

/** The machine code to display for a refusal (contract code or refusal tag). */
export function describeRefusalCode(refusal: Refusal): string {
  switch (refusal.tag) {
    case 'api-error':
      return refusal.code;
    case 'unknown-error':
      return `${refusal.rawCode} (unknown to this client build)`;
    case 'transport-error':
      return refusal.reason.toUpperCase();
    case 'decoding-error':
      return 'CONTRACT_MISMATCH';
  }
}

/** The correlation requestId carried by the refusal, when one exists. */
export function refusalRequestId(refusal: Refusal): string | null {
  switch (refusal.tag) {
    case 'api-error':
    case 'unknown-error':
    case 'decoding-error':
      return refusal.requestId;
    case 'transport-error':
      return null;
  }
}

/** The human-facing detail for a refusal, when one exists. */
export function refusalMessage(refusal: Refusal): string | null {
  switch (refusal.tag) {
    case 'api-error':
    case 'unknown-error':
    case 'decoding-error':
      return refusal.message;
    case 'transport-error':
      return `The API could not be reached (${refusal.reason}).`;
  }
}

export interface ErrorStateProps {
  /** Short human title for the surface, e.g. "Couldn't load receivables". */
  title: string;
  /** The message from the error envelope, when the server sent one. */
  message?: string | null;
  /** Machine code from the contract's error union (or refusal tag). */
  code: string;
  /** Correlation id echoed by the kernel — quote it in support requests. */
  requestId?: string | null;
  onRetry?: () => void;
}

export function ErrorState({ title, message, code, requestId, onRetry }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-danger-soft bg-danger-soft/40 px-4 py-4"
      data-testid="error-state"
    >
      <p className="text-sm font-medium text-danger">{title}</p>
      {message !== undefined && message !== null && message.length > 0 && (
        <p className="text-xs text-ink-soft">{message}</p>
      )}
      <p className="font-mono text-xs text-ink-faint">
        code: <span className="font-semibold text-ink-soft">{code}</span>
      </p>
      {requestId !== undefined && requestId !== null && requestId.length > 0 && (
        <p className="font-mono text-xs text-ink-faint">
          requestId: <span className="text-ink-soft">{requestId}</span>
        </p>
      )}
      {onRetry !== undefined && (
        <Button variant="secondary" size="sm" className="w-fit" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
