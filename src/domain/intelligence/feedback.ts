/**
 * Recommendation feedback loop — the H7 closed circuit (issue #23, docs/06
 * H7 decision: "intelligence consumes outcome events … and records feedback;
 * it stays read-only over fund truth").
 *
 * Outcomes arrive as plain data (an adapter projects lane events like
 * `receivable.settled`, `collections.promiseBroken` or a collector's report
 * into an outcome) and are appended to an append-only feedback log — never
 * edited, never deleted (R3 discipline).
 *
 * IDEMPOTENCE (R9-style, mirroring the payments intake funnel): the first
 * record for a (recommendationId, outcomeKey) pair wins.
 *
 *   - replay with the SAME outcome → the ORIGINAL fact is returned untouched,
 *     nothing is appended, and `intelligence.duplicateOutcomeObserved` is
 *     emitted (the at-least-once tripwire — duplicates are observed, not
 *     re-processed);
 *   - same key but a DIFFERENT outcome → that is tampering, not a retry:
 *     INTEL_OUTCOME_CONFLICT (mirrors payments' DUPLICATE_AMOUNT_MISMATCH);
 *   - a different outcomeKey on the same recommendation is a NEW fact (a
 *     recommendation can legitimately accumulate history: promise_made,
 *     then later paid).
 *
 * Each accepted outcome appends ONE fact and emits TWO events: the raw
 * intake fact (`intelligence.recommendationOutcomeRecorded`) and the derived
 * H7 signal (`intelligence.feedbackRecorded`, outcome → deterministic
 * verdict). Effectiveness stats aggregate the verdicts — pure arithmetic
 * over the log, time-boxed only by an explicitly supplied `asOf` (never a
 * hidden clock read; no time travel beyond what the caller injects).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  domainEvent,
  type DuplicateOutcomeObservedPayload,
  type FeedbackRecordedPayload,
  type IntelligenceEvent,
  type RecommendationOutcomeRecordedPayload,
} from './events';
import {
  NEXT_ACTION_CAPABILITIES,
  type NextActionCapability,
  type RecommendationFact,
} from './recommendations';

// --- outcome taxonomy -----------------------------------------------------------------

export const RECOMMENDATION_OUTCOMES = [
  'paid',
  'partial',
  'promise_made',
  'escalated',
  'no_response',
] as const;
export type RecommendationOutcome = (typeof RECOMMENDATION_OUTCOMES)[number];

export const FEEDBACK_VERDICTS = ['effective', 'partially_effective', 'ineffective'] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

/**
 * The deterministic outcome → verdict mapping (the H7 signal). Full payment
 * validates the recommendation; movement (partial, a fresh promise) counts
 * as partial effectiveness; escalation or silence means the recommended
 * capability did not move the customer.
 */
export const OUTCOME_VERDICTS: Readonly<Record<RecommendationOutcome, FeedbackVerdict>> = {
  paid: 'effective',
  partial: 'partially_effective',
  promise_made: 'partially_effective',
  escalated: 'ineffective',
  no_response: 'ineffective',
};

// --- the feedback fact ------------------------------------------------------------------

/** One append-only feedback fact (unique by feedbackKey). */
export interface RecommendationFeedback {
  /** Idempotency key: `${recommendationId}:${outcomeKey}` — unique per fact. */
  readonly feedbackKey: string;
  readonly recommendationId: Uuid;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly customerId: Uuid;
  readonly capability: NextActionCapability;
  readonly outcome: RecommendationOutcome;
  readonly outcomeKey: string;
  readonly verdict: FeedbackVerdict;
  /** Caller-supplied context; null when absent. */
  readonly details: string | null;
  /** ISO-8601 — when the outcome happened in the real world. */
  readonly occurredAt: string;
  /** ISO-8601 — when the fact was appended (injected Clock). */
  readonly recordedAt: string;
}

