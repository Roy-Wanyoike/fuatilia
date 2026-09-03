/**
 * Payment-link lane events (issue #21, SPEC §28).
 *
 * Envelope contract (src/domain/events/README.md): narrow payloads, ids only,
 * camelCase names, schema version 1, occurredAt from the injected Clock.
 * Naming follows the repo convention `<context>.<aggregate><PastTenseVerb>`.
 *
 * Privacy: the token is a SECRET and is never mirrored into event payloads —
 * payloads carry opaque ids and amounts only.
 */
import type { Clock, Currency, Uuid } from '../shared';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: Date;
}

export interface PaymentLinkCreatedPayload {
  readonly linkId: Uuid;
  readonly orgId: Uuid;
  readonly receivableIds: readonly Uuid[]; // opaque — receivables are another lane
  readonly mode: 'fixed' | 'open';
  readonly targetAmountMinor?: bigint; // fixed mode
  readonly minAmountMinor?: bigint; // open mode bounds
  readonly maxAmountMinor?: bigint;
  readonly currency: Currency;
  readonly singleUse: boolean;
  readonly allowPartial: boolean;
  readonly expiresAt?: Date;
}

export interface PaymentLinkRedeemedPayload {
  readonly linkId: Uuid;
  readonly intentId: Uuid; // payment intent for the payments lane (opaque hand-off)
  readonly amountMinor: bigint;
  readonly currency: Currency;
  readonly redeemedAt: Date;
}

export interface PaymentLinkCompletedPayload {
  readonly linkId: Uuid;
  readonly collectedMinor: bigint; // Σ accepted redemptions at completion
  readonly completedAt: Date;
}

export interface PaymentLinkExpiredPayload {
  readonly linkId: Uuid;
  readonly expiredAt: Date;
}

export interface PaymentLinkDisabledPayload {
  readonly linkId: Uuid;
  readonly reason: string;
  readonly disabledAt: Date;
}

export interface PaymentLinkCancelledPayload {
  readonly linkId: Uuid;
  readonly reason: string;
  readonly cancelledAt: Date;
}

/** R9-style tripwire: a retry arrived with a used idempotency key; original intent stands. */
export interface PaymentLinkDuplicateRedemptionObservedPayload {
  readonly linkId: Uuid;
  readonly idempotencyKey: string;
  readonly intentId: Uuid;
  readonly seenAt: Date;
}

export type PaymentLinkEvent =
  | DomainEvent<'paymentlink.created', PaymentLinkCreatedPayload>
  | DomainEvent<'paymentlink.redeemed', PaymentLinkRedeemedPayload>
  | DomainEvent<'paymentlink.completed', PaymentLinkCompletedPayload>
  | DomainEvent<'paymentlink.expired', PaymentLinkExpiredPayload>
  | DomainEvent<'paymentlink.disabled', PaymentLinkDisabledPayload>
  | DomainEvent<'paymentlink.cancelled', PaymentLinkCancelledPayload>
  | DomainEvent<'paymentlink.duplicateRedemptionObserved', PaymentLinkDuplicateRedemptionObservedPayload>;

export const paymentLinkCreatedEvent = (
  args: {
    linkId: Uuid;
    orgId: Uuid;
    receivableIds: readonly Uuid[];
    mode: 'fixed' | 'open';
    targetAmountMinor?: bigint;
    minAmountMinor?: bigint;
    maxAmountMinor?: bigint;
    currency: Currency;
    singleUse: boolean;
    allowPartial: boolean;
    expiresAt?: Date;
  },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.created',
  version: 1,
  aggregateId: args.linkId,
  payload: {
    linkId: args.linkId,
    orgId: args.orgId,
    receivableIds: [...args.receivableIds],
    mode: args.mode,
    ...(args.targetAmountMinor !== undefined ? { targetAmountMinor: args.targetAmountMinor } : {}),
    ...(args.minAmountMinor !== undefined ? { minAmountMinor: args.minAmountMinor } : {}),
    ...(args.maxAmountMinor !== undefined ? { maxAmountMinor: args.maxAmountMinor } : {}),
    currency: args.currency,
    singleUse: args.singleUse,
    allowPartial: args.allowPartial,
    ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
  },
  occurredAt: clock.now(),
});

export const paymentLinkRedeemedEvent = (
  args: { linkId: Uuid; intentId: Uuid; amountMinor: bigint; currency: Currency; redeemedAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.redeemed',
  version: 1,
  aggregateId: args.linkId,
  payload: {
    linkId: args.linkId,
    intentId: args.intentId,
    amountMinor: args.amountMinor,
    currency: args.currency,
    redeemedAt: args.redeemedAt,
  },
  occurredAt: clock.now(),
});

export const paymentLinkCompletedEvent = (
  args: { linkId: Uuid; collectedMinor: bigint; completedAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.completed',
  version: 1,
  aggregateId: args.linkId,
  payload: { linkId: args.linkId, collectedMinor: args.collectedMinor, completedAt: args.completedAt },
  occurredAt: clock.now(),
});

export const paymentLinkExpiredEvent = (
  args: { linkId: Uuid; expiredAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.expired',
  version: 1,
  aggregateId: args.linkId,
  payload: { linkId: args.linkId, expiredAt: args.expiredAt },
  occurredAt: clock.now(),
});

export const paymentLinkDisabledEvent = (
  args: { linkId: Uuid; reason: string; disabledAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.disabled',
  version: 1,
  aggregateId: args.linkId,
  payload: { linkId: args.linkId, reason: args.reason, disabledAt: args.disabledAt },
  occurredAt: clock.now(),
});

export const paymentLinkCancelledEvent = (
  args: { linkId: Uuid; reason: string; cancelledAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.cancelled',
  version: 1,
  aggregateId: args.linkId,
  payload: { linkId: args.linkId, reason: args.reason, cancelledAt: args.cancelledAt },
  occurredAt: clock.now(),
});

export const paymentLinkDuplicateRedemptionObservedEvent = (
  args: { linkId: Uuid; idempotencyKey: string; intentId: Uuid; seenAt: Date },
  clock: Clock,
): PaymentLinkEvent => ({
  name: 'paymentlink.duplicateRedemptionObserved',
  version: 1,
  aggregateId: args.linkId,
  payload: {
    linkId: args.linkId,
    idempotencyKey: args.idempotencyKey,
    intentId: args.intentId,
    seenAt: args.seenAt,
  },
  occurredAt: clock.now(),
});
