import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { queueOutboundMessage, startConversation, appendInboundMessage, type Conversation } from './conversation';
import {
  attemptSend,
  decideRetry,
  markDelivered,
  markRead,
  simulatedProvider,
  type ProviderOutcome,
  type RetryPolicy,
} from './provider';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const CONV_ID = uid(10);
const MSG_ID = uid(20);
const INVOICE = uid(30);

const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const T0 = '2026-03-01T08:00:00.000Z';
const clock = at(T0);

const POLICY: RetryPolicy = { maxAttempts: 3, backoffStepsMs: [1000, 5000] };

const conversationWithQueuedMessage = (): Conversation => {
  const started = startConversation(
    { id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp' },
    [],
    clock,
  );
  const { conversation } = queueOutboundMessage(started.conversation, {
    id: MSG_ID,
    bodyRef: 'body-ref-1',
    linkage: { customerId: CUSTOMER, invoiceId: INVOICE },
  });
  return conversation;
};

const cmd = { body: 'Hello Asha', to: 'opaque-handle' };
const rejected = (reason = 'provider down'): ProviderOutcome => ({ status: 'rejected', failureReason: reason });
const accepted = (ref = 'meta-abc'): ProviderOutcome => ({ status: 'accepted', providerRef: ref });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- retry policy (pure ladder) -------------------------------------------------

describe('decideRetry (pure function)', () => {
  it('table: retries with successive backoff steps, then dead-letters at maxAttempts', () => {
    const table: Array<{ failedAttemptNo: number; want: ReturnType<typeof decideRetry> }> = [
      { failedAttemptNo: 1, want: { action: 'retry', delayMs: 1000, nextAttemptNo: 2 } },
      { failedAttemptNo: 2, want: { action: 'retry', delayMs: 5000, nextAttemptNo: 3 } },
      { failedAttemptNo: 3, want: { action: 'deadLetter' } },
      { failedAttemptNo: 4, want: { action: 'deadLetter' } },
    ];
    for (const c of table) {
      expect(decideRetry(POLICY, c.failedAttemptNo)).toEqual(c.want);
    }
  });

  it('single-shot policy (maxAttempts 1) dead-letters after the first failure', () => {
    expect(decideRetry({ maxAttempts: 1, backoffStepsMs: [] }, 1)).toEqual({ action: 'deadLetter' });
  });

  it('table: invalid policies and inputs throw COMMS_RETRY_POLICY_INVALID / COMMS_RETRY_DECISION_INVALID', () => {
    const table: Array<{ policy: RetryPolicy; failedAttemptNo?: number; code: string }> = [
      { policy: { maxAttempts: 0, backoffStepsMs: [] }, code: 'COMMS_RETRY_POLICY_INVALID' },
      { policy: { maxAttempts: 3, backoffStepsMs: [100] }, code: 'COMMS_RETRY_POLICY_INVALID' },
      { policy: { maxAttempts: 2, backoffStepsMs: [-5] }, code: 'COMMS_RETRY_POLICY_INVALID' },
      { policy: { maxAttempts: 2, backoffStepsMs: [1.5] }, code: 'COMMS_RETRY_POLICY_INVALID' },
      { policy: POLICY, failedAttemptNo: 0, code: 'COMMS_RETRY_DECISION_INVALID' },
    ];
    for (const c of table) {
      expectCode(() => decideRetry(c.policy, c.failedAttemptNo ?? 1), c.code);
    }
  });
});

// --- simulated provider ------------------------------------------------------------

describe('simulatedProvider (deterministic port double)', () => {
  it('consumes the script in order with deterministic refs and records dispatches', () => {
    const provider = simulatedProvider([rejected('nope'), accepted('ref-2')], 'meta-test');
    const o1 = provider.send({ messageId: MSG_ID, conversationId: CONV_ID, channel: 'whatsapp', body: 'x', to: 'y' }, 1);
    const o2 = provider.send({ messageId: MSG_ID, conversationId: CONV_ID, channel: 'whatsapp', body: 'x', to: 'y' }, 2);
    expect(o1).toEqual(rejected('nope'));
    expect(o2).toEqual(accepted('ref-2'));
    expect(provider.dispatched).toHaveLength(2);
  });

  it('over-dispatching the script throws COMMS_PROVIDER_SCRIPT_EXHAUSTED (fixture bugs surface)', () => {
    const provider = simulatedProvider([accepted()]);
    provider.send({ messageId: MSG_ID, conversationId: CONV_ID, channel: 'sms', body: 'x', to: 'y' }, 1);
    expectCode(
      () => provider.send({ messageId: MSG_ID, conversationId: CONV_ID, channel: 'sms', body: 'x', to: 'y' }, 2),
      'COMMS_PROVIDER_SCRIPT_EXHAUSTED',
    );
  });

  it('an empty script is refused up front', () => {
    expectCode(() => simulatedProvider([]), 'COMMS_PROVIDER_SCRIPT_EMPTY');
  });
});

// --- the delivery ladder ------------------------------------------------------------

describe('attemptSend ladder', () => {
  it('accepted outcome: attempt recorded, message sent with sentAt, comms.messageSent emitted', () => {
    const conv = conversationWithQueuedMessage();
    const { conversation, result } = attemptSend(conv, MSG_ID, simulatedProvider([accepted('meta-1')]), cmd, POLICY, clock);
    const msg = result.message;
    expect(msg.status).toBe('sent');
    expect(msg.sentAt?.toISOString()).toBe(T0);
    expect(msg.attempts).toEqual([
      { attemptNo: 1, providerRef: 'meta-1', status: 'sent', attemptedAt: T0 },
    ]);
    expect(result.decision).toBeNull();
    expect(result.events.map((e) => e.name)).toEqual(['comms.messageSent']);
    expect(result.events[0]!.aggregateId).toBe(MSG_ID);
    expect(result.events[0]!.payload).toMatchObject({
      conversationId: CONV_ID,
      messageId: MSG_ID,
      attemptNo: 1,
      providerRef: 'meta-1',
      direction: 'out',
      channel: 'whatsapp',
      templateId: null,
      templateVersion: null,
    });
    expect(conversation.messages[0]!.status).toBe('sent');
  });

  it('table: fail → retry ladder applies each injected backoff step against the Clock', () => {
    const t0 = '2026-03-01T08:00:00.000Z';
    const t1 = '2026-03-01T08:00:01.000Z'; // t0 + 1000ms (step 1)
    const t2 = '2026-03-01T08:00:06.000Z'; // t1 + 5000ms (step 2)
    let conv = conversationWithQueuedMessage();
    const provider = simulatedProvider([rejected('timeout'), rejected('timeout'), accepted('meta-3')]);

    const step1 = attemptSend(conv, MSG_ID, provider, cmd, POLICY, at(t0));
    const step2 = attemptSend(step1.conversation, MSG_ID, provider, cmd, POLICY, at(t1));
    const step3 = attemptSend(step2.conversation, MSG_ID, provider, cmd, POLICY, at(t2));

    const rows = [step1, step2, step3].map((step, i) => ({
      attemptNo: i + 1,
      status: step.result.message.status,
      events: step.result.events.map((e) => e.name),
      retryAt: step.result.retryAt,
    }));
    expect(rows).toEqual([
      { attemptNo: 1, status: 'queued', events: ['comms.messageFailed'], retryAt: t1 },
      { attemptNo: 2, status: 'queued', events: ['comms.messageFailed'], retryAt: t2 },
      { attemptNo: 3, status: 'sent', events: ['comms.messageSent'], retryAt: null },
    ]);
    const msg = step3.conversation.messages[0]!;
    expect(msg.status).toBe('sent');
    expect(msg.attempts.map((a) => a.attemptNo)).toEqual([1, 2, 3]);
    expect(msg.attempts[0]).toMatchObject({ status: 'failed', failureReason: 'timeout', attemptedAt: t0, providerRef: '' });
    expect(msg.attempts[2]).toMatchObject({ status: 'sent', providerRef: 'meta-3', attemptedAt: t2 });
  });

  it('exhausted retries dead-letter the message with both terminal events', () => {
    let conv = conversationWithQueuedMessage();
    const provider = simulatedProvider([rejected('down'), rejected('down'), rejected('down')]);
    const attempt = (c: Conversation) => attemptSend(c, MSG_ID, provider, cmd, POLICY, clock);

    conv = attempt(conv).conversation; // 1 → retry
    conv = attempt(conv).conversation; // 2 → retry
    const { conversation, result } = attempt(conv); // 3 → dead letter

    expect(result.message.status).toBe('deadLettered');
    expect(result.decision).toEqual({ action: 'deadLetter' });
    expect(result.retryAt).toBeNull();
    expect(result.events.map((e) => e.name)).toEqual(['comms.messageFailed', 'comms.messageDeadLettered']);
    const failed = result.events[0]!;
    expect(failed.payload).toMatchObject({ attemptNo: 3, willRetry: false, retryAt: null, failureReason: 'down' });
    const dead = result.events[1]!;
    expect(dead.aggregateId).toBe(MSG_ID);
    expect(dead.payload).toMatchObject({ attempts: 3, failureReason: 'down' });
    expect(conversation.messages[0]!.status).toBe('deadLettered');
    expect(conversation.messages[0]!.attempts).toHaveLength(3);
  });

  it('earlier messageFailed events carry willRetry: true and the clock+backoff retryAt', () => {
    const conv = conversationWithQueuedMessage();
    const { result } = attemptSend(conv, MSG_ID, simulatedProvider([rejected('down')]), cmd, POLICY, clock);
    expect(result.events[0]!.payload).toMatchObject({
      attemptNo: 1,
      willRetry: true,
      retryAt: '2026-03-01T08:00:01.000Z', // T0 + 1000ms backoff step
    });
  });

  it('table: invalid sends throw stable codes', () => {
    const conv = conversationWithQueuedMessage();
    expectCode(
      () => attemptSend(conv, uid(999), simulatedProvider([accepted()]), cmd, POLICY, clock),
      'COMMS_MESSAGE_NOT_IN_CONVERSATION',
    );
    expectCode(
      () => attemptSend(conv, MSG_ID, simulatedProvider([accepted()]), cmd, { maxAttempts: 0, backoffStepsMs: [] }, clock),
      'COMMS_RETRY_POLICY_INVALID',
    );
    const sent = attemptSend(conv, MSG_ID, simulatedProvider([accepted()]), cmd, POLICY, clock).conversation;
    expectCode(() => attemptSend(sent, MSG_ID, simulatedProvider([accepted()]), cmd, POLICY, clock), 'COMMS_MESSAGE_NOT_QUEUED');
  });

  it('a message that already used its attempts cannot be re-attempted (COMMS_ATTEMPT_LIMIT_EXCEEDED)', () => {
    let conv = conversationWithQueuedMessage();
    conv = attemptSend(conv, MSG_ID, simulatedProvider([rejected('down')]), cmd, POLICY, clock).conversation;
    // One attempt spent; a stricter policy with maxAttempts 1 refuses up front.
    expectCode(
      () => attemptSend(conv, MSG_ID, simulatedProvider([accepted()]), cmd, { maxAttempts: 1, backoffStepsMs: [] }, clock),
      'COMMS_ATTEMPT_LIMIT_EXCEEDED',
    );
  });
});

// --- receipts --------------------------------------------------------------------

describe('delivery receipts', () => {
  it('sent → delivered marks the attempt and emits comms.messageDelivered', () => {
    const conv = attemptSend(
      conversationWithQueuedMessage(),
      MSG_ID,
      simulatedProvider([accepted('meta-9')]),
      cmd,
      POLICY,
      clock,
    ).conversation;
    const { conversation, event } = markDelivered(conv, MSG_ID, clock);
    expect(event.name).toBe('comms.messageDelivered');
    expect(event.payload).toEqual({ conversationId: CONV_ID, messageId: MSG_ID, attemptNo: 1, providerRef: 'meta-9' });
    const msg = conversation.messages[0]!;
    expect(msg.status).toBe('delivered');
    expect(msg.attempts[0]!.status).toBe('delivered');
  });

  it('delivered → read emits comms.messageRead and advances message + attempt', () => {
    let conv = attemptSend(
      conversationWithQueuedMessage(),
      MSG_ID,
      simulatedProvider([accepted()]),
      cmd,
      POLICY,
      clock,
    ).conversation;
    conv = markDelivered(conv, MSG_ID, clock).conversation;
    const { conversation, event } = markRead(conv, MSG_ID, clock);
    expect(event.name).toBe('comms.messageRead');
    expect(conversation.messages[0]!.status).toBe('read');
    expect(conversation.messages[0]!.attempts[0]!.status).toBe('read');
  });

  it('inbound messages arrive delivered and can be marked read without any attempts', () => {
    const started = startConversation({ id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel: 'sms' }, [], clock);
    const { conversation } = appendInboundMessage(started.conversation, {
      id: MSG_ID,
      bodyRef: 'b',
      linkage: { customerId: CUSTOMER },
    }, clock);
    const msg = conversation.messages[0]!;
    expect(msg.attempts).toEqual([]);
    expect(msg.status).toBe('delivered');
    const { conversation: conv2 } = markRead(conversation, MSG_ID, clock);
    expect(conv2.messages[0]!.status).toBe('read');
  });

  it('table: receipts only advance in order', () => {
    const table: Array<{ from: 'queued' | 'sent' | 'delivered'; action: 'delivered' | 'read'; code: string }> = [
      { from: 'queued', action: 'delivered', code: 'COMMS_MESSAGE_NOT_SENT' },
      { from: 'queued', action: 'read', code: 'COMMS_MESSAGE_NOT_DELIVERED' },
      { from: 'sent', action: 'read', code: 'COMMS_MESSAGE_NOT_DELIVERED' },
    ];
    for (const c of table) {
      let conv = conversationWithQueuedMessage();
      if (c.from === 'sent' || c.from === 'delivered') {
        conv = attemptSend(conv, MSG_ID, simulatedProvider([accepted()]), cmd, POLICY, clock).conversation;
      }
      if (c.from === 'delivered') conv = markDelivered(conv, MSG_ID, clock).conversation;
      if (c.action === 'delivered') expectCode(() => markDelivered(conv, MSG_ID, clock), c.code);
      else expectCode(() => markRead(conv, MSG_ID, clock), c.code);
    }
  });
});
