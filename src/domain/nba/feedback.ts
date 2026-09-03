/**
 * The NBA feedback hook (issue #36, VISION §3.4 "historical collection
 * outcomes … later tune weights").
 *
 * `recordOutcome` appends ONE append-only, idempotent feedback fact per
 * (planId, outcome) pair — the same R9 idempotence discipline as payment
 * intake: a replay returns the ORIGINAL fact list unchanged and raises the
 * tripwire `nba.duplicateOutcomeObserved` instead of a second
 * `nba.actionOutcomeRecorded`. Same plan + different outcome, or same
 * outcome + different plan, are genuinely new facts and append.
 *
 * The facts are PLAIN DATA (data in → data out): the caller owns the store;
 * this module never mutates its input — every call returns a fresh array.
 *
 * `actionEffectiveness` derives simple, deterministic per-action stats from
 * an accumulated fact list (pure replay — same facts in, same stats out, no
 * clock, no randomness), so weight tuning (a later wave) has an auditable
 * starting point: counts per outcome and the share of "success" outcomes
 * (paid | partial | promise_made) per action.
 */
import { DomainError, type Clock } from '../shared';
import { assertNbaActionType, NBA_ACTIONS, type NbaActionType } from './actions';
import { NBA_OUTCOMES, type NbaFeatureBundle, type NbaOutcome } from './features';
import {
  domainEvent,
  type NbaActionOutcomeRecordedPayload,
  type NbaDuplicateOutcomeObservedPayload,
  type NbaEvent,
} from './events';
import type { NbaRankedPlan } from './rank';

/** One append-only feedback fact: the outcome of a plan's recommended action. */
export interface ActionOutcomeFact {
  readonly planId: NbaRankedPlan['planId'];
  /** The action the plan recommended — the outcome attributes to it. */
  readonly action: NbaActionType;
  readonly outcome: NbaOutcome;
  /** ISO-8601 — when the outcome happened (caller-supplied). */
  readonly occurredAt: string;
  /** ISO-8601 — when the fact was recorded (injected Clock). */
  readonly recordedAt: string;
}

export type RecordOutcomeResult =
  | {
      readonly duplicate: false;
      /** Fresh array = original facts + the new fact (input never mutated). */
      readonly facts: readonly ActionOutcomeFact[];
      readonly events: readonly [NbaEvent & { name: 'nba.actionOutcomeRecorded' }];
    }
  | {
      /** Replay: facts stand unchanged; the tripwire fires instead. */
      readonly duplicate: true;
      /** The ORIGINAL fact list, bit-for-bit (same content, same order). */
      readonly facts: readonly ActionOutcomeFact[];
      readonly events: readonly [NbaEvent & { name: 'nba.duplicateOutcomeObserved' }];
    };

const assertOccurredAt = (value: Date): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new DomainError('NBA_OCCURRED_AT_INVALID', `occurredAt must be a valid Date, got ${String(value)}`, {});
  }
  return value.toISOString();
};

/**
 * Defensive shape guard for the caller-supplied plan: the feedback hook only
 * reads ids + the recommended action off it, but garbage in must surface as
 * a stable `NBA_*` code, never as a malformed fact/event payload.
 */
const assertPlanShape = (plan: NbaRankedPlan): void => {
  if (plan === null || typeof plan !== 'object') {
    throw new DomainError('NBA_PLAN_INVALID', `plan must be a ranked plan object, got ${String(plan)}`, {});
  }
  for (const field of ['planId', 'orgId', 'customerId', 'receivableId'] as const) {
    const value = plan[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DomainError('NBA_PLAN_INVALID', `the plan requires a non-blank ${field}`, { field });
    }
  }
  if (plan.recommended !== null) {
    // NBA never invents an action to attribute an outcome to.
    assertNbaActionType(plan.recommended.action);
  }
};

/**
 * Record the outcome of a plan (append-only, idempotent on
 * unique(planId, outcome)).
 *
 * Throws (malformed input only — a duplicate is never an error, it is a
 * fact): NBA_OUTCOME_INVALID, NBA_OCCURRED_AT_INVALID, NBA_CLOCK_INVALID,
 * NBA_PLAN_INVALID, NBA_ACTION_INVALID, NBA_PLAN_HAS_NO_RECOMMENDATION.
 */
