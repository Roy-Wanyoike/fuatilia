/**
 * Provider ports + delivery machinery (SPEC §26, issue #22) — PURE.
 *
 * `MessagingProvider` is the port: given an outbound command it returns an
 * outcome VALUE (accepted with a providerRef, or rejected with a reason).
 * The domain never performs I/O — real adapters (Meta Cloud API, Safaricom
 * SMS, SMTP) implement the port at the edge; `simulatedProvider` is the
 * deterministic test double with an injectable outcome script.
 *
 * The retry ladder is a pure function (`decideRetry`): a failed attempt
 * retries up to `maxAttempts` with injected backoff steps, then the message
 * is dead-lettered (status `deadLettered` + comms.messageDeadLettered) —
 * terminal, manual review, never a silent retry loop. All timestamps come
 * from the injected Clock.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { CommsChannel } from './conversation';
import { withMessage, type Conversation, type Message } from './conversation';
import {
  messageDeadLetteredEvent,
  messageDeliveredEvent,
  messageFailedEvent,
  messageReadEvent,
  messageSentEvent,
  type CommsEvent,
  type MessageDeadLetteredPayload,
  type MessageDeliveredPayload,
  type MessageFailedPayload,
  type MessageReadPayload,
  type MessageSentPayload,
} from './events';

// --- provider port ------------------------------------------------------------

export interface OutboundCommand {
  readonly messageId: Uuid;
  readonly conversationId: Uuid;
  readonly channel: CommsChannel;
  /** Rendered body handed to the provider (adapter stores/forwards it). */
  readonly body: string;
  /** Opaque destination handle (msisdn/email address handle). */
  readonly to: string;
}

export type ProviderOutcome =
  | { readonly status: 'accepted'; readonly providerRef: string }
  | { readonly status: 'rejected'; readonly failureReason: string };

/**
 * The port. Synchronous-pure in the domain core: adapters wrap their async
 * I/O and surface the outcome through this same value shape.
 */
export interface MessagingProvider {
  readonly name: string;
  send(cmd: OutboundCommand, attemptNo: number): ProviderOutcome;
}

export interface SimulatedProvider extends MessagingProvider {
  /** Every dispatched command, in order — lets tests assert the wire. */
  readonly dispatched: readonly OutboundCommand[];
}

/**
 * Deterministic simulator: outcomes are consumed from the injected script in
 * order (over-dispatching throws COMMS_PROVIDER_SCRIPT_EXHAUSTED so fixture
 * bugs surface). providerRef is deterministic (`<name>-<n>`), never random.
 */
export const simulatedProvider = (
  script: readonly ProviderOutcome[],
  name = 'simulated',
): SimulatedProvider => {
  if (script.length === 0) {
    throw new DomainError('COMMS_PROVIDER_SCRIPT_EMPTY', 'simulated provider needs at least one outcome');
  }
  const dispatched: OutboundCommand[] = [];
  let dispatchCount = 0;
  return {
    name,
    get dispatched() {
      return dispatched;
    },
    send(cmd: OutboundCommand, _attemptNo: number): ProviderOutcome {
      const outcome = script[dispatchCount];
      if (outcome === undefined) {
        throw new DomainError(
          'COMMS_PROVIDER_SCRIPT_EXHAUSTED',
          `simulated provider script has ${script.length} outcome(s) but dispatch #${dispatchCount + 1} was requested`,
          { scriptLength: script.length, dispatchNo: dispatchCount + 1 },
        );
      }
      dispatchCount += 1;
      dispatched.push(cmd);
      return outcome;
    },
  };
};

// --- retry policy (pure function) -----------------------------------------------

export interface RetryPolicy {
  /** Total attempts allowed (>= 1) — includes the first send. */
  readonly maxAttempts: number;
  /**
   * Backoff before retry n (ms), indexed by the failed attempt number minus
   * one. Must supply at least maxAttempts − 1 steps.
   */
  readonly backoffStepsMs: readonly number[];
}

export type RetryDecision =
  | { readonly action: 'retry'; readonly delayMs: number; readonly nextAttemptNo: number }
  | { readonly action: 'deadLetter' };

const assertPolicy = (policy: RetryPolicy): void => {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new DomainError(
      'COMMS_RETRY_POLICY_INVALID',
      `maxAttempts must be a positive integer, got ${policy.maxAttempts}`,
      { maxAttempts: policy.maxAttempts },
    );
  }
  if (policy.backoffStepsMs.length < policy.maxAttempts - 1) {
    throw new DomainError(
      'COMMS_RETRY_POLICY_INVALID',
      `retry policy needs at least ${policy.maxAttempts - 1} backoff step(s) for maxAttempts ${policy.maxAttempts}`,
      { steps: policy.backoffStepsMs.length, maxAttempts: policy.maxAttempts },
    );
  }
  if (policy.backoffStepsMs.some((ms) => !Number.isInteger(ms) || ms < 0)) {
    throw new DomainError(
      'COMMS_RETRY_POLICY_INVALID',
      'backoff steps must be non-negative integers (ms)',
      { steps: policy.backoffStepsMs },
    );
  }
};

