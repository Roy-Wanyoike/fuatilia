/**
 * Conversation → Message → DeliveryAttempt — the communications aggregate
 * (SPEC §26 Unified Collections Inbox, issue #22).
 *
 *   - A Conversation is unique per (orgId, customerId, channel) and owns an
 *     append-only thread of Messages plus a consent fact trail. It never
 *     imports another lane: customerId/orgId and the consentRef are opaque
 *     Uuid values.
 *   - A Message carries direction (in|out), an opaque bodyRef (the body store
 *     is an adapter concern — the domain keeps refs, not PII payloads), an
 *     optional pinned templateRef, the customer linkage required by SPEC §26
 *     (customerId required; caseId/promiseId/invoiceId optional), sentAt and
 *     a status.
 *   - Outbound messages carry DeliveryAttempts (attemptNo, providerRef,
 *     status, failureReason) appended by provider.ts as the provider port and
 *     retry policy drive them.
 *
 * Consent facts (K2): the conversation's own append-only trail records
 * `consentGranted` / `consentRevoked` facts (opaque consentRef — the org-wide
 * DPA registry lives in the consent lane and is projected in here). The
 * automated-send boundary in guard.ts reads this trail; a revocation fact
 * appended to the conversation blocks all subsequent automated sends.
 *
 * Pure functions only: aggregates are returned as new objects (append-only
 * spirit, R3 — never mutated in place); time via the injected Clock.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { TemplateRef } from './templates';
import {
  conversationStartedEvent,
  inboundReceivedEvent,
  unmatchedInboundEvent,
  type CommsEvent,
  type ConversationStartedPayload,
  type InboundReceivedPayload,
  type UnmatchedInboundPayload,
} from './events';

// --- channel primitives (single source of truth for the lane) -----------------

export const COMMS_CHANNELS = ['whatsapp', 'sms', 'email'] as const;
export type CommsChannel = (typeof COMMS_CHANNELS)[number];

export const assertCommsChannel = (channel: string): CommsChannel => {
  if (!(COMMS_CHANNELS as readonly string[]).includes(channel)) {
    throw new DomainError('COMMS_CHANNEL_INVALID', `unknown communications channel: ${channel}`, {
      channel,
      allowed: COMMS_CHANNELS,
    });
  }
  return channel as CommsChannel;
};

// --- conversation aggregate -----------------------------------------------------

export type MessageDirection = 'in' | 'out';

/**
 * Message status. `failed` = the latest attempt failed and the retry policy
 * still has attempts left (message returns to `queued` for the retry);
 * `deadLettered` = terminal after the final failure (docs/07 — dead letters
 * need manual review, never a silent retry loop).
 */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'read' | 'deadLettered';

/** DeliveryAttempt status — per-provider lifecycle of one attempt. */
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'read';

export interface DeliveryAttempt {
  /** 1-based, monotonic per message. */
  readonly attemptNo: number;
  /** Opaque provider message ref (e.g. Meta/Safaricom id) once accepted. */
  readonly providerRef: string;
  readonly status: DeliveryStatus;
  readonly failureReason?: string;
  readonly attemptedAt: string; // ISO-8601, from the injected Clock
}

/**
 * SPEC §26 linkage: every communication connects to the customer, and —
 * optionally — the collection case, promise or invoice it is about. All ids
 * are opaque Uuids from other lanes; this lane never dereferences them.
 */
export interface MessageLinkage {
  readonly customerId: Uuid;
  readonly caseId?: Uuid;
  readonly promiseId?: Uuid;
  readonly invoiceId?: Uuid;
}

export interface Message {
  readonly id: Uuid;
  readonly conversationId: Uuid;
  readonly direction: MessageDirection;
  /** Opaque ref into the body store (adapter concern); never the raw body. */
  readonly bodyRef: string;
  /** Pinned exact template version when the body was rendered from one. */
  readonly templateRef: TemplateRef | null;
  readonly linkage: MessageLinkage;
  /** The consentRef this message was sent under (automated sends; K2). */
  readonly consentRef?: Uuid;
  readonly sentAt: Date | null;
  readonly status: MessageStatus;
  /** Outbound only — appended by the provider/retry machinery. */
  readonly attempts: readonly DeliveryAttempt[];
}

export type ConversationFact =
  | { readonly type: 'consentGranted'; readonly consentRef: Uuid; readonly at: string }
  | { readonly type: 'consentRevoked'; readonly consentRef: Uuid; readonly at: string };

export interface Conversation {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly channel: CommsChannel;
  readonly startedAt: Date;
  readonly messages: readonly Message[];
  /** Append-only consent trail read by the K2 boundary (guard.ts). */
  readonly facts: readonly ConversationFact[];
}

// --- conversation lifecycle -----------------------------------------------------

export interface StartConversationArgs {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly channel: string;
}

