import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { CaseListView } from './case-list-view';
import { createFuatiliaClient, type FetchLike, type FuatiliaClient } from '@/lib/api/client';
import {
  caseListEmptyExample,
  caseListExample,
  specCase,
  syntheticDisputedCase,
} from '@/lib/api/fixtures/collections';
import { queryInvalidExample } from '@/lib/api/fixtures/errors';

// =============================================================================
// CASE LIST (issue #135): loading / refusal / empty / loaded / load-more /
// sort states over the REAL contract envelope. No optimistic rows — the
// page renders exactly what the read model returned.
// =============================================================================

afterEach(() => {
  cleanup();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-rid' },
  });
}

function renderList(fetchImpl: FetchLike): void {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://collections.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  render(
    <QueryProviders>
      <CaseListView client={client} />
    </QueryProviders>,
  );
}

describe('CaseList loading state', () => {
  it('renders skeletons while the first page is pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderList(neverFetch);
    await waitFor(() => {
      expect(screen.getByTestId('case-list-loading')).toHaveAttribute('aria-busy', 'true');
    });
  });
});

describe('CaseList refusal state', () => {
  it('surfaces the envelope with code + requestId and a retry affordance', async () => {
    renderList(
      routeFetch({
        '/v1/collections/cases': { status: 400, body: queryInvalidExample },
      }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("code: HTTP_QUERY_INVALID");
    expect(alert).toHaveTextContent(`requestId: 9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70`);
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('CaseList empty state', () => {
  it('renders the empty read model honestly (no fabricated rows)', async () => {
    renderList(
      routeFetch({
        '/v1/collections/cases': { status: 200, body: caseListEmptyExample },
      }),
    );
    await screen.findByTestId('empty-state');
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No collections cases yet');
    expect(screen.queryAllByTestId('case-row')).toHaveLength(0);
  });
});

describe('CaseList loaded state', () => {
  it('renders contract rows with state-machine badges and detail links', async () => {
    const secondCase = { ...specCase, id: 'aa0a0a0a-0000-4000-8000-000000000009', caseNumber: 'CASE-000010', derivedStatus: 'disputed' as const };
    renderList(
      routeFetch({
        '/v1/collections/cases': {
          status: 200,
          body: { data: { cases: [specCase, syntheticDisputedCase, secondCase] }, meta: { pagination: { nextCursor: null, total: 3 } } },
        },
      }),
    );
    await screen.findByTestId('case-list-total');
    const rows = screen.getAllByTestId('case-row');
    expect(rows).toHaveLength(3);

    const first = within(rows[0]!);
    expect(first.getByText('CASE-000007')).toHaveAttribute('href', `/collections/${specCase.id}`);
    expect(first.getByTestId('case-priority-badge')).toHaveTextContent('high');
    expect(first.getByTestId('case-status-badge')).toHaveTextContent('Open');
    expect(first.getByTestId('case-derived-badge')).toHaveTextContent('waiting');
    expect(first.getByText('2026-09-01 11:30')).toBeInTheDocument(); // 08:30Z + 3h Nairobi

    // The disputed overlay renders its danger badge on the right row.
    const disputedRow = rows.find((row) => within(row).queryByText('CASE-000010') !== null);
    expect(disputedRow).toBeDefined();
    expect(within(disputedRow!).getByTestId('case-derived-badge')).toHaveTextContent('disputed');

    expect(screen.getByTestId('case-list-total')).toHaveTextContent('3 of 3 case(s) shown');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('CaseList load-more state', () => {
  it('appends the second page from meta.pagination.nextCursor — honestly, per page', async () => {
    const user = userEvent.setup();
    renderList(
      pagedFetch([
        {
          status: 200,
          body: {
            data: { cases: [specCase] },
            meta: { pagination: { nextCursor: '20', total: 2 } },
          },
        },
        {
          status: 200,
          body: {
            data: { cases: [syntheticDisputedCase] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
      ]),
    );

    await screen.findByText('CASE-000007');
    expect(screen.getByTestId('case-list-total')).toHaveTextContent('1 of 2 case(s) shown');

    const loadMore = screen.getByRole('button', { name: 'Load more' });
    await user.click(loadMore);

    await screen.findByText('CASE-000010');
    expect(screen.getByTestId('case-list-total')).toHaveTextContent('2 of 2 case(s) shown');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

describe('CaseList sort state', () => {
  it('refetches with the whitelisted sort fields (contract query params)', async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://collections.test',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(`${init.method} ${url}`);
        return jsonResponse(200, caseListExample);
      },
      logger: null,
      requestIdGenerator: () => 'test-req-1',
    });
    render(
      <QueryProviders>
        <CaseListView client={client} />
      </QueryProviders>,
    );
    await screen.findByTestId('case-list-total');
    expect(calls[0]).toContain('sort=caseNumber&order=asc');

    await user.selectOptions(screen.getByLabelText('Sort'), 'priority');
    await waitFor(() => {
      expect(calls.some((call) => call.includes('sort=priority&order=asc'))).toBe(true);
    });

    const direction = screen.getByLabelText('Sort direction');
    await user.selectOptions(direction, 'desc');
    await waitFor(() => {
      expect(calls.some((call) => call.includes('sort=priority&order=desc'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function routeFetch(routes: Record<string, { status: number; body: unknown }>): FetchLike {
  return async (input) => {
    const url = String(input);
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
}

/** Sequential pages for the cursor walk (first call → pages[0], etc.). */
function pagedFetch(pages: Array<{ status: number; body: unknown }>): FetchLike {
  let call = 0;
  return async () => {
    const page = pages[call];
    call += 1;
    if (page === undefined) throw new Error('unexpected extra page fetch');
    return jsonResponse(page.status, page.body);
  };
}
