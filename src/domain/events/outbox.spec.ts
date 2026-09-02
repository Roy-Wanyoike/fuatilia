import { describe, expect, it } from 'vitest';
import { DomainError, uuid } from '../shared';
import type { Uuid } from '../shared';
import { makeEnvelope } from './envelope';
import type { DomainEvent } from './envelope';
import { Outbox } from './outbox';

const T0 = '2025-09-02T08:00:00.000Z';

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const payment = rid(4);
const receivable = rid(3);
const match = rid(5);
const journey = rid(77); // correlationId — ties the whole payment journey together

/** A payment journey: initiated → confirmed → matched → allocation lands. */
const initiated = () =>
  makeEnvelope(
    'payment.initiated',
    { eventId: rid(11), aggregateId: payment, correlationId: journey, occurredAt: T0 },
    { paymentId: payment, channel: 'stk', requestedMinor: 100000 },
  );
const confirmed = () =>
  makeEnvelope(
    'payment.confirmed',
    { eventId: rid(12), aggregateId: payment, correlationId: journey, occurredAt: T0 },
    { paymentId: payment, confirmedMinor: 100000, externalRef: 'QK12HKXYZ', confirmedAt: T0 },
  );
const matched = () =>
  makeEnvelope(
    'reconciliation.paymentMatched',
    { eventId: rid(16), aggregateId: match, correlationId: journey, occurredAt: T0 },
    { matchId: match, paymentId: payment, declaredRefs: ['INV-2025-0001'], confidence: 'auto' },
  );
const partiallySettled = () =>
  makeEnvelope(
    'receivable.partiallySettled',
    { eventId: rid(6), aggregateId: receivable, correlationId: journey, occurredAt: T0 },
    { receivableId: receivable, amountMinor: 40000, remainingMinor: 60000 },
  );

const appendJourney = (outbox: Outbox): void => {
  outbox.append(initiated());
  outbox.append(confirmed());
  outbox.append(matched());
  outbox.append(partiallySettled());
};

