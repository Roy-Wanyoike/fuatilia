import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  ACTOR_KINDS,
  AUDIT_ACTIONS,
  MAX_REASON_LENGTH,
  MAX_USER_AGENT_LENGTH,
  assertActor,
  buildAuditDraft,
  createInMemoryAuditSink,
} from './record';
import { appendAuditRecord, GENESIS_PREV_HASH, type AuditHashPort } from './chain';

// --- fixtures ---------------------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(301);
const USER = uid(310);
const AUD = uid(311);

const T0 = '2026-03-01T08:00:00.000Z';
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock = clockAt(T0);

/** Deterministic fake hash port — 64-bit FNV-1a double round; the domain never imports crypto. */
const fakeHash: AuditHashPort = (input) => {
  const fnv = (offset: number): string => {
    let h = offset >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01935525)}`;
};

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  auditId: AUD,
  orgId: ORG,
  actor: { kind: 'user', id: USER, orgId: ORG } as const,
  action: 'transition',
  entityType: 'receivable',
  entityId: uid(320),
  requestId: 'req-000001',
  ...overrides,
});

const append = (overrides: Record<string, unknown> = {}, prev: Parameters<typeof appendAuditRecord>[2] = null) =>
  appendAuditRecord(createInMemoryAuditSink(clock), fakeHash, prev, baseInput(overrides) as Parameters<typeof appendAuditRecord>[3], clock);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the record ----------------------------------------------------------------------------

describe('AuditRecord — every §37 field is representable', () => {
  it('builds a complete record: stamping, redaction, freezing, all §37 fields present', () => {
    const { record } = append({
      correlationId: 'corr-000123',
      ip: '197.232.64.10',
      userAgent: 'Mozilla/5.0 (FuatiliaWeb)',
      previousState: { status: 'open', balanceMinor: 1000 },
      newState: { status: 'overdue', balanceMinor: 1000 },
      reason: 'aging bucket flipped overnight',
      approval: { ref: 'appr-0001', approverId: USER, decidedAt: T0 },
      aiContext: { agentKind: 'collections-agent', evidenceRefs: ['ev-1', 'ev-2'] },
    });
    expect(record.auditId).toBe(AUD);
    expect(record.orgId).toBe(ORG);
    expect(record.actor).toEqual({ kind: 'user', id: USER, orgId: ORG });
    expect(record.action).toBe('transition');
    expect(record.entityType).toBe('receivable');
    expect(record.entityId).toBe(uid(320));
    expect(record.occurredAt).toBe(T0); // stamped from the injected Clock
    expect(record.requestId).toBe('req-000001');
    expect(record.correlationId).toBe('corr-000123');
    expect(record.ip).toBe('197.232.64.10');
    expect(record.userAgent).toBe('Mozilla/5.0 (FuatiliaWeb)');
    expect(record.previousState).toEqual({ status: 'open', balanceMinor: 1000 });
    expect(record.newState).toEqual({ status: 'overdue', balanceMinor: 1000 });
    expect(record.reason).toBe('aging bucket flipped overnight');
    expect(record.approval).toEqual({ ref: 'appr-0001', approverId: USER, decidedAt: T0 });
    expect(record.aiContext).toEqual({ agentKind: 'collections-agent', evidenceRefs: ['ev-1', 'ev-2'] });
    expect(record.prevRecordHash).toBeNull(); // genesis
    expect(typeof record.recordHash).toBe('string');
    expect(Object.isFrozen(record)).toBe(true);
  });

  it('optional fields normalize to null when absent — "not applicable" is explicit', () => {
    const { record } = append();
    expect(record.correlationId).toBeNull();
    expect(record.ip).toBeNull();
    expect(record.userAgent).toBeNull();
    expect(record.previousState).toBeNull();
    expect(record.newState).toBeNull();
    expect(record.reason).toBeNull();
    expect(record.approval).toBeNull();
    expect(record.aiContext).toBeNull();
  });

  it('accepts null AND undefined for every optional field (same meaning)', () => {
    for (const nil of [undefined, null]) {
      const { record } = append({
        correlationId: nil,
        ip: nil,
        userAgent: nil,
        previousState: nil,
        newState: nil,
        reason: nil,
        approval: nil,
        aiContext: nil,
      });
      expect(record.correlationId).toBeNull();
      expect(record.previousState).toBeNull();
      expect(record.approval).toBeNull();
      expect(record.aiContext).toBeNull();
    }
  });

  it('the closed action vocabulary accepts exactly its 16 verbs — table over all of them', () => {
    expect(AUDIT_ACTIONS).toHaveLength(16);
    for (const action of AUDIT_ACTIONS) {
      const { record } = append({ action });
      expect(record.action).toBe(action);
    }
    expect([...AUDIT_ACTIONS]).toEqual([
      'create', 'update', 'transition', 'cancel', 'reverse', 'write_off', 'refund', 'issue',
      'revoke', 'approve', 'send', 'ingest', 'settle', 'redeem', 'access', 'login',
    ]);
  });

  it('all four actor kinds are representable — system carries null actor.orgId', () => {
    expect(ACTOR_KINDS).toEqual(['user', 'apiKey', 'agent', 'system']);
    for (const kind of ACTOR_KINDS) {
      const actor = kind === 'system' ? { kind, id: 'platform:late-fee-sweeper', orgId: null } : { kind, id: uid(330), orgId: ORG };
      const { record } = append({ actor });
      expect(record.actor.kind).toBe(kind);
    }
  });

  it('aiContext makes AI actions auditable (agentKind + evidenceRefs) — §37 AI clause', () => {
    const { record } = append({
      actor: { kind: 'agent', id: uid(331), orgId: ORG },
      action: 'send',
      aiContext: { agentKind: 'dunning-nba', evidenceRefs: ['ev-a', 'ev-b', 'ev-c'] },
    });
    expect(record.actor.kind).toBe('agent');
    expect(record.aiContext).toEqual({ agentKind: 'dunning-nba', evidenceRefs: ['ev-a', 'ev-b', 'ev-c'] });
  });
});

// --- validation tables ------------------------------------------------------------------------

describe('buildAuditDraft — validation table (deny-by-default, stable codes)', () => {
  it('field refusals', () => {
    expectCode(() => append({ orgId: '   ' }), 'AUDIT_ORG_REQUIRED');
    expectCode(() => append({ action: 'nuke' }), 'AUDIT_ACTION_INVALID');
    expectCode(() => append({ action: 42 }), 'AUDIT_ACTION_INVALID');
    expectCode(() => append({ actor: { kind: 'superuser', id: 'x', orgId: ORG } }), 'AUDIT_ACTOR_INVALID');
    expectCode(() => append({ actor: { kind: 'user', id: '  ', orgId: ORG } }), 'AUDIT_ACTOR_INVALID');
    expectCode(() => append({ actor: { kind: 'user', id: USER, orgId: null } }), 'AUDIT_ACTOR_INVALID');
    expectCode(() => append({ actor: { kind: 'system', id: 'platform', orgId: ORG } }), 'AUDIT_ACTOR_INVALID');
    expectCode(() => append({ entityType: '' }), 'AUDIT_ENTITY_TYPE_REQUIRED');
    expectCode(() => append({ entityId: '  ' }), 'AUDIT_ENTITY_ID_REQUIRED');
    expectCode(() => append({ requestId: '' }), 'AUDIT_REQUEST_ID_REQUIRED');
    expectCode(() => append({ correlationId: '  ' }), 'AUDIT_CORRELATION_ID_INVALID');
    expectCode(() => append({ ip: '' }), 'AUDIT_IP_MALFORMED');
    expectCode(() => append({ userAgent: 'x'.repeat(MAX_USER_AGENT_LENGTH + 1) }), 'AUDIT_USER_AGENT_MALFORMED');
    expectCode(() => append({ reason: 'y'.repeat(MAX_REASON_LENGTH + 1) }), 'AUDIT_REASON_MALFORMED');
  });

  it('approval refusals — the bundle is validated, not taken on faith', () => {
    expectCode(() => append({ approval: { ref: '  ', approverId: null, decidedAt: null } }), 'AUDIT_APPROVAL_INVALID');
    expectCode(() => append({ approval: { ref: 'appr-1', approverId: USER, decidedAt: 'March 1st' } }), 'AUDIT_APPROVAL_INVALID');
    expect(append({ approval: { ref: 'appr-1', approverId: null, decidedAt: null } }).record.approval).toEqual({
      ref: 'appr-1',
      approverId: null,
      decidedAt: null,
    });
  });

  it('aiContext refusals — an auditable AI action names its kind and its evidence', () => {
    expectCode(() => append({ aiContext: { agentKind: '  ', evidenceRefs: ['ev-1'] } }), 'AUDIT_AI_CONTEXT_INVALID');
    expectCode(() => append({ aiContext: { agentKind: 'nba', evidenceRefs: 'ev-1' } }), 'AUDIT_AI_CONTEXT_INVALID');
    expectCode(() => append({ aiContext: { agentKind: 'nba', evidenceRefs: ['ev-1', '   '] } }), 'AUDIT_AI_CONTEXT_INVALID');
  });

  it('snapshot refusals — only losslessly-hashable state may be recorded', () => {
    expectCode(() => append({ previousState: 'status=open' }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => append({ previousState: ['array'] }), 'AUDIT_SNAPSHOT_INVALID');
    expectCode(() => append({ newState: { x: undefined } }), 'AUDIT_SNAPSHOT_INVALID');
    const cyclic: Record<string, unknown> = { status: 'open' };
    cyclic.self = cyclic;
    expectCode(() => append({ newState: cyclic }), 'AUDIT_SNAPSHOT_INVALID');
  });

  it('clock refusals — a broken injected clock is a programming error', () => {
    expectCode(() => appendAuditRecord(createInMemoryAuditSink(clock), fakeHash, null, baseInput() as Parameters<typeof appendAuditRecord>[3], {} as unknown as Clock), 'AUDIT_CLOCK_INVALID');
    expectCode(
      () =>
        appendAuditRecord(
          createInMemoryAuditSink(clock),
          fakeHash,
          null,
          baseInput() as Parameters<typeof appendAuditRecord>[3],
          { now: () => new Date('not-a-date') },
        ),
      'AUDIT_CLOCK_INVALID',
    );
  });

  it('a pinned occurredAt must be ISO-8601; a valid one is honored verbatim', () => {
    expectCode(() => append({ occurredAt: 'yesterday' }), 'AUDIT_OCCURRED_AT_INVALID');
    const pinned = '2026-02-28T23:59:59.999Z';
    expect(append({ occurredAt: pinned }).record.occurredAt).toBe(pinned);
  });

  it('the append path redacts BEFORE anything else sees the state (bypass impossible, chain covers redacted form)', () => {
    const { record } = append({
      previousState: { password: 'hunter2', balanceMinor: 100 },
      newState: { apiKey: 'ak-123456', status: 'open' },
    });
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(JSON.stringify(record)).not.toContain('ak-123456');
    expect(record.previousState).toEqual({ balanceMinor: 100 });
    expect(record.newState).toEqual({ status: 'open' });
  });
});

// --- the sink -----------------------------------------------------------------------------------

describe('createInMemoryAuditSink — deterministic, Clock-injected, append-only', () => {
  it('exposes only append + read-only views — no update/delete capability exists (type-level guarantee, pinned at runtime)', () => {
    const sink = createInMemoryAuditSink(clock);
    expect(Object.keys(sink).sort()).toEqual(['append', 'records', 'size']);
    expect(sink.size()).toBe(0);
    expect(sink.records()).toEqual([]);
  });

  it('stores frozen records in append order and returns exactly what was stored', () => {
    const sink = createInMemoryAuditSink(clock);
    const first = appendAuditRecord(sink, fakeHash, null, baseInput() as Parameters<typeof appendAuditRecord>[3], clock).record;
    const second = appendAuditRecord(sink, fakeHash, first, baseInput({ auditId: uid(312), action: 'update' }) as Parameters<typeof appendAuditRecord>[3], clock).record;
    expect(sink.size()).toBe(2);
    expect(sink.records()).toEqual([first, second]);
    expect(sink.records()[0]).toBe(first); // same frozen instance
    expect(Object.isFrozen(sink.records())).toBe(true);
  });

  it('refuses a duplicate auditId — audit ids are unique forever (AUDIT_AUDIT_ID_TAKEN)', () => {
    const sink = createInMemoryAuditSink(clock);
    const { record } = appendAuditRecord(sink, fakeHash, null, baseInput() as Parameters<typeof appendAuditRecord>[3], clock);
    expectCode(
      () =>
        appendAuditRecord(
          sink,
          fakeHash,
          record,
          baseInput({ entityId: uid(321) }) as Parameters<typeof appendAuditRecord>[3],
          clock,
        ),
      'AUDIT_AUDIT_ID_TAKEN',
    );
  });

  it('refuses future-dated records at the boundary — the trail never records the future', () => {
    const sink = createInMemoryAuditSink(clock);
    const build = (occurredAt: string, id: number) =>
      appendAuditRecord(sink, fakeHash, null, baseInput({ occurredAt, auditId: uid(id) }) as Parameters<typeof appendAuditRecord>[3], clock);
    expectCode(() => build('2026-03-01T08:00:00.001Z', 340), 'AUDIT_OCCURRED_AT_FUTURE'); // 1ms past the clock → refused
    expect(build(T0, 341).record.occurredAt).toBe(T0); // exactly at the clock → allowed (inclusive)
    expect(build('2026-03-01T07:59:59.999Z', 342).record.occurredAt).toBe('2026-03-01T07:59:59.999Z');
  });

  it('RE-redacts on direct append — bypassing the chain helper still cannot persist a secret', () => {
    const sink = createInMemoryAuditSink(clock);
    const { record } = appendAuditRecord(
      sink,
      fakeHash,
      null,
      baseInput({
        newState: { authorization: 'Bearer abc', status: 'open', amountMinor: 5 },
      }) as Parameters<typeof appendAuditRecord>[3],
      clock,
    );
    expect(record.newState).toEqual({ status: 'open', amountMinor: 5 });
    expect(JSON.stringify(sink.records())).not.toContain('Bearer abc');
  });

  it('a structurally broken record is refused (AUDIT_RECORD_MALFORMED / AUDIT_HASH_MALFORMED)', () => {
    const sink = createInMemoryAuditSink(clock);
    const { record } = appendAuditRecord(sink, fakeHash, null, baseInput() as Parameters<typeof appendAuditRecord>[3], clock);
    expectCode(() => sink.append({ ...record, recordHash: '' }), 'AUDIT_HASH_MALFORMED');
    expectCode(() => sink.append({ ...record, auditId: '   ' as unknown as Uuid }), 'AUDIT_RECORD_MALFORMED');
    expectCode(() => sink.append({ ...record, occurredAt: 'not-iso' }), 'AUDIT_OCCURRED_AT_INVALID');
  });
});

// --- actor / draft helpers ----------------------------------------------------------------------

describe('assertActor — the §37 actor table', () => {
  it('accepts every kind with the org rules pinned', () => {
    expect(assertActor({ kind: 'user', id: 'u1', orgId: ORG })).toEqual({ kind: 'user', id: 'u1', orgId: ORG });
    expect(assertActor({ kind: 'apiKey', id: 'k1', orgId: ORG })).toEqual({ kind: 'apiKey', id: 'k1', orgId: ORG });
    expect(assertActor({ kind: 'agent', id: 'a1', orgId: ORG })).toEqual({ kind: 'agent', id: 'a1', orgId: ORG });
    expect(assertActor({ kind: 'system', id: 'platform' })).toEqual({ kind: 'system', id: 'platform', orgId: null });
    expectCode(() => assertActor({ kind: 'robot', id: 'r1', orgId: ORG }), 'AUDIT_ACTOR_INVALID');
    expectCode(() => assertActor(null), 'AUDIT_ACTOR_INVALID');
  });

  it('buildAuditDraft returns a frozen draft and never mutates its input', () => {
    const input = baseInput({ previousState: { secret: 'x', keep: 1 } }) as Parameters<typeof buildAuditDraft>[0];
    const before = JSON.stringify(input);
    const draft = buildAuditDraft(input, clock);
    expect(Object.isFrozen(draft)).toBe(true);
    expect(draft.previousState).toEqual({ keep: 1 });
    expect(JSON.stringify(input)).toBe(before); // input untouched
  });

  it('the genesis hash anchor is the 64-zero constant', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
  });
});
