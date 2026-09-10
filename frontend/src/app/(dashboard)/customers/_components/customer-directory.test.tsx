import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { CustomerDirectory } from './customer-directory';
import {
  createFuatiliaClient,
  type FetchLike,
  type FuatiliaClient,
} from '@/lib/api/client';
import { specPayment, paymentListEmptyExample } from '@/lib/api/fixtures/payments';
import {
  receivableListEmptyExample,
  specReceivable,
} from '@/lib/api/fixtures/receivables';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';
import type { ReceivableView } from '@/lib/api/wire-types';

// =============================================================================
// CUSTOMER DIRECTORY — per-state coverage (issue #134).
// Every row is a spec-derived fixture; the client is always the real typed
// client (stubbed transport or the REAL fetch stack against a dead base
// URL). When the backend is unreachable the screen shows the refusal —
// fabricated customer rows are impossible by construction.
// =============================================================================

const CUSTOMER = '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b';
const OTHER_CUSTOMER = '99990000-1111-4789-8a0b-1c2d3e4f5a6b';

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

function renderDirectory(fetchImpl: FetchLike): ReturnType<typeof render> {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://directory.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  return render(
    <QueryProviders>
      <CustomerDirectory client={client} />
    </QueryProviders>,
  );
}

function region(): HTMLElement {
  const element = screen.getByRole('region', { name: 'Customer directory' });
  expect(element).toHaveAttribute('data-state');
  return element;
}

// ---------------------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------------------

describe('Customer directory loading state', () => {
  it('renders a skeleton while both read models are pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderDirectory(neverFetch);

    expect(region()).toHaveAttribute('aria-busy', 'true');
    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'loading');
    });
    expect(region().querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
    expect(screen.getByRole('presentation')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LOADED — derived identities, exact integer money, deep-view links
// ---------------------------------------------------------------------------

describe('Customer directory loaded state', () => {
  it('derives one row per customerId with outstanding money and a 360 link', async () => {
    renderDirectory(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable] },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
        '/v1/payments': {
          status: 200,
          body: {
            data: { payments: [specPayment] },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
      }),
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'loaded');
    });

    // One derived identity from the two rows (same customerId).
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(2); // header + 1
    expect(rows[1]).toHaveTextContent(CUSTOMER);
    expect(within(rows[1]!).getByTestId('directory-outstanding')).toHaveTextContent(
      '1 KES 75,000.00',
    );
    expect(rows[1]).toHaveTextContent('1 overdue');
    expect(rows[1]).toHaveTextContent('2026-09-04 10:00:00Z');

    const link = screen.getByRole('link', { name: `View customer ${CUSTOMER}` });
    expect(link).toHaveAttribute('href', `/customers/${encodeURIComponent(CUSTOMER)}`);
    expect(screen.getByText('· 1 derived')).toBeInTheDocument();
  });

  it('groups multiple customers and links each to its own 360 view', async () => {
    const otherRow: ReceivableView = {
      ...specReceivable,
      id: 'aa0a0a0a-0000-4000-8000-000000000003',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322104',
      customerId: OTHER_CUSTOMER,
      state: 'open',
      overdue: false,
      applied: { minor: 0, currency: 'KES' },
      balance: { minor: 12500000, currency: 'KES' },
    };
    renderDirectory(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable, otherRow] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/payments': {
          status: 200,
          body: paymentListEmptyExample,
        },
      }),
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'loaded');
    });

    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3); // header + 2 customers
    expect(rows[1]).toHaveTextContent(CUSTOMER); // newest activity first
    expect(rows[2]).toHaveTextContent(OTHER_CUSTOMER);
    expect(within(rows[2]!).getByTestId('directory-outstanding')).toHaveTextContent(
      '1 KES 125,000.00',
    );
    expect(
      screen.getByRole('link', { name: `View customer ${OTHER_CUSTOMER}` }),
    ).toHaveAttribute('href', `/customers/${encodeURIComponent(OTHER_CUSTOMER)}`);
  });

  it('presents count-only when a customer mixes currencies (R10)', async () => {
    const usdRow: ReceivableView = {
      ...specReceivable,
      id: 'aa0a0a0a-0000-4000-8000-000000000004',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322105',
      currency: 'USD',
      original: { minor: 100000, currency: 'USD' },
      applied: { minor: 0, currency: 'USD' },
      balance: { minor: 100000, currency: 'USD' },
      state: 'open',
      overdue: false,
    };
    renderDirectory(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable, usdRow] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
      }),
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'loaded');
    });
    expect(screen.getByTestId('directory-outstanding')).toHaveTextContent(
      '2 mixed currencies — count only (R10)',
    );
  });
});

