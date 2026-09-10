import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { BalanceOverview } from '@/app/(portal)/_components/balance-overview';
import { PortalGate } from '@/app/(portal)/_components/portal-gate';
import { PortalShell } from '@/app/(portal)/_components/portal-shell';
import { createFuatiliaClient, type FetchLike, type FuatiliaClient } from '@/lib/api/client';
import { specReceivable } from '@/lib/api/fixtures/receivables';
import { PortalI18nProvider } from '@/lib/portal-i18n/context';

// =============================================================================
// SW RENDERING (issue #149): the portal must genuinely SPEAK Kiswahili —
// every view renders its real strings from the sw catalog, and without a
// provider everything stays English (en is the default).
// =============================================================================

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}));

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-rid' },
  });
}

function renderInSw(ui: React.ReactElement): void {
  render(<PortalI18nProvider initialLocale="sw">{ui}</PortalI18nProvider>);
}

describe('portal rendering in Kiswahili', () => {
  it('renders the gate in sw: heading, labelled input, explainer and submit', () => {
    renderInSw(<PortalGate />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Fuatilia — portal ya malipa' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Nambari ya ufikiaji ya portal')).toHaveAttribute(
      'type',
      'password',
    );
    expect(screen.getByRole('button', { name: 'Fungua akaunti yangu' })).toBeEnabled();
    // The tokenization disclosure survives translation (word order shifts).
    expect(screen.getByText(/HTTP-only, SameSite=Strict/)).toBeInTheDocument();
    expect(screen.getByText(/Haiwekwi kwenye URL/)).toBeInTheDocument();
  });

  it('renders the shell in sw: nav labels, sign-out and the skip link', () => {
    renderInSw(
      <PortalShell>
        <p>content</p>
      </PortalShell>,
    );
    const nav = screen.getByRole('navigation', { name: 'Menyu ya portal' });
    expect(within(nav).getByRole('link', { name: 'Salio' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Ankara' })).toHaveAttribute('href', '/invoices');
    expect(within(nav).getByRole('link', { name: 'Taarifa' })).toHaveAttribute('href', '/statement');
    expect(screen.getByRole('button', { name: 'Toka' })).toBeInTheDocument();
    expect(screen.getByText('Ruka hadi maudhui')).toBeInTheDocument();
  });

  it('renders the balance overview in sw from real read-model rows', async () => {
    const fetchImpl: FetchLike = async (input) => {
      const url = String(input);
      if (url.includes('/v1/receivables')) {
        return jsonResponse(200, {
          data: { receivables: [specReceivable] },
          meta: { pagination: { nextCursor: null, total: 1 } },
        });
      }
      return jsonResponse(200, {
        data: { payments: [] },
        meta: { pagination: { nextCursor: null, total: 0 } },
      });
    };
    const client: FuatiliaClient = createFuatiliaClient({
      baseUrl: 'http://portal.test',
      fetchImpl,
      logger: null,
      requestIdGenerator: () => 'test-req-1',
    });
    renderInSw(
      <QueryProviders>
        <BalanceOverview client={client} />
      </QueryProviders>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Salio lako' })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: 'Zilizobaki kulipwa' }),
      ).toHaveAttribute('data-state', 'loaded');
    });
    // Exact money is locale-independent; the caption is Kiswahili. (The
    // spec row is overdue, so the outstanding AND overdue cards both
    // render a total — scope to the outstanding card.)
    const outstanding = within(screen.getByRole('region', { name: 'Zilizobaki kulipwa' }));
    expect(outstanding.getByTestId('balance-card-total')).toHaveTextContent('KES 75,000.00');
    expect(outstanding.getByTestId('balance-card-total')).toHaveTextContent(
      'zilizobaki kulipwa kwenye ankara zilizo wazi',
    );
    // The zero-row payments source renders its honest Kiswahili source-empty.
    await waitFor(() => {
      expect(
        screen.getByRole('region', { name: 'Zilizoshikiliwa kwenye akaunti' }),
      ).toHaveAttribute('data-state', 'empty');
    });
    expect(
      within(screen.getByRole('region', { name: 'Zilizoshikiliwa kwenye akaunti' })).getByTestId(
        'empty-state',
      ),
    ).toHaveTextContent('Hakuna malipo yaliyorekodiwa bado');
  });

  it('stays English by default: no provider means en, never a crash or a blank', () => {
    render(<PortalGate />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Fuatilia payer portal' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Portal access code')).toBeInTheDocument();
  });
});
