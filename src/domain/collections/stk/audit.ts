/**
 * Lane events → the unified §37 audit trail (RICE #2, issue #53 precedent).
 *
 * Every STK-push transition emits its lane event in the repo envelope, and
 * every one of those events projects cleanly into the EXISTING audit lane:
 * `auditFromEvent` (the plain-envelope projection) + the closed
 * `AUDIT_ACTIONS` vocabulary, with NO new audit format and no lane-specific
 * audit schema. The mapping is closed and exhaustive — adding a lane event
 * without an honest audit action is a compile error, never a silent gap.
 *
 * Closed-vocabulary actions used (honesty over convenience):
 *
 *   stk.pushProposed          → create      (the entity came into existence)
 *   stk.pushAwaitingApproval  → transition  (lifecycle state change)
 *   stk.pushApproved          → approve     (an approval was granted)
 *   stk.pushInitiated         → send        (outbound push dispatched)
 *   stk.pushNotInitiated      → send        (the send attempt, refused by the wire)
 *   stk.pushConfirmed         → ingest      (callback received + reconciled)
 *   stk.pushFailed            → ingest      (callback received + reconciled)
 *   stk.pushTimedOut          → transition  (lifecycle state change)
 *   stk.pushRefused           → transition  (lifecycle state change — the
 *                              refusal itself is ALSO the compliance event,
 *                              mirroring collections.dunningBlockedNoConsent)
 *   payments.duplicateCallbackObserved → ingest (the R9 tripwire this lane's
 *                              reconciliation surfaced)
 *
 * Pure: no I/O, no clock reads (the event's own instant is preserved — the
 * record attests the action, which happened when the event happened).
 * Adapters chain-stamp the returned draft through the audit lane's
 * `appendAuditRecord` onto their `AuditSink`.
 */
import { auditFromEvent } from '../../audit/project';
import type { AppendAuditInput, AuditAction, AuditActor } from '../../audit/record';
import { DomainError } from '../../shared';
import type { Uuid } from '../../shared';
import type { PaymentEvent } from '../../payments/events';
import type { StkPushEvent } from './events';

/** Context the envelope cannot carry (§37 fields the producer leaves out). */
export interface StkAuditContext {
  /** Caller-minted audit id (the audit lane mints nothing). */
  readonly auditId: Uuid;
  /** The org the record belongs to (the §37 record is org-scoped). */
  readonly orgId: Uuid;
  /** Who drove the attempt — kind ∈ user | apiKey | agent | system. */
  readonly actor: AuditActor;
  readonly requestId: string;
  /** Journey tie — defaults to the action id so one attempt chains its trail. */
  readonly correlationId?: string | null;
}

const STK_EVENT_ACTIONS: Readonly<Record<StkPushEvent['name'], AuditAction>> = {
  'stk.pushProposed': 'create',
  'stk.pushRefused': 'transition',
  'stk.pushAwaitingApproval': 'transition',
  'stk.pushApproved': 'approve',
  'stk.pushInitiated': 'send',
  'stk.pushNotInitiated': 'send',
  'stk.pushConfirmed': 'ingest',
  'stk.pushFailed': 'ingest',
  'stk.pushTimedOut': 'transition',
};

/**
 * Project one lane event into a complete §37 audit draft. The event's
 * `occurredAt` is preserved verbatim; the context segment of the name
 * (`stk`) becomes the entityType and the action id the entityId. The event
 * payload's orgId must agree with the context's — a record for another org
 * is a caller bug, refused.
 */
export const stkPushAuditInput = (event: StkPushEvent, ctx: StkAuditContext): AppendAuditInput => {
  if (event.payload.orgId !== ctx.orgId) {
    throw new DomainError(
      'STK_AUDIT_ORG_MISMATCH',
      `event org ${String(event.payload.orgId)} does not match the audit context org ${ctx.orgId}`,
    );
  }
  return auditFromEvent(
    {
      name: event.name,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      payload: event.payload as unknown as Record<string, unknown>,
      correlationId: ctx.correlationId ?? event.aggregateId,
    },
    {
      auditId: ctx.auditId,
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: STK_EVENT_ACTIONS[event.name],
      requestId: ctx.requestId,
    },
  );
};

/**
 * Project the intake lane's duplicate-callback tripwire (the R9 fact this
 * lane's reconciliation surfaced) into a §37 ingest record. The duplicate
 * payload carries no org (payments-lane payloads are narrow), so the org
 * comes from the context. Only the duplicate observation is projected here —
 * the payments lane's own initiated/confirmed/failed facts keep their
 * existing treatment.
 */
export const duplicateCallbackAuditInput = (
  event: PaymentEvent & { name: 'payments.duplicateCallbackObserved' },
  ctx: StkAuditContext,
): AppendAuditInput =>
  auditFromEvent(
    {
      name: event.name,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt.toISOString(),
      payload: event.payload as unknown as Record<string, unknown>,
      correlationId: ctx.correlationId ?? event.aggregateId,
    },
    {
      auditId: ctx.auditId,
      orgId: ctx.orgId,
      actor: ctx.actor,
      action: 'ingest',
      requestId: ctx.requestId,
    },
  );
