'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import type { CaseView } from '@/lib/api/wire-types';
import {
  defaultCollectionsClient,
  type CollectionsCaseClient,
} from '@/lib/collections/case-ops';
import { caseActionLadder, TRANSITION_LABELS } from '@/lib/collections/state-machine';

/**
 * The TRANSITION flow (issue #135) — POST /v1/collections/cases/{caseId}/
 * transitions. The UI can only ever offer the legal edges of the case state
 * machine (`caseActionLadder`): open → in_progress, in_progress → resolved |
 * closed_inactive; terminal cases expose an empty ladder and this panel says
 * so instead of rendering a dead form. Every step carries a reason — blank
 * reasons are refused locally BEFORE the wire (the wire would answer 400
 * CASE_REASON_REQUIRED), and wire refusals surface verbatim with code +
 * requestId. No optimistic state: the panel is done only when the server
 * answers with the post-transition case view, which replaces the current one.
 */

export interface CaseTransitionPanelProps {
  caseView: CaseView;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
  /** Receives the server's post-transition case view (never an invention). */
  onCaseReplaced: (nextCase: CaseView, requestId: string | null) => void;
}

type PanelPhase = 'idle' | 'submitting' | 'moved' | 'refused';

export function CaseTransitionPanel({
  caseView,
  writeClient = defaultCollectionsClient,
  onCaseReplaced,
}: CaseTransitionPanelProps) {
  const ladder = caseActionLadder(caseView);
  const [target, setTarget] = useState<string>('');
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [refusalState, setRefusalState] = useState<{
    message: string | null;
    code: string;
    requestId: string | null;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [movedTo, setMovedTo] = useState<string | null>(null);

  const effectiveTarget = ladder.transitions.some((t) => t.to === target)
    ? target
    : (ladder.transitions[0]?.to ?? '');

  if (ladder.transitions.length === 0) {
    return (
      <Card aria-labelledby="case-transition-heading" data-testid="case-transition-panel">
        <CardHeader>
          <CardTitle id="case-transition-heading" className="text-base">
            Lifecycle
          </CardTitle>
          <CardDescription>
            Legal edges only: open → in_progress, in_progress → resolved | closed_inactive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft" data-testid="case-transition-sealed">
            This case is {TRANSITION_LABELS[caseView.status]} — a terminal state takes no
            edges, so there is nothing to transition.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function submit(): Promise<void> {
    if (effectiveTarget === '') return;
    if (reason.trim().length === 0) {
      setLocalError('A reason is required — the transition is recorded in the case history.');
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    const result = await writeClient.transitionCase(caseView.id, {
      to: effectiveTarget as CaseView['status'],
      reason: reason.trim(),
    });
    if (result.ok) {
      setRefusalState(null);
      setMovedTo(TRANSITION_LABELS[result.data.status]);
      setPhase('moved');
      onCaseReplaced(result.data, result.requestId);
      return;
    }
    setRefusalState({
      message: refusalMessage(result.refusal),
      code: describeRefusalCode(result.refusal),
      requestId: refusalRequestId(result.refusal),
    });
    setPhase('refused');
  }

  return (
    <Card aria-labelledby="case-transition-heading" data-testid="case-transition-panel">
      <CardHeader>
        <CardTitle id="case-transition-heading" className="text-base">
          Lifecycle
        </CardTitle>
        <CardDescription>
          POST …/transitions — move along a legal edge. The decision, its reason and actor are
          appended to the case history.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'moved' && movedTo !== null && (
          <p
            role="status"
            className="rounded-md border border-ok-soft bg-ok-soft/40 px-4 py-3 text-sm text-ok"
            data-testid="case-transition-success"
          >
            Case moved to {movedTo}.
          </p>
        )}

        {phase === 'refused' && refusalState !== null && (
          <ErrorState
            title="Couldn't move the case"
            message={refusalState.message}
            code={refusalState.code}
            requestId={refusalState.requestId}
          />
        )}

        <fieldset>
          <legend className="text-sm font-medium text-ink">Move to</legend>
          <div className="mt-1 space-y-1">
            {ladder.transitions.map((edge) => (
              <label key={edge.to} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="case-transition-target"
                  value={edge.to}
                  checked={effectiveTarget === edge.to}
                  onChange={() => setTarget(edge.to)}
                  disabled={phase === 'submitting'}
                />
                {edge.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="case-transition-reason" className="text-sm font-medium text-ink">
            Transition reason (appended to the case history){' '}
            <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="case-transition-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            required
            disabled={phase === 'submitting'}
            placeholder="Why the case is moving (recorded in the history log)"
            className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        {localError !== null && (
          <p role="alert" className="text-xs text-danger" data-testid="case-transition-local-error">
            {localError}
          </p>
        )}

        <Button onClick={() => void submit()} disabled={phase === 'submitting'}>
          {phase === 'submitting'
            ? 'Moving…'
            : `Move to ${TRANSITION_LABELS[effectiveTarget as CaseView['status']] ?? effectiveTarget}`}
        </Button>
      </CardContent>
    </Card>
  );
}
