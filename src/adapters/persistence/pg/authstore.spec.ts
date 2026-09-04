/**
 * PGAuthStore specs (issue #73) — the cache-first synchronous facade over
 * PostgreSQL for the AuthStore seam.
 *
 * Covered: the boot guard (no mutation before ensureReady()), the AuthStore
 * round-trip per row type THROUGH PostgreSQL (save → flush → re-boot →
 * identical state), upsert semantics on double-save, the secret-discipline
 * guarantee (API keys stored HASHED via the store's SecretCodec — the
 * plaintext never reaches any column), audited-denial event capture, the
 * sticky-failure contract under a real dead postmaster (save* throws until
 * a flush() re-arms) and recovery without losing the queue, and the
 * swap-in test: the SAME kernel that serves server.spec.ts against the
 * in-memory store passes its key scenarios with the PG stores behind the
 * `options.store` / `options.resourceStore` seams.
 *
 * Durability semantics run against the shared lane cluster
 * (FUATILIA_TEST_DATABASE_URL); the dead-postmaster test spawns a private
 * ephemeral cluster (real initdb/pg_ctl — never a stub). An unreachable
 * cluster fails the run, never a silent skip.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../../domain/auth/user';
import { defineRole, expandRolePermissions } from '../../../domain/auth/roles';
import { grantRole } from '../../../domain/auth/assignments';
import { issueKey } from '../../../domain/auth/apikeys';
import { openSession } from '../../../domain/auth/sessions';
import { systemClock } from '../../../domain/shared';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { seedWorld } from '../../http/runtime/memory';
import { createHttpKernel } from '../../http/server';
import { PGClient } from './client';
import { PGAuthStore, PGScopeError } from './authstore';
import { PGResourceStore } from './resourcestore';
import { bootstrapTestDb, purgeOrgs, spawnEphemeralCluster, testDatabaseUrl } from './testutil';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as Uuid;
};

let config: Record<string, unknown>;
let client: PGClient;
const orgs: string[] = [];

beforeAll(async () => {
  config = (await bootstrapTestDb()) as unknown as Record<string, unknown>;
  client = new PGClient({ config: config as never });
});

afterEach(() => {
  seq = 0;
});

afterAll(async () => {
  await purgeOrgs(testDatabaseUrl(), orgs).catch(() => undefined);
  await client.close().catch(() => undefined);
});

const trackOrg = (orgId: Uuid): Uuid => {
  orgs.push(orgId);
  return orgId;
};

// --- row builders (the lanes validate; these are the wire analogues) --------

const makeUser = (store: PGAuthStore) => {
  const orgId = trackOrg(nextId());
  return createUser(store.users(), {
    userId: nextId(),
    orgId,
    email: `ada-${seq}@fuatilia.test`,
    username: `ada-${seq}`,
    displayName: 'Ada Kimathi',
  }, clock).user;
};
const makeRole = (store: PGAuthStore) =>
  defineRole(store.roles(), {
    roleId: nextId(),
    orgId: trackOrg(nextId()),
    name: 'Finance Manager',
    permissions: ['receivables:read', 'payments:read'],
  }, clock).role;

const makeGrant = (store: PGAuthStore) => {
  const role = defineRole([], { roleId: nextId(), orgId: trackOrg(nextId()), name: 'Granted Role', permissions: ['receivables:read', 'payments:read'] }, clock).role;
  const granter = defineRole([], { roleId: nextId(), orgId: trackOrg(nextId()), name: 'Granter', permissions: ['receivables:read', 'payments:read', 'admin:manage-users'] }, clock).role;
  const granted = grantRole(store.grants(), {
    grantId: nextId(),
    orgId: role.orgId,
    userId: nextId(),
    role,
    grantedBy: nextId(),
    granterPermissions: expandRolePermissions(granter),
  }, clock);
  if (!granted.granted) throw new Error('seed grant must succeed');
  return granted.grant;
};

const SECRET = 'fuatilia-plaintext-secret-4f2a';
const makeKey = (store: PGAuthStore) =>
  issueKey(store.keys(), {
    keyId: nextId(),
    orgId: trackOrg(nextId()),
    name: 'backend-ingest',
    createdBy: nextId(),
    secret: SECRET,
    scopes: ['payments:intake'],
    expiresAt: null,
  }, store.codec, clock).key;

const makeSession = () =>
  openSession({
    sessionId: nextId(),
    userId: nextId(),
    orgId: trackOrg(nextId()),
    idleTimeoutMs: 900_000,
    absoluteTimeoutMs: 43_200_000,
  }, clock).session;

const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('PGAuthStore — boot contract', () => {
  it('refuses mutations before ensureReady() (blind writes would collide with stored state)', async () => {
    const store = new PGAuthStore(new PGClient({ config: config as never }));
    const user = makeUser(store);
    expect(() => store.saveUser(user)).toThrow(/not ready|ensureReady/i);
    const report = await store.ensureReady();
    expect(report.quarantined).toBe(0);
    expect(() => store.saveUser(user)).not.toThrow(); // boot unlocks
    await store.flush();
    orgs.push(user.orgId);
  });
});

describe('PGAuthStore — durability round-trips (save → flush → re-boot → identical)', () => {
  it('persists users, roles, grants, keys, sessions and audited events across a full reboot', async () => {
    const store = new PGAuthStore(new PGClient({ config: config as never }));
    await store.ensureReady();

    const user = makeUser(store);
    const role = makeRole(store);
    const grant = makeGrant(store);
    const key = makeKey(store);
    const session = makeSession();
    const denial = {
      name: 'auth.denied',
      version: 1 as const,
      aggregateId: user.userId,
      payload: { orgId: user.orgId, code: 'AUTH_ACCESS_DENIED', permission: 'payments:refund' },
      occurredAt: T0,
    };
    store.saveUser(user);
    store.saveRole(role);
    store.saveGrant(grant);
    store.saveKey(key);
    store.saveSession(session);
    store.record(denial);
    await store.flush();

    // A SECOND instance over the SAME database must observe identical state.
    const reborn = new PGAuthStore(new PGClient({ config: config as never }));
    await reborn.ensureReady();

    const savedUser = reborn.users().find((u) => u.userId === user.userId);
    expect(normalized(savedUser)).toEqual(normalized(user));
    expect(normalized(reborn.roles().find((r) => r.roleId === role.roleId))).toEqual(normalized(role));
    expect(normalized(reborn.grants().find((g) => g.grantId === grant.grantId))).toEqual(normalized(grant));
    expect(normalized(reborn.keys().find((k) => k.keyId === key.keyId))).toEqual(normalized(key));
    expect(normalized(reborn.sessions().find((s) => s.sessionId === session.sessionId))).toEqual(normalized(session));
    const event = reborn.events().find((e) => e.name === 'auth.denied' && e.aggregateId === user.userId);
    expect(normalized(event)).toEqual(normalized(denial));

    await reborn.close();
  });

  it('upserts on double-save (idempotent, never duplicates)', async () => {
    const store = new PGAuthStore(new PGClient({ config: config as never }));
    await store.ensureReady();
    const user = makeUser(store);
    store.saveUser(user);
    store.saveUser(user);
    await store.flush();
    const reborn = new PGAuthStore(new PGClient({ config: config as never }));
    await reborn.ensureReady();
    expect(reborn.users().filter((u) => u.userId === user.userId)).toHaveLength(1);
    await reborn.close();
  });

  it('API keys are stored HASHED — the plaintext secret reaches no column', async () => {
    const store = new PGAuthStore(new PGClient({ config: config as never }));
    await store.ensureReady();
    const key = makeKey(store);
    store.saveKey(key);
    await store.flush();

    const probe = await client.query('key-hash-probe', 'SELECT * FROM api_keys WHERE key_id = $1', [key.keyId]);
    expect(probe.rows).toHaveLength(1);
    for (const [column, value] of Object.entries(probe.rows[0] ?? {})) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value);
      expect(`${column}=${serialized ?? ''}`).not.toContain(SECRET);
    }
    // the hash side is deterministic per codec — a re-issue hashes identically
    expect(key.secretHash).not.toBe(SECRET);
  });
});

describe('PGAuthStore — swap-in at the kernel seam (server.spec scenarios over PG)', () => {
  it('serves health, meta, 401-unauthenticated and the authed admin path with the PG stores', async () => {
    const store = new PGAuthStore(new PGClient({ config: config as never }));
    const resourceStore = new PGResourceStore(new PGClient({ config: config as never }));
    await store.ensureReady();
    await resourceStore.ensureReady();

    const world = seedWorld(store, clock);
    const kernel = createHttpKernel({ store, resourceStore, clock: systemClock });
    const listened = await kernel.listen(0);
    try {
      const url = (path: string): string => `${listened.url}${path}`;

      const health = await fetch(url('/v1/health'));
      expect(health.status).toBe(200);
      expect(((await health.json()) as { data: { status: string } }).data.status).toBe('ok');

      const meta = await fetch(url('/v1/meta'));
      expect(((await meta.json()) as { data: { capabilities: string[] } }).data.capabilities).toContain('auth');

      const anonymous = await fetch(url('/v1/auth/users'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: world.orgId, email: 'x@y.test', username: 'x', displayName: 'X' }),
      });
      expect(anonymous.status).toBe(401);
      const anonBody = (await anonymous.json()) as { error: { code: string }; requestId: string };
      expect(anonBody.error.code).toBe('HTTP_UNAUTHENTICATED');
      expect(anonBody.requestId).toBeTruthy();

      const authed = await fetch(url('/v1/auth/users'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${world.sessionId}` },
        body: JSON.stringify({ orgId: world.orgId, email: 'pg-adapter@fuatilia.test', username: 'pg-adapter', displayName: 'PG Adapter User' }),
      });
      expect(authed.status).toBe(201);
      const created = (await authed.json()) as { data: { id: string; orgId: string } };
      expect(created.data.orgId).toBe(world.orgId);
      // the created user landed in the PG projection, not just the response
      expect(store.users().some((u) => u.userId === created.data.id)).toBe(true);
      await store.flush();
      const reborn = new PGAuthStore(new PGClient({ config: config as never }));
      await reborn.ensureReady();
      expect(reborn.users().some((u) => u.userId === created.data.id)).toBe(true);
      await reborn.close();
    } finally {
      await listened.close();
    }
  });
});

describe('PGAuthStore — sticky failure under a REAL dead postmaster (ephemeral cluster)', () => {
  it('save* throws while PG is down, the queue survives, and flush() re-arms after recovery', async () => {
    const cluster = await spawnEphemeralCluster('authstore-crash');
    try {
      const client = new PGClient({ config: cluster.config as never });
      const store = new PGAuthStore(client);
      await store.ensureReady();

      const user = makeUser(store);
      store.saveUser(user);
      await store.flush();

      // kill PostgreSQL (clean fast stop — the postmaster is REALLY gone)
      await cluster.stop('fast');
      const doomed = makeUser(store);
      store.saveUser(doomed);
      await expect(store.flush()).rejects.toThrow();
      // sticky: further saves refuse until a successful flush re-arms
      expect(() => store.saveUser(makeUser(store))).toThrow();

      // the admin comes back — the SAME queue drains, nothing was lost
      await cluster.start();
      await store.flush();
      expect(store.users().some((u) => u.userId === doomed.userId)).toBe(true);

      // and the durable state survives one more full reboot
      const reborn = new PGAuthStore(new PGClient({ config: cluster.config as never }));
      await reborn.ensureReady();
      expect(reborn.users().some((u) => u.userId === user.userId)).toBe(true);
      expect(reborn.users().some((u) => u.userId === doomed.userId)).toBe(true);
      await reborn.close();
      await client.close();
    } finally {
      await cluster.destroy();
    }
  }, 120_000);
});