/**
 * The pure retry decision: after `failedAttemptNo` failures, either retry
 * with the next backoff step or dead-letter. Deterministic — no clock here;
 * the caller applies the delay against the injected Clock.
 */
export const decideRetry = (policy: RetryPolicy, failedAttemptNo: number): RetryDecision => {
  assertPolicy(policy);
  if (failedAttemptNo < 1) {
    throw new DomainError(
      'COMMS_RETRY_DECISION_INVALID',
      `failedAttemptNo must be >= 1, got ${failedAttemptNo}`,
      { failedAttemptNo },
    );
  }
  if (failedAttemptNo < policy.maxAttempts) {
    const index = Math.min(failedAttemptNo - 1, policy.backoffStepsMs.length - 1);
    const delayMs = policy.backoffStepsMs[index];
    return { action: 'retry', delayMs: delayMs ?? 0, nextAttemptNo: failedAttemptNo + 1 };
  }
  return { action: 'deadLetter' };
};

// --- delivery lifecycle -----------------------------------------------------------

/** Events the delivery machinery can emit. */
export type DeliveryEvent =
  | CommsEvent<'comms.messageSent', MessageSentPayload>
  | CommsEvent<'comms.messageDelivered', MessageDeliveredPayload>
  | CommsEvent<'comms.messageRead', MessageReadPayload>
  | CommsEvent<'comms.messageFailed', MessageFailedPayload>
  | CommsEvent<'comms.messageDeadLettered', MessageDeadLetteredPayload>;

export interface AttemptSendResult {
  /** Message with the attempt appended and status advanced (new object). */
  readonly message: Message;
  readonly outcome: ProviderOutcome;
  /** Null when the provider accepted the send. */
  readonly decision: RetryDecision | null;
  readonly events: readonly DeliveryEvent[];
  /** ISO-8601 next attempt time when the policy schedules a retry. */
  readonly retryAt: string | null;
}

const assertSendable = (message: Message, policy: RetryPolicy): void => {
  if (message.direction !== 'out') {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_OUTBOUND',
      `message ${message.id} is inbound — only outbound messages are sent through the provider`,
      { messageId: message.id },
    );
  }
  if (message.status !== 'queued') {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_QUEUED',
      `message ${message.id} is '${message.status}' — only queued messages can be attempted`,
      { messageId: message.id, status: message.status },
    );
  }
  if (message.attempts.length >= policy.maxAttempts) {
    throw new DomainError(
      'COMMS_ATTEMPT_LIMIT_EXCEEDED',
      `message ${message.id} already used all ${policy.maxAttempts} attempt(s)`,
      { messageId: message.id, attempts: message.attempts.length },
    );
  }
};

/**
 * One provider attempt against a queued message. Appends the DeliveryAttempt
 * (attemptNo = attempts.length + 1) and advances status:
 *   accepted  → attempt `sent`, message `sent`, comms.messageSent;
 *   rejected  → attempt `failed`, then the pure retry policy decides:
 *     retry      → message `queued` for the next attempt (comms.messageFailed,
 *                  willRetry: true, retryAt = clock + backoff step);
 *     deadLetter → message `deadLettered`, terminal (comms.messageFailed +
 *                  comms.messageDeadLettered).
 * Calling provider.send is safe: the port is injected and pure.
 */
