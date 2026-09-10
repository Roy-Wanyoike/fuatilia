import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { Customer360 } from './customer-360';
import {
  createFuatiliaClient,
  type FetchLike,
  type FuatiliaClient,
} from '@/lib/api/client';
import type { Clock } from '@/lib/clock';
import {
  paymentListEmptyExample,
  specPayment,
  syntheticPaymentFullyApplied,
} from '@/lib/api/fixtures/payments';
import {
  receivableListEmptyExample,
  specReceivable,
} from '@/lib/api/fixtures/receivables';
import {
  caseListEmptyExample,
  specCase,
  syntheticPromisedCase,
  syntheticPromisedCaseMissed,
} from '@/lib/api/fixtures/collections';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';
import type { CaseView, PaymentView, ReceivableView } from '@/lib/api/wire-types';

// =============================================================================
// CUSTOMER 360 — per-section state coverage (issue #134).
// Every row is a spec-derived fixture; the client is always the real typed
// client (stubbed transport or the REAL fetch stack against a dead base URL).
// When the backend is unreachable every section shows its refusal —
// fabricated business rows are impossible by construction.
// =============================================================================

// Fixed "now": 2026-09-04T09:00:00Z == 12:00 Africa/Nairobi (UTC+3).
const NOW: Clock = () => new Date('2026-09-04T09:00:00.000Z');

const CUSTOMER = '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b';
const OTHER_CUSTOMER = '99990000-1111-4789-8a0b-1c2d3e4f5a6b';

const SECTION_TITLES = [
  'Receivables & aging',
  'Payment history & allocations',
  'Collections cases & promises',
  'Communications timeline',
] as const;

const otherCustomerReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000003',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322104',
  customerId: OTHER_CUSTOMER,
};

const otherCustomerPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000002',
  externalRef: 'SBK41XQ7RV',
  idempotencyKey: 'daraja-c2b-SBK41XQ7RV',
  customerId: OTHER_CUSTOMER,
};

const foreignCase: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000004',
  caseNumber: 'CASE-000011',
  sequence: 11,
  receivableIds: [otherCustomerReceivable.id],
};

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

function renderView(fetchImpl: FetchLike, customerId = CUSTOMER): ReturnType<typeof render> {
  const client: FuatiliaClient = createFuatiliaClient({
    baseUrl: 'http://c360.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'test-req-1',
  });
  return render(
    <QueryProviders>
      <Customer360 customerId={customerId} client={client} clock={NOW} />
    </QueryProviders>,
  );
}

function section(name: (typeof SECTION_TITLES)[number]): HTMLElement {
  const element = screen.getByRole('region', { name });
  expect(element).toHaveAttribute('data-card-kind');
  return element;
}

async function allSections(kind: string): Promise<void> {
  await waitFor(() => {
    for (const title of SECTION_TITLES) {
      expect(section(title)).toHaveAttribute('data-card-kind', kind);
    }
  });
}

// ---------------------------------------------------------------------------
// LOADING — skeletons on every section before the client resolves
// ---------------------------------------------------------------------------

describe('Customer 360 loading state', () => {
  it('renders four skeleton sections while every query is pending', async () => {
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    renderView(neverFetch);

    // Header identity is present while loading.
    expect(screen.getByRole('heading', { level: 1, name: 'Customer 360' })).toBeInTheDocument();
    expect(screen.getByTestId('customer-id')).toHaveTextContent(CUSTOMER);
    expect(screen.getByRole('link', { name: 'All customers' })).toHaveAttribute(
      'href',
      '/customers',
    );

    for (const title of SECTION_TITLES) {
      expect(section(title)).toHaveAttribute('aria-busy', 'true');
    }
    await allSections('loading');
    expect(screen.getAllByRole('presentation')).toHaveLength(SECTION_TITLES.length);
  });
});

// ---------------------------------------------------------------------------
// LOADED — spec fixtures, per-section derivation, exact integer money
// ---------------------------------------------------------------------------

