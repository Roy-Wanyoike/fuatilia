import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PortalShell } from '@/app/(portal)/_components/portal-shell';
import { clearPortalLocaleCookie, parsePortalLocaleCookie, PORTAL_LOCALE_COOKIE } from '@/lib/portal-i18n/cookie';
import { PortalI18nProvider } from '@/lib/portal-i18n/context';

// =============================================================================
// LANGUAGE TOGGLE (issue #149): English ⇄ Kiswahili, persisted to the
// `fuatilia_portal_locale` cookie, with an instant client-side re-render.
// The cookie is a UI preference — no credentials, SameSite=Lax (cookie.ts).
// =============================================================================

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/',
}));

afterEach(() => {
  refresh.mockClear();
  clearPortalLocaleCookie();
});

function renderShell(initialLocale: 'en' | 'sw' = 'en'): void {
  render(
    <PortalI18nProvider initialLocale={initialLocale}>
      <PortalShell>
        <p>content</p>
      </PortalShell>
    </PortalI18nProvider>,
  );
}

describe('Portal LanguageToggle', () => {
  it('renders a labelled group with both language endonyms and the active state', () => {
    renderShell('en');
    const group = screen.getByRole('group', { name: 'Language' });
    expect(group).toBeInTheDocument();
    const english = screen.getByRole('button', { name: 'English' });
    const kiswahili = screen.getByRole('button', { name: 'Kiswahili' });
    expect(english).toHaveAttribute('aria-pressed', 'true');
    expect(kiswahili).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists Kiswahili to the cookie and re-renders the shell in sw', async () => {
    renderShell('en');
    expect(parsePortalLocaleCookie(document.cookie)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Kiswahili' }));

    // Cookie persisted (the toggle's own persistence contract).
    expect(parsePortalLocaleCookie(document.cookie)).toBe('sw');
    expect(document.cookie).toContain(`${PORTAL_LOCALE_COOKIE}=sw`);
    // Instant client-side re-render — no reload needed for the shell.
    expect(screen.getByRole('button', { name: 'Toka' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Menyu ya portal' })).toBeInTheDocument();
    // aria-pressed follows the new locale.
    expect(screen.getByRole('button', { name: 'Kiswahili' })).toHaveAttribute('aria-pressed', 'true');
    // Server components (metadata) are refreshed too.
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('switches back to English and persists the choice', async () => {
    renderShell('sw');
    expect(screen.getByRole('button', { name: 'Toka' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'English' }));

    expect(parsePortalLocaleCookie(document.cookie)).toBe('en');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Portal' })).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('is inert on the active language — no cookie churn, no refresh', async () => {
    renderShell('en');
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(parsePortalLocaleCookie(document.cookie)).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('carries the toggle inside the gate-less shell only as designed (portal lane)', () => {
    renderShell('en');
    expect(screen.getByTestId('portal-language-toggle')).toBeInTheDocument();
  });
});