export interface ConversationStarted {
  readonly conversation: Conversation;
  readonly event: CommsEvent<'comms.conversationStarted', ConversationStartedPayload>;
}

/**
 * Open a conversation. Uniqueness: one open thread per
 * (orgId, customerId, channel) — duplicates throw COMMS_CONVERSATION_EXISTS
 * (the existing conversation should be reused for threading).
 */
export function startConversation(
  args: StartConversationArgs,
  existing: readonly Conversation[],
  clock: Clock,
): ConversationStarted {
  const channel = assertCommsChannel(args.channel);
  const startedAt = clock.now();
  if (Number.isNaN(startedAt.getTime())) {
    throw new DomainError('COMMS_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  const duplicate = existing.find(
    (c) => c.orgId === args.orgId && c.customerId === args.customerId && c.channel === channel,
  );
  if (duplicate) {
    throw new DomainError(
      'COMMS_CONVERSATION_EXISTS',
      `a ${channel} conversation for customer ${args.customerId} in org ${args.orgId} already exists`,
      { conversationId: duplicate.id },
    );
  }
  const conversation: Conversation = {
    id: args.id,
    orgId: args.orgId,
    customerId: args.customerId,
    channel,
    startedAt,
    messages: [],
    facts: [],
  };
  return {
    conversation,
    event: conversationStartedEvent(
      {
        conversationId: conversation.id,
        orgId: conversation.orgId,
        customerId: conversation.customerId,
        channel,
      },
      clock,
    ),
  };
}

// --- message append (threading) ---------------------------------------------------

export interface OutboundMessageInput {
  readonly id: Uuid;
  readonly bodyRef: string;
  readonly templateRef?: TemplateRef | null;
  readonly linkage: MessageLinkage;
  /** Set on automated sends (K2) by guard.ts; manual sends may omit it. */
  readonly consentRef?: Uuid;
}

export interface InboundMessageInput {
  readonly id: Uuid;
  readonly bodyRef: string;
  /** Must match the conversation's customer — a thread is single-customer. */
  readonly linkage: MessageLinkage;
}

const assertMessageInput = (conversation: Conversation, id: Uuid, bodyRef: string): void => {
  if (!bodyRef.trim()) {
    throw new DomainError('COMMS_BODY_REF_REQUIRED', 'a message requires a bodyRef');
  }
  if (conversation.messages.some((m) => m.id === id)) {
    throw new DomainError('COMMS_MESSAGE_ID_TAKEN', `message id already in conversation: ${id}`, {
      messageId: id,
      conversationId: conversation.id,
    });
  }
};

const assertLinkageCustomer = (conversation: Conversation, linkage: MessageLinkage): void => {
  if (linkage.customerId !== conversation.customerId) {
    throw new DomainError(
      'COMMS_MESSAGE_CUSTOMER_MISMATCH',
      `message linkage customer ${linkage.customerId} does not match conversation customer ${conversation.customerId}`,
      { customerId: linkage.customerId, conversationCustomerId: conversation.customerId },
    );
  }
};

/**
 * Queue a manual (agent-composed) outbound message. NOT the automated-send
 * path — the K2 consent boundary lives in guard.ts `sendAutomatedMessage`.
 * Starts `queued` with zero attempts; provider.ts drives the lifecycle.
 */
export const queueOutboundMessage = (
  conversation: Conversation,
  input: OutboundMessageInput,
): { conversation: Conversation; message: Message } => {
  assertMessageInput(conversation, input.id, input.bodyRef);
  const message: Message = {
    id: input.id,
    conversationId: conversation.id,
    direction: 'out',
    bodyRef: input.bodyRef,
    templateRef: input.templateRef ?? null,
    linkage: input.linkage,
    ...(input.consentRef !== undefined ? { consentRef: input.consentRef } : {}),
    sentAt: null,
    status: 'queued',
    attempts: [],
  };
  return { conversation: { ...conversation, messages: [...conversation.messages, message] }, message };
};

/**
 * Append an inbound (customer) message to the thread — threading per
 * SPEC §26. Inbound messages arrive `delivered` (no delivery attempts of our
 * own). Use `routeInbound` first: an inbound that matches no conversation
 * raises `comms.unmatchedInbound` instead.
 */
export const appendInboundMessage = (
  conversation: Conversation,
  input: InboundMessageInput,
  clock: Clock,
): { conversation: Conversation; message: Message; event: CommsEvent<'comms.inboundReceived', InboundReceivedPayload> } => {
  assertMessageInput(conversation, input.id, input.bodyRef);
  assertLinkageCustomer(conversation, input.linkage);
  const message: Message = {
    id: input.id,
    conversationId: conversation.id,
    direction: 'in',
    bodyRef: input.bodyRef,
    templateRef: null,
    linkage: input.linkage,
    sentAt: clock.now(),
    status: 'delivered',
    attempts: [],
  };
  return {
    conversation: { ...conversation, messages: [...conversation.messages, message] },
    message,
    event: inboundReceivedEvent(
      { conversationId: conversation.id, messageId: message.id, channel: conversation.channel },
      clock,
    ),
  };
};

/** Replace a message inside its conversation (immutable update). */
export const withMessage = (conversation: Conversation, message: Message): Conversation => {
  const index = conversation.messages.findIndex((m) => m.id === message.id);
  if (index === -1) {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_IN_CONVERSATION',
      `message ${message.id} does not belong to conversation ${conversation.id}`,
      { messageId: message.id, conversationId: conversation.id },
    );
  }
  const messages = [...conversation.messages];
  messages[index] = message;
  return { ...conversation, messages };
};

