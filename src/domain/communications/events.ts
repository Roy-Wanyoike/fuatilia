/**
 * Communications — domain event constructors for the `comms.*` facts owned by
 * this lane (SPEC §26 Unified Collections Inbox, issue #22).
 *
 * Envelope: { name, version, aggregateId, payload, occurredAt } per
 * src/domain/events/README.md — the same stable shape the adjustments lane
 * uses until the typed catalog (issue #6) absorbs these names.
 *
 * Payloads are narrow and serializable: opaque ids only (no entity
 * references) and ISO-8601 strings. occurredAt comes from the injected Clock
 * — never Date.now(). Aggregate conventions:
 *   - conversation lifecycle / consent screening → the conversation id;
 *   - per-message delivery facts (sent/delivered/read/failed/deadLettered) →
 *     the message id;
 *   - unmatchedInbound has no aggregate (no conversation exists yet) → the
 *     org id.
 */
import type { Clock, Uuid } from '../shared';

export type CommsEventName =
  | 'comms.conversationStarted'
  | 'comms.messageSent'
  | 'comms.messageDelivered'
  | 'comms.messageRead'
  | 'comms.messageFailed'
  | 'comms.messageDeadLettered'
  | 'comms.sendBlockedNoConsent'
  | 'comms.inboundReceived'
  | 'comms.unmatchedInbound';

/** Stable envelope (issue #4); unifies with the typed catalog in issue #6. */
export interface CommsEvent<TName extends CommsEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the injected Clock
}

/** comms.conversationStarted — a thread opened for (org, customer, channel). */
export interface ConversationStartedPayload {
  readonly conversationId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly channel: string;
}

/** comms.messageSent — an outbound message left the building. */
export interface MessageSentPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly direction: 'out';
  readonly channel: string;
  readonly attemptNo: number;
  readonly providerRef: string;
  /** Exact pinned template version when the body was rendered from one. */
  readonly templateId: Uuid | null;
  readonly templateVersion: number | null;
}

/** comms.messageDelivered — provider confirmed delivery. */
export interface MessageDeliveredPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly attemptNo: number;
  readonly providerRef: string;
}

/** comms.messageRead — delivery receipt advanced to read. */
export interface MessageReadPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
}

/** comms.messageFailed — an attempt failed; `willRetry` per the retry policy. */
export interface MessageFailedPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly attemptNo: number;
  readonly failureReason: string;
  readonly willRetry: boolean;
  /** ISO-8601 next attempt time when willRetry is true (clock + backoff). */
  readonly retryAt: string | null;
}

/** comms.messageDeadLettered — final failure; manual review required. */
export interface MessageDeadLetteredPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly attempts: number;
  readonly failureReason: string;
}

/**
 * comms.sendBlockedNoConsent — K2 boundary refusal. Emitted (not thrown) so
 * the audit trail records every blocked automated send attempt.
 */
export interface SendBlockedNoConsentPayload {
  readonly conversationId: Uuid;
  readonly channel: string;
  readonly consentRef: string | null;
  readonly reason: 'NO_CONSENT_REF' | 'CONSENT_REVOKED' | 'CONSENT_NOT_GRANTED';
  readonly detail: string;
}

/** comms.inboundReceived — a customer reply appended to an existing thread. */
export interface InboundReceivedPayload {
  readonly conversationId: Uuid;
  readonly messageId: Uuid;
  readonly channel: string;
}

/**
 * comms.unmatchedInbound — an inbound message matched no conversation
 * (org+customer+channel). Raised as a FACT so the message is never silently
 * dropped; a new thread may be opened from it by policy.
 */
export interface UnmatchedInboundPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly channel: string;
  readonly bodyRef: string;
}

const emit = <TName extends CommsEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): CommsEvent<TName, TPayload> => ({
  name,
  version: 1,
  aggregateId,
  payload,
  occurredAt: clock.now().toISOString(),
});

/** Aggregate is the conversation. */
export const conversationStartedEvent = (
  args: ConversationStartedPayload,
  clock: Clock,
): CommsEvent<'comms.conversationStarted', ConversationStartedPayload> =>
  emit('comms.conversationStarted', args.conversationId, { ...args }, clock);

/** Aggregate is the message. */
export const messageSentEvent = (
  args: MessageSentPayload,
  clock: Clock,
): CommsEvent<'comms.messageSent', MessageSentPayload> =>
  emit('comms.messageSent', args.messageId, { ...args }, clock);

/** Aggregate is the message. */
export const messageDeliveredEvent = (
  args: MessageDeliveredPayload,
  clock: Clock,
): CommsEvent<'comms.messageDelivered', MessageDeliveredPayload> =>
  emit('comms.messageDelivered', args.messageId, { ...args }, clock);

/** Aggregate is the message. */
export const messageReadEvent = (
  args: MessageReadPayload,
  clock: Clock,
): CommsEvent<'comms.messageRead', MessageReadPayload> =>
  emit('comms.messageRead', args.messageId, { ...args }, clock);

/** Aggregate is the message. */
export const messageFailedEvent = (
  args: MessageFailedPayload,
  clock: Clock,
): CommsEvent<'comms.messageFailed', MessageFailedPayload> =>
  emit('comms.messageFailed', args.messageId, { ...args }, clock);

/** Aggregate is the message. */
export const messageDeadLetteredEvent = (
  args: MessageDeadLetteredPayload,
  clock: Clock,
): CommsEvent<'comms.messageDeadLettered', MessageDeadLetteredPayload> =>
  emit('comms.messageDeadLettered', args.messageId, { ...args }, clock);

/** Aggregate is the conversation (the screened send boundary). */
export const sendBlockedNoConsentEvent = (
  args: SendBlockedNoConsentPayload,
  clock: Clock,
): CommsEvent<'comms.sendBlockedNoConsent', SendBlockedNoConsentPayload> =>
  emit('comms.sendBlockedNoConsent', args.conversationId, { ...args }, clock);

/** Aggregate is the message (thread append). */
export const inboundReceivedEvent = (
  args: InboundReceivedPayload,
  clock: Clock,
): CommsEvent<'comms.inboundReceived', InboundReceivedPayload> =>
  emit('comms.inboundReceived', args.messageId, { ...args }, clock);

/** Aggregate is the org — no conversation exists to aggregate on. */
export const unmatchedInboundEvent = (
  args: UnmatchedInboundPayload,
  clock: Clock,
): CommsEvent<'comms.unmatchedInbound', UnmatchedInboundPayload> =>
  emit('comms.unmatchedInbound', args.orgId, { ...args }, clock);
