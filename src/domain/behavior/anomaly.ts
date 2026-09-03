/**
 * Behavioral anomaly detection — deterministic, rule-based, explainable
 * (F19, issue #26, SPEC §4 "Create a behavioral anomaly event" + §24
 * "Behavioral Anomaly Detection: create explainable alerts").
 *
 * NO opaque ML scores. Every detector is a transparent threshold rule over
 * the same plain-data fact histories the profile uses; every anomaly record
 * carries the rule id, the measured numbers, the exact thresholds in force,
 * the evidence refs, and a human-readable explanation. Thresholds are
 * configurable per call (partial overrides over safe defaults) and are
 * VALIDATED — a malformed threshold refuses to run rather than silently
 * re-defaulting.
 *
 * Detectors (fixed emission order, documented for deterministic consumers):
 *
 *   1. cadence_deterioration      median days-to-pay of payments settled in
 *                                 the recent window rose ≥ trigger days above
 *                                 the baseline (everything settled earlier).
 *   2. promise_break_after_streak the most recently decided promise is broken
 *                                 after an unbroken kept-streak ≥ min.
 *   3. partial_payment_pattern    the partial-payment share in the recent
 *                                 window jumped ≥ rateIncrease above baseline.
 *   4. silence_after_promise      a pending promise is ≥ grace days past its
 *                                 promised date with no inbound message AND
 *                                 no payment settled since it was made.
 *   5. dispute_spike              ≥ spikeMin disputes opened in the window.
 *
 * `detectedAt` comes from the injected Clock — never Date.now(). Pure:
 * data in → anomalies out; facts are never mutated; records are frozen.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  DAY_MS,
  medianOf,
  normalizeFacts,
  type BehaviorFacts,
  type EvidenceRef,
  type NormalizedFacts,
} from './profile';

export type AnomalySeverity = 'low' | 'medium' | 'high';

export const BEHAVIOR_ANOMALY_TYPES = [
  'cadence_deterioration',
  'promise_break_after_streak',
  'partial_payment_pattern',
  'silence_after_promise',
  'dispute_spike',
] as const;
export type BehaviorAnomalyType = (typeof BEHAVIOR_ANOMALY_TYPES)[number];

/** Stable rule ids (the explainability handle — log/alert/UI key). */
export const BEHAVIOR_ANOMALY_RULES = Object.freeze({
  cadence_deterioration: 'BEHAV_RULE_CADENCE_DETERIORATION',
  promise_break_after_streak: 'BEHAV_RULE_PROMISE_BREAK_AFTER_STREAK',
  partial_payment_pattern: 'BEHAV_RULE_PARTIAL_PAYMENT_PATTERN',
  silence_after_promise: 'BEHAV_RULE_SILENCE_AFTER_PROMISE',
  dispute_spike: 'BEHAV_RULE_DISPUTE_SPIKE',
} as const satisfies Record<BehaviorAnomalyType, string>);

/**
 * The full threshold set. All knobs are exposed on every anomaly they
 * decide (see `BehaviorAnomaly.thresholds`) — transparency is the contract.
 */
export interface AnomalyThresholds {
  // cadence deterioration
  /** Recent window length in days (payments settled in (asOf−window, asOf]). */
  readonly cadenceWindowDays: number;
  /** Minimum baseline payments (settled before the window) to trust the baseline median. */
  readonly cadenceMinBaseline: number;
  /** Minimum recent payments to trust the recent median. */
  readonly cadenceMinRecent: number;
  /** Median delta (days) that fires the detector. */
  readonly cadenceTriggerDays: number;
  /** Median delta that escalates severity to medium. */
  readonly cadenceMediumDays: number;
  /** Median delta that escalates severity to high. */
  readonly cadenceHighDays: number;
  // promise break after streak
  /** Kept promises in the streak before the break for the rule to fire. */
  readonly promiseMinStreak: number;
  /** Streak length that escalates severity to high. */
  readonly promiseStreakHigh: number;
  // partial payment pattern
  readonly partialWindowDays: number;
  /** Recent share of partial payments above which the rule fires. */
  readonly partialMinRate: number;
  /** How much the partial share must exceed the baseline share to fire. */
  readonly partialRateIncrease: number;
  /** Minimum payments on EACH side of the window split. */
  readonly partialMinPayments: number;
  // silence after promise
  /** Days past the promised date before silence is anomalous. */
  readonly silenceGraceDays: number;
  /** Days past the promised date that escalates severity to medium. */
  readonly silenceMediumDays: number;
  /** Days past the promised date that escalates severity to high. */
  readonly silenceHighDays: number;
  // dispute spike
  readonly disputeWindowDays: number;
  /** Disputes opened in the window that fire the rule. */
  readonly disputeSpikeMin: number;
  /** Disputes in the window that escalate severity to high. */
  readonly disputeSpikeHigh: number;
}

