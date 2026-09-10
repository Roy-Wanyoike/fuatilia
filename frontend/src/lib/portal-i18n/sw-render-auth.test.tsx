import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignInForm } from '@/app/(auth)/_components/sign-in-form';
import { QueryProviders } from '@/providers/query-provider';
import { PortalI18nProvider } from '@/lib/portal-i18n/context';

// =============================================================================
// SW RENDERING — auth (issue #180): the credential surfaces genuinely SPEAK
// Kiswahili once the provider carries a sw locale (the same provider + cookie
// the #149 portal uses). The sign-in form's own unit tests render it without
// a provider and pin the en fallback; this file pins the sw one.
// =============================================================================

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => '/',
}));

function renderInSw(ui: React.ReactElement): void {
  render(
    <QueryProviders>
      <PortalI18nProvider initialLocale="sw">{ui}</PortalI18nProvider>
    </QueryProviders>,
  );
}

describe('auth rendering in Kiswahili (#180)', () => {
  it('renders the sign-in gate in sw: heading, labelled input and submit', () => {
    renderInSw(<SignInForm />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Ingia kwenye Fuatilia' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Kitambulisho cha kipindi')).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: 'Fungua koni' })).toBeEnabled();
    // The credential disclosure survives translation (word order shifts).
    expect(screen.getByText(/HTTP-only, SameSite=Strict/)).toBeInTheDocument();
    expect(screen.getByText(/Hakiwekwi kwenye URL/)).toBeInTheDocument();
  });
});
