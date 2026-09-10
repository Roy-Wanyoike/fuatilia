'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

/**
 * Portal shell for the authenticated payer (issue #86): landmark structure,
 * a compact mobile-first nav (Balance / Invoices / Statement) and sign-out.
 * The credential lives in the httpOnly cookie only — sign-out simply asks
 * the same-origin session route to expire it, server-side.
 */

const PORTAL_NAV = [
  { href: '/', label: 'Balance' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/statement', label: 'Statement' },
] as const;

export function PortalShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await fetch('/api/portal/session', { method: 'DELETE' });
    } catch {
      // Best-effort: the route expires the cookie; a network failure here
      // still lands the payer back on the gate, which re-validates.
    }
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-surface">
      <a
        href="#portal-main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      <header className="border-b border-slate-200 bg-surface-raised">
        <div className="mx-auto flex max-w-3xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm font-semibold tracking-tight text-ink">
            Fuatilia
            <span className="ml-2 font-normal text-ink-soft">payer portal</span>
          </p>
          <button
            type="button"
            className="w-fit rounded-md border border-slate-300 bg-surface-raised px-3 py-1.5 text-xs font-medium text-ink hover:bg-surface-sunk focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              void signOut();
            }}
            disabled={signingOut}
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
        <nav aria-label="Portal" className="mx-auto max-w-3xl px-4 pb-2">
          <ul className="flex gap-1 overflow-x-auto">
            {PORTAL_NAV.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`inline-flex whitespace-nowrap rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      active
                        ? 'bg-accent-soft font-semibold text-accent'
                        : 'text-ink-soft hover:bg-surface-sunk hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main id="portal-main-content" className="mx-auto max-w-3xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}
