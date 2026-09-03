/**
 * Collections-lane domain events (wave 3, issue #8, review finding H6).
 *
 * Naming follows the issue-#8 event list (repo convention
 * `<context>.<aggregate><PastTenseVerb>`):
 *
 *   case.opened                        a CollectionsCase opened on one or more
 *                                      receivables — the R8 exclusivity fact
 *                                      (from here until closure those
 *                                      receivables are covered);
 *   case.actionRecorded                an action (call/sms/whatsapp/letter/
 *                                      fieldVisit/escalation) appended to the
 *                                      case's append-only action log;
 *   case.escalated                     the case priority was raised
 *                                      (low→normal→high→urgent) with a reason;
 *   case.resolved                      the case reached its outcome — a RESUME
 *                                      fact: the covered receivables remain
 *                                      covered only while the case is open;
 *   case.closed                        the case was closed as inactive — the
 *                                      receivables are RELEASED (R8): new
 *                                      cases may now cover them;
 *   collections.dunningBlockedNoConsent  a K2 refusal fact — an automated
 *                                      outbound dunning send (sms/whatsapp)
 *                                      was attempted WITHOUT a dunning
 *                                      consent reference and was therefore
 *                                      NOT executed. Compliance evidence for
 *                                      the Kenya DPA 2019 audit trail.
 *
 * Envelope mirrors the disputes lane: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings and cross-lane ids (receivable, collector) as opaque
 * Uuids, so consumers never import producers.
 */
import type { Clock, Uuid } from '../shared';
import type { CasePriority } from './case';
import type { CaseActionType } from './actions';

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
// case.* payloads
// ---------------------------------------------------------------------------

/** `case.opened` — the R8 exclusivity fact for the covered receivables. */
export interface CaseOpenedPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  /** Opaque receivable ids this case covers — exactly the ids R8 locks. */
  readonly receivableIds: readonly Uuid[];
  /** Opaque collector (user/team) id, owned by an adapter lane. */
  readonly collectorId: Uuid;
  readonly priority: CasePriority;
  readonly openedBy: string;
  /** ISO-8601 */
  readonly openedAt: string;
}

/** `case.actionRecorded` — an entry appended to the case's action log. */
export interface CaseActionRecordedPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  readonly actionId: string;
  readonly actionType: CaseActionType;
  /** ISO-8601 — when the action is scheduled to happen. */
  readonly scheduledFor: string;
  /** Non-null when the action was logged with its outcome already known. */
  readonly outcome: string | null;
  /** ISO-8601, non-null when the action is already completed. */
  readonly completedAt: string | null;
  /** Opaque dunning consent reference for outbound automated sends (K2). */
  readonly consentRef: string | null;
  readonly actorId: string;
  /** ISO-8601 — when the entry was appended to the log. */
  readonly recordedAt: string;
}

/** `case.escalated` — the case priority was raised with a recorded reason. */
export interface CaseEscalatedPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  readonly from: CasePriority;
  readonly to: CasePriority;
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly escalatedAt: string;
}

/** `case.resolved` — the case reached its outcome (receivables still covered while open). */
export interface CaseResolvedPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly resolvedAt: string;
}

/** `case.closed` — closed inactive; the covered receivables are RELEASED (R8). */
export interface CaseClosedPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  /** The receivables R8 coverage is released from at this instant. */
  readonly releasedReceivableIds: readonly Uuid[];
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly closedAt: string;
}

/**
 * `collections.dunningBlockedNoConsent` — a K2 refusal fact. The automated
 * outbound send was NOT appended to the action log and NOT executed; this
 * event is the compliance record of the blocked attempt (Kenya DPA 2019).
 */
export interface DunningBlockedNoConsentPayload {
  readonly caseId: Uuid;
  readonly caseNumber: string;
  readonly orgId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly actionType: CaseActionType;
  /** ISO-8601 — the send that would have gone out. */
  readonly scheduledFor: string;
  readonly actorId: string;
  /** Human-readable refusal detail (no dunning consent covers this send). */
  readonly reason: string;
  /** ISO-8601 — when the attempt was blocked. */
  readonly blockedAt: string;
}

export type CollectionsEvent =
  | DomainEvent<'case.opened', CaseOpenedPayload>
  | DomainEvent<'case.actionRecorded', CaseActionRecordedPayload>
  | DomainEvent<'case.escalated', CaseEscalatedPayload>
  | DomainEvent<'case.resolved', CaseResolvedPayload>
  | DomainEvent<'case.closed', CaseClosedPayload>
  | DomainEvent<'collections.dunningBlockedNoConsent', DunningBlockedNoConsentPayload>;

/** Event names of this lane, for registry/outbox wiring without importing payloads. */
export const COLLECTIONS_EVENT_NAMES = [
  'case.opened',
  'case.actionRecorded',
  'case.escalated',
  'case.resolved',
  'case.closed',
  'collections.dunningBlockedNoConsent',
] as const;

export type CollectionsEventName = (typeof COLLECTIONS_EVENT_NAMES)[number];
