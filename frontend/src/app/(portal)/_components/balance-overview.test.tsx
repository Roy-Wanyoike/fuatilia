import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { BalanceOverview } from '@/app/(portal)/_components/balance-overview';
import { createFuatiliaClient, type FetchLike, type FuatiliaClient } from '@/lib/api/client';
import { specPayment, syntheticPaymentFullyApplied } from '@/lib/api/fixtures/payments';
import { specReceivable, syntheticReceivableDeepAged } from '@/lib/api/fixtures/receivables';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';

// AccessRefused (rendered on 401/403) pulls the App Router hook; the views
// under test are not the router, so stub it out for this suite.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// =============================================================================
// BALANCE OVERVIEW (issue #86 view a): outstanding / overdue / held on
// account from the two mounted read models. Every card renders one REAL
// state (loading / refused / error / empty / loaded); money is exact integer
// minor units through lib/money.ts; mixed currencies refuse to total (R10).
// =============================================================================

const CARD_TITLES = ['Outstanding', 'Overdue', 'Held on account'] as const;

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

function renderOverview(fetchImpl: FetchLike): void {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://portal.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  render(
    <QueryProviders>
      <BalanceOverview client={client} />
    </QueryProviders>,
  );
}

function cardRegion(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

async function allCards(state: string): Promise<void> {
  await waitFor(() => {
    for (const title of CARD_TITLES) {
      expect(cardRegion(title)).toHaveAttribute('data-state', state);
    }
  });
}

const oneReceivableEnvelope = {
  data: { receivables: [specReceivable] },
  meta: { pagination: { nextCursor: null, total: 1 } },
};

const oneHeldPaymentEnvelope = {
  data: {
    payments: [{ ...specPayment, unapplied: { minor: 12500, currency: 'KES' } }],
  },
  meta: { pagination: { nextCursor: null, total: 1 } },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BalanceOverview loading state', () => {
  it('renders three skeleton cards while the queries are pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderOverview(neverFetch);
    for (const title of CARD_TITLES) {
      expect(cardRegion(title)).toHaveAttribute('aria-busy', 'true');
    }
    await allCards('loading');
    expect(screen.getAllByRole('presentation')).toHaveLength(CARD_TITLES.length);
  });
});

describe('BalanceOverview loaded state', () => {
  it('renders exact integer minor-unit money from the read models', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': { status: 200, body: oneReceivableEnvelope },
        '/v1/payments': { status: 200, body: oneHeldPaymentEnvelope },
      }),
    );
    await allCards('loaded');

    const outstanding = within(cardRegion('Outstanding'));
    expect(outstanding.getByTestId('balance-card-total')).toHaveTextContent('KES 75,000.00');
    expect(outstanding.getByTestId('balance-card-total')).toHaveTextContent('left to pay');

    // The spec row is overdue — both outstanding and overdue carry it.
    expect(within(cardRegion('Overdue')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 75,000.00',
    );

    // Held on account: confirmed cash with unapplied > 0, exact rendering.
    expect(within(cardRegion('Held on account')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 125.00',
    );
  });

  it('refuses to total a mixed-currency book (R10) and presents count-only', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: {
              receivables: [
                specReceivable,
                { ...specReceivable, id: 'aa0a0a0a-0000-4000-8000-000000000008', currency: 'USD', balance: { minor: 5000, currency: 'USD' } },
              ],
            },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/payments': { status: 200, body: { data: { payments: [] }, meta: { pagination: { nextCursor: null, total: 0 } } } },
      }),
    );
    await waitFor(() => {
      expect(cardRegion('Outstanding')).toHaveAttribute('data-state', 'loaded');
      expect(cardRegion('Held on account')).toHaveAttribute('data-state', 'empty');
    });
    const outstanding = within(cardRegion('Outstanding'));
    expect(outstanding.getByText('2')).toBeInTheDocument();
    expect(outstanding.getByTestId('balance-card-total')).toHaveTextContent(
      'mixed currencies on this account — count only (R10)',
    );
    // The overdue split is mixed too (both rows are overdue) — count-only.
    expect(within(cardRegion('Overdue')).getByTestId('balance-card-total')).toHaveTextContent(
      'mixed currencies on this account — count only (R10)',
    );
  });

  it('keeps overdue split honest: rows exist but nothing overdue', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: {
              receivables: [{ ...specReceivable, overdue: false, aging: { daysPastDue: 0, bucket: '0-30' } }],
            },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
        '/v1/payments': { status: 200, body: { data: { payments: [syntheticPaymentFullyApplied] }, meta: { pagination: { nextCursor: null, total: 1 } } } },
      }),
    );
    await waitFor(() => {
      expect(cardRegion('Outstanding')).toHaveAttribute('data-state', 'loaded');
      expect(cardRegion('Overdue')).toHaveAttribute('data-state', 'empty');
      expect(cardRegion('Held on account')).toHaveAttribute('data-state', 'empty');
    });
    expect(within(cardRegion('Outstanding')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 75,000.00',
    );
    const overdue = within(cardRegion('Overdue'));
    expect(overdue.getByTestId('empty-state')).toHaveTextContent('Nothing overdue');
    // Fully applied payment → nothing held.
    expect(within(cardRegion('Held on account')).getByTestId('empty-state')).toHaveTextContent(
      'Nothing held on account',
    );
  });
});