export const attemptSend = (
  conversation: Conversation,
  messageId: Uuid,
  provider: MessagingProvider,
  cmd: Omit<OutboundCommand, 'messageId' | 'conversationId' | 'channel'>,
  policy: RetryPolicy,
  clock: Clock,
): { conversation: Conversation; result: AttemptSendResult } => {
  const message = conversation.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_IN_CONVERSATION',
      `message ${messageId} does not belong to conversation ${conversation.id}`,
      { messageId, conversationId: conversation.id },
    );
  }
  assertPolicy(policy); // fail fast on bad config, regardless of the outcome
  assertSendable(message, policy);

  const attemptNo = message.attempts.length + 1;
  const attemptedAt = clock.now();
  if (Number.isNaN(attemptedAt.getTime())) {
    throw new DomainError('COMMS_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  const outcome = provider.send(
    { ...cmd, messageId: message.id, conversationId: conversation.id, channel: conversation.channel },
    attemptNo,
  );

  if (outcome.status === 'accepted') {
    const attempt = {
      attemptNo,
      providerRef: outcome.providerRef,
      status: 'sent' as const,
      attemptedAt: attemptedAt.toISOString(),
    };
    const sent: Message = {
      ...message,
      status: 'sent',
      sentAt: attemptedAt,
      attempts: [...message.attempts, attempt],
    };
    return {
      conversation: withMessage(conversation, sent),
      result: {
        message: sent,
        outcome,
        decision: null,
        retryAt: null,
        events: [
          messageSentEvent(
            {
              conversationId: conversation.id,
              messageId: message.id,
              direction: 'out',
              channel: conversation.channel,
              attemptNo,
              providerRef: outcome.providerRef,
              templateId: message.templateRef?.templateId ?? null,
              templateVersion: message.templateRef?.version ?? null,
            },
            clock,
          ),
        ],
      },
    };
  }

  // Rejected — record the failed attempt, then consult the pure policy.
  const failedAttempt = {
    attemptNo,
    providerRef: '',
    status: 'failed' as const,
    failureReason: outcome.failureReason,
    attemptedAt: attemptedAt.toISOString(),
  };
  const decision = decideRetry(policy, attemptNo);
  if (decision.action === 'retry') {
    const retried: Message = {
      ...message,
      status: 'queued', // stays eligible for the next attempt
      attempts: [...message.attempts, failedAttempt],
    };
    const retryAt = new Date(attemptedAt.getTime() + decision.delayMs);
    return {
      conversation: withMessage(conversation, retried),
      result: {
        message: retried,
        outcome,
        decision,
        retryAt: retryAt.toISOString(),
        events: [
          messageFailedEvent(
            {
              conversationId: conversation.id,
              messageId: message.id,
              attemptNo,
              failureReason: outcome.failureReason,
              willRetry: true,
              retryAt: retryAt.toISOString(),
            },
            clock,
          ),
        ],
      },
    };
  }

  const deadLettered: Message = {
    ...message,
    status: 'deadLettered', // terminal — manual review
    attempts: [...message.attempts, failedAttempt],
  };
  return {
    conversation: withMessage(conversation, deadLettered),
    result: {
      message: deadLettered,
      outcome,
      decision,
      retryAt: null,
      events: [
        messageFailedEvent(
          {
            conversationId: conversation.id,
            messageId: message.id,
            attemptNo,
            failureReason: outcome.failureReason,
            willRetry: false,
            retryAt: null,
          },
          clock,
        ),
        messageDeadLetteredEvent(
          {
            conversationId: conversation.id,
            messageId: message.id,
            attempts: attemptNo,
            failureReason: outcome.failureReason,
          },
          clock,
        ),
      ],
    },
  };
};

/** Provider webhook: last attempt `sent` → `delivered` (message + attempt). */
export const markDelivered = (
  conversation: Conversation,
  messageId: Uuid,
  clock: Clock,
): { conversation: Conversation; event: CommsEvent<'comms.messageDelivered', MessageDeliveredPayload> } => {
  const message = conversation.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_IN_CONVERSATION',
      `message ${messageId} does not belong to conversation ${conversation.id}`,
      { messageId, conversationId: conversation.id },
    );
  }
  if (message.status !== 'sent') {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_SENT',
      `message ${message.id} is '${message.status}' — only sent messages can be marked delivered`,
      { messageId: message.id, status: message.status },
    );
  }
  const last = message.attempts[message.attempts.length - 1];
  const updated: Message = {
    ...message,
    status: 'delivered',
    attempts: message.attempts.map((a) =>
      last !== undefined && a.attemptNo === last.attemptNo ? { ...a, status: 'delivered' as const } : a,
    ),
  };
  return {
    conversation: withMessage(conversation, updated),
    event: messageDeliveredEvent(
      {
        conversationId: conversation.id,
        messageId: message.id,
        attemptNo: last?.attemptNo ?? 0,
        providerRef: last?.providerRef ?? '',
      },
      clock,
    ),
  };
};

/** Receipt advance: `delivered` → `read` (works for inbound threads too). */
export const markRead = (
  conversation: Conversation,
  messageId: Uuid,
  clock: Clock,
): { conversation: Conversation; event: CommsEvent<'comms.messageRead', MessageReadPayload> } => {
  const message = conversation.messages.find((m) => m.id === messageId);
  if (!message) {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_IN_CONVERSATION',
      `message ${messageId} does not belong to conversation ${conversation.id}`,
      { messageId, conversationId: conversation.id },
    );
  }
  if (message.status !== 'delivered') {
    throw new DomainError(
      'COMMS_MESSAGE_NOT_DELIVERED',
      `message ${message.id} is '${message.status}' — only delivered messages can be marked read`,
      { messageId: message.id, status: message.status },
    );
  }
  const last = message.attempts[message.attempts.length - 1];
  const updated: Message = {
    ...message,
    status: 'read',
    attempts: message.attempts.map((a) =>
      last !== undefined && a.attemptNo === last.attemptNo ? { ...a, status: 'read' as const } : a,
    ),
  };
  return {
    conversation: withMessage(conversation, updated),
    event: messageReadEvent({ conversationId: conversation.id, messageId: message.id }, clock),
  };
};
