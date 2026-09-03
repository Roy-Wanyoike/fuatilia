import { describe, expect, it, vi } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { memorySnapshot, type CustomerMemory } from './snapshot';
import { MEMORY_CLAIMS, type Claim } from './claims';
import {
  memoryEvent,
  memoryEventAt,
  readClock,
  snapshotTakenEvent,
  type BehaviorChangedPayload,
  type MemoryEvent,
  type SnapshotTakenPayload,
} from './events';
import { diffProfiles, type DiffResult } from './diff';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(1);
const BEFORE_AS_OF = '2026-01-01T00:00:00.000Z';
const AFTER_AS_OF = '2026-04-01T00:00:00.000Z';
const CLOCK_ISO = '2026-04-02T12:00:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };

let seq = 4000;
const ev = (): Uuid => uid(++seq);

const issuedFact = (): MemoryFactOfSnapshot => ({
  eventId: ev(), customerId: CUSTOMER, at: '2025-12-01T00:00:00.000Z',
  type: 'invoice_issued', invoiceId: uid(++seq), currency: 'KES', totalMinor: 100_000,
});
type MemoryFactOfSnapshot = Parameters<typeof memorySnapshot>[0][number];

const paidFact = (invoiceId: Uuid, days: number): MemoryFactOfSnapshot => ({
  eventId: ev(), customerId: CUSTOMER,
  at: new Date(Date.parse('2025-12-01T00:00:00.000Z') + days * 86_400_000 + 12 * 3_600_000).toISOString(),
  type: 'payment_received', paymentId: uid(++seq), invoiceId, currency: 'KES', amountMinor: 100_000,
});

const snapshotTaken = (memory: CustomerMemory): MemoryEvent<'memory.snapshotTaken', SnapshotTakenPayload> =>
  snapshotTakenEvent(memory, clock);

const memoryWithClaims = (claims: Claim[]): CustomerMemory => ({
  customerId: CUSTOMER, asOf: AFTER_AS_OF, claims, factCount: 3,
});

const cadenceClaim = (median: number): Claim => ({
  claim: MEMORY_CLAIMS.cadence,
  value: { sampleCount: 2, minDaysToPay: 2, medianDaysToPay: median, p90DaysToPay: 3 },
  computedFrom: [ev()],
  asOf: AFTER_AS_OF,
});

const crossedDiff = (): DiffResult =>
  diffProfiles(
    memoryWithClaims([cadenceClaim(2)]), // BEFORE: pays in 2 days…
    { ...memoryWithClaims([cadenceClaim(9)]), asOf: AFTER_AS_OF }, // …AFTER: 9 days → deteriorating
    clock,
  );

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- memory.snapshotTaken -------------------------------------------------------