describe('Customer 360 loaded state', () => {
  it('derives all four sections from the typed rows', async () => {
    renderView(
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
            data: { payments: [specPayment, syntheticPaymentFullyApplied] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/collections/cases': {
          status: 200,
          body: {
            data: {
              cases: [specCase, syntheticPromisedCase, syntheticPromisedCaseMissed],
            },
            meta: { pagination: { nextCursor: null, total: 3 } },
          },
        },
      }),
    );
    await allSections('loaded');

    // 1. Receivables & aging — outstanding/overdue stats, bucket badges, table.
    // specReceivable.balance = 7,500,000 minor = KES 75,000.00 (spec example).
    const receivables = within(section('Receivables & aging'));
    expect(receivables.getByTestId('stat-outstanding')).toHaveTextContent('KES 75,000.00');
    expect(receivables.getByTestId('stat-overdue')).toHaveTextContent('KES 75,000.00');
    expect(receivables.getByTestId('aging-buckets')).toHaveTextContent('0-30');
    expect(receivables.getByTestId('aging-buckets')).toHaveTextContent('KES 75,000.00');
    // Empty buckets disclose '—' — never a fabricated 'beyond range' claim.
    expect(receivables.getByTestId('aging-buckets')).toHaveTextContent('0 · —');
    const receivableRows = receivables.getAllByRole('row');
    expect(receivableRows).toHaveLength(2); // header + spec row
    expect(receivableRows[1]).toHaveTextContent('0f1e2d3c-4b5a-4968-8776-6554433221ff');
    expect(receivableRows[1]).toHaveTextContent('partially_paid');
    expect(receivableRows[1]).toHaveTextContent('KES 75,000.00');
    expect(receivableRows[1]).toHaveTextContent('overdue');
    expect(receivableRows[1]).toHaveTextContent('20d');

    // 2. Payment history & allocations — confirmed/held stats + ledger lines.
    // Both payments confirmed (750,000 minor each → KES 15,000.00); only
    // specPayment still holds unapplied money (KES 7,500.00).
    const payments = within(section('Payment history & allocations'));
    expect(payments.getByTestId('stat-confirmed')).toHaveTextContent('KES 15,000.00');
    expect(payments.getByTestId('stat-held-on-account')).toHaveTextContent('KES 7,500.00');
    expect(payments.getByTestId('payment-history').children).toHaveLength(2);
    const ledger = payments.getByTestId(`payment-${syntheticPaymentFullyApplied.id}-ledger`);
    expect(ledger).toHaveTextContent('KES 7,500.00');
    expect(ledger).toHaveTextContent(`applied to receivable ${specReceivable.id}`);
    expect(section('Payment history & allocations')).toHaveTextContent('SBK41XQ7RT');

    // 3. Collections cases & promises — attributed cases + promise postures.
    // All three cases are status 'open' on the wire (the promised overlay is
    // derivedStatus, not status) — so all three count as open.
    const cases = within(section('Collections cases & promises'));
    expect(cases.getByTestId('open-case-count')).toHaveTextContent('3 open (3 total');
    expect(cases.getByText('CASE-000007')).toBeInTheDocument();
    const promises = cases.getByTestId('promises');
    expect(promises).toHaveTextContent('CASE-000008');
    expect(promises).toHaveTextContent('due now');
    expect(promises).toHaveTextContent('CASE-000009');
    expect(promises).toHaveTextContent('missed');

    // 4. Communications timeline — case actions, newest scheduled first.
    const comms = within(section('Communications timeline'));
    const entries = comms.getByTestId('comms-timeline').children;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent('pending');
    expect(entries[0]).toHaveTextContent('CASE-000008');
    expect(entries[1]).toHaveTextContent('completed');
    expect(entries[1]).toHaveTextContent('promised to clear balance on 2026-09-04');
    expect(entries[2]).toHaveTextContent('CASE-000009');
    expect(entries[2]).toHaveTextContent('fieldVisit');
  });

  it('renders only the rows attributable to this customer', async () => {
    renderView(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [specReceivable, otherCustomerReceivable] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/payments': {
          status: 200,
          body: {
            data: { payments: [specPayment, otherCustomerPayment] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
        '/v1/collections/cases': {
          status: 200,
          body: {
            data: { cases: [specCase, foreignCase] },
            meta: { pagination: { nextCursor: null, total: 2 } },
          },
        },
      }),
    );
    await waitFor(() => {
      expect(section('Receivables & aging')).toHaveAttribute('data-card-kind', 'loaded');
      expect(section('Payment history & allocations')).toHaveAttribute('data-card-kind', 'loaded');
      expect(section('Collections cases & promises')).toHaveAttribute('data-card-kind', 'loaded');
      // specCase (the spec example) carries no recorded actions — the comms
      // timeline is subset-empty, honestly, not loaded with invented entries.
      expect(section('Communications timeline')).toHaveAttribute('data-card-kind', 'empty');
    });

    const receivables = within(section('Receivables & aging'));
    expect(receivables.getAllByRole('row')).toHaveLength(2); // header + ours only
    expect(receivables.queryByText('0f1e2d3c-4b5a-4968-8776-655443322104')).toBeNull();

    const payments = within(section('Payment history & allocations'));
    expect(payments.getByTestId('payment-history').children).toHaveLength(1);
    expect(payments.queryByText('SBK41XQ7RV')).toBeNull();

    const cases = within(section('Collections cases & promises'));
    expect(cases.getByText('CASE-000007')).toBeInTheDocument();
    expect(cases.queryByText('CASE-000011')).toBeNull();

    // specCase is the spec example — it carries no recorded actions yet, so
    // the timeline discloses that instead of rendering fabricated entries.
    expect(
      within(section('Communications timeline')).getByTestId('empty-state'),
    ).toHaveTextContent('No case actions for this customer yet');
  });
});

