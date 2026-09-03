/**
 * Webhooks — domain event constructors for the `webhook.*` facts owned by
 * this lane (issue #47, SPEC §53 developer platform — the pure-domain half:
 * subscriptions, signing and delivery semantics the future transport mounts).
 *
 * Envelope: { name, version, aggregateId, payload, occurredAt } per
 * src/domain/events/README.md — the same stable lane shape communications,
 * paymentlinks and promises emit until the typed catalog (issue #6) absorbs
 * these names.
 *
 * Payloads are narrow and serializable: opaque ids only (no entity
 * references) and ISO-8601 strings. occurredAt comes from the injected Clock
 * — never Date.now().
 *
 * SECRET MATERIAL NEVER TRAVELS: the signing secret VALUE is returned once at
 * registration and never enters any record, payload or event — only its
 * non-reversible reference (`secretRef`) does. Pinned by a dedicated test.
 *
 * Aggregate conventions:
 *   - endpoint lifecycle (registered/paused/resumed/revoked) → the endpoint id;
 *   - subscription facts → the endpoint id;
 *   - per-delivery facts (queued/succeeded/failed/deadLettered) and signature
 *     verifications → the delivery id;
 *   - delivery-planning refusals → the endpoint id (no delivery exists yet).
 */
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';

/** Stable machine code for a broken injected clock — adapters match on this. */
export const WEBHOOK_CLOCK_INVALID = 'WEBHOOK_CLOCK_INVALID';

export type WebhookEventName =
  | 'webhook.endpointRegistered'
  | 'webhook.endpointPaused'
  | 'webhook.endpointResumed'
  | 'webhook.endpointRevoked'
  | 'webhook.subscriptionAdded'
  | 'webhook.deliveryQueued'
  | 'webhook.deliverySucceeded'
  | 'webhook.deliveryFailed'
  | 'webhook.deliveryDeadLettered'
  /**
   * K2-precedent audit fact: every planDelivery refusal is emitted as an
   * observable fact (mirrors comms.sendBlockedNoConsent). Additive beyond the
   * issue's event list — the "every refusal emits an observable fact"
   * invariant needs it. Flagged as a deviation in the PR.
   */
  | 'webhook.deliveryRefused'
  | 'webhook.signatureRejected';

/** All names in one place — the lane's observable surface. */
export const WEBHOOK_EVENT_NAMES: readonly WebhookEventName[] = [
  'webhook.endpointRegistered',
  'webhook.endpointPaused',
  'webhook.endpointResumed',
  'webhook.endpointRevoked',
  'webhook.subscriptionAdded',
  'webhook.deliveryQueued',
  'webhook.deliverySucceeded',
  'webhook.deliveryFailed',
  'webhook.deliveryDeadLettered',
  'webhook.deliveryRefused',
  'webhook.signatureRejected',
];

/** Stable envelope (issue #4); unifies with the typed catalog in issue #6. */
export interface WebhookEvent<TName extends WebhookEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the injected Clock
}

/** planDelivery refusal reasons — decision-VALUE discriminants (issue #47). */
export type WebhookRefusalReason = 'ENDPOINT_PAUSED' | 'ENDPOINT_REVOKED' | 'NOT_SUBSCRIBED' | 'PAYLOAD_TOO_LARGE';

/** verifySignature rejection kinds — the VERIFIED decision never emits. */
export type SignatureRejectReason = 'MISMATCH' | 'STALE_TIMESTAMP' | 'MALFORMED';

/** webhook.endpointRegistered — an org-scoped delivery target exists. */
export interface EndpointRegisteredPayload {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly url: string;
  readonly label: string;
  readonly description: string | null;
  /** Non-reversible reference to the signing secret — NEVER the secret value. */
  readonly secretRef: string;
}

/** webhook.endpointPaused — deliveries stop being planned for the endpoint. */
export interface EndpointPausedPayload {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly reason: string;
}

/** webhook.endpointResumed — the endpoint plans deliveries again. */
export interface EndpointResumedPayload {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
}

/** webhook.endpointRevoked — terminal; the endpoint never plans deliveries. */
export interface EndpointRevokedPayload {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly reason: string;
}

/** webhook.subscriptionAdded — an event-type pattern joined the endpoint. */
export interface SubscriptionAddedPayload {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  /** Exact event type or `<prefix>.*` wildcard (e.g. `payment.*`). */
  readonly pattern: string;
  readonly mode: 'exact' | 'wildcard';
}

/** webhook.deliveryQueued — a delivery entered the queue (idempotently). */
export interface DeliveryQueuedPayload {
  readonly deliveryId: Uuid;
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  /** The domain event being delivered (opaque — other lanes own it). */
  readonly eventId: Uuid;
  readonly eventType: string;
}

/** webhook.deliverySucceeded — an attempt delivered the payload. */
export interface DeliverySucceededPayload {
  readonly deliveryId: Uuid;
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly eventId: Uuid;
  readonly eventType: string;
  readonly attemptNo: number;
}

/** webhook.deliveryFailed — an attempt failed; `willRetry` per the ladder. */
export interface DeliveryFailedPayload {
  readonly deliveryId: Uuid;
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly eventId: Uuid;
  readonly attemptNo: number;
  readonly failureReason: string;
  readonly willRetry: boolean;
  /** ISO-8601 deterministic next attempt when willRetry is true. */
  readonly nextAttemptAt: string | null;
}

