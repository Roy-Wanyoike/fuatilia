import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import { Money } from '../../../domain/shared/money';
import { grantRole } from '../../../domain/auth/assignments';
import { ADMIN_MANAGE_USERS, defineRole, expandRolePermissions } from '../../../domain/auth/roles';
import type { Receivable } from '../../../domain/receivables/receivable';
import { createHttpKernel } from '../server';
import { InMemoryAuthStore, seedWorld, type SeededWorld } from '../runtime/memory';
import { InMemoryResourceStore } from '../runtime/resources';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => uuid(`50000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);

// --- world seeding -----------------------------------------------------------------------

const grantPermissions = (
  authStore: InMemoryAuthStore,
  world: SeededWorld,
  permissions: readonly string[],
  roleName: string,
): void => {
  const { role } = defineRole(
    authStore.roles(),
    { roleId: nextId(), orgId: world.orgId, name: roleName, permissions: [...permissions] },
    clock,
  );
  authStore.saveRole(role);
  const granted = grantRole(
    authStore.grants(),
    {
      grantId: nextId(),
      orgId: world.orgId,
      userId: world.adminUserId,
      role,
      grantedBy: world.adminUserId,
      // Spec seeding: role's own expansion + the role-administration permission
      // the escalation guard demands (the seedWorld shortcut).
      granterPermissions: [...new Set([...expandRolePermissions(role), ADMIN_MANAGE_USERS])],
    },
    clock,
  );
  if (!granted.granted) throw new Error('seed grant must succeed');
  authStore.saveGrant(granted.grant);
};

/**
 * Module-level mirror of the current world's resource store — `makeWorld`
 * assigns it before every test body runs (in-file tests execute sequentially,
 * so tests may reference `resources` directly).
 */
let resources: InMemoryResourceStore;

const makeWorld = (options: { readonly permissions?: readonly string[] } = {}) => {
  const authStore = new InMemoryAuthStore();
  const world = seedWorld(authStore, clock);
  if (options.permissions) grantPermissions(authStore, world, options.permissions, `Role-${++seq}`);
  const store = new InMemoryResourceStore();
  resources = store;
  const kernel = createHttpKernel({ store: authStore, resourceStore: store, clock });
  return { authStore, world, resources: store, kernel };
};

/** A second org in the SAME stores — ids namespaced away from the first world's. */
const seedSecondOrg = (authStore: InMemoryAuthStore): SeededWorld =>
  seedWorld(authStore, clock, (n) => uuid(`5fffffff-0000-4000-8000-${String(n).padStart(12, '0')}`));

const receivable = (id: Uuid): Receivable => ({
  id,
  invoiceId: nextId(),
  customerId: nextId(),
  currency: 'KES',
  original: Money.ofMinor(120_000, 'KES'),
  applied: Money.zero('KES'),
  state: 'open',
  overdue: false,
  openedAt: new Date(T0),
  dueDate: new Date(Date.parse(T0) - 10 * 86_400_000),
  settledAt: null,
  voidedAt: null,
  writeOff: null,
  uncollectibleReason: null,
  uncollectibleAt: null,
  recoveredAt: null,
});

const call = (
  kernel: ReturnType<typeof createHttpKernel>,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string; query?: Record<string, string> } = {},
) =>
  kernel.handle({
    method,
    path,
    headers: opts.auth ? { authorization: opts.auth } : {},
    rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    query: opts.query,
  });

const openBody = (overrides: Record<string, unknown> = {}) => ({
  receivableIds: [nextId()],
  collectorId: nextId(),
  ...overrides,
});

/** Save a fresh open KES receivable into the current world's store; return its id. */
const seedReceivable = (): Uuid => {
  const id = nextId();
  resources.saveReceivable(receivable(id));
  return id;
};

const openCaseOverTheWire = (
  kernel: ReturnType<typeof createHttpKernel>,
  world: SeededWorld,
  overrides: Record<string, unknown> = {},
): { status: number; caseId?: string; caseNumber?: string } => {
  // Default bodies reference a REAL, freshly-seeded receivable — open requests
  // over unknown receivables are 404s (covered by dedicated tests using raw
  // `call` bodies).
  const receivableIds = (overrides.receivableIds as readonly Uuid[] | undefined) ?? [seedReceivable()];
  const res = call(kernel, 'POST', '/v1/collections/cases', {
    auth: `Bearer ${world.sessionId}`,
    body: openBody({ ...overrides, receivableIds }),
  });
  const data = res.body as { data?: { case: { id: string; caseNumber: string } } };
  return { status: res.status, caseId: data.data?.case.id, caseNumber: data.data?.case.caseNumber };
};

const eventNames = (resources: InMemoryResourceStore): string[] => resources.events().map((e) => e.name);

// --- composition --------------------------------------------------------------------------

describe('route-table composition — /v1/collections mounted on the kernel', () => {
  it('exposes the open/act/read rows with their concrete vocabulary permissions', () => {
    const { kernel } = makeWorld();
    const rows = kernel.routes
      .filter((r) => r.pattern.startsWith('/v1/collections'))
      .map((r) => `${r.method} ${r.pattern} → ${r.permission}`)
      .sort();
    expect(rows).toEqual([
      'GET /v1/collections/cases → collections:read',
      'GET /v1/collections/cases/:caseId → collections:read',
      'POST /v1/collections/cases → collections:act',
      'POST /v1/collections/cases/:caseId/actions → collections:act',
      'POST /v1/collections/cases/:caseId/actions/:actionId/completions → collections:act',
      'POST /v1/collections/cases/:caseId/escalations → collections:act',
      'POST /v1/collections/cases/:caseId/transitions → collections:act',
    ]);
  });

  it('surfaces the collections capability on GET /v1/meta', () => {
    const { kernel, world } = makeWorld();
    const res = call(kernel, 'GET', '/v1/meta', { auth: `Bearer ${world.sessionId}` });
    expect((res.body as { data: { capabilities: string[] } }).data.capabilities).toContain('collections');
  });
});

// --- open (collections:act) -----------------------------------------------------------------

describe('POST /v1/collections/cases — opening with the R8 exclusivity guard', () => {
  it('opens a case → 201, per-org sequence + caseNumber, case.opened recorded', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    const receivableId = nextId();
    resources.saveReceivable(receivable(receivableId));

    const res = call(kernel, 'POST', '/v1/collections/cases', {
      auth: `Bearer ${world.sessionId}`,
      body: openBody({ receivableIds: [receivableId], priority: 'high' }),
    });
    expect(res.status).toBe(201);
    const view = (res.body as { data: { case: Record<string, unknown> } }).data.case;
    expect(view.caseNumber).toBe('CASE-000001');
    expect(view.sequence).toBe(1);
    expect(view.status).toBe('open');
    expect(view.priority).toBe('high');
    expect(view.openedBy).toBe(world.adminUserId);
    expect(view.receivableIds).toEqual([receivableId]);
    expect(eventNames(resources)).toEqual(['case.opened']);
  });

  it('hands out the next per-org sequence number on every open (CASE-000002…)', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    const firstReceivable = nextId();
    const secondReceivable = nextId();
    resources.saveReceivable(receivable(firstReceivable));
    resources.saveReceivable(receivable(secondReceivable));
    const first = openCaseOverTheWire(kernel, world, { receivableIds: [firstReceivable] });
    const second = openCaseOverTheWire(kernel, world, { receivableIds: [secondReceivable] });
    expect(first.caseNumber).toBe('CASE-000001');
    expect(second.caseNumber).toBe('CASE-000002');
  });

  it('R8: a second open case over a covered receivable → 409 CASE_ALREADY_OPEN', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    const receivableId = nextId();
    resources.saveReceivable(receivable(receivableId));
    const first = openCaseOverTheWire(kernel, world, { receivableIds: [receivableId] });
    expect(first.status).toBe(201);

    const res = call(kernel, 'POST', '/v1/collections/cases', {
      auth: `Bearer ${world.sessionId}`,
      body: openBody({ receivableIds: [receivableId] }),
    });
    expect(res.status).toBe(409);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CASE_ALREADY_OPEN');
    expect(body.error.message).toContain(receivableId);
    expect(resources.cases()).toHaveLength(1); // the refused case never existed
  });

  it('R8 releases receivables on closure — a NEW case may then cover them', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    const receivableId = nextId();
    resources.saveReceivable(receivable(receivableId));
    const first = openCaseOverTheWire(kernel, world, { receivableIds: [receivableId] });
    if (!first.caseId) throw new Error('seed case missing');

    call(kernel, 'POST', `/v1/collections/cases/${first.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'in_progress', reason: 'agent engaged' },
    });
    call(kernel, 'POST', `/v1/collections/cases/${first.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'closed_inactive', reason: 'parked without an outcome' },
    });

    const fresh = openCaseOverTheWire(kernel, world, { receivableIds: [receivableId] });
    expect(fresh.status).toBe(201);
    expect(fresh.caseNumber).toBe('CASE-000002'); // the released receivable, a new sequence slot
  });

  it('references must resolve → 404 HTTP_RECEIVABLE_NOT_FOUND for an unknown receivable', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    const ghost = nextId();
    const res = call(kernel, 'POST', '/v1/collections/cases', {
      auth: `Bearer ${world.sessionId}`,
      body: openBody({ receivableIds: [ghost] }),
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_RECEIVABLE_NOT_FOUND');
    expect(resources_cases(resources)).toBe(0);
  });

  it('rejects malformed bodies with 400 HTTP_BODY_INVALID (table)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    const cases: readonly { readonly name: string; readonly body: unknown }[] = [
      { name: 'receivableIds missing', body: { collectorId: nextId() } },
      { name: 'receivableIds empty', body: openBody({ receivableIds: [] }) },
      { name: 'receivableIds not UUIDs', body: openBody({ receivableIds: ['rec-1'] }) },
      { name: 'receivableIds duplicated', body: openBody({ receivableIds: [nextId(), nextId()] }).receivableIds && { collectorId: nextId(), receivableIds: (() => { const id = nextId(); return [id, id]; })() } },
      { name: 'collectorId missing', body: { receivableIds: [nextId()] } },
      { name: 'collectorId not a UUID', body: openBody({ collectorId: 'team-nairobi' }) },
      { name: 'unknown priority', body: openBody({ priority: 'yesterday', receivableIds: [seedReceivable()] }) },
    ];
    for (const c of cases) {
      const res = call(kernel, 'POST', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}`, body: c.body });
      expect(res.status, c.name).toBe(400);
      expect((res.body as { error: { code: string } }).error.code, c.name).toBe('HTTP_BODY_INVALID');
    }
    expect(resources.cases()).toHaveLength(0);
    expect(eventNames(resources)).toEqual([]);
  });
});