export const DEFAULT_ANOMALY_THRESHOLDS: Readonly<AnomalyThresholds> = Object.freeze({
  cadenceWindowDays: 90,
  cadenceMinBaseline: 2,
  cadenceMinRecent: 2,
  cadenceTriggerDays: 3,
  cadenceMediumDays: 7,
  cadenceHighDays: 15,
  promiseMinStreak: 2,
  promiseStreakHigh: 5,
  partialWindowDays: 90,
  partialMinRate: 0.5,
  partialRateIncrease: 0.5,
  partialMinPayments: 3,
  silenceGraceDays: 3,
  silenceMediumDays: 7,
  silenceHighDays: 30,
  disputeWindowDays: 90,
  disputeSpikeMin: 2,
  disputeSpikeHigh: 3,
});

export interface AnomalyOptions {
  /** Snapshot instant; defaults to clock.now(). Windows are relative to it. */
  readonly asOf?: Date;
  /** Partial overrides over DEFAULT_ANOMALY_THRESHOLDS. */
  readonly thresholds?: Partial<AnomalyThresholds>;
}

/** The explainable anomaly record — frozen, plain-data, F23-extensible. */
export interface BehaviorAnomaly {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly type: BehaviorAnomalyType;
  /** Stable rule id (BEHAV_RULE_*). */
  readonly rule: string;
  readonly severity: AnomalySeverity;
  readonly explanation: string;
  readonly evidence: readonly EvidenceRef[];
  /** The measured numbers the rule compared (numbers + ISO dates). */
  readonly measured: Readonly<Record<string, number | string>>;
  /** The thresholds in force when this anomaly was decided. */
  readonly thresholds: Readonly<Record<string, number>>;
  /** ISO-8601, from the injected Clock. */
  readonly detectedAt: string;
}

const SEVERITY_ORDER: Readonly<Record<AnomalySeverity, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

