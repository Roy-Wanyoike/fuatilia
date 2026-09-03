import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import {
  assertMemoryFacts,
  DAY_MS,
  ISO_PATTERN,
  wholeDaysBetween,
  type MemoryFact,
} from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(1);
let seq = 100;

/** Next fresh evidence anchor. */
const ev = (): Uuid => uid(++seq);

const at = (iso: string) => iso;

const invoiceIssued = (overrides: Partial<MemoryFact> = {}): MemoryFact => ({
  eventId: ev(),
  customerId: CUSTOMER,
  at: at('2026-01-01T09:00:00.000Z'),
  type: 'invoice_issued',
  invoiceId: uid(10),
  currency: 'KES',
  totalMinor: 120_000,
  ...overrides,
} as MemoryFact);

const paymentReceived = (overrides: Partial<MemoryFact> = {}): MemoryFact => ({
  eventId: ev(),
  customerId: CUSTOMER,
  at: at('2026-01-10T09:00:00.000Z'),
  type: 'payment_received',
  paymentId: uid(20),
  invoiceId: null,
  currency: 'KES',
  amountMinor: 60_000,
  ...overrides,
} as MemoryFact);

/** One fact of EVERY v1 type — the smallest history that exercises all gates. */
const everyFactType = (): MemoryFact[] => [
  invoiceIssued(),
  paymentReceived(),
  {
    eventId: ev(), customerId: CUSTOMER, at: '2026-01-11T09:00:00.000Z',
    type: 'allocation_applied', receivableId: uid(30), currency: 'KES', amountMinor: 50_000,
  },
  {
    eventId: ev(), customerId: CUSTOMER, at: '2026-01-02T09:00:00.000Z',
    type: 'receivable_opened', receivableId: uid(30), currency: 'KES', amountMinor: 120_000,
    dueDate: '2026-01-20T00:00:00.000Z',
  },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-12T09:00:00.000Z', type: 'receivable_settled', receivableId: uid(30) },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-05T09:00:00.000Z', type: 'promise_outcome', promiseId: uid(40), outcome: 'kept' },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-06T09:00:00.000Z', type: 'message_exchanged', channel: 'whatsapp', direction: 'inbound' },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-06T10:00:00.000Z', type: 'consent_changed', channel: 'whatsapp', status: 'granted' },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-07T09:00:00.000Z', type: 'dispute_opened', disputeId: uid(50), receivableId: null },
  { eventId: ev(), customerId: CUSTOMER, at: '2026-01-08T09:00:00.000Z', type: 'dispute_resolved', disputeId: uid(50) },
];

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const detailsOf = (fn: () => unknown): Record<string, unknown> => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.details ?? {};
    throw error;
  }
  throw new Error('expected a DomainError, but nothing was thrown');
};

// --- acceptance -------------------------------------------------------------

