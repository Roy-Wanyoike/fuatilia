import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import { Money } from '../../../domain/shared/money';
import type { Receivable, ReceivableState } from '../../../domain/receivables/receivable';
import { issueKey } from '../../../domain/auth/apikeys';
import { createHttpKernel } from '../server';
import { InMemoryAuthStore, seedWorld, type SeededWorld } from '../runtime/memory';
import { InMemoryResourceStore } from '../runtime/resources';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => uuid(`30000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);

// --- world seeding -----------------------------------------------------------------------

const seedKeyWithScopes = (authStore: InMemoryAuthStore, world: SeededWorld, scopes: readonly string[]): Uuid => {
  const issued = issueKey(
    [],
    {
      keyId: nextId(),
      orgId: world.orgId,
      name: `spec-key-${seq}`,
      createdBy: world.adminUserId,
      secret: 'fuatilia-spec-key-secret-001',
      scopes: [...scopes],
    },
    authStore.codec,
    clock,
  );
  authStore.saveKey(issued.key);
  authStore.record(issued.event);
  return issued.key.keyId;
};

const makeWorld = () => {
  const authStore = new InMemoryAuthStore();
  const world = seedWorld(authStore, clock);
  const resources = new InMemoryResourceStore();
  const kernel = createHttpKernel({ store: authStore, resourceStore: resources, clock });
  return { authStore, world, resources, kernel };
};

/** A receivable due `daysPastDue` days before the frozen clock instant. */
const receivableDue = (id: Uuid, daysPastDue: number, overrides: Partial<Receivable> = {}): Receivable => {
  const dueDate = new Date(Date.parse(T0) - daysPastDue * 86_400_000);
  return {
    id,
    invoiceId: nextId(),
    customerId: nextId(),
    currency: 'KES',
    original: Money.ofMinor(100_000, 'KES'),
    applied: Money.zero('KES'),
    state: 'open',
    overdue: daysPastDue > 0,
    openedAt: dueDate,
    dueDate,
    settledAt: null,
    voidedAt: null,
    writeOff: null,
    uncollectibleReason: null,
    uncollectibleAt: null,
    recoveredAt: null,
    ...overrides,
  };
};

const call = (
  kernel: ReturnType<typeof createHttpKernel>,
  method: string,
  path: string,
  opts: { auth?: string; query?: Record<string, string> } = {},
) =>
  kernel.handle({
    method,
    path,
    headers: opts.auth ? { authorization: opts.auth } : {},
    query: opts.query,
  });

// --- composition --------------------------------------------------------------------------

describe('route-table composition — /v1/receivables mounted on the kernel', () => {
  it('exposes both read-model rows with the receivables:read permission', () => {
    const { kernel } = makeWorld();
    const rows = kernel.routes.filter((r) => r.pattern.startsWith('/v1/receivables'));
    expect(rows.map((r) => `${r.method} ${r.pattern} → ${r.permission}`).sort()).toEqual([
      'GET /v1/receivables → receivables:read',
      'GET /v1/receivables/:receivableId → receivables:read',
    ]);
  });

  it('surfaces the receivables capability on GET /v1/meta', () => {
    const { kernel } = makeWorld();
    const res = call(kernel, 'GET', '/v1/meta', { auth: `Bearer ${makeWorld().world.sessionId}` });
    expect(res.status).toBe(200);
    const data = (res.body as { data: { capabilities: string[] } }).data;
    expect(data.capabilities).toContain('receivables');
  });

  it('defaults to a fresh empty resource store when none is injected', () => {
    const authStore = new InMemoryAuthStore();
    const world = seedWorld(authStore, clock);
    const kernel = createHttpKernel({ store: authStore, clock });
    expect(kernel.resources.receivables()).toEqual([]);
    const res = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}` });
    const data = (res.body as { data: { receivables: unknown[] }; meta: { pagination: { total: number } } }).data;
    expect(data.receivables).toEqual([]);
    expect((res.body as { meta: { pagination: { total: number } } }).meta.pagination.total).toBe(0);
  });
});

// --- the read model -------------------------------------------------------------------------

