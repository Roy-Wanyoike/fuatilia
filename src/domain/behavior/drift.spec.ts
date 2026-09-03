import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { buildBehaviorProfile, DAY_MS, type BehaviorFacts, type BehaviorProfile, type PaymentFact, type PromiseFact, type DisputeFact, type CommunicationFact } from './profile';
import { compareProfiles, DEFAULT_TRAJECTORY_THRESHOLDS, type TrajectoryReport } from './drift';

// --- fixtures ---------------------------------------------------------------
//
// Two snapshot instants three months apart. The "after" facts CUMULATIVELY
// extend the "before" facts (as an adapter projecting one event stream
// would); every builder below is calibrated so the medians/rates in the
// assertions are exact whole or half integers.

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);

const BEFORE_AS_OF = '2026-03-01T00:00:00.000Z';
const AFTER_AS_OF = '2026-06-01T00:00:00.000Z';

const DAY = DAY_MS;
const NOON = 12 * 3600_000;
let seq = 0;

/** Payment due at midnight UTC of `dueDate`, settled `days` whole UTC days later at noon. */
const paying = (dueDate: string, days: number): PaymentFact => ({
  paymentId: uid(100 + ++seq),
  receivableId: RECEIVABLE,
  amountMinor: 100_000,
  dueDate: `${dueDate}T00:00:00.000Z`,
  settledAt: new Date(Date.parse(`${dueDate}T00:00:00.000Z`) + days * DAY + NOON).toISOString(),
  partial: false,
});

const promise = (outcome: PromiseFact['outcome'], resolvedAt: string | null): PromiseFact => ({
  promiseId: uid(200 + ++seq),
  receivableId: RECEIVABLE,
  promisedDate: '2026-01-20T00:00:00.000Z',
  outcome,
  resolvedAt,
});

const openDispute = (openedAt: string): DisputeFact => ({
  disputeId: uid(300 + ++seq),
  receivableId: RECEIVABLE,
  openedAt,
  resolvedAt: null,
});

const message = (direction: CommunicationFact['direction'], sentAt: string, channel = 'whatsapp'): CommunicationFact => ({
  messageId: uid(400 + ++seq),
  channel,
  direction,
  sentAt,
});

const build = (facts: BehaviorFacts, asOf: string): BehaviorProfile =>
  buildBehaviorProfile(ORG, CUSTOMER, facts, new Date(asOf));

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

// Baseline pair: before median 2 ([2,2]); after adds [12,12] → cumulative
// [2,2,12,12] → median 7 ⇒ Δ +5 (exactly at the default cadence threshold).
const cadenceFacts = (withRecent: boolean): BehaviorFacts => ({
  payments: withRecent ? [paying('2026-01-10', 2), paying('2026-01-12', 2), paying('2026-05-01', 12), paying('2026-05-03', 12)] : [paying('2026-01-10', 2), paying('2026-01-12', 2)],
});

// Baseline pair: before 1 kept + 1 broken → rate 0.5; after adds 8 kept →
// 9/10 = 0.9 ⇒ Δ +0.4 (default reliability threshold 0.1).
const reliabilityFacts = (withRecent: boolean): BehaviorFacts => ({
  promises: [
    promise('kept', '2026-01-25T00:00:00.000Z'),
    promise('broken', '2026-02-05T00:00:00.000Z'),
    ...(withRecent
      ? Array.from({ length: 8 }, (_, i) => promise('kept', new Date(Date.parse('2026-05-01T00:00:00.000Z') + i * DAY).toISOString()))
      : []),
  ],
});

// Disputes pair: before none; after one open dispute ⇒ Δ +1 (default 1).
const disputeFacts = (withRecent: boolean): BehaviorFacts => ({
  disputes: withRecent ? [openDispute('2026-05-10T00:00:00.000Z')] : [],
});

// Responsiveness pair: before 3 outbound + 1 inbound → 0.25; after adds
// 3 inbound + 1 outbound → 4/8 = 0.5 ⇒ Δ +0.25 (default 0.15).
const responsivenessFacts = (withRecent: boolean): BehaviorFacts => ({
  communications: [
    message('inbound', '2026-01-05T00:00:00.000Z'),
    message('outbound', '2026-01-06T00:00:00.000Z'),
    message('outbound', '2026-01-07T00:00:00.000Z'),
    message('outbound', '2026-01-08T00:00:00.000Z'),
    ...(withRecent
      ? [message('inbound', '2026-05-01T00:00:00.000Z'), message('inbound', '2026-05-02T00:00:00.000Z'), message('inbound', '2026-05-03T00:00:00.000Z'), message('outbound', '2026-05-04T00:00:00.000Z')]
      : []),
  ],
});

