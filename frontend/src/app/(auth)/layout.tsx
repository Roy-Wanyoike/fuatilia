import type { Metadata } from 'next';

/**
 * (auth) route group — the credential surfaces (sign-in, sign-out) plus the
 * same-origin session BFF route (api/auth/session). Private screens: kept
 * out of search indexes; the dashboard-facing gate lives in
 * src/middleware.ts + app/(dashboard)/layout.tsx (issue #133).
 */
export const metadata: Metadata = {
  title: 'Fuatilia — Sign in',
  description: 'Collector sign-in for the Fuatilia collections console.',
  robots: { index: false, follow: false },
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children;
}