/** webhook.deliveryDeadLettered — ladder exhausted; terminal, manual review. */
export interface DeliveryDeadLetteredPayload {
  readonly deliveryId: Uuid;
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly eventId: Uuid;
  readonly attempts: number;
  readonly failureReason: string;
}

/**
 * webhook.deliveryRefused — planDelivery refusal made observable (K2 style):
 * the refusal is a VALUE and this fact is its audit trail.
 */
export interface DeliveryRefusedPayload {
  readonly orgId: Uuid;
  readonly endpointId: Uuid;
  readonly eventId: Uuid;
  readonly eventType: string;
  readonly reason: WebhookRefusalReason;
  readonly detail: string;
}

/** webhook.signatureRejected — a verification did not end in VERIFIED. */
export interface SignatureRejectedPayload {
  readonly endpointId: Uuid;
  readonly deliveryId: Uuid;
  readonly reason: SignatureRejectReason;
  /** Non-leaking detail — never echoes computed digests or the secret. */
  readonly detail: string;
  /** True when this is a replay of an already-recorded rejection (same decision). */
  readonly replay: boolean;
}

/** Clock guard — the whole lane stamps events through here. */
export const webhookNow = (clock: Clock): Date => {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError(WEBHOOK_CLOCK_INVALID, 'clock returned an invalid Date');
  }
  return now;
};

const emit = <TName extends WebhookEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): WebhookEvent<TName, TPayload> => {
  const occurredAt = webhookNow(clock).toISOString();
  return Object.freeze({ name, version: 1 as const, aggregateId, payload: { ...payload }, occurredAt });
};

/** Aggregate is the endpoint. */
export const endpointRegisteredEvent = (
  args: EndpointRegisteredPayload,
  clock: Clock,
): WebhookEvent<'webhook.endpointRegistered', EndpointRegisteredPayload> =>
  emit('webhook.endpointRegistered', args.endpointId, args, clock);

/** Aggregate is the endpoint. */
export const endpointPausedEvent = (
  args: EndpointPausedPayload,
  clock: Clock,
): WebhookEvent<'webhook.endpointPaused', EndpointPausedPayload> =>
  emit('webhook.endpointPaused', args.endpointId, args, clock);

/** Aggregate is the endpoint. */
export const endpointResumedEvent = (
  args: EndpointResumedPayload,
  clock: Clock,
): WebhookEvent<'webhook.endpointResumed', EndpointResumedPayload> =>
  emit('webhook.endpointResumed', args.endpointId, args, clock);

/** Aggregate is the endpoint. */
export const endpointRevokedEvent = (
  args: EndpointRevokedPayload,
  clock: Clock,
): WebhookEvent<'webhook.endpointRevoked', EndpointRevokedPayload> =>
  emit('webhook.endpointRevoked', args.endpointId, args, clock);

/** Aggregate is the endpoint (the subscription hangs off it). */
export const subscriptionAddedEvent = (
  args: SubscriptionAddedPayload,
  clock: Clock,
): WebhookEvent<'webhook.subscriptionAdded', SubscriptionAddedPayload> =>
  emit('webhook.subscriptionAdded', args.endpointId, args, clock);

/** Aggregate is the delivery. */
export const deliveryQueuedEvent = (
  args: DeliveryQueuedPayload,
  clock: Clock,
): WebhookEvent<'webhook.deliveryQueued', DeliveryQueuedPayload> =>
  emit('webhook.deliveryQueued', args.deliveryId, args, clock);

/** Aggregate is the delivery. */
export const deliverySucceededEvent = (
  args: DeliverySucceededPayload,
  clock: Clock,
): WebhookEvent<'webhook.deliverySucceeded', DeliverySucceededPayload> =>
  emit('webhook.deliverySucceeded', args.deliveryId, args, clock);

/** Aggregate is the delivery. */
export const deliveryFailedEvent = (
  args: DeliveryFailedPayload,
  clock: Clock,
): WebhookEvent<'webhook.deliveryFailed', DeliveryFailedPayload> =>
  emit('webhook.deliveryFailed', args.deliveryId, args, clock);

/** Aggregate is the delivery. */
export const deliveryDeadLetteredEvent = (
  args: DeliveryDeadLetteredPayload,
  clock: Clock,
): WebhookEvent<'webhook.deliveryDeadLettered', DeliveryDeadLetteredPayload> =>
  emit('webhook.deliveryDeadLettered', args.deliveryId, args, clock);

/** Aggregate is the endpoint — no delivery was ever created for the refusal. */
export const deliveryRefusedEvent = (
  args: DeliveryRefusedPayload,
  clock: Clock,
): WebhookEvent<'webhook.deliveryRefused', DeliveryRefusedPayload> =>
  emit('webhook.deliveryRefused', args.endpointId, args, clock);

/** Aggregate is the delivery (verification runs per delivery). */
export const signatureRejectedEvent = (
  args: SignatureRejectedPayload,
  clock: Clock,
): WebhookEvent<'webhook.signatureRejected', SignatureRejectedPayload> =>
  emit('webhook.signatureRejected', args.deliveryId, args, clock);
