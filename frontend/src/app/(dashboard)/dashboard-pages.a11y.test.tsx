import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import OverviewPage from './page';
import PaymentsPage from './payments/page';
import ReconciliationPage from './reconciliation/page';
import CustomersPage from './customers/page';
import SettingsPage from './settings/page';
import type { FetchLike } from '@/lib/api/client';
import { paymentListEmptyExample, paymentListExample } from '@/lib/api/fixtures/payments';
import { receivableListEmptyExample } from '@/lib/api/fixtures/receivables';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';

// =============================================================================
// (DASHBOARD) PAGES A11Y — per-page assertions for issue #146 acceptance 1:
// every (dashboard) page renders a section labelled by its h1 (landmark),
// busy states are announced (aria-busy), data tables carry accessible names,
// and every control has a real accessible name. Shell chrome (skip link /
// landmarks) is covered by app-shell.a11y.test.tsx.
//
// The pages read through defaultClient (global fetch), so the transport is
// stubbed per test with spec-derived fixtures — the component stack under
// test (typed client → query → derivation → render) is the real one.
// =============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'pages-rid' },
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Overview page a11y', () => {
  it('labels its section with the h1 and announces the three headline regions', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/v1/receivables': { status: 200, body: receivableListEmptyExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
      }),
    );
    render(
      <QueryProviders>
        <OverviewPage />
      </QueryProviders>,
    );

    const heading = await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(heading).toHaveAttribute('id', 'overview-heading');
    const section = heading.closest('section');
    expect(section).toHaveAttribute('aria-labelledby', 'overview-heading');

    for (const regionName of ['Outstanding receivables', 'Overdue', 'Unmatched cash']) {
      const region = screen.getByRole('region', { name: regionName });
      await waitFor(() => expect(region).toHaveAttribute('aria-busy', 'false'));
    }

    // Empty read models render the designed empty state — real text, three of.
    expect(screen.getAllByText('Nothing here yet')).toHaveLength(3);
    // No nameless controls and no alert states on the empty path.
    for (const control of screen.queryAllByRole('button')) {
      expect(control).toHaveAccessibleName();
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Payments page a11y', () => {
  it('labels its section, names the ledger table, and names pagination controls', async () => {
    // Multi-page shape (honest server cursor) so both pagination controls'
    // enabled states are exercised in one render.
    vi.stubGlobal(
      'fetch',
      routeFetch({
        '/v1/payments': {
          status: 200,
          body: {
            ...paymentListExample,
            meta: { pagination: { nextCursor: 'cursor-page-2', total: 42 } },
          },
        },
      }),
    );
    render(
      <QueryProviders>
        <PaymentsPage />
      </QueryProviders>,
    );

    const heading = await screen.findByRole('heading', { level: 1, name: 'Payments' });
    expect(heading).toHaveAttribute('id', 'payments-heading');
    expect(heading.closest('section')).toHaveAttribute('aria-labelledby', 'payments-heading');

    // The ledger table is named for assistive tech (WCAG 1.3.1) and its
    // headers are real column scopes.
    const table = await screen.findByRole('table', { name: 'Payments ledger' });
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map((header) => header.textContent)).toEqual([
      'Receipt',
      'Channel',
      'State',
      'Requested',
      'Confirmed',
      'Unapplied',
      'Initiated',
    ]);
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col');
    }

    // Pagination is native buttons with visible text (keyboard operable,
    // 2.1.1 / 4.1.2); "Previous" is inert on the first page.
    const previous = screen.getByRole('button', { name: 'Previous' });
    expect(previous).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(previous.className).toContain('focus-visible:outline-accent');
    // The page indicator is real text (not an unlabeled progress graphic).
    expect(screen.getByText(/page 1/)).toHaveTextContent('page 1 of ≤ 3');
  });

  it('announces refusals as alerts with a named retry control', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ '/v1/payments': { status: 401, body: unauthorizedExample } }),
    );
    render(
      <QueryProviders>
        <PaymentsPage />
      </QueryProviders>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Payments are unavailable');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // A refusal never renders a data table (no fabricated rows).
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('Static dashboard pages a11y', () => {
  const cases = [
    { render: <ReconciliationPage />, name: 'Reconciliation', id: 'reconciliation-heading' },
    {
      // Customer 360 (#134) mounts the derived directory through react-query —
      // the page needs the provider and a stubbed transport like every other
      // read-model surface. Empty read models render its honest empty state.
      render: <CustomersPage />,
      name: 'Customers',
      id: 'customers-heading',
      routes: {
        '/v1/receivables': { status: 200, body: receivableListEmptyExample },
        '/v1/payments': { status: 200, body: paymentListEmptyExample },
      },
    },
    { render: <SettingsPage />, name: 'Settings', id: 'settings-heading' },
  ] as const;

  for (const testCase of cases) {
    it(`labels the ${testCase.name} section with its h1 and keeps controls named`, async () => {
      if ('routes' in testCase) {
        vi.stubGlobal('fetch', routeFetch(testCase.routes));
      }
      render(<QueryProviders>{testCase.render}</QueryProviders>);

      const heading = await screen.findByRole('heading', { level: 1, name: testCase.name });
      expect(heading).toHaveAttribute('id', testCase.id);
      expect(heading.closest('section')).toHaveAttribute('aria-labelledby', testCase.id);

      // Read-model surfaces resolve through react-query — wait for every busy
      // region to settle before asserting the settled (empty) state.
      await waitFor(() => {
        expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      });

      // These surfaces are honest empties: no interactive controls to trip on.
      expect(screen.queryAllByRole('button')).toHaveLength(0);
      expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    });
  }
});
