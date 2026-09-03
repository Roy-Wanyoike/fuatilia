import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared/errors';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  paginatedMeta,
  parsePagination,
  parseSorting,
} from './pagination';

const expectQueryCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

describe('parsePagination — strict §38 boundaries, never clamps', () => {
  it('defaults to the 20-row page with no cursor when the query is empty', () => {
    expect(parsePagination({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: null });
  });

  it('accepts the legal boundary limits 1 and 100 (table)', () => {
    for (const limit of ['1', String(MAX_PAGE_LIMIT)]) {
      expect(parsePagination({ limit }).limit).toBe(Number(limit));
    }
  });

  it('refuses out-of-range and malformed limits without clamping (table)', () => {
    const cases: readonly { readonly name: string; readonly limit: string }[] = [
      { name: 'zero', limit: '0' },
      { name: 'one over the cap', limit: '101' },
      { name: 'negative', limit: '-5' },
      { name: 'fractional', limit: '2.5' },
      { name: 'garbage', limit: 'all' },
      { name: 'padded digits', limit: '1 0' },
    ];
    for (const c of cases) {
      expectQueryCode(() => parsePagination({ limit: c.limit }), 'HTTP_QUERY_INVALID');
    }
  });

  it('ignores a blank limit and keeps the default', () => {
    expect(parsePagination({ limit: '   ' })).toEqual({ limit: DEFAULT_PAGE_LIMIT, cursor: null });
  });

  it('passes an opaque cursor through and refuses one over the length cap', () => {
    expect(parsePagination({ cursor: 'eyJpZCI6MTAwfQ' }).cursor).toBe('eyJpZCI6MTAwfQ');
    expectQueryCode(() => parsePagination({ cursor: 'c'.repeat(513) }), 'HTTP_QUERY_INVALID');
  });

  it('a 512-char cursor is exactly at the legal boundary', () => {
    expect(parsePagination({ cursor: 'c'.repeat(512) }).cursor).toHaveLength(512);
  });
});

describe('parseSorting — whitelist-based, deny-by-default', () => {
  const WHITELIST = ['createdAt', 'amountMinor', 'customerName'];

  it('defaults to no field, ascending', () => {
    expect(parseSorting({}, WHITELIST)).toEqual({ field: null, order: 'asc' });
  });

  it('accepts whitelisted fields with case-insensitive order (table)', () => {
    const cases: readonly { readonly query: Record<string, string>; readonly expected: { field: string; order: 'asc' | 'desc' } }[] = [
      { query: { sort: 'createdAt' }, expected: { field: 'createdAt', order: 'asc' } },
      { query: { sort: 'amountMinor', order: 'DESC' }, expected: { field: 'amountMinor', order: 'desc' } },
      { query: { sort: ' customerName ' }, expected: { field: 'customerName', order: 'asc' } },
    ];
    for (const c of cases) {
      expect(parseSorting(c.query, WHITELIST)).toEqual(c.expected);
    }
  });

  it('refuses fields outside the whitelist — arbitrary client sorts are how you scan a database', () => {
    expectQueryCode(() => parseSorting({ sort: 'passwordHash' }, WHITELIST), 'HTTP_QUERY_INVALID');
  });

  it('refuses an illegal order value', () => {
    expectQueryCode(() => parseSorting({ sort: 'createdAt', order: 'up' }, WHITELIST), 'HTTP_QUERY_INVALID');
  });
});

describe('paginatedMeta — the consistent list envelope', () => {
  it('omits total when unknown', () => {
    expect(paginatedMeta('next-1')).toEqual({ pagination: { nextCursor: 'next-1' } });
  });

  it('carries total when the resource knows it, and null when the page is the last', () => {
    expect(paginatedMeta('next-2', 41)).toEqual({ pagination: { nextCursor: 'next-2', total: 41 } });
    expect(paginatedMeta(null, 0)).toEqual({ pagination: { nextCursor: null, total: 0 } });
  });
});
