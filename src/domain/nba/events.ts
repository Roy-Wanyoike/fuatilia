/**
 * NBA-lane domain events (wave 5, issue #36, VISION §3.4 + §3.10).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   nba.recommendationCreated        a ranked action plan was produced — the
 *                                    recommendation fact consumers subscribe to
 *   nba.actionOutcomeRecorded        the feedback hook recorded an outcome for
 *                                    a plan (append-only, idempotent)
 *   nba.duplicateOutcomeObserved     the idempotence tripwire: a replayed
 *                                    (planId, outcome) pair was observed and
 *                                    the ORIGINAL fact stands (R9 pattern,
 *                                    mirrors payments.duplicateCallbackObserved)
 *
 * Envelope mirrors the promises/disputes lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings, monetary values as safe-integer minor-unit numbers, and
 * cross-lane ids (org, customer, receivable) as opaque Uuids. The payload
 * references its evidence — the planId, the ranked alternatives, the policy
 * reason codes — instead of embedding any entity (docs/04 discipline).
 *
 * NOTE: `nba.*` is a new lane vocabulary; registration in docs/04 is left to
 * the events-lane owner (same as every prior wave-3/4/5 lane).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { NbaActionType } from './actions';
import type { NbaOutcome } from './features';

export interface DomainEvent<TName extends string, TPayload> {
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
 * NBA_CLOCK_INVALID, not as a raw TypeError deep in .toISOString()).
 */
const nowIso = (clock: Clock): string => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('NBA_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('NBA_CLOCK_INVALID', `clock.now() must return a valid Date, got ${String(now)}`);
  }
  return now.toISOString();
};

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
    occurredAt: nowIso(clock),
    payload,
  };
}

// --- nba.recommendationCreated -----------------------------------------------------

export interface RecommendationAlternative {
  readonly action: NbaActionType;
  readonly score: number;
}

export interface PolicyDenialEvidence {
  readonly action: NbaActionType;
  /** The F20 policy reason code carried by the deny/requires_approval decision. */
  readonly reasonCode: string;
  readonly decision: 'deny' | 'requires_approval';
}

export interface NbaRecommendationCreatedPayload {
  readonly planId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId: Uuid;
  /** Outstanding amount the plan was computed for (minor units). */
  readonly amountMinor: number;
  readonly currency: string;
  /** The recommended action; null when policy denied every candidate. */
  readonly recommendedAction: NbaActionType | null;
  readonly recommendedScore: number;
  /** Full eligible ranking below the recommendation (evidence for "why not X"). */
  readonly alternatives: readonly RecommendationAlternative[];
  /** Denials + approval requirements, as evidence that policy was honored. */
  readonly policyEvidence: readonly PolicyDenialEvidence[];
  /** ISO-8601 — when the plan was produced. */
  readonly createdAt: string;
}

// --- nba.actionOutcomeRecorded ------------------------------------------------------

export interface NbaActionOutcomeRecordedPayload {
  readonly planId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId: Uuid;
  /** The action the plan recommended (the outcome attributes to it). */
  readonly action: NbaActionType;
  readonly outcome: NbaOutcome;
  /** ISO-8601 — when the outcome happened (caller-supplied). */
  readonly occurredAt: string;
  /** ISO-8601 — when the fact was recorded (injected Clock). */
  readonly recordedAt: string;
}

// --- nba.duplicateOutcomeObserved ----------------------------------------------------

export interface NbaDuplicateOutcomeObservedPayload {
  readonly planId: Uuid;
  readonly outcome: NbaOutcome;
  /** ISO-8601 — when the replay was observed. */
  readonly seenAt: string;
}

export type NbaEvent =
  | DomainEvent<'nba.recommendationCreated', NbaRecommendationCreatedPayload>
  | DomainEvent<'nba.actionOutcomeRecorded', NbaActionOutcomeRecordedPayload>
  | DomainEvent<'nba.duplicateOutcomeObserved', NbaDuplicateOutcomeObservedPayload>;

/** Everything this lane emits. */
export type NbaLaneEvent = NbaEvent;
