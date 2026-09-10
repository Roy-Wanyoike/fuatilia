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
import { CASE_ACTION_SOURCES, type CaseActionType, type CaseView } from '@/lib/api/wire-types';
import {
  defaultCollectionsClient,
  type CollectionsCaseClient,
} from '@/lib/collections/case-ops';
import { formatTimestamp, scheduledForToIso } from '@/lib/collections/display';
import {
  ACTION_TYPE_LABELS,
  caseActionLadder,
  defaultSourceFor,
  requiresDunningConsent,
} from '@/lib/collections/state-machine';

/**
 * The RECORD-ACTION flow (issue #135) — POST /v1/collections/cases/{caseId}/
 * actions. Appends one action to the case's sealed log; the server answers
 * 201 with BOTH the post-append case AND the action. Contract rules the UI
 * mirrors (the server stays the source of truth):
 *
 *  - `scheduledFor` is a contract date-time with explicit offset — the
 *    collector types Nairobi wall time and `scheduledForToIso` emits
 *    `+03:00` (Fuatilia's home market is UTC+3 fixed, no DST).
 *  - the RecordActionBody default `source` per type (spec: outbound types
 *    default to `automated` — forgetting the flag must not bypass consent),
 *    and switching the type resets the source to that default.
 *  - K2 dunning consent: automated OUTBOUND sends (sms/whatsapp) REQUIRE a
 *    consentRef — the wire refuses 403 DUNNING_CONSENT_REQUIRED ("nothing
 *    was sent"), which surfaces verbatim.
 *
 * No optimistic append: the log grows only when the server's answer lands.
 */

export interface CaseRecordActionPanelProps {
  caseView: CaseView;
  /** Write client (case ops); defaults to the process-wide collections client. */
  writeClient?: CollectionsCaseClient;
  /** Receives the server's post-append case view (never an invention). */
  onCaseReplaced: (nextCase: CaseView, requestId: string | null) => void;
}

type PanelPhase = 'idle' | 'submitting' | 'recorded' | 'refused';

