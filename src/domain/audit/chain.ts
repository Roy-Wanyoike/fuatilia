/**
 * Tamper-evident hash chain (issue #53, SPEC §37 "append-only").
 *
 * Append-only stops the application from rewriting the trail; the hash
 * chain stops ANYONE (a compromised admin, a stray migration, a corrupted
 * row) from doing it undetected:
 *
 *     recordHash = H(prevHash ‖ canonical(record))
 *
 *   - `H` is the INJECTED hash port (`AuditHashPort`) — the domain owns the
 *     chaining contract, the adapter owns cryptography (the auth/apikeys
 *     `SecretCodec` precedent; no crypto import ever appears here). A port
 *     that is not a function — or that returns junk — is refused with
 *     AUDIT_HASH_PORT_INVALID, never stored.
 *   - `canonical(record)` is DETERMINISTIC canonical JSON: object keys
 *     sorted recursively (arrays keep their order), no whitespace, JSON
 *     string escapes — so the same record hashes bit-for-bit anywhere,
 *     regardless of key insertion order. No RNG, no wall clock in the input.
 *   - each record carries `prevRecordHash` (null for the trail's genesis
 *     record); the GENESIS hash input uses the all-zeros anchor so the
 *     hashed string is always total.
 *   - canonicalization EXCLUDES `recordHash` itself (that would be circular)
 *     and covers the REDACTED snapshots only — because the builder redacts
 *     before hashing and the sink re-redacts before storing, the chain
 *     attests exactly what was persisted. A redaction "bypass" that hashed
 *     the raw form would verify against nothing.
 *
 * `verifyChain` walks a full trail from its genesis record and returns
 * DECISION VALUES (stable AUDIT_CHAIN_BROKEN evidence, never an exception):
 *   - RECORD_HASH_MISMATCH — a stored field was mutated in place;
 *   - PREV_HASH_MISMATCH — a record was removed or reordered (the survivor's
 *     back-link no longer resolves);
 *   - GENESIS_INVALID — the trail does not start at a genesis record;
 *   - HASH_FIELD_MALFORMED — the chain fields themselves were clobbered;
 *   - LENGTH_MISMATCH / HEAD_MISMATCH — truncation against the caller's
 *     externally-anchored expectation. Honest limit: hash chains cannot see
 *     TAIL truncation from the inside (a surviving prefix is internally
 *     consistent — genesis-drop and mid-chain removal ARE caught, the
 *     survivor still claims its predecessor); anchoring the expected
 *     length/head hash (e.g. from the last external audit) closes the gap.
 *     The tests pin both the catch and the limit.
 */
import { DomainError, type Clock } from '../shared';
import {
  assertAuditClock,
  assertRecordShape,
  buildAuditDraft,
  type AppendAuditInput,
  type AuditRecord,
  type AuditSink,
} from './record';
import { redactSnapshot } from './redact';
import { recordAppendedEvent, type RecordAppendedEvent } from './events';

/** The injected hash port — adapters bind SHA-256 here; tests bind a fake. */
export type AuditHashPort = (input: string) => string;

/** Anchor for the trail's first record (production adapters: 64 hex zeros for SHA-256). */
export const GENESIS_PREV_HASH = '0'.repeat(64);

const MAX_HASH_LENGTH = 256;

/** Guard the injected port: it must be a function (the apikeys codec precedent). */
export const assertHashPort = (hash: AuditHashPort): AuditHashPort => {
  if (!hash || typeof hash !== 'function') {
    throw new DomainError('AUDIT_HASH_PORT_INVALID', `the injected hash port must be a function, got ${typeof hash}`);
  }
  return hash;
};

const useHash = (hash: AuditHashPort, input: string): string => {
  const out = hash(input);
  if (typeof out !== 'string' || out.length === 0 || out.length > MAX_HASH_LENGTH) {
    throw new DomainError(
      'AUDIT_HASH_PORT_INVALID',
      `the injected hash port returned ${typeof out === 'string' ? `junk ("${out.slice(0, 32)}…")` : typeof out} — refused, never stored`,
    );
  }
  return out;
};

const assertHashString = (raw: unknown, field: 'recordHash' | 'prevRecordHash'): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_HASH_LENGTH) {
    throw new DomainError('AUDIT_HASH_MALFORMED', `${field} must be a non-empty string of at most ${MAX_HASH_LENGTH} chars`);
  }
  return raw;
};

// --- canonical JSON ---------------------------------------------------------------------

/** Canonical JSON: recursively key-sorted, no whitespace, lossless for validated records. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new DomainError('AUDIT_SNAPSHOT_INVALID', `non-finite number ${String(value)} cannot be canonicalized`);
      }
      return String(value);
    default: {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, member]) => member !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
      }
      throw new DomainError('AUDIT_SNAPSHOT_INVALID', `value of type ${typeof value} cannot be canonicalized`);
    }
  }
}

/** The canonical form hashed into `recordHash`: the record MINUS `recordHash` itself. */
export const canonicalAuditRecord = (record: AuditRecord): string => {
  const { recordHash: _omitted, ...rest } = record;
  void _omitted;
  return canonicalJson(rest);
};

/** H(prevHash ‖ canonical(record)) — the ‖ is plain concatenation. */
export const chainHash = (prevHash: string | null, record: AuditRecord, hash: AuditHashPort): string =>
  useHash(hash, `${prevHash ?? GENESIS_PREV_HASH}${canonicalAuditRecord(record)}`);

// --- the append path ---------------------------------------------------------------------

export interface AppendedAudit {
  /** The stored record — redacted, chain-stamped, frozen. */
  readonly record: AuditRecord;
  /** `audit.recordAppended` — the narrow companion fact (no snapshots inside). */
  readonly event: RecordAppendedEvent;
}