describe('assertMemoryFacts — acceptance', () => {
  it('accepts a history containing every v1 fact type', () => {
    expect(() => assertMemoryFacts(everyFactType())).not.toThrow();
  });

  it('accepts every documented ISO-8601 zone form on `at`', () => {
    const table = [
      '2026-03-02T08:00:00.000Z',
      '2026-03-02T08:00:00Z',
      '2026-03-02T08:00:00.123Z',
      '2026-03-02T11:00:00+03:00',
      '2026-03-01T23:00:00-05:00',
    ];
    table.forEach((timestamp, i) => {
      expect(() => assertMemoryFacts([invoiceIssued({ at: timestamp })]), `row ${i}`).not.toThrow();
    });
  });

  it('accepts optional ids as absent, null, or UUID-shaped', () => {
    const table: { label: string; fact: MemoryFact }[] = [
      { label: 'undefined invoiceId', fact: paymentReceived({ invoiceId: undefined }) },
      { label: 'null invoiceId', fact: paymentReceived({ invoiceId: null }) },
      { label: 'shaped invoiceId', fact: paymentReceived({ invoiceId: uid(77) }) },
      { label: 'null receivableId on dispute', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-07T09:00:00.000Z', type: 'dispute_opened', disputeId: uid(50), receivableId: null } },
    ];
    table.forEach(({ label, fact }) => {
      expect(() => assertMemoryFacts([fact]), label).not.toThrow();
    });
  });

  it('does not mutate the supplied history (frozen-input pin)', () => {
    const facts = everyFactType().map((fact) => Object.freeze({ ...fact }));
    const before = JSON.stringify(facts);
    Object.freeze(facts);
    expect(() => assertMemoryFacts(facts)).not.toThrow();
    expect(JSON.stringify(facts)).toBe(before);
  });
});

// --- rejection tables ---------------------------------------------------------

describe('assertMemoryFacts — rejection tables', () => {
  it('refuses a non-array history with MEM_FACT_REQUIRED', () => {
    const table = [null, undefined, 'facts', 42, {}, new Map()];
    table.forEach((facts) => {
      expectCode(() => assertMemoryFacts(facts as unknown as MemoryFact[]), 'MEM_FACT_REQUIRED');
    });
  });

  it('refuses non-object rows with MEM_FACT_INVALID', () => {
    const table = [null, 42, 'invoice_issued', [], true];
    table.forEach((row) => {
      const details = detailsOf(() => assertMemoryFacts([row as unknown as MemoryFact]));
      expect(details).toMatchObject({ index: 0, field: '(root)' });
      expectCode(() => assertMemoryFacts([row as unknown as MemoryFact]), 'MEM_FACT_INVALID');
    });
  });

  it('refuses unknown fact types with MEM_FACT_UNKNOWN_TYPE', () => {
    const details = detailsOf(() =>
      assertMemoryFacts([invoiceIssued({ type: 'telepathy' as unknown as 'invoice_issued' })]),
    );
    expect(details).toMatchObject({ index: 0 });
    expectCode(
      () => assertMemoryFacts([invoiceIssued({ type: 'telepathy' as unknown as 'invoice_issued' })]),
      'MEM_FACT_UNKNOWN_TYPE',
    );
  });

  it('refuses a duplicated evidence anchor with MEM_FACT_DUPLICATE_EVENT_ID — even across types', () => {
    const shared = ev();
    const facts: MemoryFact[] = [
      invoiceIssued({ eventId: shared }),
      paymentReceived({ eventId: shared }),
    ];
    const details = detailsOf(() => assertMemoryFacts(facts));
    expect(details).toMatchObject({ index: 1, eventId: shared });
    expectCode(() => assertMemoryFacts(facts), 'MEM_FACT_DUPLICATE_EVENT_ID');
  });

  it('refuses malformed opaque ids (UUID-shape gate) with MEM_FACT_INVALID', () => {
    const badIds = ['', '   ', 'customer-1', '00000000-0000-4000-8000-1', 42, null, {}, '000000000000000000000000000000000000'.slice(0, 35)];
    badIds.forEach((bad) => {
      const details = detailsOf(() => assertMemoryFacts([invoiceIssued({ eventId: bad as unknown as Uuid })]));
      expect(details).toMatchObject({ index: 0, field: 'eventId' });
      expectCode(() => assertMemoryFacts([invoiceIssued({ eventId: bad as unknown as Uuid })]), 'MEM_FACT_INVALID');
    });
  });

  it('refuses a malformed customerId with MEM_FACT_INVALID', () => {
    const details = detailsOf(() => assertMemoryFacts([invoiceIssued({ customerId: 'cust_1' as unknown as Uuid })]));
    expect(details).toMatchObject({ index: 0, field: 'customerId' });
  });

  it('refuses zoneless / non-ISO timestamps with MEM_FACT_INVALID (never guessed)', () => {
    const table = ['', '2026-03-02', '2026-03-02T08:00:00', '2026-03-02 08:00:00Z', 'yesterday', 1730000000000, null];
    table.forEach((bad) => {
      const details = detailsOf(() => assertMemoryFacts([invoiceIssued({ at: bad as unknown as string })]));
      expect(details).toMatchObject({ index: 0, field: 'at' });
    });
  });

  it('refuses unknown currencies with MEM_CURRENCY_INVALID (shared whitelist)', () => {
    const table = ['XYZ', 'kes', 'KES!', '', 42, null];
    table.forEach((bad) => {
      const details = detailsOf(() => assertMemoryFacts([invoiceIssued({ currency: bad as unknown as 'KES' })]));
      expect(details).toMatchObject({ index: 0, field: 'currency' });
      expectCode(() => assertMemoryFacts([invoiceIssued({ currency: bad as unknown as 'KES' })]), 'MEM_CURRENCY_INVALID');
    });
  });
});

describe('assertMemoryFacts — per-type field gates', () => {
  interface Row {
    readonly label: string;
    readonly fact: MemoryFact;
    readonly code: string;
    readonly field: string;
  }

  const table: Row[] = [
    { label: 'invoice_issued without invoiceId', fact: invoiceIssued({ invoiceId: '' as unknown as Uuid }), code: 'MEM_FACT_INVALID', field: 'invoiceId' },
    { label: 'invoice_issued with negative total', fact: invoiceIssued({ totalMinor: -1 }), code: 'MEM_FACT_INVALID', field: 'totalMinor' },
    { label: 'invoice_issued with fractional total', fact: invoiceIssued({ totalMinor: 10.5 }), code: 'MEM_FACT_INVALID', field: 'totalMinor' },
    { label: 'invoice_issued with unsafe total', fact: invoiceIssued({ totalMinor: Number.MAX_SAFE_INTEGER + 1 }), code: 'MEM_FACT_INVALID', field: 'totalMinor' },
    { label: 'payment_received with malformed optional invoiceId', fact: paymentReceived({ invoiceId: 'inv-9' as unknown as Uuid }), code: 'MEM_FACT_INVALID', field: 'invoiceId' },
    { label: 'payment_received with negative amount', fact: paymentReceived({ amountMinor: -100 }), code: 'MEM_FACT_INVALID', field: 'amountMinor' },
    { label: 'payment_received with bad currency', fact: paymentReceived({ currency: 'GBP!' as unknown as 'KES' }), code: 'MEM_CURRENCY_INVALID', field: 'currency' },
    { label: 'allocation_applied without receivableId', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-11T09:00:00.000Z', type: 'allocation_applied', receivableId: null as unknown as Uuid, currency: 'KES', amountMinor: 1 }, code: 'MEM_FACT_INVALID', field: 'receivableId' },
    { label: 'receivable_opened with zoneless dueDate', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-02T09:00:00.000Z', type: 'receivable_opened', receivableId: uid(31), currency: 'KES', amountMinor: 1, dueDate: '2026-01-20' }, code: 'MEM_FACT_INVALID', field: 'dueDate' },
    { label: 'receivable_settled without receivableId', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-12T09:00:00.000Z', type: 'receivable_settled', receivableId: undefined as unknown as Uuid }, code: 'MEM_FACT_INVALID', field: 'receivableId' },
    { label: 'promise_outcome with unknown outcome', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-05T09:00:00.000Z', type: 'promise_outcome', promiseId: uid(41), outcome: 'delayed' as unknown as 'kept' }, code: 'MEM_FACT_INVALID', field: 'outcome' },
    { label: 'message_exchanged with blank channel', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-06T09:00:00.000Z', type: 'message_exchanged', channel: '  ', direction: 'inbound' }, code: 'MEM_FACT_INVALID', field: 'channel' },
    { label: 'message_exchanged with unknown direction', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-06T09:00:00.000Z', type: 'message_exchanged', channel: 'sms', direction: 'sideways' as unknown as 'inbound' }, code: 'MEM_FACT_INVALID', field: 'direction' },
    { label: 'consent_changed with unknown status', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-06T10:00:00.000Z', type: 'consent_changed', channel: 'sms', status: 'maybe' as unknown as 'granted' }, code: 'MEM_FACT_INVALID', field: 'status' },
    { label: 'dispute_opened with malformed optional receivableId', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-07T09:00:00.000Z', type: 'dispute_opened', disputeId: uid(51), receivableId: 'rcv-2' as unknown as Uuid }, code: 'MEM_FACT_INVALID', field: 'receivableId' },
    { label: 'dispute_resolved without disputeId', fact: { eventId: ev(), customerId: CUSTOMER, at: '2026-01-08T09:00:00.000Z', type: 'dispute_resolved', disputeId: '' as unknown as Uuid }, code: 'MEM_FACT_INVALID', field: 'disputeId' },
  ];

  table.forEach(({ label, fact, code, field }) => {
    it(`refuses ${label} (${code})`, () => {
      const details = detailsOf(() => assertMemoryFacts([fact]));
      expect(details).toMatchObject({ index: 0, field });
      expectCode(() => assertMemoryFacts([fact]), code);
    });
  });

  it('pins the failing row index for multi-fact histories', () => {
    const details = detailsOf(() =>
      assertMemoryFacts([invoiceIssued(), paymentReceived({ amountMinor: -5 })]),
    );
    expect(details).toMatchObject({ index: 1, field: 'amountMinor' });
  });
});

// --- time helpers -------------------------------------------------------------

describe('wholeDaysBetween — UTC-day arithmetic table', () => {
  it('floors whole days and clamps negatives to 0', () => {
    const from = '2026-03-01T00:00:00.000Z';
    const table: [string, number][] = [
      ['2026-03-01T00:00:00.000Z', 0], // same instant
      ['2026-03-01T23:59:59.999Z', 0], // a partial day is not a day
      ['2026-03-02T00:00:00.000Z', 1], // exactly one day
      ['2026-03-03T12:00:00.000Z', 2], // 2.5 days floors to 2
      ['2026-02-28T00:00:00.000Z', 0], // "before" clamps at 0 — never negative
    ];
    table.forEach(([to, expected]) => {
      expect(wholeDaysBetween(from, to)).toBe(expected);
    });
  });

  it('is exact across a DST-affected wall-clock month (UTC discipline)', () => {
    // 2026-03-08 is the US DST switch; UTC-day math is unaffected.
    const days = wholeDaysBetween('2026-03-01T00:00:00.000Z', '2026-03-31T00:00:00.000Z');
    expect(days).toBe(30);
    expect(days * DAY_MS).toBe(30 * 86_400_000);
  });

  it('matches the shared ISO_PATTERN (timestamp contract pin)', () => {
    expect(ISO_PATTERN.test('2026-03-02T08:00:00.000Z')).toBe(true);
    expect(ISO_PATTERN.test('2026-03-02T08:00:00')).toBe(false);
  });
});
