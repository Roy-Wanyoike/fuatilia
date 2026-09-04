import { createFuatiliaClient, type FuatiliaClient } from './client';

/**
 * Process-wide client for the app composition. The base URL resolution:
 *   1. NEXT_PUBLIC_API_BASE — direct browser → API calls (no credential
 *      attached; the API answers 401 envelopes until the session relay
 *      lands — see README "Auth at the seam").
 *   2. Same-origin `/api/v1` (default) — the BFF route handler attaches
 *      `Authorization: Bearer <session>` from the httpOnly cookie
 *      server-side, so the token never reaches browser JS.
 */
function resolveBaseUrl(): string {
  const direct = process.env.NEXT_PUBLIC_API_BASE;
  if (direct !== undefined && direct.length > 0) return direct;
  return '/api/v1';
}

export const defaultClient: FuatiliaClient = createFuatiliaClient({
  baseUrl: resolveBaseUrl(),
});
