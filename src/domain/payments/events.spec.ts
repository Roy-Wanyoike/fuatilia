import { describe, expect, it } from 'vitest';
import { Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  duplicateCallbackObservedEvent,
  matchReversedEvent,
  paymentConfirmedEvent,
  paymentFailedEvent,
  paymentInitiatedEvent,
  paymentMatchedEvent,
  paymentReversedEvent,
  type PaymentEvent,
} from './events';

const T0 = Date.UTC(2025, 2, 15, 8, 0, 0);
const fixed = new Date(T0);
const clock: Clock = { now: () => fixed };

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

describe('Event envelope contract (docs/04 + src/domain/events/README.md)', () => {
  const rows: {
    event: string;
    aggregateId: Uuid;
    payloadKeys: string[];
    make: () => PaymentEvent;
  }[] = [
    {
      event: 'payment.initiated', // E11
      aggregateId: rid(1),
      payloadKeys: ['paymentId', 'channel', 'requestedMinor'],
      make: () =>
        paymentInitiatedEvent(
          { paymentId: rid(1), channel: 'c2b', requestedMinor: Money.ofMinor(500, 'KES') },
          clock,
        ),
    },
    {
      event: 'payment.confirmed', // E12
      aggregateId: rid(1),
      payloadKeys: ['paymentId', 'confirmedMinor', 'externalRef', 'confirmedAt'],
      make: () =>
        paymentConfirmedEvent(
          {
            paymentId: rid(1),
            confirmedMinor: Money.ofMinor(500, 'KES'),
            externalRef: 'QK1',
            confirmedAt: fixed,
          },
          clock,
        ),
    },
    {
      event: 'payment.failed', // E13
      aggregateId: rid(1),
      payloadKeys: ['paymentId', 'failureCode'],
      make: () => paymentFailedEvent({ paymentId: rid(1), failureCode: 'CX103' }, clock),
    },
    {
      event: 'payment.reversed', // E14
      aggregateId: rid(1),
      payloadKeys: ['paymentId', 'reason', 'reversalOf'],
      make: () => paymentReversedEvent({ paymentId: rid(1), reason: 'dup', reversalOf: rid(1) }, clock),
    },
    {
      event: 'payments.duplicateCallbackObserved', // E15 (note the plural context — C5 tripwire)
      aggregateId: rid(1),
      payloadKeys: ['paymentId', 'externalRef', 'seenAt'],
      make: () =>
        duplicateCallbackObservedEvent({ paymentId: rid(1), externalRef: 'QK1', seenAt: fixed }, clock),
    },
    {
      event: 'reconciliation.paymentMatched', // E16
      aggregateId: rid(2),
      payloadKeys: ['matchId', 'paymentId', 'declaredRefs', 'confidence'],
      make: () =>
        paymentMatchedEvent(
          { matchId: rid(2), paymentId: rid(1), declaredRefs: ['INV-1'], confidence: 'auto' },
          clock,
        ),
    },
    {
      event: 'reconciliation.matchReversed', // E18
      aggregateId: rid(2),
      payloadKeys: ['matchId', 'reason'],
      make: () => matchReversedEvent({ matchId: rid(2), reason: 'wrong payment' }, clock),
    },
  ];

  it.each(rows)('$event carries the catalog name, version 1, the Clock time and a camelCase payload', ({ event, aggregateId, payloadKeys, make }) => {
    const evt = make();
    expect(evt.name).toBe(event); // camelCase names exactly as in docs/04
    expect(evt.version).toBe(1); // schema version — breaking changes bump it
    expect(evt.aggregateId).toBe(aggregateId); // owning aggregate (payment or match)
    expect(evt.occurredAt.getTime()).toBe(fixed.getTime()); // from the injected Clock
    expect(Object.keys(evt.payload).sort()).toEqual([...payloadKeys].sort());
    expect(Object.keys(evt).sort()).toEqual(['aggregateId', 'name', 'occurredAt', 'payload', 'version']);
  });

  it('minor-unit amounts in payloads are bigint (i64) — never floats', () => {
    const evt = paymentInitiatedEvent(
      { paymentId: rid(3), channel: 'stk', requestedMinor: Money.ofMinor(12_345, 'KES') },
      clock,
    );
    if (evt.name !== 'payment.initiated') throw new Error('unexpected event');
    expect(evt.payload.requestedMinor).toBe(12_345n);
    expect(typeof evt.payload.requestedMinor).toBe('bigint');
  });

  it('payloads reference aggregates by id only — no entity objects', () => {
    const evt = paymentMatchedEvent(
      { matchId: rid(4), paymentId: rid(5), declaredRefs: ['INV-2024-001', 'INV-2024-002'], confidence: 'manual' },
      clock,
    );
    if (evt.name !== 'reconciliation.paymentMatched') throw new Error('unexpected event');
    expect(evt.payload.declaredRefs).toEqual(['INV-2024-001', 'INV-2024-002']);
    expect(JSON.stringify(evt.payload)).toContain('"matchId"');
    expect(JSON.stringify(evt.payload)).not.toContain('paymentId":{');
  });
});