describe('BalanceOverview empty state', () => {
  it('renders the designed empty states when both read models are empty', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: { data: { receivables: [] }, meta: { pagination: { nextCursor: null, total: 0 } } },
        },
        '/v1/payments': {
          status: 200,
          body: { data: { payments: [] }, meta: { pagination: { nextCursor: null, total: 0 } } },
        },
      }),
    );
    await allCards('empty');
    expect(within(cardRegion('Outstanding')).getByTestId('empty-state')).toHaveTextContent(
      'No invoices on file yet',
    );
    expect(within(cardRegion('Held on account')).getByTestId('empty-state')).toHaveTextContent(
      'No payments on file yet',
    );
  });
});

describe('BalanceOverview refused state (401/403 envelopes)', () => {
  it('renders the clean refused state with code + requestId on a 401 envelope', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': { status: 401, body: unauthorizedExample },
        '/v1/payments': { status: 401, body: unauthorizedExample },
      }),
    );
    await allCards('refused');
    for (const region of screen.getAllByTestId('access-refused')) {
      expect(region).toHaveTextContent('HTTP_UNAUTHENTICATED');
      expect(region).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    }
    // No fabricated numbers anywhere.
    expect(screen.queryByTestId('balance-card-total')).toBeNull();
  });

  it('renders the refused state on a 403 envelope (authenticated, not authorized)', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 403,
          body: {
            error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
            requestId: 'rid-403',
          },
        },
        '/v1/payments': {
          status: 403,
          body: {
            error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
            requestId: 'rid-403',
          },
        },
      }),
    );
    await allCards('refused');
    expect(screen.getAllByTestId('access-refused')[0]).toHaveTextContent('AUTH_ACCESS_DENIED');
  });
});

describe('BalanceOverview error state (other contract envelopes)', () => {
  it('renders code + requestId + Retry on a 500 envelope', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 500,
          body: {
            error: { code: 'HTTP_INTERNAL_ERROR', message: 'internal server error' },
            requestId: 'rid-500',
          },
        },
        '/v1/payments': { status: 200, body: oneHeldPaymentEnvelope },
      }),
    );
    await waitFor(() => {
      expect(cardRegion('Outstanding')).toHaveAttribute('data-state', 'error');
    });
    const errorState = within(cardRegion('Outstanding')).getByTestId('error-state');
    expect(errorState).toHaveTextContent('HTTP_INTERNAL_ERROR');
    expect(errorState).toHaveTextContent('rid-500');
    expect(within(errorState).getByRole('button', { name: 'Retry' })).toBeEnabled();
    // The other card still renders its real data once its query settles.
    await waitFor(() => {
      expect(cardRegion('Held on account')).toHaveAttribute('data-state', 'loaded');
    });
    expect(within(cardRegion('Held on account')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 125.00',
    );
  });

  it('recovers through Retry after a transport failure', async () => {
    let calls = 0;
    const flakyFetch: FetchLike = async (input) => {
      calls += 1;
      const url = String(input);
      if (calls <= 2) throw new TypeError('fetch failed');
      if (url.includes('/v1/receivables')) return jsonResponse(200, oneReceivableEnvelope);
      return jsonResponse(200, oneHeldPaymentEnvelope);
    };
    renderOverview(flakyFetch);
    await waitFor(() => {
      expect(cardRegion('Outstanding')).toHaveAttribute('data-state', 'error');
    });
    const errorState = within(cardRegion('Outstanding')).getByTestId('error-state');
    expect(errorState).toHaveTextContent('NETWORK');
    await userEvent.click(within(errorState).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(cardRegion('Outstanding')).toHaveAttribute('data-state', 'loaded');
    });
    // Only the retried query recovers; the untouched card keeps its real error.
    expect(cardRegion('Held on account')).toHaveAttribute('data-state', 'error');
    expect(within(cardRegion('Outstanding')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 75,000.00',
    );
  });
});

describe('BalanceOverview derivation provenance', () => {
  it('derives from real read-model rows only — no invented cards or metrics', async () => {
    renderOverview(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable, syntheticReceivableDeepAged] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/payments': { status: 200, body: oneHeldPaymentEnvelope },
      }),
    );
    await allCards('loaded');
    // Two outstanding rows: 7,500,000 + 7,500,000 minor = KES 150,000.00.
    expect(within(cardRegion('Outstanding')).getByTestId('balance-card-total')).toHaveTextContent(
      'KES 150,000.00',
    );
    // Exactly the three derived cards — no invented metrics. (The page's
    // labelled <section> is a region too, so the count is scoped to cards.)
    expect(
      screen.getAllByRole('region', { name: /Outstanding|Overdue|Held on account/ }),
    ).toHaveLength(CARD_TITLES.length);
  });
});