export interface RecordOutcomeArgs {
  readonly outcome: string;
  /** Idempotency key; defaults to the outcome type (one fact per outcome type). */
  readonly outcomeKey?: string;
  readonly details?: string;
  /**
   * When the outcome happened in the real world (e.g. the settlement date of
   * the receivable.settled event this was projected from). Defaults to the
   * clock instant; a future-dated or malformed value is rejected.
   */
  readonly occurredAt?: Date;
}

export interface RecordOutcomeResult {
  /** The fact for this key — the ORIGINAL when replayed. */
  readonly feedback: RecommendationFeedback;
  readonly events: readonly IntelligenceEvent[];
  /** true → replay absorbed: the fact above is the pre-existing original. */
  readonly replayed: boolean;
}

// --- validation --------------------------------------------------------------------------

const assertFactId = (raw: string, label: string): Uuid => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError('INTEL_RECOMMENDATION_INVALID', `a recommendation requires a non-blank ${label}`, {
      field: label,
    });
  }
  return raw as Uuid;
};

const assertValidDate = (at: Date, code: 'INTEL_CLOCK_INVALID' | 'INTEL_OCCURRED_AT_INVALID'): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'the supplied instant is not a valid Date');
  }
  return at;
};

/**
 * Record an outcome for a recommendation — the feedback loop's intake.
 *
 * Idempotent by (recommendationId, outcomeKey): a replay returns the
 * ORIGINAL fact with `replayed: true` and emits
 * `intelligence.duplicateOutcomeObserved`; a key collision with a different
 * outcome throws INTEL_OUTCOME_CONFLICT. A fresh key appends exactly one
 * fact and emits
 * `intelligence.recommendationOutcomeRecorded` + `intelligence.feedbackRecorded`.
 *
 * The `existingFeedback` log is NEVER mutated — the caller owns the
 * append (the return value carries the fact to append).
 *
 * Throws:
 *   - INTEL_RECOMMENDATION_INVALID — malformed recommendation fact;
 *   - INTEL_CAPABILITY_INVALID — unknown capability on the recommendation;
 *   - INTEL_OUTCOME_INVALID — unknown outcome;
 *   - INTEL_OUTCOME_KEY_REQUIRED — blank/absent outcomeKey value;
 *   - INTEL_DETAILS_INVALID — details present but not a non-blank string;
 *   - INTEL_CLOCK_INVALID — broken clock or malformed occurredAt;
 *   - INTEL_OCCURRED_AT_INVALID — occurredAt is future-dated relative to the
 *     clock instant (outcomes cannot be recorded before they are observed);
 *   - INTEL_OUTCOME_CONFLICT — same key replayed with a different outcome.
 */