/**
 * THE append path. Order is the integrity story:
 *   1. validate + stamp (pinned occurredAt or the injected Clock, read once);
 *   2. REDACT the state snapshots (`buildAuditDraft`);
 *   3. chain-stamp: hash the REDACTED draft over the previous record's hash;
 *   4. hand the frozen record to the sink (which re-validates + re-redacts —
 *      a no-op here, the whole point there) and emit `audit.recordAppended`
 *      at the record's own instant.
 *
 * `prev` is the trail's current head record (null for the first record of a
 * trail). Passing it explicitly keeps this function PURE — no hidden chain
 * state, no read API on the port, so append-only survives untouched.
 *
 * Throws (caller bugs): every stable code from the builder, plus
 * AUDIT_HASH_PORT_INVALID / AUDIT_HASH_MALFORMED.
 */
export function appendAuditRecord(
  sink: AuditSink,
  hash: AuditHashPort,
  prev: AuditRecord | null,
  input: AppendAuditInput,
  clock: Clock,
): AppendedAudit {
  assertHashPort(hash);
  assertAuditClock(clock);
  const draft = buildAuditDraft(input, clock); // 1 + 2
  const prevRecordHash = prev === null ? null : assertHashString(prev.recordHash, 'prevRecordHash');
  const unhashed = { ...draft, prevRecordHash, recordHash: '' } as AuditRecord; // recordHash excluded from its own hash
  const record: AuditRecord = Object.freeze({ ...unhashed, recordHash: chainHash(prevRecordHash, unhashed, hash) }); // 3
  assertRecordShape(record);
  const stored = sink.append(record); // 4
  const event = recordAppendedEvent(stored, { now: () => new Date(stored.occurredAt) });
  return { record: stored, event };
}

// --- verification -------------------------------------------------------------------------

/** Externally anchored expectations — closes the truncation gap (see module docs). */
export interface ChainExpectation {
  readonly length?: number;
  readonly headHash?: string;
}

export type ChainBreakReason =
  | 'GENESIS_INVALID'
  | 'PREV_HASH_MISMATCH'
  | 'RECORD_HASH_MISMATCH'
  | 'HASH_FIELD_MALFORMED'
  | 'LENGTH_MISMATCH'
  | 'HEAD_MISMATCH';

export type ChainVerification =
  | { readonly ok: true; readonly length: number; readonly headHash: string | null }
  | {
      readonly ok: false;
      /** Stable evidence code — machine-matchable, per issue #53. */
      readonly code: 'AUDIT_CHAIN_BROKEN';
      /** Index of the first broken record; -1 for trail-level (length/head) breaks. */
      readonly index: number;
      readonly reason: ChainBreakReason;
      readonly detail: string;
    };

const broken = (index: number, reason: ChainBreakReason, detail: string): ChainVerification => ({
  ok: false,
  code: 'AUDIT_CHAIN_BROKEN',
  index,
  reason,
  detail,
});

/**
 * Verify a full trail (genesis first). Read-only: never mutates, never
 * throws for a broken trail — the break IS the result (stable evidence).
 * Re-hashing runs over the REDACTED snapshots, so verification attests the
 * exact form the sink persisted.
 */
export function verifyChain(
  records: readonly AuditRecord[],
  hash: AuditHashPort,
  expected?: ChainExpectation,
): ChainVerification {
  assertHashPort(hash);
  if (expected?.length !== undefined && (!Number.isInteger(expected.length) || expected.length < 0)) {
    throw new DomainError(
      'AUDIT_FILTER_INVALID',
      `expected.length must be a non-negative integer, got ${String(expected.length)}`,
    );
  }
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (!record || typeof record !== 'object') {
      return broken(i, 'HASH_FIELD_MALFORMED', `trail entry ${i} is not an object`);
    }
    if (typeof record.recordHash !== 'string' || record.recordHash.length === 0 || record.recordHash.length > MAX_HASH_LENGTH) {
      return broken(i, 'HASH_FIELD_MALFORMED', `record ${String(record.auditId)} has a malformed recordHash`);
    }
    if (i === 0 && record.prevRecordHash !== null) {
      return broken(0, 'GENESIS_INVALID', 'the trail must start at a genesis record (prevRecordHash === null)');
    }
    if (i > 0) {
      const prev = records[i - 1]!;
      if (record.prevRecordHash !== prev.recordHash) {
        return broken(
          i,
          'PREV_HASH_MISMATCH',
          `record ${String(record.auditId)} links to ${String(record.prevRecordHash)}, but the previous stored hash is ${String(prev.recordHash)} — a record was removed or reordered`,
        );
      }
    }
    const redacted: AuditRecord = {
      ...record,
      previousState: record.previousState === null ? null : (redactSnapshot(record.previousState) as AuditRecord['previousState']),
      newState: record.newState === null ? null : (redactSnapshot(record.newState) as AuditRecord['newState']),
    };
    const recomputed = chainHash(record.prevRecordHash, redacted, hash);
    if (recomputed !== record.recordHash) {
      return broken(
        i,
        'RECORD_HASH_MISMATCH',
        `record ${String(record.auditId)} does not match its hash — the record was mutated after append`,
      );
    }
  }
  if (expected?.length !== undefined && records.length !== expected.length) {
    return broken(-1, 'LENGTH_MISMATCH', `trail holds ${records.length} records, expected ${expected.length} — records were truncated`);
  }
  const headHash = records.length === 0 ? null : records[records.length - 1]!.recordHash;
  if (expected?.headHash !== undefined && headHash !== expected.headHash) {
    return broken(-1, 'HEAD_MISMATCH', `trail head ${String(headHash)} does not match the anchored head ${expected.headHash} — tail records are missing`);
  }
  return { ok: true, length: records.length, headHash };
}
