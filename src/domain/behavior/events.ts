/**
 * Behavior-lane domain events (wave 4, issue #26, SPEC §4 + §24).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   behavior.profileBuilt       a point-in-time BehaviorProfile was computed;
 *                               payload = the narrow metric summary (the full
 *                               evidence trail lives on the profile itself)
 *   behavior.trajectoryChanged  the worst-of drift verdict flipped between two
 *                               profile snapshots (VISION §3.3 "Recent
 *                               behavior: deteriorating")
 *   behavior.anomalyDetected    a deterministic detector fired; payload carries
 *                               rule id, severity, measured numbers, the exact
 *                               thresholds in force, and the evidence refs
 *
 * Envelope mirrors the wave-3 lanes (disputes/promises/communications): plain
 * objects `{ name, version, aggregateId, occurredAt, payload }` (the typed
 * catalog + outbox of issue #6 wraps these; `version` stays 1 until a
 * breaking payload change). Payloads are narrow, serializable and id-only:
 * dates travel as ISO-8601 strings and cross-lane ids as opaque strings, so
 * consumers (memory F23, notifications, agent API F21) never import producers.
 * The intelligence layer NEVER moves money — these are read-only facts.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { BehaviorAnomaly } from './anomaly';
import type { BehaviorProfile, EvidenceRef } from './profile';
import type { Trajectory, TrajectoryReport } from './drift';

export type BehaviorEventName =
  | 'behavior.profileBuilt'
  | 'behavior.trajectoryChanged'
  | 'behavior.anomalyDetected';

export interface BehaviorDomainEvent<TName extends BehaviorEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/**
 * Validate the injected Clock AND the instant it returns (the domain core
 * only ever throws DomainError — a clock returning garbage must surface as
 * BEHAV_CLOCK_INVALID, not as a raw TypeError deep in .toISOString()).
 */
const nowIso = (clock: Clock): string => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('BEHAV_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('BEHAV_CLOCK_INVALID', `clock.now() must return a valid Date, got ${String(now)}`);
  }
  return now.toISOString();
};

const build = <TName extends BehaviorEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): BehaviorDomainEvent<TName, TPayload> => {
  return Object.freeze({
    name,
    version: 1 as const,
    aggregateId,
    occurredAt: nowIso(clock),
    payload: Object.freeze({ ...payload }),
  });
};

// ---------------------------------------------------------------------------
// behavior.profileBuilt
// ---------------------------------------------------------------------------

/** Narrow scalar summary of a built profile (flat, serializable). */
export interface ProfileBuiltPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** ISO-8601 — the profile's snapshot instant. */
  readonly asOf: string;
  readonly paymentCount: number;
  readonly medianDaysToPay: number | null;
  readonly onTimeCount: number;
  readonly lateCount: number;
  readonly partialCount: number;
  readonly promiseKeptCount: number;
  readonly promiseBrokenCount: number;
  readonly promiseExpiredCount: number;
  readonly promisePendingCount: number;
  readonly promiseReliabilityRate: number | null;
  readonly disputeTotalCount: number;
  readonly disputeOpenCount: number;
  readonly currentlyOpen: boolean;
  readonly inboundTotal: number;
  readonly outboundTotal: number;
  readonly responseRate: number | null;
  readonly allocationCount: number;
  readonly totalAllocatedMinor: number;
  readonly lastActivityAt: string | null;
  /** How many evidence refs back the profile (the full list rides on the profile). */
  readonly evidenceCount: number;
}

const countEvidence = (profile: BehaviorProfile): number =>
  profile.paymentCadence.evidence.length +
  profile.promiseReliability.evidence.length +
  profile.disputeHistory.evidence.length +
  profile.communications.evidence.length +
  profile.allocations.evidence.length;

