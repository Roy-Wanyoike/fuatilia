/**
 * The Fuatilia event catalog — exactly the 27 core events of
 * docs/04-event-catalog.md (E01 invoicing.invoiceNumberAllocated …
 * E27 collections.promiseBroken), no more, no less.
 *
 * `FuatiliaEvent` is a discriminated union on `name`: every member carries a
 * narrow, serializable payload (ids as `Uuid`, minor units as safe-integer
 * numbers, timestamps as ISO-8601 strings, closed enums as literal unions).
 * Wave-3 deferrals (promiseToPayMade, caseClosed, intelligence.*, notifications.*,
 * consent.*) are deliberately absent — the envelope is stable, adding them later
 * is purely additive.
 *
 * Self-contained by design: this module imports ONLY from '../shared' and never
 * from other domain lanes — event payloads carry ids/scalars, so consumers
 * (collections intelligence, notifications, ledger) never import producers.
 */
import { DomainError } from '../shared';
import type { Currency, Uuid } from '../shared';
import type { DomainEvent } from './envelope';

// ---------------------------------------------------------------------------
// Local closed enums (mirrors of docs/05 — kept local so this module stays
// self-contained; the owning lanes define the authoritative versions)
// ---------------------------------------------------------------------------

/** docs/05 aging buckets (receivables lane owns the authoritative type). */
export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';
/** docs/05 Payment.channel — Daraja dual-path intake. */
export type PaymentChannel = 'c2b' | 'stk';
/** docs/05 ReconciliationMatch.confidence — auto or manual. */
export type MatchConfidence = 'auto' | 'manual';
/** docs/05 Allocation.strategy (H3). */
export type AllocationStrategy = 'fifo' | 'explicit' | 'pro_rata';
/**
 * E26 case trigger. Open string on purpose: docs/04 names `receivable.overdue`
 * as the canonical trigger and the collections lane (issue #8) owns the closed
 * set; the envelope stays additive when that lands.
 */
export type CaseTrigger = string;

// ---------------------------------------------------------------------------
// Payloads — one interface per event, keys exactly as docs/04 "Key payload"
// ---------------------------------------------------------------------------

/** E01 — invoicing.invoiceNumberAllocated (Ledger, Reporting). */
export interface InvoiceNumberAllocatedPayload {
  readonly invoiceId: Uuid;
  readonly invoiceNumber: string;
  readonly eTIMSRef: string;
}

/** E02 — invoicing.invoiceIssued (Receivables, Notifications). */
export interface InvoiceIssuedPayload {
  readonly invoiceId: Uuid;
  readonly customerId: Uuid;
  readonly totalMinor: number;
  readonly currency: Currency;
  /** ISO-8601 */
  readonly dueDate: string;
}

/** E03 — invoicing.invoiceSent (Collections — engagement signal). */
export interface InvoiceSentPayload {
  readonly invoiceId: Uuid;
  readonly channel: string; // delivery channel (email/sms/…), owned by invoicing
  /** ISO-8601 */
  readonly sentAt: string;
}

/** E04 — invoicing.invoiceVoided (Receivables, Ledger). */
export interface InvoiceVoidedPayload {
  readonly invoiceId: Uuid;
  readonly reason: string;
  readonly actorId: string;
}

/** E05 — receivable.opened (Collections, Intelligence). */
export interface ReceivableOpenedPayload {
  readonly receivableId: Uuid;
  readonly invoiceId: Uuid;
  readonly originalMinor: number;
  /** ISO-8601 */
  readonly dueDate: string;
}

/** E06 — receivable.partiallySettled (Collections, Notifications, Intelligence). */
export interface ReceivablePartiallySettledPayload {
  readonly receivableId: Uuid;
  readonly amountMinor: number;
  readonly remainingMinor: number;
}

/** E07 — receivable.settled (Collections, Intelligence, Ledger). */
export interface ReceivableSettledPayload {
  readonly receivableId: Uuid;
  /** ISO-8601 */
  readonly settledAt: string;
}

/** E08 — receivable.overdue (Collections — case trigger). */
export interface ReceivableOverduePayload {
  readonly receivableId: Uuid;
  readonly daysLate: number;
  readonly agingBucket: AgingBucket;
}

/** E09 — receivable.writtenOff (Ledger, Intelligence). */
export interface ReceivableWrittenOffPayload {
  readonly receivableId: Uuid;
  readonly reason: string;
  readonly approvedBy: string;
}

/** E10 — receivable.recovered (Ledger, Intelligence). */
export interface ReceivableRecoveredPayload {
  readonly receivableId: Uuid;
  readonly amountMinor: number;
}

/** E11 — payment.initiated (Notifications — STK prompt). */
export interface PaymentInitiatedPayload {
  readonly paymentId: Uuid;
  readonly channel: PaymentChannel;
  readonly requestedMinor: number;
}

