'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * TanStack Query is the ONLY server-state layer (no SWR duplication, per
 * the issue's payload-consciousness requirement). A fresh QueryClient per
 * browser render avoids cross-request leakage during SSR.
 */
export function QueryProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is money-truth: stale-while-revalidate on focus, but no
            // aggressive polling by default. Refusals are values — surface
            // them rather than retry-looping 4xx envelopes.
            retry: false,
            staleTime: 30_000,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