describe('memory.snapshotTaken — envelope + payload', () => {
  it('wraps a projected memory in the repo envelope with a Clock-stamped occurredAt', () => {
    const inv = uid(++seq);
    const memory = memorySnapshot(
      [
        { eventId: ev(), customerId: CUSTOMER, at: '2025-12-01T00:00:00.000Z', type: 'invoice_issued', invoiceId: inv, currency: 'KES', totalMinor: 100_000 },
        paidFact(inv, 2),
        paidFact(inv, 3),
      ],
      AFTER_AS_OF,
    ).customers[0] as CustomerMemory;
    const event = snapshotTaken(memory);
    expect(event).toEqual({
      name: 'memory.snapshotTaken',
      version: 1,
      aggregateId: CUSTOMER,
      occurredAt: CLOCK_ISO,
      payload: {
        customerId: CUSTOMER,
        asOf: AFTER_AS_OF,
        claimCount: 2,
        claims: ['payment.cadence', 'payment.sizeBands'],
        factCount: 3,
      },
    });
  });

  it('reports zero claims for a claim-less memory (honest silence on the wire)', () => {
    const event = snapshotTaken(memoryWithClaims([]));
    expect(event.payload).toEqual({ customerId: CUSTOMER, asOf: AFTER_AS_OF, claimCount: 0, claims: [], factCount: 3 });
  });

  it('stamps occurredAt from exactly one clock read', () => {
    const now = vi.fn(() => new Date(CLOCK_ISO));
    snapshotTakenEvent(memoryWithClaims([]), { now });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('is JSON-serializable (no Dates, no bigints, no functions)', () => {
    const event = snapshotTaken(memoryWithClaims([cadenceClaim(5)]));
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});

// --- memory.behaviorChanged ---------------------------------------------------------

describe('memory.behaviorChanged — envelope + payload', () => {
  it('carries only the crossed dimensions with their evidence, version 1', () => {
    const event = crossedDiff().event;
    expect(event?.name).toBe('memory.behaviorChanged');
    expect(event?.version).toBe(1);
    expect(event?.aggregateId).toBe(CUSTOMER);
    expect(event?.occurredAt).toBe(CLOCK_ISO);
    const payload = event?.payload as BehaviorChangedPayload;
    expect(payload.customerId).toBe(CUSTOMER);
    expect(payload.asOf).toBe(AFTER_AS_OF);
    expect(payload.changes).toEqual([{
      dimension: 'payment_cadence',
      direction: 'deteriorating',
      before: 2,
      after: 9,
      threshold: 3,
      reason: 'median days-to-pay worsened from 2 to 9 (threshold 3 days)',
    }]);
    expect(payload.evidenceRefs.length).toBeGreaterThan(0);
    expect(payload.changes[0]).not.toHaveProperty('currency'); // exposure-only field
  });

  it('is JSON-serializable and round-trips byte-identical', () => {
    const event = crossedDiff().event as MemoryEvent<'memory.behaviorChanged', BehaviorChangedPayload>;
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('excludes exposure currency keys on non-exposure rows and includes them on exposure rows', () => {
    const result = diffProfiles(
      { customerId: CUSTOMER, asOf: BEFORE_AS_OF, claims: [], factCount: 0 },
      {
        customerId: CUSTOMER, asOf: AFTER_AS_OF, factCount: 1,
        claims: [{
          claim: MEMORY_CLAIMS.exposure,
          value: { currencies: [{ currency: 'KES', openReceivables: 1, openMinor: 900_000, aging: [] }] },
          computedFrom: [ev()],
          asOf: AFTER_AS_OF,
        }],
      },
      clock,
    );
    const payload = result.event?.payload as BehaviorChangedPayload;
    expect(payload.changes[0]).toMatchObject({ dimension: 'exposure', currency: 'KES', before: 0, after: 900_000 });
  });
});

// --- event factory internals --------------------------------------------------------

describe('memory event factory — clock discipline', () => {
  it('refuses a broken clock with MEM_CLOCK_INVALID', () => {
    const broken: unknown[] = [
      { now: () => 'nope' },
      { now: () => new Date(Number.NaN) },
      null,
      undefined,
    ];
    broken.forEach((bad) => {
      expectCode(() => memoryEvent('memory.snapshotTaken', CUSTOMER, {}, bad as Clock), 'MEM_CLOCK_INVALID');
    });
  });

  it('reads the clock exactly once per event', () => {
    const now = vi.fn(() => new Date(CLOCK_ISO));
    memoryEvent('memory.snapshotTaken', CUSTOMER, {}, { now });
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('normalizes the Date to an ISO-8601 string', () => {
    const event = memoryEvent('memory.snapshotTaken', CUSTOMER, {}, clock);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(typeof event.occurredAt).toBe('string');
  });

  it('accepts a pre-read instant via memoryEventAt (one-clock-read composition)', () => {
    const now = vi.fn(() => new Date(CLOCK_ISO));
    const occurredAt = readClock({ now });
    expect(now).toHaveBeenCalledTimes(1);
    const event = memoryEventAt('memory.behaviorChanged', CUSTOMER, { changes: [] }, occurredAt);
    expect(now).toHaveBeenCalledTimes(1); // no second read at event build time
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload).toEqual({ changes: [] });
  });

  it('refuses a non-Date instant in memoryEventAt', () => {
    expectCode(
      // @ts-expect-error — deliberately malformed input
      () => memoryEventAt('memory.snapshotTaken', CUSTOMER, {}, '2026-04-02T12:00:00.000Z'),
      'MEM_CLOCK_INVALID',
    );
  });
});
