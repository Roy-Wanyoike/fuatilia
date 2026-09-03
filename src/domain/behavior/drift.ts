/**
 * Behavior drift — trajectory classification between two point-in-time
 * profiles (F19, issue #26; powers "Recent behavior: deteriorating" in the
 * VISION §3.3 customer financial memory).
 *
 * `compareProfiles(before, after, thresholds?)` classifies each dimension as
 * `improving | stable | deteriorating` via TRANSPARENT threshold rules — no
 * opaque scores, no ML: every classification ships the numbers it compared
 * (before/after/delta) and the exact threshold that decided it (SPEC:
 * explainable anomaly events; H7 evidence discipline).
 *
 * Rules per dimension (first match wins):
 *
 *   payment_cadence     Δ median days-to-pay (after − before).
 *                       Δ ≥ +cadenceDays → deteriorating (slower payer);
 *                       Δ ≤ −cadenceDays → improving (faster payer);
 *                       else stable.
 *   promise_reliability Δ reliability rate. Δ ≥ +reliabilityRate → improving;
 *                       Δ ≤ −reliabilityRate → deteriorating; else stable.
 *   disputes            Δ open disputes (openCount). Δ ≥ +disputes →
 *                       deteriorating; Δ ≤ −disputes → improving; else stable.
 *   responsiveness      Δ response rate (inbound share). Δ ≤ −responsiveness →
 *                       deteriorating (customer going quiet);
 *                       Δ ≥ +responsiveness → improving; else stable.
 *
 * `null` on either side of a comparison (no data for that dimension yet) is
 * NOT a claim: the dimension classifies `stable` with an
 * "insufficient history" reason rather than inventing a trajectory.
 *
 * Overall trajectory = WORST-OF: any deteriorating dimension ⇒ deteriorating;
 * else any improving ⇒ improving; else stable. The winning dimensions'
 * reasons ride along (in fixed dimension order) as the report's evidence.
 */
import { DomainError, type Uuid } from '../shared';
import type { BehaviorProfile } from './profile';

export type Trajectory = 'improving' | 'stable' | 'deteriorating';

export const TRAJECTORY_DIMENSIONS = ['payment_cadence', 'promise_reliability', 'disputes', 'responsiveness'] as const;
export type TrajectoryDimension = (typeof TRAJECTORY_DIMENSIONS)[number];

/** Safe-default thresholds; override any subset via `compareProfiles` options. */
export interface TrajectoryThresholds {
  /** |Δ| median days-to-pay that counts as a real cadence change. */
  readonly cadenceDays: number;
  /** |Δ| promise reliability rate that counts as a real change. */
  readonly reliabilityRate: number;
  /** |Δ| open disputes that counts as a real change. */
  readonly disputes: number;
  /** |Δ| inbound response share that counts as a real change. */
  readonly responsiveness: number;
}

export const DEFAULT_TRAJECTORY_THRESHOLDS: Readonly<TrajectoryThresholds> = Object.freeze({
  cadenceDays: 5,
  reliabilityRate: 0.1,
  disputes: 1,
  responsiveness: 0.15,
});

/** One dimension's verdict — with the numbers + threshold that produced it. */
export interface DimensionTrajectory {
  readonly dimension: TrajectoryDimension;
  readonly trajectory: Trajectory;
  readonly before: number | null;
  readonly after: number | null;
  /** after − before, rounded to 4dp; null when either side lacks history. */
  readonly delta: number | null;
  /** The (absolute) threshold applied — exposed for explainability. */
  readonly threshold: number;
  readonly reason: string;
}

export interface TrajectoryReport {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly beforeAsOf: string;
  readonly afterAsOf: string;
  /** Worst-of over the dimensions. */
  readonly overall: Trajectory;
  /** Fixed TRAJECTORY_DIMENSIONS order. */
  readonly dimensions: readonly DimensionTrajectory[];
  /** Reasons of the non-stable dimensions that drove `overall` (ordered). */
  readonly reasons: readonly string[];
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Renders a metric (or its absence) inside a human-readable reason. */
const fmt = (x: number | null): string => (x === null ? 'null' : String(round4(x)));

const assertThresholds = (t: Readonly<TrajectoryThresholds>): void => {
  const positive = (value: number, name: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new DomainError('BEHAV_THRESHOLD_INVALID', `threshold ${name} must be a positive finite number, got ${String(value)}`, {
        threshold: name,
        value: String(value),
      });
    }
  };
  positive(t.cadenceDays, 'cadenceDays');
  positive(t.reliabilityRate, 'reliabilityRate');
  positive(t.disputes, 'disputes');
  positive(t.responsiveness, 'responsiveness');
};

/** Classify a signed delta against an absolute threshold (symmetric rule). */
const classifyDelta = (delta: number | null, threshold: number, improvingDirection: 'down' | 'up'): Trajectory => {
  if (delta === null) return 'stable'; // insufficient history is never a claim
  if (improvingDirection === 'down') {
    if (delta <= -threshold) return 'improving';
    if (delta >= threshold) return 'deteriorating';
  } else {
    if (delta >= threshold) return 'improving';
    if (delta <= -threshold) return 'deteriorating';
  }
  return 'stable';
};

