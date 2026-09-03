/**
 * THE socket integration test of the transport lane (issue #55).
 *
 * Everything else in `src/adapters/http/**` is tested handler-level with
 * synthetic requests (deterministic, no sockets). This one spec spins the
 * real `node:http` server on an EPHEMERAL port (`listen(0)`) and drives
 * fetch end-to-end against the seeded auth world, proving the composition
 * root: node adaptation → kernel → auth middleware → route handlers.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../domain/shared';
import { createHttpKernel } from './server';
import { seedWorld, InMemoryAuthStore } from './runtime/memory';

const clock = systemClock;
const store = new InMemoryAuthStore();
const world = seedWorld(store, clock);
const kernel = createHttpKernel({ store, clock });

const listened = kernel.listen(0);
const closeLater = async (): Promise<void> => {
  const l = await listened;
  await l.close();
};
void closeLater;

const url = async (path: string): Promise<string> => {
  const l = await listened;
  return `${l.url}${path}`;
};

const bearer = (): string => `Bearer ${world.sessionId}`;
const apiKey = (): string => `ApiKey ${world.apiKeyId}.${world.apiKeySecret}`;

afterAll(async () => {
  await (await listened).close();
});

describe('POST-SOCKET integration — the /v1 surface end-to-end', () => {
  it('GET /v1/health is public and answers the success envelope', async () => {
    const res = await fetch(await url('/v1/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('ok');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('GET /v1/meta lists the mounted capabilities', async () => {
    const res = await fetch(await url('/v1/meta'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; apiVersion: string; capabilities: string[] } };
    expect(body.data.name).toBe('fuatilia');
    expect(body.data.apiVersion).toBe('v1');
    expect(body.data.capabilities).toContain('auth');
  });

  it('an unknown route is a 404 envelope with the transport code', async () => {
    const res = await fetch(await url('/v1/does-not-exist'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HTTP_ROUTE_NOT_FOUND');
  });

  it('a protected route without credentials is 401 and echoes the request id', async () => {
    const res = await fetch(await url('/v1/auth/users'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: world.orgId, email: 'x@y.test', username: 'x', displayName: 'X' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('HTTP_UNAUTHENTICATED');
    expect(body.requestId).toBeTruthy();
  });

  it('the seeded admin session creates a user; the scoped API key is correctly 403 (table)', async () => {
    const res = await fetch(await url('/v1/auth/users'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer() },
      body: JSON.stringify({
        orgId: world.orgId,
        email: 'created-1@fuatilia.test',
        username: 'created1',
        displayName: 'Created 1',
      }),
    });
    expect(res.status, 'Bearer session (admin:manage-users)').toBe(201);
    const body = (await res.json()) as { data: { user: { userId: string; email: string } } };
    expect(body.data.user.email).toBe('created-1@fuatilia.test');

    // The seed key holds ONLY receivables:read — the 403 wire path with the
    // audited AUTH_ACCESS_DENIED code, end-to-end (deny-by-default over /v1).
    const forbidden = await fetch(await url('/v1/auth/users'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey() },
      body: JSON.stringify({
        orgId: world.orgId,
        email: 'denied@fuatilia.test',
        username: 'denied1',
        displayName: 'Denied',
      }),
    });
    expect(forbidden.status, 'ApiKey (receivables:read only)').toBe(403);
    const denied = (await forbidden.json()) as { error: { code: string } };
    expect(denied.error.code).toBe('AUTH_ACCESS_DENIED');
  });

  it('a route-level validation refusal (bad scopes) is a 400 envelope over the wire', async () => {
    const res = await fetch(await url('/v1/auth/api-keys'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer() },
      body: JSON.stringify({ orgId: world.orgId, name: 'k', scopes: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HTTP_BODY_INVALID');
  });

  it('a malformed JSON body is a 400 envelope, never a crash', async () => {
    const res = await fetch(await url('/v1/auth/users'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: bearer() },
      body: '{"orgId": ',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('HTTP_BODY_MALFORMED');
  });

  it('request ids echo when the client supplies x-request-id (response header)', async () => {
    const res = await fetch(await url('/v1/health'), {
      headers: { 'x-request-id': 'integration-echo-42' },
    });
    expect(res.headers.get('x-request-id')).toBe('integration-echo-42');
  });
});