describe('GET /v1/receivables/:receivableId — the receivable read model', () => {
  it('projects the aggregate view with the lane’s own balance math (R1)', () => {
    const { kernel, world, resources } = makeWorld();
    const id = nextId();
    resources.saveReceivable(
      receivableDue(id, 10, {
        applied: Money.ofMinor(40_000, 'KES'),
        state: 'partially_paid',
      }),
    );
    const res = call(kernel, 'GET', `/v1/receivables/${id}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { receivable: { balance: { minor: number }; applied: { minor: number }; state: string } } }).data.receivable;
    expect(view.state).toBe('partially_paid');
    expect(view.applied.minor).toBe(40_000);
    expect(view.balance.minor).toBe(60_000); // original 100_000 − applied 40_000 — lane math, not handler math
  });

  it('carries the aging projection (days past due + bucket) from the lane', () => {
    const { kernel, world, resources } = makeWorld();
    const id = nextId();
    resources.saveReceivable(receivableDue(id, 45));
    const res = call(kernel, 'GET', `/v1/receivables/${id}`, { auth: `Bearer ${world.sessionId}` });
    const view = (res.body as { data: { receivable: { aging: { daysPastDue: number; bucket: string } } } }).data.receivable;
    expect(view.aging).toEqual({ daysPastDue: 45, bucket: '31-60' });
  });

  it('answers aging: null for a settled receivable — the lane refuses to age settled debt', () => {
    const { kernel, world, resources } = makeWorld();
    const id = nextId();
    resources.saveReceivable(
      receivableDue(id, 100, { state: 'settled', settledAt: new Date(T0), overdue: false, applied: Money.ofMinor(100_000, 'KES') }),
    );
    const res = call(kernel, 'GET', `/v1/receivables/${id}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { receivable: { aging: unknown; state: string } } }).data.receivable;
    expect(view.state).toBe('settled');
    expect(view.aging).toBeNull();
  });

  it('answers 404 HTTP_RECEIVABLE_NOT_FOUND for an unknown aggregate', () => {
    const { kernel, world } = makeWorld();
    const ghost = nextId();
    const res = call(kernel, 'GET', `/v1/receivables/${ghost}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(404);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('HTTP_RECEIVABLE_NOT_FOUND');
    expect(body.error.message).toContain(ghost);
  });
});

describe('GET /v1/receivables — the aging list', () => {
  it('lists every stored receivable with aging buckets and pagination meta', () => {
    const { kernel, world, resources } = makeWorld();
    resources.saveReceivable(receivableDue(nextId(), 5));
    resources.saveReceivable(receivableDue(nextId(), 75));
    const res = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(200);
    const body = res.body as { data: { receivables: { aging: { bucket: string } }[] }; meta: { pagination: { total: number; nextCursor: string | null } } };
    expect(body.data.receivables.map((r) => r.aging?.bucket)).toEqual(['0-30', '61-90']);
    expect(body.meta.pagination.total).toBe(2);
    expect(body.meta.pagination.nextCursor).toBeNull();
  });

  it('maps whole-day bucket boundaries deterministically (table)', () => {
    const { kernel, world, resources } = makeWorld();
    const buckets: readonly [number, string][] = [
      [0, '0-30'],
      [30, '0-30'],
      [31, '31-60'],
      [60, '31-60'],
      [61, '61-90'],
      [90, '61-90'],
      [91, '90+'],
    ];
    for (const [days] of buckets) resources.saveReceivable(receivableDue(nextId(), days));
    const res = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}`, query: { limit: '100' } });
    const views = (res.body as { data: { receivables: { aging: { bucket: string; daysPastDue: number } | null }[] } }).data.receivables;
    const actual = new Map(views.map((v) => [v.aging?.daysPastDue, v.aging?.bucket]));
    for (const [days, bucket] of buckets) expect(actual.get(days), `day ${days}`).toBe(bucket);
  });

  it('pages with the opaque cursor (limit + follow)', () => {
    const { kernel, world, resources } = makeWorld();
    for (let i = 0; i < 3; i += 1) resources.saveReceivable(receivableDue(nextId(), i));
    const page1 = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}`, query: { limit: '2' } });
    const body1 = page1.body as { data: { receivables: unknown[] }; meta: { pagination: { nextCursor: string; total: number } } };
    expect(body1.data.receivables).toHaveLength(2);
    expect(body1.meta.pagination.total).toBe(3);
    expect(body1.meta.pagination.nextCursor).toBe('2');

    const page2 = call(kernel, 'GET', '/v1/receivables', {
      auth: `Bearer ${world.sessionId}`,
      query: { limit: '2', cursor: body1.meta.pagination.nextCursor },
    });
    const body2 = page2.body as { data: { receivables: unknown[] }; meta: { pagination: { nextCursor: string | null; total: number } } };
    expect(body2.data.receivables).toHaveLength(1);
    expect(body2.meta.pagination.nextCursor).toBeNull();
  });

  it('sorts by whitelisted fields only (deny arbitrary sort strings)', () => {
    const { kernel, world, resources } = makeWorld();
    resources.saveReceivable(receivableDue(nextId(), 40, { state: 'partially_paid' }));
    resources.saveReceivable(receivableDue(nextId(), 3, { state: 'open' }));

    const bad = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}`, query: { sort: 'customerId' } });
    expect(bad.status).toBe(400);
    expect((bad.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');

    const good = call(kernel, 'GET', '/v1/receivables', {
      auth: `Bearer ${world.sessionId}`,
      query: { sort: 'state', order: 'asc' },
    });
    const states = (good.body as { data: { receivables: { state: string }[] } }).data.receivables.map((r) => r.state);
    expect(states).toEqual([...states].sort());
  });

  it('refuses out-of-range pagination with HTTP_QUERY_INVALID (strict boundaries, never clamped)', () => {
    const { kernel, world } = makeWorld();
    for (const limit of ['0', '101', 'abc']) {
      const res = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}`, query: { limit } });
      expect(res.status, `limit=${limit}`).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
    }
    for (const cursor of ['not-a-number', '-1']) {
      const res = call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}`, query: { cursor } });
      expect(res.status, `cursor=${cursor}`).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
    }
  });
});

