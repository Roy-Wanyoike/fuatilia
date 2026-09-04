'use client';

import type { ReactNode } from 'react';
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState, describeRefusalCode } from '@/components/ui/error-state';
import { SkeletonMetric } from '@/components/ui/skeleton';
import type { Refusal } from '@/lib/api/client';

/**
 * One Command Center section. Exactly one of the four states renders:
 *  - loading → skeleton (aria-busy on the region)
 *  - empty   → designed EmptyState (source empty vs subset empty)
 *  - error   → ErrorState carrying the refusal (code + requestId) + retry
 *  - loaded  → the card's real derived content
 */
export type CommandCardState =
  | { kind: 'loading' }
  | { kind: 'empty'; title: string; description: string; hint?: string }
  | { kind: 'error'; refusal: Refusal; title: string; onRetry: () => void }
  | { kind: 'loaded'; content: ReactNode };

export interface CommandCardProps {
  title: string;
  /** The operator question this section answers. */
  question: string;
  /** The contract calls the card is derived from — shown in the footer. */
  derivation: string;
  state: CommandCardState;
}

export function CommandCard({ title, question, derivation, state }: CommandCardProps) {
  return (
    <Card
      role="region"
      aria-label={title}
      aria-busy={state.kind === 'loading'}
      data-card-kind={state.kind}
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{question}</CardDescription>
      </CardHeader>
      <div className="px-4 py-3">
        {state.kind === 'loading' && <SkeletonMetric rows={2} />}
        {state.kind === 'empty' && (
          <EmptyState title={state.title} description={state.description} hint={state.hint} />
        )}
        {state.kind === 'error' && (
          <ErrorState
            title={state.title}
            code={describeRefusalCode(state.refusal)}
            message={refusalMessage(state.refusal)}
            requestId={refusalRequestId(state.refusal)}
            onRetry={state.onRetry}
          />
        )}
        {state.kind === 'loaded' && state.content}
      </div>
      <CardFooter>
        <span className="font-mono">derivation: {derivation}</span>
      </CardFooter>
    </Card>
  );
}

function refusalMessage(refusal: Refusal): string | null {
  switch (refusal.tag) {
    case 'api-error':
    case 'unknown-error':
      return refusal.message;
    case 'transport-error':
      return `The API could not be reached (${refusal.reason}).`;
    case 'decoding-error':
      return refusal.message;
  }
}

function refusalRequestId(refusal: Refusal): string | null {
  switch (refusal.tag) {
    case 'api-error':
    case 'unknown-error':
    case 'decoding-error':
      return refusal.requestId;
    case 'transport-error':
      return null;
  }
}
