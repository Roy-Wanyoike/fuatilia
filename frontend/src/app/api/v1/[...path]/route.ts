import { forwardAuthenticated, contractInternalError } from '@/lib/server/forward';

/**
 * Same-origin BFF: /api/v1/* → <API_BASE_URL>/v1/* with
 * `Authorization: Bearer <session>` attached from the httpOnly
 * `fuatilia_session` cookie. The bearer credential never reaches browser
 * JS (see README "Auth at the seam").
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
    return await forwardAuthenticated(request, { apiBase });
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