export function recordOutcome(
  existing: readonly ActionOutcomeFact[],
  plan: NbaRankedPlan,
  outcome: NbaOutcome,
  occurredAt: Date,
  clock: Clock,
): RecordOutcomeResult {
  if (!(NBA_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new DomainError('NBA_OUTCOME_INVALID', `unknown plan outcome: ${String(outcome)}`, {
      outcome: String(outcome),
      allowed: NBA_OUTCOMES,
    });
  }
  const occurredIso = assertOccurredAt(occurredAt);
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('NBA_CLOCK_INVALID', 'the injected Clock returned an invalid Date', {});
  }
  const recordedIso = now.toISOString();
  assertPlanShape(plan);

  if (plan.recommended === null) {
    // A plan whose every candidate was denied recommended NOTHING — there is
    // no action whose outcome could be recorded (NBA never invents one).
    throw new DomainError('NBA_PLAN_HAS_NO_RECOMMENDATION', `plan ${plan.planId} recommended no action — nothing to record an outcome for`, {
      planId: plan.planId,
    });
  }

  const duplicate = existing.some((f) => f.planId === plan.planId && f.outcome === outcome);
  if (duplicate) {
    return {
      duplicate: true,
      facts: [...existing],
      events: [
        domainEvent<'nba.duplicateOutcomeObserved', NbaDuplicateOutcomeObservedPayload>(
          'nba.duplicateOutcomeObserved',
          plan.planId,
          { planId: plan.planId, outcome, seenAt: recordedIso },
          clock,
        ),
      ],
    };
  }

  const fact: ActionOutcomeFact = {
    planId: plan.planId,
    action: plan.recommended.action,
    outcome,
    occurredAt: occurredIso,
    recordedAt: recordedIso,
  };
  const event = domainEvent<'nba.actionOutcomeRecorded', NbaActionOutcomeRecordedPayload>(
    'nba.actionOutcomeRecorded',
    plan.planId,
    {
      planId: plan.planId,
      orgId: plan.orgId,
      customerId: plan.customerId,
      receivableId: plan.receivableId,
      action: fact.action,
      outcome,
      occurredAt: occurredIso,
      recordedAt: recordedIso,
    },
    clock,
  );
  return { duplicate: false, facts: [...existing, fact], events: [event] };
}

// --- effectiveness stats (deterministic replay over accumulated facts) ------------------

/** Outcomes that count as "this action worked". */
export const NBA_SUCCESS_OUTCOMES: readonly NbaOutcome[] = ['paid', 'partial', 'promise_made'];

export interface ActionEffectiveness {
  readonly action: NbaActionType;
  /** Total recorded outcomes for this action. */
  readonly total: number;
  /** Exact count per outcome (all six keys present, 0 when unobserved). */
  readonly byOutcome: Readonly<Record<NbaOutcome, number>>;
  /** paid + partial + promise_made. */
  readonly successCount: number;
  /** floor(1000 × successCount / total) — permill, integer. */
  readonly successRatePermill: number;
}

/**
 * Derive per-action effectiveness from accumulated feedback facts. Pure and
 * deterministic: same facts in → same stats out (actions in canonical
 * NBA_ACTIONS order, only actions with ≥ 1 fact appear). Defensively
 * validates the facts — a corrupted ledger throws, it never skews stats.
 */
export function actionEffectiveness(facts: readonly ActionOutcomeFact[]): readonly ActionEffectiveness[] {
  for (const fact of facts) {
    if (fact === null || typeof fact !== 'object') {
      throw new DomainError('NBA_FACT_INVALID', 'feedback facts must be objects', {});
    }
    assertNbaActionType(fact.action);
    if (!(NBA_OUTCOMES as readonly string[]).includes(fact.outcome)) {
      throw new DomainError('NBA_OUTCOME_INVALID', `unknown outcome in feedback facts: ${String(fact.outcome)}`, {
        outcome: String(fact.outcome),
      });
    }
  }

  const stats = new Map<NbaActionType, Record<NbaOutcome, number>>();
  for (const fact of facts) {
    const row = stats.get(fact.action) ?? {
      paid: 0,
      partial: 0,
      promise_made: 0,
      no_response: 0,
      escalated: 0,
      opted_out: 0,
    };
    row[fact.outcome] += 1;
    stats.set(fact.action, row);
  }

  return NBA_ACTIONS.filter((action) => stats.has(action)).map((action) => {
    const byOutcome = stats.get(action)!;
    const total = NBA_OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0);
    const successCount = NBA_SUCCESS_OUTCOMES.reduce((sum, outcome) => sum + byOutcome[outcome], 0);
    return {
      action,
      total,
      byOutcome,
      successCount,
      successRatePermill: Math.floor((1000 * successCount) / total),
    };
  });
}

/** Feature-bundle projection helper: facts → the bundle's priorOutcomes shape. */
export const priorOutcomesOf = (facts: readonly ActionOutcomeFact[]): NbaFeatureBundle['priorOutcomes'] =>
  facts.map((f) => ({ action: f.action, outcome: f.outcome }));
