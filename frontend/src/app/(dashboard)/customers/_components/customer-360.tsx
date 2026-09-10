'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import {
  CommandCard,
  type CommandCardState,
} from '@/components/command-center/command-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { defaultClient } from '@/lib/api/browser-client';
import type { ApiResult, FuatiliaClient, Refusal } from '@/lib/api/client';
import type { AllRowsResult } from '@/lib/api/pagination';
import { listAllCases, listAllPayments, listAllReceivables } from '@/lib/api/pagination';
import { systemClock, type Clock } from '@/lib/clock';
import type {
  AgingBucket,
  CaseActionSource,
  CaseActionType,
  CasePriority,
  CaseStatus,
  CaseView,
  DerivedCaseStatus,
  PaymentChannel,
  PaymentState,
  PaymentView,
  ReceivableState,
  ReceivableView,
} from '@/lib/api/wire-types';
import {
  attributeCustomerCases,
  BUCKET_ORDER,
  summarizeCustomerPayments,
  summarizeCustomerReceivables,
  type CustomerCasesSummary,
  type CustomerPaymentsSummary,
  type CustomerReceivablesSummary,
} from '@/lib/customers/derive';
import { usePortalT } from '@/lib/portal-i18n/context';
import { formatMoney } from '@/lib/money';

/**
 * Customer 360 (issue #134, screen b) — ONE screen per customer, fed ONLY by
 * the mounted /v1 read models:
 *
 *   - Receivables & aging    GET /v1/receivables   (customerId filter)
 *   - Payments & allocations GET /v1/payments      (customerId filter)
 *   - Cases & promises       GET /v1/collections/cases, attributed through
 *                            receivableIds ∩ the customer's receivable ids
 *   - Comms timeline         case actions across the customer's cases
 *
 * Each section owns its loading / error (code + requestId) / empty / loaded
 * state — a refused source never blanks a sibling (the portal
 * balance-overview discipline). No customer directory, promise read model,
 * or comms endpoint is mounted on /v1, so those views are honest
 * derivations; nothing here is invented. Strings resolve through the shared
 * i18n catalogs (issue #180); wire state/enum badges stay wire values.
 */

const RECEIVABLES_KEY = ['api', 'receivables', 'all'] as const;
const PAYMENTS_KEY = ['api', 'payments', 'all'] as const;
const CASES_KEY = ['api', 'collections', 'cases', 'all'] as const;

export interface Customer360Props {
  customerId: string;
  client?: FuatiliaClient;
  /** Injected for deterministic tests; defaults to the system clock. */
  clock?: Clock;
}

type AllRowsQuery<T> = UseQueryResult<ApiResult<AllRowsResult<T>>>;

