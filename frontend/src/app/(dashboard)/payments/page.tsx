'use client';

import { useQuery } from '@tanstack/react-query';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
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
import { defaultClient } from '@/lib/api/browser-client';
import type { PaymentView } from '@/lib/api/wire-types';
import { formatMoney } from '@/lib/money';

/**
 * /payments — the fund-truth read model (GET /v1/payments) rendered as a
 * pagination-FIRST table (TanStack Table with manual server pagination —
 * the kernel's strict limit/cursor contract drives the controls; the client
 * never clamps). Money renders via the exact integer formatter.
 */

const columnHelper = createColumnHelper<PaymentView>();

// Inferred (never widened to `unknown` TValue) — the helper pins each
// accessor's value type, and useReactTable accepts the mixed-TValue array.
const columns = [
  columnHelper.accessor('externalRef', {
    header: 'Receipt',
    cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
  }),
  columnHelper.accessor('channel', {
    header: 'Channel',
    cell: (info) => <Badge tone="neutral">{info.getValue()}</Badge>,
  }),
  columnHelper.accessor('state', {
    header: 'State',
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
    header: 'Requested',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue())}</span>,
  }),
  columnHelper.accessor('confirmed', {
    header: 'Confirmed',
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
    header: 'Unapplied',
    cell: (info) => <span className="tabular-nums">{formatMoney(info.getValue())}</span>,
  }),
  columnHelper.accessor('initiatedAt', {
    header: 'Initiated',
    cell: (info) => (
      <time dateTime={info.getValue()} className="text-xs text-ink-soft">
        {info.getValue().replace('T', ' ').replace(/\.\d+Z$/, 'Z')}
      </time>
    ),
  }),
];

const PAGE_SIZE = 20;

export default function PaymentsPage() {
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
        Payments
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">
        The fund-truth read model over the one Daraja intake funnel (C2B + STK).
      </p>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>
            Ledger{' '}
            {total !== null && (
              <span className="font-normal text-ink-faint">· {total} total</span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {paymentsQuery.isPending && <SkeletonRows rows={5} />}
          {refusal !== null && (
            <ErrorState
              title="Payments are unavailable"
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
              title="No payments yet"
              description="Money arrives through POST /v1/payments/intake — the one C2B/STK funnel."
            />
          )}
          {!paymentsQuery.isPending && refusal === null && !sourceEmpty && (
            <Table>
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
              Previous
            </Button>
            <span className="text-xs text-ink-faint">
              page {cursorStack.length}
              {total !== null ? ` of ≤ ${Math.max(1, Math.ceil(total / PAGE_SIZE))}` : ''}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={nextCursor === null || paymentsQuery.isFetching}
              onClick={() => {
                if (nextCursor !== null) setCursorStack((stack) => [...stack, nextCursor]);
              }}
            >
              Next
            </Button>
          </div>
        </CardFooter>
      </Card>
    </section>
  );
}