/** `behavior.profileBuilt` — aggregateId is the customer (a profile is per-customer). */
export function profileBuiltEvent(profile: BehaviorProfile, clock: Clock): BehaviorDomainEvent<'behavior.profileBuilt', ProfileBuiltPayload> {
  return build(
    'behavior.profileBuilt',
    profile.customerId,
    {
      orgId: profile.orgId,
      customerId: profile.customerId,
      asOf: profile.asOf,
      paymentCount: profile.paymentCadence.count,
      medianDaysToPay: profile.paymentCadence.medianDaysToPay,
      onTimeCount: profile.paymentCadence.onTimeCount,
      lateCount: profile.paymentCadence.lateCount,
      partialCount: profile.paymentCadence.partialCount,
      promiseKeptCount: profile.promiseReliability.keptCount,
      promiseBrokenCount: profile.promiseReliability.brokenCount,
      promiseExpiredCount: profile.promiseReliability.expiredCount,
      promisePendingCount: profile.promiseReliability.pendingCount,
      promiseReliabilityRate: profile.promiseReliability.reliabilityRate,
      disputeTotalCount: profile.disputeHistory.totalCount,
      disputeOpenCount: profile.disputeHistory.openCount,
      currentlyOpen: profile.disputeHistory.currentlyOpen,
      inboundTotal: profile.communications.inboundTotal,
      outboundTotal: profile.communications.outboundTotal,
      responseRate: profile.communications.responseRate,
      allocationCount: profile.allocations.count,
      totalAllocatedMinor: profile.allocations.totalAmountMinor,
      lastActivityAt: profile.lastActivityAt,
      evidenceCount: countEvidence(profile),
    },
    clock,
  );
}

// ---------------------------------------------------------------------------
// behavior.trajectoryChanged
// ---------------------------------------------------------------------------

export interface TrajectoryDimensionFact {
  readonly dimension: string;
  readonly trajectory: Trajectory;
  readonly delta: number | null;
  readonly threshold: number;
}

export interface TrajectoryChangedPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** The previous overall verdict (caller-supplied; emit only when it differs). */
  readonly from: Trajectory;
  /** The new worst-of verdict. */
  readonly to: Trajectory;
  readonly beforeAsOf: string;
  readonly afterAsOf: string;
  /** Per-dimension verdicts — the reasons are the evidence trail. */
  readonly dimensions: readonly TrajectoryDimensionFact[];
  readonly reasons: readonly string[];
}

/** `behavior.trajectoryChanged` — aggregateId is the customer. */
export function trajectoryChangedEvent(
  report: TrajectoryReport,
  previousOverall: Trajectory,
  clock: Clock,
): BehaviorDomainEvent<'behavior.trajectoryChanged', TrajectoryChangedPayload> {
  const reasons = report.reasons ?? [];
  return build(
    'behavior.trajectoryChanged',
    report.customerId,
    {
      orgId: report.orgId,
      customerId: report.customerId,
      from: previousOverall,
      to: report.overall,
      beforeAsOf: report.beforeAsOf,
      afterAsOf: report.afterAsOf,
      dimensions: report.dimensions.map((d) => ({ dimension: d.dimension, trajectory: d.trajectory, delta: d.delta, threshold: d.threshold })),
      reasons: [...reasons],
    },
    clock,
  );
}

// ---------------------------------------------------------------------------
// behavior.anomalyDetected
// ---------------------------------------------------------------------------

export interface AnomalyDetectedPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly type: BehaviorAnomaly['type'];
  readonly rule: string;
  readonly severity: BehaviorAnomaly['severity'];
  readonly explanation: string;
  /** Source aggregate refs — the claim is traceable to events (H7). */
  readonly evidence: readonly EvidenceRef[];
  readonly measured: Readonly<Record<string, number | string>>;
  readonly thresholds: Readonly<Record<string, number>>;
  /** ISO-8601 — matches the anomaly's detectedAt (from the injected Clock). */
  readonly detectedAt: string;
}

/** `behavior.anomalyDetected` — aggregateId is the customer. */
export function anomalyDetectedEvent(anomaly: BehaviorAnomaly, clock: Clock): BehaviorDomainEvent<'behavior.anomalyDetected', AnomalyDetectedPayload> {
  return build(
    'behavior.anomalyDetected',
    anomaly.customerId,
    {
      orgId: anomaly.orgId,
      customerId: anomaly.customerId,
      type: anomaly.type,
      rule: anomaly.rule,
      severity: anomaly.severity,
      explanation: anomaly.explanation,
      evidence: anomaly.evidence.map((e) => ({ kind: e.kind, id: e.id })),
      measured: { ...anomaly.measured },
      thresholds: { ...anomaly.thresholds },
      detectedAt: anomaly.detectedAt,
    },
    clock,
  );
}

export type BehaviorLaneEvent =
  | BehaviorDomainEvent<'behavior.profileBuilt', ProfileBuiltPayload>
  | BehaviorDomainEvent<'behavior.trajectoryChanged', TrajectoryChangedPayload>
  | BehaviorDomainEvent<'behavior.anomalyDetected', AnomalyDetectedPayload>;