const assertThresholds = (t: Readonly<AnomalyThresholds>): void => {
  const nonNegative = (value: number, name: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new DomainError('BEHAV_THRESHOLD_INVALID', `threshold ${name} must be a non-negative integer, got ${String(value)}`, {
        threshold: name,
        value: String(value),
      });
    }
  };
  const positive = (value: number, name: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
      throw new DomainError('BEHAV_THRESHOLD_INVALID', `threshold ${name} must be a positive integer, got ${String(value)}`, {
        threshold: name,
        value: String(value),
      });
    }
  };
  const unitRate = (value: number, name: string): void => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new DomainError('BEHAV_THRESHOLD_INVALID', `threshold ${name} must be a rate within [0, 1], got ${String(value)}`, {
        threshold: name,
        value: String(value),
      });
    }
  };
  positive(t.cadenceWindowDays, 'cadenceWindowDays');
  positive(t.cadenceMinBaseline, 'cadenceMinBaseline');
  positive(t.cadenceMinRecent, 'cadenceMinRecent');
  positive(t.cadenceTriggerDays, 'cadenceTriggerDays');
  positive(t.cadenceMediumDays, 'cadenceMediumDays');
  positive(t.cadenceHighDays, 'cadenceHighDays');
  if (t.cadenceTriggerDays >= t.cadenceMediumDays || t.cadenceMediumDays >= t.cadenceHighDays) {
    throw new DomainError(
      'BEHAV_THRESHOLD_INVALID',
      `cadence severity thresholds must be strictly increasing (trigger ${t.cadenceTriggerDays} < medium ${t.cadenceMediumDays} < high ${t.cadenceHighDays})`,
      { trigger: t.cadenceTriggerDays, medium: t.cadenceMediumDays, high: t.cadenceHighDays },
    );
  }
  positive(t.promiseMinStreak, 'promiseMinStreak');
  positive(t.promiseStreakHigh, 'promiseStreakHigh');
  positive(t.partialWindowDays, 'partialWindowDays');
  unitRate(t.partialMinRate, 'partialMinRate');
  unitRate(t.partialRateIncrease, 'partialRateIncrease');
  positive(t.partialMinPayments, 'partialMinPayments');
  positive(t.silenceGraceDays, 'silenceGraceDays');
  positive(t.silenceMediumDays, 'silenceMediumDays');
  positive(t.silenceHighDays, 'silenceHighDays');
  if (t.silenceGraceDays >= t.silenceMediumDays || t.silenceMediumDays >= t.silenceHighDays) {
    throw new DomainError(
      'BEHAV_THRESHOLD_INVALID',
      `silence severity thresholds must be strictly increasing (grace ${t.silenceGraceDays} < medium ${t.silenceMediumDays} < high ${t.silenceHighDays})`,
      { grace: t.silenceGraceDays, medium: t.silenceMediumDays, high: t.silenceHighDays },
    );
  }
  positive(t.disputeWindowDays, 'disputeWindowDays');
  positive(t.disputeSpikeMin, 'disputeSpikeMin');
  positive(t.disputeSpikeHigh, 'disputeSpikeHigh');
  if (t.disputeSpikeMin >= t.disputeSpikeHigh) {
    throw new DomainError(
      'BEHAV_THRESHOLD_INVALID',
      `dispute spike thresholds must be strictly increasing (min ${t.disputeSpikeMin} < high ${t.disputeSpikeHigh})`,
      { min: t.disputeSpikeMin, high: t.disputeSpikeHigh },
    );
  }
};

const resolveThresholds = (overrides?: Partial<AnomalyThresholds>): Readonly<AnomalyThresholds> => {
  const merged = { ...DEFAULT_ANOMALY_THRESHOLDS, ...(overrides ?? {}) } as AnomalyThresholds;
  assertThresholds(merged);
  return Object.freeze(merged);
};

const pickSeverity = (value: number, high: number, medium: number): AnomalySeverity =>
  value >= high ? 'high' : value >= medium ? 'medium' : 'low';

// ---------------------------------------------------------------------------
// Detectors — each: (ctx) => BehaviorAnomaly | null (silence: array)
// ---------------------------------------------------------------------------

interface DetectorContext {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly asOfMs: number;
  readonly detectedAt: string;
  readonly thresholds: Readonly<AnomalyThresholds>;
  readonly facts: NormalizedFacts;
}

const ref = (kind: EvidenceRef['kind'], id: string): EvidenceRef => Object.freeze({ kind, id });
const frozenRecord = <T extends Record<string, number | string>>(record: T): Readonly<T> => Object.freeze({ ...record });

const pick = (severity: AnomalySeverity, explanation: string, ctx: DetectorContext, type: BehaviorAnomalyType, evidence: readonly EvidenceRef[], measured: Record<string, number | string>): BehaviorAnomaly =>
  Object.freeze({
    orgId: ctx.orgId,
    customerId: ctx.customerId,
    type,
    rule: BEHAVIOR_ANOMALY_RULES[type],
    severity,
    explanation,
    evidence: Object.freeze([...evidence]),
    measured: frozenRecord(measured),
    thresholds: frozenRecord(thresholdsOf(ctx.thresholds, type)),
    detectedAt: ctx.detectedAt,
  });