export function recordRecommendationOutcome(
  recommendation: RecommendationFact,
  args: RecordOutcomeArgs,
  existingFeedback: readonly RecommendationFeedback[],
  clock: Clock,
): RecordOutcomeResult {
  // Defensive shape validation — feedback must never inherit corrupt facts.
  assertFactId(recommendation.recommendationId, 'recommendationId');
  assertFactId(recommendation.orgId, 'orgId');
  assertFactId(recommendation.receivableId, 'receivableId');
  assertFactId(recommendation.customerId, 'customerId');
  if (!(NEXT_ACTION_CAPABILITIES as readonly string[]).includes(recommendation.capability)) {
    throw new DomainError(
      'INTEL_CAPABILITY_INVALID',
      `unknown capability on recommendation: ${String(recommendation.capability)}`,
      { capability: String(recommendation.capability), allowed: NEXT_ACTION_CAPABILITIES },
    );
  }
  if (!(RECOMMENDATION_OUTCOMES as readonly string[]).includes(args.outcome)) {
    throw new DomainError('INTEL_OUTCOME_INVALID', `unknown outcome: ${String(args.outcome)}`, {
      outcome: String(args.outcome),
      allowed: RECOMMENDATION_OUTCOMES,
    });
  }
  const outcome = args.outcome as RecommendationOutcome;
  const outcomeKey = args.outcomeKey ?? outcome;
  if (typeof outcomeKey !== 'string' || outcomeKey.trim().length === 0) {
    throw new DomainError(
      'INTEL_OUTCOME_KEY_REQUIRED',
      'outcomeKey must be a non-blank string (it is the idempotency key)',
      { outcomeKey: String(outcomeKey) },
    );
  }
  let details: string | null = null;
  if (args.details !== undefined) {
    if (typeof args.details !== 'string' || args.details.trim().length === 0) {
      throw new DomainError(
        'INTEL_DETAILS_INVALID',
        'details, when supplied, must be a non-blank string',
        { details: String(args.details) },
      );
    }
    details = args.details;
  }
  const recordedAt = assertValidDate(clock.now(), 'INTEL_CLOCK_INVALID');
  const occurredAt =
    args.occurredAt === undefined ? recordedAt : assertValidDate(args.occurredAt, 'INTEL_OCCURRED_AT_INVALID');
  if (occurredAt.getTime() > recordedAt.getTime()) {
    throw new DomainError(
      'INTEL_OCCURRED_AT_INVALID',
      `outcome occurredAt ${occurredAt.toISOString()} cannot be after the recorded instant ${recordedAt.toISOString()} — outcomes cannot be observed before they happen`,
      { occurredAt: occurredAt.toISOString(), recordedAt: recordedAt.toISOString() },
    );
  }

  const feedbackKey = `${recommendation.recommendationId}:${outcomeKey}`;
  const existing = existingFeedback.find((f) => f.feedbackKey === feedbackKey);
  if (existing !== undefined) {
    if (existing.outcome !== outcome) {
      throw new DomainError(
        'INTEL_OUTCOME_CONFLICT',
        `feedback key ${feedbackKey} already recorded outcome '${existing.outcome}' — replaying it as '${outcome}' is tampering, not a retry`,
        { feedbackKey, recordedOutcome: existing.outcome, attemptedOutcome: outcome },
      );
    }
    // R9 mirror: the original fact stands; the replay is only OBSERVED.
    const payload: DuplicateOutcomeObservedPayload = {
      recommendationId: recommendation.recommendationId,
      outcomeKey,
      outcome,
      originalRecordedAt: existing.recordedAt,
      observedAt: recordedAt.toISOString(),
    };
    const event = domainEvent<'intelligence.duplicateOutcomeObserved', DuplicateOutcomeObservedPayload>(
      'intelligence.duplicateOutcomeObserved',
      recommendation.recommendationId,
      payload,
      clock,
    );
    return { feedback: existing, events: [event], replayed: true };
  }

  const fact: RecommendationFeedback = {
    feedbackKey,
    recommendationId: recommendation.recommendationId,
    orgId: recommendation.orgId,
    receivableId: recommendation.receivableId,
    customerId: recommendation.customerId,
    capability: recommendation.capability,
    outcome,
    outcomeKey,
    verdict: OUTCOME_VERDICTS[outcome],
    details,
    occurredAt: occurredAt.toISOString(),
    recordedAt: recordedAt.toISOString(),
  };

  const recordedPayload: RecommendationOutcomeRecordedPayload = {
    recommendationId: fact.recommendationId,
    orgId: fact.orgId,
    receivableId: fact.receivableId,
    outcome,
    outcomeKey,
    details,
    occurredAt: fact.occurredAt,
    recordedAt: fact.recordedAt,
  };
  const feedbackPayload: FeedbackRecordedPayload = {
    recommendationId: fact.recommendationId,
    capability: fact.capability,
    outcome,
    verdict: fact.verdict,
    feedbackKey,
    recordedAt: fact.recordedAt,
  };
  const events: readonly IntelligenceEvent[] = [
    domainEvent<'intelligence.recommendationOutcomeRecorded', RecommendationOutcomeRecordedPayload>(
      'intelligence.recommendationOutcomeRecorded',
      recommendation.recommendationId,
      recordedPayload,
      clock,
    ),
    domainEvent<'intelligence.feedbackRecorded', FeedbackRecordedPayload>(
      'intelligence.feedbackRecorded',
      recommendation.recommendationId,
      feedbackPayload,
      clock,
    ),
  ];
  return { feedback: fact, events, replayed: false };
}

