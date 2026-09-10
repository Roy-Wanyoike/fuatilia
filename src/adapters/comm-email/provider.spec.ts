/**
 * Seam wiring tests (issue #127): the wire→outcome mapping, the
 * preResolvedProvider satisfying the PURE port through a FULL attemptSend
 * ladder (table-driven: success / transient retry / permanent refusal), the
 * fail-closed consent boundary, and DSN (bounce) parsing.
 */
import { describe, expect, it } from 'vitest';
import {
  attemptSend,
  markDelivered,
  type OutboundCommand,
  type ProviderOutcome,
  type RetryPolicy,
} from '../../domain/communications/provider';
import type { Clock, Uuid } from '../../domain/shared';
import { queueOutboundMessage, startConversation, type Conversation } from '../../domain/communications/conversation';
import {
  dispatchToOutcome,
  parseDeliveryStatusNotification,
  policyForWireResult,
  preResolvedProvider,
  withConsentRequirement,
} from './provider';
import type { EmailTransport, EmailWireRequest, EmailWireResult } from './transports';

const asUuid = (value: string): Uuid => value as unknown as Uuid;
const fakeClock = (): Clock => ({ now: () => new Date('2026-09-08T09:00:00Z') });

const POLICY: RetryPolicy = { maxAttempts: 3, backoffStepsMs: [1000, 5000] };

const acceptedOutcome: ProviderOutcome = { status: 'accepted', providerRef: '<m-1.1.1@relay.example>' };
const transientRefusal: EmailWireResult = { ok: false, failureReason: 'EMAIL_SMTP_451: try again later', retryable: true };
const unknownMailbox: EmailWireResult = { ok: false, failureReason: 'EMAIL_SMTP_550: User unknown', retryable: false };

const REQ: EmailWireRequest = {
  to: 'jane.doe@example.com',
  subject: 'Payment reminder',
  text: 'Invoice INV-1042 is due.',
  clientRef: 'm-1#1',
};

const scriptedTransport = (results: readonly EmailWireResult[]): EmailTransport => {
  let n = 0;
  return {
    name: 'smtp',
    async dispatch() {
      const result = results[Math.min(n, results.length - 1)] as EmailWireResult;
      n += 1;
      return result;
    },
  };
};

describe('dispatchToOutcome', () => {
  it('maps ok results to accepted outcomes', async () => {
    await expect(
      dispatchToOutcome(scriptedTransport([{ ok: true, providerRef: '<m-1.1.1@relay.example>' }]), REQ),
    ).resolves.toEqual({ status: 'accepted', providerRef: '<m-1.1.1@relay.example>' });
  });

  it('carries retryability as a machine-readable suffix on the refusal', async () => {
    const outcome = await dispatchToOutcome(scriptedTransport([transientRefusal]), REQ);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.failureReason).toBe('EMAIL_SMTP_451: try again later [retryable]');
    }
  });

  it('carries permanence as a machine-readable suffix on the refusal', async () => {
    const outcome = await dispatchToOutcome(scriptedTransport([unknownMailbox]), REQ);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.failureReason).toBe('EMAIL_SMTP_550: User unknown [permanent]');
    }
  });
});

