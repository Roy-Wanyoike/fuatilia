import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CaseListView } from '@/app/(dashboard)/collections/_components/case-list-view';
import { OpenCasePanel } from '@/app/(dashboard)/collections/_components/open-case-panel';
import { CaseRecordActionPanel } from '@/app/(dashboard)/collections/_components/case-record-action-panel';
import { CaseCompleteActionPanel } from '@/app/(dashboard)/collections/_components/case-complete-action-panel';
import { CustomerDirectory } from '@/app/(dashboard)/customers/_components/customer-directory';
import { CollectionsScreen } from '@/components/command-center/collections-screen';
import { QueryProviders } from '@/providers/query-provider';
import { createFuatiliaClient, type FetchLike } from '@/lib/api/client';
import { caseListEmptyExample, specCase } from '@/lib/api/fixtures/collections';
import { paymentListEmptyExample } from '@/lib/api/fixtures/payments';
import { receivableListEmptyExample } from '@/lib/api/fixtures/receivables';
import { PortalI18nProvider } from '@/lib/portal-i18n/context';

// =============================================================================
// SW RENDERING — dashboard (issue #180): the collector console genuinely
// SPEAKS Kiswahili once the provider carries a sw locale (the same provider
// + cookie the #149 portal uses). The components' own unit tests render them
// without a provider and pin the en fallback; this file pins the sw one.
// =============================================================================

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-rid' },
  });
}

function renderInSw(ui: React.ReactElement): void {
  render(
    <QueryProviders>
      <PortalI18nProvider initialLocale="sw">{ui}</PortalI18nProvider>
    </QueryProviders>,
  );
}

describe('dashboard rendering in Kiswahili (#180)', () => {
  it('renders the open-case panel in sw: card title and toggle', () => {
    // Collapsed by default: no wire calls, only the card chrome — the
    // cheapest real render that proves the catalog reaches the console.
    renderInSw(<OpenCasePanel />);
    expect(screen.getByText('Fungua kesa')).toBeInTheDocument(); // card title
    expect(screen.getByRole('button', { name: 'Fungua kesa…' })).toBeEnabled();
  });

  it('renders the case list in sw from a real (empty) read-model page', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/v1/collections/cases')) {
        return jsonResponse(200, caseListEmptyExample);
      }
      return jsonResponse(404, { error: { code: 'HTTP_NOT_FOUND', message: 'no route' } });
    };
    const client = createFuatiliaClient({
      baseUrl: 'http://dashboard.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'test-req-1',
    });
    renderInSw(<CaseListView client={client} />);

    // The card title speaks Kiswahili…
    expect(screen.getByText('Kesa')).toBeInTheDocument();
    // …and the honest empty state arrives in Kiswahili once the query settles.
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent('Hakuna kesa za makusanyi bado');
    });
  });

  it('renders the record-action panel in sw: title, labelled fields and submit', () => {
    // Form chrome only — the panel fires no wire calls until submit.
    renderInSw(<CaseRecordActionPanel caseView={specCase} onCaseReplaced={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Rekodi hatua' })).toBeInTheDocument(); // card title
    expect(screen.getByLabelText('Aina')).toBeInTheDocument(); // type select
    expect(screen.getByLabelText(/Imepangwa \(saa za Nairobi\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Chanzo')).toBeInTheDocument(); // source stays a wire value
    expect(screen.getByRole('button', { name: 'Rekodi hatua' })).toBeEnabled();
  });

  it('renders the complete-action panel in sw for a case with no actions yet', () => {
    renderInSw(
      <CaseCompleteActionPanel caseView={{ ...specCase, actions: [] }} onCaseReplaced={() => {}} />,
    );
    expect(screen.getByText('Kamilisha hatua')).toBeInTheDocument();
    expect(screen.getByTestId('case-complete-action-empty')).toHaveTextContent(
      'Hakuna hatua zilizorekodiwa kwenye kesa hii bado',
    );
  });

  it('renders the customer directory in sw from empty read models', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/v1/receivables')) {
        return jsonResponse(200, receivableListEmptyExample);
      }
      if (url.includes('/v1/payments')) {
        return jsonResponse(200, paymentListEmptyExample);
      }
      return jsonResponse(404, { error: { code: 'HTTP_NOT_FOUND', message: 'no route' } });
    };
    vi.stubGlobal('fetch', fetchImpl);
    renderInSw(<CustomerDirectory />);

    expect(screen.getByRole('region', { name: 'Orodha ya wateja' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toHaveTextContent('Hakuna shughuli za wateja bado');
    });
    vi.unstubAllGlobals();
  });

  it('renders the Command Center chrome in sw while the read models are pending', () => {
    // Never-answering fetch: the pending path is the cheapest real render —
    // h1, subtitle and the labelled retry control, all in Kiswahili.
    const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);
    vi.stubGlobal('fetch', neverFetch);
    const client = createFuatiliaClient({
      baseUrl: 'http://dashboard.test',
      fetchImpl: neverFetch,
      logger: null,
      requestIdGenerator: () => 'test-req-1',
    });
    renderInSw(<CollectionsScreen client={client} />);

    expect(screen.getByRole('heading', { level: 1, name: 'Kituo cha Amri cha Makusanyi' }));
    expect(screen.getByText('Timu yangu ya makusanyi ifanye nini sasa hivi?'));
    // With a never-answering wire the queries stay in flight, so refresh is
    // honestly disabled (the a11y suite pins the enabled state separately).
    expect(screen.getByRole('button', { name: 'Onyesha upya' })).toBeDisabled();
    vi.unstubAllGlobals();
  });
});
