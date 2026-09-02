import { describe, expect, it } from 'vitest';
import { DomainError, uuid } from '../shared';
import type { Uuid } from '../shared';
import { makeEnvelope } from './envelope';
import {
  EVENT_NAMES,
  EVENT_VERSIONS,
  isEventName,
  minorUnits,
  type FuatiliaEvent,
  type EventName,
} from './catalog';

const T0 = '2025-09-02T08:00:00.000Z';
const DUE = '2025-10-01T00:00:00.000Z';

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

/** Wave-1 style assertion: the callable must throw DomainError with exactly this stable code. */
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

/** Aggregate id per owning aggregate (invoice, receivable, payment, match, …). */
const opts = (aggregateId: Uuid, eventId: Uuid = rid(90)) => ({ eventId, aggregateId, occurredAt: T0 });

const invoice = rid(1);
const customer = rid(2);
const receivable = rid(3);
const payment = rid(4);
const match = rid(5);
const creditNote = rid(6);
const application = rid(7);
const refund = rid(8);
const allocation = rid(9);
const kase = rid(10);
const promise = rid(11);

interface Row {
  readonly name: EventName;
  readonly aggregateId: Uuid;
  /** "Key payload" column of docs/04 — the exact payload key set. */
  readonly payloadKeys: readonly string[];
  readonly make: () => FuatiliaEvent;
}

