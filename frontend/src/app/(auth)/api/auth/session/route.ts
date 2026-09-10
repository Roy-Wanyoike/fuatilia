import { handleSignInPost, handleSignOutDelete, type SessionRouteDeps } from '@/lib/auth/session-route';

/**
 * POST /api/auth/session — the collector sign-in endpoint (issue #133).
 * Validates the pasted session credential against the live API and, on
 * success, sets the httpOnly SameSite=Strict `fuatilia_session` cookie. On
 * refusal it relays the API's contract envelope (status, code, requestId).
 *
 * DELETE /api/auth/session — sign-out: expires the cookie server-side.
 *
 * The credential arrives in the JSON request BODY — never a query string —
 * and after validation lives only in the httpOnly cookie. It is relayed to
 * the API as `Authorization: Bearer <session>` exclusively server-side
 * (lib/server/forward.ts, app/api/v1/[...path]).
 */

export const dynamic = 'force-dynamic';

const deps: SessionRouteDeps = {
  apiBase: process.env.API_BASE_URL ?? '',
  secureCookie: process.env.NODE_ENV === 'production',
};

export function POST(request: Request): Promise<Response> {
  return handleSignInPost(request, deps);
}

export function DELETE(): Promise<Response> {
  return handleSignOutDelete(deps);
}
