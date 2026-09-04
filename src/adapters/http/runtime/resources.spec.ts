import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import { Money } from '../../../domain/shared/money';
import { intakePayment } from '../../../domain/payments/intake';
import { openCase } from '../../../domain/collections/case';
import type { Receivable } from '../../../domain/receivables/receivable';
import type { StoredEvent } from './memory';
import { InMemoryResourceStore, toStoredEvent } from './resources';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => uuid(`20000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);
const ORG = uuid('20000000-0000-4000-8000-000000000901');

const seedPayment = (store: InMemoryResourceStore, externalRef: string) => {
  const result = intakePayment(
    {
      channel: 'c2b',
      externalRef,
      idempotencyKey: `key-${externalRef}`,
      amount: Money.ofMinor(25_000, 'KES'),
      paymentId: nextId(),
    },
    { clock },
  );
  store.savePayment(result.payment);
  return result.payment;
};

const seedCase = (store: InMemoryResourceStore, orgId: Uuid, receivableIds: readonly Uuid[], sequenceNo: number) => {
  const result = openCase(
    {
      id: nextId(),
      orgId,
      receivableIds: [...receivableIds],
      collectorId: nextId(),
      openedBy: 'seed-collector',
      sequenceNo,
    },
    [],
    clock,
  );
  store.saveCase(result.case);
  return result.case;
};

const seedReceivable = (store: InMemoryResourceStore, id: Uuid): Receivable => {
  const receivable: Receivable = {
    id,
    invoiceId: nextId(),
    customerId: nextId(),
    currency: 'KES',
    original: Money.ofMinor(100_000, 'KES'),
    applied: Money.zero('KES'),
    state: 'open',
    overdue: false,
    openedAt: new Date(T0),
    dueDate: new Date(T0),
    settledAt: null,
    voidedAt: null,
    writeOff: null,
    uncollectibleReason: null,
    uncollectibleAt: null,
    recoveredAt: null,
  };
  store.saveReceivable(receivable);
  return receivable;
};

describe('InMemoryResourceStore — the reference resource runtime', () => {
  it('starts empty and derives a first case sequence of 1', () => {
    const store = new InMemoryResourceStore();
    expect(store.receivables()).toEqual([]);
    expect(store.payments()).toEqual([]);
    expect(store.cases()).toEqual([]);
    expect(store.events()).toEqual([]);
    expect(store.nextCaseSequence(ORG)).toBe(1);
  });

  it('round-trips a lane-built payment by upserting on the aggregate id', () => {
    const store = new InMemoryResourceStore();
    const payment = seedPayment(store, 'SJ91AB2KX');
    expect(store.payments()).toHaveLength(1);
    expect(store.payments()[0]?.id).toBe(payment.id);

    const replacement = { ...payment, state: 'confirmed' as const };
    store.savePayment(replacement);
    expect(store.payments()).toHaveLength(1);
    expect(store.payments()[0]?.state).toBe('confirmed');
  });

  it('upserts receivables and keeps other rows intact', () => {
    const store = new InMemoryResourceStore();
    const first = seedReceivable(store, nextId());
    const second = seedReceivable(store, nextId());
    expect(store.receivables()).toHaveLength(2);

    const settled: Receivable = { ...first, state: 'settled', settledAt: new Date(T0) };
    store.saveReceivable(settled);
    expect(store.receivables()).toHaveLength(2);
    expect(store.receivables().find((r) => r.id === first.id)?.state).toBe('settled');
    expect(store.receivables().find((r) => r.id === second.id)?.state).toBe('open');
  });

  it('upserts collections cases (transitions replace the row — facts are immutable values)', () => {
    const store = new InMemoryResourceStore();
    const seeded = seedCase(store, ORG, [nextId()], 1);
    expect(store.cases()).toHaveLength(1);

    const engaged: typeof seeded = {
      ...seeded,
      status: 'in_progress',
      history: [...seeded.history, { from: 'open', to: 'in_progress', reason: 'agent engaged', actorId: 'collector', at: new Date(T0) }],
    };
    store.saveCase(engaged);
    expect(store.cases()).toHaveLength(1);
    expect(store.cases()[0]?.status).toBe('in_progress');
  });

  it('derives the per-org case sequence as max stored sequence + 1, independently per org', () => {
    const store = new InMemoryResourceStore();
    const otherOrg = uuid('20000000-0000-4000-8000-000000000902');

    seedCase(store, ORG, [nextId()], 1);
    seedCase(store, ORG, [nextId()], 2);
    seedCase(store, otherOrg, [nextId()], 7);

    expect(store.nextCaseSequence(ORG)).toBe(3);
    expect(store.nextCaseSequence(otherOrg)).toBe(8);
  });

  it('appends events append-only and hands back fresh copies', () => {
    const store = new InMemoryResourceStore();
    const event = toStoredEvent({
      name: 'payment.initiated',
      version: 1,
      aggregateId: nextId(),
      payload: { ok: true },
      occurredAt: new Date(T0),
    });
    store.record(event);
    store.record(event);

    const events = store.events();
    expect(events).toHaveLength(2);
    // The getter's contract is a fresh mutable-agnostic COPY: mutating the
    // returned array (readonly-typed; cast is the point of the isolation
    // check) must never touch the store.
    (events as unknown as StoredEvent[]).pop();
    expect(store.events()).toHaveLength(2);
  });

  it('returns fresh array copies from every getter', () => {
    const store = new InMemoryResourceStore();
    seedPayment(store, 'REF-1');
    const payments = store.payments() as unknown as unknown[];
    payments.pop();
    expect(store.payments()).toHaveLength(1);
  });
});

describe('toStoredEvent — the structural log envelope', () => {
  it('normalizes Date occurredAt (payments lane) to ISO-8601', () => {
    const stored = toStoredEvent({
      name: 'payment.initiated',
      version: 1,
      aggregateId: 'agg-1',
      payload: { requestedMinor: 25_000n },
      occurredAt: new Date(T0),
    });
    expect(stored.occurredAt).toBe(T0);
    expect(stored.name).toBe('payment.initiated');
    expect(stored.version).toBe(1);
  });

  it('keeps string occurredAt (collections/receivables/auth lanes) untouched', () => {
    const stored = toStoredEvent({
      name: 'case.opened',
      version: 1,
      aggregateId: 'agg-2',
      payload: { caseNumber: 'CASE-000001' },
      occurredAt: T0,
    });
    expect(stored.occurredAt).toBe(T0);
  });
});
