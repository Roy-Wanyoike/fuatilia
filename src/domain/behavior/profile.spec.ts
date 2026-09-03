import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import {
  buildBehaviorProfile,
  medianOf,
  percentileOf,
  utcDaysBetween,
  DAY_MS,
  type AllocationFact,
  type BehaviorFacts,
  type CommunicationFact,
  type DisputeFact,
  type PaymentFact,
  type PromiseFact,
} from './profile';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);

const AS_OF = '2026-04-01T00:00:00.000Z';
const asOfDate = new Date(AS_OF);
const dateAt = (iso: string): Date => new Date(iso);

const DAY = DAY_MS;
/** `2026-01-10` + dayOffset whole UTC days (+ time-of-day ms, default noon). */
const ts = (baseIso: string, dayOffset: number, timeOfDayMs = 12 * 3600_000): string =>
  new Date(Date.parse(baseIso) + dayOffset * DAY + timeOfDayMs).toISOString();
const BASE = '2026-01-10';

let seq = 0;
const payment = (overrides: Partial<PaymentFact> & { due: string; settled: string }): PaymentFact => {
  const { due, settled, ...rest } = overrides;
  return {
    paymentId: uid(100 + ++seq),
    receivableId: RECEIVABLE,
    amountMinor: 100_000,
    dueDate: due,
    settledAt: settled,
    partial: false,
    ...rest,
  };
};
const promise = (overrides: Partial<PromiseFact>): PromiseFact => ({
  promiseId: uid(200 + ++seq),
  receivableId: RECEIVABLE,
  promisedDate: ts(BASE, 30),
  outcome: 'kept',
  resolvedAt: ts(BASE, 25),
  ...overrides,
});
const dispute = (overrides: Partial<DisputeFact>): DisputeFact => ({
  disputeId: uid(300 + ++seq),
  receivableId: RECEIVABLE,
  openedAt: ts(BASE, 0),
  resolvedAt: null,
  ...overrides,
});
const comm = (overrides: Partial<CommunicationFact>): CommunicationFact => ({
  messageId: uid(400 + ++seq),
  channel: 'whatsapp',
  direction: 'outbound',
  sentAt: ts(BASE, 1),
  ...overrides,
});
const allocation = (overrides: Partial<AllocationFact>): AllocationFact => ({
  allocationId: uid(500 + ++seq),
  paymentId: uid(600 + ++seq),
  receivableId: RECEIVABLE,
  amountMinor: 40_000,
  allocatedAt: ts(BASE, 5),
  ...overrides,
});

/** A payment settled `days` (integer UTC days) after its due date (due 00:00Z, settled 12:00Z). */
const paying = (days: number, settledBase = BASE): PaymentFact =>
  payment({ due: ts(settledBase, 0, 0), settled: ts(settledBase, days) });

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

// --- order statistics --------------------------------------------------------

describe('behavior cadence order statistics', () => {
  it('medianOf: empty → null, odd → middle, even → mean of middles', () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([9])).toBe(9);
    expect(medianOf([2, 5, 9])).toBe(5);
    expect(medianOf([2, 5, 9, 12])).toBe(7);
    expect(medianOf([4, 4])).toBe(4);
  });

  it('percentileOf p90 (R-7 linear interpolation) table incl. single-value and bounds', () => {
    expect(percentileOf([], 0.9)).toBeNull();
    expect(percentileOf([4], 0.9)).toBe(4);
    expect(percentileOf([10, 20], 0.9)).toBe(19); // h = 0.9 → 10 + 0.9·10
    expect(percentileOf([1, 2, 3], 0.9)).toBe(2.8); // h = 1.8 → 2 + 0.8·1
    expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9.1); // h = 8.1
    expect(percentileOf([3, 1, 2], 0)).toBe(1);
    expect(percentileOf([3, 1, 2], 1)).toBe(3);
    expect(() => percentileOf([1], 1.01)).toThrowError();
    expectCode(() => percentileOf([1], -0.1), 'BEHAV_PERCENTILE_INVALID');
  });

  it('utcDaysBetween is integer UTC-day arithmetic: ±1ms across midnight flips the day', () => {
    const due = Date.parse('2026-03-10T00:00:00.000Z');
    expect(utcDaysBetween(due, Date.parse('2026-03-10T23:59:59.999Z'))).toBe(0);
    expect(utcDaysBetween(due, Date.parse('2026-03-10T00:00:00.000Z'))).toBe(0);
    expect(utcDaysBetween(due, Date.parse('2026-03-11T00:00:00.000Z'))).toBe(1);
    expect(utcDaysBetween(due, Date.parse('2026-03-09T23:59:59.999Z'))).toBe(-1);
  });

  it('UTC day indexing is DST-free (crosses a real DST transition with no skew)', () => {
    // US spring-forward 2026-03-08 — calendar-day gap via UTC day index stays exact
    expect(utcDaysBetween(Date.parse('2026-03-07T23:00:00.000Z'), Date.parse('2026-03-08T23:00:00.000Z'))).toBe(1);
    expect(utcDaysBetween(Date.parse('2026-03-07T12:00:00.000Z'), Date.parse('2026-03-10T12:00:00.000Z'))).toBe(3);
  });
});

