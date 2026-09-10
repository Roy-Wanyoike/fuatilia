'use client';

import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useMemo, useState } from 'react';
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
import { defaultClient } from '@/lib/api/browser-client';
import type { PaymentView } from '@/lib/api/wire-types';
import { usePortalT } from '@/lib/portal-i18n/context';
import { formatMoney } from '@/lib/money';

/**
 * /payments — the fund-truth read model (GET /v1/payments) rendered as a
 * pagination-FIRST table (TanStack Table with manual server pagination —
 * the kernel's strict limit/cursor contract drives the controls; the client
 * never clamps). Money renders via the exact integer formatter. Column
 * headers and controls resolve through the shared i18n catalogs
 * (issue #180); the state/channel badges stay WIRE VALUES — an operator
 * correlates them with logs and the /v1 spec.
 */

const columnHelper = createColumnHelper<PaymentView>();

const PAGE_SIZE = 20;

export default function PaymentsPage() {
  const t = usePortalT();

  // Built per render from the locale-bound t: TanStack headers accept
  // render functions, so the catalog owns the copy while the accessors
  // stay typed (never widened to `unknown` TValue).
  const columns = useMemo(
    () => [
      columnHelper.accessor('externalRef', {
        header: t('dashboard.payments.col.receipt'),
        cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
      }),
      columnHelper.accessor('channel', {
        header: t('dashboard.payments.col.channel'),
        cell: (info) => <Badge tone="neutral">{info.getValue()}</Badge>,
      }),
      columnHelper.accessor('state', {
        header: t('dashboard.payments.col.state'),
        cell: (info) => {
          const state = info.getValue();
          const tone =
            state === 'refunded' || state === 'reversed' || state === 'failed'
              ? 'danger'
              : state === 'allocated'
                ? 'success'
                : 'info';
          return <Badge tone={tone}>{state}</Badge>;
        },
      }),
      columnHelper.accessor('requested', {
        header: t('dashboard.payments.col.requested'),
        cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue())}</span>,
      }),
      columnHelper.accessor('confirmed', {
        header: t('dashboard.payments.col.confirmed'),
        cell: (info) => {
          const confirmed = info.getValue();
          return confirmed === null ? (
            <span className="text-ink-faint">—</span>
          ) : (
            <span className="tabular-nums">{formatMoney(confirmed)}</span>
          );
        },
      }),
      columnHelper.accessor('unapplied', {
        header: t('dashboard.payments.col.unapplied'),
        cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue())}</span>,
      }),
      columnHelper.accessor('initiatedAt', {
        header: t('dashboard.payments.col.initiated'),
        cell: (info) => (
          <time dateTime={info.getValue()} className="text-xs text-ink-soft">
            {info.getValue().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}
          </time>
        ),
      }),
    ],
    [t],
  );

  // Cursor stack for "previous": the kernel returns only nextCursor.
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([null]);
  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const paymentsQuery = useQuery({
    queryKey: ['api', 'payments', 'page', cursor ?? 'first', PAGE_SIZE],
    queryFn: () =>
      defaultClient.listPayments({
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
        sort: 'initiatedAt',
        order: 'desc',
      }),
  });

  const rows = paymentsQuery.data?.ok === true ? paymentsQuery.data.data.rows : [];
  const nextCursor =
    paymentsQuery.data?.ok === true ? paymentsQuery.data.data.pagination.nextCursor : null;
  const total =
    paymentsQuery.data?.ok === true ? paymentsQuery.data.data.pagination.total : null;

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    pageCount: -1,
  });

  const refusal = paymentsQuery.data?.ok === false ? paymentsQuery.data.refusal : null;
  const sourceEmpty = paymentsQuery.data?.ok === true && rows.length === 0;

  return (
    <section aria-labelledby="payments-heading">
      <h1 id="payments-heading" className="text-lg font-semibold text-ink">
        {t('dashboard.payments.title')}
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">{t('dashboard.payments.subtitle')}</p>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>
            {t('dashboard.payments.ledgerTitle')}{' '}
            {total !== null && (
              <span className="font-normal text-ink-faint">
                {t('dashboard.payments.totalBadge', { total })}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {paymentsQuery.isPending && <SkeletonRows rows={5} />}
          {refusal !== null && (
            <ErrorState
              title={t('dashboard.payments.refusedTitle')}
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
              title={t('dashboard.payments.emptyTitle')}
              description={t('dashboard.payments.emptyDescription')}
            />
          )}
          {!paymentsQuery.isPending && refusal === null && !sourceEmpty && (
            <Table aria-label={t('dashboard.payments.tableLabel')}>
              <THead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TR key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TH key={header.id} scope="col">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TH>
                    ))}
                  </TR>
                ))}
              </THead>
              <TBody>
                {table.getRowModel().rows.map((row) => (
                  <TR key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TD key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
        <CardFooter>
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={cursorStack.length <= 1 || paymentsQuery.isFetching}
              onClick={() => {
                setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
              }}
            >
              {t('common.previous')}
            </Button>
            <span className="text-xs text-ink-faint">
              {total !== null
                ? t('dashboard.payments.pageOf', {
                    page: cursorStack.length,
                    pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                  })
                : t('dashboard.payments.page', { page: cursorStack.length })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={nextCursor === null || paymentsQuery.isFetching}
              onClick={() => {
                if (nextCursor !== null) setCursorStack((stack) => [...stack, nextCursor]);
              }}
            >
              {t('common.next')}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </section>
  );
}