/** The exact subset of thresholds a rule reads — exposed verbatim on the record. */
const thresholdsOf = (t: Readonly<AnomalyThresholds>, type: BehaviorAnomalyType): Record<string, number> => {
  switch (type) {
    case 'cadence_deterioration':
      return {
        cadenceWindowDays: t.cadenceWindowDays,
        cadenceMinBaseline: t.cadenceMinBaseline,
        cadenceMinRecent: t.cadenceMinRecent,
        cadenceTriggerDays: t.cadenceTriggerDays,
        cadenceMediumDays: t.cadenceMediumDays,
        cadenceHighDays: t.cadenceHighDays,
      };
    case 'promise_break_after_streak':
      return { promiseMinStreak: t.promiseMinStreak, promiseStreakHigh: t.promiseStreakHigh };
    case 'partial_payment_pattern':
      return {
        partialWindowDays: t.partialWindowDays,
        partialMinRate: t.partialMinRate,
        partialRateIncrease: t.partialRateIncrease,
        partialMinPayments: t.partialMinPayments,
      };
    case 'silence_after_promise':
      return {
        silenceGraceDays: t.silenceGraceDays,
        silenceMediumDays: t.silenceMediumDays,
        silenceHighDays: t.silenceHighDays,
      };
    case 'dispute_spike':
      return { disputeWindowDays: t.disputeWindowDays, disputeSpikeMin: t.disputeSpikeMin, disputeSpikeHigh: t.disputeSpikeHigh };
  }
};

/** 1. Sudden cadence deterioration vs the pre-window baseline. */
function detectCadenceDeterioration(ctx: DetectorContext): BehaviorAnomaly | null {
  const t = ctx.thresholds;
  const windowStartMs = ctx.asOfMs - t.cadenceWindowDays * DAY_MS;
  const settled = ctx.facts.payments.filter((p) => p.settledMs <= ctx.asOfMs);
  const recent = settled.filter((p) => p.settledMs > windowStartMs);
  const baseline = settled.filter((p) => p.settledMs <= windowStartMs);
  if (baseline.length < t.cadenceMinBaseline || recent.length < t.cadenceMinRecent) return null;
  const baselineMedian = medianOf([...baseline].map((p) => dayGap(p.dueMs, p.settledMs)).sort((a, b) => a - b));
  const recentMedian = medianOf([...recent].map((p) => dayGap(p.dueMs, p.settledMs)).sort((a, b) => a - b));
  if (baselineMedian === null || recentMedian === null) return null;
  const delta = recentMedian - baselineMedian;
  if (delta < t.cadenceTriggerDays) return null;
  const severity = pickSeverity(delta, t.cadenceHighDays, t.cadenceMediumDays);
  return pick(
    severity,
    `Payment cadence deteriorated: median days-to-pay rose from ${baselineMedian} (baseline over ${baseline.length} payments) to ${recentMedian} (last ${t.cadenceWindowDays} days over ${recent.length} payments), a change of +${delta} days (fires at +${t.cadenceTriggerDays}d).`,
    ctx,
    'cadence_deterioration',
    [...baseline.map((p) => p.ref), ...recent.map((p) => p.ref)],
    {
      baselineMedianDays: baselineMedian,
      recentMedianDays: recentMedian,
      deltaDays: delta,
      baselineCount: baseline.length,
      recentCount: recent.length,
    },
  );
}

const dayGap = (dueMs: number, settledMs: number): number => {
  const dayIndex = (ms: number): number => {
    const d = new Date(ms);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
  };
  return dayIndex(settledMs) - dayIndex(dueMs);
};

/**
 * 2. First-ever (or post-recovery) broken promise after a kept streak. Reads
 * the decided promises in decision order (resolvedAt, then input order as a
 * stable tiebreaker) and looks at the kept-run immediately before the LAST
 * decided promise.
 */
