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
import { usePortalT } from '@/lib/portal-i18n/context';
import { formatMoney } from '@/lib/money';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Balance overview (issue #86 view a): outstanding / overdue / payments
 * held on account, derived from GET /v1/receivables + GET /v1/payments
 * (bounded pagination walk). Every card renders one REAL state — loading,
 * refused (401/403), error (code + requestId), empty, or loaded — never a
 * fabricated number. Money is exact integer minor units via lib/money.ts;
 * mixed-currency books refuse to be totaled and say so (R10). All
 * payer-facing strings resolve through the portal i18n catalogs (issue
 * #149).
 */

export function BalanceOverview({ client = portalClient }: { client?: FuatiliaClient }) {
  const t = usePortalT();
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
        {t('balance.title')}
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">{t('balance.subtitle')}</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <BalanceCard
          title={t('balance.cards.outstanding.title')}
          caption={t('balance.cards.outstanding.caption')}
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          refusedTitle={t('balance.cards.outstanding.refusedTitle')}
          refusedDescription={t('common.refusedBillingDescription')}
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          sourceEmpty={receivablesSourceEmpty}
          sourceEmptyCopy={{
            title: t('common.noInvoicesTitle'),
            description: t('common.noInvoicesDescription'),
          }}
          subsetEmptyCopy={{
            title: t('balance.cards.outstanding.emptyTitle'),
            description: t('balance.cards.outstanding.emptyDescription'),
          }}
          value={receivableSummary === null ? null : receivableSummary.outstanding}
        />
        <BalanceCard
          title={t('balance.cards.overdue.title')}
          caption={t('balance.cards.overdue.caption')}
          loading={receivablesQuery.isPending}
          refusal={receivablesRefusal}
          refusedTitle={t('balance.cards.overdue.refusedTitle')}
          refusedDescription={t('common.refusedBillingDescription')}
          onRetry={() => {
            void receivablesQuery.refetch();
          }}
          sourceEmpty={receivablesSourceEmpty}
          sourceEmptyCopy={{
            title: t('common.noInvoicesTitle'),
            description: t('common.noInvoicesDescription'),
          }}
          subsetEmptyCopy={{
            title: t('balance.cards.overdue.emptyTitle'),
            description: t('balance.cards.overdue.emptyDescription'),
          }}
          value={receivableSummary === null ? null : receivableSummary.overdue}
        />
        <BalanceCard
          title={t('balance.cards.heldOnAccount.title')}
          caption={t('balance.cards.heldOnAccount.caption')}
          loading={paymentsQuery.isPending}
          refusal={paymentsRefusal}
          refusedTitle={t('balance.cards.heldOnAccount.refusedTitle')}
          refusedDescription={t('common.refusedPaymentsDescription')}
          onRetry={() => {
            void paymentsQuery.refetch();
          }}
          sourceEmpty={paymentsSourceEmpty}
          sourceEmptyCopy={{
            title: t('common.noPaymentsTitle'),
            description: t('balance.cards.heldOnAccount.sourceEmptyDescription'),
          }}
          subsetEmptyCopy={{
            title: t('balance.cards.heldOnAccount.emptyTitle'),
            description: t('balance.cards.heldOnAccount.emptyDescription'),
          }}
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
  const t = usePortalT();
  const unavailableTitle = t('balance.cardUnavailable', { card: title });

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
            title={unavailableTitle}
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
  const t = usePortalT();
  if (total === null) {
    return mixedCurrency ? (
      <span>{t('balance.mixedCurrencyCountOnly')}</span>
    ) : (
      <span>{t('balance.rangeCountOnly')}</span>
    );
  }
  return (
    <>
      <span className="font-semibold tabular-nums text-ink">{formatMoney(total)}</span>{' '}
      {caption}
    </>
  );
}
