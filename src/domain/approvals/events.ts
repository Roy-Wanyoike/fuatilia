/**
 * Approvals-lane domain events (wave 7, issue #52, SPEC §36 maker-checker).
 *
 *   approvals.requestCreated   an approval request was opened (state drafted)
 *                              against a matched org policy
 *   approvals.quorumMet        the quorum of DISTINCT approvers was crossed —
 *                              exactly once per request, at the crossing
 *                              decision (before `approvals.approved`, same
 *                              instant)
 *   approvals.approved         the request REACHED the approved state (quorum
 *                              crossed) — a state fact, emitted once
 *   approvals.rejected         a checker refused the operation (reason travels)
 *   approvals.expired          the TTL swept the request (Clock past expiresAt)
 *   approvals.cancelled        the requester withdrew the pending request
 *   approvals.applied          the approved operation was marked applied —
 *                              the approval evidence bundle travels in the
 *                              FUNCTION RESULT, never in this narrow event
 *   approvals.decisionRefused  every REFUSED lane operation (self-approval,
 *                              role not held, duplicate approver, wrong
 *                              state, quorum shortfall, cancel by a
 *                              non-requester) — refusals are first-class
 *                              facts, never silent (mirrors
 *                              webhook.deliveryRefused and
 *                              collections.dunningBlockedNoConsent)
 *
 * Envelope mirrors the policy/promises/webhooks lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Dates travel as ISO-8601 strings, monetary values as plain
 * minor-unit numbers guarded against unsafe-integer precision loss, and
 * cross-lane ids (org, subject entities, roles) as opaque strings/Uuids so
 * consumers never import producers. Unlike the policy lane, approver /
 * requester / canceller ids DO travel: maker-checker IS an audit record of
 * who decided (SPEC §37 "approval information"). A broken injected clock
 * surfaces as the stable APPROVAL_CLOCK_INVALID, not as a raw error deep in
 * .toISOString() (policy/behavior-lane precedent).
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { ApprovalRefusalOperation, PayloadSnapshot } from './request';
import type { OperationType } from './policy';

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
    throw new DomainError('APPROVAL_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError(
      'APPROVAL_CLOCK_INVALID',
      `clock.now() must return a valid Date, got ${String(now)}`,
    );
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
      'APPROVAL_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amountMinor} exceeds the safe-integer range for event payloads`,
    );
  }
  return amountMinor;
}

// --- the catalog -------------------------------------------------------------------

export const APPROVALS_REQUEST_CREATED = 'approvals.requestCreated';
export const APPROVALS_QUORUM_MET = 'approvals.quorumMet';
export const APPROVALS_APPROVED = 'approvals.approved';
export const APPROVALS_REJECTED = 'approvals.rejected';
export const APPROVALS_EXPIRED = 'approvals.expired';
export const APPROVALS_CANCELLED = 'approvals.cancelled';
export const APPROVALS_APPLIED = 'approvals.applied';
export const APPROVALS_DECISION_REFUSED = 'approvals.decisionRefused';

export interface RequestCreatedPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly policyId: Uuid;
  readonly subjectRefs: readonly Uuid[];
  /** Caller-redacted snapshot of what would execute — never raw PII by contract. */
  readonly payloadSnapshot: PayloadSnapshot;
  readonly requesterId: string;
  readonly requiredApproverRoles: readonly string[];
  readonly quorum: number;
  readonly ttlDays: number;
  /** ISO-8601 — when the request stops accepting decisions. */
  readonly expiresAt: string;
  readonly createdAt: string;
}

export type RequestCreatedEvent = DomainEvent<'approvals.requestCreated', RequestCreatedPayload>;

export interface QuorumMetPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly quorum: number;
  readonly distinctApproverCount: number;
  readonly metAt: string;
}

export type QuorumMetEvent = DomainEvent<'approvals.quorumMet', QuorumMetPayload>;

export interface ApprovedPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly quorum: number;
  readonly distinctApproverCount: number;
  readonly approvedAt: string;
}

export type ApprovedEvent = DomainEvent<'approvals.approved', ApprovedPayload>;

export interface RejectedPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly rejectedBy: string;
  readonly reason: string;
  readonly rejectedAt: string;
}

export type RejectedEvent = DomainEvent<'approvals.rejected', RejectedPayload>;

export interface ExpiredPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly expiresAt: string;
  readonly expiredAt: string;
}

export type ExpiredEvent = DomainEvent<'approvals.expired', ExpiredPayload>;

export interface CancelledPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly cancelledBy: string;
  readonly cancelledAt: string;
}

export type CancelledEvent = DomainEvent<'approvals.cancelled', CancelledPayload>;

export interface AppliedPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  readonly appliedAt: string;
}

export type AppliedEvent = DomainEvent<'approvals.applied', AppliedPayload>;

export interface DecisionRefusedPayload {
  readonly orgId: Uuid;
  readonly approvalRequestId: Uuid;
  readonly operationType: OperationType;
  /** Which lane operation was attempted: submit | approve | reject | expire | cancel | apply. */
  readonly attempted: ApprovalRefusalOperation;
  /** Opaque actor attempting the operation; null when the lane operation has no actor (expire). */
  readonly attemptedBy: string | null;
  /** Stable `APPROVAL_*` reason — the machine-readable "why". */
  readonly reasonCode: string;
  readonly detail: string;
}

export type DecisionRefusedEvent = DomainEvent<'approvals.decisionRefused', DecisionRefusedPayload>;

/** Everything this lane emits. */
export type ApprovalLaneEvent =
  | RequestCreatedEvent
  | QuorumMetEvent
  | ApprovedEvent
  | RejectedEvent
  | ExpiredEvent
  | CancelledEvent
  | AppliedEvent
  | DecisionRefusedEvent;
