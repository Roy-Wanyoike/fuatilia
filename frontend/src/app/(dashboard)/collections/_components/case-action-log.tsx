'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { CaseView } from '@/lib/api/wire-types';
import { formatTimestamp } from '@/lib/collections/display';
import { usePortalT } from '@/lib/portal-i18n/context';
import { isCaseLive } from '@/lib/collections/state-machine';
import {
  CASE_ACTION_TYPE_LABEL_KEYS,
  CASE_STATUS_LABEL_KEYS,
} from './case-labels';

/**
 * The SEALED LOG (issue #135) — the case's append-only records as the wire
 * returned them: every recorded action (with its completion state), every
 * lifecycle transition, every priority bump. Read-only by definition — the
 * only way a row appears here is the server appending it. Terminal cases
 * carry an explicit seal note (the wire refuses further writes with 409
 * CASE_CLOSED). Strings resolve through the shared i18n catalogs
 * (issue #180); action sources stay wire values.
 */

export interface CaseActionLogProps {
  caseView: CaseView;
}

export function CaseActionLog({ caseView }: CaseActionLogProps) {
  const t = usePortalT();
  return (
    <Card aria-labelledby="case-log-heading" data-testid="case-action-log">
      <CardHeader>
        <CardTitle id="case-log-heading" className="text-base">
          {t('dashboard.collections.log.title')}
        </CardTitle>
        <CardDescription>{t('dashboard.collections.log.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isCaseLive(caseView.status) && (
          <p className="text-xs text-ink-soft" data-testid="case-log-sealed-note">
            {t('dashboard.collections.log.sealedNote', {
              status: t(CASE_STATUS_LABEL_KEYS[caseView.status]),
            })}
          </p>
        )}

        <section aria-labelledby="case-log-actions-heading">
          <h3 id="case-log-actions-heading" className="text-sm font-medium text-ink">
            {t('dashboard.collections.log.actionsTitle', { count: caseView.actions.length })}
          </h3>
          {caseView.actions.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-actions-empty">
              {t('dashboard.collections.log.actionsEmpty')}
            </p>
          ) : (
            <div className="mt-1">
              <Table>
                <THead>
                  <TR>
                    <TH scope="col">{t('dashboard.collections.log.col.type')}</TH>
                    <TH scope="col">{t('dashboard.collections.log.col.scheduled')}</TH>
                    <TH scope="col">{t('dashboard.collections.log.col.source')}</TH>
                    <TH scope="col">{t('dashboard.collections.log.col.consent')}</TH>
                    <TH scope="col">{t('dashboard.collections.log.col.outcome')}</TH>
                    <TH scope="col">{t('dashboard.collections.log.col.state')}</TH>
                  </TR>
                </THead>
                <TBody>
                  {caseView.actions.map((action) => (
                    <TR key={action.id} data-testid="case-log-action-row">
                      <TD>{t(CASE_ACTION_TYPE_LABEL_KEYS[action.type])}</TD>
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
                            {t('dashboard.collections.log.awaitingCompletion')}
                          </Badge>
                        ) : (
                          <Badge tone="success" data-testid="case-log-action-completed">
                            {t('dashboard.collections.log.completedAt', {
                              at: formatTimestamp(action.completedAt),
                            })}
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
            {t('dashboard.collections.log.historyTitle', { count: caseView.history.length })}
          </h3>
          {caseView.history.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-history-empty">
              {t('dashboard.collections.log.historyEmpty')}
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
                    {t('dashboard.collections.log.historyFromTo', {
                      from: t(CASE_STATUS_LABEL_KEYS[entry.from]),
                      to: t(CASE_STATUS_LABEL_KEYS[entry.to]),
                    })}
                  </span>{' '}
                  <span className="text-ink-soft">
                    {t('dashboard.collections.log.historyReason', { reason: entry.reason })}
                  </span>{' '}
                  <span className="text-ink-soft">
                    {t('dashboard.collections.log.historyMeta', {
                      at: formatTimestamp(entry.at),
                      actor: entry.actorId,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="case-log-priority-heading">
          <h3 id="case-log-priority-heading" className="text-sm font-medium text-ink">
            {t('dashboard.collections.log.priorityTitle', {
              count: caseView.priorityChanges.length,
            })}
          </h3>
          {caseView.priorityChanges.length === 0 ? (
            <p className="mt-1 text-xs text-ink-soft" data-testid="case-log-priority-empty">
              {t('dashboard.collections.log.priorityEmpty')}
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
                  <span className="text-ink-soft">
                    {t('dashboard.collections.log.historyReason', { reason: entry.reason })}
                  </span>{' '}
                  <span className="text-ink-soft">
                    {t('dashboard.collections.log.historyMeta', {
                      at: formatTimestamp(entry.at),
                      actor: entry.actorId,
                    })}
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
