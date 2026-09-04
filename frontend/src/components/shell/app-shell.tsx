'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { defaultClient } from '@/lib/api/browser-client';
import type { ApiResult, FuatiliaClient } from '@/lib/api/client';
import type { HealthData } from '@/lib/api/wire-types';

/**
 * Dashboard shell: landmark structure (banner / navigation / main), a
 * skip-to-content link, and the six primary sections from SPEC §45.
 *
 * Capability awareness: GET /v1/meta exposes the deployment's mounted
 * capabilities (["auth","collections","payments","receivables"] today).
 * Sections whose backend capability is not mounted yet are labeled
 * "planned" — the nav never pretends a surface exists when the contract
 * does not mount one. Permission vocabulary is displayed per item so
 * operators can see what a section requires; enforcement is server-side
 * (403 AUTH_ACCESS_DENIED envelopes surface in-page).
 */

export interface NavItem {
  href: string;
  label: string;
  description: string;
  /** The /v1 capability this section consumes (null = no capability yet). */
  capability: string | null;
  /** The permission vocabulary the section's calls require. */
  permission: string | null;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/',
    label: 'Overview',
    description: 'Headline money positions',
    capability: null,
    permission: 'receivables:read',
  },
  {
    href: '/collections',
    label: 'Collections',
    description: 'Command Center + cases',
    capability: 'collections',
    permission: 'collections:read',
  },
  {
    href: '/payments',
    label: 'Payments',
    description: 'Fund truth, Daraja intake',
    capability: 'payments',
    permission: 'payments:read',
  },
  {
    href: '/reconciliation',
    label: 'Reconciliation',
    description: 'Matching + unapplied cash',
    capability: null,
    permission: 'payments:read',
  },
  {
    href: '/customers',
    label: 'Customers',
    description: 'Customer 360',
    capability: null,
    permission: null,
  },
  {
    href: '/settings',
    label: 'Settings',
    description: 'Team, roles, API keys',
    capability: 'auth',
    permission: 'admin:manage-users',
  },
] as const;

export function AppShell({
  children,
  client = defaultClient,
}: {
  children: ReactNode;
  client?: FuatiliaClient;
}) {
  const pathname = usePathname();
  const metaQuery = useQuery({
    queryKey: ['api', 'meta'],
    queryFn: () => client.getMeta(),
    staleTime: 5 * 60_000,
  });
  const healthQuery = useQuery({
    queryKey: ['api', 'health'],
    queryFn: () => client.getHealth(),
    refetchInterval: 60_000,
  });

  // The mounted-capability set from GET /v1/meta. The "planned" label only
  // appears once meta has ANSWERED (never while pending, never when the
  // probe failed) — an unanswered probe must not claim a surface is planned.
  const metaAnswered = metaQuery.isSuccess;
  const capabilities =
    metaQuery.data?.ok === true ? new Set(metaQuery.data.data.capabilities) : null;

  return (
    <div className="min-h-screen bg-surface">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>

      <header className="border-b border-slate-200 bg-surface-raised">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <p className="text-sm font-semibold tracking-tight text-ink">
            Fuatilia
            <span className="ml-2 font-normal text-ink-faint">AR &amp; collections · Kenya</span>
          </p>
          <div className="flex items-center gap-2 text-xs text-ink-faint">
            <span aria-hidden="true">API</span>
            <HealthBadge healthQuery={healthQuery} />
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6">
        <nav
          aria-label="Primary"
          className="w-56 shrink-0 self-start rounded-lg border border-slate-200 bg-surface-raised p-3"
        >
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => {
              const capabilityMissing =
                metaAnswered &&
                item.capability !== null &&
                capabilities?.has(item.capability) !== true;
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex flex-col rounded-md px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                      active
                        ? 'bg-accent-soft font-semibold text-accent'
                        : 'text-ink-soft hover:bg-surface-sunk hover:text-ink'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      {item.label}
                      {capabilityMissing && <Badge tone="neutral">planned</Badge>}
                    </span>
                    <span className="text-xs font-normal text-ink-faint">
                      {item.description}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 border-t border-slate-100 pt-2 text-xs leading-relaxed text-ink-faint">
            Permissions are enforced by the API (deny-by-default). Refusals surface in-page with
            their contract code.
          </p>
        </nav>

        <main id="main-content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}

function HealthBadge({
  healthQuery,
}: {
  healthQuery: UseQueryResult<ApiResult<HealthData>>;
}) {
  const result = healthQuery.data;
  const state = (() => {
    if (healthQuery.isPending) return { tone: 'neutral' as const, label: 'checking…' };
    if (result?.ok === true) return { tone: 'success' as const, label: 'reachable' };
    return { tone: 'danger' as const, label: 'unreachable' };
  })();
  return (
    <Badge tone={state.tone}>
      <span className="sr-only">API health: </span>
      {state.label}
    </Badge>
  );
}
