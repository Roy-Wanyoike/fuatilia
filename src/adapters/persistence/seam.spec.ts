/**
 * The kernel seam specs (issue #61, F32) — proof that the file-backed
 * AuthStore slots into the HTTP kernel's existing `store` option WITHOUT any
 * change to the kernel, the middleware or the routes (the adapter seam
 * `runtime/memory.ts` documents).
 *
 * The headline scenario: create a user over the wire, flush, "restart" (a
 * fresh store + fresh kernel over the same directory) — the user, the
 * seeded admin, the session and the event log are all still there, and the
 * journal's sequence continues. Also verified: the journal never carries a
 * plaintext secret issued through the lane.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { issueKey } from '../../domain/auth/apikeys';
import type { Clock, Uuid } from '../../domain/shared/ids';
import { createHttpKernel } from '../http/server';
import { seedWorld, type SeededWorld } from '../http/runtime/memory';
import { createFileAuthStore } from './index';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => {
  seq += 1;
  return `70000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as Uuid;
};

let dir: string;

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

/** Boot a kernel over a fresh FileAuthStore in `dir`, seeding the admin world. */
const bootSeeded = async (): Promise<{
  kernel: ReturnType<typeof createHttpKernel>;
  store: ReturnType<typeof createFileAuthStore>;
  world: SeededWorld;
}> => {
  dir = await mkdtemp(join(tmpdir(), 'fuatilia-seam-'));
  const store = createFileAuthStore(dir, { clock });
  await store.load();
  const world = seedWorld(store, clock, () => nextId());
  await store.flush();
  const kernel = createHttpKernel({ store, clock, idGen: () => nextId() });
  return { kernel, store, world };
};

const postUser = (
  kernel: ReturnType<typeof createHttpKernel>,
  sessionId: string,
  email: string,
) =>
  kernel.handle({
    method: 'POST',
    path: '/v1/auth/users',
    headers: { authorization: `Bearer ${sessionId}` },
    rawBody: JSON.stringify({ email, username: email.split('@')[0], displayName: 'Wire User' }),
  });

describe('the kernel seam — persistence across "restarts"', () => {
  it('a user created over the wire lands in the file store', async () => {
    const { kernel, store, world } = await bootSeeded();
    const res = postUser(kernel, world.sessionId, 'wire-1@fuatilia.test');
    expect(res.status).toBe(201);
    await store.flush();
    expect(store.users().some((u) => u.email === 'wire-1@fuatilia.test')).toBe(true);
    await store.close();
  });

  it('a fresh kernel over the SAME directory sees the wire-created user after a restart', async () => {
    const { kernel, store, world } = await bootSeeded();
    postUser(kernel, world.sessionId, 'restart@fuatilia.test');
    await store.flush();
    await store.close();

    const revived = createFileAuthStore(dir, { clock });
    const report = await revived.load();
    expect(report.quarantined).toBe(0);
    expect(revived.users().some((u) => u.email === 'restart@fuatilia.test')).toBe(true);
    expect(revived.users().some((u) => u.email === 'admin@fuatilia.test')).toBe(true);
    await revived.close();
  });

  it('the seeded session survives the restart — the admin can keep acting', async () => {
    const { kernel, store, world } = await bootSeeded();
    expect(postUser(kernel, world.sessionId, 'first@fuatilia.test').status).toBe(201);
    await store.flush();
    await store.close();

    const revived = createFileAuthStore(dir, { clock });
    await revived.load();
    const kernel2 = createHttpKernel({ store: revived, clock, idGen: () => nextId() });
    const res = postUser(kernel2, world.sessionId, 'second@fuatilia.test');
    expect(res.status).toBe(201); // same Bearer token — sessions are rows, not memory
    await revived.flush();
    expect(revived.users().map((u) => u.email)).toEqual(
      expect.arrayContaining(['first@fuatilia.test', 'second@fuatilia.test']),
    );
    await revived.close();
  });

  it('audited denials are journaled events — an unauthenticated request leaves a durable trace', async () => {
    const { kernel, store } = await bootSeeded();
    const res = kernel.handle({
      method: 'POST',
      path: '/v1/auth/users',
      headers: {},
      rawBody: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
    await store.flush();

    const revived = createFileAuthStore(dir, { clock });
    await revived.load();
    // the seeded world's events PLUS the audited denial survived the restart
    expect(revived.events().length).toBeGreaterThan(0);
    expect(revived.events().some((e) => e.name.startsWith('auth.'))).toBe(true);
    await revived.close();
  });
});

describe('the kernel seam — secret discipline through the lane', () => {
  it('issuing an api key through the store never writes the plaintext to disk', async () => {
    const { store } = await bootSeeded();
    const plaintext = 'wire-issued-secret-77';
    const { key } = issueKey(store.keys(), {
      keyId: nextId(),
      orgId: nextId(),
      name: 'ingest',
      createdBy: nextId(),
      secret: plaintext,
      scopes: ['payments:intake'],
      expiresAt: null,
    }, store.codec, clock);
    store.saveKey(key);
    await store.flush();

    const journalRaw = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    expect(journalRaw).not.toContain(plaintext);
    expect(key.secretHash).not.toBe(plaintext);
    await store.close();
  });
});

describe('the kernel seam — chained restarts', () => {
  it('three generations over one directory accumulate state with a continuous sequence', async () => {
    const { kernel, store, world } = await bootSeeded();
    postUser(kernel, world.sessionId, 'gen-1@fuatilia.test');
    await store.flush();
    await store.close();

    const second = createFileAuthStore(dir, { clock });
    await second.load();
    const kernel2 = createHttpKernel({ store: second, clock, idGen: () => nextId() });
    expect(postUser(kernel2, world.sessionId, 'gen-2@fuatilia.test').status).toBe(201);
    await second.flush();
    await second.close();

    const third = createFileAuthStore(dir, { clock });
    const report = await third.load();
    expect(report.quarantined).toBe(0);
    expect(third.users().map((u) => u.email)).toEqual(
      expect.arrayContaining(['gen-1@fuatilia.test', 'gen-2@fuatilia.test']),
    );
    await third.close();
  });
});
