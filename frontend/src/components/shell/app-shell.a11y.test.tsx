import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryProviders } from '@/providers/query-provider';
import { AppShell, NAV_ITEMS } from '@/components/shell/app-shell';
import { SignInRequired } from '@/components/shell/sign-in-required';
import { createFuatiliaClient, type FetchLike } from '@/lib/api/client';
import { healthExample, metaExample, unauthorizedExample } from '@/lib/api/fixtures/errors';

// =============================================================================
// APP SHELL A11Y — the dashboard chrome's accessibility contract, asserted so
// it cannot rot (issue #146):
//   1. landmark tree: banner / navigation("Primary") / main,
//   2. the skip link is the FIRST focusable element and targets main, which
//      itself is focusable (tabIndex -1) so the jump moves focus (WCAG 2.4.1),
//   3. every nav item has an accessible name + visible-focus style, and the
//      active page is announced with aria-current="page" (WCAG 2.4.8 / 4.1.2),
//   4. capability gaps surface as real "planned" text in the nav (never
//      color-only state, WCAG 1.4.1),
//   5. the API-health status is announced by text, not color alone
//      (sr-only "API health:" prefix, WCAG 1.4.1).
// No axe dependency: assertions are behavioral against the rendered DOM.
// =============================================================================

const { pathnameRef } = vi.hoisted(() => ({ pathnameRef: { current: '/' } }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameRef.current,
}));

const neverFetch: FetchLike = () => new Promise<Response>(() => undefined);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'a11y-rid' },
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

function renderShell(fetchImpl: FetchLike = neverFetch): ReturnType<typeof render> {
  const client = createFuatiliaClient({
    baseUrl: 'http://shell.a11y.test',
    fetchImpl,
    logger: null,
    requestIdGenerator: () => 'shell-req-1',
  });
  return render(
    <QueryProviders>
      <AppShell client={client}>
        <p>page body</p>
      </AppShell>
    </QueryProviders>,
  );
}

describe('AppShell a11y', () => {
  beforeEach(() => {
    pathnameRef.current = '/';
  });

  it('exposes the landmark tree with the skip link as the first focusable element', () => {
    const { container } = renderShell();

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    // The skip-link target must be focusable for the jump to move focus.
    expect(main).toHaveAttribute('tabindex', '-1');

    const skipLink = screen.getByRole('link', { name: 'Skip to content' });
    expect(skipLink).toHaveAttribute('href', '#main-content');

    // DOM order == focus order here: nothing may precede the skip link.
    const focusables = container.querySelectorAll('a[href], button:not([disabled])');
    expect(focusables.length).toBeGreaterThan(0);
    expect(focusables[0]).toBe(skipLink);

    // API health is text, never color-only (sr-only prefix inside the badge).
    expect(screen.getByText('API health:')).toBeInTheDocument();
  });

  it('names every primary-nav item, shows focus styles, and marks the active page', () => {
    pathnameRef.current = '/collections';
    renderShell();

    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    const links = nav.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toHaveLength(NAV_ITEMS.length);

    for (const item of NAV_ITEMS) {
      const link = nav.getByRole('link', { name: new RegExp(item.label) });
      // No nameless/icon-only navigation (WCAG 4.1.2) + visible focus (2.4.7).
      expect(link).toHaveAccessibleName();
      expect(link.className).toContain('focus-visible:outline');
      if (item.href === '/collections') {
        expect(link).toHaveAttribute('aria-current', 'page');
      } else {
        expect(link).not.toHaveAttribute('aria-current');
      }
    }
  });

  it('announces unmounted capabilities as "planned" text in the nav', async () => {
    const metaWithoutAuth = {
      data: {
        ...metaExample.data,
        capabilities: metaExample.data.capabilities.filter((capability) => capability !== 'auth'),
      },
    };
    renderShell(
      routeFetch({
        '/v1/meta': { status: 200, body: metaWithoutAuth },
        '/v1/health': { status: 200, body: healthExample },
      }),
    );

    // Settings consumes the auth capability → its nav item says "planned".
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    await nav.findByText('planned');
    // Exactly one unmounted capability among the six sections.
    expect(nav.getAllByText('planned')).toHaveLength(1);

    // Health answered → the badge text is state language, not a color swatch.
    expect(await screen.findByText('reachable')).toBeInTheDocument();
  });

  it('keeps the sign-in gate a labelled main landmark with an h1', () => {
    render(<SignInRequired />);

    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to Fuatilia' })).toBeInTheDocument();
  });

  it('never claims "planned" from an unanswered probe and states health in text', async () => {
    renderShell(
      routeFetch({
        '/v1/meta': { status: 401, body: unauthorizedExample },
        '/v1/health': { status: 401, body: unauthorizedExample },
      }),
    );

    // A refused probe is NOT an answer: the nav must not label sections
    // "planned" (the shell distinguishes unanswered from missing capability).
    const nav = within(screen.getByRole('navigation', { name: 'Primary' }));
    expect(nav.queryAllByText('planned')).toHaveLength(0);

    // Both probes refused → the health badge says so in words (1.4.1),
    // never as a color-only dot.
    expect(await screen.findByText('unreachable')).toBeInTheDocument();
  });
});
