import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignInRequired } from '@/components/shell/sign-in-required';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

// =============================================================================
// REFUSED DASHBOARD (issue #133, AC2): "(dashboard) routes render refused
// state without a valid session". The (dashboard) layout renders
// SignInRequired whenever a request reaches it without a session cookie —
// defense in depth behind the middleware gate (lib/auth/gate.ts +
// src/middleware.ts), which redirects unauthenticated dashboard routes to
// /sign-in first. This pins the rendered refusal itself: it explains the
// credential seam and renders NO dashboard data.
// =============================================================================

describe('the (dashboard) refused state (SignInRequired)', () => {
  it('renders the designed sign-in screen when no valid session is present', () => {
    render(<SignInRequired />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Sign in to Fuatilia' }),
    ).toBeInTheDocument();
    // The credential mechanism is disclosed, not hidden.
    expect(screen.getByText(SESSION_COOKIE_NAME)).toBeInTheDocument();
    expect(screen.getByText(/HTTP-only session cookie/)).toBeInTheDocument();
  });

  it('discloses the issuance seam honestly (revocation mounted, issuance not) without fabricating a login', () => {
    render(<SignInRequired />);

    expect(screen.getByText(/Seam status:/)).toBeInTheDocument();
    expect(
      screen.getByText(/session revocation but not session issuance/i),
    ).toBeInTheDocument();
  });

  it('renders no dashboard data — no tables, no regions, no metrics', () => {
    render(<SignInRequired />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByText(/KES/)).not.toBeInTheDocument();
  });
});
