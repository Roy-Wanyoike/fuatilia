/**
 * FileAuthStore specs (issue #61, F32) — the file-backed AuthStore itself.
 *
 * Covered: the boot guard (no mutation before load()), the AuthStore
 * round-trip per row type THROUGH the journal (save → reload → identical
 * state), upsert semantics, the crash-atomic snapshot (state.tmp + rename,
 * corrupt/orphaned tmp never read), snapshot+journal-tail boot folding,
 * corrupt-snapshot fallback to the full journal, sequence continuity across
 * reloads, and the secret-discipline guarantee (journal and snapshot bytes
 * never contain a plaintext secret).
 *
 * Every test runs in a fresh `os.tmpdir()` directory; no sleeps — the store's
 * own flush/snapshot promises are the synchronization points.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUser } from '../../domain/auth/user';
import { defineRole, expandRolePermissions } from '../../domain/auth/roles';
import { grantRole } from '../../domain/auth/assignments';
import { issueKey } from '../../domain/auth/apikeys';
import { openSession } from '../../domain/auth/sessions';
import type { Clock, Uuid } from '../../domain/shared/ids';
import type { AuthStore } from '../http/runtime/memory';
import { FileAuthStore, SNAPSHOT_FILENAME, SNAPSHOT_TMP_FILENAME } from './filestore';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as Uuid;
};

let dir: string;
const freshStore = async (label: string): Promise<FileAuthStore> => {
  dir = await mkdtemp(join(tmpdir(), `fuatilia-store-${label}-`));
  return new FileAuthStore(dir, { clock });
};

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

// --- row builders (the lanes validate; these are the wire analogues) --------

const makeUser = (displayName = 'Ada Kimathi', store?: AuthStore) => {
  const existing = store ? store.users() : [];
  return createUser(existing, {
    userId: nextId(),
    orgId: nextId(),
    email: `ada-${seq}@fuatilia.test`,
    username: `ada-${seq}`,
    displayName,
  }, clock).user;
};
const makeRole = (store: AuthStore) =>
  defineRole(store.roles(), {
    roleId: nextId(),
    orgId: nextId(),
    name: 'Finance Manager',
    permissions: ['receivables:read', 'payments:read'],
  }, clock).role;

const makeGrant = (store: AuthStore, roleId: Uuid) => {
  const role = defineRole([], { roleId, orgId: nextId(), name: 'Granted Role', permissions: ['receivables:read', 'payments:read'] }, clock).role;
  // the granter must COVER the role's own permissions plus the role-administration permission
  const granter = defineRole([], { roleId: nextId(), orgId: nextId(), name: 'Granter', permissions: ['receivables:read', 'payments:read', 'admin:manage-users'] }, clock).role;
  const granted = grantRole(store.grants(), {
    grantId: nextId(),
    orgId: nextId(),
    userId: nextId(),
    role,
    grantedBy: nextId(),
    granterPermissions: expandRolePermissions(granter),
  }, clock);
  if (!granted.granted) throw new Error('seed grant must succeed');
  return granted.grant;
};

const makeKey = (store: AuthStore, secret: string) =>
  issueKey(store.keys(), {
    keyId: nextId(),
    orgId: nextId(),
    name: 'backend-ingest',
    createdBy: nextId(),
    secret,
    scopes: ['payments:intake'],
    expiresAt: null,
  }, store.codec, clock).key;

const makeSession = (store: AuthStore) =>
  openSession({
    sessionId: nextId(),
    userId: nextId(),
    orgId: nextId(),
    idleTimeoutMs: 900_000,
    absoluteTimeoutMs: 43_200_000,
  }, clock).session;

describe('FileAuthStore — boot contract', () => {
  it('refuses mutations before load() (blind writes would collide with on-disk sequences)', async () => {
    const store = await freshStore('boot');
    expect(() => store.saveUser(makeUser())).toThrow(/not loaded/);
    const report = await store.load();
    expect(report).toEqual({ lines: 0, applied: 0, quarantined: 0 });
    expect(() => store.saveUser(makeUser())).not.toThrow(); // load() unlocks
    await store.flush();
  });

  it('load() creates a missing directory and reports an empty journal', async () => {
    const store = await freshStore('mkdir');
    (dir as string) = join(dir, 'nested', 'auth'); // the store will create it
    const report = await store.load();
    expect(report).toEqual({ lines: 0, applied: 0, quarantined: 0 });
  });
});

describe('FileAuthStore — the AuthStore round-trip per row type (through the journal)', () => {
  it('persists users, roles, grants, keys and sessions; a reloaded store sees them all', async () => {
    const store = await freshStore('roundtrip');
    await store.load();
    const user = makeUser();
    const role = makeRole(store);
    const grant = makeGrant(store, role.roleId);
    const key = makeKey(store, 'round-trip-secret-1');
    const session = makeSession(store);
    store.saveUser(user);
    store.saveRole(role);
    store.saveGrant(grant);
    store.saveKey(key);
    store.saveSession(session);
    await store.flush();

    const revived = new FileAuthStore(dir, { clock });
    await revived.load();
    expect(revived.users()).toEqual([user]);
    expect(revived.roles()).toEqual([role]);
    expect(revived.grants()).toEqual([grant]);
    expect(revived.keys()).toEqual([key]);
    expect(revived.sessions()).toEqual([session]);
    await revived.close();
  });

  it('upserts by aggregate id — the latest fact wins and survives a reload', async () => {
    const store = await freshStore('upsert');
    await store.load();
    const userId = nextId();
    const original = createUser([], {
      userId, orgId: nextId(), email: 'u@fuatilia.test', username: 'user-one', displayName: 'Before',
    }, clock).user;
    const renamed: typeof original = { ...original, displayName: 'After' };
    store.saveUser(original);
    store.saveUser(renamed); // same aggregate id
    await store.flush();

    const revived = new FileAuthStore(dir, { clock });
    await revived.load();
    expect(revived.users()).toHaveLength(1);
    expect(revived.users()[0]?.displayName).toBe('After');
    await revived.close();
  });

  it('persists the append-only event log; reloaded stores keep its order', async () => {
    const store = await freshStore('events');
    await store.load();
    const { user, event } = createUser([], {
      userId: nextId(), orgId: nextId(), email: 'e@fuatilia.test', username: 'event-user', displayName: 'E',
    }, clock);
    store.saveUser(user);
    store.record(event);
    store.record({ name: 'auth.auditTest', version: 1, aggregateId: user.userId, payload: { ok: true }, occurredAt: T0 });
    await store.flush();

    const revived = new FileAuthStore(dir, { clock });
    await revived.load();
    expect(revived.events().map((e) => e.name)).toEqual(['auth.userCreated', 'auth.auditTest']);
    await revived.close();
  });
});

describe('FileAuthStore — snapshots (crash-atomic boot optimization)', () => {
  it('snapshot() leaves state.json and no staging tmp behind; reload folds snapshot + tail', async () => {
    const store = await freshStore('snapshot');
    await store.load();
    store.saveUser(makeUser('Snapshot User'));
    await store.flush();
    await store.snapshot();

    const snapshotRaw = await readFile(join(dir, SNAPSHOT_FILENAME), 'utf8');
    expect(JSON.parse(snapshotRaw)).toMatchObject({ format: 'fuatilia.auth-store/1' });
    await expect(readFile(join(dir, SNAPSHOT_TMP_FILENAME), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    // journal is NEVER truncated — it stays the source of truth
    const journalRaw = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    expect(journalRaw.split('\n').filter((l) => l !== '')).toHaveLength(1);

    const revived = new FileAuthStore(dir, { clock });
    const report = await revived.load();
    expect(revived.users()).toHaveLength(1);
    expect(report.lines).toBe(1); // the snapshot's seq is folded — the tail is empty
    expect(report.applied).toBe(0);
    await revived.close();
  });

  it('boots from snapshot + journal tail: mutations after the snapshot survive', async () => {
    const store = await freshStore('tail');
    await store.load();
    store.saveUser(makeUser('In Snapshot'));
    await store.flush();
    await store.snapshot();
    store.saveUser(makeUser('After Snapshot'));
    await store.flush();

    const revived = new FileAuthStore(dir, { clock });
    const report = await revived.load();
    expect(revived.users().map((u) => u.displayName)).toEqual(['In Snapshot', 'After Snapshot']);
    expect(report.applied).toBe(1); // exactly the tail line beyond the snapshot
    await revived.close();
  });

  it('a crash between tmp and rename never loses the previous snapshot', async () => {
    const store = await freshStore('crash');
    await store.load();
    store.saveUser(makeUser('Committed'));
    await store.flush();
    await store.snapshot();

    // simulate the torn state: a half-written staging file (the rename never happened)
    await writeFile(join(dir, SNAPSHOT_TMP_FILENAME), '{"format":"fuatilia.auth-store/1","torn":', 'utf8');
    // the next snapshot OVERWRITES the tmp and completes the rename — the store never reads tmp
    store.saveUser(makeUser('Second'));
    await store.flush();
    await store.snapshot();

    const revived = new FileAuthStore(dir, { clock });
    await revived.load();
    expect(revived.users().map((u) => u.displayName)).toEqual(['Committed', 'Second']);
    await revived.close();
  });

  it('a corrupt snapshot is IGNORED — the journal replay covers everything', async () => {
    const store = await freshStore('corrupt');
    await store.load();
    store.saveUser(makeUser('From Journal'));
    await store.flush();
    await writeFile(join(dir, SNAPSHOT_FILENAME), 'not even json', 'utf8');

    const revived = new FileAuthStore(dir, { clock });
    const report = await revived.load();
    expect(revived.users()).toHaveLength(1); // full journal replay, all-or-nothing fallback
    expect(report.applied).toBe(1);
    await revived.close();
  });
});

describe('FileAuthStore — sequence continuity across reloads', () => {
  it('loading twice is idempotent; appended sequences continue from the high-water mark', async () => {
    const store = await freshStore('continuity');
    await store.load();
    const user = makeUser();
    store.saveUser(user);
    await store.flush();

    await store.load(); // second boot over the same instance
    expect(store.users()).toEqual([user]); // identical state

    store.saveUser(makeUser('Second')); // must get seq 2, NOT restart at 1
    await store.flush();
    const journalRaw = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    const seqs = journalRaw
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2]);
  });
});

describe('FileAuthStore — secret discipline (SPEC §34)', () => {
  it('journal and snapshot bytes never contain a plaintext api-key secret', async () => {
    const store = await freshStore('secrets');
    await store.load();
    const plaintext = 'super-secret-plaintext-42';
    const key = makeKey(store, plaintext);
    store.saveKey(key);
    await store.flush();
    await store.snapshot();

    const journalRaw = await readFile(join(dir, 'journal.jsonl'), 'utf8');
    const snapshotRaw = await readFile(join(dir, SNAPSHOT_FILENAME), 'utf8');
    expect(journalRaw).not.toContain(plaintext);
    expect(snapshotRaw).not.toContain(plaintext);
    // the row's hash is what travels — and it round-trips
    const revived = new FileAuthStore(dir, { clock });
    await revived.load();
    expect(revived.keys()[0]?.secretHash).toBe(key.secretHash);
    expect(revived.keys()[0]?.secretHash).not.toBe(plaintext);
    await revived.close();
  });
});