// --- the profile -------------------------------------------------------------

describe('buildBehaviorProfile — empty history', () => {
  it('produces a valid, claim-less profile (no fabricated numbers)', () => {
    const profile = buildBehaviorProfile(ORG, CUSTOMER, {}, asOfDate);
    expect(profile.orgId).toBe(ORG);
    expect(profile.customerId).toBe(CUSTOMER);
    expect(profile.asOf).toBe(AS_OF);
    expect(profile.paymentCadence).toEqual({
      count: 0,
      minDaysToPay: null,
      medianDaysToPay: null,
      p90DaysToPay: null,
      onTimeCount: 0,
      lateCount: 0,
      partialCount: 0,
      evidence: [],
    });
    expect(profile.promiseReliability).toEqual({
      keptCount: 0,
      brokenCount: 0,
      expiredCount: 0,
      pendingCount: 0,
      decidedCount: 0,
      reliabilityRate: null,
      evidence: [],
    });
    expect(profile.disputeHistory).toEqual({ totalCount: 0, resolvedCount: 0, openCount: 0, currentlyOpen: false, evidence: [] });
    expect(profile.communications).toEqual({ byChannel: [], inboundTotal: 0, outboundTotal: 0, responseRate: null, evidence: [] });
    expect(profile.allocations).toEqual({ count: 0, totalAmountMinor: 0, evidence: [] });
    expect(profile.lastActivityAt).toBeNull();
  });
});

