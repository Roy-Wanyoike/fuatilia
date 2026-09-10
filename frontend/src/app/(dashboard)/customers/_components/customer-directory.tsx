'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { defaultClient } from '@/lib/api/browser-client';
import type { FuatiliaClient, Refusal } from '@/lib/api/client';
import { listAllPayments, listAllReceivables } from '@/lib/api/pagination';
import { deriveCustomerDirectory, type CustomerDirectoryEntry } from '@/lib/customers/derive';
import { usePortalT } from '@/lib/portal-i18n/context';
import { formatMoney } from '@/lib/money';

/**
 * /customers — the customer directory (issue #134, screen a).
 *
 * The /v1 contract mounts NO customer directory operation (SPEC §47), so
 * customer identities here are DERIVED: the distinct `customerId` fields of
 * the receivable + payment read models (both walked with the bounded
 * pagination helper, cap disclosed when hit). Payments with a null
 * customerId are unattributable and never mint a customer. Each row links
 * to the per-customer 360 view. Strings resolve through the shared i18n
 * catalogs (issue #180).
 */

const RECEIVABLES_KEY = ['api', 'receivables', 'all'] as const;
const PAYMENTS_KEY = ['api', 'payments', 'all'] as const;

export function CustomerDirectory({ client = defaultClient }: { client?: FuatiliaClient }) {
  const t = usePortalT();
  const receivablesQuery = useQuery({
    queryKey: RECEIVABLES_KEY,
    queryFn: () => listAllReceivables(client),
  });
  const paymentsQuery = useQuery({
    queryKey: PAYMENTS_KEY,
    queryFn: () => listAllPayments(client),
  });

  const retryAll = () => {
    void receivablesQuery.refetch();
    void paymentsQuery.refetch();
  };

  const receivablesResult = receivablesQuery.data;
  const paymentsResult = paymentsQuery.data;
  const loading = receivablesQuery.isPending || paymentsQuery.isPending;

  // First refusal wins — both sources are required to derive the directory,
  // so a refusal on either one is surfaced with its code + requestId.
  const refusal: Refusal | null =
    receivablesResult?.ok === false
      ? receivablesResult.refusal
      : paymentsResult?.ok === false
        ? paymentsResult.refusal
        : null;

  const bothOk = receivablesResult?.ok === true && paymentsResult?.ok === true;
  const sourceEmpty =
    bothOk &&
    receivablesResult.data.rows.length === 0 &&
    paymentsResult.data.rows.length === 0;

  const truncated =
    (receivablesResult?.ok === true && receivablesResult.data.truncated) ||
    (paymentsResult?.ok === true && paymentsResult.data.truncated);

  const entries =
    bothOk && !sourceEmpty
      ? deriveCustomerDirectory({
          receivables: receivablesResult.data.rows,
          payments: paymentsResult.data.rows,
        })
      : [];

  const state = loading
    ? 'loading'
    : refusal !== null
      ? 'error'
      : sourceEmpty
        ? 'empty'
        : 'loaded';

  return (
    <section aria-labelledby="customers-heading">
      <h1 id="customers-heading" className="text-lg font-semibold text-ink">
        {t('dashboard.customers.directory.title')}
      </h1>
      <p className="mt-0.5 max-w-2xl text-sm text-ink-soft">
        {t('dashboard.customers.directory.subtitle')}
      </p>

      <Card
        role="region"
        aria-label={t('dashboard.customers.directory.regionLabel')}
        aria-busy={state === 'loading'}
        data-state={state}
        className="mt-4"
      >
        <CardHeader>
          <CardTitle>
            {t('dashboard.customers.directory.cardTitle')}{' '}
            {state === 'loaded' && (
              <span className="font-normal text-ink-faint">
                {t('dashboard.customers.directory.derivedCount', { count: entries.length })}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <div className="px-4 py-3">
          {state === 'loading' && <SkeletonRows rows={5} />}
          {state === 'error' && refusal !== null && (
            <ErrorState
              title={t('dashboard.customers.directory.refusedTitle')}
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
              onRetry={retryAll}
            />
          )}
          {state === 'empty' && (
            <EmptyState
              title={t('dashboard.customers.directory.emptyTitle')}
              description={t('dashboard.customers.directory.emptyDescription')}
              hint={t('dashboard.customers.directory.emptyHint')}
            />
          )}
          {state === 'loaded' && <DirectoryRows entries={entries} />}
        </div>
        {truncated && (
          <p
            role="status"
            className="mx-4 mb-3 rounded-md border border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft"
            data-testid="directory-truncated"
          >
            {t('dashboard.customers.directory.truncatedNote')}
          </p>
        )}
        <CardFooter>
          <span className="font-mono">{t('dashboard.customers.directory.footer')}</span>
        </CardFooter>
      </Card>
    </section>
  );
}

function DirectoryRows({ entries }: { entries: readonly CustomerDirectoryEntry[] }) {
  const t = usePortalT();
  return (
    <Table>
      <THead>
        <TR>
          <TH scope="col">{t('dashboard.customers.directory.col.customer')}</TH>
          <TH scope="col">{t('dashboard.customers.directory.col.outstanding')}</TH>
          <TH scope="col">{t('dashboard.customers.directory.col.overdue')}</TH>
          <TH scope="col">{t('dashboard.customers.directory.col.receivables')}</TH>
          <TH scope="col">{t('dashboard.customers.directory.col.lastActivity')}</TH>
          <TH scope="col">
            <span className="sr-only">{t('dashboard.customers.directory.open360SrOnly')}</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {entries.map((entry) => (
          <TR key={entry.customerId}>
            <TD className="font-mono text-xs">{entry.customerId}</TD>
            <TD>
              <span className="tabular-nums" data-testid="directory-outstanding">
                {entry.outstanding.count}{' '}
                {entry.outstanding.total === null ? (
                  entry.outstanding.mixedCurrency ? (
                    <span className="text-xs text-ink-soft">
                      {t('dashboard.customers.directory.mixedCurrencyCountOnly')}
                    </span>
                  ) : (
                    <span className="text-xs text-ink-soft">
                      {t('dashboard.customers.directory.rangeCountOnly')}
                    </span>
                  )
                ) : (
                  <span className="text-ink-soft">{formatMoney(entry.outstanding.total)}</span>
                )}
              </span>
            </TD>
            <TD>
              {entry.overdueCount > 0 ? (
                <Badge tone="warning">
                  {t('dashboard.customers.directory.overdueCount', { count: entry.overdueCount })}
                </Badge>
              ) : (
                <span className="text-ink-faint">—</span>
              )}
            </TD>
            <TD className="tabular-nums">{entry.receivableCount}</TD>
            <TD>
              {entry.lastActivityAt === null ? (
                <span className="text-ink-faint">—</span>
              ) : (
                <time dateTime={entry.lastActivityAt} className="text-xs text-ink-soft">
                  {entry.lastActivityAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}
                </time>
              )}
            </TD>
            <TD>
              <Link
                href={`/customers/${encodeURIComponent(entry.customerId)}`}
                className="text-sm font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t('dashboard.customers.directory.viewLink')}{' '}
                <span className="sr-only">
                  {t('dashboard.customers.directory.viewLinkSrOnly', { id: entry.customerId })}
                </span>
              </Link>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