const rows: readonly Row[] = [
  {
    name: 'invoicing.invoiceNumberAllocated', // E01
    aggregateId: invoice,
    payloadKeys: ['invoiceId', 'invoiceNumber', 'eTIMSRef'],
    make: () =>
      makeEnvelope('invoicing.invoiceNumberAllocated', opts(invoice), {
        invoiceId: invoice,
        invoiceNumber: 'INV-2025-0001',
        eTIMSRef: 'KE-etims-0001',
      }),
  },
  {
    name: 'invoicing.invoiceIssued', // E02
    aggregateId: invoice,
    payloadKeys: ['invoiceId', 'customerId', 'totalMinor', 'currency', 'dueDate'],
    make: () =>
      makeEnvelope('invoicing.invoiceIssued', opts(invoice), {
        invoiceId: invoice,
        customerId: customer,
        totalMinor: 125050,
        currency: 'KES',
        dueDate: DUE,
      }),
  },
  {
    name: 'invoicing.invoiceSent', // E03
    aggregateId: invoice,
    payloadKeys: ['invoiceId', 'channel', 'sentAt'],
    make: () => makeEnvelope('invoicing.invoiceSent', opts(invoice), { invoiceId: invoice, channel: 'email', sentAt: T0 }),
  },
  {
    name: 'invoicing.invoiceVoided', // E04
    aggregateId: invoice,
    payloadKeys: ['invoiceId', 'reason', 'actorId'],
    make: () =>
      makeEnvelope('invoicing.invoiceVoided', opts(invoice), {
        invoiceId: invoice,
        reason: 'issued in error',
        actorId: 'user-7',
      }),
  },
  {
    name: 'receivable.opened', // E05
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'invoiceId', 'originalMinor', 'dueDate'],
    make: () =>
      makeEnvelope('receivable.opened', opts(receivable), {
        receivableId: receivable,
        invoiceId: invoice,
        originalMinor: 125050,
        dueDate: DUE,
      }),
  },
  {
    name: 'receivable.partiallySettled', // E06
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'amountMinor', 'remainingMinor'],
    make: () =>
      makeEnvelope('receivable.partiallySettled', opts(receivable), {
        receivableId: receivable,
        amountMinor: 50000,
        remainingMinor: 75050,
      }),
  },
  {
    name: 'receivable.settled', // E07
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'settledAt'],
    make: () => makeEnvelope('receivable.settled', opts(receivable), { receivableId: receivable, settledAt: T0 }),
  },
  {
    name: 'receivable.overdue', // E08
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'daysLate', 'agingBucket'],
    make: () =>
      makeEnvelope('receivable.overdue', opts(receivable), { receivableId: receivable, daysLate: 47, agingBucket: '31-60' }),
  },
  {
    name: 'receivable.writtenOff', // E09
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'reason', 'approvedBy'],
    make: () =>
      makeEnvelope('receivable.writtenOff', opts(receivable), {
        receivableId: receivable,
        reason: 'debtor insolvent',
        approvedBy: 'finance-lead',
      }),
  },
  {
    name: 'receivable.recovered', // E10
    aggregateId: receivable,
    payloadKeys: ['receivableId', 'amountMinor'],
    make: () => makeEnvelope('receivable.recovered', opts(receivable), { receivableId: receivable, amountMinor: 25000 }),
  },
  {
    name: 'payment.initiated', // E11
    aggregateId: payment,
    payloadKeys: ['paymentId', 'channel', 'requestedMinor'],
    make: () =>
      makeEnvelope('payment.initiated', opts(payment), { paymentId: payment, channel: 'c2b', requestedMinor: 100000 }),
  },
  {
    name: 'payment.confirmed', // E12
    aggregateId: payment,
    payloadKeys: ['paymentId', 'confirmedMinor', 'externalRef', 'confirmedAt'],
    make: () =>
      makeEnvelope('payment.confirmed', opts(payment), {
        paymentId: payment,
        confirmedMinor: 100000,
        externalRef: 'QK12HKXYZ',
        confirmedAt: T0,
      }),
  },
  {
    name: 'payment.failed', // E13
    aggregateId: payment,
    payloadKeys: ['paymentId', 'failureCode'],
    make: () => makeEnvelope('payment.failed', opts(payment), { paymentId: payment, failureCode: 'CX103' }),
  },
  {
    name: 'payment.reversed', // E14
    aggregateId: payment,
    payloadKeys: ['paymentId', 'reason', 'reversalOf'],
    make: () =>
      makeEnvelope('payment.reversed', opts(payment), { paymentId: payment, reason: 'duplicate charge', reversalOf: rid(14) }),
  },
  {
    name: 'payments.duplicateCallbackObserved', // E15 (plural context — C5 tripwire)
    aggregateId: payment,
    payloadKeys: ['paymentId', 'externalRef', 'seenAt'],
    make: () =>
      makeEnvelope('payments.duplicateCallbackObserved', opts(payment), {
        paymentId: payment,
        externalRef: 'QK12HKXYZ',
        seenAt: T0,
      }),
  },
  {
    name: 'reconciliation.paymentMatched', // E16
    aggregateId: match,
    payloadKeys: ['matchId', 'paymentId', 'declaredRefs', 'confidence'],
    make: () =>
      makeEnvelope('reconciliation.paymentMatched', opts(match), {
        matchId: match,
        paymentId: payment,
        declaredRefs: ['INV-2025-0001'],
        confidence: 'auto',
      }),
  },
  {
    name: 'reconciliation.paymentPartiallyMatched', // E17
    aggregateId: match,
    payloadKeys: ['matchId', 'paymentId', 'explainedMinor'],
    make: () =>
      makeEnvelope('reconciliation.paymentPartiallyMatched', opts(match), {
        matchId: match,
        paymentId: payment,
        explainedMinor: 60000,
      }),
  },
  {
    name: 'reconciliation.matchReversed', // E18
    aggregateId: match,
    payloadKeys: ['matchId', 'reason'],
    make: () => makeEnvelope('reconciliation.matchReversed', opts(match), { matchId: match, reason: 'wrong payment' }),
  },
  {
    name: 'adjustment.creditNoteIssued', // E19
    aggregateId: creditNote,
    payloadKeys: ['creditNoteId', 'customerId', 'totalMinor'],
    make: () =>
      makeEnvelope('adjustment.creditNoteIssued', opts(creditNote), {
        creditNoteId: creditNote,
        customerId: customer,
        totalMinor: 30000,
      }),
  },
  {
    name: 'adjustment.creditNoteApplied', // E20
    aggregateId: creditNote,
    payloadKeys: ['applicationId', 'creditNoteId', 'receivableId', 'amountMinor'],
    make: () =>
      makeEnvelope('adjustment.creditNoteApplied', opts(creditNote), {
        applicationId: application,
        creditNoteId: creditNote,
        receivableId: receivable,
        amountMinor: 20000,
      }),
  },
  {
    name: 'adjustment.refundRequested', // E21
    aggregateId: refund,
    payloadKeys: ['refundId', 'paymentId', 'totalMinor', 'reason'],
    make: () =>
      makeEnvelope('adjustment.refundRequested', opts(refund), {
        refundId: refund,
        paymentId: payment,
        totalMinor: 15000,
        reason: 'service cancelled',
      }),
  },
  {
    name: 'adjustment.refundCompleted', // E22
    aggregateId: refund,
    payloadKeys: ['refundId', 'completedAt'],
    make: () => makeEnvelope('adjustment.refundCompleted', opts(refund), { refundId: refund, completedAt: T0 }),
  },
  {
    name: 'adjustment.creditBalanceApplied', // E23 (receivableId null — routed to balance, wave-1 #4)
    aggregateId: customer,
    payloadKeys: ['customerId', 'amountMinor', 'receivableId'],
    make: () =>
      makeEnvelope('adjustment.creditBalanceApplied', opts(customer), {
        customerId: customer,
        amountMinor: 10000,
        receivableId: null,
      }),
  },
  {
    name: 'allocation.executed', // E24
    aggregateId: allocation,
    payloadKeys: ['allocationId', 'sourceId', 'receivableId', 'amountMinor', 'strategy'],
    make: () =>
      makeEnvelope('allocation.executed', opts(allocation), {
        allocationId: allocation,
        sourceId: payment,
        receivableId: receivable,
        amountMinor: 80000,
        strategy: 'fifo',
      }),
  },
  {
    name: 'allocation.reversed', // E25
    aggregateId: allocation,
    payloadKeys: ['allocationId', 'reason', 'compensatingId'],
    make: () =>
      makeEnvelope('allocation.reversed', opts(allocation), {
        allocationId: allocation,
        reason: 'allocated to wrong invoice',
        compensatingId: rid(25),
      }),
  },
  {
    name: 'collections.caseOpened', // E26
    aggregateId: kase,
    payloadKeys: ['caseId', 'receivableId', 'trigger'],
    make: () =>
      makeEnvelope('collections.caseOpened', opts(kase), { caseId: kase, receivableId: receivable, trigger: 'overdue' }),
  },
  {
    name: 'collections.promiseBroken', // E27
    aggregateId: kase,
    payloadKeys: ['promiseId', 'caseId', 'expectedAt'],
    make: () =>
      makeEnvelope('collections.promiseBroken', opts(kase), { promiseId: promise, caseId: kase, expectedAt: T0 }),
  },
];

