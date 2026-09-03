import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { createInMemoryAuditSink, type AuditRecord } from './record';
import {
  appendAuditRecord,
  canonicalAuditRecord,
  canonicalJson,
  chainHash,
  GENESIS_PREV_HASH,
  verifyChain,
  type AuditHashPort,
  type ChainVerification,
} from './chain';

// --- fixtures -----------------------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(401);
const USER = uid(410);

const T0 = Date.parse('2026-03-01T08:00:00.000Z');
const clockAt = (ms: number): Clock => ({ now: () => new Date(ms) });

/** Deterministic fake hash port — a 64-bit FNV-1a double round; the domain never imports crypto. */
const fnv = (offset: number, input: string): string => {
  let h = offset >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};
const fakeHash: AuditHashPort = (input) => `${fnv(0x811c9dc5, input)}${fnv(0x01935525, input)}`;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

/** Build an n-record chained trail on a fresh sink (one fact per minute, deterministic). */
const buildTrail = (n: number): { sink: ReturnType<typeof createInMemoryAuditSink>; records: AuditRecord[] } => {
  // the sink's clock sits one minute past the last record — the future-check gate, satisfied
  const sink = createInMemoryAuditSink(clockAt(T0 + (n + 1) * 60_000));
  const records: AuditRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    const { record } = appendAuditRecord(
      sink,
      fakeHash,
      records[records.length - 1] ?? null,
      {
        auditId: uid(500 + i),
        orgId: ORG,
        actor: { kind: 'user', id: USER, orgId: ORG },
        action: i === 0 ? 'create' : 'update',
        entityType: 'receivable',
        entityId: uid(450),
        requestId: `req-${i}`,
        previousState: i === 0 ? null : { balanceMinor: (i - 1) * 100 },
        newState: { balanceMinor: i * 100 },
      },
      clockAt(T0 + i * 60_000),
    );
    records.push(record);
  }
  return { sink, records };
};

const expectBroken = (result: ChainVerification, index: number, reason: string): void => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected the chain to be broken');
  expect(result.code).toBe('AUDIT_CHAIN_BROKEN');
  expect(result.index).toBe(index);
  expect(result.reason).toBe(reason);
};

// --- canonical JSON + hashing --------------------------------------------------------------

describe('canonicalJson — deterministic canonical form (no RNG, key order irrelevant)', () => {
  it('sorts keys recursively; arrays keep their order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { i: 9, h: 8 }] } })).toBe(
      '{"a":{"c":[3,{"h":8,"i":9}],"d":2},"b":1}',
    );
  });

  it('the same record assembled with different key insertion order hashes identically', () => {
    const one = { auditId: 'a', orgId: 'o', actor: { id: 'u', kind: 'user' }, state: { y: 2, x: 1 } };
    const two = { state: { x: 1, y: 2 }, actor: { kind: 'user', id: 'u' }, orgId: 'o', auditId: 'a' };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
    expect(canonicalAuditRecord(one as unknown as AuditRecord)).toBe(
      canonicalAuditRecord(two as unknown as AuditRecord),
    );
  });

  it('canonicalAuditRecord excludes recordHash itself (no circular hashing)', () => {
    const { records } = buildTrail(1);
    const withFakeHash = { ...records[0]!, recordHash: 'completely-different' };
    expect(canonicalAuditRecord(withFakeHash)).toBe(canonicalAuditRecord(records[0]!));
  });

  it('chainHash uses the genesis anchor for null prev, the previous hash afterwards', () => {
    const { records } = buildTrail(2);
    expect(records[0]!.prevRecordHash).toBeNull();
    expect(records[0]!.recordHash).toBe(chainHash(null, records[0]!, fakeHash));
    expect(records[1]!.prevRecordHash).toBe(records[0]!.recordHash);
    expect(records[1]!.recordHash).toBe(chainHash(records[0]!.recordHash, records[1]!, fakeHash));
    expect(fakeHash(`${GENESIS_PREV_HASH}${canonicalAuditRecord(records[0]!)}`)).toBe(records[0]!.recordHash);
  });
});

// --- the append path ---------------------------------------------------------------------------