/** E12 — payment.confirmed (Allocation, Reconciliation). */
export interface PaymentConfirmedPayload {
  readonly paymentId: Uuid;
  readonly confirmedMinor: number;
  readonly externalRef: string;
  /** ISO-8601 */
  readonly confirmedAt: string;
}

/** E13 — payment.failed (Notifications, Intelligence). */
export interface PaymentFailedPayload {
  readonly paymentId: Uuid;
  readonly failureCode: string;
}

/** E14 — payment.reversed (Ledger, Allocation — compensating). */
export interface PaymentReversedPayload {
  readonly paymentId: Uuid;
  readonly reason: string;
  readonly reversalOf: Uuid;
}

/** E15 — payments.duplicateCallbackObserved (Ops/monitoring — C5 tripwire). */
export interface DuplicateCallbackObservedPayload {
  readonly paymentId: Uuid;
  readonly externalRef: string;
  /** ISO-8601 */
  readonly seenAt: string;
}

/** E16 — reconciliation.paymentMatched (Allocation hint, Ops). */
export interface PaymentMatchedPayload {
  readonly matchId: Uuid;
  readonly paymentId: Uuid;
  readonly declaredRefs: readonly string[];
  readonly confidence: MatchConfidence;
}

/** E17 — reconciliation.paymentPartiallyMatched (Ops). */
export interface PaymentPartiallyMatchedPayload {
  readonly matchId: Uuid;
  readonly paymentId: Uuid;
  readonly explainedMinor: number;
}

/** E18 — reconciliation.matchReversed (Allocation, Ledger). */
export interface MatchReversedPayload {
  readonly matchId: Uuid;
  readonly reason: string;
}

/** E19 — adjustment.creditNoteIssued (Receivables — available credit). */
export interface CreditNoteIssuedPayload {
  readonly creditNoteId: Uuid;
  readonly customerId: Uuid;
  readonly totalMinor: number;
}

/** E20 — adjustment.creditNoteApplied (Ledger, Notifications). */
export interface CreditNoteAppliedPayload {
  readonly applicationId: Uuid;
  readonly creditNoteId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: number;
}

/** E21 — adjustment.refundRequested (Approvals, Ops). */
export interface RefundRequestedPayload {
  readonly refundId: Uuid;
  readonly paymentId: Uuid;
  readonly totalMinor: number;
  readonly reason: string;
}

/** E22 — adjustment.refundCompleted (Ledger, Notifications). */
export interface RefundCompletedPayload {
  readonly refundId: Uuid;
  /** ISO-8601 */
  readonly completedAt: string;
}

/**
 * E23 — adjustment.creditBalanceApplied (Ledger, Notifications).
 * `receivableId` is null when consented credit is routed to the balance
 * without a target receivable (wave-1 adjustments semantics, issue #4).
 */
export interface CreditBalanceAppliedPayload {
  readonly customerId: Uuid;
  readonly amountMinor: number;
  readonly receivableId: Uuid | null;
}

/** E24 — allocation.executed (Receivables, Ledger, Intelligence). */
export interface AllocationExecutedPayload {
  readonly allocationId: Uuid;
  /** Payment or credit-balance source of funds. */
  readonly sourceId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: number;
  readonly strategy: AllocationStrategy;
}

/** E25 — allocation.reversed (Ledger — append-only correction, R3). */
export interface AllocationReversedPayload {
  readonly allocationId: Uuid;
  readonly reason: string;
  /** The compensating entry created by the reversal. */
  readonly compensatingId: Uuid;
}

/** E26 — collections.caseOpened (Intelligence). The case is the owning aggregate. */
export interface CaseOpenedPayload {
  readonly caseId: Uuid;
  readonly receivableId: Uuid;
  readonly trigger: CaseTrigger;
}

/** E27 — collections.promiseBroken (Intelligence — priority boost). The case owns promises. */
export interface PromiseBrokenPayload {
  readonly promiseId: Uuid;
  readonly caseId: Uuid;
  /** ISO-8601 — when the promise was due. */
  readonly expectedAt: string;
}

// ---------------------------------------------------------------------------
// The discriminated union
// ---------------------------------------------------------------------------

/** Invoicing lane (E01–E04). */
export type InvoicingEvent =
  | DomainEvent<'invoicing.invoiceNumberAllocated', InvoiceNumberAllocatedPayload>
  | DomainEvent<'invoicing.invoiceIssued', InvoiceIssuedPayload>
  | DomainEvent<'invoicing.invoiceSent', InvoiceSentPayload>
  | DomainEvent<'invoicing.invoiceVoided', InvoiceVoidedPayload>;

/** Receivables lane (E05–E10). */
export type ReceivableEvent =
  | DomainEvent<'receivable.opened', ReceivableOpenedPayload>
  | DomainEvent<'receivable.partiallySettled', ReceivablePartiallySettledPayload>
  | DomainEvent<'receivable.settled', ReceivableSettledPayload>
  | DomainEvent<'receivable.overdue', ReceivableOverduePayload>
  | DomainEvent<'receivable.writtenOff', ReceivableWrittenOffPayload>
  | DomainEvent<'receivable.recovered', ReceivableRecoveredPayload>;