function detectPromiseBreakAfterStreak(ctx: DetectorContext): BehaviorAnomaly | null {
  const t = ctx.thresholds;
  const decided = ctx.facts.promises
    .filter((p) => p.outcome !== 'pending' && p.resolvedMs !== null && p.resolvedMs <= ctx.asOfMs)
    .map((p, index) => ({ p, index }))
    .sort((a, b) => (a.p.resolvedMs as number) - (b.p.resolvedMs as number) || a.index - b.index)
    .map(({ p }) => p);
  if (decided.length === 0) return null;
  const last = decided[decided.length - 1]!;
  if (last.outcome !== 'broken') return null;
  let streak = 0;
  for (let i = decided.length - 2; i >= 0; i -= 1) {
    const p = decided[i]!;
    if (p.outcome !== 'kept') break;
    streak += 1;
  }
  if (streak < t.promiseMinStreak) return null;
  const severity: AnomalySeverity = streak >= t.promiseStreakHigh ? 'high' : 'medium';
  const keptRefs = decided.slice(decided.length - 1 - streak, decided.length - 1).map((p) => p.ref);
  return pick(
    severity,
    `A customer with ${streak} consecutive kept promises just broke one: promise ${last.ref.id} was decided 'broken' on ${new Date(last.resolvedMs as number).toISOString()} after a ${streak}-kept streak (fires at ${t.promiseMinStreak}).`,
    ctx,
    'promise_break_after_streak',
    [last.ref, ...keptRefs],
    { streakKept: streak, brokenPromiseDecidedAt: new Date(last.resolvedMs as number).toISOString() },
  );
}

/** 3. Unusual partial-payment pattern: the partial share jumped vs baseline. */
function detectPartialPaymentPattern(ctx: DetectorContext): BehaviorAnomaly | null {
  const t = ctx.thresholds;
  const windowStartMs = ctx.asOfMs - t.partialWindowDays * DAY_MS;
  const settled = ctx.facts.payments.filter((p) => p.settledMs <= ctx.asOfMs);
  const recent = settled.filter((p) => p.settledMs > windowStartMs);
  const baseline = settled.filter((p) => p.settledMs <= windowStartMs);
  if (recent.length < t.partialMinPayments || baseline.length < t.partialMinPayments) return null;
  const baselineRate = baseline.filter((p) => p.partial).length / baseline.length;
  const recentRate = recent.filter((p) => p.partial).length / recent.length;
  const increase = recentRate - baselineRate;
  if (increase < t.partialRateIncrease || recentRate < t.partialMinRate) return null;
  const severity: AnomalySeverity = recentRate === 1 ? 'medium' : 'low';
  return pick(
    severity,
    `Unusual partial-payment pattern: the share of partial payments rose from ${round(baselineRate)} (baseline over ${baseline.length} payments) to ${round(recentRate)} (last ${t.partialWindowDays} days over ${recent.length} payments), an increase of ${round(increase)} (fires at +${t.partialRateIncrease}).`,
    ctx,
    'partial_payment_pattern',
    [...baseline.filter((p) => p.partial).map((p) => p.ref), ...recent.map((p) => p.ref)],
    {
      baselinePartialRate: round(baselineRate),
      recentPartialRate: round(recentRate),
      rateIncrease: round(increase),
      baselineCount: baseline.length,
      recentCount: recent.length,
    },
  );
}

const round = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * 4. Silence after promise: pending promises ≥ grace days past their
 * promised date with no inbound message AND no settled payment since the
 * promised date (the customer went quiet on a live commitment). One anomaly
 * per silent promise, ordered by promisedDate then promiseId.
 */
