import { describe, expect, it } from 'vitest';
import { DomainError, uuid } from '../shared';
import type { Uuid } from '../shared';
import { makeEnvelope, validateEnvelope, EVENT_NAME_PATTERN } from './envelope';
import type { DomainEvent } from './envelope';

const T0 = '2025-09-02T08:00:00.000Z';
const T0_MS = Date.UTC(2025, 8, 2, 8, 0, 0);

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
const correlation = rid(77);

const confirmed = () =>
  makeEnvelope(
    'payment.confirmed',
    { eventId: rid(41), aggregateId: payment, correlationId: correlation, occurredAt: new Date(T0_MS) },
    { paymentId: payment, confirmedMinor: 100000, externalRef: 'QK12HKXYZ', confirmedAt: T0 },
  );

describe('envelope — the stable wire contract (src/domain/events/README.md)', () => {
  it('makeEnvelope builds the full envelope: eventId, name, version 1, ISO occurredAt, aggregateId, correlationId, payload', () => {
    const event = confirmed();
    expect(Object.keys(event).sort()).toEqual(
      ['aggregateId', 'correlationId', 'eventId', 'name', 'occurredAt', 'payload', 'version'].sort(),
    );
    expect(event.name).toBe('payment.confirmed');
    expect(event.version).toBe(1);
    expect(event.eventId).toBe(rid(41));
    expect(event.aggregateId).toBe(payment);
    expect(event.correlationId).toBe(correlation);
    expect(event.occurredAt).toBe(T0); // Date from the injected Clock → ISO-8601 string
    expect(event.payload).toEqual({ paymentId: payment, confirmedMinor: 100000, externalRef: 'QK12HKXYZ', confirmedAt: T0 });
    expect(Object.isFrozen(event)).toBe(true); // events are immutable facts
  });

  it('occurredAt accepts a pre-formatted ISO-8601 string (adapters may have serialized already)', () => {
    const event = makeEnvelope(
      'receivable.settled',
      { eventId: rid(42), aggregateId: rid(3), occurredAt: T0 },
      { receivableId: rid(3), settledAt: T0 },
    );
    expect(event.occurredAt).toBe(T0);
    expect('correlationId' in event).toBe(false); // optional member stays absent, not undefined
  });

  it('the naming convention is `<context>.<aggregate><PastTenseVerb>` in camelCase, exactly one dot', () => {
    expect(EVENT_NAME_PATTERN.test('receivable.opened')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('invoicing.invoiceNumberAllocated')).toBe(true);
    expect(EVENT_NAME_PATTERN.test('payments.duplicateCallbackObserved')).toBe(true);
  });

  it.each([
    { name: 'noDot' },
    { name: 'receivable' },
    { name: '.opened' },
    { name: 'receivable.' },
    { name: 'a.b.c' },
    { name: 'Receivable.opened' }, // context must start lowercase
    { name: 'receivable.Opened' }, // aggregate+verb must start lowercase
    { name: 'receivable-opened' },
    { name: 'receivable.open ed' },
    { name: '' },
    { name: 'receivable..opened' },
  ])('malformed name $name → EVENT_NAME_MALFORMED', ({ name }) => {
    expectCode(
      () =>
        makeEnvelope(
          name as 'payment.confirmed', // structurally invalid — the runtime guard is the point
          { eventId: rid(43), aggregateId: payment, occurredAt: T0 },
          { paymentId: payment, confirmedMinor: 1, externalRef: 'x', confirmedAt: T0 },
        ),
      'EVENT_NAME_MALFORMED',
    );
  });

  it.each([{ name: 'invoice.paid' }, { name: 'ledger.entryPosted' }, { name: 'receivable.expired' }, { name: 'collections.caseClosed' }])(
    'well-formed but unknown name $name → EVENT_UNKNOWN',
    ({ name }) => {
      expectCode(
        () =>
          makeEnvelope(
            name as 'payment.confirmed', // runtime membership check is the point
            { eventId: rid(44), aggregateId: payment, occurredAt: T0 },
            { paymentId: payment, confirmedMinor: 1, externalRef: 'x', confirmedAt: T0 },
          ),
        'EVENT_UNKNOWN',
      );
    },
  );

  it.each([
    { field: 'eventId', patch: { eventId: 'not-a-uuid' } },
    { field: 'eventId', patch: { eventId: '00000000-0000-4000-8000-00000000000' } }, // 35 chars
    { field: 'aggregateId', patch: { aggregateId: 'payments' } },
    { field: 'correlationId', patch: { correlationId: '0000000-0000-4000-8000-000000000001' } },
  ])('invalid $field → EVENT_ID_INVALID (details names the field)', ({ field, patch }) => {
    expectCode(() => {
      const base = { eventId: rid(45), aggregateId: payment, correlationId: rid(46), occurredAt: T0 };
      makeEnvelope('payment.confirmed', { ...base, ...patch } as typeof base, {
        paymentId: payment,
        confirmedMinor: 1,
        externalRef: 'x',
        confirmedAt: T0,
      });
    }, 'EVENT_ID_INVALID');
    try {
      const base = { eventId: rid(45), aggregateId: payment, correlationId: rid(46), occurredAt: T0 };
      makeEnvelope('payment.confirmed', { ...base, ...patch } as typeof base, {
        paymentId: payment,
        confirmedMinor: 1,
        externalRef: 'x',
        confirmedAt: T0,
      });
    } catch (err) {
      expect((err as DomainError).details).toMatchObject({ field });
    }
  });

  it.each([
    { occurredAt: '2025-09-02 08:00:00' }, // space separator — not ISO
    { occurredAt: 'Sept 2, 2025' },
    { occurredAt: '2025-13-01T00:00:00.000Z' }, // parses as text, not as a date
    { occurredAt: '2025-09-02T08:00:00+0400' }, // offset needs the colon
    { occurredAt: 1756819200000 }, // epoch millis — never on the wire
    { occurredAt: new Date('not a date') },
  ])('invalid occurredAt $occurredAt → EVENT_OCCURRED_AT_INVALID', ({ occurredAt }) => {
    expectCode(
      () =>
        makeEnvelope(
          'payment.failed',
          { eventId: rid(47), aggregateId: payment, occurredAt: occurredAt as unknown as Date },
          { paymentId: payment, failureCode: 'CX103' },
        ),
      'EVENT_OCCURRED_AT_INVALID',
    );
  });

  describe('payload guards — narrow, serializable, ids only', () => {
    it.each([
      { label: 'undefined payload', payload: undefined, code: 'EVENT_PAYLOAD_REQUIRED' },
      { label: 'null payload', payload: null, code: 'EVENT_PAYLOAD_REQUIRED' },
      { label: 'array payload', payload: [], code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'string payload', payload: 'nope', code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'bigint amount (must use minorUnits)', payload: { paymentId: payment, confirmedMinor: 2n }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'NaN amount', payload: { paymentId: payment, confirmedMinor: NaN }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'Infinity amount', payload: { paymentId: payment, confirmedMinor: Infinity }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'function member', payload: { compute: () => 1 }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'symbol member', payload: { secret: Symbol('x') }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'undefined member (silently dropped by JSON)', payload: { hint: undefined }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'Date member (must be an ISO string)', payload: { when: new Date(T0_MS) }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'class instance member', payload: { money: new (class Money {})() }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'deeply nested bigint', payload: { nested: { list: [1, { bad: 2n }] } }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
    ])('$label → $code', ({ payload, code }) => {
      expectCode(
        () =>
          makeEnvelope(
            'payment.confirmed',
            { eventId: rid(48), aggregateId: payment, occurredAt: T0 },
            payload as unknown as { paymentId: Uuid; confirmedMinor: number; externalRef: string; confirmedAt: string },
          ),
        code,
      );
    });

    it('circular payload → EVENT_PAYLOAD_NOT_SERIALIZABLE', () => {
      const cyclic: Record<string, unknown> = { paymentId: payment, confirmedMinor: 1, externalRef: 'x', confirmedAt: T0 };
      cyclic.self = cyclic;
      expectCode(
        () =>
          makeEnvelope(
            'payment.confirmed',
            { eventId: rid(49), aggregateId: payment, occurredAt: T0 },
            cyclic as unknown as { paymentId: Uuid; confirmedMinor: number; externalRef: string; confirmedAt: string },
          ),
        'EVENT_PAYLOAD_NOT_SERIALIZABLE',
      );
    });

    it('serializable payloads pass untouched — arrays of strings and plain nested objects are fine', () => {
      const payload = { matchId: rid(5), paymentId: payment, declaredRefs: ['INV-1', 'R-2'], confidence: 'auto' as const };
      const event = makeEnvelope('reconciliation.paymentMatched', { eventId: rid(50), aggregateId: rid(5), occurredAt: T0 }, payload);
      expect(event.payload.declaredRefs).toEqual(['INV-1', 'R-2']);
    });

    it('the error names the offending path', () => {
      let threw = false;
      try {
        makeEnvelope(
          'payment.confirmed',
          { eventId: rid(51), aggregateId: payment, occurredAt: T0 },
          { paymentId: payment, confirmedMinor: 1, externalRef: 'x', confirmedAt: T0, extra: { deep: [0n] } } as never,
        );
      } catch (err) {
        threw = true;
        expect((err as DomainError).details).toMatchObject({ path: 'extra.deep[0]' });
      }
      expect(threw).toBe(true);
    });
  });

  describe('validateEnvelope — the outbox gatekeeper, also usable directly', () => {
    it('accepts every envelope built by makeEnvelope', () => {
      expect(() => validateEnvelope(confirmed())).not.toThrow();
      expect(() =>
        validateEnvelope(
          makeEnvelope('collections.promiseBroken', { eventId: rid(52), aggregateId: rid(10), occurredAt: T0 }, {
            promiseId: rid(11),
            caseId: rid(10),
            expectedAt: T0,
          }),
        ),
      ).not.toThrow();
    });

    it.each([
      { label: 'unknown name', patch: { name: 'invoice.paid' }, code: 'EVENT_UNKNOWN' },
      { label: 'malformed name', patch: { name: 'junk' }, code: 'EVENT_NAME_MALFORMED' },
      { label: 'version bumped to 2', patch: { version: 2 }, code: 'EVENT_VERSION_UNSUPPORTED' },
      { label: 'version 0', patch: { version: 0 }, code: 'EVENT_VERSION_UNSUPPORTED' },
      { label: 'bad eventId', patch: { eventId: 'nope' }, code: 'EVENT_ID_INVALID' },
      { label: 'bad aggregateId', patch: { aggregateId: 123 }, code: 'EVENT_ID_INVALID' },
      { label: 'bad correlationId', patch: { correlationId: {} }, code: 'EVENT_ID_INVALID' },
      { label: 'Date occurredAt (must be an ISO string in the envelope)', patch: { occurredAt: new Date(T0_MS) }, code: 'EVENT_OCCURRED_AT_INVALID' },
      { label: 'garbage occurredAt', patch: { occurredAt: 'yesterday' }, code: 'EVENT_OCCURRED_AT_INVALID' },
      { label: 'bigint payload', patch: { payload: { confirmedMinor: 2n } }, code: 'EVENT_PAYLOAD_NOT_SERIALIZABLE' },
      { label: 'missing payload', patch: { payload: undefined }, code: 'EVENT_PAYLOAD_REQUIRED' },
    ])('$label → $code', ({ patch, code }) => {
      expectCode(() => validateEnvelope({ ...confirmed(), ...patch } as unknown as DomainEvent), code);
    });
  });
});
