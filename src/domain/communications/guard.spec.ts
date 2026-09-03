import { describe, expect, it } from 'vitest';
import { type Clock, type Uuid, uuid } from '../shared';
import {
  appendConsentGranted,
  appendConsentRevoked,
  queueOutboundMessage,
  startConversation,
  type Conversation,
} from './conversation';
import {
  COMMS_SEND_BLOCKED_NO_CONSENT,
  sendAutomatedMessage,
  type AutomatedSendResult,
} from './guard';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const CONV_ID = uid(10);
const MSG_ID = uid(20);
const CONSENT = uid(80);

const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const T_GRANT = '2026-03-01T08:00:00.000Z';
const T_REVOKE = '2026-03-02T08:00:00.000Z';
const T_SEND = '2026-03-01T09:00:00.000Z';
const sendClock = at(T_SEND);

const startConversationAt = (clock: Clock = sendClock): Conversation =>
  startConversation({ id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp' }, [], clock).conversation;

/** Conversation with an active grant fact — the "before" state of the K2 table. */
const grantedConversation = (): Conversation =>
  appendConsentGranted(startConversationAt(), { consentRef: CONSENT }, at(T_GRANT));

const sendInput = (over: Partial<Parameters<typeof sendAutomatedMessage>[1]> = {}) => ({
  id: MSG_ID,
  bodyRef: 'body-ref-1',
  linkage: { customerId: CUSTOMER, invoiceId: uid(30) },
  consentRef: CONSENT,
  ...over,
});

const expectBlocked = (result: AutomatedSendResult, reason: string, consentRef: string | null): void => {
  expect(result.accepted).toBe(false);
  if (result.accepted) return; // narrows for TS
  expect(result.code).toBe(COMMS_SEND_BLOCKED_NO_CONSENT);
  expect(result.reason).toBe(reason);
  expect(result.event.name).toBe('comms.sendBlockedNoConsent');
  expect(result.event.version).toBe(1);
  expect(result.event.aggregateId).toBe(CONV_ID);
  expect(result.event.payload).toEqual({
    conversationId: CONV_ID,
    channel: 'whatsapp',
    consentRef,
    reason,
    detail: result.detail,
  });
};

// --- the K2 boundary table ------------------------------------------------------

describe('sendAutomatedMessage — consent-before-send boundary (K2)', () => {
  it('BEFORE revocation: an active grant lets the automated send through', () => {
    const conv = grantedConversation();
    const result = sendAutomatedMessage(conv, sendInput(), sendClock);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.message.status).toBe('queued');
      expect(result.message.consentRef).toBe(CONSENT);
      expect(result.message.attempts).toEqual([]);
      expect(result.conversation.messages).toHaveLength(1);
    }
  });

  it('AFTER revocation: the appended revocation fact blocks ALL subsequent automated sends', () => {
    let conv = grantedConversation();
    // before: allowed
    const before = sendAutomatedMessage(conv, sendInput(), sendClock);
    expect(before.accepted).toBe(true);
    if (!before.accepted) return;
    conv = before.conversation; // the queued message lives in the NEW conversation object
    // revoke (append-only fact on the conversation)
    conv = appendConsentRevoked(conv, { consentRef: CONSENT }, at(T_REVOKE));
    // after: blocked, forever, on every subsequent send
    expectBlocked(sendAutomatedMessage(conv, sendInput(), sendClock), 'CONSENT_REVOKED', CONSENT);
    expectBlocked(
      sendAutomatedMessage(conv, sendInput({ id: uid(21) }), sendClock),
      'CONSENT_REVOKED',
      CONSENT,
    );
    // and nothing was appended to the thread by the blocked attempts
    expect(conv.messages).toHaveLength(1);
  });

  it('missing consentRef on the command is refused (NO_CONSENT_REF)', () => {
    const { consentRef: _omitted, ...without } = sendInput();
    expectBlocked(sendAutomatedMessage(grantedConversation(), without, sendClock), 'NO_CONSENT_REF', null);
  });

  it('a consentRef never granted on the conversation is refused — no implied consent (CONSENT_NOT_GRANTED)', () => {
    expectBlocked(
      sendAutomatedMessage(startConversationAt(), sendInput({ consentRef: uid(81) }), sendClock),
      'CONSENT_NOT_GRANTED',
      uid(81),
    );
    // even when some OTHER ref is active on the conversation (K2: exact ref or nothing)
    expectBlocked(
      sendAutomatedMessage(grantedConversation(), sendInput({ consentRef: uid(82) }), sendClock),
      'CONSENT_NOT_GRANTED',
      uid(82),
    );
  });

  it('re-granting after revocation (new fact, K3) unblocks automated sends', () => {
    let conv = grantedConversation();
    conv = appendConsentRevoked(conv, { consentRef: CONSENT }, at(T_REVOKE));
    expect(sendAutomatedMessage(conv, sendInput(), sendClock).accepted).toBe(false);
    conv = appendConsentGranted(conv, { consentRef: CONSENT }, sendClock);
    const result = sendAutomatedMessage(conv, sendInput(), sendClock);
    expect(result.accepted).toBe(true);
  });

  it('the block fires before anything is queued — no partial sends on refusal', () => {
    let conv = grantedConversation();
    conv = appendConsentRevoked(conv, { consentRef: CONSENT }, at(T_REVOKE));
    const result = sendAutomatedMessage(conv, sendInput(), sendClock);
    if (!result.accepted) {
      expect('conversation' in result).toBe(false);
      expect('message' in result).toBe(false);
    }
    expect(conv.messages).toHaveLength(0);
  });

  it('manual agent replies are NOT automated sends — queueOutboundMessage bypasses the gate', () => {
    const conv = startConversationAt(); // no consent facts at all
    const { message } = queueOutboundMessage(conv, {
      id: MSG_ID,
      bodyRef: 'body-ref-1',
      linkage: { customerId: CUSTOMER },
    });
    expect(message.status).toBe('queued');
    expect(message.consentRef).toBeUndefined();
  });

  it('blocked refusals are values, not exceptions — only malformed input throws', () => {
    expect(() => sendAutomatedMessage(grantedConversation(), sendInput({ bodyRef: ' ' }), sendClock)).toThrow();
    const result = sendAutomatedMessage(startConversationAt(), sendInput({ consentRef: uid(83) }), sendClock);
    expect(result.accepted).toBe(false);
  });
});