/** Payments lane (E11–E15). */
export type PaymentEvent =
  | DomainEvent<'payment.initiated', PaymentInitiatedPayload>
  | DomainEvent<'payment.confirmed', PaymentConfirmedPayload>
  | DomainEvent<'payment.failed', PaymentFailedPayload>
  | DomainEvent<'payment.reversed', PaymentReversedPayload>
  | DomainEvent<'payments.duplicateCallbackObserved', DuplicateCallbackObservedPayload>;

/** Reconciliation lane (E16–E18). */
export type ReconciliationEvent =
  | DomainEvent<'reconciliation.paymentMatched', PaymentMatchedPayload>
  | DomainEvent<'reconciliation.paymentPartiallyMatched', PaymentPartiallyMatchedPayload>
  | DomainEvent<'reconciliation.matchReversed', MatchReversedPayload>;

/** Adjustments lane (E19–E23). */
export type AdjustmentEvent =
  | DomainEvent<'adjustment.creditNoteIssued', CreditNoteIssuedPayload>
  | DomainEvent<'adjustment.creditNoteApplied', CreditNoteAppliedPayload>
  | DomainEvent<'adjustment.refundRequested', RefundRequestedPayload>
  | DomainEvent<'adjustment.refundCompleted', RefundCompletedPayload>
  | DomainEvent<'adjustment.creditBalanceApplied', CreditBalanceAppliedPayload>;

/** Allocation lane (E24–E25). */
export type AllocationEvent =
  | DomainEvent<'allocation.executed', AllocationExecutedPayload>
  | DomainEvent<'allocation.reversed', AllocationReversedPayload>;

/** Collections lane (E26–E27). */
export type CollectionsEvent =
  | DomainEvent<'collections.caseOpened', CaseOpenedPayload>
  | DomainEvent<'collections.promiseBroken', PromiseBrokenPayload>;

/** Every Fuatilia domain event — the full 27-event catalog of docs/04. */
export type FuatiliaEvent =
  | InvoicingEvent
  | ReceivableEvent
  | PaymentEvent
  | ReconciliationEvent
  | AdjustmentEvent
  | AllocationEvent
  | CollectionsEvent;

/** The 27 catalog names, in docs/04 table order (E01 → E27). */
export const EVENT_NAMES = Object.freeze([
  'invoicing.invoiceNumberAllocated', // E01
  'invoicing.invoiceIssued', // E02
  'invoicing.invoiceSent', // E03
  'invoicing.invoiceVoided', // E04
  'receivable.opened', // E05
  'receivable.partiallySettled', // E06
  'receivable.settled', // E07
  'receivable.overdue', // E08
  'receivable.writtenOff', // E09
  'receivable.recovered', // E10
  'payment.initiated', // E11
  'payment.confirmed', // E12
  'payment.failed', // E13
  'payment.reversed', // E14
  'payments.duplicateCallbackObserved', // E15
  'reconciliation.paymentMatched', // E16
  'reconciliation.paymentPartiallyMatched', // E17
  'reconciliation.matchReversed', // E18
  'adjustment.creditNoteIssued', // E19
  'adjustment.creditNoteApplied', // E20
  'adjustment.refundRequested', // E21
  'adjustment.refundCompleted', // E22
  'adjustment.creditBalanceApplied', // E23
  'allocation.executed', // E24
  'allocation.reversed', // E25
  'collections.caseOpened', // E26
  'collections.promiseBroken', // E27
] as const satisfies readonly EventName[]);

export type EventName = FuatiliaEvent['name'];

/** Catalog payload-schema version per name — the catalog ships at version 1. */
export const EVENT_VERSIONS: Readonly<Record<EventName, 1>> = Object.freeze(
  Object.fromEntries(EVENT_NAMES.map((name) => [name, 1 as const])) as Record<EventName, 1>,
);

/** Type guard for untrusted input (adapters, queue consumers). */
export const isEventName = (value: unknown): value is EventName =>
  typeof value === 'string' && (EVENT_NAMES as readonly string[]).includes(value);

/** Narrow a catalog name to its payload type (compile-time). */
export type PayloadOf<N extends EventName> = Extract<FuatiliaEvent, { name: N }>['payload'];

/**
 * Money → JSON-safe minor units for event payloads (docs/04 "serializable").
 * Mirrors the wave-1 receivables guard: refuses silent precision loss, so no
 * cent is ever corrupted on the way out.
 */
export function minorUnits(amount: number | bigint): number {
  const value = typeof amount === 'bigint' ? Number(amount) : amount;
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'EVENT_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${String(amount)} exceeds the safe-integer range for event payloads`,
      { amount: String(amount) },
    );
  }
  return value;
}