// --- the permission boundary ------------------------------------------------------------------

describe('the permission boundary over /v1/receivables', () => {
  it('serves the seeded receivables:read API key end-to-end', () => {
    const { kernel, world, resources } = makeWorld();
    const id = nextId();
    resources.saveReceivable(receivableDue(id, 2));
    const res = call(kernel, 'GET', `/v1/receivables/${id}`, { auth: `ApiKey ${world.apiKeyId}.${world.apiKeySecret}` });
    expect(res.status).toBe(200);
    expect((res.body as { data: { receivable: { id: string } } }).data.receivable.id).toBe(id);
  });

  it('a principal without receivables:read is 403 AUTH_ACCESS_DENIED — and the denial is AUDITED', () => {
    const { kernel, authStore, world, resources } = makeWorld();
    resources.saveReceivable(receivableDue(nextId(), 2));
    const scopedKeyId = seedKeyWithScopes(authStore, world, ['payments:read']);

    const res = call(kernel, 'GET', '/v1/receivables', { auth: `ApiKey ${scopedKeyId}.fuatilia-spec-key-secret-001` });
    expect(res.status).toBe(403);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_ACCESS_DENIED');

    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect(denial).toBeDefined();
    expect((denial?.payload as { permission: string }).permission).toBe('receivables:read');
    expect((denial?.payload as { reason: string }).reason).toBe('NO_GRANT');
  });

  it('an unauthenticated request is 401 and audited (deny-by-default is a fact)', () => {
    const { kernel, authStore } = makeWorld();
    const res = call(kernel, 'GET', '/v1/receivables');
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_UNAUTHENTICATED');
    expect(authStore.events().some((event) => event.name === 'auth.accessDenied')).toBe(true);
  });

  it('the read model records no events — GETs are not facts', () => {
    const { kernel, world, resources } = makeWorld();
    resources.saveReceivable(receivableDue(nextId(), 2));
    call(kernel, 'GET', '/v1/receivables', { auth: `Bearer ${world.sessionId}` });
    expect(resources.events()).toEqual([]);
  });
});
