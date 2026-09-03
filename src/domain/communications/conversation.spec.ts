import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  appendConsentGranted,
  appendConsentRevoked,
  appendInboundMessage,
  latestConsentFact,
  queueOutboundMessage,
  routeInbound,
  startConversation,
  withMessage,
  type Conversation,
} from './conversation';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const OTHER_CUSTOMER = uid(3);

const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T09:00:00.000Z';
const clock = at(T0);

const CONV_ID = uid(10);

const start = (clock_ = clock, channel = 'whatsapp'): Conversation =>
  startConversation({ id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel }, [], clock_).conversation;

const inbound = (n: number, at_ = clock) => ({
  id: uid(100 + n),
  bodyRef: `body-ref-${n}`,
  linkage: { customerId: CUSTOMER },
});

const outbound = (n: number) => ({
  id: uid(100 + n),
  bodyRef: `body-ref-${n}`,
  linkage: { customerId: CUSTOMER, invoiceId: uid(50) },
});

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

// --- conversation lifecycle ---------------------------------------------------

describe('startConversation', () => {
  it('opens a conversation and emits comms.conversationStarted', () => {
    const { conversation, event } = startConversation(
      { id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp' },
      [],
      clock,
    );
    expect(conversation).toMatchObject({ orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp' });
    expect(conversation.messages).toEqual([]);
    expect(conversation.facts).toEqual([]);
    expect(conversation.startedAt.toISOString()).toBe(T0);
    expect(event.name).toBe('comms.conversationStarted');
    expect(event.aggregateId).toBe(CONV_ID);
    expect(event.payload).toEqual({
      conversationId: CONV_ID,
      orgId: ORG,
      customerId: CUSTOMER,
      channel: 'whatsapp',
    });
    expect(event.occurredAt).toBe(T0);
    expect(event.version).toBe(1);
  });

  it('uniqueness: duplicate (org, customer, channel) throws COMMS_CONVERSATION_EXISTS', () => {
    const existing = [start()];
    expectCode(
      () => startConversation({ id: uid(99), orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp' }, existing, clock),
      'COMMS_CONVERSATION_EXISTS',
    );
  });

  it('table: same key is allowed when a uniqueness dimension differs', () => {
    const table: Array<{ existing: Conversation[]; channel: string; orgId?: Uuid; customerId?: Uuid }> = [
      { existing: [start()], channel: 'sms' }, // different channel
      { existing: [start()], channel: 'whatsapp', customerId: OTHER_CUSTOMER }, // different customer
      { existing: [start()], channel: 'whatsapp', orgId: uid(9) }, // different org
    ];
    for (const c of table) {
      const started = startConversation(
        { id: uid(99), orgId: c.orgId ?? ORG, customerId: c.customerId ?? CUSTOMER, channel: c.channel },
        c.existing,
        clock,
      );
      expect(started.conversation.id).toBe(uid(99));
    }
  });

  it('rejects unknown channels with COMMS_CHANNEL_INVALID', () => {
    expectCode(
      () => startConversation({ id: CONV_ID, orgId: ORG, customerId: CUSTOMER, channel: 'push' }, [], clock),
      'COMMS_CHANNEL_INVALID',
    );
  });
});

// --- threading ------------------------------------------------------------------

describe('message threading', () => {
  it('inbound messages arrive delivered with sentAt from the Clock and thread in append order', () => {
    let conv = start();
    conv = appendInboundMessage(conv, inbound(1), at(T0)).conversation;
    conv = queueOutboundMessage(conv, outbound(2)).conversation;
    conv = appendInboundMessage(conv, inbound(3), at(T1)).conversation;

    expect(conv.messages.map((m) => m.direction)).toEqual(['in', 'out', 'in']);
    expect(conv.messages.map((m) => m.status)).toEqual(['delivered', 'queued', 'delivered']);
    expect(conv.messages[2]!.sentAt?.toISOString()).toBe(T1);
    expect(conv.messages[0]!.templateRef).toBeNull();
    expect(conv.messages.every((m) => m.conversationId === CONV_ID)).toBe(true);
  });

  it('inbound append emits comms.inboundReceived on the message aggregate', () => {
    const { event } = appendInboundMessage(start(), inbound(1), clock);
    expect(event.name).toBe('comms.inboundReceived');
    expect(event.aggregateId).toBe(inbound(1).id);
    expect(event.payload).toEqual({ conversationId: CONV_ID, messageId: inbound(1).id, channel: 'whatsapp' });
  });

  it('linkage customer must match the conversation customer', () => {
    expectCode(
      () => appendInboundMessage(start(), { ...inbound(1), linkage: { customerId: OTHER_CUSTOMER } }, clock),
      'COMMS_MESSAGE_CUSTOMER_MISMATCH',
    );
  });

  it('SPEC §26 linkage: customerId required, case/promise/invoice refs ride along opaquely', () => {
    const { message } = queueOutboundMessage(start(), {
      ...outbound(1),
      linkage: { customerId: CUSTOMER, caseId: uid(60), promiseId: uid(61), invoiceId: uid(62) },
    });
    expect(message.linkage).toEqual({
      customerId: CUSTOMER,
      caseId: uid(60),
      promiseId: uid(61),
      invoiceId: uid(62),
    });
  });

  it('table: invalid message appends throw stable codes', () => {
    const conv = start();
    expectCode(() => queueOutboundMessage(conv, { ...outbound(1), bodyRef: ' ' }), 'COMMS_BODY_REF_REQUIRED');
    expectCode(
      () => appendInboundMessage(conv, { ...inbound(1), bodyRef: '' }, clock),
      'COMMS_BODY_REF_REQUIRED',
    );
    const convWith = queueOutboundMessage(conv, outbound(1)).conversation;
    expectCode(() => queueOutboundMessage(convWith, outbound(1)), 'COMMS_MESSAGE_ID_TAKEN');
    expectCode(() => appendInboundMessage(convWith, { ...inbound(1), id: outbound(1).id }, clock), 'COMMS_MESSAGE_ID_TAKEN');
  });

  it('withMessage rejects foreign message ids', () => {
    expectCode(() => withMessage(start(), { ...outbound(1), conversationId: CONV_ID } as never), 'COMMS_MESSAGE_NOT_IN_CONVERSATION');
  });
});

// --- inbound routing ---------------------------------------------------------------

describe('routeInbound', () => {
  it('matches the (org, customer, channel) thread', () => {
    const conv = start();
    const route = routeInbound([conv], { orgId: ORG, customerId: CUSTOMER, channel: 'whatsapp', bodyRef: 'b1' }, clock);
    expect(route.matched).toBe(true);
    if (route.matched) expect(route.conversation.id).toBe(CONV_ID);
  });

  it('table: a miss on any dimension routes to unmatched', () => {
    const conv = start();
    const table: Array<{ probe: { orgId: Uuid; customerId: Uuid; channel: string } }> = [
      { probe: { orgId: ORG, customerId: CUSTOMER, channel: 'sms' } },
      { probe: { orgId: ORG, customerId: OTHER_CUSTOMER, channel: 'whatsapp' } },
      { probe: { orgId: uid(9), customerId: CUSTOMER, channel: 'whatsapp' } },
    ];
    for (const c of table) {
      const route = routeInbound([conv], { ...c.probe, bodyRef: 'b1' }, clock);
      expect(route.matched).toBe(false);
      if (!route.matched) {
        expect(route.fact.name).toBe('comms.unmatchedInbound');
        expect(route.fact.aggregateId).toBe(c.probe.orgId);
        expect(route.fact.payload).toEqual({ ...c.probe, bodyRef: 'b1' });
      }
    }
  });

  it('unmatched inbound is raised as a fact, not an error — nothing is silently dropped', () => {
    const route = routeInbound([], { orgId: ORG, customerId: CUSTOMER, channel: 'email', bodyRef: 'b1' }, clock);
    expect(route.matched).toBe(false);
    if (!route.matched) expect(route.fact.version).toBe(1);
  });

  it('invalid channel on the probe throws (input validation, not a miss)', () => {
    expectCode(
      () => routeInbound([], { orgId: ORG, customerId: CUSTOMER, channel: 'push', bodyRef: 'b1' }, clock),
      'COMMS_CHANNEL_INVALID',
    );
  });
});

// --- consent fact trail (K2) ---------------------------------------------------------

describe('consent fact trail', () => {
  const REF = uid(80);

  it('grant then revoke appends an ordered, immutable trail with Clock timestamps', () => {
    let conv = start();
    conv = appendConsentGranted(conv, { consentRef: REF }, at(T0));
    conv = appendConsentRevoked(conv, { consentRef: REF }, at(T1));
    expect(conv.facts.map((f) => f.type)).toEqual(['consentGranted', 'consentRevoked']);
    expect(conv.facts[0]!.at).toBe(T0);
    expect(conv.facts[1]!.at).toBe(T1);
    expect(latestConsentFact(conv, REF)?.type).toBe('consentRevoked');
  });

  it('re-grant after revocation is a NEW fact (the trail IS the audit)', () => {
    let conv = start();
    conv = appendConsentGranted(conv, { consentRef: REF }, at(T0));
    conv = appendConsentRevoked(conv, { consentRef: REF }, at(T1));
    conv = appendConsentGranted(conv, { consentRef: REF }, at('2026-03-03T08:00:00.000Z'));
    expect(conv.facts).toHaveLength(3);
    expect(latestConsentFact(conv, REF)?.type).toBe('consentGranted');
  });

  it('table: invalid trail operations throw stable codes', () => {
    let conv = start();
    expectCode(() => appendConsentRevoked(conv, { consentRef: REF }, clock), 'COMMS_CONSENT_REVOCATION_UNGRANTED');
    conv = appendConsentGranted(conv, { consentRef: REF }, clock);
    expectCode(() => appendConsentGranted(conv, { consentRef: REF }, clock), 'COMMS_CONSENT_ALREADY_GRANTED');
    conv = appendConsentRevoked(conv, { consentRef: REF }, clock);
    expectCode(() => appendConsentRevoked(conv, { consentRef: REF }, clock), 'COMMS_CONSENT_NOT_ACTIVE');
  });

  it('latestConsentFact ignores unrelated refs', () => {
    let conv = start();
    conv = appendConsentGranted(conv, { consentRef: uid(81) }, clock);
    expect(latestConsentFact(conv, REF)).toBeNull();
  });
});
