/**
 * Payment & reconciliation domain events — the wave-1 slice owned by this
 * module (docs/04-event-catalog.md E11–E16, E18).
 *
 * Envelope contract (src/domain/events/README.md): narrow payloads, ids only,
 * camelCase names, schema version 1, occurredAt from the injected Clock.
 * The full typed catalog (eventId, correlationId, wire serialization) lands
 * with issue #6 — this module emits the stable subset it owns.
 */
import type { Clock, Money, Uuid } from '../shared';
import type { MatchConfidence } from './reconciliation';
import type { PaymentChannel } from './payment';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: Date;
}

export interface PaymentInitiatedPayload {
  readonly paymentId: Uuid;
  readonly channel: PaymentChannel;
  readonly requestedMinor: bigint;
}

export interface PaymentConfirmedPayload {
  readonly paymentId: Uuid;
  readonly confirmedMinor: bigint;
  readonly externalRef: string;
  readonly confirmedAt: Date;
}

export interface PaymentFailedPayload {
  readonly paymentId: Uuid;
  readonly failureCode: string;
}

export interface PaymentReversedPayload {
  readonly paymentId: Uuid;
  readonly reason: string;
  readonly reversalOf: Uuid;
}

export interface DuplicateCallbackObservedPayload {
  readonly paymentId: Uuid;
  readonly externalRef: string;
  readonly seenAt: Date;
}

export interface PaymentMatchedPayload {
  readonly matchId: Uuid;
  readonly paymentId: Uuid;
  readonly declaredRefs: readonly string[];
  readonly confidence: MatchConfidence;
}

export interface MatchReversedPayload {
  readonly matchId: Uuid;
  readonly reason: string;
}

export type PaymentEvent =
  | DomainEvent<'payment.initiated', PaymentInitiatedPayload>
  | DomainEvent<'payment.confirmed', PaymentConfirmedPayload>
  | DomainEvent<'payment.failed', PaymentFailedPayload>
  | DomainEvent<'payment.reversed', PaymentReversedPayload>
  | DomainEvent<'payments.duplicateCallbackObserved', DuplicateCallbackObservedPayload>
  | DomainEvent<'reconciliation.paymentMatched', PaymentMatchedPayload>
  | DomainEvent<'reconciliation.matchReversed', MatchReversedPayload>;

export const paymentInitiatedEvent = (
  args: { paymentId: Uuid; channel: PaymentChannel; requestedMinor: Money },
  clock: Clock,
): PaymentEvent => ({
  name: 'payment.initiated',
  version: 1,
  aggregateId: args.paymentId,
  payload: {
    paymentId: args.paymentId,
    channel: args.channel,
    requestedMinor: args.requestedMinor.amount,
  },
  occurredAt: clock.now(),
});

export const paymentConfirmedEvent = (
  args: { paymentId: Uuid; confirmedMinor: Money; externalRef: string; confirmedAt: Date },
  clock: Clock,
): PaymentEvent => ({
  name: 'payment.confirmed',
  version: 1,
  aggregateId: args.paymentId,
  payload: {
    paymentId: args.paymentId,
    confirmedMinor: args.confirmedMinor.amount,
    externalRef: args.externalRef,
    confirmedAt: args.confirmedAt,
  },
  occurredAt: clock.now(),
});

export const paymentFailedEvent = (
  args: { paymentId: Uuid; failureCode: string },
  clock: Clock,
): PaymentEvent => ({
  name: 'payment.failed',
  version: 1,
  aggregateId: args.paymentId,
  payload: { paymentId: args.paymentId, failureCode: args.failureCode },
  occurredAt: clock.now(),
});

export const paymentReversedEvent = (
  args: { paymentId: Uuid; reason: string; reversalOf: Uuid },
  clock: Clock,
): PaymentEvent => ({
  name: 'payment.reversed',
  version: 1,
  aggregateId: args.paymentId,
  payload: { paymentId: args.paymentId, reason: args.reason, reversalOf: args.reversalOf },
  occurredAt: clock.now(),
});

export const duplicateCallbackObservedEvent = (
  args: { paymentId: Uuid; externalRef: string; seenAt: Date },
  clock: Clock,
): PaymentEvent => ({
  name: 'payments.duplicateCallbackObserved',
  version: 1,
  aggregateId: args.paymentId,
  payload: { paymentId: args.paymentId, externalRef: args.externalRef, seenAt: args.seenAt },
  occurredAt: clock.now(),
});

export const paymentMatchedEvent = (
  args: {
    matchId: Uuid;
    paymentId: Uuid;
    declaredRefs: readonly string[];
    confidence: MatchConfidence;
  },
  clock: Clock,
): PaymentEvent => ({
  name: 'reconciliation.paymentMatched',
  version: 1,
  aggregateId: args.matchId,
  payload: {
    matchId: args.matchId,
    paymentId: args.paymentId,
    declaredRefs: [...args.declaredRefs],
    confidence: args.confidence,
  },
  occurredAt: clock.now(),
});

export const matchReversedEvent = (
  args: { matchId: Uuid; reason: string },
  clock: Clock,
): PaymentEvent => ({
  name: 'reconciliation.matchReversed',
  version: 1,
  aggregateId: args.matchId,
  payload: { matchId: args.matchId, reason: args.reason },
  occurredAt: clock.now(),
});
