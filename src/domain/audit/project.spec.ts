import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { createInMemoryAuditSink, type AuditRecord } from './record';
import { appendAuditRecord, verifyChain, type AuditHashPort } from './chain';
import { auditFromEvent, queryAuditTrail, type AuditEventEnvelope, type AuditFromEventOptions } from './project';

// --- fixtures -------------------------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(801);
const USER = uid(810);
const AGENT = uid(811);

const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T08:05:00.000Z';
const T2 = '2026-03-01T08:10:00.000Z';
const clockAt = (iso: string) => ({ now: () => new Date(iso) });

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

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const envelope = (overrides: Partial<AuditEventEnvelope> = {}): AuditEventEnvelope => ({
  name: 'payment.confirmed',
  aggregateId: uid(820),
  occurredAt: T0,
  payload: { amountMinor: 1500, currency: 'KES' },
  ...overrides,
});

const options = (overrides: Partial<AuditFromEventOptions> = {}): AuditFromEventOptions => ({
  auditId: uid(830),
  orgId: ORG,
  actor: { kind: 'system', id: 'platform:projection', orgId: null },
  action: 'ingest',
  requestId: 'req-proj-1',
  ...overrides,
});

// --- auditFromEvent --------------------------------------------------------------------------

describe('auditFromEvent — plain envelope → complete §37 draft (no lane imports)', () => {
  it('maps the naming convention: context → entityType, aggregateId → entityId, instant preserved', () => {
    const draft = auditFromEvent(envelope(), options());
    expect(draft.entityType).toBe('payment');
    expect(draft.entityId).toBe(envelope().aggregateId);
    expect(draft.occurredAt).toBe(T0); // the EVENT's instant, never "now"
    expect(draft.action).toBe('ingest');
    expect(draft.previousState).toBeNull();
    expect(draft.newState).toBeNull();
    expect(draft.aiContext).toBeNull();
    expect(draft.approval).toBeNull();
  });

  it('previousState/newState ride in the payload when the producer included them', () => {
    const draft = auditFromEvent(
      envelope({ payload: { previousState: { status: 'pending' }, newState: { status: 'confirmed' } } }),
      options(),
    );
    expect(draft.previousState).toEqual({ status: 'pending' });
    expect(draft.newState).toEqual({ status: 'confirmed' });
  });

  it('correlationId: envelope wins over the caller fallback; absent on both sides → null', () => {
    expect(auditFromEvent(envelope({ correlationId: 'corr-env' }), options({ correlationId: 'corr-ctx' })).correlationId).toBe('corr-env');
    expect(auditFromEvent(envelope(), options({ correlationId: 'corr-ctx' })).correlationId).toBe('corr-ctx');
    expect(auditFromEvent(envelope(), options()).correlationId).toBeNull();
  });

  it('the closed action is caller-supplied, never guessed from the event name (deny-by-default)', () => {
    expectCode(() => auditFromEvent(envelope(), options({ action: 'confirmed' as never })), 'AUDIT_ACTION_INVALID');
  });

  it('envelope refusal table', () => {
    expectCode(() => auditFromEvent(envelope({ name: 'paymentconfirmed' }), options()), 'AUDIT_EVENT_NAME_MALFORMED');
    expectCode(() => auditFromEvent(envelope({ name: 'Payment.Confirmed' }), options()), 'AUDIT_EVENT_NAME_MALFORMED');
    expectCode(() => auditFromEvent(envelope({ name: 'a.b.c' }), options()), 'AUDIT_EVENT_NAME_MALFORMED');
    expectCode(() => auditFromEvent(envelope({ occurredAt: '08:00' }), options()), 'AUDIT_EVENT_OCCURRED_AT_INVALID');
    expectCode(() => auditFromEvent(envelope({ payload: 'flat' as unknown as Record<string, unknown> }), options()), 'AUDIT_EVENT_PAYLOAD_INVALID');
    expectCode(
      () => auditFromEvent(envelope({ payload: { previousState: 'pending' } }), options()),
      'AUDIT_EVENT_PAYLOAD_INVALID',
    );
    expectCode(() => auditFromEvent(envelope({ payload: { newState: ['confirmed'] } }), options()), 'AUDIT_EVENT_PAYLOAD_INVALID');
    expectCode(() => auditFromEvent(null as unknown as AuditEventEnvelope, options()), 'AUDIT_EVENT_PAYLOAD_INVALID');
  });

  it('context refusals — actor and request context are validated like any append', () => {
    expectCode(() => auditFromEvent(envelope(), options({ actor: { kind: 'ghost' as never, id: 'x', orgId: null } })), 'AUDIT_ACTOR_INVALID');
    expectCode(() => auditFromEvent(envelope(), options({ requestId: ' ' })), 'AUDIT_REQUEST_ID_REQUIRED');
  });

  it('projection + append + verify end-to-end, INCLUDING an AI agent action (§37 AI clause)', () => {
    const sink = createInMemoryAuditSink(clockAt(T1));
    const draft = auditFromEvent(
      envelope({ name: 'reminder.scheduled', occurredAt: T0, payload: { channel: 'sms' } }),
      options({
        auditId: uid(831),
        action: 'send',
        actor: { kind: 'agent', id: AGENT, orgId: ORG },
        aiContext: { agentKind: 'dunning-nba', evidenceRefs: ['ev-41', 'ev-42'] },
      }),
    );
    const { record, event } = appendAuditRecord(sink, fakeHash, null, draft, clockAt(T1));
    expect(record.entityType).toBe('reminder');
    expect(record.actor.kind).toBe('agent');
    expect(record.aiContext).toEqual({ agentKind: 'dunning-nba', evidenceRefs: ['ev-41', 'ev-42'] });
    expect(record.occurredAt).toBe(T0);
    expect(verifyChain(sink.records(), fakeHash).ok).toBe(true);
    expect(event.payload.auditId).toBe(record.auditId);
  });
});

