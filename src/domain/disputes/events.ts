/**
 * Disputes-lane domain events (wave 3, issue #20, SPEC §29).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   dispute.opened         the PAUSE fact — automated collections must stop
 *                          dunning the receivable while the dispute is live;
 *   dispute.statusChanged  a non-terminal step (investigating, awaiting_*),
 *                          with reason + actor for the audit trail;
 *   dispute.resolved       a RESUME fact — carries the outcome decision
 *                          (optional remedy refs: credit note | write-off);
 *   dispute.rejected       a RESUME fact — claim not upheld;
 *   dispute.cancelled      a RESUME fact — withdrawn by the customer/business.
 *
 * The pause/resume policy itself lives in ./pause.ts — collections lanes
 * consult it as plain data (statuses / facts), never by importing the
 * aggregate's transition logic.
 *
 * Envelope mirrors the receivables lane: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings and cross-lane ids as opaque Uuids, so consumers
 * (collections, notifications, intelligence) never import producers.
 */
import type { Clock, Uuid } from '../shared';
import type { DisputeCategory, DisputeOutcome, DisputeStatus } from './dispute';

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
// dispute.* payloads
// ---------------------------------------------------------------------------

/** `dispute.opened` — the typed pause fact for collections automation. */
export interface DisputeOpenedPayload {
  readonly disputeId: Uuid;
  readonly disputeNumber: string;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly category: DisputeCategory;
  readonly description: string;
  /** Opaque evidence references (SPEC §29 "Evidence"); never dereferenced here. */
  readonly evidenceRefs: readonly string[];
  /** Opaque assigned-user id, null until someone is assigned. */
  readonly assignedTo: Uuid | null;
  /** Actor who opened the dispute (audit). */
  readonly openedBy: string;
  /** ISO-8601 */
  readonly openedAt: string;
}

/** `dispute.statusChanged` — a non-terminal step (investigating / awaiting_*). */
export interface DisputeStatusChangedPayload {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  readonly from: DisputeStatus;
  readonly to: DisputeStatus;
  readonly reason: string;
  readonly actorId: string;
}

/** `dispute.resolved` — RESUME fact with the outcome decision attached. */
export interface DisputeResolvedPayload {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  readonly reason: string;
  readonly actorId: string;
  readonly outcome: DisputeOutcome;
  /** ISO-8601 */
  readonly resolvedAt: string;
}

/** `dispute.rejected` — RESUME fact: the claim was investigated and not upheld. */
export interface DisputeRejectedPayload {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly rejectedAt: string;
}

/** `dispute.cancelled` — RESUME fact: withdrawn before/while investigating. */
export interface DisputeCancelledPayload {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly cancelledAt: string;
}

export type DisputeEvent =
  | DomainEvent<'dispute.opened', DisputeOpenedPayload>
  | DomainEvent<'dispute.statusChanged', DisputeStatusChangedPayload>
  | DomainEvent<'dispute.resolved', DisputeResolvedPayload>
  | DomainEvent<'dispute.rejected', DisputeRejectedPayload>
  | DomainEvent<'dispute.cancelled', DisputeCancelledPayload>;