// Compile-time exhaustiveness: every one of the 27 catalog names has a fixture.
const COVERED: Record<EventName, true> = {
  'invoicing.invoiceNumberAllocated': true,
  'invoicing.invoiceIssued': true,
  'invoicing.invoiceSent': true,
  'invoicing.invoiceVoided': true,
  'receivable.opened': true,
  'receivable.partiallySettled': true,
  'receivable.settled': true,
  'receivable.overdue': true,
  'receivable.writtenOff': true,
  'receivable.recovered': true,
  'payment.initiated': true,
  'payment.confirmed': true,
  'payment.failed': true,
  'payment.reversed': true,
  'payments.duplicateCallbackObserved': true,
  'reconciliation.paymentMatched': true,
  'reconciliation.paymentPartiallyMatched': true,
  'reconciliation.matchReversed': true,
  'adjustment.creditNoteIssued': true,
  'adjustment.creditNoteApplied': true,
  'adjustment.refundRequested': true,
  'adjustment.refundCompleted': true,
  'adjustment.creditBalanceApplied': true,
  'allocation.executed': true,
  'allocation.reversed': true,
  'collections.caseOpened': true,
  'collections.promiseBroken': true,
};

describe('catalog — the 27 events of docs/04', () => {
  it('EVENT_NAMES is exactly the docs/04 catalog, in E01→E27 order, frozen', () => {
    expect([...EVENT_NAMES]).toEqual([
      'invoicing.invoiceNumberAllocated',
      'invoicing.invoiceIssued',
      'invoicing.invoiceSent',
      'invoicing.invoiceVoided',
      'receivable.opened',
      'receivable.partiallySettled',
      'receivable.settled',
      'receivable.overdue',
      'receivable.writtenOff',
      'receivable.recovered',
      'payment.initiated',
      'payment.confirmed',
      'payment.failed',
      'payment.reversed',
      'payments.duplicateCallbackObserved',
      'reconciliation.paymentMatched',
      'reconciliation.paymentPartiallyMatched',
      'reconciliation.matchReversed',
      'adjustment.creditNoteIssued',
      'adjustment.creditNoteApplied',
      'adjustment.refundRequested',
      'adjustment.refundCompleted',
      'adjustment.creditBalanceApplied',
      'allocation.executed',
      'allocation.reversed',
      'collections.caseOpened',
      'collections.promiseBroken',
    ]);
    expect(EVENT_NAMES).toHaveLength(27);
    expect(Object.isFrozen(EVENT_NAMES)).toBe(true);
  });

  it('the 27 names are unique and every name has exactly one fixture row (compile-time COVERED table)', () => {
    expect(new Set(EVENT_NAMES).size).toBe(27);
    expect(rows).toHaveLength(27);
    expect(new Set(rows.map((r) => r.name)).size).toBe(27);
    expect(rows.every((r) => COVERED[r.name] === true)).toBe(true);
  });

  it.each(rows)(
    '$name is constructible through makeEnvelope with a typed narrow payload (docs/04 keys, version 1)',
    ({ name, aggregateId, payloadKeys, make }) => {
      const event = make();
      expect(event.name).toBe(name);
      expect(event.version).toBe(1); // catalog ships at schema version 1
      expect(event.aggregateId).toBe(aggregateId);
      expect(event.occurredAt).toBe(T0); // ISO-8601 string on the wire
      expect(Object.keys(event).sort()).toEqual(
        ['aggregateId', 'eventId', 'name', 'occurredAt', 'payload', 'version'].sort(),
      );
      expect(Object.keys(event.payload).sort()).toEqual([...payloadKeys].sort());
      expect(Object.isFrozen(event)).toBe(true); // events are immutable facts
      expect(isEventName(event.name)).toBe(true);
    },
  );

  it('EVENT_VERSIONS pins every catalog event at schema version 1', () => {
    expect(Object.keys(EVENT_VERSIONS)).toHaveLength(27);
    for (const name of EVENT_NAMES) {
      expect(EVENT_VERSIONS[name]).toBe(1);
    }
    expect(Object.isFrozen(EVENT_VERSIONS)).toBe(true);
  });

  it('isEventName narrows to EventName for all 27 names and rejects everything else', () => {
    for (const name of EVENT_NAMES) {
      expect(isEventName(name)).toBe(true);
    }
    for (const junk of ['receivable.openedX', 'invoice.paid', 'PAYMENT.CONFIRMED', 'payment.confirmed ', '', 'a.b', null, 42, {}]) {
      expect(isEventName(junk)).toBe(false);
    }
  });

  it('wave-3 deferrals are NOT constructible — adding them later is purely additive', () => {
    const deferred = [
      'collections.promiseToPayMade',
      'collections.caseClosed',
      'intelligence.priorityComputed',
      'intelligence.feedbackRecorded',
      'notifications.dunningSent',
      'consent.granted',
      'consent.revoked',
    ] as const;
    for (const name of deferred) {
      expect(isEventName(name)).toBe(false);
      expectCode(
        () =>
          // deliberately outside the catalog — the generic must not let it through at runtime
          makeEnvelope(name as unknown as EventName, opts(receivable), { receivableId: receivable } as never),
        'EVENT_UNKNOWN',
      );
    }
  });

  describe('minorUnits — safe-integer guard for minor-unit payload values (wave-1 parity)', () => {
    it.each([
      { input: 500, expected: 500 },
      { input: 0, expected: 0 },
      { input: Number.MAX_SAFE_INTEGER, expected: Number.MAX_SAFE_INTEGER },
      { input: 500n, expected: 500 },
      { input: 0n, expected: 0 },
    ])('accepts $input → $expected', ({ input, expected }) => {
      expect(minorUnits(input)).toBe(expected);
    });

    it.each([
      { input: 2 ** 53 }, // first unsafe integer
      { input: -(2 ** 53) },
      { input: 1.5 },
      { input: NaN },
      { input: Infinity },
      { input: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    ])('refuses $input with EVENT_AMOUNT_NOT_SAFE_INTEGER (no silent precision loss)', ({ input }) => {
      expectCode(() => minorUnits(input), 'EVENT_AMOUNT_NOT_SAFE_INTEGER');
    });
  });
});