export function CaseRecordActionPanel({
  caseView,
  writeClient = defaultCollectionsClient,
  onCaseReplaced,
}: CaseRecordActionPanelProps) {
  const ladder = caseActionLadder(caseView);
  const [type, setType] = useState<CaseActionType>('call');
  const [scheduledFor, setScheduledFor] = useState('');
  const [source, setSource] = useState<(typeof CASE_ACTION_SOURCES)[number]>(
    defaultSourceFor('call'),
  );
  const [consentRef, setConsentRef] = useState('');
  const [outcome, setOutcome] = useState('');
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [refusalState, setRefusalState] = useState<{
    message: string | null;
    code: string;
    requestId: string | null;
  } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [recordedMessage, setRecordedMessage] = useState<string | null>(null);

  if (ladder.recordableTypes.length === 0) {
    return (
      <Card aria-labelledby="case-record-action-heading" data-testid="case-record-action-panel">
        <CardHeader>
          <CardTitle id="case-record-action-heading" className="text-base">
            Record an action
          </CardTitle>
          <CardDescription>
            POST …/actions — append to the case&apos;s action log.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-soft" data-testid="case-record-action-sealed">
            This case is {caseView.status} — its action log is sealed (the wire refuses further
            writes with 409 CASE_CLOSED).
          </p>
        </CardContent>
      </Card>
    );
  }

  const consentRequired = requiresDunningConsent(type, source);

  function changeType(next: CaseActionType): void {
    setType(next);
    // Spec default per type: outbound → automated, everything else manual.
    setSource(defaultSourceFor(next));
  }

  async function submit(): Promise<void> {
    const iso = scheduledForToIso(scheduledFor);
    if (iso === null) {
      setLocalError('Enter a valid schedule date and time.');
      return;
    }
    if (consentRequired && consentRef.trim().length === 0) {
      setLocalError(
        'An automated outbound send requires a dunning consent reference (K2) — nothing may be sent without one.',
      );
      return;
    }
    setLocalError(null);
    setPhase('submitting');
    const result = await writeClient.recordCaseAction(caseView.id, {
      type,
      scheduledFor: iso,
      source,
      ...(consentRequired ? { consentRef: consentRef.trim() } : {}),
      ...(outcome.trim().length > 0 ? { outcome: outcome.trim() } : {}),
    });
    if (result.ok) {
      setRefusalState(null);
      // The server's appended action is the truth; format its schedule
      // BEFORE the local field resets (the message outlives the input).
      const appended = result.data.action;
      const label = ACTION_TYPE_LABELS[appended?.type ?? type];
      const when = formatTimestamp(appended?.scheduledFor ?? iso);
      setRecordedMessage(`${label} recorded — scheduled for ${when}.`);
      setPhase('recorded');
      setScheduledFor('');
      setConsentRef('');
      setOutcome('');
      onCaseReplaced(result.data.case, result.requestId);
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
    <Card aria-labelledby="case-record-action-heading" data-testid="case-record-action-panel">
      <CardHeader>
        <CardTitle id="case-record-action-heading" className="text-base">
          Record an action
        </CardTitle>
        <CardDescription>
          POST …/actions — one entry per send/attempt, appended to the sealed log.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {phase === 'recorded' && recordedMessage !== null && (
          <p
            role="status"
            className="rounded-md border border-ok-soft bg-ok-soft/40 px-4 py-3 text-sm text-ok"
            data-testid="case-record-action-success"
          >
            {recordedMessage}
          </p>
        )}

        {phase === 'refused' && refusalState !== null && (
          <ErrorState
            title="Couldn't record the action"
            message={refusalState.message}
            code={refusalState.code}
            requestId={refusalState.requestId}
          />
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label htmlFor="case-action-type" className="text-sm font-medium text-ink">
              Type
            </label>
            <select
              id="case-action-type"
              value={type}
              onChange={(event) => changeType(event.target.value as CaseActionType)}
              disabled={phase === 'submitting'}
              className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {ladder.recordableTypes.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {ACTION_TYPE_LABELS[candidate]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="case-action-scheduled" className="text-sm font-medium text-ink">
              Scheduled for (Nairobi time) <span aria-hidden="true">*</span>
            </label>
            <input
              id="case-action-scheduled"
              type="datetime-local"
              value={scheduledFor}
              onChange={(event) => setScheduledFor(event.target.value)}
              required
              disabled={phase === 'submitting'}
              className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
          </div>
          <div>
            <label htmlFor="case-action-source" className="text-sm font-medium text-ink">
              Source
            </label>
            <select
              id="case-action-source"
              value={source}
              onChange={(event) => setSource(event.target.value as (typeof CASE_ACTION_SOURCES)[number])}
              disabled={phase === 'submitting'}
              className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {CASE_ACTION_SOURCES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </div>
        </div>

        {consentRequired && (
          <div>
            <label htmlFor="case-action-consent" className="text-sm font-medium text-ink">
              Dunning consent reference (K2) <span aria-hidden="true">*</span>
            </label>
            <input
              id="case-action-consent"
              type="text"
              value={consentRef}
              onChange={(event) => setConsentRef(event.target.value)}
              required
              disabled={phase === 'submitting'}
              placeholder="Active consent reference for automated outbound dunning"
              className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <p className="mt-1 text-xs text-ink-soft">
              Automated sms/whatsapp dunning requires an active consent reference — without one
              the wire refuses 403 DUNNING_CONSENT_REQUIRED and nothing is sent.
            </p>
          </div>
        )}

        <div>
          <label htmlFor="case-action-outcome" className="text-sm font-medium text-ink">
            Outcome (optional — usually stamped when completing)
          </label>
          <textarea
            id="case-action-outcome"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            rows={2}
            disabled={phase === 'submitting'}
            className="mt-1 w-full rounded-md border border-slate-300 bg-surface-raised px-3 py-2 text-sm text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        {localError !== null && (
          <p role="alert" className="text-xs text-danger" data-testid="case-record-action-local-error">
            {localError}
          </p>
        )}

        <Button onClick={() => void submit()} disabled={phase === 'submitting'}>
          {phase === 'submitting' ? 'Recording…' : 'Record action'}
        </Button>
      </CardContent>
    </Card>
  );
}
