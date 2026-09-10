'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import {
  CommandCard,
  type CommandCardState,
} from '@/components/command-center/command-card';
import { defaultClient } from '@/lib/api/browser-client';
import type { AllRowsResult } from '@/lib/api/pagination';
import { listAllCases, listAllPayments, listAllReceivables } from '@/lib/api/pagination';
import type { ApiResult, FuatiliaClient, Refusal } from '@/lib/api/client';
import type { Money } from '@/lib/api/envelope';
import type { CaseView, PaymentView, ReceivableView } from '@/lib/api/wire-types';
import { systemClock, type Clock } from '@/lib/clock';
import {
  deriveCommandCenter,
  type CommandCenterSummary,
} from '@/lib/derivation/command-center';
import { usePortalT } from '@/lib/portal-i18n/context';
import { formatMoney } from '@/lib/money';

/**
 * Collections Command Center v1 (issue #76) — the flagship read path.
 * "What should my collections team do right now?"
 *
 * Seven sections, each fed ONLY by the typed client over the /v1 contract:
 *   1. Expected collections today   — GET /v1/receivables
 *   2. Overdue                      — GET /v1/receivables
 *   3. At-risk                      — GET /v1/receivables
 *   4. Promises due                 — GET /v1/collections/cases
 *   5. Missed promises              — GET /v1/collections/cases
 *   6. Unmatched payments           — GET /v1/payments
 *   7. High-value opportunities     — GET /v1/receivables
 *
 * When the backend is unreachable every card renders its REAL error state
 * (tagged refusal + requestId) — fabricated business rows are impossible by
 * construction because this component holds no data other than query
 * results. Strings resolve through the shared i18n catalogs (issue #180);
 * wire enum badges stay wire values.
 */

export interface CollectionsScreenProps {
  client?: FuatiliaClient;
  /** Injected for deterministic tests; defaults to the system clock. */
  clock?: Clock;
}

type AllRowsQuery<T> = UseQueryResult<ApiResult<AllRowsResult<T>>>;

const RECEIVABLES_KEY = ['api', 'receivables', 'all'] as const;
const PAYMENTS_KEY = ['api', 'payments', 'all'] as const;
const CASES_KEY = ['api', 'collections', 'cases', 'all'] as const;