// --- read (collections:read) ------------------------------------------------------------------

describe('GET /v1/collections/cases/:caseId and GET /v1/collections/cases — the case read model', () => {
  it('serves the case view with the lane’s derived-status overlay', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act', 'collections:read'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'GET', `/v1/collections/cases/${opened.caseId}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { case: Record<string, unknown> } }).data.case;
    expect(view.status).toBe('open');
    expect(view.derivedStatus).toBe('waiting'); // live with nothing holding — the lane's derivation
    expect(view.actions).toEqual([]);
    expect(view.history).toEqual([]);
  });

  it('an unknown case → 404 HTTP_CASE_NOT_FOUND', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:read'] });
    const res = call(kernel, 'GET', `/v1/collections/cases/${nextId()}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_CASE_NOT_FOUND');
  });

  it('a FOREIGN-ORG case answers 404 — existence is never leaked across orgs', () => {
    const { kernel, authStore, world, resources } = makeWorld({ permissions: ['collections:act', 'collections:read'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const other = seedSecondOrg(authStore);
    // The foreign principal must CLEAR authorization (org scoping is asserted,
    // not the permission gate) — grant the read permission to org 2's admin.
    grantPermissions(authStore, other, ['collections:read'], 'Reader-Org2');
    const foreign = call(kernel, 'GET', `/v1/collections/cases/${opened.caseId}`, { auth: `Bearer ${other.sessionId}` });
    expect(foreign.status).toBe(404);
    expect((foreign.body as { error: { code: string } }).error.code).toBe('HTTP_CASE_NOT_FOUND');

    const list = call(kernel, 'GET', '/v1/collections/cases', { auth: `Bearer ${other.sessionId}` });
    expect((list.body as { data: { cases: unknown[] } }).data.cases).toEqual([]);
    const own = call(kernel, 'GET', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}` });
    expect((own.body as { data: { cases: unknown[] } }).data.cases).toHaveLength(1);
  });

  it('lists org cases with pagination meta', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act', 'collections:read'] });
    resources.saveReceivable(receivable(nextId()));
    resources.saveReceivable(receivable(nextId()));
    openCaseOverTheWire(kernel, world);
    openCaseOverTheWire(kernel, world);

    const page1 = call(kernel, 'GET', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}`, query: { limit: '1' } });
    const body1 = page1.body as { data: { cases: { caseNumber: string }[] }; meta: { pagination: { nextCursor: string; total: number } } };
    expect(body1.data.cases).toHaveLength(1);
    expect(body1.meta.pagination.total).toBe(2);
    expect(body1.meta.pagination.nextCursor).toBe('1');

    const page2 = call(kernel, 'GET', '/v1/collections/cases', {
      auth: `Bearer ${world.sessionId}`,
      query: { limit: '1', cursor: body1.meta.pagination.nextCursor },
    });
    const body2 = page2.body as { data: { cases: { caseNumber: string }[] }; meta: { pagination: { nextCursor: string | null } } };
    expect(body2.data.cases).toHaveLength(1);
    expect(body2.meta.pagination.nextCursor).toBeNull();
    expect(
      [body1.data.cases[0]?.caseNumber, body2.data.cases[0]?.caseNumber].sort(),
    ).toEqual(['CASE-000001', 'CASE-000002']);
  });

  it('refuses a garbage cursor → 400 HTTP_QUERY_INVALID', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:read'] });
    const res = call(kernel, 'GET', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}`, query: { cursor: '!!' } });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
  });
});

