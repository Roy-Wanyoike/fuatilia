import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import {
  CollectionsScreen,
} from '@/components/command-center/collections-screen';
import {
  createFuatiliaClient,
  type FetchLike,
  type FuatiliaClient,
} from '@/lib/api/client';
import type { Clock } from '@/lib/clock';
import {
  syntheticReceivableDeepAged,
  syntheticReceivableDueToday,
  specReceivable,
  receivableListEmptyExample,
  receivableNotFoundExample,
} from '@/lib/api/fixtures/receivables';
import {
  specPayment,
  syntheticPaymentFullyApplied,
  paymentListEmptyExample,
} from '@/lib/api/fixtures/payments';
import {
  specCase,
  syntheticPromisedCase,
  syntheticPromisedCaseMissed,
  syntheticDisputedCase,
  caseListEmptyExample,
} from '@/lib/api/fixtures/collections';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';

// =============================================================================
// COMMAND CENTER v1 — per-card state coverage (issue #76 acceptance 2/3).
// Every "row" below is a spec-derived fixture; the client is always the real
// typed client (either with a stubbed transport or the REAL fetch stack
// against a dead base URL). No fabricated data path exists: when the backend
// is unreachable, the cards show the refusal, never invented rows.
// =============================================================================

// Fixed "now": 2026-09-04T09:00:00Z == 12:00 Africa/Nairobi (UTC+3).
const NOW: Clock = () => new Date('2026-09-04T09:00:00.000Z');

const CARD_TITLES = [
  'Expected collections today',
  'Overdue',
  'At-risk',
  'Promises due',
  'Missed promises',
  'Unmatched payments',
  'High-value opportunities',
] as const;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-rid' },
  });
}

/** Route stubs by URL fragment — the transport varies, the client never does. */
function routeFetch(routes: Record<string, { status: number; body: unknown }>): FetchLike {
  return async (input) => {
    const url = String(input);
    for (const [fragment, route] of Object.entries(routes)) {
      if (url.includes(fragment)) return jsonResponse(route.status, route.body);
    }
    throw new Error(`no route stub for ${url}`);
  };
}

function renderScreen(fetchImpl: FetchLike): ReturnType<typeof render> {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://command-center.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  return render(
    <QueryProviders>
      <CollectionsScreen client={client} clock={NOW} />
    </QueryProviders>,
  );
}

function cardRegion(name: string): HTMLElement {
  const region = screen.getByRole('region', { name });
  expect(region).toHaveAttribute('data-card-kind');
  return region;
}

async function allCards(kind: string): Promise<void> {
  await waitFor(() => {
    for (const title of CARD_TITLES) {
      expect(cardRegion(title)).toHaveAttribute('data-card-kind', kind);
    }
  });
}

// ---------------------------------------------------------------------------
// LOADING — skeletons on every card before the client resolves
// ---------------------------------------------------------------------------

describe('Command Center loading state', () => {
  it('renders seven skeleton cards while every query is pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderScreen(neverFetch);
    for (const title of CARD_TITLES) {
      expect(cardRegion(title)).toHaveAttribute('aria-busy', 'true');
    }
    await allCards('loading');
    // Each card region carries a skeleton pulse block.
    expect(screen.getAllByRole('presentation')).toHaveLength(CARD_TITLES.length);
  });
});

// ---------------------------------------------------------------------------
// LOADED — spec-fixture rows, deterministic clock, exact integer money
// ---------------------------------------------------------------------------

