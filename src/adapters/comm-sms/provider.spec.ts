/**
 * Seam wiring tests (issue #112): the wire→outcome mapping, the
 * preResolvedProvider satisfying the PURE port through a FULL attemptSend
 * ladder, the fail-closed consent boundary, and status-callback parsing.
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
  parseAfricasTalkingDeliveryReport,
  parseTwilioStatusCallback,
  policyForWireResult,
  preResolvedProvider,
  withConsentRequirement,
} from './provider';
import type { SmsTransport, SmsWireResult } from './transports';

const asUuid = (value: string): Uuid => value as unknown as Uuid;
const fakeClock = (): Clock => ({ now: () => new Date('2026-09-08T09:00:00Z') });

const POLICY: RetryPolicy = { maxAttempts: 3, backoffStepsMs: [1000, 5000] };

const acceptedOutcome: ProviderOutcome = { status: 'accepted', providerRef: 'ATIdx_1' };
const rateLimited: SmsWireResult = { ok: false, failureReason: 'AT_RATE_LIMITED', retryable: true };
const invalidNumber: SmsWireResult = { ok: false, failureReason: 'AT_InvalidPhoneNumber', retryable: false };

const scriptedTransport = (results: readonly SmsWireResult[]): SmsTransport => {
  let n = 0;
  return {
    name: 'africastalking',
    async dispatch() {
      const result = results[Math.min(n, results.length - 1)] as SmsWireResult;
      n += 1;
      return result;
    },
  };
};

describe('dispatchToOutcome', () => {
  it('maps ok results to accepted outcomes', async () => {
    await expect(dispatchToOutcome(scriptedTransport([{ ok: true, providerRef: 'ATIdx_1' }]), { to: '254712345678', body: 'x' })).resolves.toEqual({
      status: 'accepted',
      providerRef: 'ATIdx_1',
    });
  });

  it('carries retryability as a machine-readable suffix on the refusal', async () => {
    const outcome = await dispatchToOutcome(scriptedTransport([rateLimited]), { to: '254712345678', body: 'x' });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.failureReason).toBe('AT_RATE_LIMITED [retryable]');
    }
  });
});

describe('preResolvedProvider through the pure attemptSend ladder', () => {
  const baseCmd = { body: 'Payment reminder', to: '254712345678' };

  const queuedConversation = (): Conversation => {
    const started = startConversation(
      { id: asUuid('c-1'), orgId: asUuid('org-1'), customerId: asUuid('cust-1'), channel: 'sms' },
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
    const provider = preResolvedProvider('africastalking', acceptedOutcome);
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.status).toBe('sent');
    expect(result.message.attempts[0]?.providerRef).toBe('ATIdx_1');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe('comms.messageSent');
  });

  it('rejected outcome: the pure policy retries then dead-letters — no silent loops', () => {
    const provider = preResolvedProvider('africastalking', {
      status: 'rejected',
      failureReason: 'AT_RATE_LIMITED [retryable]',
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
    const provider = preResolvedProvider('africastalking', {
      status: 'rejected',
      failureReason: 'AT_InvalidPhoneNumber [permanent]',
    });
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.attempts[0]?.providerRef).toBe('');
  });

  it('permanent refusals collapse the ladder via policyForWireResult (one attempt, immediate terminal)', () => {
    const collapsed = policyForWireResult(invalidNumber, POLICY);
    expect(collapsed.maxAttempts).toBe(1);
    const riding = policyForWireResult(rateLimited, POLICY);
    expect(riding.maxAttempts).toBe(3);
  });

  it('delivery callbacks mark the LAST attempt delivered', () => {
    const provider = preResolvedProvider('africastalking', acceptedOutcome);
    const { conversation } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    const { conversation: delivered, event } = markDelivered(conversation, asUuid('m-1'), fakeClock());
    expect(delivered.messages[0]?.status).toBe('delivered');
    expect(event.name).toBe('comms.messageDelivered');
    expect(event.payload.providerRef).toBe('ATIdx_1');
  });
});

describe('withConsentRequirement (fail-closed boundary)', () => {
  const cmd: OutboundCommand = {
    messageId: asUuid('m-1'),
    conversationId: asUuid('c-1'),
    channel: 'sms',
    body: 'Payment reminder',
    to: '254712345678',
  };
  const refusing = withConsentRequirement(preResolvedProvider('africastalking', acceptedOutcome), () => false);

  it('refuses WITHOUT the wire when the probe says no', () => {
    expect(refusing.send(cmd, 1)).toEqual({
      status: 'rejected',
      failureReason: 'DUNNING_CONSENT_REQUIRED: no active grant covers this send (boundary refusal)',
    });
  });

  it('passes through when consented', () => {
    const guarded = withConsentRequirement(preResolvedProvider('africastalking', acceptedOutcome), () => true);
    expect(guarded.send(cmd, 1)).toEqual({ status: 'accepted', providerRef: 'ATIdx_1' });
  });

  it('a THROWING probe fails closed', () => {
    const guarded = withConsentRequirement(preResolvedProvider('africastalking', acceptedOutcome), () => {
      throw new Error('registry unavailable');
    });
    const outcome = guarded.send(cmd, 1);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.failureReason).toContain('DUNNING_CONSENT_REQUIRED');
  });
});

describe('status callback parsing', () => {
  it('twilio: form-encoded delivered callback → delivered verdict', () => {
    expect(parseTwilioStatusCallback('MessageSid=SM876&MessageStatus=delivered')).toEqual({
      kind: 'delivered',
      providerRef: 'SM876',
    });
  });
  it('twilio: undelivered carries the provider reason', () => {
    expect(parseTwilioStatusCallback({ MessageSid: 'SM1', MessageStatus: 'undelivered', ErrorMessage: 'carrier blocked' })).toEqual({
      kind: 'failed',
      providerRef: 'SM1',
      reason: 'carrier blocked',
    });
  });
  it('twilio: intermediate statuses are not delivery facts', () => {
    expect(parseTwilioStatusCallback({ MessageSid: 'SM2', MessageStatus: 'queued' })).toEqual({ kind: 'sent', providerRef: 'SM2' });
  });
  it('twilio: unknown status refused', () => {
    expect(() => parseTwilioStatusCallback({ MessageSid: 'SM3', MessageStatus: 'teleported' })).toThrowError(/unknown twilio MessageStatus/);
  });
  it('twilio: missing sid refused', () => {
    expect(() => parseTwilioStatusCallback({ MessageStatus: 'delivered' })).toThrowError(/no MessageSid/);
  });
  it('africastalking: Success report → delivered', () => {
    expect(parseAfricasTalkingDeliveryReport({ messageId: 'ATIdx_1', status: 'Success' })).toEqual({
      kind: 'delivered',
      providerRef: 'ATIdx_1',
    });
  });
  it('africastalking: Failed report → failed verdict', () => {
    expect(parseAfricasTalkingDeliveryReport({ messageId: 'ATIdx_2', status: 'Failed' })).toEqual({
      kind: 'failed',
      providerRef: 'ATIdx_2',
      reason: 'AT_DELIVERY_FAILED',
    });
  });
  it('africastalking: unknown status refused', () => {
    expect(() => parseAfricasTalkingDeliveryReport({ messageId: 'ATIdx_3', status: 'Pending' })).toThrowError(/unknown africastalking status/);
  });
  it('africastalking: missing messageId refused', () => {
    expect(() => parseAfricasTalkingDeliveryReport({ status: 'Success' })).toThrowError(/no 'messageId'/);
  });
});