const allFacts = (withRecent: boolean): BehaviorFacts => ({
  ...cadenceFacts(withRecent),
  ...reliabilityFacts(withRecent),
  ...disputeFacts(withRecent),
  ...responsivenessFacts(withRecent),
});

const dimensionOf = (report: TrajectoryReport, dimension: string) =>
  report.dimensions.find((d) => d.dimension === dimension)!;

// --- per-dimension classification --------------------------------------------

describe('compareProfiles — payment_cadence (Δ median days-to-pay, down = improving)', () => {
  it('deteriorating at the exact threshold: Δ +5 with default cadenceDays 5', () => {
    const report = compareProfiles(build(cadenceFacts(false), BEFORE_AS_OF), build(cadenceFacts(true), AFTER_AS_OF));
    const d = dimensionOf(report, 'payment_cadence');
    expect(d.before).toBe(2);
    expect(d.after).toBe(7);
    expect(d.delta).toBe(5);
    expect(d.threshold).toBe(5);
    expect(d.trajectory).toBe('deteriorating');
    expect(report.overall).toBe('deteriorating');
  });

  it('improving at the exact threshold: Δ −5 (faster payer)', () => {
    const before = build(
      { payments: [paying('2026-01-10', 12), paying('2026-01-12', 12)] },
      BEFORE_AS_OF,
    );
    const after = build(
      { payments: [paying('2026-01-10', 12), paying('2026-01-12', 12), paying('2026-05-01', 2), paying('2026-05-03', 2)] },
      AFTER_AS_OF,
    );
    const report = compareProfiles(before, after);
    const d = dimensionOf(report, 'payment_cadence');
    expect(d.delta).toBe(-5);
    expect(d.trajectory).toBe('improving');
    expect(report.overall).toBe('improving');
  });

  it('stable inside the band: Δ +4 with defaults', () => {
    const before = build({ payments: [paying('2026-01-10', 2), paying('2026-01-12', 2)] }, BEFORE_AS_OF);
    const after = build(
      { payments: [paying('2026-01-10', 2), paying('2026-01-12', 2), paying('2026-05-01', 10), paying('2026-05-03', 10)] },
      AFTER_AS_OF,
    );
    const report = compareProfiles(before, after);
    expect(dimensionOf(report, 'payment_cadence')).toMatchObject({ trajectory: 'stable', before: 2, after: 6, delta: 4 });
    expect(report.overall).toBe('stable');
  });

  it('no settled payments on one side ⇒ stable + insufficient-history reason, delta null', () => {
    const before = build({}, BEFORE_AS_OF);
    const after = build({ payments: [paying('2026-05-01', 3)] }, AFTER_AS_OF);
    const d = dimensionOf(compareProfiles(before, after), 'payment_cadence');
    expect(d.trajectory).toBe('stable');
    expect(d.before).toBeNull();
    expect(d.after).toBe(3);
    expect(d.delta).toBeNull();
    expect(d.reason).toMatch(/insufficient history/);
  });

  it('custom thresholds override the defaults (Δ +3 fires at cadenceDays 3, not at 5 or 4)', () => {
    const before = build(cadenceFacts(false), BEFORE_AS_OF);
    const after = build(
      { payments: [paying('2026-01-10', 2), paying('2026-01-12', 2), paying('2026-05-01', 8), paying('2026-05-03', 8)] },
      AFTER_AS_OF,
    );
    expect(dimensionOf(compareProfiles(before, after), 'payment_cadence').trajectory).toBe('stable'); // Δ 3 < 5
    expect(dimensionOf(compareProfiles(before, after, { cadenceDays: 4 }), 'payment_cadence').trajectory).toBe('stable'); // 3 < 4
    expect(dimensionOf(compareProfiles(before, after, { cadenceDays: 3 }), 'payment_cadence').trajectory).toBe('deteriorating'); // exactly at threshold
  });
});

