/**
 * Receivables-lane domain events (wave 1, issue #1).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *   receivable.opened / .partiallySettled / .settled / .overdue / .writtenOff / .recovered
 * plus the invoicing.* events the Invoice aggregate produces while it lives in
 * this module (E02 invoiceIssued, E03 invoiceSent, E04 invoiceVoided; E01
 * invoiceNumberAllocated lands with full eTIMS integration, issue #10).
 *
 * Wave-1 envelope: plain objects `{ name, version, aggregateId, occurredAt, payload }`
 * (the typed catalog + outbox of issue #6 wraps these — `version` stays 1 until a
 * breaking payload change). Payloads are narrow, serializable and id-only; dates
 * travel as ISO-8601 strings and monetary values as plain minor-unit numbers,
 * guarded against unsafe-integer precision loss so no cent is ever corrupted on
 * the way out.
 */
import { Clock, DomainError, Money, Uuid } from '../shared';
import type { AgingBucket } from './aging';

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

/** Money → JSON-safe minor units. Refuses silent precision loss. */
export function minorToNumber(amount: Money): number {
  const value = Number(amount.amount);
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'EVENT_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amount.amount} ${amount.currency} exceeds the safe-integer range for event payloads`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// receivable.* events (E05–E10)
// ---------------------------------------------------------------------------

export interface ReceivableOpenedPayload {
  readonly receivableId: Uuid;
  readonly invoiceId: Uuid;
  readonly originalMinor: number;
  /** ISO-8601 */
  readonly dueDate: string;
}

export interface ReceivablePartiallySettledPayload {
  readonly receivableId: Uuid;
  readonly amountMinor: number;
  readonly remainingMinor: number;
}

export interface ReceivableSettledPayload {
  readonly receivableId: Uuid;
  /** ISO-8601 */
  readonly settledAt: string;
}

export interface ReceivableOverduePayload {
  readonly receivableId: Uuid;
  readonly daysLate: number;
  readonly agingBucket: AgingBucket;
}

export interface ReceivableWrittenOffPayload {
  readonly receivableId: Uuid;
  readonly reason: string;
  readonly approvedBy: string;
}

export interface ReceivableRecoveredPayload {
  readonly receivableId: Uuid;
  readonly amountMinor: number;
}

export type ReceivableEvent =
  | DomainEvent<'receivable.opened', ReceivableOpenedPayload>
  | DomainEvent<'receivable.partiallySettled', ReceivablePartiallySettledPayload>
  | DomainEvent<'receivable.settled', ReceivableSettledPayload>
  | DomainEvent<'receivable.overdue', ReceivableOverduePayload>
  | DomainEvent<'receivable.writtenOff', ReceivableWrittenOffPayload>
  | DomainEvent<'receivable.recovered', ReceivableRecoveredPayload>;

// ---------------------------------------------------------------------------
// invoicing.* events produced by the Invoice aggregate (E02–E04)
// ---------------------------------------------------------------------------

export interface InvoiceIssuedPayload {
  readonly invoiceId: Uuid;
  readonly customerId: Uuid;
  readonly totalMinor: number;
  readonly currency: string;
  /** ISO-8601 */
  readonly dueDate: string;
}

export interface InvoiceSentPayload {
  readonly invoiceId: Uuid;
  readonly channel: string;
  /** ISO-8601 */
  readonly sentAt: string;
}

export interface InvoiceVoidedPayload {
  readonly invoiceId: Uuid;
  readonly reason: string;
  readonly actorId: string;
}

export type InvoiceEvent =
  | DomainEvent<'invoicing.invoiceIssued', InvoiceIssuedPayload>
  | DomainEvent<'invoicing.invoiceSent', InvoiceSentPayload>
  | DomainEvent<'invoicing.invoiceVoided', InvoiceVoidedPayload>;