describe('preResolvedProvider through the pure attemptSend ladder', () => {
  const baseCmd = { body: 'Payment reminder', to: 'jane.doe@example.com' };

  const queuedConversation = (): Conversation => {
    const started = startConversation(
      { id: asUuid('c-1'), orgId: asUuid('org-1'), customerId: asUuid('cust-1'), channel: 'email' },
      [],
      fakeClock(),
    );
    const { conversation } = queueOutboundMessage(started.conversation, {
      id: asUuid('m-1'),
      bodyRef: 'body-reminder-1',
      linkage: { customerId: asUuid('cust-1'), invoiceId: asUuid('inv-1') },
    });
    return conversation;
  };

  it('accepted outcome: message sent with the REAL wire providerRef', () => {
    const provider = preResolvedProvider('smtp', acceptedOutcome);
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.status).toBe('sent');
    expect(result.message.attempts[0]?.providerRef).toBe('<m-1.1.1@relay.example>');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe('comms.messageSent');
  });

  it('rejected outcome: the pure policy retries then dead-letters — no silent loops', () => {
    const provider = preResolvedProvider('smtp', {
      status: 'rejected',
      failureReason: 'EMAIL_SMTP_451: try again later [retryable]',
    });
    let conversation = queuedConversation();
    const retryAts: (string | null)[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { conversation: next, result } = attemptSend(conversation, asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
      conversation = next;
      retryAts.push(result.retryAt);
      expect(result.outcome.status).toBe('rejected');
    }
    expect(conversation.messages[0]?.status).toBe('deadLettered');
    expect(conversation.messages[0]?.attempts).toHaveLength(3);
    expect(retryAts[0]).not.toBeNull();
    expect(retryAts[1]).not.toBeNull();
    expect(retryAts[2]).toBeNull(); // terminal
  });

  it('the providerRef never invents values on rejection', () => {
    const provider = preResolvedProvider('smtp', {
      status: 'rejected',
      failureReason: 'EMAIL_SMTP_550: User unknown [permanent]',
    });
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.attempts[0]?.providerRef).toBe('');
  });

  it('delivery DSNs mark the LAST attempt delivered', () => {
    const provider = preResolvedProvider('smtp', acceptedOutcome);
    const { conversation } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    const { conversation: delivered, event } = markDelivered(conversation, asUuid('m-1'), fakeClock());
    expect(delivered.messages[0]?.status).toBe('delivered');
    expect(event.name).toBe('comms.messageDelivered');
    expect(event.payload.providerRef).toBe('<m-1.1.1@relay.example>');
  });

  // AC2, table-driven: the full wire→outcome→ladder ride per failure class.
  it.each([
    {
      name: 'success: 250 acceptance lands sent on the first attempt',
      script: [{ ok: true, providerRef: '<m-1.1.1@relay.example>' }] as readonly EmailWireResult[],
      expectedStatus: 'sent',
      expectedAttempts: 1,
      expectedEvents: ['comms.messageSent'],
    },
    {
      name: 'transient failure: 451 retries on the standard ladder, then dead-letters',
      script: [transientRefusal] as readonly EmailWireResult[],
      expectedStatus: 'deadLettered',
      expectedAttempts: 3,
      expectedEvents: [
        'comms.messageFailed',
        'comms.messageFailed',
        'comms.messageFailed',
        'comms.messageDeadLettered',
      ],
    },
    {
      name: 'permanent refusal: 550 unknown mailbox collapses the ladder to one attempt',
      script: [unknownMailbox] as readonly EmailWireResult[],
      expectedStatus: 'deadLettered',
      expectedAttempts: 1,
      expectedEvents: ['comms.messageFailed', 'comms.messageDeadLettered'],
    },
  ])('$name', async ({ script, expectedStatus, expectedAttempts, expectedEvents }) => {
    const transport = scriptedTransport(script);
    let conversation = queuedConversation();
    const eventNames: string[] = [];
    for (let attempt = 1; attempt <= expectedAttempts; attempt += 1) {
      const wire = script[Math.min(attempt - 1, script.length - 1)] as EmailWireResult;
      const outcome = await dispatchToOutcome(transport, { ...REQ, clientRef: `m-1#${attempt}` });
      const { conversation: next, result } = attemptSend(
        conversation,
        asUuid('m-1'),
        preResolvedProvider('smtp', outcome),
        baseCmd,
        policyForWireResult(wire, POLICY),
        fakeClock(),
      );
      conversation = next;
      eventNames.push(...result.events.map((e) => e.name));
      if (attempt < expectedAttempts) expect(result.retryAt).not.toBeNull();
    }
    const message = conversation.messages[0];
    expect(message?.status).toBe(expectedStatus);
    expect(message?.attempts).toHaveLength(expectedAttempts);
    expect(eventNames).toEqual(expectedEvents);
    if (expectedStatus === 'deadLettered') {
      // terminal: every attempt failed and the ladder stopped — no silent loops
      expect(message?.attempts.every((a) => a.status === 'failed')).toBe(true);
    }
  });
});