describe('compareProfiles — promise_reliability (Δ kept rate, up = improving)', () => {
  it('improving: 0.5 → 0.9 (Δ +0.4 ≥ 0.1)', () => {
    const report = compareProfiles(build(reliabilityFacts(false), BEFORE_AS_OF), build(reliabilityFacts(true), AFTER_AS_OF));
    const d = dimensionOf(report, 'promise_reliability');
    expect(d).toMatchObject({ before: 0.5, after: 0.9, delta: 0.4, threshold: 0.1, trajectory: 'improving' });
  });

  it('deteriorating when the rate falls below −threshold', () => {
    const before = build(
      { promises: Array.from({ length: 8 }, (_, i) => promise('kept', new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * DAY).toISOString())).concat(promise('broken', '2026-02-01T00:00:00.000Z')) },
      BEFORE_AS_OF,
    );
    const after = build(
      {
        promises: [
          ...Array.from({ length: 8 }, (_, i) => promise('kept', new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * DAY).toISOString())),
          promise('broken', '2026-02-01T00:00:00.000Z'),
          promise('broken', '2026-05-01T00:00:00.000Z'),
          promise('broken', '2026-05-02T00:00:00.000Z'),
        ],
      },
      AFTER_AS_OF,
    );
    const d = dimensionOf(compareProfiles(before, after), 'promise_reliability');
    expect(d.before).toBe(8 / 9);
    expect(d.after).toBe(8 / 11);
    expect(d.trajectory).toBe('deteriorating');
  });

  it('stable when Δ rate is inside the band', () => {
    const before = build({ promises: [promise('kept', '2026-01-25T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z')] }, BEFORE_AS_OF);
    const after = build(
      { promises: [promise('kept', '2026-01-25T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z'), promise('kept', '2026-05-01T00:00:00.000Z'), promise('broken', '2026-05-02T00:00:00.000Z')] },
      AFTER_AS_OF,
    );
    const d = dimensionOf(compareProfiles(before, after), 'promise_reliability');
    expect(d.before).toBe(0.5);
    expect(d.after).toBe(0.5);
    expect(d.trajectory).toBe('stable');
  });

  it('no decided promises on one side ⇒ stable + insufficient history', () => {
    const before = build({ promises: [promise('pending', null)] }, BEFORE_AS_OF);
    const after = build({ promises: [promise('pending', null), promise('kept', '2026-05-01T00:00:00.000Z')] }, AFTER_AS_OF);
    const d = dimensionOf(compareProfiles(before, after), 'promise_reliability');
    expect(d).toMatchObject({ trajectory: 'stable', before: null, after: 1, delta: null });
    expect(d.reason).toMatch(/insufficient history/);
  });
});

describe('compareProfiles — disputes (Δ open disputes, up = deteriorating)', () => {
  it('deteriorating: 0 → 1 open dispute (Δ +1 ≥ 1)', () => {
    const report = compareProfiles(build(disputeFacts(false), BEFORE_AS_OF), build(disputeFacts(true), AFTER_AS_OF));
    const d = dimensionOf(report, 'disputes');
    expect(d).toMatchObject({ before: 0, after: 1, delta: 1, threshold: 1, trajectory: 'deteriorating' });
    expect(report.overall).toBe('deteriorating');
  });

  it('improving: 1 → 0 open disputes', () => {
    const before = build({ disputes: [openDispute('2026-01-15T00:00:00.000Z')] }, BEFORE_AS_OF);
    const after = build({ disputes: [{ ...openDispute('2026-01-15T00:00:00.000Z'), resolvedAt: '2026-04-01T00:00:00.000Z' }] }, AFTER_AS_OF);
    const d = dimensionOf(compareProfiles(before, after), 'disputes');
    expect(d).toMatchObject({ before: 1, after: 0, delta: -1, trajectory: 'improving' });
  });

  it('stable when openCount is unchanged; Δ 0 is never a claim', () => {
    const facts: BehaviorFacts = { disputes: [openDispute('2026-01-15T00:00:00.000Z')] };
    const report = compareProfiles(build(facts, BEFORE_AS_OF), build(facts, AFTER_AS_OF));
    expect(dimensionOf(report, 'disputes')).toMatchObject({ trajectory: 'stable', delta: 0 });
    expect(report.overall).toBe('stable');
  });
});

