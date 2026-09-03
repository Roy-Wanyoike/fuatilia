/**
 * §38 pagination/sorting consistency helpers (issue #55).
 *
 * `parsePagination` — `limit` (integer 1–100, default 20) + opaque `cursor`.
 * Boundaries are STRICT: `limit=1` and `limit=100` are legal, `0`/`101`/
 * non-integers/negatives refuse with `HTTP_QUERY_INVALID` (deny-by-default —
 * the kernel never silently clamps a client's page size).
 *
 * `parseSorting` — whitelist-based `sort` + `order` (`asc`|`desc`, default
 * `asc`). A field outside the resource's declared whitelist refuses; sorting
 * by arbitrary client strings is exactly how you scan a database.
 *
 * `paginatedMeta` — the consistent `meta` envelope for list responses.
 */
import { DomainError } from '../../domain/shared/errors';
import { HTTP_QUERY_INVALID } from './kernel/errors';

export const DEFAULT_PAGE_LIMIT = 20;
export const MIN_PAGE_LIMIT = 1;
export const MAX_PAGE_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 512;

export interface Pagination {
  readonly limit: number;
  readonly cursor: string | null;
}

/** Parse `?limit=&cursor=` — strict boundaries, no clamping. */
export function parsePagination(query: Readonly<Record<string, string>>): Pagination {
  const rawLimit = query['limit'];
  let limit = DEFAULT_PAGE_LIMIT;
  if (rawLimit !== undefined && rawLimit.trim() !== '') {
    const trimmed = rawLimit.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new DomainError(
        HTTP_QUERY_INVALID,
        `query parameter 'limit' must be an integer between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}`,
        { limit: rawLimit },
      );
    }
    limit = Number(trimmed);
    if (limit < MIN_PAGE_LIMIT || limit > MAX_PAGE_LIMIT) {
      throw new DomainError(
        HTTP_QUERY_INVALID,
        `query parameter 'limit' must be between ${MIN_PAGE_LIMIT} and ${MAX_PAGE_LIMIT}, got ${limit}`,
        { limit: rawLimit },
      );
    }
  }
  const rawCursor = query['cursor'];
  let cursor: string | null = null;
  if (rawCursor !== undefined && rawCursor.trim() !== '') {
    cursor = rawCursor.trim();
    if (cursor.length > MAX_CURSOR_LENGTH) {
      throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' exceeds ${MAX_CURSOR_LENGTH} characters`, {
        cursor: `${cursor.slice(0, 12)}…`,
      });
    }
  }
  return { limit, cursor };
}

export type SortOrder = 'asc' | 'desc';

export interface Sorting {
  readonly field: string | null;
  readonly order: SortOrder;
}

/** Parse `?sort=&order=` against the resource's sortable-field whitelist. */
export function parseSorting(query: Readonly<Record<string, string>>, whitelist: readonly string[]): Sorting {
  const rawSort = query['sort'];
  let field: string | null = null;
  if (rawSort !== undefined && rawSort.trim() !== '') {
    field = rawSort.trim();
    if (!whitelist.includes(field)) {
      throw new DomainError(
        HTTP_QUERY_INVALID,
        `query parameter 'sort' must be one of: ${whitelist.join(', ')}`,
        { sort: rawSort },
      );
    }
  }
  const rawOrder = query['order'];
  let order: SortOrder = 'asc';
  if (rawOrder !== undefined && rawOrder.trim() !== '') {
    const candidate = rawOrder.trim().toLowerCase();
    if (candidate !== 'asc' && candidate !== 'desc') {
      throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'order' must be 'asc' or 'desc'`, {
        order: rawOrder,
      });
    }
    order = candidate;
  }
  return { field, order };
}

/** The consistent list-envelope `meta`: `{ pagination: { nextCursor, total? } }`. */
export function paginatedMeta(
  nextCursor: string | null,
  total?: number,
): { pagination: { nextCursor: string | null; total?: number } } {
  return {
    pagination:
      total === undefined
        ? { nextCursor }
        : { nextCursor, total },
  };
}