describe('withConsentRequirement (fail-closed boundary)', () => {
  const cmd: OutboundCommand = {
    messageId: asUuid('m-1'),
    conversationId: asUuid('c-1'),
    channel: 'email',
    body: 'Payment reminder',
    to: 'jane.doe@example.com',
  };
  const refusing = withConsentRequirement(preResolvedProvider('smtp', acceptedOutcome), () => false);

  it('refuses WITHOUT the wire when the probe says no', () => {
    expect(refusing.send(cmd, 1)).toEqual({
      status: 'rejected',
      failureReason: 'DUNNING_CONSENT_REQUIRED: no active grant covers this send (boundary refusal)',
    });
  });

  it('passes through when consented', () => {
    const guarded = withConsentRequirement(preResolvedProvider('smtp', acceptedOutcome), () => true);
    expect(guarded.send(cmd, 1)).toEqual({ status: 'accepted', providerRef: '<m-1.1.1@relay.example>' });
  });

  it('a THROWING probe fails closed', () => {
    const guarded = withConsentRequirement(preResolvedProvider('smtp', acceptedOutcome), () => {
      throw new Error('registry unavailable');
    });
    const outcome = guarded.send(cmd, 1);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.failureReason).toContain('DUNNING_CONSENT_REQUIRED');
  });
});

describe('policyForWireResult', () => {
  it('permanent refusals collapse the ladder to one attempt', () => {
    const collapsed = policyForWireResult(unknownMailbox, POLICY);
    expect(collapsed.maxAttempts).toBe(1);
    expect(collapsed.backoffStepsMs).toHaveLength(0);
    const riding = policyForWireResult(transientRefusal, POLICY);
    expect(riding.maxAttempts).toBe(3);
    const accepted = policyForWireResult({ ok: true, providerRef: '<x@y>' }, POLICY);
    expect(accepted.maxAttempts).toBe(3);
  });
});

describe('delivery status notification (DSN) parsing', () => {
  it('failed DSN carries the enhanced status as the machine reason', () => {
    expect(parseDeliveryStatusNotification({ messageId: '<m-1.1.1@relay.example>', action: 'failed', status: '5.1.1' })).toEqual({
      kind: 'failed',
      providerRef: '<m-1.1.1@relay.example>',
      reason: 'EMAIL_DSN_FAILED_5.1.1',
    });
  });
  it('delayed DSN is not a delivery fact (intermediate verdict)', () => {
    expect(parseDeliveryStatusNotification({ messageId: '<m-2@relay.example>', action: 'delayed', status: '4.4.1' })).toEqual({
      kind: 'sent',
      providerRef: '<m-2@relay.example>',
    });
  });
  it('delivered DSN closes the lifecycle', () => {
    expect(parseDeliveryStatusNotification({ messageId: '<m-3@relay.example>', action: 'delivered' })).toEqual({
      kind: 'delivered',
      providerRef: '<m-3@relay.example>',
    });
  });
  it.each([
    ['missing messageId', { action: 'delivered' }, /no 'messageId'/],
    ['unknown action', { messageId: '<x@y>', action: 'teleported' }, /unknown DSN action/],
    ['non-object payload', 42, /no 'messageId'/],
    ['malformed enhanced status', { messageId: '<x@y>', action: 'failed', status: 'mailbox full' }, /not an enhanced status code/],
  ])('refuses %s', (_name, payload, matcher) => {
    expect(() => parseDeliveryStatusNotification(payload)).toThrowError(matcher);
  });
});
