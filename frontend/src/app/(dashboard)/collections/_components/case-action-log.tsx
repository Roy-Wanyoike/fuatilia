'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { CaseView } from '@/lib/api/wire-types';
import { formatTimestamp } from '@/lib/collections/display';
import {
  ACTION_TYPE_LABELS,
  isCaseLive,
  TRANSITION_LABELS,
} from '@/lib/collections/state-machine';

/**
 * The SEALED LOG (issue #135) — the case's append-only records as the wire
 * returned them: every recorded action (with its completion state), every
 * lifecycle transition, every priority bump. Read-only by definition — the
 * only way a row appears here is the server appending it. Terminal cases
 * carry an explicit seal note (the wire refuses further writes with 409
 * CASE_CLOSED).
 */

export interface CaseActionLogProps {
  caseView: CaseView;
}

export function CaseActionLog({ caseView }: CaseActionLogProps) {
  return (
    <Card aria-labelledby="case-log-heading" data-testid="case-action-log">
      <CardHeader>
        <CardTitle id="case-log-heading" className="text-base">
          The sealed log
        </CardTitle>
        <CardDescription>
          Append-only, as the wire returned it — actions, transitions, priority changes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isCaseLive(caseView.status) && (
          <p className="text-xs text-ink-soft" data-testid="case-log-sealed-note">
            This case is {TRANSITION_LABELS[caseView.status]} — its log is sealed and the wire
            refuses further writes with 409 CASE_CLOSED.
          </p>
        )}

        <section aria-labelledby="case-log-actions-heading">
          <h3 id="case-log-actions-heading" className="text-sm font-medium text-ink">
            Actions ({caseView.actions.length})
          </h3>
          {caseView.actions.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-actions-empty">
              No actions recorded yet.
            </p>
          ) : (
            <div className="mt-1">
              <Table>
                <THead>
                  <TR>
                    <TH scope="col">Type</TH>
                    <TH scope="col">Scheduled</TH>
                    <TH scope="col">Source</TH>
                    <TH scope="col">Consent</TH>
                    <TH scope="col">Outcome</TH>
                    <TH scope="col">State</TH>
                  </TR>
                </THead>
                <TBody>
                  {caseView.actions.map((action) => (
                    <TR key={action.id} data-testid="case-log-action-row">
                      <TD>{ACTION_TYPE_LABELS[action.type]}</TD>
                      <TD className="whitespace-nowrap text-xs">
                        {formatTimestamp(action.scheduledFor)}
                      </TD>
                      <TD>{action.source}</TD>
                      <TD className="font-mono text-xs">
                        {action.consentRef ?? '—'}
                      </TD>
                      <TD className="text-xs">{action.outcome ?? '—'}</TD>
                      <TD>
                        {action.completedAt === null ? (
                          <Badge tone="warning" data-testid="case-log-action-open">
                            awaiting completion
                          </Badge>
                        ) : (
                          <Badge tone="success" data-testid="case-log-action-completed">
                            completed {formatTimestamp(action.completedAt)}
                          </Badge>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          )}
        </section>

        <section aria-labelledby="case-log-history-heading">
          <h3 id="case-log-history-heading" className="text-sm font-medium text-ink">
            Lifecycle history ({caseView.history.length})
          </h3>
          {caseView.history.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-history-empty">
              No transitions recorded yet.
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {caseView.history.map((entry, index) => (
                <li
                  key={`${entry.at}-${index}`}
                  className="rounded-md border border-slate-200 px-3 py-2 text-xs"
                  data-testid="case-log-history-row"
                >
                  <span className="font-medium text-ink">
                    {TRANSITION_LABELS[entry.from]} → {TRANSITION_LABELS[entry.to]}
                  </span>{' '}
                  <span className="text-ink-soft">— “{entry.reason}”</span>{' '}
                  <span className="text-ink-soft">
                    at {formatTimestamp(entry.at)} by <span className="font-mono">{entry.actorId}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="case-log-priority-heading">
          <h3 id="case-log-priority-heading" className="text-sm font-medium text-ink">
            Priority changes ({caseView.priorityChanges.length})
          </h3>
          {caseView.priorityChanges.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-priority-empty">
              No escalations recorded yet.
            </p>
          ) : (
            <ul className="mt-1 space-y-1">
              {caseView.priorityChanges.map((entry, index) => (
                <li
                  key={`${entry.at}-${index}`}
                  className="rounded-md border border-slate-200 px-3 py-2 text-xs"
                  data-testid="case-log-priority-row"
                >
                  <span className="font-medium text-ink">
                    {entry.from} → {entry.to}
                  </span>{' '}
                  <span className="text-ink-soft">— “{entry.reason}”</span>{' '}
                  <span className="text-ink-soft">
                    at {formatTimestamp(entry.at)} by <span className="font-mono">{entry.actorId}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