const insufficient = (
  before: number | null,
  after: number | null,
  threshold: number,
  label: string,
): Omit<DimensionTrajectory, 'dimension'> => ({
  trajectory: 'stable',
  before,
  after,
  delta: null,
  threshold,
  reason: `${label}: insufficient history on ${before === null && after === null ? 'either side' : 'one side'} — no trajectory claimed`,
});

const resolveThresholds = (overrides?: Partial<TrajectoryThresholds>): Readonly<TrajectoryThresholds> => {
  const merged = { ...DEFAULT_TRAJECTORY_THRESHOLDS, ...(overrides ?? {}) } as TrajectoryThresholds;
  assertThresholds(merged);
  return Object.freeze(merged);
};

const profileIdentityOf = (profile: BehaviorProfile, side: string): { orgId: Uuid; customerId: Uuid; asOf: string } => {
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new DomainError('BEHAV_PROFILE_INVALID', `${side} must be a BehaviorProfile object, got ${String(profile)}`);
  }
  const asOf = (profile as { asOf?: unknown }).asOf;
  const orgId = (profile as { orgId?: unknown }).orgId;
  const customerId = (profile as { customerId?: unknown }).customerId;
  const cadence = (profile as { paymentCadence?: unknown }).paymentCadence;
  const reliability = (profile as { promiseReliability?: unknown }).promiseReliability;
  const disputes = (profile as { disputeHistory?: unknown }).disputeHistory;
  const communications = (profile as { communications?: unknown }).communications;
  if (
    typeof asOf !== 'string' ||
    typeof orgId !== 'string' ||
    typeof customerId !== 'string' ||
    cadence === null || typeof cadence !== 'object' ||
    reliability === null || typeof reliability !== 'object' ||
    disputes === null || typeof disputes !== 'object' ||
    communications === null || typeof communications !== 'object'
  ) {
    throw new DomainError(
      'BEHAV_PROFILE_INVALID',
      `${side} is not a recognizable BehaviorProfile (missing asOf/orgId/customerId or a metric block)`,
      { side },
    );
  }
  return { orgId: orgId as Uuid, customerId: customerId as Uuid, asOf };
};

/**
 * Compare two point-in-time profiles of the SAME customer (before earlier
 * than or equal to after) and classify the drift per dimension + overall.
 * Pure; the returned report is frozen.
 */
