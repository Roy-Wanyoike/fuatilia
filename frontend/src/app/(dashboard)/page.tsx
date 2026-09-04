'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonMetric } from '@/components/ui/skeleton';
import { defaultClient } from '@/lib/api/browser-client';
import type { Refusal } from '@/lib/api/client';
import type { Money } from '@/lib/api/envelope';
import { listAllPayments, listAllReceivables } from '@/lib/api/pagination';
import { deriveOverview, type OverviewSummary } from '@/lib/derivation/command-center';
import { formatMoney } from '@/lib/money';

/**
 * / (Overview) — headline money positions derived from the same typed
 * read models as the Command Center (receivables + payments). Loading /
 * error / empty states are real query states, never fabricated.
 */
export default function OverviewPage() {
  const receivablesQuery = useQuery({
    queryKey: ['api', 'receivables', 'all'],
    queryFn: () => listAllReceivables(defaultClient),
  });
  const paymentsQuery = useQuery({
    queryKey: ['api', 'payments', 'all'],
    queryFn: () => listAllPayments(defaultClient),
  });

  const receivablesResult = receivablesQuery.data;
  const paymentsResult = paymentsQuery.data;
  const bothLoaded =
    receivablesResult?.ok === true &&
    paymentsResult?.ok === true &&
    !receivablesQuery.isPending &&
    !paymentsQuery.isPending;

  const summary: OverviewSummary | null = bothLoaded
    ? deriveOverview({
        receivables: receivablesResult.data.rows,
        payments: paymentsResult.data.rows,
      })
    : null;

  const receivablesRefusal: Refusal | null =
    receivablesResult?.ok === false ? receivablesResult.refusal : null;
  const paymentsRefusal: Refusal | null =
    paymentsResult?.ok === false ? paymentsResult.refusal : null;
  const receivablesEmpty = receivablesResult?.ok === true && receivablesResult.data.rows.length === 0;
  const paymentsEmpty = paymentsResult?.ok === true && paymentsResult.data.rows.length === 0;

  return (
    <section aria-labelledby="overview-heading">
      <h1 id="overview-heading" className="text-lg font-semibold text-ink">
        Overview
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        Headline positions derived from the /v1 read models — actuals only, no predictions.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        <HeadlineCard
          title="Outstanding receivables"
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          empty={receivablesEmpty}
          value={summary === null ? null : summary.outstanding}
          totalLabel="open + partially paid balance"
        />
        <HeadlineCard
          title="Overdue"
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          empty={receivablesEmpty}
          value={summary === null ? null : summary.overdue}
          totalLabel="past-due balance"
        />
        <HeadlineCard
          title="Unmatched cash"
          loading={paymentsQuery.isPending}
          refusal={paymentsRefusal}
          onRetry={() => {
            void paymentsQuery.refetch();
          }}
          empty={paymentsEmpty}
          value={summary === null ? null : summary.unmatchedPayments}
          totalLabel="confirmed but unapplied"
        />
      </div>
    </section>
  );
}

function HeadlineCard({
  title,
  loading,
  refusal,
  onRetry,
  empty,
  value,
  totalLabel,
}: {
  title: string;
  loading: boolean;
  refusal: Refusal | null;
  onRetry: () => void;
  empty: boolean;
  /** null while either source query is still working. */
  value: { count: number; total: Money | null; mixedCurrency: boolean } | null;
  totalLabel: string;
}) {
  return (
    <Card role="region" aria-label={title} aria-busy={loading}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <SkeletonMetric rows={1} />}
        {!loading && refusal !== null && (
          <ErrorState
            title={`${title} is unavailable`}
            code={describeRefusalCode(refusal)}
            requestId={refusalRequestId(refusal)}
            message={refusalMessage(refusal)}
            onRetry={onRetry}
          />
        )}
        {!loading && refusal === null && empty && (
          <EmptyState
            title="Nothing here yet"
            description="The underlying read model returned no rows on this deployment."
          />
        )}
        {!loading && refusal === null && !empty && value !== null && (
          <div>
            <p className="text-3xl font-semibold tabular-nums text-ink">{value.count}</p>
            <p className="mt-1 text-sm text-ink-soft">
              {value.total === null
                ? value.mixedCurrency
                  ? 'mixed currencies — count only (R10)'
                  : 'total beyond exact integer range — count only'
                : `${formatMoney(value.total)} ${totalLabel}`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