// --- effectiveness (pure stats over the feedback log) --------------------------------------

export interface EffectivenessStats {
  /** The capability these stats cover, or 'all' for the unfiltered log. */
  readonly capability: NextActionCapability | 'all';
  /** Feedback facts considered (after capability + asOf filters). */
  readonly total: number;
  readonly byOutcome: Readonly<Record<RecommendationOutcome, number>>;
  readonly byVerdict: Readonly<Record<FeedbackVerdict, number>>;
  /**
   * effective / total — the share of recorded outcomes that validate the
   * recommendation. 0 when total is 0 (no signal ≠ perfect score).
   */
  readonly effectivenessRate: number;
}

export interface EffectivenessOpts {
  /** Restrict to one capability. */
  readonly capability?: NextActionCapability;
  /**
   * Consider only facts recorded at/before this instant — the caller passes
   * the clock instant explicitly (no hidden time travel).
   */
  readonly asOf?: Date;
}

const zeroOutcomes = (): Record<RecommendationOutcome, number> => ({
  paid: 0,
  partial: 0,
  promise_made: 0,
  escalated: 0,
  no_response: 0,
});

const zeroVerdicts = (): Record<FeedbackVerdict, number> => ({
  effective: 0,
  partially_effective: 0,
  ineffective: 0,
});

/**
 * Aggregate the feedback log into effectiveness stats — pure arithmetic, no
 * I/O, no hidden clock. Deterministic: counts, then a plain ratio.
 */
export function feedbackEffectiveness(
  feedback: readonly RecommendationFeedback[],
  opts?: EffectivenessOpts,
): EffectivenessStats {
  const asOf = opts?.asOf === undefined ? undefined : assertValidDate(opts.asOf, 'INTEL_CLOCK_INVALID');
  const byOutcome = zeroOutcomes();
  const byVerdict = zeroVerdicts();
  let total = 0;
  for (const fact of feedback) {
    if (opts?.capability !== undefined && fact.capability !== opts.capability) continue;
    if (asOf !== undefined && Date.parse(fact.recordedAt) > asOf.getTime()) continue;
    if (!(RECOMMENDATION_OUTCOMES as readonly string[]).includes(fact.outcome)) {
      throw new DomainError('INTEL_OUTCOME_INVALID', `unknown outcome in feedback log: ${String(fact.outcome)}`, {
        feedbackKey: fact.feedbackKey,
        outcome: String(fact.outcome),
      });
    }
    total += 1;
    byOutcome[fact.outcome as RecommendationOutcome] += 1;
    byVerdict[OUTCOME_VERDICTS[fact.outcome as RecommendationOutcome]] += 1;
  }
  return {
    capability: opts?.capability ?? 'all',
    total,
    byOutcome,
    byVerdict,
    effectivenessRate: total === 0 ? 0 : byVerdict.effective / total,
  };
}

/**
 * Per-capability breakdown, in canonical NEXT_ACTION_CAPABILITIES order —
 * one row per capability that has at least one recorded fact (capabilities
 * with no feedback are simply absent, never zero-filled guesses).
 */
export function feedbackEffectivenessByCapability(
  feedback: readonly RecommendationFeedback[],
  opts?: Omit<EffectivenessOpts, 'capability'>,
): readonly EffectivenessStats[] {
  return NEXT_ACTION_CAPABILITIES.map((capability) =>
    feedbackEffectiveness(feedback, { ...opts, capability }),
  ).filter((stats) => stats.total > 0);
}
