import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { StatementTimeline } from '@/app/(portal)/_components/statement-timeline';
import { createFuatiliaClient, type FetchLike, type FuatiliaClient } from '@/lib/api/client';
import { specPayment, syntheticPaymentFullyApplied } from '@/lib/api/fixtures/payments';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';
import type { PaymentView } from '@/lib/api/wire-types';

// AccessRefused (rendered on 401/403) pulls the App Router hook; the views
// under test are not the router, so stub it out for this suite.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// =============================================================================
// STATEMENT TIMELINE (issue #86 view c): confirmations, allocations, refunds,
// reversals and failures from the payment read model, newest first, money in
// exact integer minor units. Cap hit → disclosed, never silently truncated.
// =============================================================================

/** Failed + reversed variants (synthesized, schema-shaped — test-only). */
const failedPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000021',
  externalRef: 'SBK41XQ7S0',
  state: 'failed',
  confirmed: null,
  unapplied: { minor: 0, currency: 'KES' },
  confirmedAt: null,
  failedAt: '2026-09-04T18:30:00.000Z',
  failureCode: 'MPESA_REQUEST_CANCELLED',
};

const reversedPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000022',
  externalRef: 'SBK41XQ7S1',
  state: 'reversed',
  reversedAt: '2026-09-07T08:00:00.000Z',
  reversalReason: 'bank reversal',
};

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

function renderStatement(fetchImpl: FetchLike): void {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://portal.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  render(
    <QueryProviders>
      <StatementTimeline client={client} />
    </QueryProviders>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatementTimeline loading state', () => {
  it('renders the skeleton while the query is pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderStatement(neverFetch);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Statement activity' })).toHaveAttribute(
        'data-state',
        'loading',
      );
    });
    expect(screen.getByRole('presentation')).toBeInTheDocument();
  });
});

describe('StatementTimeline loaded state', () => {
  it('renders all five entry kinds newest-first with exact money', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': {
          status: 200,
          body: {
            data: {
              payments: [
                specPayment, // confirmation only
                syntheticPaymentFullyApplied, // confirmation + allocation
                failedPayment, // failure
                reversedPayment, // reversal
              ],
            },
            meta: { pagination: { nextCursor: null, total: 4 } },
          },
        },
      }),
    );

    const timeline = await screen.findByTestId('statement-timeline');
    const items = within(timeline).getAllByRole('listitem');
    // Newest first: reversal (09-07) → failure (09-04T18:30) → allocation
    // (09-04T11:00) → the three confirmations (09-04T10:01, key tie-break).
    // reversedPayment was confirmed before it was reversed, so it carries
    // BOTH its confirmation and its reversal entry.
    expect(items).toHaveLength(6);

    expect(items[0]).toHaveTextContent('reversed');
    expect(items[0]).toHaveTextContent('KES 7,500.00');
    expect(items[0]).toHaveTextContent('reason: bank reversal');
    expect(items[0]).toHaveTextContent('SBK41XQ7S1');

    expect(items[1]).toHaveTextContent('payment failed');
    expect(items[1]).toHaveTextContent('KES 7,500.00');
    expect(items[1]).toHaveTextContent('attempted');
    expect(items[1]).toHaveTextContent('failure code: MPESA_REQUEST_CANCELLED');
    expect(items[1]).toHaveTextContent('SBK41XQ7S0');

    expect(items[2]).toHaveTextContent('applied to invoice');
    expect(items[2]).toHaveTextContent('KES 7,500.00');
    expect(items[2]).toHaveTextContent('SBK41XQ7RU');

    expect(items[3]).toHaveTextContent('payment confirmed');
    expect(items[3]).toHaveTextContent('KES 7,500.00');
    expect(items[3]).toHaveTextContent('SBK41XQ7RT');

    expect(items[4]).toHaveTextContent('payment confirmed');
    expect(items[4]).toHaveTextContent('KES 7,500.00');
    expect(items[4]).toHaveTextContent('SBK41XQ7RU');

    expect(items[5]).toHaveTextContent('payment confirmed');
    expect(items[5]).toHaveTextContent('KES 7,500.00');
    expect(items[5]).toHaveTextContent('SBK41XQ7S1');

    // No truncation on an exhausted walk.
    expect(screen.queryByTestId('statement-truncated')).toBeNull();
  });

  it('renders refunds with reason and exact money', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': {
          status: 200,
          body: {
            data: {
              payments: [
                {
                  ...specPayment,
                  id: 'bb0b0b0b-0000-4000-8000-000000000023',
                  state: 'partially_refunded',
                  refunds: [
                    {
                      id: 'dd0d0d0d-0000-4000-8000-000000000023',
                      amount: { minor: 100000, currency: 'KES' },
                      reason: 'duplicate payment',
                      recordedAt: '2026-09-06T09:00:00.000Z',
                    },
                  ],
                },
              ],
            },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
      }),
    );
    const timeline = await screen.findByTestId('statement-timeline');
    expect(timeline).toHaveTextContent('refund');
    expect(timeline).toHaveTextContent('KES 1,000.00');
    expect(timeline).toHaveTextContent('reason: duplicate payment');
    expect(timeline).toHaveTextContent('2026-09-06 09:00:00Z');
  });

  it('discloses the page cap instead of silently truncating', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': {
          status: 200,
          body: {
            data: { payments: [specPayment] },
            meta: { pagination: { nextCursor: '20', total: 500 } },
          },
        },
      }),
    );
    const notice = await screen.findByTestId('statement-truncated');
    expect(notice).toHaveTextContent('page cap was reached');
    expect(notice).toHaveTextContent('older activity is not listed');
  });
});

describe('StatementTimeline empty state', () => {
  it('renders the designed empty state when no payments exist', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': {
          status: 200,
          body: { data: { payments: [] }, meta: { pagination: { nextCursor: null, total: 0 } } },
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Statement activity' })).toHaveAttribute(
        'data-state',
        'empty',
      );
    });
    expect(screen.getByTestId('empty-state')).toHaveTextContent('No payments on file yet');
  });
});

describe('StatementTimeline refused + error states', () => {
  it('renders the clean refused state on a 401 envelope (code + requestId)', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': { status: 401, body: unauthorizedExample },
      }),
    );
    const refused = await screen.findByTestId('access-refused');
    expect(refused).toHaveTextContent('Your statement is not available');
    expect(refused).toHaveTextContent('HTTP_UNAUTHENTICATED');
    expect(refused).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    expect(screen.queryByTestId('statement-timeline')).toBeNull();
  });

  it('renders code + requestId + Retry on a 500 envelope', async () => {
    renderStatement(
      routeFetch({
        '/v1/payments': {
          status: 500,
          body: {
            error: { code: 'HTTP_INTERNAL_ERROR', message: 'internal server error' },
            requestId: 'rid-500',
          },
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Statement activity' })).toHaveAttribute(
        'data-state',
        'error',
      );
    });
    const errorState = screen.getByTestId('error-state');
    expect(errorState).toHaveTextContent('HTTP_INTERNAL_ERROR');
    expect(errorState).toHaveTextContent('rid-500');
  });
});
