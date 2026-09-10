import { describe, expect, it } from 'vitest';
import {
  PORTAL_VALIDATION_PATH,
  validatePortalAccess,
  type ValidatePortalAccessDeps,
} from '@/lib/portal/validate';
import { unauthorizedExample } from '@/lib/api/fixtures/errors';

// =============================================================================
// PORTAL ACCESS-CODE VALIDATION (issue #86): the pasted code is validated
// against the LIVE API before any cookie is set. The code travels in the
// Authorization header ONLY — never in a URL. Outcomes are tagged values.
// =============================================================================

const CODE = '8d9e0f1a-2b3c-4d5e-8f6a-7b8c9d0e1f2a';

function depsWith(
  response: Response | Error,
  captured: { url?: string; init?: RequestInit } = {},
  apiBase = 'http://api.test',
): ValidatePortalAccessDeps {
  return {
    apiBase,
    code: CODE,
    fetchImpl: async (input, init) => {
      if (response instanceof Error) throw response;
      captured.url = String(input);
      captured.init = init;
      return response;
    },
  };
}

describe('validatePortalAccess', () => {
  it('probes a real protected /v1 operation with the code as the Bearer credential', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const outcome = await validatePortalAccess(
      depsWith(new Response(JSON.stringify({ data: { receivables: [] } }), { status: 200 }), captured),
    );

    expect(outcome).toEqual({ tag: 'accepted' });
    expect(captured.url).toBe('http://api.test/v1/receivables?limit=1');
    expect(PORTAL_VALIDATION_PATH).toBe('/v1/receivables?limit=1');
    const headers = new Headers(captured.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${CODE}`);
  });

  it('never places the access code in a URL', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await validatePortalAccess(
      depsWith(new Response(null, { status: 200 }), captured),
    );
    expect(captured.url).toBeDefined();
    expect(captured.url).not.toContain(CODE);
  });

  it('refuses with the contract envelope on a 401 (unknown/expired credential)', async () => {
    const outcome = await validatePortalAccess(
      depsWith(new Response(JSON.stringify(unauthorizedExample), { status: 401 })),
    );
    expect(outcome).toEqual({
      tag: 'refused',
      status: 401,
      code: 'HTTP_UNAUTHENTICATED',
      message: unauthorizedExample.error.message,
      requestId: '9f2c1b3a-4d5e-4f60-8a71-2b3c4d5e6f70',
    });
  });

  it('refuses with the contract envelope on a 403 (authenticated, not authorized)', async () => {
    const outcome = await validatePortalAccess(
      depsWith(
        new Response(
          JSON.stringify({
            error: { code: 'AUTH_ACCESS_DENIED', message: 'deny by default' },
            requestId: 'rid-403',
          }),
          { status: 403 },
        ),
      ),
    );
    expect(outcome).toEqual({
      tag: 'refused',
      status: 403,
      code: 'AUTH_ACCESS_DENIED',
      message: 'deny by default',
      requestId: 'rid-403',
    });
  });

  it('refuses with null code/requestId when the error body is not a contract envelope', async () => {
    const outcome = await validatePortalAccess(
      depsWith(new Response('<html>gateway timeout</html>', { status: 504 })),
    );
    expect(outcome).toEqual({
      tag: 'refused',
      status: 504,
      code: null,
      message: null,
      requestId: null,
    });
  });

  it('returns an honest transport refusal when the API cannot be reached', async () => {
    const outcome = await validatePortalAccess(
      depsWith(new Error('fetch failed')),
    );
    expect(outcome.tag).toBe('transport');
    if (outcome.tag === 'transport') {
      expect(outcome.message).toContain('could not be reached');
    }
  });

  it('normalizes a trailing slash on the API base', async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    await validatePortalAccess(
      depsWith(new Response(null, { status: 200 }), captured, 'http://api.test/'),
    );
    expect(captured.url).toBe('http://api.test/v1/receivables?limit=1');
  });
});
