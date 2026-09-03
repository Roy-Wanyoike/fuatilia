/**
 * Intelligence-lane domain events (wave 4, issue #23, review finding H7).
 *
 * F13 — collections priority scoring + recommendation feedback loop. The
 * intelligence layer is strictly READ-ONLY over fund truth (README design
 * principle 2, docs/07 R4): it consumes plain-data projections supplied by
 * the caller and emits its own facts. It never moves money and never
 * mutates another lane's aggregates.
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`
 * (the catalog's deferred list already reserved
 * `intelligence.priorityComputed` + `intelligence.feedbackRecorded`):
 *
 *   intelligence.priorityComputed               a scoring/ranking run over a
 *                                               batch of receivable projections
 *   intelligence.recommendationCreated          a recommended next capability
 *                                               was recorded as a fact
 *   intelligence.recommendationOutcomeRecorded  an outcome arrived for a
 *                                               recommendation (the R9-style
 *                                               intake fact)
 *   intelligence.feedbackRecorded               the derived H7 feedback signal
 *                                               (outcome → verdict) appended
 *                                               to the feedback log
 *   intelligence.duplicateOutcomeObserved       an outcome replay was absorbed:
 *                                               the ORIGINAL fact stands, the
 *                                               duplicate is NOT appended
 *                                               (monitoring tripwire, mirrors
 *                                               payments.duplicateCallbackObserved)
 *
 * Envelope mirrors the collections/promises lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings and cross-lane ids (receivable, customer, org) as opaque
 * Uuids, so consumers (collections, F22 next-best-action, reporting) never
 * import producers.
 */
import type { Clock, Uuid } from '../shared';
import type { NextActionCapability } from './recommendations';
import type { FeedbackVerdict, RecommendationOutcome } from './feedback';
import type { PriorityBand } from './scoring';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Pure event factory — the only way this module builds events. */
export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): DomainEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: clock.now().toISOString(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** `intelligence.priorityComputed` — one scoring/ranking run over one batch. */
export interface PriorityComputedPayload {
  readonly orgId: Uuid;
  /** How many receivable projections were scored. */
  readonly receivableCount: number;
  /** Receivable ids in final rank order (rank 1 first) — ids only, no scores. */
  readonly rankedReceivableIds: readonly Uuid[];
  /** ISO-8601 */
  readonly computedAt: string;
}

/** `intelligence.recommendationCreated` — a recommendation became a fact. */
export interface RecommendationCreatedPayload {
  readonly recommendationId: Uuid;
  readonly orgId: Uuid;
  /** Opaque receivable id — owned by the receivables lane. */
  readonly receivableId: Uuid;
  /** Opaque customer id — owned by the customer lane. */
  readonly customerId: Uuid;
  readonly capability: NextActionCapability;
  /** The priority score the recommendation was based on (explainable in-app). */
  readonly score: number;
  /** Band derived from `score` at creation time (same thresholds as scoring). */
  readonly band: PriorityBand;
  /** The transparent reasons — explainability is a hard requirement (H7). */
  readonly reasons: readonly string[];
  /** ISO-8601 */
  readonly createdAt: string;
}

/**
 * `intelligence.recommendationOutcomeRecorded` — the raw outcome intake fact
 * (R9-style: the FIRST record for a (recommendationId, outcomeKey) pair wins;
 * replays return the original fact and raise
 * `intelligence.duplicateOutcomeObserved` instead).
 */
export interface RecommendationOutcomeRecordedPayload {
  readonly recommendationId: Uuid;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly outcome: RecommendationOutcome;
  /** Caller-supplied idempotency key (defaults to the outcome type). */
  readonly outcomeKey: string;
  readonly details: string | null;
  /** ISO-8601 — when the outcome happened in the real world (caller-supplied). */
  readonly occurredAt: string;
  /** ISO-8601 — when the fact was appended (injected Clock). */
  readonly recordedAt: string;
}

/**
 * `intelligence.feedbackRecorded` — the H7 feedback signal: an outcome mapped
 * to a deterministic verdict for the recommendation's capability. This is the
 * fact `feedbackEffectiveness` aggregates over.
 */
export interface FeedbackRecordedPayload {
  readonly recommendationId: Uuid;
  readonly capability: NextActionCapability;
  readonly outcome: RecommendationOutcome;
  readonly verdict: FeedbackVerdict;
  /** Idempotency key: `${recommendationId}:${outcomeKey}` — unique per fact. */
  readonly feedbackKey: string;
  /** ISO-8601 */
  readonly recordedAt: string;
}

/**
 * `intelligence.duplicateOutcomeObserved` — an outcome replay was absorbed:
 * the original fact stands, nothing was appended. Compliance/monitoring
 * evidence that outcome intake is at-least-once safe (R9 discipline).
 */
export interface DuplicateOutcomeObservedPayload {
  readonly recommendationId: Uuid;
  readonly outcomeKey: string;
  /** The outcome carried by the DUPLICATE attempt. */
  readonly outcome: RecommendationOutcome;
  /** ISO-8601 — when the original fact was recorded. */
  readonly originalRecordedAt: string;
  /** ISO-8601 — when the duplicate was observed. */
  readonly observedAt: string;
}

export type IntelligenceEvent =
  | DomainEvent<'intelligence.priorityComputed', PriorityComputedPayload>
  | DomainEvent<'intelligence.recommendationCreated', RecommendationCreatedPayload>
  | DomainEvent<'intelligence.recommendationOutcomeRecorded', RecommendationOutcomeRecordedPayload>
  | DomainEvent<'intelligence.feedbackRecorded', FeedbackRecordedPayload>
  | DomainEvent<'intelligence.duplicateOutcomeObserved', DuplicateOutcomeObservedPayload>;

/** Everything this lane emits — registry/outbox wiring without payload imports. */
export const INTELLIGENCE_EVENT_NAMES = [
  'intelligence.priorityComputed',
  'intelligence.recommendationCreated',
  'intelligence.recommendationOutcomeRecorded',
  'intelligence.feedbackRecorded',
  'intelligence.duplicateOutcomeObserved',
] as const;

export type IntelligenceEventName = (typeof INTELLIGENCE_EVENT_NAMES)[number];
