import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import {
  looksLikePortalSessionToken,
  PORTAL_SESSION_COOKIE_NAME,
} from '@/lib/portal/session';
import { PortalGate } from './_components/portal-gate';
import { PortalShell } from './_components/portal-shell';

/**
 * Portal gate + shell (issue #86).
 *
 * Server-component gate: the payer portal renders only when the httpOnly
 * SameSite=Strict `fuatilia_portal_session` cookie is present with the
 * contract's opaque session-UUID shape — the cookie the gate set AFTER the
 * pasted access code was validated against the live API. Without it, the
 * payer sees the designed access-code gate, never the data.
 *
 * The cookie is invisible to client JS by design; the dedicated portal BFF
 * (app/(portal)/api/portal/v1/[...path]) relays it as the Bearer header
 * server-side. When the credential later fails upstream (expired/revoked
 * session, missing permission), every view renders the contract's 401/403
 * refusal as a clean refused state with code + requestId.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const token = cookieStore.get(PORTAL_SESSION_COOKIE_NAME)?.value ?? null;
  const sessionPresent = looksLikePortalSessionToken(token);

  if (!sessionPresent) {
    return <PortalGate />;
  }

  return <PortalShell>{children}</PortalShell>;
}

export const metadata: Metadata = {
  title: 'Fuatilia — Payer portal',
  description:
    'Tokenized self-service portal: balances, invoices and payment statements.',
  // A private, credential-gated surface — keep it out of search indexes.
  robots: { index: false, follow: false },
};
