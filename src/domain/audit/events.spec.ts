import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { createInMemoryAuditSink } from './record';
import { appendAuditRecord } from './chain';
import { recordAppendedEvent } from './events';

// --- fixtures -------------------------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1001);
const USER = uid(1010);
const AUD = uid(1011);

const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T08:01:00.000Z';
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

/** Deterministic fake hash port — 64-bit FNV-1a double round; the domain never imports crypto. */
const fakeHash = (input: string): string => {
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

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const store = (overrides: Record<string, unknown> = {}) =>
  appendAuditRecord(
    createInMemoryAuditSink(clockAt(T0)),
    fakeHash,
    null,
    {
      auditId: AUD,
      orgId: ORG,
      actor: { kind: 'user', id: USER, orgId: ORG },
      action: 'write_off',
      entityType: 'receivable',
      entityId: uid(1020),
      requestId: 'req-evt-1',
      correlationId: 'corr-evt-1',
      previousState: { balanceMinor: 1000, password: 'should-not-travel' },
      newState: { balanceMinor: 0 },
      reason: 'confirmed bankruptcy filing',
      ip: '197.232.64.10',
      userAgent: 'FuatiliaWeb/1.0',
      ...overrides,
    } as Parameters<typeof appendAuditRecord>[3],
    clockAt(T0),
  );

// --- the lane fact ----------------------------------------------------------------------------

describe('audit.recordAppended — the one narrow lane fact', () => {
  it('carries the repo envelope: name, version 1, aggregateId = auditId, occurredAt, payload', () => {
    const { record, event } = store();
    expect(event.name).toBe('audit.recordAppended');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(record.auditId);
    expect(event.occurredAt).toBe(T0);
    expect(Object.keys(event).sort()).toEqual(['aggregateId', 'name', 'occurredAt', 'payload', 'version']);
  });

  it('payload pins every narrow field — ids, actor kind, action, entity, request/correlation, chain hashes, instant', () => {
    const { record, event } = store();
    expect(event.payload).toEqual({
      auditId: AUD,
      orgId: ORG,
      actorKind: 'user',
      actorId: USER,
      action: 'write_off',
      entityType: 'receivable',
      entityId: uid(1020),
      requestId: 'req-evt-1',
      correlationId: 'corr-evt-1',
      prevRecordHash: null,
      recordHash: record.recordHash,
      occurredAt: T0,
    });
  });

  it('the payload is NARROW — no snapshots, no reason/approval/aiContext, no ip/user-agent, no secret ever travels', () => {
    const { event } = store({
      aiContext: { agentKind: 'collections-agent', evidenceRefs: ['ev-1'] },
      approval: { ref: 'appr-9', approverId: USER, decidedAt: T0 },
    });
    const flat = JSON.stringify(event.payload);
    expect(flat).not.toContain('balanceMinor');
    expect(flat).not.toContain('should-not-travel');
    expect(flat).not.toContain('bankruptcy');
    expect(flat).not.toContain('197.232.64.10');
    expect(flat).not.toContain('FuatiliaWeb');
    expect(flat).not.toContain('appr-9');
    expect(flat).not.toContain('collections-agent');
    expect(flat).not.toContain('ev-1');
  });

  it('the envelope instant is Clock-driven; a broken clock is AUDIT_CLOCK_INVALID', () => {
    const { record } = store();
    expect(recordAppendedEvent(record, clockAt(T1)).occurredAt).toBe(T1);
    expectCode(() => recordAppendedEvent(record, {} as unknown as Clock), 'AUDIT_CLOCK_INVALID');
    expectCode(
      () => recordAppendedEvent(record, { now: () => new Date('nope') } as unknown as Clock),
      'AUDIT_CLOCK_INVALID',
    );
  });

  it('a chained (non-genesis) record carries prevRecordHash into the payload', () => {
    const sink = createInMemoryAuditSink(clockAt(T1)); // sink clock past both instants (future gate)
    const first = appendAuditRecord(sink, fakeHash, null, {
      auditId: AUD,
      orgId: ORG,
      actor: { kind: 'system', id: 'platform', orgId: null },
      action: 'create',
      entityType: 'ledger_journal',
      entityId: uid(1030),
      requestId: 'req-1',
    } as Parameters<typeof appendAuditRecord>[3], clockAt(T0)).record;
    const second = appendAuditRecord(sink, fakeHash, first, {
      auditId: uid(1012),
      orgId: ORG,
      actor: { kind: 'system', id: 'platform', orgId: null },
      action: 'update',
      entityType: 'ledger_journal',
      entityId: uid(1030),
      requestId: 'req-2',
    } as Parameters<typeof appendAuditRecord>[3], clockAt(T1));
    expect(second.event.payload.prevRecordHash).toBe(first.recordHash);
    expect(second.event.payload.recordHash).toBe(second.record.recordHash);
  });
});