describe('Command Center loaded state', () => {
  it('derives all seven sections from the typed rows', async () => {
    renderScreen(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: {
              receivables: [specReceivable, syntheticReceivableDueToday, syntheticReceivableDeepAged],
            },
            meta: { pagination: { nextCursor: null, total: 3 } },
          },
        },
        '/v1/payments': {
          status: 200,
          body: {
            data: { payments: [specPayment, syntheticPaymentFullyApplied] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/collections/cases': {
          status: 200,
          body: {
            data: {
              cases: [specCase, syntheticPromisedCase, syntheticPromisedCaseMissed, syntheticDisputedCase],
            },
            meta: { pagination: { nextCursor: null, total: 4 } },
          },
        },
      }),
    );
    await allCards('loaded');

    // 1. Expected collections today — the due-today synthetic only.
    const expected = within(cardRegion('Expected collections today'));
    expect(expected.getByTestId('metric-count')).toHaveTextContent('1');
    expect(expected.getByTestId('metric-total')).toHaveTextContent('KES 75,000.00');

    // 2. Overdue — spec row (0-30) + deep-aged (90+), integer-summed.
    const overdue = within(cardRegion('Overdue'));
    expect(overdue.getByTestId('metric-count')).toHaveTextContent('2');
    expect(overdue.getByTestId('metric-total')).toHaveTextContent('KES 150,000.00');
    const buckets = overdue.getByTestId('overdue-buckets');
    expect(buckets).toHaveTextContent('0-30: 1');
    expect(buckets).toHaveTextContent('31-60: 0');
    expect(buckets).toHaveTextContent('61-90: 0');
    expect(buckets).toHaveTextContent('90+: 1');

    // 3. At-risk — deep-aged rows only (61–90 / 90+).
    const atRisk = within(cardRegion('At-risk'));
    expect(atRisk.getByTestId('metric-count')).toHaveTextContent('1');
    expect(atRisk.getByTestId('metric-total')).toHaveTextContent('KES 75,000.00');

    // 4. Promises due — two promised cases, both with follow-ups ≤ today.
    const promises = within(cardRegion('Promises due'));
    expect(promises.getByTestId('metric-count')).toHaveTextContent('2');
    expect(promises.getByTestId('promises-due-now')).toHaveTextContent('2');
    expect(promises.getByTestId('promises-cases')).toHaveTextContent('CASE-000008');
    expect(promises.getByTestId('promises-cases')).toHaveTextContent('CASE-000009');

    // 5. Missed promises — only the case promised for 2026-09-01.
    const missed = within(cardRegion('Missed promises'));
    expect(missed.getByTestId('metric-count')).toHaveTextContent('1');
    expect(missed.getByTestId('missed-cases')).toHaveTextContent('CASE-000009');
    expect(missed.getByTestId('missed-cases')).not.toHaveTextContent('CASE-000008');

    // 6. Unmatched payments — confirmed with unapplied > 0.
    const unmatched = within(cardRegion('Unmatched payments'));
    expect(unmatched.getByTestId('metric-count')).toHaveTextContent('1');
    expect(unmatched.getByTestId('metric-total')).toHaveTextContent('KES 7,500.00');

    // 7. High-value opportunities — top rows by balance + the book total.
    const opportunities = within(cardRegion('High-value opportunities'));
    expect(opportunities.getAllByRole('row')).toHaveLength(4); // header + 3
    expect(opportunities.getAllByRole('row')[1]).toHaveTextContent('11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b');
    expect(opportunities.getAllByRole('row')[1]).toHaveTextContent('KES 75,000.00');
    // The book total lives on the card region itself (no nested region).
    expect(cardRegion('High-value opportunities')).toHaveTextContent('KES 225,000.00');

    // Derivation provenance ("as of") line with the injected clock.
    expect(screen.getByTestId('command-center-asof')).toHaveTextContent(
      'derived for 2026-09-04 (Africa/Nairobi)',
    );
  });
});

// ---------------------------------------------------------------------------
// EMPTY — real empty read models (source empty), never placeholder rows
// ---------------------------------------------------------------------------

describe('Command Center empty state', () => {
  it('renders the designed empty state when the read models return zero rows', async () => {
    renderScreen(
      routeFetch({
        '/v1/receivables': { status: 200, body: receivableListEmptyExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
        '/v1/collections/cases': { status: 200, body: caseListEmptyExample },
      }),
    );
    await allCards('empty');
    expect(within(cardRegion('Expected collections today')).getByTestId('empty-state')).toHaveTextContent(
      'No receivables on this deployment yet',
    );
    expect(within(cardRegion('Promises due')).getByTestId('empty-state')).toHaveTextContent(
      'No collections cases yet',
    );
    expect(within(cardRegion('Unmatched payments')).getByTestId('empty-state')).toHaveTextContent(
      'No payments on this deployment yet',
    );
  });

  it('distinguishes subset-empty (rows exist, section is 0) from source-empty', async () => {
    renderScreen(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: { data: { receivables: [specReceivable] }, meta: { pagination: { nextCursor: null, total: 1 } } },
        },
        '/v1/payments': {
          status: 200,
          body: { data: { payments: [specPayment] }, meta: { pagination: { nextCursor: null, total: 1 } } },
        },
        '/v1/collections/cases': {
          status: 200,
          body: { data: { cases: [specCase] }, meta: { pagination: { nextCursor: null, total: 1 } } },
        },
      }),
    );
    await waitFor(() => {
      expect(cardRegion('Overdue')).toHaveAttribute('data-card-kind', 'loaded');
    });
    // Rows exist but nothing due today / deep-aged / promised.
    expect(within(cardRegion('Expected collections today')).getByTestId('empty-state')).toHaveTextContent(
      'Nothing falls due today',
    );
    expect(within(cardRegion('At-risk')).getByTestId('empty-state')).toHaveTextContent(
      'Nothing is deep-aged',
    );
    expect(within(cardRegion('Promises due')).getByTestId('empty-state')).toHaveTextContent(
      'No live promised cases',
    );
    expect(within(cardRegion('Missed promises')).getByTestId('empty-state')).toHaveTextContent(
      'No missed promises',
    );
    // While overdue + unmatched still derive real metrics.
    expect(within(cardRegion('Overdue')).getByTestId('metric-count')).toHaveTextContent('1');
    expect(within(cardRegion('Unmatched payments')).getByTestId('metric-count')).toHaveTextContent('1');
  });
});

// ---------------------------------------------------------------------------
// ERROR — contract envelope errors carry code + requestId to the surface
// ---------------------------------------------------------------------------

