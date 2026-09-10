'use client';

import {
  useInfiniteQuery,
  type InfiniteData,
} from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { FuatiliaClient, Page, Refusal } from '@/lib/api/client';
import type { CaseView } from '@/lib/api/wire-types';
import { formatTimestamp } from '@/lib/collections/display';
import { CASE_SORTS, type CaseSort } from '@/lib/api/client';
import { DerivedStatusBadge, CasePriorityBadge, CaseStatusBadge } from './case-badges';

/**
 * The collections CASE LIST (issue #135) — GET /v1/collections/cases with
 * the contract's sort whitelist + cursor pagination. Every state is a REAL
 * query state: skeletons while the first page is pending, the refusal's
 * code + requestId when the wire refuses, the empty read model when the org
 * has no cases, and honest "Load more" paging (no optimistic rows — the
 * page appends only what the server returned).
 */

const LIST_QUERY_ROOT = ['api', 'collections', 'cases', 'workspace'] as const;
const PAGE_LIMIT = 20;

export interface CaseListViewProps {
  /** Read client; defaults to the process-wide browser client (BFF). */
  client?: FuatiliaClient;
}

type PageResult = { ok: true; data: Page<CaseView> } | { ok: false; refusal: Refusal };

function flattenPages(pages: PageResult[]): { rows: CaseView[]; nextCursor: string | null; total: number | null } {
  const rows: CaseView[] = [];
  let nextCursor: string | null = null;
  let total: number | null = null;
  for (const page of pages) {
    if (!page.ok) break;
    rows.push(...page.data.rows);
    nextCursor = page.data.pagination.nextCursor;
    total = page.data.pagination.total ?? total;
  }
  return { rows, nextCursor, total };
}

function firstRefusal(pages: InfiniteData<PageResult> | undefined): Refusal | null {
  if (pages === undefined) return null;
  for (const page of pages.pages) {
    if (!page.ok) return page.refusal;
  }
  return null;
}

export function CaseListView({ client = defaultClient }: CaseListViewProps) {
  const [sort, setSort] = useState<CaseSort>('caseNumber');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');

  const casesQuery = useInfiniteQuery({
    queryKey: [...LIST_QUERY_ROOT, sort, order],
    queryFn: async ({ pageParam }): Promise<PageResult> => {
      const result = await client.listCases({
        limit: PAGE_LIMIT,
        cursor: pageParam ?? undefined,
        sort,
        order,
      });
      return result;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.ok ? lastPage.data.pagination.nextCursor : undefined,
  });

  const refusal = firstRefusal(casesQuery.data);
  const flattened =
    casesQuery.data !== undefined ? flattenPages(casesQuery.data.pages) : null;
  const isLoadingFirstPage = casesQuery.isPending;
  const isLoadingMore = casesQuery.isFetching && !casesQuery.isPending;
  const hasMore = flattened?.nextCursor !== null && flattened !== null;

  const refresh = () => {
    void casesQuery.refetch();
  };

  return (
    <Card aria-labelledby="case-list-heading">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle id="case-list-heading" className="text-base">
            Cases
          </CardTitle>
          <CardDescription>
            GET /v1/collections/cases — the org-scoped case read model,
            cursor-paginated. Rows are sealed logs: work happens in the case
            detail.
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="case-sort" className="text-xs text-ink-soft">
            Sort
          </label>
          <select
            id="case-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as CaseSort)}
            className="rounded-md border border-slate-300 bg-surface-raised px-2 py-1 text-xs text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {CASE_SORTS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort direction"
            value={order}
            onChange={(event) => setOrder(event.target.value as 'asc' | 'desc')}
            className="rounded-md border border-slate-300 bg-surface-raised px-2 py-1 text-xs text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </select>
          <Button variant="secondary" size="sm" onClick={refresh} disabled={casesQuery.isFetching}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {refusal !== null && (
          <div className="mb-3">
            <ErrorState
              title="Couldn't load cases"
              message={refusalMessage(refusal)}
              code={describeRefusalCode(refusal)}
              requestId={refusalRequestId(refusal)}
              onRetry={refresh}
            />
          </div>
        )}

        {isLoadingFirstPage && (
          <div aria-busy="true" data-testid="case-list-loading">
            <SkeletonRows rows={4} />
          </div>
        )}

        {!isLoadingFirstPage && refusal === null && flattened !== null && (
          <>
            {flattened.rows.length === 0 ? (
              <EmptyState
                title="No collections cases yet"
                description="The /v1/collections/cases read model returned an empty first page for your org."
                hint="Open a case below over one or more receivables to start tracking collections."
              />
            ) : (
              <>
                <Table>
                  <THead>
                    <TR>
                      <TH scope="col">Case</TH>
                      <TH scope="col">Priority</TH>
                      <TH scope="col">Status</TH>
                      <TH scope="col">Derived</TH>
                      <TH scope="col">Actions</TH>
                      <TH scope="col">Opened</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {flattened.rows.map((c) => (
                      <TR key={c.id} data-testid="case-row">
                        <TD>
                          <Link
                            href={`/collections/${encodeURIComponent(c.id)}`}
                            className="font-mono text-xs font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            {c.caseNumber}
                          </Link>
                        </TD>
                        <TD>
                          <CasePriorityBadge priority={c.priority} />
                        </TD>
                        <TD>
                          <CaseStatusBadge status={c.status} />
                        </TD>
                        <TD>
                          <DerivedStatusBadge derived={c.derivedStatus} />
                        </TD>
                        <TD className="tabular-nums">{c.actions.length}</TD>
                        <TD className="whitespace-nowrap text-xs text-ink-soft">
                          {formatTimestamp(c.openedAt)}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-ink-soft" data-testid="case-list-total">
                    {flattened.total !== null
                      ? `${flattened.rows.length} of ${flattened.total} case(s) shown`
                      : `${flattened.rows.length} case(s) shown`}
                  </p>
                  {hasMore && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => void casesQuery.fetchNextPage()}
                      disabled={isLoadingMore}
                    >
                      {isLoadingMore ? 'Loading…' : 'Load more'}
                    </Button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
