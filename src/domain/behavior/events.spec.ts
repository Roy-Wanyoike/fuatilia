import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { buildBehaviorProfile, DAY_MS, type BehaviorFacts, type PaymentFact, type PromiseFact } from './profile';
import { compareProfiles } from './drift';
import { detectAnomalies, type BehaviorAnomaly } from './anomaly';
import { anomalyDetectedEvent, profileBuiltEvent, trajectoryChangedEvent } from './events';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);

const CLOCK_ISO = '2026-04-01T00:00:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };
const DAY = DAY_MS;
let seq = 0;

const pay = (settledDate: string, daysLate: number, partial = false): PaymentFact => {
  const settledMs = Date.parse(`${settledDate}T12:00:00.000Z`);
  return {
    paymentId: uid(100 + ++seq),
    receivableId: RECEIVABLE,
    amountMinor: 100_000,
    dueDate: new Date(settledMs - daysLate * DAY - 12 * 3600_000).toISOString(),
    settledAt: new Date(settledMs).toISOString(),
    partial,
  };
};

const promise = (outcome: PromiseFact['outcome'], resolvedAt: string | null): PromiseFact => ({
  promiseId: uid(200 + ++seq),
  receivableId: RECEIVABLE,
  promisedDate: '2026-01-20T00:00:00.000Z',
  outcome,
  resolvedAt,
});

const profileAt = (facts: BehaviorFacts, asOf: string) => buildBehaviorProfile(ORG, CUSTOMER, facts, new Date(asOf));

const factsBefore: BehaviorFacts = {
  payments: [pay('2026-01-10', 2), pay('2026-01-12', 2)],
  promises: [promise('kept', '2026-01-25T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z')],
};
const factsAfter: BehaviorFacts = {
  payments: [...factsBefore.payments!, pay('2026-05-01', 12), pay('2026-05-03', 12)],
  promises: [...factsBefore.promises!, promise('kept', '2026-05-10T00:00:00.000Z'), promise('kept', '2026-05-11T00:00:00.000Z')],
};

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

// --- behavior.profileBuilt ------------------------------------------------------

describe('profileBuiltEvent — behavior.profileBuilt', () => {
  it('wraps the narrow metric summary in the repo envelope (version 1, customer aggregate, clock ISO)', () => {
    const profile = profileAt(factsAfter, '2026-06-01T00:00:00.000Z');
    const event = profileBuiltEvent(profile, clock);
    expect(event.name).toBe('behavior.profileBuilt');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(CUSTOMER); // a profile is a per-customer fact
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload.orgId).toBe(ORG);
    expect(event.payload.customerId).toBe(CUSTOMER);
    expect(event.payload.asOf).toBe('2026-06-01T00:00:00.000Z');
    expect(event.payload.paymentCount).toBe(4);
    expect(event.payload.medianDaysToPay).toBe(7); // [2,2,12,12]
    expect(event.payload.onTimeCount).toBe(0); // every fixture payment settles after its due date
    expect(event.payload.lateCount).toBe(4);
    expect(event.payload.partialCount).toBe(0);
    expect(event.payload.promiseKeptCount).toBe(3);
    expect(event.payload.promiseBrokenCount).toBe(1);
    expect(event.payload.promiseExpiredCount).toBe(0);
    expect(event.payload.promisePendingCount).toBe(0);
    expect(event.payload.promiseReliabilityRate).toBe(0.75);
    expect(event.payload.disputeTotalCount).toBe(0);
    expect(event.payload.disputeOpenCount).toBe(0);
    expect(event.payload.currentlyOpen).toBe(false);
    expect(event.payload.inboundTotal).toBe(0);
    expect(event.payload.outboundTotal).toBe(0);
    expect(event.payload.responseRate).toBeNull();
    expect(event.payload.allocationCount).toBe(0);
    expect(event.payload.totalAllocatedMinor).toBe(0);
    expect(event.payload.lastActivityAt).toBe(new Date(Date.parse('2026-05-11T00:00:00.000Z')).toISOString());
  });

  it('evidenceCount sums the per-dimension evidence trails (the full refs ride on the profile)', () => {
    const profile = profileAt(
      {
        payments: [pay('2026-01-10', 1)],
        promises: [promise('kept', '2026-01-25T00:00:00.000Z'), promise('pending', null)],
      },
      '2026-06-01T00:00:00.000Z',
    );
    const event = profileBuiltEvent(profile, clock);
    expect(event.payload.evidenceCount).toBe(2); // 1 payment + 1 decided promise; pending carries no evidence
  });

  it('empty history builds a valid zero/null payload', () => {
    const event = profileBuiltEvent(profileAt({}, '2026-06-01T00:00:00.000Z'), clock);
    expect(event.payload).toMatchObject({ paymentCount: 0, medianDaysToPay: null, promiseReliabilityRate: null, responseRate: null, evidenceCount: 0, lastActivityAt: null });
  });

  it('envelope and payload are frozen; the event JSON-round-trips', () => {
    const event = profileBuiltEvent(profileAt(factsAfter, '2026-06-01T00:00:00.000Z'), clock);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
    expect(() => {
      (event.payload as { paymentCount: number }).paymentCount = 42;
    }).toThrow(TypeError);
  });
});

