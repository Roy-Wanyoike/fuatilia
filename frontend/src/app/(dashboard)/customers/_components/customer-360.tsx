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
 * derivations; nothing here is invented.
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
            Customer 360
          </h1>
          <p className="mt-0.5 font-mono text-sm text-ink-soft" data-testid="customer-id">
            {customerId}
          </p>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Receivables, payments, cases and communications attributed to this customer — fed
            only by the mounted /v1 read models.
          </p>
        </div>
        <Link
          href="/customers"
          className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          All customers
        </Link>
      </div>

      {noAttributableActivity && (
        <div className="mt-4" data-testid="no-customer-activity">
          <EmptyState
            title="No /v1 activity is attributable to this customer id"
            description="No receivable or payment row carries this customerId, and cases can only be attributed through receivables. The id is either unknown to this deployment or has no activity yet."
            hint="The /v1 contract mounts no customer directory, so an unknown id cannot be distinguished from an inactive one — nothing is fabricated either way."
          />
        </div>
      )}

      {truncated && (
        <p
          role="status"
          className="mt-4 rounded-md border border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft"
          data-testid="customer-360-truncated"
        >
          Large dataset: the read path stopped at the payload-conscious page cap, so this view
          covers the fetched rows only.
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
  return (
    <div data-testid={testId}>
      <p className="text-2xl font-semibold tabular-nums text-ink">{stat.count}</p>
      <p className="mt-0.5 text-xs text-ink-soft">
        {stat.total === null ? (
          stat.count === 0 ? (
            // Zero rows is not a refused total — say so instead of claiming one.
            <>{label} · no rows yet</>
          ) : stat.mixedCurrency ? (
            <>
              {label} · mixed currencies — count only (R10: no cross-currency totals)
            </>
          ) : (
            <>{label} · beyond exact integer range — count only</>
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
  const source = sourceRows(query);
  let state: CommandCardState;
  if (source.status === 'loading') {
    state = { kind: 'loading' };
  } else if (source.status === 'error') {
    state = {
      kind: 'error',
      refusal: source.refusal,
      title: 'Receivables are unavailable',
      onRetry,
    };
  } else if (source.rows.length === 0) {
    state = {
      kind: 'empty',
      title: 'No receivables on this deployment yet',
      description:
        'The /v1/receivables read model returned an empty first page. Rows arrive through the invoicing flow.',
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.receivables.length === 0) {
    state = {
      kind: 'empty',
      title: 'No receivables carry this customer id',
      description:
        'The receivable read model has rows, but none of the fetched pages attributes this customerId.',
    };
  } else {
    state = { kind: 'loaded', content: <ReceivablesContent summary={summary} /> };
  }

  return (
    <CommandCard
      title="Receivables & aging"
      question="What does this customer owe, and how deep is it aged?"
      derivation="GET /v1/receivables — customerId filter; aging over open|partially_paid rows (settled money is never aged)"
      state={state}
    />
  );
}

function ReceivablesContent({ summary }: { summary: CustomerReceivablesSummary }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <CountTotalStat label="outstanding" stat={summary.outstanding} testId="stat-outstanding" />
        <CountTotalStat label="overdue" stat={summary.overdue} testId="stat-overdue" />
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
          Aging buckets (outstanding balance)
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
                        ? 'mixed currencies (R10)'
                        : 'beyond exact range'
                    : formatMoney(stat.total)}
                </span>
              </span>
            );
          })}
        </div>
        {summary.terminalCount > 0 && (
          <p className="mt-1.5 text-xs text-ink-faint">
            {summary.terminalCount} further receivable
            {summary.terminalCount === 1 ? '' : 's'} settled, written off or otherwise closed.
          </p>
        )}
      </div>

      <Table>
        <THead>
          <TR>
            <TH scope="col">Invoice</TH>
            <TH scope="col">State</TH>
            <TH scope="col">Balance</TH>
            <TH scope="col">Due</TH>
            <TH scope="col">Aging</TH>
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
                    overdue
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
  const source = sourceRows(query);
  let state: CommandCardState;
  if (source.status === 'loading') {
    state = { kind: 'loading' };
  } else if (source.status === 'error') {
    state = {
      kind: 'error',
      refusal: source.refusal,
      title: 'Payment history is unavailable',
      onRetry,
    };
  } else if (source.rows.length === 0) {
    state = {
      kind: 'empty',
      title: 'No payments on this deployment yet',
      description:
        'The /v1/payments read model returned an empty first page. Money arrives through the Daraja intake funnel.',
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.payments.length === 0) {
    state = {
      kind: 'empty',
      title: 'No payments carry this customer id',
      description:
        'The payment read model has rows, but none of the fetched pages attributes this customerId (payments without a customerId are unattributable).',
    };
  } else {
    state = { kind: 'loaded', content: <PaymentsContent summary={summary} /> };
  }

  return (
    <CommandCard
      title="Payment history & allocations"
      question="What money moved, and where was it applied?"
      derivation="GET /v1/payments — customerId filter; allocations flattened from allocations[] rows"
      state={state}
    />
  );
}

function PaymentsContent({ summary }: { summary: CustomerPaymentsSummary }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <CountTotalStat label="confirmed" stat={summary.confirmed} testId="stat-confirmed" />
        <CountTotalStat
          label="held on account"
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
                    <span className="font-normal text-ink-faint">requested</span>
                  </>
                ) : (
                  <>
                    {formatMoney(payment.confirmed)}{' '}
                    <span className="font-normal text-ink-faint">confirmed</span>
                  </>
                )}
              </span>
              {payment.unapplied.minor > 0 && (
                <span className="tabular-nums text-xs text-ink-soft">
                  {formatMoney(payment.unapplied)} unapplied
                </span>
              )}
              <time dateTime={payment.initiatedAt} className="text-xs text-ink-soft">
                initiated {formatInstant(payment.initiatedAt)}
              </time>
            </div>
            {payment.failureCode !== null && payment.failureCode.length > 0 && (
              <p className="text-xs text-danger">
                failure code: <span className="font-mono">{payment.failureCode}</span>
              </p>
            )}
            {payment.reversalReason !== null && payment.reversalReason.length > 0 && (
              <p className="text-xs text-ink-soft">reversal reason: {payment.reversalReason}</p>
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
                    applied to receivable{' '}
                    <span className="font-mono">{allocation.receivableId}</span>{' '}
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
                    refunded
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
  let state: CommandCardState;
  if (casesSource.status === 'loading' || receivablesSource.status === 'loading') {
    state = { kind: 'loading' };
  } else if (casesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: casesSource.refusal,
      title: 'Collections cases are unavailable',
      onRetry,
    };
  } else if (receivablesSource.status === 'error') {
    // Cases link to a customer only through receivableIds — without the
    // receivable rows, attribution is impossible and the section says so.
    state = {
      kind: 'error',
      refusal: receivablesSource.refusal,
      title: 'Case attribution is unavailable',
      onRetry,
    };
  } else if (casesSource.rows.length === 0) {
    state = {
      kind: 'empty',
      title: 'No collections cases yet',
      description:
        'GET /v1/collections/cases returned an empty first page — open a case to start tracking.',
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.cases.length === 0) {
    state = {
      kind: 'empty',
      title: "No cases touch this customer's receivables",
      description:
        'Cases link to customers only through receivableIds; none of the fetched cases covers this customer\u2019s receivables.',
    };
  } else {
    state = { kind: 'loaded', content: <CasesContent summary={summary} /> };
  }

  return (
    <CommandCard
      title="Collections cases & promises"
      question="Is this customer in active collections, and what did they promise?"
      derivation="GET /v1/collections/cases — attributed via receivableIds; promises from the derivedStatus overlay + earliest uncompleted action"
      state={state}
    />
  );
}

function CasesContent({ summary }: { summary: CustomerCasesSummary }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-soft" data-testid="open-case-count">
        <span className="font-semibold text-ink">{summary.openCaseCount}</span> open (
        {summary.cases.length} total incl. resolved/closed)
      </p>

      <Table>
        <THead>
          <TR>
            <TH scope="col">Case</TH>
            <TH scope="col">Priority</TH>
            <TH scope="col">Status</TH>
            <TH scope="col">Actions</TH>
            <TH scope="col">Opened</TH>
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
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">Promises</p>
        {summary.promises.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">No live promised cases.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5" data-testid="promises">
            {summary.promises.map((promise) => (
              <li
                key={promise.caseId}
                className="flex flex-wrap items-center gap-2 text-xs text-ink-soft"
              >
                <span className="font-mono text-ink">{promise.caseNumber}</span>
                {promise.missed ? (
                  <Badge tone="danger">missed</Badge>
                ) : promise.dueNow ? (
                  <Badge tone="warning">due now</Badge>
                ) : (
                  <Badge tone="neutral">scheduled</Badge>
                )}
                {promise.nextActionAt === null ? (
                  <span>no pending follow-up</span>
                ) : (
                  <time dateTime={promise.nextActionAt}>
                    next follow-up {formatInstant(promise.nextActionAt)}
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
  let state: CommandCardState;
  if (casesSource.status === 'loading' || receivablesSource.status === 'loading') {
    state = { kind: 'loading' };
  } else if (casesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: casesSource.refusal,
      title: 'The communications timeline is unavailable',
      onRetry,
    };
  } else if (receivablesSource.status === 'error') {
    state = {
      kind: 'error',
      refusal: receivablesSource.refusal,
      title: 'Comms attribution is unavailable',
      onRetry,
    };
  } else if (casesSource.rows.length === 0) {
    state = {
      kind: 'empty',
      title: 'No collections cases yet',
      description:
        'The communications log derives from case actions, and the case read model is empty.',
    };
  } else if (summary === null) {
    state = { kind: 'loading' };
  } else if (summary.comms.length === 0) {
    state = {
      kind: 'empty',
      title: 'No case actions for this customer yet',
      description:
        "The customer's cases carry no recorded actions (calls, messages, letters, visits, escalations) yet.",
    };
  } else {
    state = { kind: 'loaded', content: <CommsContent summary={summary} /> };
  }

  return (
    <CommandCard
      title="Communications timeline"
      question="What has been said, sent and scheduled with this customer?"
      derivation="case actions of attributed cases — GET /v1/collections/cases (actions[]; no dedicated comms endpoint is mounted)"
      state={state}
    />
  );
}

function CommsContent({ summary }: { summary: CustomerCasesSummary }) {
  return (
    <ol className="flex flex-col divide-y divide-slate-100" data-testid="comms-timeline">
      {summary.comms.map((entry) => (
        <li key={entry.key} className="flex flex-col gap-1 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ACTION_TYPE_TONES[entry.type]}>{entry.type}</Badge>
            <Badge tone={sourceTone(entry.source)}>{entry.source}</Badge>
            <span className="font-mono text-xs text-ink-soft">{entry.caseNumber}</span>
            {entry.completedAt === null ? (
              <Badge tone="warning">pending</Badge>
            ) : (
              <Badge tone="success">completed</Badge>
            )}
          </div>
          <p className="text-xs text-ink-soft">
            <time dateTime={entry.scheduledFor}>scheduled {formatInstant(entry.scheduledFor)}</time>
            {entry.completedAt !== null && (
              <>
                {' · '}
                <time dateTime={entry.completedAt}>
                  completed {formatInstant(entry.completedAt)}
                </time>
              </>
            )}
          </p>
          {entry.outcome !== null && entry.outcome.length > 0 && (
            <p className="break-words text-xs text-ink">{entry.outcome}</p>
          )}
          {entry.consentRef !== null && entry.consentRef.length > 0 && (
            <p className="font-mono text-xs text-ink-faint">consent ref: {entry.consentRef}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
