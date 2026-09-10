import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { InvoiceList } from '@/app/(portal)/_components/invoice-list';
import { createFuatiliaClient, type FetchLike, type FuatiliaClient } from '@/lib/api/client';
import {
  receivableListEmptyExample,
  specReceivable,
  syntheticReceivableDeepAged,
} from '@/lib/api/fixtures/receivables';

// AccessRefused (rendered on 401/403) pulls the App Router hook; the views
// under test are not the router, so stub it out for this suite.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// =============================================================================
// INVOICE LIST (issue #86 view b): the receivable read model with state
// badges, aging bucket + days past due, balances in exact minor units, and
// server-driven cursor pagination. 401/403 → clean refused state.
// =============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-rid' },
  });
}

function routeFetch(routes: Record<string, { status: number; body: unknown }>): FetchLike {
  return async (input) => {
    const url = String(input);
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
}

function renderInvoices(fetchImpl: FetchLike): void {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://portal.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  render(
    <QueryProviders>
      <InvoiceList client={client} />
    </QueryProviders>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('InvoiceList loading state', () => {
  it('renders the skeleton while the query is pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderInvoices(neverFetch);
    const card = screen.getByRole('region', { name: 'Invoices' });
    await waitFor(() => {
      expect(card).toHaveAttribute('data-state', 'loading');
    });
    expect(screen.getByRole('presentation')).toBeInTheDocument();
    // The pagination footer only exists once a page has actually loaded.
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });
});

describe('InvoiceList loaded state', () => {
  it('renders rows with state badges, aging buckets, days past due and exact money', async () => {
    renderInvoices(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable, syntheticReceivableDeepAged] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
      }),
    );

    await waitFor(() => {
      // Two rows in the mobile stacked variant (the desktop table mirrors them).
      expect(screen.getAllByTestId('invoice-list-item')).toHaveLength(2);
    });

    // Desktop table variant.
    const table = screen.getByTestId('invoice-table');
    const tableRows = within(table).getAllByRole('row');
    expect(tableRows).toHaveLength(3); // header + 2
    const firstDataRow = tableRows[1]!;
    expect(firstDataRow).toHaveTextContent('0f1e2d3c-4b5a-4968-8776-6554433221ff');
    expect(firstDataRow).toHaveTextContent('partially paid');
    expect(firstDataRow).toHaveTextContent('KES 75,000.00');
    expect(firstDataRow).toHaveTextContent('2026-08-15');
    expect(firstDataRow).toHaveTextContent('overdue');
    expect(firstDataRow).toHaveTextContent('0-30');
    expect(firstDataRow).toHaveTextContent('20 days past due');
    const secondDataRow = tableRows[2]!;
    expect(secondDataRow).toHaveTextContent('90+');
    expect(secondDataRow).toHaveTextContent('126 days past due');

    // Mobile stacked variant carries the same honest data.
    const mobileList = screen.getByTestId('invoice-list');
    expect(within(mobileList).getAllByTestId('invoice-list-item')).toHaveLength(2);
    expect(mobileList).toHaveTextContent('KES 75,000.00');
    expect(mobileList).toHaveTextContent('partially paid');
    expect(mobileList).toHaveTextContent('126 days past due');
  });

  it('renders settled rows without aging as honestly unaged', async () => {
    renderInvoices(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: {
              receivables: [
                {
                  ...specReceivable,
                  state: 'settled',
                  overdue: false,
                  balance: { minor: 0, currency: 'KES' },
                  aging: null,
                  settledAt: '2026-09-01T00:00:00.000Z',
                },
              ],
            },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('invoice-list-item')).toHaveLength(1);
    });
    const table = screen.getByTestId('invoice-table');
    expect(table).toHaveTextContent('settled');
    expect(table).toHaveTextContent('KES 0.00');
    // No aging on settled money — the lane refuses to age settled receivables.
    expect(table).toHaveTextContent('—');
  });

  it('drives pagination from the kernel cursor contract (Next fetches the next page)', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get('cursor');
      return jsonResponse(200, {
        data: {
          receivables:
            cursor === null
              ? [specReceivable]
              : [
                  {
                    ...specReceivable,
                    id: 'aa0a0a0a-0000-4000-8000-000000000009',
                    invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322199',
                  },
                ],
        },
        meta: {
          pagination: { nextCursor: cursor === null ? '20' : null, total: 2 },
        },
      });
    };
    renderInvoices(fetchImpl);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Invoices' })).toHaveAttribute('data-state', 'loaded');
    });
    // total 2, page size 20 → one bounded page.
    expect(screen.getByText('page 1 of ≤ 1')).toBeInTheDocument();
    expect(screen.getByTestId('invoice-table')).toHaveTextContent(
      '0f1e2d3c-4b5a-4968-8776-6554433221ff',
    );

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoice-table')).toHaveTextContent(
        '0f1e2d3c-4b5a-4968-8776-655443322199',
      );
    });
    // Previous becomes available; Next is gone (nextCursor null).
    expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => {
      expect(screen.getByTestId('invoice-table')).toHaveTextContent(
        '0f1e2d3c-4b5a-4968-8776-6554433221ff',
      );
    });
  });
});

describe('InvoiceList empty state', () => {
  it('renders the designed empty state when the read model has no rows', async () => {
    renderInvoices(routeFetch({ '/v1/receivables': { status: 200, body: receivableListEmptyExample } }));
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent('No invoices on file yet');
    });
    expect(screen.queryByTestId('invoice-table')).toBeNull();
    expect(screen.queryByTestId('invoice-list')).toBeNull();
  });
});

describe('InvoiceList refused + error states', () => {
  it('renders the clean refused state on a 401 envelope (code + requestId, no rows)', async () => {
    renderInvoices(
      routeFetch({
        '/v1/receivables': {
          status: 401,
          body: {
            error: {
              code: 'HTTP_UNAUTHENTICATED',
              message: 'authentication required',
            },
            requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
          },
        },
      }),
    );
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('Your invoices are not available');
    expect(refused).toHaveTextContent('HTTP_UNAUTHENTICATED');
    expect(refused).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    expect(screen.queryByTestId('invoice-table')).toBeNull();
  });

  it('renders the refused state on a 403 envelope as well', async () => {
    renderInvoices(
      routeFetch({
        '/v1/receivables': {
          status: 403,
          body: {
            error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
            requestId: 'rid-403',
          },
        },
      }),
    );
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('AUTH_ACCESS_DENIED');
  });

  it('renders code + requestId + Retry on a 500 envelope', async () => {
    renderInvoices(
      routeFetch({
        '/v1/receivables': {
          status: 500,
          body: {
            error: { code: 'HTTP_INTERNAL_ERROR', message: 'internal server error' },
            requestId: 'rid-500',
          },
        },
      }),
    );
    const errorState = await screen.findByTestId('error-state');
    expect(errorState).toHaveTextContent('HTTP_INTERNAL_ERROR');
    expect(errorState).toHaveTextContent('rid-500');
    expect(within(errorState).getByRole('button', { name: 'Retry' })).toBeEnabled();
  });
});