describe('compareProfiles — responsiveness (Δ inbound response share, down = deteriorating)', () => {
  it('improving: 0.25 → 0.5 (Δ +0.25 ≥ 0.15)', () => {
    const report = compareProfiles(build(responsivenessFacts(false), BEFORE_AS_OF), build(responsivenessFacts(true), AFTER_AS_OF));
    const d = dimensionOf(report, 'responsiveness');
    expect(d.before).toBe(0.25);
    expect(d.after).toBe(0.5);
    expect(d.delta).toBe(0.25);
    expect(d.trajectory).toBe('improving');
  });

  it('deteriorating when the customer goes quiet (Δ ≤ −0.15)', () => {
    const before = build(
      { communications: [message('inbound', '2026-01-05T00:00:00.000Z'), message('outbound', '2026-01-06T00:00:00.000Z'), message('inbound', '2026-01-07T00:00:00.000Z'), message('outbound', '2026-01-08T00:00:00.000Z')] },
      BEFORE_AS_OF,
    );
    const after = build(
      {
        communications: [
          message('inbound', '2026-01-05T00:00:00.000Z'),
          message('outbound', '2026-01-06T00:00:00.000Z'),
          message('inbound', '2026-01-07T00:00:00.000Z'),
          message('outbound', '2026-01-08T00:00:00.000Z'),
          message('outbound', '2026-05-01T00:00:00.000Z'),
          message('outbound', '2026-05-02T00:00:00.000Z'),
          message('outbound', '2026-05-03T00:00:00.000Z'),
          message('outbound', '2026-05-04T00:00:00.000Z'),
        ],
      },
      AFTER_AS_OF,
    );
    const d = dimensionOf(compareProfiles(before, after), 'responsiveness');
    expect(d.before).toBe(0.5);
    expect(d.after).toBe(0.25); // 2 inbound / 8 total after the quiet spell
    expect(d.trajectory).toBe('deteriorating');
  });

  it('rounds deltas to 4dp before classifying: −0.09999999999999998 classifies as −0.1', () => {
    const before = build(
      { communications: [message('inbound', '2026-01-05T00:00:00.000Z'), message('outbound', '2026-01-06T00:00:00.000Z')] },
      BEFORE_AS_OF,
    );
    const after = build(
      {
        communications: [
          message('inbound', '2026-01-05T00:00:00.000Z'),
          message('outbound', '2026-01-06T00:00:00.000Z'),
          message('inbound', '2026-05-01T00:00:00.000Z'),
          message('outbound', '2026-05-02T00:00:00.000Z'),
          message('outbound', '2026-05-03T00:00:00.000Z'),
        ],
      },
      AFTER_AS_OF,
    );
    const d = dimensionOf(compareProfiles(before, after, { responsiveness: 0.1 }), 'responsiveness');
    expect(d.before).toBe(0.5);
    expect(d.after).toBe(0.4);
    expect(d.delta).toBe(-0.1); // raw 2/5 − 1/2 is float-noisy; round4 must clean it
    expect(d.trajectory).toBe('deteriorating'); // exactly at the threshold ⇒ NOT stable
  });

  it('no messages on one side ⇒ stable + insufficient history', () => {
    const d = dimensionOf(compareProfiles(build({}, BEFORE_AS_OF), build(responsivenessFacts(true), AFTER_AS_OF)), 'responsiveness');
    expect(d).toMatchObject({ trajectory: 'stable', before: null, delta: null });
  });
});

// --- overall (worst-of) + report shape -----------------------------------------