// --- act: transitions + escalations -------------------------------------------------------------

describe('POST /v1/collections/cases/:caseId/transitions — the stored lifecycle', () => {
  it('engages (open → in_progress): history row appended, NO lane event (engagement is not a fact)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'in_progress', reason: 'agent engaged' },
    });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { case: Record<string, unknown> } }).data.case;
    expect(view.status).toBe('in_progress');
    expect(view.history).toHaveLength(1);
    expect(eventNames(resources)).toEqual(['case.opened']); // no case.statusChanged exists (issue-#8 catalog)
  });

  it('resolves → case.resolved recorded; closes inactive → case.closed with releasedReceivableIds', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    const receivableId = nextId();
    resources.saveReceivable(receivable(receivableId));
    const opened = openCaseOverTheWire(kernel, world, { receivableIds: [receivableId] });
    if (!opened.caseId) throw new Error('seed case missing');

    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'in_progress', reason: 'engaged' } });
    const resolved = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'resolved', reason: 'debtor settled in full' } });
    expect(resolved.status).toBe(200);
    expect((resolved.body as { data: { case: { status: string; closedBy: string } } }).data.case.status).toBe('resolved');

    const closed = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'closed_inactive', reason: 'duplicate closure' },
    });
    expect(closed.status).toBe(400); // resolved is terminal — CASE_TRANSITION_INVALID
    expect((closed.body as { error: { code: string } }).error.code).toBe('CASE_TRANSITION_INVALID');
    expect(eventNames(resources)).toEqual(['case.opened', 'case.resolved']);
  });

  it('closing an in_progress case emits case.closed releasing its receivables (R8)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    const receivableId = nextId();
    resources.saveReceivable(receivable(receivableId));
    const opened = openCaseOverTheWire(kernel, world, { receivableIds: [receivableId] });
    if (!opened.caseId) throw new Error('seed case missing');

    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'in_progress', reason: 'engaged' } });
    const closed = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'closed_inactive', reason: 'parked without an outcome' },
    });
    expect(closed.status).toBe(200);
    const view = (closed.body as { data: { case: { status: string; closedAt: string | null; closedBy: string | null } } }).data.case;
    expect(view.status).toBe('closed_inactive');
    expect(view.closedAt).toBe(T0);
    expect(view.closedBy).toBe(world.adminUserId);

    const closedEvent = resources.events().find((e) => e.name === 'case.closed');
    expect(closedEvent).toBeDefined();
    expect((closedEvent?.payload as { releasedReceivableIds: string[] }).releasedReceivableIds).toEqual([receivableId]);
  });

  it('skipping engagement (open → resolved) is refused → 400 CASE_TRANSITION_INVALID', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'resolved', reason: 'no engagement happened' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_TRANSITION_INVALID');
    expect(resources.cases()[0]?.status).toBe('open');
  });
});

