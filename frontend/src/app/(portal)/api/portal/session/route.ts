import { handleSessionDelete, handleSessionPost, type SessionRouteDeps } from '@/lib/portal/session-route';

/**
 * POST /api/portal/session — the portal gate endpoint (issue #86).
 * Validates the pasted access code against the live API and, on success,
 * sets the httpOnly SameSite=Strict `fuatilia_portal_session` cookie. On
 * refusal it relays the API's contract envelope (status, code, requestId).
 *
 * DELETE /api/portal/session — sign-out: expires the cookie server-side.
 *
 * The credential arrives in the JSON request BODY — never a query string —
 * and after validation lives only in the httpOnly cookie.
 */

export const dynamic = 'force-dynamic';

const deps: SessionRouteDeps = {
  apiBase: process.env.API_BASE_URL ?? '',
  secureCookie: process.env.NODE_ENV === 'production',
};

export function POST(request: Request): Promise<Response> {
  return handleSessionPost(request, deps);
}

export function DELETE(): Promise<Response> {
  return handleSessionDelete(deps);
}