describe('appendAuditRecord — chain-stamped appends', () => {
  it('appends are verifiable end-to-end over a 5-record trail', () => {
    const { records } = buildTrail(5);
    const result = verifyChain(records, fakeHash);
    expect(result).toEqual({ ok: true, length: 5, headHash: records[4]!.recordHash });
  });

  it('hash-port refusals — junk ports are programming errors, never stored', () => {
    const sink = createInMemoryAuditSink(clockAt(T0));
    const input = {
      auditId: uid(600),
      orgId: ORG,
      actor: { kind: 'user', id: USER, orgId: ORG },
      action: 'create',
      entityType: 'receivable',
      entityId: uid(601),
      requestId: 'req-x',
    } as Parameters<typeof appendAuditRecord>[3];
    expectCode(() => appendAuditRecord(sink, undefined as unknown as AuditHashPort, null, input, clockAt(T0)), 'AUDIT_HASH_PORT_INVALID');
    expectCode(() => appendAuditRecord(sink, (() => 42) as unknown as AuditHashPort, null, input, clockAt(T0)), 'AUDIT_HASH_PORT_INVALID');
    expectCode(() => appendAuditRecord(sink, () => '' as string, null, input, clockAt(T0)), 'AUDIT_HASH_PORT_INVALID');
    expect(sink.size()).toBe(0);
  });

  it('a broken head record is refused before linking (AUDIT_HASH_MALFORMED)', () => {
    const { records } = buildTrail(1);
    const damaged = { ...records[0]!, recordHash: '   ' };
    expectCode(
      () =>
        appendAuditRecord(
          createInMemoryAuditSink(clockAt(T0)),
          fakeHash,
          damaged,
          {
            auditId: uid(610),
            orgId: ORG,
            actor: { kind: 'user', id: USER, orgId: ORG },
            action: 'update',
            entityType: 'receivable',
            entityId: uid(450),
            requestId: 'req-y',
          },
          clockAt(T0),
        ),
      'AUDIT_HASH_MALFORMED',
    );
  });
});

// --- tamper detection tables ----------------------------------------------------------------------