export function compareProfiles(
  before: BehaviorProfile,
  after: BehaviorProfile,
  overrides?: Partial<TrajectoryThresholds>,
): TrajectoryReport {
  const b = profileIdentityOf(before, 'before');
  const a = profileIdentityOf(after, 'after');
  if (b.orgId !== a.orgId || b.customerId !== a.customerId) {
    throw new DomainError(
      'BEHAV_PROFILE_MISMATCH',
      `profiles belong to different (org, customer) pairs: (${b.orgId}, ${b.customerId}) vs (${a.orgId}, ${a.customerId})`,
      { before: { orgId: b.orgId, customerId: b.customerId }, after: { orgId: a.orgId, customerId: a.customerId } },
    );
  }
  if (new Date(b.asOf).getTime() > new Date(a.asOf).getTime()) {
    throw new DomainError(
      'BEHAV_PROFILE_ORDER_INVALID',
      `before.asOf (${b.asOf}) must not be later than after.asOf (${a.asOf})`,
      { beforeAsOf: b.asOf, afterAsOf: a.asOf },
    );
  }
  const thresholds = resolveThresholds(overrides);

  // --- payment cadence: Δ median days-to-pay; down = improving ---------------
  const cadenceBefore = before.paymentCadence.medianDaysToPay;
  const cadenceAfter = after.paymentCadence.medianDaysToPay;
  const cadenceDelta = cadenceBefore === null || cadenceAfter === null ? null : round4(cadenceAfter - cadenceBefore);
  const cadenceTrajectory = classifyDelta(cadenceDelta, thresholds.cadenceDays, 'down');
  const payment_cadence: DimensionTrajectory =
    cadenceDelta === null
      ? { ...insufficient(cadenceBefore, cadenceAfter, thresholds.cadenceDays, 'payment cadence'), dimension: 'payment_cadence' }
      : {
          dimension: 'payment_cadence',
          trajectory: cadenceTrajectory,
          before: cadenceBefore,
          after: cadenceAfter,
          delta: cadenceDelta,
          threshold: thresholds.cadenceDays,
          reason:
            cadenceTrajectory === 'stable'
              ? `payment cadence median days-to-pay ${fmt(cadenceBefore)} → ${fmt(cadenceAfter)} (Δ ${fmt(cadenceDelta)}d, within ±${thresholds.cadenceDays}d)`
              : `payment cadence median days-to-pay ${fmt(cadenceBefore)} → ${fmt(cadenceAfter)} (Δ ${fmt(cadenceDelta)}d, exceeds ±${thresholds.cadenceDays}d)`,
        };

  // --- promise reliability: Δ kept rate; up = improving ------------------------
  const reliabilityBefore = before.promiseReliability.reliabilityRate;
  const reliabilityAfter = after.promiseReliability.reliabilityRate;
  const reliabilityDelta =
    reliabilityBefore === null || reliabilityAfter === null ? null : round4(reliabilityAfter - reliabilityBefore);
  const reliabilityTrajectory = classifyDelta(reliabilityDelta, thresholds.reliabilityRate, 'up');
  const promise_reliability: DimensionTrajectory =
    reliabilityDelta === null
      ? { ...insufficient(reliabilityBefore, reliabilityAfter, thresholds.reliabilityRate, 'promise reliability'), dimension: 'promise_reliability' }
      : {
          dimension: 'promise_reliability',
          trajectory: reliabilityTrajectory,
          before: reliabilityBefore,
          after: reliabilityAfter,
          delta: reliabilityDelta,
          threshold: thresholds.reliabilityRate,
          reason:
            reliabilityTrajectory === 'stable'
              ? `promise reliability rate ${fmt(reliabilityBefore)} → ${fmt(reliabilityAfter)} (Δ ${fmt(reliabilityDelta)}, within ±${thresholds.reliabilityRate})`
              : `promise reliability rate ${fmt(reliabilityBefore)} → ${fmt(reliabilityAfter)} (Δ ${fmt(reliabilityDelta)}, exceeds ±${thresholds.reliabilityRate})`,
        };

  // --- disputes: Δ open disputes; up = deteriorating ---------------------------
  const disputesBefore = before.disputeHistory.openCount;
  const disputesAfter = after.disputeHistory.openCount;
  const disputesDelta = round4(disputesAfter - disputesBefore);
  const disputesTrajectory = classifyDelta(disputesDelta, thresholds.disputes, 'down');
  const disputes: DimensionTrajectory = {
    dimension: 'disputes',
    trajectory: disputesTrajectory,
    before: disputesBefore,
    after: disputesAfter,
    delta: disputesDelta,
    threshold: thresholds.disputes,
    reason:
      disputesTrajectory === 'stable'
        ? `open disputes ${disputesBefore} → ${disputesAfter} (Δ ${disputesDelta}, within ±${thresholds.disputes})`
        : `open disputes ${disputesBefore} → ${disputesAfter} (Δ ${disputesDelta}, exceeds ±${thresholds.disputes})`,
  };

  // --- responsiveness: Δ inbound share; up = improving --------------------------
  // (a HIGHER customer-initiated share means the customer is more engaged;
  // a falling share — the customer going quiet — is deterioration)
  const responsivenessBefore = before.communications.responseRate;
  const responsivenessAfter = after.communications.responseRate;
  const responsivenessDelta =
    responsivenessBefore === null || responsivenessAfter === null ? null : round4(responsivenessAfter - responsivenessBefore);
  const responsivenessTrajectory = classifyDelta(responsivenessDelta, thresholds.responsiveness, 'up');
  const responsiveness: DimensionTrajectory =
    responsivenessDelta === null
      ? { ...insufficient(responsivenessBefore, responsivenessAfter, thresholds.responsiveness, 'responsiveness'), dimension: 'responsiveness' }
      : {
          dimension: 'responsiveness',
          trajectory: responsivenessTrajectory,
          before: responsivenessBefore,
          after: responsivenessAfter,
          delta: responsivenessDelta,
          threshold: thresholds.responsiveness,
          reason:
            responsivenessTrajectory === 'stable'
              ? `inbound response share ${fmt(responsivenessBefore)} → ${fmt(responsivenessAfter)} (Δ ${fmt(responsivenessDelta)}, within ±${thresholds.responsiveness})`
              : `inbound response share ${fmt(responsivenessBefore)} → ${fmt(responsivenessAfter)} (Δ ${fmt(responsivenessDelta)}, exceeds ±${thresholds.responsiveness})`,
        };

  const dimensions = Object.freeze(
    [payment_cadence, promise_reliability, disputes, responsiveness].map((d) => Object.freeze(d)) as readonly DimensionTrajectory[],
  );
  const nonStable = dimensions.filter((d) => d.trajectory !== 'stable');
  const overall: Trajectory =
    nonStable.some((d) => d.trajectory === 'deteriorating')
      ? 'deteriorating'
      : nonStable.some((d) => d.trajectory === 'improving')
        ? 'improving'
        : 'stable';

  return Object.freeze({
    orgId: a.orgId,
    customerId: a.customerId,
    beforeAsOf: b.asOf,
    afterAsOf: a.asOf,
    overall,
    dimensions,
    reasons: Object.freeze(nonStable.map((d) => `${d.dimension}: ${d.reason}`)),
  } satisfies TrajectoryReport);
}
