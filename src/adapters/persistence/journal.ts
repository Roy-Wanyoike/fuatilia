/**
 * Append-only JSONL journal — the write half of the file-backed AuthStore
 * (issue #61, F32 "File-backed AuthStore persistence adapter").
 *
 * Format: one journal entry per line, no exceptions —
 *
 *   {"seq":1,"kind":"user","at":"2026-01-01T00:00:00.000Z","row":{...}}\n
 *
 *   - `seq`  — monotonic 1-based sequence number. Gaps are legal after a
 *     failed write (the slot is burned); strict monotonicity is the
 *     invariant, never contiguity. `adopt()` seeds the counter from a
 *     replayed high-water mark so sequence numbers continue, never restart.
 *   - `kind` — which AuthStore collection the row belongs to
 *     (user | role | grant | key | session | event).
 *   - `at`   — the mutation instant (the injected Clock, ISO-8601).
 *   - `row`  — exactly what the store row holds. Rows already carry HASHED
 *     secrets upstream (the SecretCodec port); the journal never adds,
 *     transforms or removes secret material.
 *
 * JSON.stringify never emits a literal newline inside a string, so one entry
 * is exactly one line: the trailing newline is the commit mark. A torn write
 * leaves a partial trailing line that replay QUARANTINES (never throws,
 * never poisons earlier lines).
 *
 * Durability: writes are serialized through an internal promise queue, so a
 * storm of concurrent `append()` calls can never interleave lines.
 * `append()` resolves once its line has been handed to the OS; `flush()` is
 * the durability barrier — it drains the queue and fsyncs the file handle.
 */
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The canonical journal filename (one per store directory). */
export const JOURNAL_FILENAME = 'journal.jsonl';

/** Which AuthStore collection a journaled row belongs to. */
export const JOURNAL_KINDS = ['user', 'role', 'grant', 'key', 'session', 'event'] as const;

export type JournalKind = (typeof JOURNAL_KINDS)[number];

/** One committed journal line (the v1 envelope — replay validates exactly this). */
export interface JournalEntry {
  readonly seq: number;
  readonly kind: JournalKind;
  readonly at: string;
  readonly row: unknown;
}

export const isJournalKind = (raw: unknown): raw is JournalKind =>
  typeof raw === 'string' && (JOURNAL_KINDS as readonly string[]).includes(raw);

const isSeq = (raw: unknown): raw is number =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0;

/**
 * The append-only journal. One writer per directory (the FileAuthStore);
 * the internal queue makes every append line-atomic regardless of how the
 * caller interleaves them.
 */
export class JsonlJournal {
  private readonly filePath: string;
  private handle: FileHandle | null = null;
  private tail: Promise<void> = Promise.resolve();
  private _lastSeq = 0;

  constructor(dir: string, filename: string = JOURNAL_FILENAME) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new Error('JsonlJournal requires a directory path');
    }
    if (typeof filename !== 'string' || filename.trim() === '' || filename.includes('/')) {
      throw new Error(`JsonlJournal requires a plain filename, got '${String(filename)}'`);
    }
    this.filePath = join(dir, filename);
  }

  /** Absolute path of the journal file. */
  get path(): string {
    return this.filePath;
  }

  /** The sequence high-water mark (continues, never restarts). */
  get lastSeq(): number {
    return this._lastSeq;
  }

  /**
   * Adopt a replayed high-water mark so appends after a boot continue the
   * on-disk sequence. Monotonic by construction: adopting a lower mark is a
   * no-op.
   */
  adopt(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`JsonlJournal.adopt requires a non-negative safe integer, got ${String(seq)}`);
    }
    this._lastSeq = Math.max(this._lastSeq, seq);
  }

  /**
   * Queue one entry. The sequence number is assigned synchronously in call
   * order (so a mutation storm stamps a strictly increasing sequence); the
   * write itself runs on the internal queue. Resolves with the assigned seq
   * once the line has been handed to the OS; rejects if THIS line could not
   * be written (the queue itself survives — later appends still land).
   */
  append(kind: JournalKind, row: unknown, at: string): Promise<number> {
    if (!isJournalKind(kind)) {
      throw new Error(`JsonlJournal.append: unknown kind '${String(kind)}'`);
    }
    if (row === undefined) {
      throw new Error('JsonlJournal.append: row must be JSON-representable (undefined is not)');
    }
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      throw new Error('JsonlJournal.append: `at` must be an ISO-8601 timestamp');
    }
    const seq = this._lastSeq + 1;
    this._lastSeq = seq;
    const entry: JournalEntry = { seq, kind, at, row };
    return this.enqueue(() => this.write(entry)).then(() => seq);
  }

  /**
   * The durability barrier: drains every queued write, then fsyncs the
   * handle. A journal that has never written anything has no barrier to
   * satisfy (and no file to sync) — flush is then a no-op.
   */
  async flush(): Promise<void> {
    return this.enqueue(() => this.syncHandle());
  }

  /**
   * Release the file handle (clean shutdown). A later append simply reopens
   * lazily and continues the sequence — close is not an end-of-life mark.
   */
  async close(): Promise<void> {
    return this.enqueue(async () => {
      if (this.handle !== null) {
        await this.handle.close();
        this.handle = null;
      }
    });
  }

  /** Chain an operation after every previously queued operation. */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.tail.then(op, op); // run regardless of a predecessor's outcome
    this.tail = next.then(
      () => undefined,
      () => undefined, // one failed append must not poison the queue
    );
    return next;
  }

  private async write(entry: JournalEntry): Promise<void> {
    const handle = await this.ensureOpen();
    await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** Lazy open: create the directory (graceful boot) then the file in append mode. */
  private async ensureOpen(): Promise<FileHandle> {
    if (this.handle !== null) return this.handle;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.handle = await open(this.filePath, 'a');
    return this.handle;
  }

  private async syncHandle(): Promise<void> {
    if (this.handle === null) return; // nothing ever written — the barrier is trivially satisfied
    await this.handle.sync();
  }
}

/** Structural validity of a sequence number as it appears inside an entry. */
export const isValidSeq = (raw: unknown): raw is number => isSeq(raw);
