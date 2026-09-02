/**
 * Adjustments — domain event constructors for the five `adjustment.*` facts owned
 * by this lane (docs/04-event-catalog.md E19–E23).
 *
 * Envelope: { name, version, aggregateId, payload, occurredAt } per
 * src/domain/events/README.md. eventId/correlationId assignment and the full
 * typed catalog land with issue #6; the payload key sets below are the contract
 * and will not change.
 *
 * Payloads are narrow and serializable: ids only (no entity references) and
 * integer minor units (bigint). Keys are camelCase per docs/04. occurredAt is an
 * ISO-8601 string derived from the injected Clock — never Date.now().
 */
import type { Clock, Uuid } from '../shared';

export type AdjustmentEventName =
  | 'adjustment.refundRequested'
  | 'adjustment.refundCompleted'
  | 'adjustment.creditNoteIssued'
  | 'adjustment.creditNoteApplied'
  | 'adjustment.creditBalanceApplied';

/** Stable envelope (issue #4); unifies with the typed catalog in issue #6. */
export interface AdjustmentEvent<TName extends AdjustmentEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the injected Clock
}

/** E21 — adjustment.refundRequested (Approvals, Ops). */
export interface RefundRequestedPayload {
  readonly refundId: Uuid;
  readonly paymentId: Uuid;
  readonly totalMinor: bigint;
  readonly reason: string;
}

/** E22 — adjustment.refundCompleted (Ledger, Notifications). */
export interface RefundCompletedPayload {
  readonly refundId: Uuid;
  readonly completedAt: string;
}

/** E19 — adjustment.creditNoteIssued (Receivables — available credit). */
export interface CreditNoteIssuedPayload {
  readonly creditNoteId: Uuid;
  readonly customerId: Uuid;
  readonly totalMinor: bigint;
}

/** E20 — adjustment.creditNoteApplied (Ledger, Notifications). */
export interface CreditNoteAppliedPayload {
  readonly applicationId: Uuid;
  readonly creditNoteId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: bigint;
}

/**
 * E23 — adjustment.creditBalanceApplied (Ledger, Notifications).
 * `receivableId` is null when consented credit-note excess is routed to the
 * balance (no receivable involved; the source note is traceable via the
 * movement's sourceId on the CustomerCreditBalance log).
 */
export interface CreditBalanceAppliedPayload {
  readonly customerId: Uuid;
  readonly amountMinor: bigint;
  readonly receivableId: Uuid | null;
}

const emit = <TName extends AdjustmentEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): AdjustmentEvent<TName, TPayload> => ({
  name,
  version: 1,
  aggregateId,
  payload,
  occurredAt: clock.now().toISOString(),
});

/** E21 — aggregate is the refund. */
export const refundRequestedEvent = (
  args: { refundId: Uuid; paymentId: Uuid; totalMinor: bigint; reason: string },
  clock: Clock,
): AdjustmentEvent<'adjustment.refundRequested', RefundRequestedPayload> =>
  emit('adjustment.refundRequested', args.refundId, { ...args }, clock);

/** E22 — aggregate is the refund; completedAt comes from the same Clock. */
export const refundCompletedEvent = (
  refundId: Uuid,
  clock: Clock,
): AdjustmentEvent<'adjustment.refundCompleted', RefundCompletedPayload> =>
  emit('adjustment.refundCompleted', refundId, { refundId, completedAt: clock.now().toISOString() }, clock);

/** E19 — aggregate is the credit note. */
export const creditNoteIssuedEvent = (
  args: { creditNoteId: Uuid; customerId: Uuid; totalMinor: bigint },
  clock: Clock,
): AdjustmentEvent<'adjustment.creditNoteIssued', CreditNoteIssuedPayload> =>
  emit('adjustment.creditNoteIssued', args.creditNoteId, { ...args }, clock);

/** E20 — aggregate is the credit note. */
export const creditNoteAppliedEvent = (
  args: { applicationId: Uuid; creditNoteId: Uuid; receivableId: Uuid; amountMinor: bigint },
  clock: Clock,
): AdjustmentEvent<'adjustment.creditNoteApplied', CreditNoteAppliedPayload> =>
  emit('adjustment.creditNoteApplied', args.creditNoteId, { ...args }, clock);

/** E23 — aggregate is the customer credit balance (keyed by customerId). */
export const creditBalanceAppliedEvent = (
  args: { customerId: Uuid; amountMinor: bigint; receivableId: Uuid | null },
  clock: Clock,
): AdjustmentEvent<'adjustment.creditBalanceApplied', CreditBalanceAppliedPayload> =>
  emit('adjustment.creditBalanceApplied', args.customerId, { ...args }, clock);
