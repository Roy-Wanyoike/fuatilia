/**
 * The file-backed AuthStore (issue #61, F32) — the first real persistence
 * adapter behind the HTTP lane's store seam (`../http/runtime/memory.ts`):
 * it satisfies the EXACT `AuthStore` interface, so `createHttpKernel({
 * store })` mounts it untouched.
 *
 * Architecture:
 *
 *   - The JSONL journal (./journal) is the SOURCE OF TRUTH. Every `save*` /
 *     `record` mutation updates the in-memory maps synchronously (the
 *     interface is synchronous) and appends one journal line describing the
 *     row. `load()` boots from the latest snapshot plus the journal tail
 *     beyond it — or the journal alone, which is always sufficient.
 *   - Snapshots (`state.json`) are a boot-speed optimization, written
 *     crash-atomically: serialize to `state.tmp`, then `rename` over
 *     `state.json`. A crash between tmp and rename leaves the previous
 *     snapshot intact and the journal tail fills the gap. A corrupt or
 *     orphaned snapshot is ignored — the journal replay covers everything.
 *   - Mutations are serialized through a promise queue (so interleaved
 *     `save*` calls can never interleave journal lines) and `flush()` is the
 *     durability barrier: drain every queued append, then fsync.
 *   - Secret discipline (SPEC §34): rows already hold HASHED secrets
 *     upstream (the `codec` port); the journal and snapshots store exactly
 *     what the rows hold and never add plaintext.
 *
 * Boot contract: construct, `await load()`, then mutate. Mutating before a
 * completed `load()` throws (fail-loud: blind writes would collide with
 * on-disk sequence numbers). A failed journal write makes `flush()` and
 * `snapshot()` reject — fail-closed, never a silent success.
 */
import { mkdir, open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiKey } from '../../domain/auth/apikeys';
import type { RoleGrant } from '../../domain/auth/assignments';
import type { Role } from '../../domain/auth/roles';
import type { Session } from '../../domain/auth/sessions';
import { systemClock, type Clock } from '../../domain/shared/ids';
import type { SecretCodec, User } from '../../domain/auth/user';
import { sha256Codec, type AuthStore, type StoredEvent } from '../http/runtime/memory';
import { JsonlJournal, JOURNAL_FILENAME, type JournalKind } from './journal';
import { parseSnapshot, replayJournal, SNAPSHOT_FORMAT, type LoadReport, type ReplayState } from './replay';

export { JOURNAL_FILENAME };
/** The committed snapshot file (written via an atomic rename). */
export const SNAPSHOT_FILENAME = 'state.json';
/** The snapshot staging file — always renamed away or overwritten, never read. */
export const SNAPSHOT_TMP_FILENAME = 'state.tmp';

export interface FileAuthStoreOptions {
  /** Secret codec (default: the reference SHA-256 codec). Rows hold its output. */
  readonly codec?: SecretCodec;
  /** Clock for journal stamps and snapshot `takenAt` (default: system). */
  readonly clock?: Clock;
  /** Journal filename override (default: `journal.jsonl`). */
  readonly journalFilename?: string;
}

/** node's fs errors carry a `code` — read it without @types/node. */
const errorCode = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

const readFileOrNull = async (filePath: string): Promise<string | null> => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
};

/**
 * Best-effort directory fsync after the snapshot rename: on crash-durability
 * platforms this pins the rename; where directory handles are unsupported it
 * is a no-op (the rename itself is already atomic).
 */
const syncDirBestEffort = async (dir: string): Promise<void> => {
  let handle: FileHandle | null = null;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // best effort — never fail a completed snapshot over a platform quirk
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
};

export class FileAuthStore implements AuthStore {
  readonly codec: SecretCodec;
  private readonly clock: Clock;
  private readonly dir: string;
  private readonly journal: JsonlJournal;

  private userRows = new Map<string, User>();
  private roleRows = new Map<string, Role>();
  private grantRows = new Map<string, RoleGrant>();
  private keyRows = new Map<string, ApiKey>();
  private sessionRows = new Map<string, Session>();
  private eventLog: StoredEvent[] = [];

  /** Serialized load / snapshot / append operations (mutation ordering). */
  private tail: Promise<void> = Promise.resolve();
  /** First failed journal write — sticky until the next successful load. */
  private failure: { readonly error: unknown } | null = null;
  /** Boot guard: mutations before a completed load() are a programming error. */
  private booted = false;