export function CollectionsScreen({
  client = defaultClient,
  clock = systemClock,
}: CollectionsScreenProps) {
  const t = usePortalT();
  const receivablesQuery = useQuery({
    queryKey: RECEIVABLES_KEY,
    queryFn: () => listAllReceivables(client),
  });
  const paymentsQuery = useQuery({
    queryKey: PAYMENTS_KEY,
    queryFn: () => listAllPayments(client),
  });
  const casesQuery = useQuery({
    queryKey: CASES_KEY,
    queryFn: () => listAllCases(client),
  });

  const retryAll = () => {
    void receivablesQuery.refetch();
    void paymentsQuery.refetch();
    void casesQuery.refetch();
  };

  const summary = useMemo<CommandCenterSummary | null>(() => {
    if (
      receivablesQuery.data?.ok !== true ||
      paymentsQuery.data?.ok !== true ||
      casesQuery.data?.ok !== true
    ) {
      return null;
    }
    return deriveCommandCenter(
      {
        receivables: receivablesQuery.data.data.rows,
        payments: paymentsQuery.data.data.rows,
        cases: casesQuery.data.data.rows,
      },
      clock(),
    );
  }, [receivablesQuery.data, paymentsQuery.data, casesQuery.data, clock]);

  const truncated =
    (receivablesQuery.data?.ok === true && receivablesQuery.data.data.truncated) ||
    (paymentsQuery.data?.ok === true && paymentsQuery.data.data.truncated) ||
    (casesQuery.data?.ok === true && casesQuery.data.data.truncated);

  return (
    <section aria-labelledby="command-center-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="command-center-heading" className="text-lg font-semibold text-ink">
            {t('dashboard.commandCenter.title')}
          </h1>
          <p className="mt-0.5 text-sm text-ink-soft">
            {t('dashboard.commandCenter.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary !== null && (
            <span className="text-xs text-ink-faint" data-testid="command-center-asof">
              {t('dashboard.commandCenter.asOf', { day: summary.todayKey })}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={retryAll}
            disabled={receivablesQuery.isFetching || paymentsQuery.isFetching || casesQuery.isFetching}
          >
            {t('dashboard.commandCenter.refresh')}
          </Button>
        </div>
      </div>

      {truncated && (
        <p className="mt-2 rounded-md border border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft" role="status">
          {t('dashboard.commandCenter.truncatedNote')}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ExpectedTodayCard
          query={receivablesQuery}
          summary={summary}
          onRetry={retryAll}
        />
        <OverdueCard query={receivablesQuery} summary={summary} onRetry={retryAll} />
        <AtRiskCard query={receivablesQuery} summary={summary} onRetry={retryAll} />
        <PromisesDueCard query={casesQuery} summary={summary} onRetry={retryAll} />
        <MissedPromisesCard query={casesQuery} summary={summary} onRetry={retryAll} />
        <UnmatchedPaymentsCard query={paymentsQuery} summary={summary} onRetry={retryAll} />
        <OpportunitiesCard
          query={receivablesQuery}
          summary={summary}
          onRetry={retryAll}
          className="md:col-span-2 xl:col-span-1"
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// shared card-state plumbing
// ---------------------------------------------------------------------------

interface CardProps<T> {
  query: AllRowsQuery<T>;
  summary: CommandCenterSummary | null;
  onRetry: () => void;
}

type SourceRows<T> =
  | { status: 'loading' }
  | { status: 'error'; refusal: Refusal }
  | { status: 'rows'; rows: T[] };

function sourceRows<T>(query: AllRowsQuery<T>): SourceRows<T> {
  if (query.isPending) return { status: 'loading' };
  if (query.data === undefined) {
    return query.isError
      ? { status: 'error', refusal: transportLikeRefusal() }
      : { status: 'loading' };
  }
  if (!query.data.ok) return { status: 'error', refusal: query.data.refusal };
  return { status: 'rows', rows: query.data.data.rows };
}

/** Query-level failures without a client refusal (defensive fallback). */
function transportLikeRefusal(): Refusal {
  return {
    tag: 'transport-error',
    reason: 'network',
    message: 'The query failed before the API client returned a result.',
  };
}

function errorState(
  refusal: Refusal,
  title: string,
  onRetry: () => void,
): CommandCardState {
  return { kind: 'error', refusal, title, onRetry };
}

function emptyOrLoaded<T>(
  source: SourceRows<T>,
  summary: CommandCenterSummary | null,
  opts: {
    title: string;
    onRetry: () => void;
    sourceEmptyTitle: string;
    sourceEmptyDescription: string;
    subsetEmptyTitle: string;
    subsetEmptyDescription: string;
    subsetEmptyHint?: string;
    subsetIsEmpty: (summary: CommandCenterSummary) => boolean;
    loaded: (summary: CommandCenterSummary) => CommandCardState;
  },
): CommandCardState {
  if (source.status === 'loading') return { kind: 'loading' };
  if (source.status === 'error') return errorState(source.refusal, opts.title, opts.onRetry);
  if (source.rows.length === 0) {
    // Source-empty needs no summary — it is decided by the read model alone,
    // so the card settles even while a SIBLING query is refusing.
    return {
      kind: 'empty',
      title: opts.sourceEmptyTitle,
      description: opts.sourceEmptyDescription,
    };
  }
  if (summary === null) return { kind: 'loading' };
  if (opts.subsetIsEmpty(summary)) {
    return {
      kind: 'empty',
      title: opts.subsetEmptyTitle,
      description: opts.subsetEmptyDescription,
      hint: opts.subsetEmptyHint,
    };
  }
  return opts.loaded(summary);
}

// ---------------------------------------------------------------------------
// metric content helpers
// ---------------------------------------------------------------------------

/**
 * Count + optional money total. `total === null` renders the honest reason
 * the number is absent (mixed currencies vs beyond-exact-range); pass
 * `omitTotal` for count-only sections.
 */
function MetricCountTotal({
  count,
  total,
  mixedCurrency = false,
  totalLabel,
  omitTotal = false,
}: {
  count: number;
  total: Money | null;
  mixedCurrency?: boolean;
  totalLabel: string;
  omitTotal?: boolean;
}) {
  const t = usePortalT();
  return (
    <div>
      <p className="text-3xl font-semibold tabular-nums text-ink" data-testid="metric-count">
        {count}
      </p>
      {!omitTotal && (
        <p className="mt-1 text-sm text-ink-soft" data-testid="metric-total">
          {total === null ? (
            mixedCurrency ? (
              t('dashboard.commandCenter.metric.mixedCurrencies')
            ) : (
              t('dashboard.commandCenter.metric.rangeOverflow')
            )
          ) : (
            <>
              {formatMoney(total)} <span className="text-ink-faint">{totalLabel}</span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** Aging-bucket → badge tone (deeper buckets are hotter). */
function bucketTone(bucket: '0-30' | '31-60' | '61-90' | '90+'): 'neutral' | 'warning' | 'danger' {
  if (bucket === '90+') return 'danger';
  if (bucket === '61-90') return 'warning';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// 1. Expected collections today
// ---------------------------------------------------------------------------

function ExpectedTodayCard({ query, summary, onRetry }: CardProps<ReceivableView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.expectedToday.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.expectedToday.sourceEmptyTitle'),
    sourceEmptyDescription: t(
      'dashboard.commandCenter.cards.expectedToday.sourceEmptyDescription',
    ),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.expectedToday.subsetEmptyTitle'),
    subsetEmptyDescription: t(
      'dashboard.commandCenter.cards.expectedToday.subsetEmptyDescription',
    ),
    subsetEmptyHint: t('dashboard.commandCenter.cards.expectedToday.subsetEmptyHint'),
    subsetIsEmpty: (s) => s.expectedToday.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <MetricCountTotal
          count={s.expectedToday.count}
          total={s.expectedToday.total}
          mixedCurrency={s.expectedToday.mixedCurrency}
          totalLabel={t('dashboard.commandCenter.cards.expectedToday.totalLabel')}
        />
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.expectedToday.cardTitle')}
      question={t('dashboard.commandCenter.cards.expectedToday.question')}
      derivation={t('dashboard.commandCenter.cards.expectedToday.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 2. Overdue
// ---------------------------------------------------------------------------

function OverdueCard({ query, summary, onRetry }: CardProps<ReceivableView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.overdue.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.overdue.sourceEmptyTitle'),
    sourceEmptyDescription: t('dashboard.commandCenter.cards.overdue.sourceEmptyDescription'),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.overdue.subsetEmptyTitle'),
    subsetEmptyDescription: t('dashboard.commandCenter.cards.overdue.subsetEmptyDescription'),
    subsetIsEmpty: (s) => s.overdue.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <div className="space-y-3">
          <MetricCountTotal
            count={s.overdue.count}
            total={s.overdue.total}
            mixedCurrency={s.overdue.mixedCurrency}
            totalLabel={t('dashboard.commandCenter.cards.overdue.totalLabel')}
          />
          <div className="flex flex-wrap gap-1.5" data-testid="overdue-buckets">
            {(['0-30', '31-60', '61-90', '90+'] as const).map((bucket) => (
              <Badge key={bucket} tone={bucketTone(bucket)}>
                {t('dashboard.commandCenter.cards.overdue.bucketLabel', {
                  bucket,
                  count: s.overdue.buckets[bucket],
                })}
              </Badge>
            ))}
          </div>
        </div>
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.overdue.cardTitle')}
      question={t('dashboard.commandCenter.cards.overdue.question')}
      derivation={t('dashboard.commandCenter.cards.overdue.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 3. At-risk
// ---------------------------------------------------------------------------

function AtRiskCard({ query, summary, onRetry }: CardProps<ReceivableView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.atRisk.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.atRisk.sourceEmptyTitle'),
    sourceEmptyDescription: t('dashboard.commandCenter.cards.atRisk.sourceEmptyDescription'),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.atRisk.subsetEmptyTitle'),
    subsetEmptyDescription: t('dashboard.commandCenter.cards.atRisk.subsetEmptyDescription'),
    subsetEmptyHint: t('dashboard.commandCenter.cards.atRisk.subsetEmptyHint'),
    subsetIsEmpty: (s) => s.atRisk.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <MetricCountTotal
          count={s.atRisk.count}
          total={s.atRisk.total}
          mixedCurrency={s.atRisk.mixedCurrency}
          totalLabel={t('dashboard.commandCenter.cards.atRisk.totalLabel')}
        />
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.atRisk.cardTitle')}
      question={t('dashboard.commandCenter.cards.atRisk.question')}
      derivation={t('dashboard.commandCenter.cards.atRisk.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 4. Promises due
// ---------------------------------------------------------------------------

function PromisesDueCard({ query, summary, onRetry }: CardProps<CaseView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.promisesDue.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.promisesDue.sourceEmptyTitle'),
    sourceEmptyDescription: t(
      'dashboard.commandCenter.cards.promisesDue.sourceEmptyDescription',
    ),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.promisesDue.subsetEmptyTitle'),
    subsetEmptyDescription: t(
      'dashboard.commandCenter.cards.promisesDue.subsetEmptyDescription',
    ),
    subsetEmptyHint: t('dashboard.commandCenter.cards.promisesDue.subsetEmptyHint'),
    subsetIsEmpty: (s) => s.promisesDue.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <div className="space-y-3">
          <MetricCountTotal count={s.promisesDue.count} total={null} totalLabel="" omitTotal />
          <p className="text-sm text-ink-soft">
            <span className="font-semibold text-ink" data-testid="promises-due-now">
              {s.promisesDue.dueNow}
            </span>{' '}
            {t('dashboard.commandCenter.cards.promisesDue.dueNowSuffix')}
          </p>
          <ul className="flex flex-wrap gap-1.5" data-testid="promises-cases">
            {s.promisesDue.caseNumbers.map((caseNumber) => (
              <li key={caseNumber}>
                <Badge tone="info">{caseNumber}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.promisesDue.cardTitle')}
      question={t('dashboard.commandCenter.cards.promisesDue.question')}
      derivation={t('dashboard.commandCenter.cards.promisesDue.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 5. Missed promises
// ---------------------------------------------------------------------------

function MissedPromisesCard({ query, summary, onRetry }: CardProps<CaseView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.missedPromises.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.missedPromises.sourceEmptyTitle'),
    sourceEmptyDescription: t(
      'dashboard.commandCenter.cards.missedPromises.sourceEmptyDescription',
    ),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.missedPromises.subsetEmptyTitle'),
    subsetEmptyDescription: t(
      'dashboard.commandCenter.cards.missedPromises.subsetEmptyDescription',
    ),
    subsetIsEmpty: (s) => s.missedPromises.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <div className="space-y-3">
          <MetricCountTotal count={s.missedPromises.count} total={null} totalLabel="" omitTotal />
          <ul className="flex flex-wrap gap-1.5" data-testid="missed-cases">
            {s.missedPromises.caseNumbers.map((caseNumber) => (
              <li key={caseNumber}>
                <Badge tone="danger">{caseNumber}</Badge>
              </li>
            ))}
          </ul>
        </div>
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.missedPromises.cardTitle')}
      question={t('dashboard.commandCenter.cards.missedPromises.question')}
      derivation={t('dashboard.commandCenter.cards.missedPromises.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 6. Unmatched payments
// ---------------------------------------------------------------------------

function UnmatchedPaymentsCard({ query, summary, onRetry }: CardProps<PaymentView>) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.unmatchedPayments.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.unmatchedPayments.sourceEmptyTitle'),
    sourceEmptyDescription: t(
      'dashboard.commandCenter.cards.unmatchedPayments.sourceEmptyDescription',
    ),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.unmatchedPayments.subsetEmptyTitle'),
    subsetEmptyDescription: t(
      'dashboard.commandCenter.cards.unmatchedPayments.subsetEmptyDescription',
    ),
    subsetIsEmpty: (s) => s.unmatchedPayments.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <MetricCountTotal
          count={s.unmatchedPayments.count}
          total={s.unmatchedPayments.total}
          mixedCurrency={s.unmatchedPayments.mixedCurrency}
          totalLabel={t('dashboard.commandCenter.cards.unmatchedPayments.totalLabel')}
        />
      ),
    }),
  });
  return (
    <CommandCard
      title={t('dashboard.commandCenter.cards.unmatchedPayments.cardTitle')}
      question={t('dashboard.commandCenter.cards.unmatchedPayments.question')}
      derivation={t('dashboard.commandCenter.cards.unmatchedPayments.derivation')}
      state={state}
    />
  );
}

// ---------------------------------------------------------------------------
// 7. High-value opportunities
// ---------------------------------------------------------------------------

function OpportunitiesCard({
  query,
  summary,
  onRetry,
  className = '',
}: CardProps<ReceivableView> & { className?: string }) {
  const t = usePortalT();
  const source = sourceRows(query);
  const state = emptyOrLoaded(source, summary, {
    title: t('dashboard.commandCenter.cards.opportunities.errorTitle'),
    onRetry,
    sourceEmptyTitle: t('dashboard.commandCenter.cards.opportunities.sourceEmptyTitle'),
    sourceEmptyDescription: t(
      'dashboard.commandCenter.cards.opportunities.sourceEmptyDescription',
    ),
    subsetEmptyTitle: t('dashboard.commandCenter.cards.opportunities.subsetEmptyTitle'),
    subsetEmptyDescription: t(
      'dashboard.commandCenter.cards.opportunities.subsetEmptyDescription',
    ),
    subsetIsEmpty: (s) => s.opportunities.count === 0,
    loaded: (s) => ({
      kind: 'loaded',
      content: (
        <div className="space-y-2">
          <Table aria-label={t('dashboard.commandCenter.cards.opportunities.tableLabel')}>
            <THead>
              <TR>
                <TH scope="col">{t('dashboard.commandCenter.cards.opportunities.col.customer')}</TH>
                <TH scope="col">{t('dashboard.commandCenter.cards.opportunities.col.balance')}</TH>
                <TH scope="col">{t('dashboard.commandCenter.cards.opportunities.col.aging')}</TH>
              </TR>
            </THead>
            <TBody>
              {s.opportunities.focus.map((focus) => (
                <TR key={focus.receivableId}>
                  <TD className="font-mono text-xs">
                    {focus.customerId}
                    {focus.overdue && (
                      <Badge tone="warning" className="ml-2">
                        {t('dashboard.commandCenter.cards.opportunities.overdueBadge')}
                      </Badge>
                    )}
                  </TD>
                  <TD className="tabular-nums">{formatMoney(focus.balance)}</TD>
                  <TD>
                    {focus.bucket === null ? (
                      <span className="text-ink-faint">—</span>
                    ) : (
                      <Badge tone={bucketTone(focus.bucket)}>{focus.bucket}</Badge>
                    )}
                    {focus.daysPastDue !== null && (
                      <span className="ml-1.5 text-xs text-ink-faint">
                        {focus.daysPastDue}d
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <p className="text-xs text-ink-faint">
            {t('dashboard.commandCenter.cards.opportunities.footerTotal', {
              count: s.opportunities.count,
              book:
                s.opportunities.total === null
                  ? t('dashboard.commandCenter.cards.opportunities.bookCountOnly')
                  : formatMoney(s.opportunities.total),
            })}
          </p>
        </div>
      ),
    }),
  });
  return (
    <div className={className}>
      <CommandCard
        title={t('dashboard.commandCenter.cards.opportunities.cardTitle')}
        question={t('dashboard.commandCenter.cards.opportunities.question')}
        derivation={t('dashboard.commandCenter.cards.opportunities.derivation')}
        state={state}
      />
    </div>
  );
}