describe('Command Center error state (API refusals)', () => {
  it('renders the contract code and requestId on a 401 envelope', async () => {
    renderScreen(
      routeFetch({
        '/v1/receivables': { status: 401, body: unauthorizedExample },
        '/v1/payments': { status: 401, body: unauthorizedExample },
        '/v1/collections/cases': { status: 401, body: unauthorizedExample },
      }),
    );
    await allCards('error');
    expect(screen.getAllByTestId('error-state')).toHaveLength(CARD_TITLES.length);
    for (const region of screen.getAllByTestId('error-state')) {
      expect(region).toHaveTextContent('HTTP_UNAUTHENTICATED');
      expect(region).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    }
  });

  it('renders a 404 refusal (HTTP_RECEIVABLE_NOT_FOUND) on the receivable cards', async () => {
    renderScreen(
      routeFetch({
        '/v1/receivables': { status: 404, body: receivableNotFoundExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
        '/v1/collections/cases': { status: 200, body: caseListEmptyExample },
      }),
    );
    await waitFor(() => {
      expect(cardRegion('Expected collections today')).toHaveAttribute('data-card-kind', 'error');
    });
    expect(within(cardRegion('Expected collections today')).getByTestId('error-state')).toHaveTextContent(
      'HTTP_RECEIVABLE_NOT_FOUND',
    );
    expect(cardRegion('Overdue')).toHaveAttribute('data-card-kind', 'error');
    expect(cardRegion('Promises due')).toHaveAttribute('data-card-kind', 'empty');
  });
});

// ---------------------------------------------------------------------------
// DEAD BASE URL — the acceptance-critical case: REAL fetch stack, refused
// TCP connection, seven real error states, zero fabricated rows
// ---------------------------------------------------------------------------

describe('Command Center against an unreachable backend (dead base URL)', () => {
  it('boots every card into its real transport-error state with no invented data', async () => {
    // Port 9 (discard) on loopback: nothing listens → ECONNREFUSED fast.
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 2_000,
      logger: null,
      requestIdGenerator: () => 'dead-url-req-1',
    });
    render(
      <QueryProviders>
        <CollectionsScreen client={client} clock={NOW} />
      </QueryProviders>,
    );

    await allCards('error');
    expect(screen.getAllByTestId('error-state')).toHaveLength(CARD_TITLES.length);
    for (const region of screen.getAllByTestId('error-state')) {
      expect(region).toHaveTextContent('NETWORK');
      expect(region).toHaveTextContent('The API could not be reached');
    }
    // No fabricated business data anywhere: no metrics, no rows, no money.
    expect(screen.queryByTestId('metric-count')).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
    expect(screen.queryByText(/KES/)).toBeNull();
    // The honest subset of content that IS allowed: section chrome + retry.
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(CARD_TITLES.length);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  });

  it('refetches through the same typed client on Retry', async () => {
    let calls = 0;
    const flakyFetch: FetchLike = async (input) => {
      calls += 1;
      const url = String(input);
      // Fail the initial wave AND the first retry wave (3 queries × 2 = 6
      // calls); the second Retry click then succeeds and settles the cards.
      if (calls <= 6) throw new TypeError('fetch failed');
      if (url.includes('/v1/receivables')) {
        return jsonResponse(200, {
          data: { receivables: [specReceivable] },
          meta: { pagination: { nextCursor: null, total: 1 } },
        });
      }
      if (url.includes('/v1/payments')) {
        return jsonResponse(200, paymentListEmptyExample);
      }
      return jsonResponse(200, caseListEmptyExample);
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://recovery.test',
      fetchImpl: flakyFetch,
      logger: null,
      requestIdGenerator: () => 'recovery-req-1',
    });
    render(
      <QueryProviders>
        <CollectionsScreen client={client} clock={NOW} />
      </QueryProviders>,
    );
    await allCards('error');
    // First retry wave: each of the three queries runs again and still fails.
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(6);
    });
    // Second retry wave: queries succeed → cards settle into real states.
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => {
      expect(cardRegion('Overdue')).toHaveAttribute('data-card-kind', 'loaded');
    });
    expect(cardRegion('Promises due')).toHaveAttribute('data-card-kind', 'empty');
    expect(within(cardRegion('Overdue')).getByTestId('metric-total')).toHaveTextContent(
      'KES 75,000.00',
    );
  });
});

// ---------------------------------------------------------------------------
// TRUNCATION — the payload-conscious page cap is disclosed, not hidden
// ---------------------------------------------------------------------------

describe('Command Center truncation disclosure', () => {
  it('shows the truncation notice when the page cap stops the walk', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get('cursor');
      return jsonResponse(200, {
        data: { receivables: cursor === null ? [specReceivable] : [syntheticReceivableDueToday] },
        meta: { pagination: { nextCursor: cursor === null ? '20' : '40', total: 3 } },
      });
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://cap.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'cap-req-1',
    });
    render(
      <QueryProviders>
        {/* maxPages 1 via listAllReceivables defaults is 5; drive the cap by
            stubbing a walk that never exhausts — the screen uses the default
            cap, so assert the notice appears only when truncated data flows.
            To keep this deterministic, override the cap path through the
            client-level default: five pages of one row each. */}
        <CollectionsScreen client={client} clock={NOW} />
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