export function Customer360({
  customerId,
  client = defaultClient,
  clock = systemClock,
}: Customer360Props) {
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

  const receivablesResult = receivablesQuery.data;
  const paymentsResult = paymentsQuery.data;
  const casesResult = casesQuery.data;

  const receivablesSummary = useMemo<CustomerReceivablesSummary | null>(() => {
    if (receivablesResult?.ok !== true) return null;
    return summarizeCustomerReceivables({
      customerId,
      receivables: receivablesResult.data.rows,
    });
  }, [receivablesResult, customerId]);

  const paymentsSummary = useMemo<CustomerPaymentsSummary | null>(() => {
    if (paymentsResult?.ok !== true) return null;
    return summarizeCustomerPayments({
      customerId,
      payments: paymentsResult.data.rows,
    });
  }, [paymentsResult, customerId]);

  const casesSummary = useMemo<CustomerCasesSummary | null>(() => {
    if (receivablesResult?.ok !== true || casesResult?.ok !== true) return null;
    return attributeCustomerCases(
      {
        customerId,
        receivables: receivablesResult.data.rows,
        cases: casesResult.data.rows,
      },
      clock(),
    );
  }, [receivablesResult, casesResult, customerId, clock]);

  const truncated =
    (receivablesResult?.ok === true && receivablesResult.data.truncated) ||
    (paymentsResult?.ok === true && paymentsResult.data.truncated) ||
    (casesResult?.ok === true && casesResult.data.truncated);

  // Honest unknown-customer state: the /v1 surface has no directory to 404
  // against, so an id with zero attributable receivables AND payments renders
  // a disclosed empty state instead of a fabricated "not found".
  const noAttributableActivity =
    receivablesSummary !== null &&
    paymentsSummary !== null &&
    receivablesSummary.receivables.length === 0 &&
    paymentsSummary.payments.length === 0;

  return (
    <section aria-labelledby="customer-360-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 id="customer-360-heading" className="text-lg font-semibold text-ink">
            {t('dashboard.customers.c360.title')}
          </h1>
          <p className="mt-0.5 font-mono text-sm text-ink-soft" data-testid="customer-id">
            {customerId}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            {t('dashboard.customers.c360.subtitle')}
          </p>
        </div>
        <Link
          href="/customers"
          className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t('dashboard.customers.c360.allCustomers')}
        </Link>
      </div>

      {noAttributableActivity && (
        <div className="mt-4" data-testid="no-customer-activity">
          <EmptyState
            title={t('dashboard.customers.c360.noActivityTitle')}
            description={t('dashboard.customers.c360.noActivityDescription')}
            hint={t('dashboard.customers.c360.noActivityHint')}
          />
        </div>
      )}

      {truncated && (
        <p
          role="status"
          className="mt-4 rounded-md border border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft"
          data-testid="customer-360-truncated"
        >
          {t('dashboard.customers.c360.truncatedNote')}
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ReceivablesSection
          query={receivablesQuery}
          summary={receivablesSummary}
          onRetry={retryAll}
        />
        <PaymentsSection query={paymentsQuery} summary={paymentsSummary} onRetry={retryAll} />
        <CasesSection
          receivablesQuery={receivablesQuery}
          casesQuery={casesQuery}
          summary={casesSummary}
          onRetry={retryAll}
        />
        <CommsSection
          receivablesQuery={receivablesQuery}
          casesQuery={casesQuery}
          summary={casesSummary}
          onRetry={retryAll}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// shared card-state plumbing (mirrors the Command Center's per-card states)
// ---------------------------------------------------------------------------

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

function formatInstant(at: string): string {
  return at.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Count + optional money total, honest about why a total is absent. */
function CountTotalStat({
  label,
  stat,
  testId,
}: {
  label: string;
  stat: { count: number; total: import('@/lib/api/envelope').Money | null; mixedCurrency: boolean };
  testId?: string;
}) {
  const t = usePortalT();
  return (
    <div data-testid={testId}>
      <p className="text-2xl font-semibold tabular-nums text-ink">{stat.count}</p>
      <p className="mt-0.5 text-xs text-ink-soft">
        {stat.total === null ? (
          stat.count === 0 ? (
            // Zero rows is not a refused total — say so instead of claiming one.
            <>
              {label} {t('dashboard.customers.c360.statFallbacks.noRows')}
            </>
          ) : stat.mixedCurrency ? (
            <>
              {label} {t('dashboard.customers.c360.statFallbacks.mixed')}
            </>
          ) : (
            <>
              {label} {t('dashboard.customers.c360.statFallbacks.range')}
            </>
          )
        ) : (
          <>
            {label} · <span className="font-semibold text-ink">{formatMoney(stat.total)}</span>
          </>
        )}
      </p>
    </div>
  );
}

/** Aging-bucket → badge tone (deeper buckets are hotter). */
function bucketTone(bucket: AgingBucket): BadgeTone {
  if (bucket === '90+') return 'danger';
  if (bucket === '61-90') return 'warning';
  return 'neutral';
}

const RECEIVABLE_STATE_TONES: Record<ReceivableState, BadgeTone> = {
  draft: 'neutral',
  open: 'info',
  partially_paid: 'info',
  settled: 'success',
  recovered: 'success',
  written_off: 'danger',
  uncollectible: 'danger',
  voided: 'neutral',
};

const PAYMENT_STATE_TONES: Record<PaymentState, BadgeTone> = {
  initiated: 'neutral',
  pending_confirmation: 'neutral',
  confirmed: 'success',
  partially_allocated: 'info',
  allocated: 'success',
  unapplied: 'warning',
  failed: 'danger',
  reversed: 'danger',
  partially_refunded: 'warning',
  refunded: 'warning',
};

const CASE_STATUS_TONES: Record<CaseStatus, BadgeTone> = {
  open: 'info',
  in_progress: 'info',
  resolved: 'success',
  closed_inactive: 'neutral',
};

const CASE_PRIORITY_TONES: Record<CasePriority, BadgeTone> = {
  low: 'neutral',
  normal: 'neutral',
  high: 'warning',
  urgent: 'danger',
};

const DERIVED_STATUS_TONES: Record<DerivedCaseStatus, BadgeTone> = {
  open: 'info',
  in_progress: 'info',
  resolved: 'success',
  closed_inactive: 'neutral',
  waiting: 'neutral',
  promised: 'warning',
  disputed: 'danger',
};

const ACTION_TYPE_TONES: Record<CaseActionType, BadgeTone> = {
  call: 'info',
  sms: 'info',
  whatsapp: 'info',
  letter: 'neutral',
  fieldVisit: 'warning',
  escalation: 'danger',
};

function sourceTone(source: CaseActionSource): BadgeTone {
  return source === 'automated' ? 'info' : 'neutral';
}

// ---------------------------------------------------------------------------
// 1. Receivables & aging
// ---------------------------------------------------------------------------

function ReceivablesSection({
  query,
  summary,
  onRetry,
}: {
  query: AllRowsQuery<ReceivableView>;
  summary: CustomerReceivablesSummary | null;
  onRetry: () => void;
}) {
  const t = usePortalT();
  const source = sourceRows(query);
  let state: CommandCardState;
  if (source.status === 'loading') {
    state = { kind: 'loading' };
  } else if (source.status === 'error') {
    state = {
      kind: 'error',
      refusal: source.refusal,
      title: t('dashboard.customers.c360.receivables.errorTitle'),
      onRetry,
    };
  } else if (source.rows.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.receivables.emptyDeploymentTitle'),
      description: t('dashboard.customers.c360.receivables.emptyDeploymentDescription'),
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.receivables.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.receivables.emptyCustomerTitle'),
      description: t('dashboard.customers.c360.receivables.emptyCustomerDescription'),
    };
  } else {
    state = { kind: 'loaded', content: <ReceivablesContent summary={summary} /> };
  }

  return (
    <CommandCard
      title={t('dashboard.customers.c360.receivables.cardTitle')}
      question={t('dashboard.customers.c360.receivables.question')}
      derivation={t('dashboard.customers.c360.receivables.derivation')}
      state={state}
    />
  );
}

function ReceivablesContent({ summary }: { summary: CustomerReceivablesSummary }) {
  const t = usePortalT();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <CountTotalStat
          label={t('dashboard.customers.c360.stats.outstanding')}
          stat={summary.outstanding}
          testId="stat-outstanding"
        />
        <CountTotalStat
          label={t('dashboard.customers.c360.stats.overdue')}
          stat={summary.overdue}
          testId="stat-overdue"
        />
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {t('dashboard.customers.c360.agingTitle')}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="aging-buckets">
          {BUCKET_ORDER.map((bucket) => {
            const stat = summary.agingBuckets[bucket];
            return (
              <span
                key={bucket}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-surface-sunk/40 px-2 py-1 text-xs"
              >
                <Badge tone={bucketTone(bucket)}>{bucket}</Badge>
                <span className="tabular-nums text-ink-soft">
                  {stat.count} ·{' '}
                  {stat.total === null
                    ? stat.count === 0
                      ? '—' // an empty bucket is empty, not a refused total
                      : stat.mixedCurrency
                        ? t('dashboard.customers.c360.agingMixed')
                        : t('dashboard.customers.c360.agingRange')
                    : formatMoney(stat.total)}
                </span>
              </span>
            );
          })}
        </div>
        {summary.terminalCount > 0 && (
          <p className="mt-1.5 text-xs text-ink-faint">
            {t(
              summary.terminalCount === 1
                ? 'dashboard.customers.c360.terminalOne'
                : 'dashboard.customers.c360.terminalMany',
              { count: summary.terminalCount },
            )}
          </p>
        )}
      </div>

      <Table>
        <THead>
          <TR>
            <TH scope="col">{t('dashboard.customers.c360.receivables.col.invoice')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.receivables.col.state')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.receivables.col.balance')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.receivables.col.due')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.receivables.col.aging')}</TH>
          </TR>
        </THead>
        <TBody>
          {summary.receivables.map((receivable) => (
            <TR key={receivable.id}>
              <TD className="font-mono text-xs">{receivable.invoiceId}</TD>
              <TD>
                <Badge tone={RECEIVABLE_STATE_TONES[receivable.state]}>{receivable.state}</Badge>
                {receivable.overdue && (
                  <Badge tone="warning" className="ml-1.5">
                    {t('dashboard.customers.c360.overdueBadge')}
                  </Badge>
                )}
              </TD>
              <TD className="tabular-nums">{formatMoney(receivable.balance)}</TD>
              <TD>
                <time dateTime={receivable.dueDate} className="text-xs text-ink-soft">
                  {formatInstant(receivable.dueDate)}
                </time>
              </TD>
              <TD>
                {receivable.aging === null ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <>
                    <Badge tone={bucketTone(receivable.aging.bucket)}>
                      {receivable.aging.bucket}
                    </Badge>
                    <span className="ml-1.5 text-xs text-ink-faint">
                      {receivable.aging.daysPastDue}d
                    </span>
                  </>
                )}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Payment history & allocations
// ---------------------------------------------------------------------------

function PaymentsSection({
  query,
  summary,
  onRetry,
}: {
  query: AllRowsQuery<PaymentView>;
  summary: CustomerPaymentsSummary | null;
  onRetry: () => void;
}) {
  const t = usePortalT();
  const source = sourceRows(query);
  let state: CommandCardState;
  if (source.status === 'loading') {
    state = { kind: 'loading' };
  } else if (source.status === 'error') {
    state = {
      kind: 'error',
      refusal: source.refusal,
      title: t('dashboard.customers.c360.payments.errorTitle'),
      onRetry,
    };
  } else if (source.rows.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.payments.emptyDeploymentTitle'),
      description: t('dashboard.customers.c360.payments.emptyDeploymentDescription'),
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.payments.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.payments.emptyCustomerTitle'),
      description: t('dashboard.customers.c360.payments.emptyCustomerDescription'),
    };
  } else {
    state = { kind: 'loaded', content: <PaymentsContent summary={summary} /> };
  }

  return (
    <CommandCard
      title={t('dashboard.customers.c360.payments.cardTitle')}
      question={t('dashboard.customers.c360.payments.question')}
      derivation={t('dashboard.customers.c360.payments.derivation')}
      state={state}
    />
  );
}

function PaymentsContent({ summary }: { summary: CustomerPaymentsSummary }) {
  const t = usePortalT();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <CountTotalStat
          label={t('dashboard.customers.c360.stats.confirmed')}
          stat={summary.confirmed}
          testId="stat-confirmed"
        />
        <CountTotalStat
          label={t('dashboard.customers.c360.stats.heldOnAccount')}
          stat={summary.heldOnAccount}
          testId="stat-held-on-account"
        />
      </div>

      <ol className="flex flex-col divide-y divide-slate-100" data-testid="payment-history">
        {summary.payments.map((payment) => (
          <li key={payment.id} className="flex flex-col gap-1.5 py-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={PAYMENT_STATE_TONES[payment.state]}>{payment.state}</Badge>
              <Badge tone="neutral">{payment.channel}</Badge>
              <span className="font-mono text-xs text-ink-soft">{payment.externalRef}</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
              <span className="tabular-nums font-semibold text-ink">
                {payment.confirmed === null ? (
                  <>
                    {formatMoney(payment.requested)}{' '}
                    <span className="font-normal text-ink-faint">
                      {t('dashboard.customers.c360.paymentRow.requestedLabel')}
                    </span>
                  </>
                ) : (
                  <>
                    {formatMoney(payment.confirmed)}{' '}
                    <span className="font-normal text-ink-faint">
                      {t('dashboard.customers.c360.paymentRow.confirmedLabel')}
                    </span>
                  </>
                )}
              </span>
              {payment.unapplied.minor > 0 && (
                <span className="tabular-nums text-xs text-ink-soft">
                  {t('dashboard.customers.c360.paymentRow.unappliedSuffix', {
                    amount: formatMoney(payment.unapplied),
                  })}
                </span>
              )}
              <time dateTime={payment.initiatedAt} className="text-xs text-ink-soft">
                {t('dashboard.customers.c360.paymentRow.initiatedPrefix', {
                  at: formatInstant(payment.initiatedAt),
                })}
              </time>
            </div>
            {payment.failureCode !== null && payment.failureCode.length > 0 && (
              <p className="text-xs text-danger">
                {t('dashboard.customers.c360.paymentRow.failureCodePrefix')}{' '}
                <span className="font-mono">{payment.failureCode}</span>
              </p>
            )}
            {payment.reversalReason !== null && payment.reversalReason.length > 0 && (
              <p className="text-xs text-ink-soft">
                {t('dashboard.customers.c360.paymentRow.reversalReasonPrefix')}{' '}
                {payment.reversalReason}
              </p>
            )}
            {(payment.allocations.length > 0 || payment.refunds.length > 0) && (
              <ul className="space-y-1" data-testid={`payment-${payment.id}-ledger`}>
                {payment.allocations.map((allocation) => (
                  <li
                    key={allocation.id}
                    className="rounded bg-surface-sunk/40 px-2 py-1 text-xs text-ink-soft"
                  >
                    <span className="tabular-nums font-semibold text-ink">
                      {formatMoney(allocation.amount)}
                    </span>{' '}
                    {t('dashboard.customers.c360.paymentRow.appliedTo', {
                      id: allocation.receivableId,
                    })}{' '}
                    <time dateTime={allocation.recordedAt}>
                      · {formatInstant(allocation.recordedAt)}
                    </time>
                  </li>
                ))}
                {payment.refunds.map((refund) => (
                  <li
                    key={refund.id}
                    className="rounded bg-surface-sunk/40 px-2 py-1 text-xs text-ink-soft"
                  >
                    <span className="tabular-nums font-semibold text-ink">
                      {formatMoney(refund.amount)}
                    </span>{' '}
                    {t('dashboard.customers.c360.paymentRow.refunded')}
                    {refund.reason.length > 0 ? <> — {refund.reason}</> : null}{' '}
                    <time dateTime={refund.recordedAt}>
                      · {formatInstant(refund.recordedAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Collections cases & promises
// ---------------------------------------------------------------------------

function CasesSection({
  receivablesQuery,
  casesQuery,
  summary,
  onRetry,
}: {
  receivablesQuery: AllRowsQuery<ReceivableView>;
  casesQuery: AllRowsQuery<CaseView>;
  summary: CustomerCasesSummary | null;
  onRetry: () => void;
}) {
  const casesSource = sourceRows(casesQuery);
  const receivablesSource = sourceRows(receivablesQuery);
  const t = usePortalT();
  let state: CommandCardState;
  if (casesSource.status === 'loading' || receivablesSource.status === 'loading') {
    state = { kind: 'loading' };
  } else if (casesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: casesSource.refusal,
      title: t('dashboard.customers.c360.cases.errorTitle'),
      onRetry,
    };
  } else if (receivablesSource.status === 'error') {
    // Cases link to a customer only through receivableIds — without the
    // receivable rows, attribution is impossible and the section says so.
    state = {
      kind: 'error',
      refusal: receivablesSource.refusal,
      title: t('dashboard.customers.c360.cases.attributionErrorTitle'),
      onRetry,
    };
  } else if (casesSource.rows.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.cases.emptyDeploymentTitle'),
      description: t('dashboard.customers.c360.cases.emptyDeploymentDescription'),
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.cases.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.cases.emptyCustomerTitle'),
      description: t('dashboard.customers.c360.cases.emptyCustomerDescription'),
    };
  } else {
    state = { kind: 'loaded', content: <CasesContent summary={summary} /> };
  }

  return (
    <CommandCard
      title={t('dashboard.customers.c360.cases.cardTitle')}
      question={t('dashboard.customers.c360.cases.question')}
      derivation={t('dashboard.customers.c360.cases.derivation')}
      state={state}
    />
  );
}

function CasesContent({ summary }: { summary: CustomerCasesSummary }) {
  const t = usePortalT();
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft" data-testid="open-case-count">
        <span className="font-semibold text-ink">{summary.openCaseCount}</span>{' '}
        {t('dashboard.customers.c360.openCaseCountSuffix', { total: summary.cases.length })}
      </p>

      <Table>
        <THead>
          <TR>
            <TH scope="col">{t('dashboard.customers.c360.cases.col.case')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.cases.col.priority')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.cases.col.status')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.cases.col.actions')}</TH>
            <TH scope="col">{t('dashboard.customers.c360.cases.col.opened')}</TH>
          </TR>
        </THead>
        <TBody>
          {summary.cases.map((openedCase) => (
            <TR key={openedCase.id}>
              <TD className="font-mono text-xs">{openedCase.caseNumber}</TD>
              <TD>
                <Badge tone={CASE_PRIORITY_TONES[openedCase.priority]}>{openedCase.priority}</Badge>
              </TD>
              <TD>
                <Badge tone={CASE_STATUS_TONES[openedCase.status]}>{openedCase.status}</Badge>
                <Badge tone={DERIVED_STATUS_TONES[openedCase.derivedStatus]} className="ml-1.5">
                  {openedCase.derivedStatus}
                </Badge>
              </TD>
              <TD className="tabular-nums">{openedCase.actions.length}</TD>
              <TD>
                <time dateTime={openedCase.openedAt} className="text-xs text-ink-soft">
                  {formatInstant(openedCase.openedAt)}
                </time>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          {t('dashboard.customers.c360.promises.title')}
        </p>
        {summary.promises.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">
            {t('dashboard.customers.c360.promises.empty')}
          </p>
        ) : (
          <ul className="mt-1.5 space-y-1.5" data-testid="promises">
            {summary.promises.map((promise) => (
              <li
                key={promise.caseId}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-soft"
              >
                <span className="font-mono text-ink">{promise.caseNumber}</span>
                {promise.missed ? (
                  <Badge tone="danger">{t('dashboard.customers.c360.promises.missed')}</Badge>
                ) : promise.dueNow ? (
                  <Badge tone="warning">{t('dashboard.customers.c360.promises.dueNow')}</Badge>
                ) : (
                  <Badge tone="neutral">{t('dashboard.customers.c360.promises.scheduled')}</Badge>
                )}
                {promise.nextActionAt === null ? (
                  <span>{t('dashboard.customers.c360.promises.noPendingFollowUp')}</span>
                ) : (
                  <time dateTime={promise.nextActionAt}>
                    {t('dashboard.customers.c360.promises.nextFollowUp', {
                      at: formatInstant(promise.nextActionAt),
                    })}
                  </time>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Communications timeline (case actions)
// ---------------------------------------------------------------------------

function CommsSection({
  receivablesQuery,
  casesQuery,
  summary,
  onRetry,
}: {
  receivablesQuery: AllRowsQuery<ReceivableView>;
  casesQuery: AllRowsQuery<CaseView>;
  summary: CustomerCasesSummary | null;
  onRetry: () => void;
}) {
  const casesSource = sourceRows(casesQuery);
  const receivablesSource = sourceRows(receivablesQuery);
  const t = usePortalT();
  let state: CommandCardState;
  if (casesSource.status === 'loading' || receivablesSource.status === 'loading') {
    state = { kind: 'loading' };
  } else if (casesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: casesSource.refusal,
      title: t('dashboard.customers.c360.comms.errorTitle'),
      onRetry,
    };
  } else if (receivablesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: receivablesSource.refusal,
      title: t('dashboard.customers.c360.comms.attributionErrorTitle'),
      onRetry,
    };
  } else if (casesSource.rows.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.comms.emptyDeploymentTitle'),
      description: t('dashboard.customers.c360.comms.emptyDeploymentDescription'),
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.comms.length === 0) {
    state = {
      kind: 'empty',
      title: t('dashboard.customers.c360.comms.emptyCustomerTitle'),
      description: t('dashboard.customers.c360.comms.emptyCustomerDescription'),
    };
  } else {
    state = { kind: 'loaded', content: <CommsContent summary={summary} /> };
  }

  return (
    <CommandCard
      title={t('dashboard.customers.c360.comms.cardTitle')}
      question={t('dashboard.customers.c360.comms.question')}
      derivation={t('dashboard.customers.c360.comms.derivation')}
      state={state}
    />
  );
}

function CommsContent({ summary }: { summary: CustomerCasesSummary }) {
  const t = usePortalT();
  return (
    <ol className="flex flex-col divide-y divide-slate-100" data-testid="comms-timeline">
      {summary.comms.map((entry) => (
        <li key={entry.key} className="flex flex-col gap-1 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ACTION_TYPE_TONES[entry.type]}>{entry.type}</Badge>
            <Badge tone={sourceTone(entry.source)}>{entry.source}</Badge>
            <span className="font-mono text-xs text-ink-soft">{entry.caseNumber}</span>
            {entry.completedAt === null ? (
              <Badge tone="warning">{t('dashboard.customers.c360.commsRow.pending')}</Badge>
            ) : (
              <Badge tone="success">{t('dashboard.customers.c360.commsRow.completed')}</Badge>
            )}
          </div>
          <p className="text-xs text-ink-soft">
            <time dateTime={entry.scheduledFor}>
              {t('dashboard.customers.c360.commsRow.scheduledAt', {
                at: formatInstant(entry.scheduledFor),
              })}
            </time>
            {entry.completedAt !== null && (
              <>
                {' · '}
                <time dateTime={entry.completedAt}>
                  {t('dashboard.customers.c360.commsRow.completedAt', {
                    at: formatInstant(entry.completedAt),
                  })}
                </time>
              </>
            )}
          </p>
          {entry.outcome !== null && entry.outcome.length > 0 && (
            <p className="break-words text-xs text-ink">{entry.outcome}</p>
          )}
          {entry.consentRef !== null && entry.consentRef.length > 0 && (
            <p className="font-mono text-xs text-ink-faint">
              {t('dashboard.customers.c360.commsRow.consentRefPrefix')} {entry.consentRef}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