describe('Outbox — pure transactional-outbox contract (at-least-once, per-consumer cursors)', () => {
  it('append preserves insertion order; size grows; every fact is frozen', () => {
    const outbox = new Outbox();
    appendJourney(outbox);
    expect(outbox.size).toBe(4);
    const order = outbox.replay().map((e) => e.name);
    expect(order).toEqual(['payment.initiated', 'payment.confirmed', 'reconciliation.paymentMatched', 'receivable.partiallySettled']);
    expect(outbox.replay().every((e) => Object.isFrozen(e))).toBe(true);
  });

  it('append validates the envelope before it can reach the wire', () => {
    const outbox = new Outbox();
    const valid = confirmed();
    expectCode(() => outbox.append({ ...valid, name: 'invoice.paid' } as DomainEvent), 'EVENT_UNKNOWN');
    expectCode(() => outbox.append({ ...valid, version: 2 } as unknown as DomainEvent), 'EVENT_VERSION_UNSUPPORTED');
    expectCode(() => outbox.append({ ...valid, eventId: 'nope' } as DomainEvent), 'EVENT_ID_INVALID');
    expectCode(() => outbox.append({ ...valid, occurredAt: 'yesterday' } as DomainEvent), 'EVENT_OCCURRED_AT_INVALID');
    expectCode(
      () => outbox.append({ ...valid, payload: { confirmedMinor: 2n } }),
      'EVENT_PAYLOAD_NOT_SERIALIZABLE',
    );
    expect(outbox.size).toBe(0); // nothing invalid ever lands
  });

  it('dedupes by eventId → OUTBOX_DUPLICATE (command replays cannot double-append)', () => {
    const outbox = new Outbox();
    outbox.append(confirmed());
    expectCode(() => outbox.append(confirmed()), 'OUTBOX_DUPLICATE');
    // even under a different name — identity is the eventId, not the payload
    expectCode(() => outbox.append({ ...confirmed(), name: 'payment.failed' } as DomainEvent), 'OUTBOX_DUPLICATE');
    expect(outbox.size).toBe(1);
  });

  it('drain on an empty outbox → no events, nextCursor -1 (cursor arithmetic base case)', () => {
    const outbox = new Outbox();
    expect(outbox.drain('ledger')).toEqual({ events: [], nextCursor: -1 });
    expect(outbox.cursorOf('ledger')).toBe(-1);
    expect(outbox.drain('ledger', -1)).toEqual({ events: [], nextCursor: -1 });
  });

  it('drain returns the events after the cursor plus the next cursor; a second drain is empty', () => {
    const outbox = new Outbox();
    appendJourney(outbox);
    const first = outbox.drain('ledger');
    expect(first.events.map((e) => e.name)).toHaveLength(4);
    expect(first.nextCursor).toBe(3); // 0-based index of the last event
    expect(outbox.cursorOf('ledger')).toBe(3); // checkpoint advanced
    expect(outbox.drain('ledger')).toEqual({ events: [], nextCursor: 3 }); // nothing new
  });

  it('drain with an explicit cursor returns the events AFTER that position', () => {
    const outbox = new Outbox();
    appendJourney(outbox);
    const fromOne = outbox.drain('ledger', 1); // cursor = index of the last delivered event
    expect(fromOne.events.map((e) => e.name)).toEqual(['reconciliation.paymentMatched', 'receivable.partiallySettled']);
    expect(fromOne.nextCursor).toBe(3);
  });

  it('at-least-once: an explicit OLDER cursor redelivers the window without rewinding the checkpoint', () => {
    const outbox = new Outbox();
    appendJourney(outbox);
    outbox.drain('intelligence'); // checkpoint at 3
    const redelivered = outbox.drain('intelligence', 1); // crashed after acking only up to 1
    expect(redelivered.events.map((e) => e.eventId)).toEqual([rid(16), rid(6)]); // events after index 1
    expect(outbox.cursorOf('intelligence')).toBe(3); // checkpoints never move backwards
    expect(outbox.drain('intelligence').events).toEqual([]); // and continuing stays empty
  });

  it('per-consumer cursors are independent — a new consumer sees the whole stream', () => {
    const outbox = new Outbox();
    appendJourney(outbox);
    outbox.drain('ledger');
    const fresh = outbox.drain('collections');
    expect(fresh.events).toHaveLength(4);
    expect(fresh.nextCursor).toBe(3);
    expect(outbox.cursorOf('ledger')).toBe(3);
    expect(outbox.cursorOf('collections')).toBe(3);
    expect(outbox.cursorOf('never-drained')).toBe(-1);
  });

  it.each([
    { label: 'below range', cursor: -2 },
    { label: 'at size (nothing delivered yet)', cursor: 4 },
    { label: 'way beyond', cursor: 99 },
    { label: 'fractional', cursor: 1.5 },
    { label: 'NaN', cursor: Number.NaN },
    { label: 'Infinity', cursor: Number.POSITIVE_INFINITY },
  ])('invalid cursor ($label) → OUTBOX_CURSOR_INVALID', ({ cursor }) => {
    const outbox = new Outbox();
    appendJourney(outbox);
    expectCode(() => outbox.drain('ledger', cursor), 'OUTBOX_CURSOR_INVALID');
  });

  it.each([{ label: 'empty string', consumer: '' }, { label: 'non-string (defensive, JS callers)', consumer: 42 as unknown as string }])(
    'invalid consumer ($label) → OUTBOX_CONSUMER_INVALID',
    ({ consumer }) => {
      const outbox = new Outbox();
      expectCode(() => outbox.drain(consumer), 'OUTBOX_CONSUMER_INVALID');
      expectCode(() => outbox.cursorOf(consumer), 'OUTBOX_CONSUMER_INVALID');
    },
  );

  it('replay is deterministic: same order every time, unaffected by drains, prefix-stable under appends', () => {
    const outbox = new Outbox();
    outbox.append(initiated());
    outbox.append(confirmed());
    const first = outbox.replay();
    expect(first.map((e) => e.eventId)).toEqual([rid(11), rid(12)]);

    outbox.drain('ledger'); // drains must not disturb history
    expect(outbox.replay().map((e) => e.eventId)).toEqual([rid(11), rid(12)]);
    expect(JSON.stringify(outbox.replay())).toBe(JSON.stringify(first)); // byte-identical

    outbox.append(matched()); // append-only: history only grows at the tail
    expect(outbox.replay().map((e) => e.eventId)).toEqual([rid(11), rid(12), rid(16)]);
  });

  it('replay returns a frozen defensive copy — mutating it cannot corrupt the outbox', () => {
    const outbox = new Outbox();
    outbox.append(initiated());
    const snapshot = outbox.replay();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as DomainEvent[]).push(confirmed())).toThrow(TypeError);
    expect(outbox.size).toBe(1);
  });

  it('scenario: one payment journey fans out to independent consumers with correct hand-offs', () => {
    const outbox = new Outbox();
    appendJourney(outbox);

    // ledger consumes everything in one go
    const ledger = outbox.drain('ledger');
    expect(ledger.events.map((e) => e.name)).toEqual([
      'payment.initiated',
      'payment.confirmed',
      'reconciliation.paymentMatched',
      'receivable.partiallySettled',
    ]);
    expect(ledger.events.every((e) => e.correlationId === journey)).toBe(true); // journey correlation intact

    // notifications consumed the stream but crashed after acking only the first two;
    // the explicit older cursor redelivers exactly the unacked window (at-least-once)
    const batch1 = outbox.drain('notifications', -1);
    expect(batch1.events).toHaveLength(4);
    expect(batch1.nextCursor).toBe(3);
    const batch2 = outbox.drain('notifications', 1); // redelivery of the unacked window
    expect(batch2.events).toHaveLength(2);
    expect(batch2.nextCursor).toBe(3);
    expect(outbox.drain('notifications').events).toEqual([]);
    expect(outbox.cursorOf('notifications')).toBe(3); // checkpoint survived the rewind

    // collections intelligence replays the full history deterministically (projection rebuild)
    expect(outbox.replay()).toHaveLength(4);
  });
});
