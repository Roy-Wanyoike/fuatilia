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
import type { CasePriority, CaseView } from '@/lib/api/wire-types';
import {
  defaultCollectionsClient,
  type CollectionsCaseClient,
} from '@/lib/collections/case-ops';
import { caseActionLadder } from '@/lib/collections/state-machine';

/**
 * The ESCALATION flow (issue #135) — POST /v1/collections/cases/{caseId}/
 * escalations. Escalation CLIMBS: the ladder offers only priorities that
 * rank strictly above the current one (`low < normal < high < urgent`) —
 * sidesteps and downgrades are refused by the wire with 400
 * CASE_ESCALATION_INVALID, so the UI never offers them. A case already at
 * `urgent` gets an honest "top of the ladder" note instead of a form.
 * Reasons are mandatory (blank → local refusal before the wire); refusals
 * surface verbatim with code + requestId; success replaces the case view
 * with the server's post-escalation answer (no optimistic bump).
 */

export interface CaseEscalationPanelProps {
  caseView: CaseView;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
  /** Receives the server's post-escalation case view (never an invention). */
  onCaseReplaced: (nextCase: CaseView, requestId: string | null) => void;
}

type PanelPhase = 'idle' | 'submitting' | 'escalated' | 'refused';

export function CaseEscalationPanel({
  caseView,
  writeClient = defaultCollectionsClient,
  onCaseReplaced,
}: CaseEscalationPanelProps) {
  const ladder = caseActionLadder(caseView);
  const [target, setTarget] = useState<CasePriority | ''>('');
  const [reason, setReason] = useState('');
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [refusalState, setRefusalState] = useState<{
    message: string | null;
    code: string;
    requestId: string | null;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [escalatedTo, setEscalatedTo] = useState<CasePriority | null>(null);

  const effectiveTarget: CasePriority | '' = ladder.escalations.some((p) => p === target)
    ? target
    : (ladder.escalations[0] ?? '');

  if (ladder.escalations.length === 0) {
    return (
      <Card aria-labelledby="case-escalation-heading" data-testid="case-escalation-panel">
        <CardHeader>
          <CardTitle id="case-escalation-heading" className="text-base">
            Escalation
          </CardTitle>
          <CardDescription>
            Strictly upward: low &lt; normal &lt; high &lt; urgent — the wire refuses
            sidesteps and downgrades with 400 CASE_ESCALATION_INVALID.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft" data-testid="case-escalation-exhausted">
            This case is {caseView.priority} — already at the top of the ladder, with nothing
            to escalate to.
          </p>
        </CardContent>
      </Card>
    );
  }

  async function submit(): Promise<void> {
    if (effectiveTarget === '') return;
    if (reason.trim().length === 0) {
      setLocalError('A reason is required — the bump is recorded in the case log.');
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    const result = await writeClient.escalateCase(caseView.id, {
      to: effectiveTarget,
      reason: reason.trim(),
    });
    if (result.ok) {
      setRefusalState(null);
      setEscalatedTo(result.data.priority);
      setPhase('escalated');
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
    <Card aria-labelledby="case-escalation-heading" data-testid="case-escalation-panel">
      <CardHeader>
        <CardTitle id="case-escalation-heading" className="text-base">
          Escalation
        </CardTitle>
        <CardDescription>
          POST …/escalations — strictly upward from {caseView.priority}. Every bump is appended
          to priorityChanges.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'escalated' && escalatedTo !== null && (
          <p
            role="status"
            className="rounded-md border border-ok-soft bg-ok-soft/40 px-4 py-3 text-sm text-ok"
            data-testid="case-escalation-success"
          >
            Case escalated to {escalatedTo}.
          </p>
        )}

        {phase === 'refused' && refusalState !== null && (
          <ErrorState
            title="Couldn't escalate the case"
            message={refusalState.message}
            code={refusalState.code}
            requestId={refusalState.requestId}
          />
        )}

        <fieldset>
          <legend className="text-sm font-medium text-ink">Escalate to</legend>
          <div className="mt-1 space-y-1">
            {ladder.escalations.map((candidate) => (
              <label key={candidate} className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="radio"
                  name="case-escalation-target"
                  value={candidate}
                  checked={effectiveTarget === candidate}
                  onChange={() => setTarget(candidate)}
                  disabled={phase === 'submitting'}
                />
                {candidate}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor="case-escalation-reason" className="text-sm font-medium text-ink">
            Escalation reason <span aria-hidden="true">*</span>
          </label>
          <textarea
            id="case-escalation-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            required
            disabled={phase === 'submitting'}
            placeholder="e.g. 60+ days overdue and site access at risk"
            className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        {localError !== null && (
          <p role="alert" className="text-xs text-danger" data-testid="case-escalation-local-error">
            {localError}
          </p>
        )}

        <Button onClick={() => void submit()} disabled={phase === 'submitting'}>
          {phase === 'submitting' ? 'Escalating…' : `Escalate to ${effectiveTarget}`}
        </Button>
      </CardContent>
    </Card>
  );
}
