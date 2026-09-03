import { describe, expect, it } from 'vitest';
import { Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  paymentLinkCancelledEvent,
  paymentLinkCompletedEvent,
  paymentLinkCreatedEvent,
  paymentLinkDisabledEvent,
  paymentLinkDuplicateRedemptionObservedEvent,
  paymentLinkExpiredEvent,
  paymentLinkRedeemedEvent,
} from './events';
import type { PaymentLinkEvent } from './events';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const LINK = uid(901);
const ORG = uid(902);
const R1 = uid(911);
const INTENT = uid(921);
const T = new Date('2026-06-01T08:00:00.000Z');
const clock: Clock = { now: () => T };

interface Row {
  name: string;
  make: () => PaymentLinkEvent;
  aggregateId: Uuid;
  payload: Record<string, unknown>;
}

const rows: Row[] = [
  {
    name: 'paymentlink.created',
    make: () =>
      paymentLinkCreatedEvent(
        {
          linkId: LINK,
          orgId: ORG,
          receivableIds: [R1],
          mode: 'fixed',
          targetAmountMinor: 85_000n,
          currency: 'KES',
          singleUse: true,
          allowPartial: false,
          expiresAt: T,
        },
        clock,
      ),
    aggregateId: LINK,
    payload: {
      linkId: LINK,
      orgId: ORG,
      receivableIds: [R1],
      mode: 'fixed',
      targetAmountMinor: 85_000n,
      currency: 'KES',
      singleUse: true,
      allowPartial: false,
      expiresAt: T,
    },
  },
  {
    name: 'paymentlink.redeemed',
    make: () =>
      paymentLinkRedeemedEvent(
        { linkId: LINK, intentId: INTENT, amountMinor: 85_000n, currency: 'KES', redeemedAt: T },
        clock,
      ),
    aggregateId: LINK,
    payload: { linkId: LINK, intentId: INTENT, amountMinor: 85_000n, currency: 'KES', redeemedAt: T },
  },
  {
    name: 'paymentlink.completed',
    make: () => paymentLinkCompletedEvent({ linkId: LINK, collectedMinor: 85_000n, completedAt: T }, clock),
    aggregateId: LINK,
    payload: { linkId: LINK, collectedMinor: 85_000n, completedAt: T },
  },
  {
    name: 'paymentlink.expired',
    make: () => paymentLinkExpiredEvent({ linkId: LINK, expiredAt: T }, clock),
    aggregateId: LINK,
    payload: { linkId: LINK, expiredAt: T },
  },
  {
    name: 'paymentlink.disabled',
    make: () => paymentLinkDisabledEvent({ linkId: LINK, reason: 'ops hold', disabledAt: T }, clock),
    aggregateId: LINK,
    payload: { linkId: LINK, reason: 'ops hold', disabledAt: T },
  },
  {
    name: 'paymentlink.cancelled',
    make: () => paymentLinkCancelledEvent({ linkId: LINK, reason: 'superseded', cancelledAt: T }, clock),
    aggregateId: LINK,
    payload: { linkId: LINK, reason: 'superseded', cancelledAt: T },
  },
  {
    name: 'paymentlink.duplicateRedemptionObserved',
    make: () =>
      paymentLinkDuplicateRedemptionObservedEvent(
        { linkId: LINK, idempotencyKey: 'retry-me', intentId: INTENT, seenAt: T },
        clock,
      ),
    aggregateId: LINK,
    payload: { linkId: LINK, idempotencyKey: 'retry-me', intentId: INTENT, seenAt: T },
  },
];

// --- envelope contract ----------------------------------------------------------

describe('paymentlink events — repo envelope contract (narrow, v1, opaque ids)', () => {
  it.each(rows)('$name carries exactly its payload keys with version 1', ({ name, make, aggregateId, payload }) => {
    const evt = make();
    expect(evt.name).toBe(name);
    expect(evt.version).toBe(1);
    expect(evt.aggregateId).toBe(aggregateId);
    expect(evt.occurredAt).toEqual(T);
    expect(Object.keys(evt.payload).sort()).toEqual(Object.keys(payload).sort());
    expect(evt.payload).toEqual(payload);
  });

  it('omits absent optional fields instead of nulls (created: open mode)', () => {
    const evt = paymentLinkCreatedEvent(
      {
        linkId: LINK,
        orgId: ORG,
        receivableIds: [R1],
        mode: 'open',
        currency: 'KES',
        singleUse: false,
        allowPartial: true,
      },
      clock,
    );
    if (evt.name !== 'paymentlink.created') throw new Error('unexpected event');
    expect(Object.keys(evt.payload).sort()).toEqual([
      'allowPartial',
      'currency',
      'linkId',
      'mode',
      'orgId',
      'receivableIds',
      'singleUse',
    ]);
  });

  it('the token is a secret and never appears in any event payload', () => {
    const token = 'SecretTokenValue-99';
    const bigintSafe = (_: unknown, v: unknown): string => (typeof v === 'bigint' ? v.toString() : v as string);
    for (const row of rows) {
      const evt = row.make();
      expect(JSON.stringify(evt, bigintSafe)).not.toContain(token);
      expect(Object.keys(evt.payload)).not.toContain('token');
    }
    // the created event from a real link likewise
    const evt = paymentLinkCreatedEvent(
      {
        linkId: LINK,
        orgId: ORG,
        receivableIds: [R1],
        mode: 'fixed',
        targetAmountMinor: Money.ofMinor(85_000, 'KES').amount,
        currency: 'KES',
        singleUse: false,
        allowPartial: false,
      },
      clock,
    );
    expect(JSON.stringify(evt, bigintSafe)).not.toContain(token);
  });

  it('payloads are JSON-serializable plain data (bigint amounts, ISO dates)', () => {
    for (const row of rows) {
      const evt = row.make();
      const wire = JSON.parse(JSON.stringify(evt, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
      expect(wire.name).toBe(row.name);
      expect(wire.version).toBe(1);
    }
  });
});
