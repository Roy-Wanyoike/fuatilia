import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { SignInRequired } from '@/components/shell/sign-in-required';
import { looksLikeSessionToken, SESSION_COOKIE_NAME } from '@/lib/auth/session';

/**
 * Auth gate (server component). The dashboard renders only when the
 * httpOnly session cookie is present — the cookie contract that carries the
 * auth-lane session id (the Bearer credential per components
 * .securitySchemes.bearerSession). The cookie is invisible to client JS by
 * design; the BFF route handler (app/api/v1/[...path]) relays it as the
 * Authorization header server-side.
 *
 * STUB AT THE SEAM (disclosed in README + the sign-in screen): the /v1
 * contract mounts session REVOCATION but not session ISSUANCE, so this gate
 * enforces cookie presence + shape only; validating the session against the
 * auth lane becomes possible once the login operation lands.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
  const sessionPresent = looksLikeSessionToken(token);

  if (!sessionPresent) {
    return <SignInRequired />;
  }

  return <AppShell>{children}</AppShell>;
}
