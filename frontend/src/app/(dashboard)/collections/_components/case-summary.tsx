'use client';

import type { Refusal, FuatiliaClient } from '@/lib/api/client';
import type { CaseView, ReceivableView } from '@/lib/api/wire-types';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { formatTimestamp } from '@/lib/collections/display';
import { formatMoney, sumMoney } from '@/lib/money';
import { usePortalT } from '@/lib/portal-i18n/context';
import type { Money } from '@/lib/api/envelope';
import {
  CasePriorityBadge,
  CaseStatusBadge,
  DerivedStatusBadge,
} from './case-badges';

/**
 * The case summary (issue #135) — identity, the three state-machine badges
 * (status / derived / priority, shared tone semantics with the list), the
 * lifecycle timestamps, and the money. Money is NEVER invented here: the
 * covered receivables are fetched from the real read model and rendered
 * from integer minor units via lib/money (exact BigInt arithmetic, R10).
 * A total exists ONLY when every covered receivable loaded and the
 * balances share one currency — otherwise the panel says so honestly.
 * Strings resolve through the shared i18n catalogs (issue #180); the
 * receivable state badge stays a wire value.
 */

export type ReceivablesForCase =
  | { phase: 'loading' }
  | { phase: 'error'; refusal: Refusal; retry: () => void }
  | { phase: 'loaded'; receivables: ReceivableView[] };

export interface CaseSummaryProps {
  caseView: CaseView;
  receivables: ReceivablesForCase;
}

export function CaseSummary({ caseView, receivables }: CaseSummaryProps) {
  const t = usePortalT();
  const balances: Money[] =
    receivables.phase === 'loaded' ? receivables.receivables.map((r) => r.balance) : [];
  const total = receivables.phase === 'loaded' ? sumMoney(balances) : null;

  return (
    <Card aria-labelledby="case-summary-heading" data-testid="case-summary">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle id="case-summary-heading" className="text-base">
            <span className="font-mono">{caseView.caseNumber}</span>
          </CardTitle>
          <CardDescription>
            <span className="font-mono">{caseView.id}</span>{' '}
            {t('dashboard.collections.summary.collectorPrefix')}{' '}
            <span className="font-mono">{caseView.collectorId}</span>
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <CaseStatusBadge status={caseView.status} />
          <DerivedStatusBadge derived={caseView.derivedStatus} />
          <CasePriorityBadge priority={caseView.priority} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2" data-testid="case-summary-facts">
          <div className="flex gap-2">
            <dt className="text-ink-soft">{t('dashboard.collections.summary.opened')}</dt>
            <dd className="text-ink">{formatTimestamp(caseView.openedAt)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-ink-soft">{t('dashboard.collections.summary.openedBy')}</dt>
            <dd className="font-mono text-ink">{caseView.openedBy}</dd>
          </div>
          {caseView.closedAt !== null && (
            <div className="flex gap-2">
              <dt className="text-ink-soft">{t('dashboard.collections.summary.closed')}</dt>
              <dd className="text-ink">{formatTimestamp(caseView.closedAt)}</dd>
            </div>
          )}
          {caseView.closedBy !== null && (
            <div className="flex gap-2">
              <dt className="text-ink-soft">{t('dashboard.collections.summary.closedBy')}</dt>
              <dd className="font-mono text-ink">{caseView.closedBy}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-ink-soft">{t('dashboard.collections.summary.coveredReceivables')}</dt>
            <dd className="text-ink">{caseView.receivableIds.length}</dd>
          </div>
        </dl>

        {receivables.phase === 'loading' && (
          <div aria-busy="true" data-testid="case-summary-loading">
            <SkeletonRows rows={2} />
          </div>
        )}

        {receivables.phase === 'error' && (
          <div data-testid="case-summary-receivables-error">
            <ErrorState
              title={t('dashboard.collections.summary.receivablesRefusedTitle')}
              message={refusalMessage(receivables.refusal)}
              code={describeRefusalCode(receivables.refusal)}
              requestId={refusalRequestId(receivables.refusal)}
              onRetry={receivables.retry}
            />
          </div>
        )}

        {receivables.phase === 'loaded' && (
          <div data-testid="case-summary-receivables">
            <ul className="space-y-1">
              {receivables.receivables.map((receivable) => (
                <li
                  key={receivable.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-xs"
                  data-testid="case-receivable-row"
                >
                  <span className="font-mono text-ink">{receivable.id}</span>
                  <span className="text-ink-soft">
                    {receivable.state}
                    {receivable.overdue
                      ? ` ${t('dashboard.collections.summary.overdueSuffix')}`
                      : ''}
                  </span>
                  <span className="font-semibold tabular-nums text-ink">
                    {formatMoney(receivable.balance)}
                  </span>
                </li>
              ))}
            </ul>
            {total !== null ? (
              <p className="mt-2 text-sm font-semibold text-ink" data-testid="case-balance-total">
                {t('dashboard.collections.summary.outstandingTotal', {
                  total: formatMoney(total),
                })}
              </p>
            ) : (
              <p className="mt-2 text-xs text-ink-soft" data-testid="case-money-unavailable">
                {t('dashboard.collections.summary.noSingleTotal')}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
