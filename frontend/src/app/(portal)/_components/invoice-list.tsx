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
import { usePortalT } from '@/lib/portal-i18n/context';
import type { LocaleKey } from '@/lib/portal-i18n/dictionary';
import { formatMoney } from '@/lib/money';
import { AccessRefused, isAccessRefusal } from './access-refused';

/**
 * Invoice list (issue #86 view b): the receivable read model
 * (GET /v1/receivables) with state badges, aging bucket + days past due,
 * and balances in exact integer minor units. Server-driven cursor
 * pagination (the kernel's strict limit/cursor contract drives the
 * controls). Mobile-first: a stacked list under `md`, a table from `md` up —
 * same rows, same data, no fabricated mobile variant. All payer-facing
 * strings resolve through the portal i18n catalogs (issue #149); the state
 * badges are bound to the catalog with an exhaustive Record map, so a new
 * wire state without a translation cannot compile.
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

/** Every receivable state has exactly one localized badge label. */
const STATE_LABEL_KEYS: Record<ReceivableView['state'], LocaleKey> = {
  draft: 'states.draft',
  open: 'states.open',
  partially_paid: 'states.partially_paid',
  settled: 'states.settled',
  recovered: 'states.recovered',
  written_off: 'states.written_off',
  uncollectible: 'states.uncollectible',
  voided: 'states.voided',
};

function StateBadge({ state }: { state: ReceivableView['state'] }) {
  const t = usePortalT();
  return <Badge tone={STATE_TONES[state]}>{t(STATE_LABEL_KEYS[state])}</Badge>;
}

function AgingCell({ receivable }: { receivable: ReceivableView }) {
  const t = usePortalT();
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
          ? aging.daysPastDue === 1
            ? t('invoices.dayPastDue', { days: aging.daysPastDue })
            : t('invoices.daysPastDue', { days: aging.daysPastDue })
          : t('invoices.notPastDue')}
      </span>
    </span>
  );
}

function DueCell({ receivable }: { receivable: ReceivableView }) {
  const t = usePortalT();
  return (
    <span className="inline-flex items-center gap-1.5">
      <time dateTime={receivable.dueDate} className="text-xs text-ink-soft">
        {receivable.dueDate.slice(0, 10)}
      </time>
      {receivable.overdue && <Badge tone="danger">{t('invoices.overdueBadge')}</Badge>}
    </span>
  );
}

function MoneyCell({ money }: { money: ReceivableView['balance'] }) {
  return <span className="tabular-nums">{formatMoney(money)}</span>;
}

function InvoiceRows({ rows }: { rows: readonly ReceivableView[] }) {
  const t = usePortalT();
  return (
    <>
      {/* Desktop table (md and up). */}
      <div className="hidden md:block" data-testid="invoice-table">
        <Table>
          <THead>
            <TR>
              <TH scope="col">{t('invoices.col.invoice')}</TH>
              <TH scope="col">{t('invoices.col.state')}</TH>
              <TH scope="col">{t('invoices.col.balance')}</TH>
              <TH scope="col">{t('invoices.col.due')}</TH>
              <TH scope="col">{t('invoices.col.aging')}</TH>
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
              {receivable.overdue && <Badge tone="danger">{t('invoices.overdueBadge')}</Badge>}
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
              {t('invoices.duePrefix')}{' '}
              <time dateTime={receivable.dueDate}>{receivable.dueDate.slice(0, 10)}</time>
              {receivable.aging !== null && receivable.aging.daysPastDue > 0
                ? ` · ${t('invoices.daysPastDue', { days: receivable.aging.daysPastDue })}`
                : receivable.aging !== null
                  ? ` · ${t('invoices.notPastDue')}`
                  : ''}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function InvoiceList({ client = portalClient }: { client?: FuatiliaClient }) {
  const t = usePortalT();
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
        {t('invoices.title')}
      </h1>
      <p className="mt-0.5 text-sm text-ink-soft">{t('invoices.subtitle')}</p>

      <Card
        role="region"
        aria-label={t('invoices.regionLabel')}
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
            {t('invoices.cardTitle')}{' '}
            {total !== null && (
              <span className="font-normal text-ink-soft">
                {t('invoices.totalBadge', { total })}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {receivablesQuery.isPending && <SkeletonRows rows={5} />}
          {authRefused && refusal !== null && (
            <AccessRefused
              title={t('invoices.refusedTitle')}
              description={t('common.refusedBillingDescription')}
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              message={refusalMessage(refusal)}
            />
          )}
          {!receivablesQuery.isPending && refusal !== null && !authRefused && (
            <ErrorState
              title={t('invoices.errorTitle')}
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
              title={t('common.noInvoicesTitle')}
              description={t('common.noInvoicesDescription')}
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
                {t('common.previous')}
              </Button>
              <span className="text-xs text-ink-soft">
                {total !== null
                  ? t('invoices.pageOf', {
                      page: cursorStack.length,
                      pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                    })
                  : t('invoices.page', { page: cursorStack.length })}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={nextCursor === null || receivablesQuery.isFetching}
                onClick={() => {
                  if (nextCursor !== null) setCursorStack((stack) => [...stack, nextCursor]);
                }}
              >
                {t('common.next')}
              </Button>
            </div>
          </CardFooter>
        )}
      </Card>
    </section>
  );
}
