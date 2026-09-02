/**
 * Event core barrel (issue #6) — the typed 27-event catalog, the stable
 * envelope, the naming/version guard rail and the outbox contract.
 */
export type {
  DomainEvent,
  EnvelopeOptions,
} from './envelope';
export {
  assertEventName,
  assertSerializablePayload,
  EVENT_NAME_PATTERN,
  makeEnvelope,
  validateEnvelope,
} from './envelope';

export type {
  AdjustmentEvent,
  AgingBucket,
  AllocationEvent,
  AllocationStrategy,
  CaseOpenedPayload,
  CaseTrigger,
  CollectionsEvent,
  CreditBalanceAppliedPayload,
  CreditNoteAppliedPayload,
  CreditNoteIssuedPayload,
  DuplicateCallbackObservedPayload,
  EventName,
  InvoiceIssuedPayload,
  InvoiceNumberAllocatedPayload,
  InvoiceSentPayload,
  InvoiceVoidedPayload,
  InvoicingEvent,
  MatchConfidence,
  MatchReversedPayload,
  PayloadOf,
  PaymentChannel,
  PaymentConfirmedPayload,
  PaymentEvent,
  PaymentFailedPayload,
  PaymentInitiatedPayload,
  PaymentMatchedPayload,
  PaymentPartiallyMatchedPayload,
  PaymentReversedPayload,
  PromiseBrokenPayload,
  ReceivableEvent,
  ReceivableOpenedPayload,
  ReceivableOverduePayload,
  ReceivablePartiallySettledPayload,
  ReceivableRecoveredPayload,
  ReceivableSettledPayload,
  ReceivableWrittenOffPayload,
  RefundCompletedPayload,
  RefundRequestedPayload,
} from './catalog';
export {
  EVENT_NAMES,
  EVENT_VERSIONS,
  isEventName,
  minorUnits,
} from './catalog';
export type { EventDefinition } from './defineEvent';
export { defineEvent } from './defineEvent';
export type { DrainResult } from './outbox';
export { Outbox } from './outbox';
