/**
 * Persistence lane — file-backed AuthStore (issue #61, F32).
 *
 * The first real persistence adapter behind the HTTP kernel's store seam:
 * an append-only JSONL journal as the source of truth, crash-atomic
 * tmp+rename snapshots as a boot optimization, and deterministic replay on
 * boot. Zero npm dependencies — `node:fs/promises` + `node:path` only
 * (declared ambiently in ./node-runtime.d.ts, per the HTTP lane's precedent).
 *
 * Composition:
 *
 *   import { createFileAuthStore } from './adapters/persistence';
 *   const store = createFileAuthStore('/var/lib/fuatilia/auth');
 *   await store.load();                      // snapshot + journal tail
 *   const kernel = createHttpKernel({ store }); // the seam stays untouched
 *
 * `load()`'s report ({ lines, applied, quarantined }) makes journal damage
 * visible at boot: corrupt/truncated/unknown lines are quarantined, never
 * thrown, and never poison earlier lines.
 */
import { FileAuthStore, type FileAuthStoreOptions } from './filestore';

/** The public factory: a file-backed AuthStore over one directory. */
export const createFileAuthStore = (dir: string, options: FileAuthStoreOptions = {}): FileAuthStore =>
  new FileAuthStore(dir, options);

export { FileAuthStore, type FileAuthStoreOptions, JOURNAL_FILENAME, SNAPSHOT_FILENAME, SNAPSHOT_TMP_FILENAME } from './filestore';
export { JsonlJournal, JOURNAL_KINDS, isJournalKind, isValidSeq, type JournalEntry, type JournalKind } from './journal';
export {
  emptyReplayState,
  parseSnapshot,
  replayJournal,
  SNAPSHOT_FORMAT,
  type LoadReport,
  type ParsedSnapshot,
  type ReplayOptions,
  type ReplayResult,
  type ReplayState,
} from './replay';
