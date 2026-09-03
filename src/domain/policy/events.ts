/**
 * Policy-lane domain events (wave 5, issue #34, VISION §3.9).
 *
 *   policy.decisionRecorded   EVERY policy evaluation — allow, deny AND
 *                             requires_approval — emits this audit fact.
 *                             Refusals are first-class facts, never silent
 *                             (mirrors collections.dunningBlockedNoConsent and
 *                             comms.sendBlockedNoConsent).
 *
 * The payload is deliberately NARROW and PII-free: what was requested (action
 * type, actor KIND, risk class, amount, effective channel — never the actor's
 * id, never the consent/dispute/promise context flags; the reason code already
 * encodes which governance rule fired), what was decided, and which rule ids
 * produced the decision (the audit trail). Consumer-facing context lives on
 * the caller's own audit record, linked by the subject ids below.
 *
 * Envelope mirrors the receivables/disputes/promises/behavior lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Dates travel as ISO-8601 strings, monetary values as plain
 * minor-unit numbers guarded against unsafe-integer precision loss, and
 * cross-lane ids (customer, receivable, case) as opaque Uuids so consumers
 * (agent API, NBA, memory, comms) never import producers. A broken injected
 * clock surfaces as the stable POLICY_CLOCK_INVALID, not as a raw error deep
 * in .toISOString() (behavior-lane precedent).
 */
import { DomainError, type Clock, type Currency, type Uuid } from '../shared';
import type { ActorType, Channel, RiskClass } from './request';
import type { Decision } from './rules';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Validated clock read — the only place this lane touches time. */
const nowIso = (clock: Clock): string => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('POLICY_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('POLICY_CLOCK_INVALID', `clock.now() must return a valid Date, got ${String(now)}`);
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

/** Minor units → JSON-safe number. Refuses silent precision loss. */
export function minorToNumber(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      'POLICY_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amountMinor} exceeds the safe-integer range for event payloads`,
    );
  }
  return amountMinor;
}

/**
 * `policy.decisionRecorded` — the audit fact for ONE governed action request.
 * Emitted for allow, deny AND requires_approval alike: an approval demand and
 * a refusal are as auditable as a permission. Aggregate id = the org (policy
 * is evaluated against the org's rule set; there is no policy aggregate).
 */
export const POLICY_DECISION_RECORDED = 'policy.decisionRecorded';

export interface DecisionRecordedPayload {
  readonly orgId: Uuid;
  /** Opaque subject ids the action targeted (null when not supplied). */
  readonly customerId: Uuid;
  readonly receivableId: Uuid | null;
  readonly caseId: Uuid | null;
  /** Verbatim requested action type — including unknown ones (safe-by-default denies are audited too). */
  readonly actionType: string;
  /** Actor KIND only — never the actor id (no PII in policy payloads). */
  readonly actorType: ActorType;
  readonly autonomous: boolean;
  readonly riskClass: RiskClass;
  readonly amountMinor: number | null;
  readonly currency: Currency | null;
  /** The EFFECTIVE channel (implied channel resolved); null when none applies. */
  readonly channel: Channel | null;
  readonly decision: Decision;
  /** Stable `POLICY_*` reason — the machine-readable "why". */
  readonly reasonCode: string;
  /** Rule ids that produced the decision (empty for engine pre-guard denials). */
  readonly matchedRuleIds: readonly string[];
  readonly ruleSetVersion: number;
  /** ISO-8601 — when the evaluation happened (from the injected Clock). */
  readonly requestedAt: string;
}

export type DecisionRecordedEvent = DomainEvent<'policy.decisionRecorded', DecisionRecordedPayload>;

/** Everything this lane emits. */
export type PolicyLaneEvent = DecisionRecordedEvent;
