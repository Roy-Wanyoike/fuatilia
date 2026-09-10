'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  ErrorState,
  describeRefusalCode,
  refusalMessage,
  refusalRequestId,
} from '@/components/ui/error-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import type { FuatiliaClient } from '@/lib/api/client';
import type { ReceivableView } from '@/lib/api/wire-types';
import { portalClient } from '@/lib/portal/browser-client';
import { formatMoney } from '@/lib/money';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Invoice list (issue #86 view b): the receivable read model
 * (GET /v1/receivables) with state badges, aging bucket + days past due,
 * and balances in exact integer minor units. Server-driven cursor
 * pagination (the kernel's strict limit/cursor contract drives the
 * controls). Mobile-first: a stacked list under `md`, a table from `md` up —
 * same rows, same data, no fabricated mobile variant.
 */

const PAGE_SIZE = 20;

const STATE_TONES: Record<
  ReceivableView['state'],
  'neutral' | 'info' | 'success' | 'warning' | 'danger'
> = {
  draft: 'neutral',
  open: 'info',
  partially_paid: 'info',
  settled: 'success',
  recovered: 'success',
  written_off: 'warning',
  uncollectible: 'warning',
  voided: 'neutral',
};

function StateBadge({ state }: { state: ReceivableView['state'] }) {
  return <Badge tone={STATE_TONES[state]}>{state.replace(/_/g, ' ')}</Badge>;
}

function AgingCell({ receivable }: { receivable: ReceivableView }) {
  const aging = receivable.aging;
  if (aging === null) {
    return <span className="text-ink-soft">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={aging.bucket === '61-90' || aging.bucket === '90+' ? 'danger' : 'neutral'}>
        {aging.bucket}
      </Badge>
      <span className="text-xs text-ink-soft">
        {aging.daysPastDue > 0
          ? `${aging.daysPastDue} day${aging.daysPastDue === 1 ? '' : 's'} past due`
          : 'not past due'}
      </span>
    </span>
  );
}

function DueCell({ receivable }: { receivable: ReceivableView }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <time dateTime={receivable.dueDate} className="text-xs text-ink-soft">
        {receivable.dueDate.slice(0, 10)}
      </time>
      {receivable.overdue && <Badge tone="danger">overdue</Badge>}
    </span>
  );
}

function MoneyCell({ money }: { money: ReceivableView['balance'] }) {
  return <span className="tabular-nums">{formatMoney(money)}</span>;
}

function InvoiceRows({ rows }: { rows: readonly ReceivableView[] }) {
  return (
    <>
      {/* Desktop table (md and up). */}
      <div className="hidden md:block" data-testid="invoice-table">
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
            {rows.map((receivable) => (
              <TR key={receivable.id}>
                <TD>
                  <span className="font-mono text-xs">{receivable.invoiceId}</span>
                </TD>
                <TD>
                  <StateBadge state={receivable.state} />
                </TD>
                <TD>
                  <MoneyCell money={receivable.balance} />
                </TD>
                <TD>
                  <DueCell receivable={receivable} />
                </TD>
                <TD>
                  <AgingCell receivable={receivable} />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
      {/* Mobile stacked list (below md). */}
      <ul className="flex flex-col gap-3 md:hidden" data-testid="invoice-list">
        {rows.map((receivable) => (
          <li
            key={receivable.id}
            className="rounded-md border border-slate-200 bg-surface-raised px-3 py-3"
            data-testid="invoice-list-item"
          >
            <p className="font-mono text-xs text-ink-soft">{receivable.invoiceId}</p>
            <p className="mt-1 text-base font-semibold tabular-nums text-ink">
              {formatMoney(receivable.balance)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StateBadge state={receivable.state} />
              {receivable.overdue && <Badge tone="danger">overdue</Badge>}
              {receivable.aging !== null && (
                <Badge
                  tone={
                    receivable.aging.bucket === '61-90' || receivable.aging.bucket === '90+'
                      ? 'danger'
                      : 'neutral'
                  }
                >
                  {receivable.aging.bucket}
                </Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-ink-soft">
              due{' '}
              <time dateTime={receivable.dueDate}>{receivable.dueDate.slice(0, 10)}</time>
              {receivable.aging !== null && receivable.aging.daysPastDue > 0
                ? ` · ${receivable.aging.daysPastDue} days past due`
                : receivable.aging !== null
                  ? ' · not past due'
                  : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function InvoiceList({ client = portalClient }: { client?: FuatiliaClient }) {
  // Cursor stack for "previous": the kernel returns only nextCursor.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const receivablesQuery = useQuery({
    queryKey: ['portal', 'receivables', 'page', cursor ?? 'first', PAGE_SIZE],
    queryFn: () =>
      client.listReceivables({
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        sort: 'dueDate',
        order: 'asc',
      }),
  });

  const result = receivablesQuery.data;
  const rows = result?.ok === true ? result.data.rows : [];
  const nextCursor = result?.ok === true ? result.data.pagination.nextCursor : null;
  const total = result?.ok === true ? result.data.pagination.total : null;
  const refusal = result?.ok === false ? result.refusal : null;
  const authRefused = refusal !== null && isAccessRefusal(refusal);
  const sourceEmpty = result?.ok === true && rows.length === 0;

  return (
    <section aria-labelledby="portal-invoices-heading">
      <h1 id="portal-invoices-heading" className="text-lg font-semibold text-ink">
        Your invoices
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        Every invoice on your account with its state, balance and aging.
      </p>

      <Card
        role="region"
        aria-label="Invoices"
        data-state={
          receivablesQuery.isPending
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
          <CardTitle>
            Invoices{' '}
            {total !== null && (
              <span className="font-normal text-ink-soft">· {total} total</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {receivablesQuery.isPending && <SkeletonRows rows={5} />}
          {authRefused && refusal !== null && (
            <AccessRefused
              title="Your invoices are not available"
              description="This portal session was refused access to your billing data."
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
            />
          )}
          {!receivablesQuery.isPending && refusal !== null && !authRefused && (
            <ErrorState
              title="Invoices are unavailable"
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
              onRetry={() => {
                void receivablesQuery.refetch();
              }}
            />
          )}
          {!receivablesQuery.isPending && refusal === null && sourceEmpty && (
            <EmptyState
              title="No invoices on file yet"
              description="Nothing has been billed to your account so far."
            />
          )}
          {!receivablesQuery.isPending && refusal === null && !sourceEmpty && (
            <InvoiceRows rows={rows} />
          )}
        </CardContent>
        {!receivablesQuery.isPending && refusal === null && !sourceEmpty && (
          <CardFooter>
            <div className="flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={cursorStack.length <= 1 || receivablesQuery.isFetching}
                onClick={() => {
                  setCursorStack((stack) =>
                    stack.length > 1 ? stack.slice(0, -1) : stack,
                  );
                }}
              >
                Previous
              </Button>
              <span className="text-xs text-ink-soft">
                page {cursorStack.length}
                {total !== null
                  ? ` of ≤ ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`
                  : ''}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={nextCursor === null || receivablesQuery.isFetching}
                onClick={() => {
                  if (nextCursor !== null) setCursorStack((stack) => [...stack, nextCursor]);
                }}
              >
                Next
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
    </section>
  );
}