// ---------------------------------------------------------------------------
// EMPTY — real empty read models, never placeholder rows
// ---------------------------------------------------------------------------

describe('Customer directory empty state', () => {
  it('renders the designed empty state when both read models return zero rows', async () => {
    renderDirectory(
      routeFetch({
        '/v1/receivables': { status: 200, body: receivableListEmptyExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
      }),
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'empty');
    });
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No customer activity yet');
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ERROR — contract envelopes surface code + requestId
// ---------------------------------------------------------------------------

describe('Customer directory error state (API refusals)', () => {
  it('renders the contract code and requestId on a 401 envelope', async () => {
    renderDirectory(
      routeFetch({
        '/v1/receivables': { status: 401, body: unauthorizedExample },
        '/v1/payments': { status: 401, body: unauthorizedExample },
      }),
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'error');
    });
    const error = screen.getByTestId('error-state');
    expect(error).toHaveTextContent('HTTP_UNAUTHENTICATED');
    expect(error).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('recovers through the same typed client when Retry succeeds', async () => {
    let calls = 0;
    const flakyFetch: FetchLike = async (input) => {
      calls += 1;
      if (calls <= 2) throw new TypeError('fetch failed');
      const url = String(input);
      if (url.includes('/v1/receivables')) {
        return jsonResponse(200, {
          data: { receivables: [specReceivable] },
          meta: { pagination: { nextCursor: null, total: 1 } },
        });
      }
      return jsonResponse(200, paymentListEmptyExample);
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://recovery.test',
      fetchImpl: flakyFetch,
      logger: null,
      requestIdGenerator: () => 'recovery-req-1',
    });
    render(
      <QueryProviders>
        <CustomerDirectory client={client} />
      </QueryProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('error-state')).toHaveTextContent('NETWORK');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'loaded');
    });
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// DEAD BASE URL — REAL fetch stack, refused TCP connection, no invented data
// ---------------------------------------------------------------------------

describe('Customer directory against an unreachable backend', () => {
  it('boots into a real transport-error state with no fabricated rows', async () => {
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 2_000,
      logger: null,
      requestIdGenerator: () => 'dead-url-req-1',
    });
    render(
      <QueryProviders>
        <CustomerDirectory client={client} />
      </QueryProviders>,
    );

    await waitFor(() => {
      expect(region()).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByTestId('error-state')).toHaveTextContent('NETWORK');
    expect(screen.getByTestId('error-state')).toHaveTextContent(
      'The API could not be reached',
    );
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByText(/KES/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TRUNCATION — the page cap is disclosed, not hidden
// ---------------------------------------------------------------------------

describe('Customer directory truncation disclosure', () => {
  it('shows the truncation notice when the page cap stops the walk', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/v1/receivables')) {
        return jsonResponse(200, {
          data: { receivables: [specReceivable] },
          meta: { pagination: { nextCursor: '20', total: 3 } },
        });
      }
      return jsonResponse(200, paymentListEmptyExample);
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://cap.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'cap-req-1',
    });
    render(
      <QueryProviders>
        <CustomerDirectory client={client} />
      </QueryProviders>,
    );

    await waitFor(
      () => {
        expect(screen.getByRole('status')).toHaveTextContent('page cap');
      },
      { timeout: 4_000 },
    );
  });
});
