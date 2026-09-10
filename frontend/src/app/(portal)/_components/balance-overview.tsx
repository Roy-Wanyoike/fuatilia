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
import { listAllPayments, listAllReceivables } from '@/lib/api/pagination';
import type { FuatiliaClient, Refusal } from '@/lib/api/client';
import type { Money } from '@/lib/api/envelope';
import { portalClient } from '@/lib/portal/browser-client';
import { derivePortalBalance, type PortalCountTotal } from '@/lib/portal/derive';
import { formatMoney } from '@/lib/money';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Balance overview (issue #86 view a): outstanding / overdue / payments
 * held on account, derived from GET /v1/receivables + GET /v1/payments
 * (bounded pagination walk). Every card renders one REAL state — loading,
 * refused (401/403), error (code + requestId), empty, or loaded — never a
 * fabricated number. Money is exact integer minor units via lib/money.ts;
 * mixed-currency books refuse to be totaled and say so (R10).
 */

export function BalanceOverview({ client = portalClient }: { client?: FuatiliaClient }) {
  const receivablesQuery = useQuery({
    queryKey: ['portal', 'receivables', 'all'],
    queryFn: () => listAllReceivables(client),
  });
  const paymentsQuery = useQuery({
    queryKey: ['portal', 'payments', 'all'],
    queryFn: () => listAllPayments(client),
  });

  const receivablesResult = receivablesQuery.data;
  const paymentsResult = paymentsQuery.data;

  // Each headline derives from its OWN read model only: a refusal in one
  // source must never blank the other card's real data — every card renders
  // its own state (loading / refused / error / empty / loaded), never a
  // fabricated number and never an empty shell pretending to be loaded.
  const receivableSummary =
    receivablesResult?.ok === true && !receivablesQuery.isPending
      ? derivePortalBalance({ receivables: receivablesResult.data.rows, payments: [] })
      : null;
  const paymentSummary =
    paymentsResult?.ok === true && !paymentsQuery.isPending
      ? derivePortalBalance({ receivables: [], payments: paymentsResult.data.rows })
      : null;

  const receivablesRefusal: Refusal | null =
    receivablesResult?.ok === false ? receivablesResult.refusal : null;
  const paymentsRefusal: Refusal | null =
    paymentsResult?.ok === false ? paymentsResult.refusal : null;
  const receivablesSourceEmpty =
    receivablesResult?.ok === true && receivablesResult.data.rows.length === 0;
  const paymentsSourceEmpty =
    paymentsResult?.ok === true && paymentsResult.data.rows.length === 0;

  return (
    <section aria-labelledby="portal-balance-heading">
      <h1 id="portal-balance-heading" className="text-lg font-semibold text-ink">
        Your balance
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        What you owe, what is overdue, and payments held on your account — actuals from the
        billing system, nothing estimated.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <BalanceCard
          title="Outstanding"
          caption="left to pay across open invoices"
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          refusedTitle="Your balance is not available"
          refusedDescription="This portal session was refused access to your billing data."
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          sourceEmpty={receivablesSourceEmpty}
          sourceEmptyCopy={{ title: 'No invoices on file yet', description: 'Nothing has been billed to your account so far.' }}
          subsetEmptyCopy={{ title: 'Nothing outstanding', description: 'Every invoice on your account is settled.' }}
          value={receivableSummary === null ? null : receivableSummary.outstanding}
        />
        <BalanceCard
          title="Overdue"
          caption="past the due date"
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          refusedTitle="Your overdue position is not available"
          refusedDescription="This portal session was refused access to your billing data."
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          sourceEmpty={receivablesSourceEmpty}
          sourceEmptyCopy={{ title: 'No invoices on file yet', description: 'Nothing has been billed to your account so far.' }}
          subsetEmptyCopy={{ title: 'Nothing overdue', description: 'All your invoices are on schedule.' }}
          value={receivableSummary === null ? null : receivableSummary.overdue}
        />
        <BalanceCard
          title="Held on account"
          caption="paid but not yet applied to an invoice"
          loading={paymentsQuery.isPending}
          refusal={paymentsRefusal}
          refusedTitle="Your payments are not available"
          refusedDescription="This portal session was refused access to your payment data."
          onRetry={() => {
            void paymentsQuery.refetch();
          }}
          sourceEmpty={paymentsSourceEmpty}
          sourceEmptyCopy={{ title: 'No payments on file yet', description: 'No payments have been received on your account so far.' }}
          subsetEmptyCopy={{ title: 'Nothing held on account', description: 'Every payment received has been applied to your invoices.' }}
          value={paymentSummary === null ? null : paymentSummary.heldOnAccount}
        />
      </div>
    </section>
  );
}

type CardCopy = { title: string; description: string };

function BalanceCard({
  title,
  caption,
  loading,
  refusal,
  refusedTitle,
  refusedDescription,
  onRetry,
  sourceEmpty,
  sourceEmptyCopy,
  subsetEmptyCopy,
  value,
}: {
  title: string;
  caption: string;
  loading: boolean;
  refusal: Refusal | null;
  refusedTitle: string;
  refusedDescription: string;
  onRetry: () => void;
  sourceEmpty: boolean;
  sourceEmptyCopy: CardCopy;
  subsetEmptyCopy: CardCopy;
  /** null while the source queries are still working. */
  value: PortalCountTotal | null;
}) {
  const authRefused = refusal !== null && isAccessRefusal(refusal);
  const empty = refusal === null && value !== null && value.count === 0;
  const subsetEmpty = empty && !sourceEmpty;

  return (
    <Card
      role="region"
      aria-label={title}
      aria-busy={loading}
      data-state={
        loading
          ? 'loading'
          : authRefused
            ? 'refused'
            : refusal !== null
              ? 'error'
              : empty
                ? 'empty'
                : 'loaded'
      }
    >
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <SkeletonMetric rows={1} />}
        {!loading && authRefused && refusal !== null && (
          <AccessRefused
            title={refusedTitle}
            description={refusedDescription}
            code={describeRefusalCode(refusal)}
            requestId={refusalRequestId(refusal)}
            message={refusalMessage(refusal)}
          />
        )}
        {!loading && refusal !== null && !authRefused && (
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
            title={subsetEmpty ? subsetEmptyCopy.title : sourceEmptyCopy.title}
            description={subsetEmpty ? subsetEmptyCopy.description : sourceEmptyCopy.description}
          />
        )}
        {!loading && refusal === null && !empty && value !== null && (
          <div>
            <p className="text-3xl font-semibold tabular-nums text-ink">{value.count}</p>
            <p className="mt-1 text-sm text-ink-soft" data-testid="balance-card-total">
              <TotalLine total={value.total} mixedCurrency={value.mixedCurrency} caption={caption} />
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Money line: exact total, or the honest count-only reason (R10). */
function TotalLine({
  total,
  mixedCurrency,
  caption,
}: {
  total: Money | null;
  mixedCurrency: boolean;
  caption: string;
}) {
  if (total === null) {
    return mixedCurrency ? (
      <span>mixed currencies on this account — count only (R10)</span>
    ) : (
      <span>total beyond exact integer range — count only</span>
    );
  }
  return (
    <>
      <span className="font-semibold tabular-nums text-ink">{formatMoney(total)}</span>{' '}
      {caption}
    </>
  );
}