describe('compareProfiles — overall trajectory (worst-of) and report shape', () => {
  it('any deteriorating dimension wins over improving ones; its reason rides along', () => {
    // cadence deteriorates (Δ +5), reliability improves (Δ +0.4)
    const before = build(allFacts(false), BEFORE_AS_OF);
    const after = build(allFacts(true), AFTER_AS_OF);
    const report = compareProfiles(before, after);
    expect(report.overall).toBe('deteriorating');
    // reasons = every non-stable dimension, in fixed dimension order
    expect(report.reasons).toHaveLength(4);
    expect(report.reasons.map((r) => r.split(':')[0])).toEqual(['payment_cadence', 'promise_reliability', 'disputes', 'responsiveness']);
    expect(report.reasons[0]).toMatch(/exceeds ±5d/);
    expect(dimensionOf(report, 'payment_cadence').trajectory).toBe('deteriorating');
    expect(dimensionOf(report, 'responsiveness').trajectory).toBe('improving');
  });

  it('improving-only pair classifies improving; all-stable pair is stable with no reasons', () => {
    const improving = compareProfiles(build(reliabilityFacts(false), BEFORE_AS_OF), build(reliabilityFacts(true), AFTER_AS_OF));
    expect(improving.overall).toBe('improving');
    expect(improving.reasons).toEqual([expect.stringMatching(/^promise_reliability:/)]);

    const stable = compareProfiles(build(disputeFacts(false), BEFORE_AS_OF), build(disputeFacts(false), AFTER_AS_OF));
    expect(stable.overall).toBe('stable');
    expect(stable.reasons).toEqual([]);
  });

  it('dimensions are emitted in the fixed TRAJECTORY_DIMENSIONS order; the report is frozen', () => {
    const report = compareProfiles(build(allFacts(false), BEFORE_AS_OF), build(allFacts(true), AFTER_AS_OF));
    expect(report.dimensions.map((d) => d.dimension)).toEqual(['payment_cadence', 'promise_reliability', 'disputes', 'responsiveness']);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.dimensions)).toBe(true);
    expect(Object.isFrozen(report.dimensions[0])).toBe(true);
    expect(Object.isFrozen(report.reasons)).toBe(true);
    expect(report.orgId).toBe(ORG);
    expect(report.customerId).toBe(CUSTOMER);
    expect(report.beforeAsOf).toBe(BEFORE_AS_OF);
    expect(report.afterAsOf).toBe(AFTER_AS_OF);
  });

  it('default thresholds are exposed and frozen; partial overrides merge over them', () => {
    expect(DEFAULT_TRAJECTORY_THRESHOLDS).toEqual({ cadenceDays: 5, reliabilityRate: 0.1, disputes: 1, responsiveness: 0.15 });
    expect(Object.isFrozen(DEFAULT_TRAJECTORY_THRESHOLDS)).toBe(true);
    const before = build(cadenceFacts(false), BEFORE_AS_OF);
    const after = build(cadenceFacts(true), AFTER_AS_OF);
    const report = compareProfiles(before, after, { cadenceDays: 10 });
    expect(dimensionOf(report, 'payment_cadence').threshold).toBe(10);
    expect(dimensionOf(report, 'disputes').threshold).toBe(DEFAULT_TRAJECTORY_THRESHOLDS.disputes);
  });

  it('no-mutation pin: comparing leaves both profiles untouched', () => {
    const beforeFacts = allFacts(false);
    const afterFacts = allFacts(true);
    const before = build(beforeFacts, BEFORE_AS_OF);
    const after = build(afterFacts, AFTER_AS_OF);
    const beforeSnapshot = JSON.parse(JSON.stringify(before));
    const afterSnapshot = JSON.parse(JSON.stringify(after));
    compareProfiles(before, after);
    expect(before).toEqual(beforeSnapshot);
    expect(after).toEqual(afterSnapshot);
  });

  it('same-profile comparison is legal (equal asOf) and fully stable', () => {
    const p = build(allFacts(true), AFTER_AS_OF);
    const report = compareProfiles(p, p);
    expect(report.overall).toBe('stable');
    expect(report.dimensions.every((d) => d.delta === 0)).toBe(true);
  });
});

// --- validation -----------------------------------------------------------------

describe('compareProfiles — validation (stable BEHAV_* codes)', () => {
  it('refuses profiles from different (org, customer) pairs', () => {
    const before = build(allFacts(false), BEFORE_AS_OF);
    const otherCustomer = buildBehaviorProfile(ORG, uid(9), allFacts(false), new Date(BEFORE_AS_OF));
    const otherOrg = buildBehaviorProfile(uid(9), CUSTOMER, allFacts(false), new Date(BEFORE_AS_OF));
    expectCode(() => compareProfiles(before, otherCustomer), 'BEHAV_PROFILE_MISMATCH');
    expectCode(() => compareProfiles(before, otherOrg), 'BEHAV_PROFILE_MISMATCH');
  });

  it('refuses chronologically inverted snapshots; equal asOf is legal', () => {
    const early = build(allFacts(false), BEFORE_AS_OF);
    const late = build(allFacts(true), AFTER_AS_OF);
    expectCode(() => compareProfiles(late, early), 'BEHAV_PROFILE_ORDER_INVALID');
    expect(() => compareProfiles(early, early)).not.toThrow();
  });

  it('refuses non-profile inputs', () => {
    const p = build(allFacts(false), BEFORE_AS_OF);
    expectCode(() => compareProfiles(null as unknown as BehaviorProfile, p), 'BEHAV_PROFILE_INVALID');
    expectCode(() => compareProfiles(p, {} as unknown as BehaviorProfile), 'BEHAV_PROFILE_INVALID');
    expectCode(() => compareProfiles(p, [p] as unknown as BehaviorProfile), 'BEHAV_PROFILE_INVALID');
  });

  it('refuses malformed thresholds (every knob validated, not just the overridden one)', () => {
    const p = build(allFacts(false), BEFORE_AS_OF);
    expectCode(() => compareProfiles(p, p, { cadenceDays: 0 }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { cadenceDays: -5 }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { cadenceDays: Number.NaN }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { cadenceDays: Number.POSITIVE_INFINITY }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { reliabilityRate: 0 }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { disputes: -1 }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(() => compareProfiles(p, p, { responsiveness: Number.NaN }), 'BEHAV_THRESHOLD_INVALID');
  });
});
