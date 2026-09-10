'use client';

/**
 * The clean REFUSED surface for the collector sign-in gate (issue #133):
 * rendered when the pasted session credential was not accepted by the live
 * API. It surfaces the contract code + requestId — never invented copy
 * pretending the credential was merely "still being checked". The form
 * stays mounted above it so the collector can correct the credential and
 * retry (a refused credential never yields a cookie, so there is no
 * session to sign out of here).
 *
 * Mirror of app/(portal)/_components/access-refused.tsx — kept lane-local
 * so the two route groups never import across each other.
 */

export interface AccessRefusedProps {
  /** Short human title, e.g. "This session credential was not accepted". */
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
    </div>
  );
}
