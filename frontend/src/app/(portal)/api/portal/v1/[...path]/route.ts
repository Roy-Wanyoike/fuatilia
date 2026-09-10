import { contractInternalError, forwardPortalRequest } from '@/lib/portal/bff';

/**
 * The PORTAL same-origin BFF (issue #86): /api/portal/v1/* →
 * <API_BASE_URL>/v1/* with `Authorization: Bearer <portal access code>`
 * attached from the httpOnly SameSite=Strict `fuatilia_portal_session`
 * cookie. The bearer credential never reaches browser JS, never appears in
 * a URL, and is attached server-side on every relay (see lib/portal/bff.ts).
 */

export const dynamic = 'force-dynamic';

const apiBase = process.env.API_BASE_URL ?? '';

async function handle(request: Request): Promise<Response> {
  if (apiBase === '') {
    // Fail closed with the contract's generic 500 envelope; the real cause
    // (unset API_BASE_URL) is logged, never leaked to the wire.
    return contractInternalError(new Error('API_BASE_URL is not configured'));
  }
  try {
    return await forwardPortalRequest(request, { apiBase });
  } catch (error: unknown) {
    return contractInternalError(error);
  }
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
};