// --- queryAuditTrail ---------------------------------------------------------------------------

describe('queryAuditTrail — read model: stable sort + AND filters', () => {
  const r = (over: Partial<AuditRecord>): AuditRecord =>
    appendAuditRecord(
      createInMemoryAuditSink(clockAt('2026-03-01T09:00:00.000Z')), // sink clock past every instant (future gate)
      fakeHash,
      null,
      {
        auditId: over.auditId ?? uid(900),
        orgId: ORG,
        actor: { kind: 'user', id: USER, orgId: ORG },
        action: 'update',
        entityType: 'receivable',
        entityId: uid(901),
        requestId: 'req-1',
        occurredAt: T1,
        ...(over as Record<string, unknown>),
      },
      clockAt(T1),
    ).record;

  const trail: AuditRecord[] = [
    r({ auditId: uid(902), occurredAt: T2, action: 'send', actor: { kind: 'agent', id: AGENT, orgId: ORG }, entityType: 'reminder' }),
    r({ auditId: uid(903), occurredAt: T0, correlationId: 'corr-7' }),
    r({ auditId: uid(904), occurredAt: T1, actor: { kind: 'apiKey', id: 'key-9', orgId: ORG } }),
    r({ auditId: uid(905), occurredAt: T1, entityType: 'payment', entityId: uid(906) }),
    r({ auditId: uid(907), occurredAt: T1, orgId: uid(802) }),
  ];

  it('an empty filter returns everything, sorted by occurredAt then auditId — input order irrelevant', () => {
    const out = queryAuditTrail(trail);
    // T0 first, then the three T1 records in auditId order, then T2:
    expect(out.map((x) => x.auditId)).toEqual([uid(903), uid(904), uid(905), uid(907), uid(902)]);
    expect(out[0]!.occurredAt).toBe(T0);
    expect(out[out.length - 1]!.occurredAt).toBe(T2);
  });

  it('ties on occurredAt break by auditId (stable total order)', () => {
    const t1s = trail.filter((x) => x.occurredAt === T1).map((x) => x.auditId);
    expect(t1s).toHaveLength(3);
    const out = queryAuditTrail(trail).filter((x) => x.occurredAt === T1).map((x) => x.auditId);
    expect(out).toEqual([...t1s].sort());
  });

  it('filter table: each field selects exactly its matches (AND semantics)', () => {
    expect(queryAuditTrail(trail, { orgId: ORG })).toHaveLength(4);
    expect(queryAuditTrail(trail, { orgId: uid(802) })).toHaveLength(1);
    expect(queryAuditTrail(trail, { actorId: AGENT })).toHaveLength(1);
    expect(queryAuditTrail(trail, { actorId: 'key-9' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { actorKind: 'apiKey' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { actorKind: 'system' })).toHaveLength(0);
    expect(queryAuditTrail(trail, { entityType: 'payment' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { entityType: 'receivable' })).toHaveLength(3);
    expect(queryAuditTrail(trail, { entityId: uid(906) })).toHaveLength(1);
    expect(queryAuditTrail(trail, { action: 'send' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { action: 'update' })).toHaveLength(4);
    expect(queryAuditTrail(trail, { correlationId: 'corr-7' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { requestId: 'req-1' })).toHaveLength(5);
    expect(queryAuditTrail(trail, { orgId: ORG, actorKind: 'agent', action: 'send' })).toHaveLength(1);
    expect(queryAuditTrail(trail, { orgId: ORG, actorKind: 'agent', action: 'update' })).toHaveLength(0);
  });

  it('time range is INCLUSIVE on both edges — boundary pins', () => {
    expect(queryAuditTrail(trail, { from: T1, to: T1 })).toHaveLength(3);
    expect(queryAuditTrail(trail, { from: T0 })).toHaveLength(5);
    expect(queryAuditTrail(trail, { to: T0 })).toHaveLength(1);
    expect(queryAuditTrail(trail, { from: '2026-03-01T08:00:00.001Z', to: T2 })).toHaveLength(4); // 1ms after T0 excluded
  });

  it('invalid filters are refused — silence never widens visibility', () => {
    expectCode(() => queryAuditTrail(trail, { from: 'yesterday' }), 'AUDIT_FILTER_INVALID');
    expectCode(() => queryAuditTrail(trail, { to: 42 as unknown as string }), 'AUDIT_FILTER_INVALID');
    expectCode(() => queryAuditTrail(trail, { from: T2, to: T1 }), 'AUDIT_FILTER_INVALID'); // inverted range
    expectCode(() => queryAuditTrail(trail, { action: 'nuke' as never }), 'AUDIT_FILTER_INVALID');
    expectCode(() => queryAuditTrail(trail, { actorKind: 'ghost' as never }), 'AUDIT_FILTER_INVALID');
    expectCode(() => queryAuditTrail(trail, { orgId: '  ' as never }), 'AUDIT_FILTER_INVALID');
    expectCode(() => queryAuditTrail(trail, null as unknown as Record<string, never>), 'AUDIT_FILTER_INVALID');
  });

  it('read-only: the input array and its order are untouched', () => {
    const snapshot = trail.map((x) => x.auditId);
    queryAuditTrail(trail, { orgId: ORG });
    queryAuditTrail(trail, {});
    expect(trail.map((x) => x.auditId)).toEqual(snapshot);
  });
});
