'use client';

import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import type { FuatiliaClient } from '@/lib/api/client';
import { listAllPayments } from '@/lib/api/pagination';
import { portalClient } from '@/lib/portal/browser-client';
import { usePortalT } from '@/lib/portal-i18n/context';
import type { LocaleKey } from '@/lib/portal-i18n/dictionary';
import { formatMoney } from '@/lib/money';
import { deriveStatement, type StatementEntry, type StatementKind } from '@/lib/portal/statement';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Statement timeline (issue #86 view c): confirmations, allocations,
 * refunds, reversals and failures derived from the GET /v1/payments rows
 * (bounded pagination walk, cap disclosed when hit), newest first. Money is
 * the contract's integer minor units through lib/money.ts — never floats,
 * never toFixed. All payer-facing strings resolve through the portal i18n
 * catalogs (issue #149); the statement kinds are bound to the catalog with
 * an exhaustive Record map.
 */

const KIND_TONES: Record<StatementKind, 'success' | 'info' | 'warning' | 'danger'> = {
  confirmation: 'success',
  allocation: 'info',
  refund: 'warning',
  reversal: 'warning',
  failure: 'danger',
};

/** Every statement kind has exactly one localized badge label. */
const KIND_LABEL_KEYS: Record<StatementKind, LocaleKey> = {
  confirmation: 'statement.kinds.confirmation',
  allocation: 'statement.kinds.allocation',
  refund: 'statement.kinds.refund',
  reversal: 'statement.kinds.reversal',
  failure: 'statement.kinds.failure',
};

function EntryAmount({ entry }: { entry: StatementEntry }) {
  const t = usePortalT();
  if (entry.amount === null) {
    return <span className="text-sm text-ink-soft">{t('statement.noFundsMoved')}</span>;
  }
  const attempted = entry.kind === 'failure';
  return (
    <span className="text-sm font-semibold tabular-nums text-ink">
      {formatMoney(entry.amount)}
      {attempted && (
        <span className="ml-1 font-normal text-ink-soft">{t('statement.attempted')}</span>
      )}
    </span>
  );
}

function StatementRows({ entries }: { entries: readonly StatementEntry[] }) {
  const t = usePortalT();
  return (
    <ol className="flex flex-col divide-y divide-slate-100" data-testid="statement-timeline">
      {entries.map((entry) => (
        <li key={entry.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={KIND_TONES[entry.kind]}>{t(KIND_LABEL_KEYS[entry.kind])}</Badge>
              <span className="font-mono text-xs text-ink-soft">{entry.externalRef}</span>
            </div>
            {entry.detail !== null && (
              <p className="mt-1 break-words text-xs text-ink-soft">{entry.detail}</p>
            )}
          </div>
          <div className="flex flex-col items-start gap-0.5 sm:items-end">
            <EntryAmount entry={entry} />
            <time dateTime={entry.at} className="text-xs text-ink-soft">
              {entry.at.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function StatementTimeline({ client = portalClient }: { client?: FuatiliaClient }) {
  const t = usePortalT();
  const paymentsQuery = useQuery({
    queryKey: ['portal', 'payments', 'all'],
    queryFn: () => listAllPayments(client),
  });

  const result = paymentsQuery.data;
  const refusal = result?.ok === false ? result.refusal : null;
  const authRefused = refusal !== null && isAccessRefusal(refusal);
  const sourceEmpty = result?.ok === true && result.data.rows.length === 0;
  const truncated = result?.ok === true && result.data.truncated;
  const entries = result?.ok === true ? deriveStatement(result.data.rows) : [];

  return (
    <section aria-labelledby="portal-statement-heading">
      <h1 id="portal-statement-heading" className="text-lg font-semibold text-ink">
        {t('statement.title')}
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">{t('statement.subtitle')}</p>

      <Card
        role="region"
        aria-label={t('statement.regionLabel')}
        data-state={
          paymentsQuery.isPending
            ? 'loading'
            : authRefused
              ? 'refused'
              : refusal !== null
                ? 'error'
                : sourceEmpty
                  ? 'empty'
                  : 'loaded'
        }
        className="mt-4"
      >
        <CardHeader>
          <CardTitle>{t('statement.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          {paymentsQuery.isPending && <SkeletonRows rows={5} />}
          {authRefused && refusal !== null && (
            <AccessRefused
              title={t('statement.refusedTitle')}
              description={t('common.refusedPaymentsDescription')}
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
            />
          )}
          {!paymentsQuery.isPending && refusal !== null && !authRefused && (
            <ErrorState
              title={t('statement.errorTitle')}
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
              onRetry={() => {
                void paymentsQuery.refetch();
              }}
            />
          )}
          {!paymentsQuery.isPending && refusal === null && sourceEmpty && (
            <EmptyState
              title={t('common.noPaymentsTitle')}
              description={t('statement.emptyDescription')}
            />
          )}
          {!paymentsQuery.isPending && refusal === null && !sourceEmpty && (
            <>
              {truncated && (
                <p
                  role="status"
                  className="mb-3 rounded-md border border-warn-soft bg-warn-soft/40 px-3 py-2 text-xs text-ink-soft"
                  data-testid="statement-truncated"
                >
                  {t('statement.truncatedNote')}
                </p>
              )}
              <StatementRows entries={entries} />
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