// --- consent fact trail (K2) ------------------------------------------------------

export interface ConsentFactInput {
  readonly consentRef: Uuid;
}

/** Latest fact for a consentRef, or null when the ref was never seen. */
export const latestConsentFact = (
  conversation: Conversation,
  consentRef: Uuid,
): ConversationFact | null => {
  let best: ConversationFact | null = null;
  for (const fact of conversation.facts) {
    if (fact.consentRef === consentRef && (best === null || fact.at >= best.at)) {
      best = fact;
    }
  }
  return best;
};

/**
 * Append a `consentGranted` fact (K3-style append-only trail). Granting an
 * already-active ref throws COMMS_CONSENT_ALREADY_GRANTED; re-granting after
 * revocation is allowed (a NEW fact — the trail IS the audit).
 */
export const appendConsentGranted = (
  conversation: Conversation,
  input: ConsentFactInput,
  clock: Clock,
): Conversation => {
  const current = latestConsentFact(conversation, input.consentRef);
  if (current !== null && current.type === 'consentGranted') {
    throw new DomainError(
      'COMMS_CONSENT_ALREADY_GRANTED',
      `consent ${input.consentRef} is already granted on conversation ${conversation.id}`,
      { consentRef: input.consentRef, conversationId: conversation.id },
    );
  }
  return {
    ...conversation,
    facts: [...conversation.facts, { type: 'consentGranted', consentRef: input.consentRef, at: clock.now().toISOString() }],
  };
};

/**
 * Append the revocation fact. K2: once appended, every subsequent automated
 * send on this conversation is blocked (see guard.ts). Revoking a ref that
 * was never granted throws COMMS_CONSENT_REVOCATION_UNGRANTED; revoking an
 * already-revoked ref throws COMMS_CONSENT_NOT_ACTIVE.
 */
export const appendConsentRevoked = (
  conversation: Conversation,
  input: ConsentFactInput,
  clock: Clock,
): Conversation => {
  const current = latestConsentFact(conversation, input.consentRef);
  if (current === null) {
    throw new DomainError(
      'COMMS_CONSENT_REVOCATION_UNGRANTED',
      `cannot revoke consent ${input.consentRef}: never granted on conversation ${conversation.id}`,
      { consentRef: input.consentRef, conversationId: conversation.id },
    );
  }
  if (current.type === 'consentRevoked') {
    throw new DomainError(
      'COMMS_CONSENT_NOT_ACTIVE',
      `consent ${input.consentRef} is already revoked on conversation ${conversation.id}`,
      { consentRef: input.consentRef, conversationId: conversation.id, revokedAt: current.at },
    );
  }
  return {
    ...conversation,
    facts: [...conversation.facts, { type: 'consentRevoked', consentRef: input.consentRef, at: clock.now().toISOString() }],
  };
};

// --- inbound routing ----------------------------------------------------------------

export interface InboundProbe {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly channel: string;
  readonly bodyRef: string;
}

export type InboundRoute =
  | { readonly matched: true; readonly conversation: Conversation }
  | {
      readonly matched: false;
      /** comms.unmatchedInbound — a FACT the caller must persist/emit. */
      readonly fact: CommsEvent<'comms.unmatchedInbound', UnmatchedInboundPayload>;
    };

/**
 * Route an inbound message to its thread by (orgId, customerId, channel).
 * A miss is not an error: it returns the `comms.unmatchedInbound` fact so
 * nothing is silently dropped (policy decides whether to open a new thread).
 */
export const routeInbound = (
  conversations: readonly Conversation[],
  probe: InboundProbe,
  clock: Clock,
): InboundRoute => {
  const channel = assertCommsChannel(probe.channel);
  const match = conversations.find(
    (c) => c.orgId === probe.orgId && c.customerId === probe.customerId && c.channel === channel,
  );
  if (match) {
    return { matched: true, conversation: match };
  }
  return {
    matched: false,
    fact: unmatchedInboundEvent(
      { orgId: probe.orgId, customerId: probe.customerId, channel, bodyRef: probe.bodyRef },
      clock,
    ),
  };
};