// --- behavior.trajectoryChanged ---------------------------------------------------

describe('trajectoryChangedEvent — behavior.trajectoryChanged', () => {
  it('carries from/to, per-dimension verdicts and the ordered reasons', () => {
    const before = profileAt(factsBefore, '2026-03-01T00:00:00.000Z');
    const after = profileAt(factsAfter, '2026-06-01T00:00:00.000Z');
    const report = compareProfiles(before, after);
    const event = trajectoryChangedEvent(report, 'stable', clock);
    expect(event.name).toBe('behavior.trajectoryChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(CUSTOMER);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload.from).toBe('stable');
    expect(event.payload.to).toBe(report.overall);
    expect(event.payload.beforeAsOf).toBe('2026-03-01T00:00:00.000Z');
    expect(event.payload.afterAsOf).toBe('2026-06-01T00:00:00.000Z');
    expect(event.payload.dimensions).toEqual(report.dimensions.map((d) => ({ dimension: d.dimension, trajectory: d.trajectory, delta: d.delta, threshold: d.threshold })));
    expect(event.payload.reasons).toEqual(report.reasons);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it('a worsening verdict travels in `to` (the "recent behavior: deteriorating" fact)', () => {
    const before = profileAt(factsBefore, '2026-03-01T00:00:00.000Z');
    const after = profileAt(factsAfter, '2026-06-01T00:00:00.000Z');
    const event = trajectoryChangedEvent(compareProfiles(before, after), 'improving', clock);
    expect(event.payload.from).toBe('improving');
    expect(event.payload.to).toBe('deteriorating'); // cadence Δ +5
  });
});

// --- behavior.anomalyDetected ------------------------------------------------------

describe('anomalyDetectedEvent — behavior.anomalyDetected', () => {
  const detectAnomaly = (): BehaviorAnomaly => {
    const facts: BehaviorFacts = {
      payments: [pay('2025-12-10', 2), pay('2025-12-20', 4), pay('2026-02-01', 9), pay('2026-02-10', 11)],
      promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z')],
    };
    const anomalies = detectAnomalies(ORG, CUSTOMER, facts, clock);
    expect(anomalies.length).toBeGreaterThan(0);
    return anomalies[0]!;
  };

  it('mirrors the anomaly record (rule, severity, evidence, measured, thresholds, detectedAt)', () => {
    const anomaly = detectAnomaly();
    const event = anomalyDetectedEvent(anomaly, clock);
    expect(event.name).toBe('behavior.anomalyDetected');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(CUSTOMER);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload).toMatchObject({
      orgId: ORG,
      customerId: CUSTOMER,
      type: anomaly.type,
      rule: anomaly.rule,
      severity: anomaly.severity,
      explanation: anomaly.explanation,
      measured: anomaly.measured,
      thresholds: anomaly.thresholds,
      detectedAt: anomaly.detectedAt,
    });
    expect(event.payload.evidence).toEqual(anomaly.evidence);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event); // serializable for the outbox
  });

  it('payload evidence is a copy — mutating the event never rewrites the anomaly record', () => {
    const anomaly = detectAnomaly();
    const event = anomalyDetectedEvent(anomaly, clock);
    (event.payload.evidence as unknown as unknown[]).push({ kind: 'payment', id: 'injected' });
    expect(anomaly.evidence).toHaveLength(event.payload.evidence.length - 1);
  });
});

// --- envelope contract -----------------------------------------------------------

describe('behavior event envelope contract', () => {
  it('all builders reject a malformed clock with BEHAV_CLOCK_INVALID', () => {
    const profile = profileAt({}, '2026-06-01T00:00:00.000Z');
    const report = compareProfiles(profile, profile);
    const bad = { now: () => 'nope' } as unknown as Clock;
    expectCode(() => profileBuiltEvent(profile, undefined as unknown as Clock), 'BEHAV_CLOCK_INVALID');
    expectCode(() => profileBuiltEvent(profile, bad), 'BEHAV_CLOCK_INVALID');
    expectCode(() => trajectoryChangedEvent(report, 'stable', bad), 'BEHAV_CLOCK_INVALID');
    expectCode(() => anomalyDetectedEvent({ orgId: ORG, customerId: CUSTOMER, type: 'dispute_spike', rule: 'BEHAV_RULE_DISPUTE_SPIKE', severity: 'low', explanation: 'x', evidence: [], measured: {}, thresholds: {}, detectedAt: CLOCK_ISO }, bad), 'BEHAV_CLOCK_INVALID');
  });

  it('occurredAt is a full ISO-8601 instant in every event', () => {
    const profile = profileAt(factsAfter, '2026-06-01T00:00:00.000Z');
    const events = [
      profileBuiltEvent(profile, clock),
      trajectoryChangedEvent(compareProfiles(profile, profile), 'stable', clock),
    ];
    for (const e of events) {
      expect(e.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
    }
  });
});