function detectSilenceAfterPromise(ctx: DetectorContext): readonly BehaviorAnomaly[] {
  const t = ctx.thresholds;
  const pending = ctx.facts.promises.filter((p) => p.outcome === 'pending');
  const inbound = ctx.facts.communications.filter((c) => c.direction === 'inbound');
  const anomalies: BehaviorAnomaly[] = [];
  for (const promise of [...pending].sort((a, b) => a.promisedMs - b.promisedMs || (a.ref.id < b.ref.id ? -1 : 1))) {
    const daysPast = dayGap(promise.promisedMs, ctx.asOfMs);
    if (daysPast < t.silenceGraceDays) continue;
    const heardSince = inbound.some((c) => c.sentMs > promise.promisedMs && c.sentMs <= ctx.asOfMs);
    const paidSince = ctx.facts.payments.some((p) => p.settledMs > promise.promisedMs && p.settledMs <= ctx.asOfMs);
    if (heardSince || paidSince) continue;
    const severity = pickSeverity(daysPast, t.silenceHighDays, t.silenceMediumDays);
    anomalies.push(
      pick(
        severity,
        `Silence after promise: the customer has been quiet for ${daysPast} days since promising to pay by ${new Date(promise.promisedMs).toISOString()} — no inbound message and no payment settled since (fires after ${t.silenceGraceDays} days).`,
        ctx,
        'silence_after_promise',
        [promise.ref],
        { daysPast, promisedDate: new Date(promise.promisedMs).toISOString() },
      ),
    );
  }
  return anomalies;
}

/** 5. Dispute spike: several disputes opened within the window. */
function detectDisputeSpike(ctx: DetectorContext): BehaviorAnomaly | null {
  const t = ctx.thresholds;
  const windowStartMs = ctx.asOfMs - t.disputeWindowDays * DAY_MS;
  const inWindow = ctx.facts.disputes.filter((d) => d.openedMs > windowStartMs && d.openedMs <= ctx.asOfMs);
  if (inWindow.length < t.disputeSpikeMin) return null;
  const severity: AnomalySeverity = inWindow.length >= t.disputeSpikeHigh ? 'high' : 'medium';
  return pick(
    severity,
    `Dispute spike: ${inWindow.length} disputes were opened in the last ${t.disputeWindowDays} days (fires at ${t.disputeSpikeMin}) — billing accuracy or delivery friction needs review.`,
    ctx,
    'dispute_spike',
    inWindow.map((d) => d.ref),
    { windowDisputeCount: inWindow.length, windowDays: t.disputeWindowDays },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every detector over the fact history and return the anomalies in FIXED
 * rule order (cadence → promise-break → partial → silence → dispute; the
 * silence rule emits per-promise anomalies ordered by promisedDate then
 * promiseId). Deterministic; facts are never mutated; records are frozen.
 */
export function detectAnomalies(
  orgId: Uuid,
  customerId: Uuid,
  facts: BehaviorFacts,
  clock: Clock,
  options?: AnomalyOptions,
): readonly BehaviorAnomaly[] {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('BEHAV_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const asOf = options?.asOf ?? clock.now();
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new DomainError('BEHAV_AS_OF_INVALID', `asOf must be a valid Date, got ${String(asOf)}`, { asOf: String(asOf) });
  }
  const thresholds = resolveThresholds(options?.thresholds);
  const ctx: DetectorContext = {
    orgId,
    customerId,
    asOfMs: asOf.getTime(),
    detectedAt: clock.now().toISOString(),
    thresholds,
    facts: normalizeFacts(facts),
  };
  const run = (type: BehaviorAnomalyType, detector: (ctx: DetectorContext) => BehaviorAnomaly | readonly BehaviorAnomaly[] | null): readonly BehaviorAnomaly[] => {
    const result = detector(ctx);
    if (result === null) return [];
    return Array.isArray(result) ? (result as readonly BehaviorAnomaly[]) : [result as BehaviorAnomaly];
  };
  return Object.freeze([
    ...run('cadence_deterioration', detectCadenceDeterioration),
    ...run('promise_break_after_streak', detectPromiseBreakAfterStreak),
    ...run('partial_payment_pattern', detectPartialPaymentPattern),
    ...run('silence_after_promise', detectSilenceAfterPromise),
    ...run('dispute_spike', detectDisputeSpike),
  ]);
}

/** Severity ranking for consumers that need to sort or gate on it. */
export const severityRank = (severity: AnomalySeverity): number => SEVERITY_ORDER[severity];
