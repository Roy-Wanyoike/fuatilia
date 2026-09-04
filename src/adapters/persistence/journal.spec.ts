/**
 * JsonlJournal specs (issue #61, F32) — the write half of the file-backed
 * AuthStore. These cover the wire format (one entry per line), the sequence
 * contract (monotonic, continues across `adopt`, strict even under a
 * concurrent storm), the durability barrier (`flush`), the boot adoption
 * path, and the argument validation (a rejected append never burns a seq).
 *
 * All filesystem work runs in a fresh `os.tmpdir()` directory per test; no
 * sleeps — every assertion awaits the store/journal promises.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlJournal, JOURNAL_KINDS, type JournalEntry } from './journal';

const T0 = '2026-03-01T08:00:00.000Z';

let dir: string;

const freshDir = async (): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), 'fuatilia-journal-'));
  return dir;
};

const readJournal = async (journal: JsonlJournal): Promise<string> =>
  readFile(journal.path, 'utf8');

const parseLines = (raw: string): JournalEntry[] =>
  raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as JournalEntry);

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined as unknown as string;
});

describe('JsonlJournal — append format and sequence', () => {
  it('assigns strictly increasing sequence numbers starting at 1', async () => {
    const journal = new JsonlJournal(await freshDir());
    const seqs: number[] = [];
    for (let i = 0; i < 5; i++) {
      seqs.push(await journal.append('user', { n: i }, T0));
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect(journal.lastSeq).toBe(5);
    await journal.close();
  });

  it('writes exactly one JSON line per entry carrying the v1 envelope (seq/kind/at/row)', async () => {
    const journal = new JsonlJournal(await freshDir());
    await journal.append('user', { userId: 'u-1' }, T0);
    await journal.append('event', { name: 'auth.userCreated' }, T0);

    const raw = await readJournal(journal);
    const entries = parseLines(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ seq: 1, kind: 'user', at: T0, row: { userId: 'u-1' } });
    expect(entries[1]).toEqual({ seq: 2, kind: 'event', at: T0, row: { name: 'auth.userCreated' } });
    // the trailing newline is the commit mark — every line is newline-terminated
    expect(raw.endsWith('\n')).toBe(true);
    await journal.close();
  });

  it('a concurrent append storm never interleaves lines (queue serialization)', async () => {
    const journal = new JsonlJournal(await freshDir());
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => journal.append('event', { i }, T0)),
    );
    await journal.flush();

    const entries = parseLines(await readJournal(journal));
    expect(entries).toHaveLength(50);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(entries.map((e) => (e.row as { i: number }).i)).toEqual(
      Array.from({ length: 50 }, (_, i) => i),
    );
    await journal.close();
  });

  it('rejects unknown kinds, undefined rows and bad stamps WITHOUT burning a sequence slot', async () => {
    const journal = new JsonlJournal(await freshDir());
    await journal.append('user', { ok: true }, T0);
    expect(journal.lastSeq).toBe(1);

    expect(() => journal.append('nope' as never, {}, T0)).toThrow();
    expect(() => journal.append('user', undefined, T0)).toThrow();
    expect(() => journal.append('user', {}, 'not-a-date')).toThrow();
    expect(journal.lastSeq).toBe(1); // the rejected calls burned nothing

    const seq = await journal.append('user', { ok: true }, T0);
    expect(seq).toBe(2); // continuity preserved
    await journal.close();
  });
});

describe('JsonlJournal — durability and lifecycle', () => {
  it('flush() is the durability barrier: after it resolves every appended line is readable', async () => {
    const journal = new JsonlJournal(await freshDir());
    for (let i = 0; i < 10; i++) journal.append('event', { i }, T0); // deliberately unawaited
    await journal.flush();

    const entries = parseLines(await readJournal(journal));
    expect(entries).toHaveLength(10);
    await journal.close();
  });

  it('flush() on a never-written journal is a trivially satisfied no-op', async () => {
    const journal = new JsonlJournal(await freshDir());
    await expect(journal.flush()).resolves.toBeUndefined();
    await journal.close();
  });

  it('close() releases the handle; a later append reopens lazily and continues the sequence', async () => {
    const journal = new JsonlJournal(await freshDir());
    await journal.append('user', { round: 1 }, T0);
    await journal.close();

    const seq = await journal.append('user', { round: 2 }, T0);
    expect(seq).toBe(2);
    const entries = parseLines(await readJournal(journal));
    expect(entries).toHaveLength(2);
    await journal.close();
  });

  it('creates a missing directory on first write (graceful boot)', async () => {
    const base = await freshDir();
    const nested = join(base, 'does', 'not', 'exist');
    const journal = new JsonlJournal(nested);
    await journal.append('user', { created: true }, T0);
    const entries = parseLines(await readFile(join(nested, 'journal.jsonl'), 'utf8'));
    expect(entries).toHaveLength(1);
    await journal.close();
  });
});

describe('JsonlJournal — adopt() (boot sequence continuation)', () => {
  it('continues the on-disk sequence after a replayed high-water mark', async () => {
    const journal = new JsonlJournal(await freshDir());
    journal.adopt(7);
    expect(journal.lastSeq).toBe(7);
    const seq = await journal.append('user', {}, T0);
    expect(seq).toBe(8); // sequence numbers continue, never restart
    await journal.close();
  });

  it('adopting a lower mark is a no-op (monotonic by construction)', () => {
    const journal = new JsonlJournal('/tmp/fuatilia-adopt-monotonic');
    journal.adopt(5);
    journal.adopt(3);
    expect(journal.lastSeq).toBe(5);
  });

  it('rejects negative and non-integer marks', () => {
    const journal = new JsonlJournal('/tmp/fuatilia-adopt-invalid');
    expect(() => journal.adopt(-1)).toThrow();
    expect(() => journal.adopt(1.5)).toThrow();
    expect(() => journal.adopt(Number.NaN)).toThrow();
  });
});

describe('JsonlJournal — construction contract', () => {
  it('requires a non-blank directory and a plain filename', () => {
    expect(() => new JsonlJournal('')).toThrow();
    expect(() => new JsonlJournal('   ')).toThrow();
    expect(() => new JsonlJournal('/tmp/ok', 'sub/dir/file.jsonl')).toThrow();
    expect(() => new JsonlJournal('/tmp/ok', '')).toThrow();
  });

  it('exposes the resolved path and the canonical filename constant', async () => {
    const base = await freshDir();
    const journal = new JsonlJournal(base);
    expect(journal.path).toBe(join(base, 'journal.jsonl'));
    expect(JOURNAL_KINDS).toEqual(['user', 'role', 'grant', 'key', 'session', 'event']);
    await journal.close();
  });
});
