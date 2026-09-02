import { describe, expect, it } from 'vitest';
import { uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  creditBalanceAppliedEvent,
  creditNoteAppliedEvent,
  creditNoteIssuedEvent,
  refundCompletedEvent,
  refundRequestedEvent,
} from './events';

const clock: Clock = { now: () => new Date('2025-06-01T09:30:00.000Z') };

/** Deterministic 36-char hex ids for table-driven tests. */
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const events = [
  refundRequestedEvent({ refundId: uid('b0000000001'), paymentId: uid('a0000000001'), totalMinor: 500n, reason: 'duplicate' }, clock),
  refundCompletedEvent(uid('b0000000001'), clock),
  creditNoteIssuedEvent({ creditNoteId: uid('d0000000001'), customerId: uid('e0000000001'), totalMinor: 700n }, clock),
  creditNoteAppliedEvent(
    {
      applicationId: uid('aa000000001'),
      creditNoteId: uid('d0000000001'),
      receivableId: uid('10000000001'),
      amountMinor: 100n,
    },
    clock,
  ),
  creditBalanceAppliedEvent({ customerId: uid('e0000000001'), amountMinor: 200n, receivableId: null }, clock),
];

describe('adjustment.* events (docs/04 E19–E23)', () => {
  it('emits exactly the five adjustment.* facts, camelCase names in catalog order', () => {
    expect(events.map((event) => event.name)).toEqual([
      'adjustment.refundRequested',
      'adjustment.refundCompleted',
      'adjustment.creditNoteIssued',
      'adjustment.creditNoteApplied',
      'adjustment.creditBalanceApplied',
    ]);
  });

  it('carries the stable envelope: {name, version: 1, aggregateId, payload, occurredAt}', () => {
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(['aggregateId', 'name', 'occurredAt', 'payload', 'version']);
      expect(event.version).toBe(1);
      expect(event.occurredAt).toBe('2025-06-01T09:30:00.000Z'); // from the injected Clock
      expect(uuid(event.aggregateId)).toBe(event.aggregateId); // Uuid-shaped
    }
  });

  it('keeps payloads narrow and camelCase: ids + integer minor units only', () => {
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['paymentId', 'reason', 'refundId', 'totalMinor']);
    expect(Object.keys(events[1]!.payload).sort()).toEqual(['completedAt', 'refundId']);
    expect(Object.keys(events[2]!.payload).sort()).toEqual(['creditNoteId', 'customerId', 'totalMinor']);
    expect(Object.keys(events[3]!.payload).sort()).toEqual([
      'amountMinor',
      'applicationId',
      'creditNoteId',
      'receivableId',
    ]);
    // receivableId is null when credit-note excess is routed to the balance
    expect(events[4]!.payload).toEqual({
      customerId: uid('e0000000001'),
      amountMinor: 200n,
      receivableId: null,
    });
  });
});
