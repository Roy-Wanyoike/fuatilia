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
import { formatTimestamp } from '@/lib/collections/display';
import { ACTION_TYPE_LABELS, caseActionLadder } from '@/lib/collections/state-machine';

/**
 * The COMPLETE-ACTION flow (issue #135) — POST /v1/collections/cases/
 * {caseId}/actions/{actionId}/completions. Stamps outcome + completedAt +
 * completedBy on a recorded-but-uncompleted action — EXACTLY once (a
 * re-completion refuses with 409 CASE_ACTION_ALREADY_COMPLETED, surfaced
 * verbatim). The ladder here is the case's own open actions: completed
 * actions are never offered, a case with none gets an honest note instead
 * of a dead form, and a blank outcome is refused locally before the wire.
 */

export interface CaseCompleteActionPanelProps {
  caseView: CaseView;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
  /** Receives the server's post-completion case view (never an invention). */
  onCaseReplaced: (nextCase: CaseView, requestId: string | null) => void;
}

type PanelPhase = 'idle' | 'submitting' | 'completed' | 'refused';

export function CaseCompleteActionPanel({
  caseView,
  writeClient = defaultCollectionsClient,
  onCaseReplaced,
}: CaseCompleteActionPanelProps) {
  const ladder = caseActionLadder(caseView);
  // Defense in depth: an action is completable when the ladder says so AND
  // it self-describes as uncompleted (the wire refuses re-completions with
  // 409 CASE_ACTION_ALREADY_COMPLETED — the UI never offers one).
  const completable = caseView.actions.filter(
    (action) => action.completedAt === null && ladder.completableActionIds.includes(action.id),
  );
  const [actionId, setActionId] = useState<string>('');
  const [outcome, setOutcome] = useState('');
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [refusalState, setRefusalState] = useState<{
    message: string | null;
    code: string;
    requestId: string | null;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [completedLabel, setCompletedLabel] = useState<string | null>(null);

  const effectiveActionId = completable.some((action) => action.id === actionId)
    ? actionId
    : (completable[0]?.id ?? '');

  if (completable.length === 0) {
    return (
      <Card aria-labelledby="case-complete-action-heading" data-testid="case-complete-action-panel">
        <CardHeader>
          <CardTitle id="case-complete-action-heading" className="text-base">
            Complete an action
          </CardTitle>
          <CardDescription>
            POST …/actions/&#123;actionId&#125;/completions — stamp the outcome, exactly once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft" data-testid="case-complete-action-empty">
            {caseView.actions.length === 0
              ? 'No actions recorded on this case yet — record one above, then complete it with its outcome.'
              : 'Every recorded action is already completed — nothing awaits an outcome.'}
          </p>
        </CardContent>
      </Card>
    );
  }

  async function submit(): Promise<void> {
    if (effectiveActionId === '') return;
    if (outcome.trim().length === 0) {
      setLocalError('An outcome is required — a completion stamps what actually happened.');
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    const result = await writeClient.completeCaseAction(caseView.id, effectiveActionId, {
      outcome: outcome.trim(),
    });
    if (result.ok) {
      setRefusalState(null);
      setCompletedLabel(outcome.trim());
      setOutcome('');
      setPhase('completed');
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
    <Card aria-labelledby="case-complete-action-heading" data-testid="case-complete-action-panel">
      <CardHeader>
        <CardTitle id="case-complete-action-heading" className="text-base">
          Complete an action
        </CardTitle>
        <CardDescription>
          POST …/actions/&#123;actionId&#125;/completions — the outcome is stamped exactly once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'completed' && completedLabel !== null && (
          <p
            role="status"
            className="rounded-md border border-ok-soft bg-ok-soft/40 px-4 py-3 text-sm text-ok"
            data-testid="case-complete-action-success"
          >
            Action completed with outcome “{completedLabel}”.
          </p>
        )}

        {phase === 'refused' && refusalState !== null && (
          <ErrorState
            title="Couldn't complete the action"
            message={refusalState.message}
            code={refusalState.code}
            requestId={refusalState.requestId}
          />
        )}

        <div>
          <label htmlFor="case-complete-action-select" className="text-sm font-medium text-ink">
            Action awaiting completion
          </label>
          <select
            id="case-complete-action-select"
            value={effectiveActionId}
            onChange={(event) => setActionId(event.target.value)}
            disabled={phase === 'submitting'}
            className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {completable.map((action) => (
              <option key={action.id} value={action.id}>
                {ACTION_TYPE_LABELS[action.type]} — scheduled {formatTimestamp(action.scheduledFor)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="case-complete-action-outcome" className="text-sm font-medium text-ink">
            Outcome <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="case-complete-action-outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            rows={2}
            required
            disabled={phase === 'submitting'}
            placeholder="What actually happened, e.g. spoke to site foreman — promised part payment"
            className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        {localError !== null && (
          <p
            role="alert"
            className="text-xs text-danger"
            data-testid="case-complete-action-local-error"
          >
            {localError}
          </p>
        )}

        <Button onClick={() => void submit()} disabled={phase === 'submitting'}>
          {phase === 'submitting' ? 'Completing…' : 'Complete action'}
        </Button>
      </CardContent>
    </Card>
  );
}