  constructor(dir: string, options: FileAuthStoreOptions = {}) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('FileAuthStore requires a directory path');
    }
    this.dir = dir;
    this.codec = options.codec ?? sha256Codec;
    this.clock = options.clock ?? systemClock;
    this.journal = new JsonlJournal(dir, options.journalFilename ?? JOURNAL_FILENAME);
  }

  // --- boot -----------------------------------------------------------------

  /**
   * Replay the directory into memory: latest snapshot + journal tail beyond
   * it (or the journal alone). Creates a missing directory. Returns the
   * journal's load report; loading twice yields identical state and sequence
   * numbers continue from the high-water mark.
   */
  async load(): Promise<LoadReport> {
    return this.runExclusive(async () => {
      await mkdir(this.dir, { recursive: true });

      const snapshotRaw = await readFileOrNull(join(this.dir, SNAPSHOT_FILENAME));
      const snapshot = snapshotRaw === null ? null : parseSnapshot(snapshotRaw);

      const journalRaw = await readFileOrNull(this.journal.path);
      const result = replayJournal(journalRaw ?? '', {
        base: snapshot?.state,
        minSeq: snapshot?.lastSeq ?? 0,
      });

      this.userRows = new Map(result.state.users);
      this.roleRows = new Map(result.state.roles);
      this.grantRows = new Map(result.state.grants);
      this.keyRows = new Map(result.state.keys);
      this.sessionRows = new Map(result.state.sessions);
      this.eventLog = [...result.state.events];

      this.journal.adopt(result.lastSeq);
      this.failure = null; // a completed load re-establishes disk truth
      this.booted = true;
      return result.report;
    });
  }

  /**
   * Write a crash-atomic snapshot of the current state: all queued journal
   * appends are drained and fsynced FIRST (the journal never trails the
   * snapshot), then `state.tmp` is written and renamed over `state.json`.
   * The journal itself is never truncated — it stays the source of truth.
   */
  async snapshot(): Promise<void> {
    return this.runExclusive(async () => {
      this.assertWritable();
      await this.journal.flush();
      const state = {
        format: SNAPSHOT_FORMAT,
        takenAt: this.clock.now().toISOString(),
        lastSeq: this.journal.lastSeq,
        rows: {
          users: [...this.userRows.values()],
          roles: [...this.roleRows.values()],
          grants: [...this.grantRows.values()],
          keys: [...this.keyRows.values()],
          sessions: [...this.sessionRows.values()],
          events: [...this.eventLog],
        },
      };
      const tmpPath = join(this.dir, SNAPSHOT_TMP_FILENAME);
      await writeFile(tmpPath, JSON.stringify(state), 'utf8');
      await rename(tmpPath, join(this.dir, SNAPSHOT_FILENAME));
      await syncDirBestEffort(this.dir);
    });
  }

  /**
   * The durability barrier: every mutation accepted so far is on disk and
   * fsynced when this resolves. Rejects if any journaled write failed.
   */
  async flush(): Promise<void> {
    return this.runExclusive(async () => {
      this.assertWritable();
      await this.journal.flush();
    });
  }

  /** Release the journal's file handle (clean shutdown; appends reopen lazily). */
  async close(): Promise<void> {
    return this.runExclusive(() => this.journal.close());
  }

  // --- the AuthStore seam (synchronous reads, journaled writes) ----------------

  users(): readonly User[] {
    return [...this.userRows.values()];
  }

  roles(): readonly Role[] {
    return [...this.roleRows.values()];
  }

  grants(): readonly RoleGrant[] {
    return [...this.grantRows.values()];
  }

  keys(): readonly ApiKey[] {
    return [...this.keyRows.values()];
  }

  sessions(): readonly Session[] {
    return [...this.sessionRows.values()];
  }

  events(): readonly StoredEvent[] {
    return [...this.eventLog];
  }

  saveUser(user: User): void {
    this.userRows.set(user.userId, user);
    this.enqueue('user', user);
  }

  saveRole(role: Role): void {
    this.roleRows.set(role.roleId, role);
    this.enqueue('role', role);
  }

  saveGrant(grant: RoleGrant): void {
    this.grantRows.set(grant.grantId, grant);
    this.enqueue('grant', grant);
  }

  saveKey(key: ApiKey): void {
    this.keyRows.set(key.keyId, key);
    this.enqueue('key', key);
  }

  saveSession(session: Session): void {
    this.sessionRows.set(session.sessionId, session);
    this.enqueue('session', session);
  }

  record(event: StoredEvent): void {
    this.eventLog.push(event);
    this.enqueue('event', event);
  }

  // --- internals -----------------------------------------------------------------

  private enqueue(kind: JournalKind, row: unknown): void {
    this.assertWritable();
    const at = this.clock.now().toISOString(); // the mutation instant, not the write instant
    this.tail = this.tail.then(async () => {
      if (this.failure !== null) return; // fail-closed after the first broken write
      try {
        await this.journal.append(kind, row, at);
      } catch (error: unknown) {
        this.failure = { error };
      }
    });
  }

  private assertWritable(): void {
    if (!this.booted) {
      throw new Error('FileAuthStore is not loaded — call load() before the first mutation (boot replays the journal)');
    }
    if (this.failure !== null) {
      throw this.failure.error;
    }
  }

  /** Serialize an exclusive operation (load / snapshot / flush / close) after all pending mutations. */
  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op, op); // run regardless of a predecessor's outcome
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