describe('buildBehaviorProfile — payment cadence', () => {
  it('computes count/min/median/p90 over integer days-to-pay (odd, even, early payments)', () => {
    const facts: BehaviorFacts = {
      payments: [
        paying(9), // 2026-01-19
        paying(2), // 2026-01-12
        paying(5), // 2026-01-15
        paying(-3, '2026-02-01'), // early
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    // sorted days: [-3, 2, 5, 9] → median (2+5)/2 = 3.5, p90 h=2.7 → 5 + 0.7·4 = 7.8
    expect(profile.paymentCadence.count).toBe(4);
    expect(profile.paymentCadence.minDaysToPay).toBe(-3);
    expect(profile.paymentCadence.medianDaysToPay).toBe(3.5);
    expect(profile.paymentCadence.p90DaysToPay).toBe(7.8);
    expect(profile.paymentCadence.onTimeCount).toBe(1); // early ≤ 0
    expect(profile.paymentCadence.lateCount).toBe(3);
    expect(profile.paymentCadence.partialCount).toBe(0);
    expect(profile.paymentCadence.evidence).toHaveLength(4);
    expect(profile.paymentCadence.evidence.map((e) => e.kind)).toEqual(['payment', 'payment', 'payment', 'payment']);
  });

  it('counts partial payments flagged by the adapter', () => {
    const facts: BehaviorFacts = {
      payments: [paying(1), payment({ due: ts(BASE, 0, 0), settled: ts(BASE, 4), partial: true }), payment({ due: ts(BASE, 0, 0), settled: ts(BASE, 6), partial: true })],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.paymentCadence.partialCount).toBe(2);
    expect(profile.paymentCadence.count).toBe(3);
  });

  it('day-boundary table: 23:59:59.999 vs 00:00:00.000 around the due date (±1ms)', () => {
    const facts: BehaviorFacts = {
      payments: [
        payment({ due: '2026-03-10T00:00:00.000Z', settled: '2026-03-10T23:59:59.999Z' }), // 0
        payment({ due: '2026-03-10T00:00:00.000Z', settled: '2026-03-11T00:00:00.000Z' }), // 1
        payment({ due: '2026-03-10T00:00:00.000Z', settled: '2026-03-10T00:00:00.000Z' }), // 0
        payment({ due: '2026-03-10T00:00:00.000Z', settled: '2026-03-09T23:59:59.999Z' }), // −1
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.paymentCadence.onTimeCount).toBe(3);
    expect(profile.paymentCadence.lateCount).toBe(1);
    expect(profile.paymentCadence.minDaysToPay).toBe(-1);
    expect(profile.paymentCadence.medianDaysToPay).toBe(0); // [−1, 0, 0, 1] → (0+0)/2
  });

  it('point-in-time: a payment settled exactly at asOf counts; 1ms later does not', () => {
    const boundary = ts(BASE, 20, 0);
    const facts: BehaviorFacts = {
      payments: [
        payment({ due: ts(BASE, 0, 0), settled: boundary }), // exactly at asOf → included
        payment({ due: ts(BASE, 0, 0), settled: new Date(Date.parse(boundary) + 1).toISOString() }), // 1ms later → invisible
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, dateAt(boundary));
    expect(profile.paymentCadence.count).toBe(1);
    expect(profile.paymentCadence.evidence).toHaveLength(1);
    expect(profile.paymentCadence.evidence[0]!.id).toBe(facts.payments![0]!.paymentId);
  });
});

describe('buildBehaviorProfile — promise reliability', () => {
  it('reliability table: kept/broken/expired/pending counts and rate', () => {
    const facts: BehaviorFacts = {
      promises: [
        promise({ outcome: 'kept' }),
        promise({ outcome: 'kept', resolvedAt: ts(BASE, 26) }),
        promise({ outcome: 'broken', resolvedAt: ts(BASE, 40) }),
        promise({ outcome: 'expired', resolvedAt: ts(BASE, 45) }),
        promise({ outcome: 'pending', resolvedAt: null, promisedDate: ts(BASE, 90) }),
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.promiseReliability.keptCount).toBe(2);
    expect(profile.promiseReliability.brokenCount).toBe(1);
    expect(profile.promiseReliability.expiredCount).toBe(1);
    expect(profile.promiseReliability.pendingCount).toBe(1);
    expect(profile.promiseReliability.decidedCount).toBe(4);
    expect(profile.promiseReliability.reliabilityRate).toBe(0.5);
    expect(profile.promiseReliability.evidence).toHaveLength(4); // decided only
    expect(profile.promiseReliability.evidence.map((e) => e.id)).not.toContain(facts.promises![4]!.promiseId);
  });

  it('no decided promises → rate null; decided-later promises are pending as of asOf', () => {
    const facts: BehaviorFacts = {
      promises: [
        promise({ outcome: 'pending', resolvedAt: null }),
        promise({ outcome: 'broken', resolvedAt: ts('2026-05-01', 1) }), // after asOf
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.promiseReliability.reliabilityRate).toBeNull();
    expect(profile.promiseReliability.decidedCount).toBe(0);
    expect(profile.promiseReliability.pendingCount).toBe(2);
    expect(profile.promiseReliability.evidence).toEqual([]);
  });
});

describe('buildBehaviorProfile — dispute history', () => {
  it('dispute table: total/resolved/open/currentlyOpen with point-in-time edges', () => {
    const facts: BehaviorFacts = {
      disputes: [
        dispute({}), // open
        dispute({ resolvedAt: ts(BASE, 10) }), // resolved
        dispute({ openedAt: ts(BASE, 5), resolvedAt: ts('2026-06-01', 0) }), // resolved AFTER asOf → open as-of
        dispute({ openedAt: ts('2026-06-01', 0) }), // opened after asOf → invisible
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.disputeHistory.totalCount).toBe(3);
    expect(profile.disputeHistory.resolvedCount).toBe(1);
    expect(profile.disputeHistory.openCount).toBe(2);
    expect(profile.disputeHistory.currentlyOpen).toBe(true);
    expect(profile.disputeHistory.evidence).toHaveLength(3);
  });

  it('all disputes resolved → currentlyOpen false', () => {
    const facts: BehaviorFacts = {
      disputes: [dispute({ resolvedAt: ts(BASE, 3) }), dispute({ openedAt: ts(BASE, 1), resolvedAt: ts(BASE, 4) })],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.disputeHistory).toMatchObject({ totalCount: 2, resolvedCount: 2, openCount: 0, currentlyOpen: false });
  });
});

describe('buildBehaviorProfile — communications responsiveness', () => {
  it('per-channel inbound/outbound counts sorted a→z, totals and response rate', () => {
    const facts: BehaviorFacts = {
      communications: [
        comm({ channel: 'whatsapp', direction: 'outbound' }),
        comm({ channel: 'email', direction: 'inbound' }),
        comm({ channel: 'whatsapp', direction: 'inbound' }),
        comm({ channel: 'sms', direction: 'outbound' }),
        comm({ channel: 'whatsapp', direction: 'inbound' }),
        comm({ channel: 'email', direction: 'outbound' }),
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.communications.byChannel).toEqual([
      { channel: 'email', inbound: 1, outbound: 1 },
      { channel: 'sms', inbound: 0, outbound: 1 },
      { channel: 'whatsapp', inbound: 2, outbound: 1 },
    ]);
    expect(profile.communications.inboundTotal).toBe(3);
    expect(profile.communications.outboundTotal).toBe(3);
    expect(profile.communications.responseRate).toBe(0.5);
  });

  it('responseRate null with no messages; messages after asOf are invisible', () => {
    const facts: BehaviorFacts = {
      communications: [
        comm({ sentAt: ts(BASE, 1) }),
        comm({ sentAt: ts('2026-06-01', 1) }), // after asOf
      ],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.communications.byChannel).toEqual([{ channel: 'whatsapp', inbound: 0, outbound: 1 }]);
    expect(profile.communications.responseRate).toBe(0);
    expect(buildBehaviorProfile(ORG, CUSTOMER, {}, asOfDate).communications.responseRate).toBeNull();
  });
});

describe('buildBehaviorProfile — allocations, last activity, determinism, immutability', () => {
  it('allocation summary counts and sums applied money', () => {
    const facts: BehaviorFacts = {
      allocations: [allocation({ amountMinor: 40_000 }), allocation({ amountMinor: 60_000, allocatedAt: ts(BASE, 6) }), allocation({ amountMinor: 1, allocatedAt: ts('2026-06-01', 0) })],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.allocations.count).toBe(2);
    expect(profile.allocations.totalAmountMinor).toBe(100_000);
    expect(profile.allocations.evidence).toHaveLength(2);
  });

  it('lastActivityAt is the latest observed fact instant across all dimensions', () => {
    const facts: BehaviorFacts = {
      payments: [paying(2)],
      promises: [promise({ outcome: 'broken', resolvedAt: ts(BASE, 40) })],
      disputes: [dispute({ resolvedAt: ts(BASE, 10) })],
      communications: [comm({ sentAt: ts(BASE, 50) })],
      allocations: [allocation({ allocatedAt: ts(BASE, 45) })],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(profile.lastActivityAt).toBe(ts(BASE, 50));
  });

  it('determinism: identical inputs build deeply-identical profiles', () => {
    const facts: BehaviorFacts = {
      payments: [paying(3), paying(8)],
      promises: [promise({ outcome: 'kept' })],
      disputes: [dispute({})],
      communications: [comm({})],
      allocations: [allocation({})],
    };
    const a = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    const b = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('immutability pins: profile and every nested block are frozen; writes throw TypeError', () => {
    const facts: BehaviorFacts = {
      payments: [paying(2)],
      promises: [promise({ outcome: 'broken' })],
      disputes: [dispute({})],
      communications: [comm({})],
      allocations: [allocation({})],
    };
    const profile = buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.paymentCadence)).toBe(true);
    expect(Object.isFrozen(profile.paymentCadence.evidence)).toBe(true);
    expect(Object.isFrozen(profile.promiseReliability)).toBe(true);
    expect(Object.isFrozen(profile.disputeHistory)).toBe(true);
    expect(Object.isFrozen(profile.communications)).toBe(true);
    expect(Object.isFrozen(profile.communications.byChannel)).toBe(true);
    expect(Object.isFrozen(profile.communications.byChannel[0])).toBe(true);
    expect(Object.isFrozen(profile.allocations)).toBe(true);
    expect(() => {
      (profile.paymentCadence as { count: number }).count = 99;
    }).toThrow(TypeError);
    expect(() => {
      (profile.disputeHistory as { currentlyOpen: boolean }).currentlyOpen = false;
    }).toThrow(TypeError);
  });

  it('no-mutation pin: the fact bundle is left untouched', () => {
    const facts: BehaviorFacts = {
      payments: [paying(2)],
      promises: [promise({ outcome: 'kept' })],
      disputes: [dispute({})],
      communications: [comm({})],
      allocations: [allocation({})],
    };
    const snapshot = JSON.parse(JSON.stringify(facts)) as typeof facts;
    buildBehaviorProfile(ORG, CUSTOMER, facts, asOfDate);
    expect(facts).toEqual(snapshot);
  });
});

describe('buildBehaviorProfile — validation (stable BEHAV_* codes)', () => {
  it('rejects malformed identity, asOf and fact-bundle shapes', () => {
    const facts: BehaviorFacts = { payments: [paying(1)] };
    expectCode(() => buildBehaviorProfile('nope' as Uuid, CUSTOMER, facts, asOfDate), 'BEHAV_ORG_ID_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, 'x' as Uuid, facts, asOfDate), 'BEHAV_CUSTOMER_ID_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, facts, '2026-04-01' as unknown as Date), 'BEHAV_AS_OF_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, facts, new Date('not-a-date')), 'BEHAV_AS_OF_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, null as unknown as BehaviorFacts, asOfDate), 'BEHAV_FACTS_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { payments: 'nope' } as unknown as BehaviorFacts, asOfDate), 'BEHAV_FACTS_INVALID');
  });

  it('rejects malformed fact rows with per-kind codes', () => {
    // JSON round-trip gives a writable copy of the (readonly) fact shapes
    type Writable<T> = { -readonly [K in keyof T]: T[K] };
    type FactBundle = {
      payments: Writable<PaymentFact>[];
      promises: Writable<PromiseFact>[];
      disputes: Writable<DisputeFact>[];
      communications: Writable<CommunicationFact>[];
      allocations: Writable<AllocationFact>[];
    };
    const bad = (mutate: (f: FactBundle) => void): BehaviorFacts => {
      const f = JSON.parse(
        JSON.stringify({
          payments: [paying(1)],
          promises: [promise({ outcome: 'kept' })],
          disputes: [dispute({})],
          communications: [comm({})],
          allocations: [allocation({})],
        }),
      ) as FactBundle;
      mutate(f);
      return f;
    };

    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, bad((f) => { f.payments![0]!.paymentId = 'x' as unknown as Uuid; }), asOfDate), 'BEHAV_PAYMENT_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, bad((f) => { f.payments![0]!.dueDate = '2026-01-10'; }), asOfDate), 'BEHAV_PAYMENT_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, bad((f) => { f.payments![0]!.settledAt = 'yesterday'; }), asOfDate), 'BEHAV_PAYMENT_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, bad((f) => { (f.payments![0] as { partial?: unknown }).partial = 'yes'; }), asOfDate), 'BEHAV_PAYMENT_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { payments: [{ ...paying(1), amountMinor: 0 }] }, asOfDate), 'BEHAV_AMOUNT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { payments: [{ ...paying(1), amountMinor: 1.5 }] }, asOfDate), 'BEHAV_AMOUNT_INVALID');

    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, bad((f) => { (f.promises![0] as { outcome: string }).outcome = 'sorta'; }), asOfDate), 'BEHAV_PROMISE_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { promises: [promise({ outcome: 'kept', resolvedAt: null })] }, asOfDate), 'BEHAV_PROMISE_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { promises: [promise({ outcome: 'pending', resolvedAt: ts(BASE, 1) })] }, asOfDate), 'BEHAV_PROMISE_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { promises: [promise({ promisedDate: '2026-01-30' })] }, asOfDate), 'BEHAV_PROMISE_FACT_INVALID');

    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { disputes: [dispute({ openedAt: 'now' })] }, asOfDate), 'BEHAV_DISPUTE_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { disputes: [dispute({ resolvedAt: '' })] }, asOfDate), 'BEHAV_DISPUTE_FACT_INVALID');

    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { communications: [comm({ channel: '   ' })] }, asOfDate), 'BEHAV_COMMUNICATION_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { communications: [comm({ direction: 'sideways' as unknown as 'inbound' })] }, asOfDate), 'BEHAV_COMMUNICATION_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { communications: [comm({ messageId: 'm-1' as unknown as Uuid })] }, asOfDate), 'BEHAV_COMMUNICATION_FACT_INVALID');

    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { allocations: [allocation({ amountMinor: -5 })] }, asOfDate), 'BEHAV_AMOUNT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { allocations: [allocation({ allocatedAt: 'someday' })] }, asOfDate), 'BEHAV_ALLOCATION_FACT_INVALID');
    expectCode(() => buildBehaviorProfile(ORG, CUSTOMER, { allocations: [allocation({ allocationId: 'a-1' as unknown as Uuid })] }, asOfDate), 'BEHAV_ALLOCATION_FACT_INVALID');
  });
});