// ---------------------------------------------------------------------------
// EMPTY — unknown ids and empty deployments render disclosed states
// ---------------------------------------------------------------------------

describe('Customer 360 empty states', () => {
  it('discloses that nothing is attributable when the id has no activity', async () => {
    renderView(
      routeFetch({
        '/v1/receivables': {
          status: 200,
          body: {
            data: { receivables: [otherCustomerReceivable] },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
        '/v1/payments': {
          status: 200,
          body: { data: { payments: [otherCustomerPayment] }, meta: { pagination: { nextCursor: null, total: 1 } } },
        },
        '/v1/collections/cases': {
          status: 200,
          body: { data: { cases: [foreignCase] }, meta: { pagination: { nextCursor: null, total: 1 } } },
        },
      }),
      'unknown-customer-id',
    );
    // Every section settles into its SUBSET-empty card kind (the sources have
    // rows — none of them attribute this id).
    await allSections('empty');

    // Top-level honest unknown-customer state (no directory to 404 against).
    expect(screen.getByTestId('no-customer-activity')).toHaveTextContent(
      'No /v1 activity is attributable to this customer id',
    );
    // Each section settles into its subset-empty state.
    expect(within(section('Receivables & aging')).getByTestId('empty-state')).toHaveTextContent(
      'No receivables carry this customer id',
    );
    expect(
      within(section('Payment history & allocations')).getByTestId('empty-state'),
    ).toHaveTextContent('No payments carry this customer id');
    expect(
      within(section('Collections cases & promises')).getByTestId('empty-state'),
    ).toHaveTextContent("No cases touch this customer's receivables");
    expect(
      within(section('Communications timeline')).getByTestId('empty-state'),
    ).toHaveTextContent('No case actions for this customer yet');
  });

  it('renders source-empty states when the read models have no rows at all', async () => {
    renderView(
      routeFetch({
        '/v1/receivables': { status: 200, body: receivableListEmptyExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
        '/v1/collections/cases': { status: 200, body: caseListEmptyExample },
      }),
    );
    await allSections('empty');

    expect(within(section('Receivables & aging')).getByTestId('empty-state')).toHaveTextContent(
      'No receivables on this deployment yet',
    );
    expect(
      within(section('Payment history & allocations')).getByTestId('empty-state'),
    ).toHaveTextContent('No payments on this deployment yet');
    expect(
      within(section('Collections cases & promises')).getByTestId('empty-state'),
    ).toHaveTextContent('No collections cases yet');
    expect(
      within(section('Communications timeline')).getByTestId('empty-state'),
    ).toHaveTextContent('No collections cases yet');
  });
});

// ---------------------------------------------------------------------------
// ERROR — contract envelopes surface code + requestId, sections stay decoupled
// ---------------------------------------------------------------------------

describe('Customer 360 error state (API refusals)', () => {
  it('renders the contract code and requestId on a 401 envelope', async () => {
    renderView(
      routeFetch({
        '/v1/receivables': { status: 401, body: unauthorizedExample },
        '/v1/payments': { status: 401, body: unauthorizedExample },
        '/v1/collections/cases': { status: 401, body: unauthorizedExample },
      }),
    );
    await allSections('error');

    const errors = screen.getAllByTestId('error-state');
    expect(errors).toHaveLength(SECTION_TITLES.length);
    for (const error of errors) {
      expect(error).toHaveTextContent('HTTP_UNAUTHENTICATED');
      expect(error).toHaveTextContent('9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70');
    }
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(
      SECTION_TITLES.length,
    );
  });

  it('keeps sections decoupled: a refused source never blanks its siblings', async () => {
    renderView(
      routeFetch({
        '/v1/receivables': { status: 401, body: unauthorizedExample },
        '/v1/payments': {
          status: 200,
          body: {
            data: { payments: [specPayment] },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
        '/v1/collections/cases': {
          status: 200,
          body: {
            data: { cases: [specCase] },
            meta: { pagination: { nextCursor: null, total: 1 } },
          },
        },
      }),
    );
    await waitFor(() => {
      expect(section('Payment history & allocations')).toHaveAttribute(
        'data-card-kind',
        'loaded',
      );
    });

    // Receivables refused → its own error state.
    const receivablesError = within(section('Receivables & aging')).getByTestId('error-state');
    expect(receivablesError).toHaveTextContent('HTTP_UNAUTHENTICATED');

    // Payments did NOT need receivables → loaded with real money.
    const payments = within(section('Payment history & allocations'));
    expect(payments.getByTestId('payment-history').children).toHaveLength(1);

    // Cases link to customers only through receivableIds → attribution says so.
    const casesError = within(
      section('Collections cases & promises'),
    ).getByTestId('error-state');
    expect(casesError).toHaveTextContent('Case attribution is unavailable');
    expect(casesError).toHaveTextContent('HTTP_UNAUTHENTICATED');
    const commsError = within(section('Communications timeline')).getByTestId('error-state');
    expect(commsError).toHaveTextContent('Comms attribution is unavailable');
  });
});

// ---------------------------------------------------------------------------
// DEAD BASE URL — REAL fetch stack, refused TCP connection, no invented data
// ---------------------------------------------------------------------------

describe('Customer 360 against an unreachable backend (dead base URL)', () => {
  it('boots every section into its real transport-error state with no invented data', async () => {
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://127.0.0.1:9',
      timeoutMs: 2_000,
      logger: null,
      requestIdGenerator: () => 'dead-url-req-1',
    });
    render(
      <QueryProviders>
        <Customer360 customerId={CUSTOMER} client={client} clock={NOW} />
      </QueryProviders>,
    );

    await allSections('error');
    const errors = screen.getAllByTestId('error-state');
    for (const error of errors) {
      expect(error).toHaveTextContent('NETWORK');
      expect(error).toHaveTextContent('The API could not be reached');
    }
    // No fabricated business data anywhere: no money, no rows, no timelines.
    expect(screen.queryByText(/KES/)).toBeNull();
    expect(screen.queryByTestId('payment-history')).toBeNull();
    expect(screen.queryByTestId('comms-timeline')).toBeNull();
    expect(screen.queryByTestId('aging-buckets')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(
      SECTION_TITLES.length,
    );
  });

  it('recovers every section through the same typed client when Retry succeeds', async () => {
    let calls = 0;
    const flakyFetch: FetchLike = async (input) => {
      calls += 1;
      if (calls <= 3) throw new TypeError('fetch failed');
      const url = String(input);
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
        <Customer360 customerId={CUSTOMER} client={client} clock={NOW} />
      </QueryProviders>,
    );

    await allSections('error');
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    await waitFor(() => {
      expect(section('Receivables & aging')).toHaveAttribute('data-card-kind', 'loaded');
    });
    expect(section('Payment history & allocations')).toHaveAttribute('data-card-kind', 'empty');
    expect(section('Collections cases & promises')).toHaveAttribute('data-card-kind', 'empty');
    expect(within(section('Receivables & aging')).getAllByRole('row')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// TRUNCATION — the payload-conscious page cap is disclosed, not hidden
// ---------------------------------------------------------------------------

describe('Customer 360 truncation disclosure', () => {
  it('shows the truncation notice when the page cap stops the walk', async () => {
    let receivablePages = 0;
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/v1/receivables')) {
        receivablePages += 1;
        // Each walked page carries a distinct row — the cursor advances, the
        // cap stops the walk, and no row key ever collides.
        const pageRow: ReceivableView = {
          ...specReceivable,
          id: `6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a${receivablePages}`,
        };
        return jsonResponse(200, {
          data: { receivables: [pageRow] },
          meta: { pagination: { nextCursor: '20', total: 3 } },
        });
      }
      if (url.includes('/v1/payments')) {
        return jsonResponse(200, paymentListEmptyExample);
      }
      return jsonResponse(200, caseListEmptyExample);
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://cap.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'cap-req-1',
    });
    render(
      <QueryProviders>
        <Customer360 customerId={CUSTOMER} client={client} clock={NOW} />
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