describe('verifyChain — mutation/removal/reordering detection (stable AUDIT_CHAIN_BROKEN evidence)', () => {
  it('an intact empty trail is vacuously ok', () => {
    expect(verifyChain([], fakeHash)).toEqual({ ok: true, length: 0, headHash: null });
  });

  it('mutation table: ANY in-place field edit breaks the hash at that index', () => {
    const mutations: Array<[string, (r: AuditRecord) => AuditRecord]> = [
      ['actor.id', (r) => ({ ...r, actor: { ...r.actor, id: uid(999) } })],
      ['action', (r) => ({ ...r, action: 'refund' })],
      ['occurredAt', (r) => ({ ...r, occurredAt: '2026-03-01T23:59:59.000Z' })],
      ['requestId', (r) => ({ ...r, requestId: 'forged-req' })],
      ['entityId', (r) => ({ ...r, entityId: uid(998) })],
      ['newState deep field', (r) => ({ ...r, newState: { balanceMinor: 1 } })],
      ['reason', (r) => ({ ...r, reason: 'retconned justification' })],
    ];
    for (const [label, mutate] of mutations) {
      const { records } = buildTrail(3);
      const tampered = records.map((r, i) => (i === 1 ? mutate(r) : r));
      const result = verifyChain(tampered, fakeHash);
      expectBroken(result, 1, 'RECORD_HASH_MISMATCH');
      expect(result.ok === false && result.detail).toContain('mutated after append');
      void label;
    }
  });

  it('a clobbered recordHash field is its own break reason (HASH_FIELD_MALFORMED)', () => {
    const { records } = buildTrail(2);
    const tampered = records.map((r, i) => (i === 1 ? { ...r, recordHash: '' } : r));
    expectBroken(verifyChain(tampered, fakeHash), 1, 'HASH_FIELD_MALFORMED');
  });

  it('removing a MIDDLE record breaks the survivor back-link (PREV_HASH_MISMATCH)', () => {
    const { records } = buildTrail(4);
    const removed = [records[0]!, records[1]!, records[3]!]; // r2 dropped
    expectBroken(verifyChain(removed, fakeHash), 2, 'PREV_HASH_MISMATCH');
  });

  it('reordering breaks the first mislinked record — swap table', () => {
    const { records } = buildTrail(4);
    expectBroken(verifyChain([records[0]!, records[2]!, records[1]!, records[3]!], fakeHash), 1, 'PREV_HASH_MISMATCH');
    // a non-genesis record at the head is caught as genesis-invalid (it claims a predecessor)
    expectBroken(verifyChain([records[1]!, records[0]!, records[2]!, records[3]!], fakeHash), 0, 'GENESIS_INVALID');
    const reversed = [...records].reverse();
    expectBroken(verifyChain(reversed, fakeHash), 0, 'GENESIS_INVALID'); // reordered trail no longer starts at genesis
  });

  it('a non-genesis first record is GENESIS_INVALID', () => {
    const { records } = buildTrail(2);
    expectBroken(verifyChain([records[1]!], fakeHash), 0, 'GENESIS_INVALID');
  });

  it('TAIL truncation is invisible inside the chain — the anchored expectation closes the gap', () => {
    const { records } = buildTrail(3);
    // honest limit, pinned: drop the TAIL record and the surviving prefix still verifies…
    expect(verifyChain([records[0]!, records[1]!], fakeHash)).toEqual({
      ok: true,
      length: 2,
      headHash: records[1]!.recordHash,
    });
    // …unless the caller anchors the expected length / head hash (e.g. from the last external audit):
    expectBroken(verifyChain([records[0]!, records[1]!], fakeHash, { length: 3 }), -1, 'LENGTH_MISMATCH');
    expectBroken(
      verifyChain([records[0]!, records[1]!], fakeHash, { headHash: records[2]!.recordHash }),
      -1,
      'HEAD_MISMATCH',
    );
    // anchored values that ARE satisfied verify clean:
    expect(verifyChain(records, fakeHash, { length: 3, headHash: records[2]!.recordHash }).ok).toBe(true);
  });

  it('dropping the GENESIS record is caught — the survivor still claims its predecessor', () => {
    const { records } = buildTrail(3);
    // r1.prevRecordHash still points at the dropped r0 → GENESIS_INVALID at the head:
    expectBroken(verifyChain([records[1]!, records[2]!], fakeHash), 0, 'GENESIS_INVALID');
    // even forging r1 into a new genesis cannot re-hash to its stored value (RECORD_HASH_MISMATCH):
    const forged: AuditRecord = { ...records[1]!, prevRecordHash: null };
    expectBroken(verifyChain([forged, records[2]!], fakeHash), 0, 'RECORD_HASH_MISMATCH');
  });

  it('verification never mutates its input and never throws for a broken trail', () => {
    const { records } = buildTrail(2);
    const snapshot = JSON.stringify(records);
    const result = verifyChain([{ ...records[1]!, action: 'cancel' }], fakeHash);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it('a malformed expectation is refused (AUDIT_FILTER_INVALID)', () => {
    const { records } = buildTrail(1);
    expectCode(() => verifyChain(records, fakeHash, { length: -1 }), 'AUDIT_FILTER_INVALID');
    expectCode(() => verifyChain(records, fakeHash, { length: 1.5 }), 'AUDIT_FILTER_INVALID');
  });

  it('redaction cannot sneak past the chain: verification attests the redacted stored form', () => {
    const sink = createInMemoryAuditSink(clockAt(T0));
    const { record } = appendAuditRecord(
      sink,
      fakeHash,
      null,
      {
        auditId: uid(700),
        orgId: ORG,
        actor: { kind: 'user', id: USER, orgId: ORG },
        action: 'update',
        entityType: 'receivable',
        entityId: uid(701),
        requestId: 'req-z',
        previousState: { password: 'hunter2', balanceMinor: 1 },
        newState: { token: 'tk-1', balanceMinor: 2 },
      },
      clockAt(T0),
    );
    expect(record.previousState).toEqual({ balanceMinor: 1 }); // stored redacted
    expect(JSON.stringify(sink.records())).not.toContain('hunter2');
    // …and the hash verifies over the redacted form, not the raw input:
    expect(verifyChain(sink.records(), fakeHash).ok).toBe(true);
  });
});
