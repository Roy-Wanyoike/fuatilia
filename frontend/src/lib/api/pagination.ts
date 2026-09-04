import type { ApiResult, FuatiliaClient, Page } from './client';
import type { CaseView, PaymentView, ReceivableView } from './wire-types';

/**
 * Bounded client-side pagination: walks `meta.pagination.nextCursor` until
 * the list is exhausted or the page cap is hit. This is the Command
 * Center's v1 read strategy — the mounted surface has no aggregate
 * endpoints yet, so derivations run over the fetched rows. The cap keeps
 * the read payload-conscious (mobile-first / low-data): five pages of 100
 * rows per resource, after which the result is returned with
 * `truncated: true` and the UI says so instead of pretending completeness.
 */
export const DEFAULT_MAX_PAGES = 5;

export interface AllRowsResult<T> {
  rows: T[];
  pagesFetched: number;
  total: number | null;
  /** True when the page cap stopped the walk before nextCursor: null. */
  truncated: boolean;
}

export type AllRowsOptions = {
  maxPages?: number;
  limit?: number;
};

export async function listAllPages<T>(
  fetchPage: (cursor: string | null) => Promise<ApiResult<Page<T>>>,
  options: AllRowsOptions = {},
): Promise<ApiResult<AllRowsResult<T>>> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const limit = options.limit ?? 100;

  const rows: T[] = [];
  let cursor: string | null = null;
  let total: number | null = null;
  let pagesFetched = 0;

  for (;;) {
    const result = await fetchPage(cursor);
    if (!result.ok) return result;
    rows.push(...result.data.rows);
    total = result.data.pagination.total ?? total;
    pagesFetched += 1;
    cursor = result.data.pagination.nextCursor;
    if (cursor === null) {
      return { ok: true, data: { rows, pagesFetched, total, truncated: false }, pagination: null, requestId: result.requestId };
    }
    if (pagesFetched >= maxPages) {
      return { ok: true, data: { rows, pagesFetched, total, truncated: true }, pagination: null, requestId: result.requestId };
    }
  }
}

export function listAllReceivables(
  client: FuatiliaClient,
  options: AllRowsOptions = {},
): Promise<ApiResult<AllRowsResult<ReceivableView>>> {
  return listAllPages((cursor) =>
    client.listReceivables({ limit: options.limit ?? 100, cursor: cursor ?? undefined, sort: 'dueDate', order: 'asc' }),
    options,
  );
}

export function listAllPayments(
  client: FuatiliaClient,
  options: AllRowsOptions = {},
): Promise<ApiResult<AllRowsResult<PaymentView>>> {
  return listAllPages((cursor) =>
    client.listPayments({ limit: options.limit ?? 100, cursor: cursor ?? undefined, sort: 'initiatedAt', order: 'desc' }),
    options,
  );
}

export function listAllCases(
  client: FuatiliaClient,
  options: AllRowsOptions = {},
): Promise<ApiResult<AllRowsResult<CaseView>>> {
  return listAllPages((cursor) =>
    client.listCases({ limit: options.limit ?? 100, cursor: cursor ?? undefined, sort: 'caseNumber', order: 'asc' }),
    options,
  );
}
