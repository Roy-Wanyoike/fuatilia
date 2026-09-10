import { createFuatiliaClient, type FuatiliaClient } from '@/lib/api/client';

/**
 * The portal's typed /v1 client (issue #86).
 *
 * Unlike the dashboard client (lib/api/browser-client.ts), the portal has NO
 * direct-browser mode: it ALWAYS talks to the same-origin portal BFF
 * `/api/portal/v1`, which attaches `Authorization: Bearer <portal access
 * code>` from the httpOnly SameSite=Strict cookie server-side. Direct
 * browser→API calls would either carry no credential (every read 401s) or
 * require the token in browser JS — both unacceptable, so the choice is
 * structural, not a default.
 */
export function createPortalClient(baseUrl = '/api/portal/v1'): FuatiliaClient {
  return createFuatiliaClient({
    baseUrl,
  });
}

export const portalClient: FuatiliaClient = createPortalClient();
