import { NextResponse, type NextRequest } from 'next/server';
import { resolveDashboardGate } from '@/lib/auth/gate';

/**
 * (dashboard) middleware gate (issue #133).
 *
 * Dashboard routes are credential-gated at the edge: a request whose
 * `fuatilia_session` cookie is absent or not shaped like the contract's
 * opaque session UUID is redirected to /sign-in with a `next` hint (the
 * requested PATH only — never a credential). With a shape-valid cookie the
 * request proceeds; session LIVENESS (idle/absolute expiry, revocation) is
 * enforced by the API itself and 401 contract envelopes surface in-page.
 *
 * All gate logic lives in lib/auth/gate.ts (pure, fully tested there) —
 * this file is the thin Next.js adapter Next requires at src/middleware.ts.
 * Defense in depth: app/(dashboard)/layout.tsx independently renders the
 * designed refused screen (SignInRequired) when reached without a valid
 * session, so the refusal is a rendered state, not only a redirect.
 *
 * Placement note: this is the one file of the #133 lane outside
 * app/(auth)/** + lib/auth/** — Next.js only mounts middleware from
 * src/middleware.ts, and the issue's scope demands the middleware gate for
 * (dashboard) routes.
 */

export function middleware(request: NextRequest): NextResponse {
  const resolution = resolveDashboardGate(
    request.headers.get('cookie'),
    request.nextUrl.pathname,
  );
  if (resolution.tag === 'allow') {
    return NextResponse.next();
  }
  return NextResponse.redirect(new URL(resolution.location, request.nextUrl.origin));
}

export const config = {
  // The (dashboard) route group's paths — enumerated because route groups
  // carry no URL prefix. Everything else (the (auth) screens, the (portal)
  // surface with its own gate, the BFF routes, static assets) is ungated.
  matcher: [
    '/',
    '/collections/:path*',
    '/customers/:path*',
    '/payments/:path*',
    '/reconciliation/:path*',
    '/settings/:path*',
  ],
};
