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
import { formatMoney } from '@/lib/money';
import { deriveStatement, type StatementEntry, type StatementKind } from '@/lib/portal/statement';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Statement timeline (issue #86 view c): confirmations, allocations,
 * refunds, reversals and failures derived from the GET /v1/payments rows
 * (bounded pagination walk, cap disclosed when hit), newest first. Money is
 * the contract's integer minor units through lib/money.ts — never floats,
 * never toFixed.
 */

const KIND_TONES: Record<StatementKind, 'success' | 'info' | 'warning' | 'danger'> = {
  confirmation: 'success',
  allocation: 'info',
  refund: 'warning',
  reversal: 'warning',
  failure: 'danger',
};

const KIND_LABELS: Record<StatementKind, string> = {
  confirmation: 'payment confirmed',
  allocation: 'applied to invoice',
  refund: 'refund',
  reversal: 'reversed',
  failure: 'payment failed',
};

function EntryAmount({ entry }: { entry: StatementEntry }) {
  if (entry.amount === null) {
    return <span className="text-sm text-ink-soft">no funds moved</span>;
  }
  const attempted = entry.kind === 'failure';
  return (
    <span className="text-sm font-semibold tabular-nums text-ink">
      {formatMoney(entry.amount)}
      {attempted && (
        <span className="ml-1 font-normal text-ink-soft">attempted</span>
      )}
    </span>
  );
}

function StatementRows({ entries }: { entries: readonly StatementEntry[] }) {
  return (
    <ol className="flex flex-col divide-y divide-slate-100" data-testid="statement-timeline">
      {entries.map((entry) => (
        <li key={entry.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={KIND_TONES[entry.kind]}>{KIND_LABELS[entry.kind]}</Badge>
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
        Your statement
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        Every confirmation, application, refund, reversal and failure on your account — newest
        first, from the payment ledger.
      </p>

      <Card
        role="region"
        aria-label="Statement activity"
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
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {paymentsQuery.isPending && <SkeletonRows rows={5} />}
          {authRefused && refusal !== null && (
            <AccessRefused
              title="Your statement is not available"
              description="This portal session was refused access to your payment data."
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
            />
          )}
          {!paymentsQuery.isPending && refusal !== null && !authRefused && (
            <ErrorState
              title="Your statement is unavailable"
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
              title="No payments on file yet"
              description="Once a payment is received on your account it will appear here with where it was applied."
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
                  Showing the most recent payments only — the page cap was reached, so older
                  activity is not listed.
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
