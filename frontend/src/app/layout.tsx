import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProviders } from '@/providers/query-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fuatilia — AR & Collections',
  description:
    'FuatiliA: AR & collections platform for Kenya. Ledger-first fund truth over the /v1 contract.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans text-ink antialiased">
        <QueryProviders>{children}</QueryProviders>
      </body>
    </html>
  );
}