describe('POST /v1/collections/cases/:caseId/escalations — the priority ladder', () => {
  it('raises the priority with a reason → case.escalated + priorityChanges row', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/escalations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'high', reason: 'promise broken twice' },
    });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { case: { priority: string; priorityChanges: Record<string, unknown>[] } } }).data.case;
    expect(view.priority).toBe('high');
    expect(view.priorityChanges).toHaveLength(1);
    expect(view.priorityChanges[0]).toMatchObject({ from: 'normal', to: 'high' });
    expect(eventNames(resources)).toEqual(['case.opened', 'case.escalated']);
  });

  it('escalation must strictly raise → 400 CASE_ESCALATION_INVALID (never sidesteps or downgrades)', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/escalations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'normal', reason: 'same rung' },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_ESCALATION_INVALID');
  });

  it('a terminal case has nothing to escalate → 409 CASE_CLOSED', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');
    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'in_progress', reason: 'engaged' } });
    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'resolved', reason: 'settled' } });

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/escalations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { to: 'urgent', reason: 'too late' },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_CLOSED');
  });
});

// --- act: the append-only dunning log + the K2 consent gate --------------------------------------

describe('POST /v1/collections/cases/:caseId/actions — the dunning activity log', () => {
  it('records a call → 201, case.actionRecorded, entry appended (backfillable with an outcome)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'call', scheduledFor: T0, outcome: 'no answer — retry Thursday' },
    });
    expect(res.status).toBe(201);
    const data = (res.body as { data: { action: Record<string, unknown>; case: { actions: unknown[] } } }).data;
    expect(data.action.type).toBe('call');
    expect(data.action.outcome).toBe('no answer — retry Thursday');
    expect(data.action.completedAt).toBe(T0); // backfilled completed
    expect(data.action.actorId).toBe(world.adminUserId);
    expect(data.case.actions).toHaveLength(1);
    expect(eventNames(resources)).toEqual(['case.opened', 'case.actionRecorded']);
  });

  it('K2: an automated whatsapp send WITHOUT a consentRef → 403 DUNNING_CONSENT_REQUIRED, blocked attempt AUDITED, nothing appended', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'whatsapp', scheduledFor: T0 },
    });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('DUNNING_CONSENT_REQUIRED');
    // The K2 refusal is a FACT: the compliance event is recorded even though the action is not.
    expect(eventNames(resources)).toEqual(['case.opened', 'collections.dunningBlockedNoConsent']);
    expect(resources.cases()[0]?.actions).toHaveLength(0);
  });

  it('K2 fail-closed defaults: sms defaults to automated (blocked), an explicit manual source needs no consentRef', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const defaulted = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'sms', scheduledFor: T0 },
    });
    expect(defaulted.status).toBe(403); // forgetting the flag never bypasses consent

    const manual = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'sms', scheduledFor: T0, source: 'manual' },
    });
    expect(manual.status).toBe(201);
    expect((manual.body as { data: { action: { source: string; consentRef: string | null } } }).data.action.source).toBe('manual');
  });

  it('K2: an automated send WITH a consentRef goes through and carries the reference', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'sms', scheduledFor: T0, consentRef: 'consent-grant-77' },
    });
    expect(res.status).toBe(201);
    expect((res.body as { data: { action: { consentRef: string | null } } }).data.action.consentRef).toBe('consent-grant-77');
  });

  it('an action on a terminal case → 409 CASE_CLOSED (the log is sealed)', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');
    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'in_progress', reason: 'engaged' } });
    call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/transitions`, { auth: `Bearer ${world.sessionId}`, body: { to: 'resolved', reason: 'settled' } });

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'call', scheduledFor: T0 },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_CLOSED');
  });

  it('an unknown action type → 400 CASE_ACTION_TYPE_INVALID (the lane’s vocabulary, table-mapped)', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'fax', scheduledFor: T0 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_ACTION_TYPE_INVALID');
  });

  it('a malformed scheduledFor and a missing type are body-shape rejections → 400 HTTP_BODY_INVALID', () => {
    const { kernel, world } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const badDate = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'call', scheduledFor: 'tuesday-ish' },
    });
    expect(badDate.status).toBe(400);
    expect((badDate.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');

    const noType = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { scheduledFor: T0 },
    });
    expect(noType.status).toBe(400);
    expect((noType.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');
  });
});

describe('POST /v1/collections/cases/:caseId/actions/:actionId/completions — completing the log', () => {
  const seedCaseWithAction = (
    kernel: ReturnType<typeof createHttpKernel>,
    world: SeededWorld,
  ): { caseId: string; actionId: string } => {
    resources_case(kernel, world);
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');
    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { type: 'fieldVisit', scheduledFor: T0 },
    });
    const action = (res.body as { data: { action: { id: string } } }).data.action;
    return { caseId: opened.caseId, actionId: action.id };
  };

  const resources_case = (_kernel: ReturnType<typeof createHttpKernel>, world: SeededWorld): void => {
    // receivable rows must exist before the case opens (referential check)
    const store = (world as unknown as { __resources?: InMemoryResourceStore }).__resources;
    void store;
  };

  it('stamps outcome + completedAt + completedBy on a fresh copy — the log stays append-only', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const { caseId, actionId } = seedCaseWithAction(kernel, world);

    const res = call(kernel, 'POST', `/v1/collections/cases/${caseId}/actions/${actionId}/completions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { outcome: 'visited — debtor asked for a statement' },
    });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { case: { actions: { id: string; outcome: string; completedBy: string }[] } } }).data.case;
    expect(view.actions).toHaveLength(1); // appended-in-place, never removed
    expect(view.actions[0]?.id).toBe(actionId);
    expect(view.actions[0]?.outcome).toBe('visited — debtor asked for a statement');
    expect(view.actions[0]?.completedBy).toBe(world.adminUserId); // defaults to the recording actor
  });

  it('an unknown action id → 404 CASE_ACTION_NOT_FOUND (the lane’s stable code, suffix table)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const opened = openCaseOverTheWire(kernel, world);
    if (!opened.caseId) throw new Error('seed case missing');

    const res = call(kernel, 'POST', `/v1/collections/cases/${opened.caseId}/actions/${nextId()}/completions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { outcome: 'ghost' },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_ACTION_NOT_FOUND');
  });

  it('completing twice → 409 CASE_ACTION_ALREADY_COMPLETED', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const { caseId, actionId } = seedCaseWithAction(kernel, world);
    call(kernel, 'POST', `/v1/collections/cases/${caseId}/actions/${actionId}/completions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { outcome: 'first stamp' },
    });

    const res = call(kernel, 'POST', `/v1/collections/cases/${caseId}/actions/${actionId}/completions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { outcome: 'second stamp' },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CASE_ACTION_ALREADY_COMPLETED');
    expect(resources.cases()[0]?.actions[0]?.outcome).toBe('first stamp');
  });

  it('an explicit completedBy override is honored when supplied', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['collections:act'] });
    resources.saveReceivable(receivable(nextId()));
    const { caseId, actionId } = seedCaseWithAction(kernel, world);
    const supervisor = nextId();

    const res = call(kernel, 'POST', `/v1/collections/cases/${caseId}/actions/${actionId}/completions`, {
      auth: `Bearer ${world.sessionId}`,
      body: { outcome: 'verified', actorId: supervisor },
    });
    expect(res.status).toBe(200);
    expect((res.body as { data: { case: { actions: { completedBy: string }[] } } }).data.case.actions[0]?.completedBy).toBe(supervisor);
  });
});

// --- the permission boundary ------------------------------------------------------------------

describe('the permission boundary over /v1/collections', () => {
  it('collections:read alone cannot act → 403 with the denial AUDITED (collections:act)', () => {
    const { kernel, authStore, world, resources } = makeWorld({ permissions: ['collections:read'] });
    resources.saveReceivable(receivable(nextId()));
    const res = call(kernel, 'POST', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}`, body: openBody() });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');
    expect(resources.cases()).toHaveLength(0);

    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect(denial).toBeDefined();
    expect((denial?.payload as { permission: string }).permission).toBe('collections:act');
  });

  it('collections:act alone cannot read → 403 with the denial AUDITED (collections:read)', () => {
    const { kernel, authStore, world } = makeWorld({ permissions: ['collections:act'] });
    const res = call(kernel, 'GET', '/v1/collections/cases', { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');

    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect((denial?.payload as { permission: string }).permission).toBe('collections:read');
  });

  it('an unauthenticated open is 401 and audited', () => {
    const { kernel, authStore, resources } = makeWorld({ permissions: ['collections:act'] });
    const res = call(kernel, 'POST', '/v1/collections/cases', { body: openBody() });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_UNAUTHENTICATED');
    expect(authStore.events().some((event) => event.name === 'auth.accessDenied')).toBe(true);
    expect(resources.cases()).toHaveLength(0);
  });
});

const resources_cases = (resources: InMemoryResourceStore): number => resources.cases().length;
