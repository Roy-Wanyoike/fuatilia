/**
 * Seam wiring tests (issue #128): the wire→outcome mapping, the
 * preResolvedProvider satisfying the PURE port through a FULL attemptSend
 * ladder, the fail-closed consent boundary, and Meta webhook status parsing
 * (delivery/read receipts → verdicts → structured comms.* events).
 */
import { describe, expect, it } from 'vitest';
import {
  attemptSend,
  markDelivered,
  markRead,
  type OutboundCommand,
  type ProviderOutcome,
  type RetryPolicy,
} from '../../domain/communications/provider';
import type { Clock, Uuid } from '../../domain/shared';
import { queueOutboundMessage, startConversation, type Conversation } from '../../domain/communications/conversation';
import {
  dispatchToOutcome,
  parseWhatsAppStatusWebhook,
  policyForWireResult,
  preResolvedProvider,
  withConsentRequirement,
} from './provider';
import type { WhatsAppTemplateSend, WhatsAppTransport, WhatsAppWireResult } from './transports';

const asUuid = (value: string): Uuid => value as unknown as Uuid;
const fakeClock = (): Clock => ({ now: () => new Date('2026-09-08T09:00:00Z') });

const POLICY: RetryPolicy = { maxAttempts: 3, backoffStepsMs: [1000, 5000] };

const acceptedOutcome: ProviderOutcome = { status: 'accepted', providerRef: 'wamid.ACBO' };
const rateLimited: WhatsAppWireResult = { ok: false, failureReason: 'WA_RATE_LIMITED', retryable: true };
const templateRejected: WhatsAppWireResult = { ok: false, failureReason: 'WA_TEMPLATE_REJECTED', retryable: false };

const scriptedTransport = (results: readonly WhatsAppWireResult[]): WhatsAppTransport => {
  let n = 0;
  return {
    name: 'whatsapp',
    async dispatch() {
      const result = results[Math.min(n, results.length - 1)] as WhatsAppWireResult;
      n += 1;
      return result;
    },
  };
};

const REQ: WhatsAppTemplateSend = {
  to: '+254712345678',
  templateName: 'payment_reminder_v1',
  languageCode: 'sw',
  bodyParams: ['INV-1042'],
};

/** A minimal Meta Cloud API webhook envelope carrying the given statuses. */
const statusPayload = (...statuses: readonly unknown[]): unknown => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABIZ1',
      changes: [
        {
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '254700000001', phone_number_id: '111111111111111' },
            statuses,
          },
          field: 'messages',
        },
      ],
    },
  ],
});

describe('dispatchToOutcome', () => {
  it('maps ok results to accepted outcomes', async () => {
    await expect(dispatchToOutcome(scriptedTransport([{ ok: true, providerRef: 'wamid.ACBO' }]), REQ)).resolves.toEqual({
      status: 'accepted',
      providerRef: 'wamid.ACBO',
    });
  });

  it('carries retryability as a machine-readable suffix on the refusal', async () => {
    const outcome = await dispatchToOutcome(scriptedTransport([rateLimited]), REQ);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.failureReason).toBe('WA_RATE_LIMITED [retryable]');
    }
  });
});

describe('preResolvedProvider through the pure attemptSend ladder', () => {
  const baseCmd = { body: 'Payment reminder', to: '+254712345678' };

  const queuedConversation = (): Conversation => {
    const started = startConversation(
      { id: asUuid('c-1'), orgId: asUuid('org-1'), customerId: asUuid('cust-1'), channel: 'whatsapp' },
      [],
      fakeClock(),
    );
    const { conversation } = queueOutboundMessage(started.conversation, {
      id: asUuid('m-1'),
      bodyRef: 'body-reminder-1',
      templateRef: { templateId: asUuid('tpl-1'), version: 3 },
      linkage: { customerId: asUuid('cust-1'), invoiceId: asUuid('inv-1') },
    });
    return conversation;
  };

  it('accepted outcome: message sent with the REAL wire wamid and the pinned template lineage', () => {
    const provider = preResolvedProvider('whatsapp', acceptedOutcome);
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.status).toBe('sent');
    expect(result.message.attempts[0]?.providerRef).toBe('wamid.ACBO');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.name).toBe('comms.messageSent');
    if (result.events[0]?.name === 'comms.messageSent') {
      expect(result.events[0].payload.templateId).toBe(asUuid('tpl-1'));
      expect(result.events[0].payload.templateVersion).toBe(3);
    }
  });

  it('rate-limit refusals ride the standard ladder: retries then terminal dead-letter', () => {
    const provider = preResolvedProvider('whatsapp', {
      status: 'rejected',
      failureReason: 'WA_RATE_LIMITED [retryable]',
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
    const provider = preResolvedProvider('whatsapp', {
      status: 'rejected',
      failureReason: 'WA_TEMPLATE_REJECTED [permanent]',
    });
    const { result } = attemptSend(queuedConversation(), asUuid('m-1'), provider, baseCmd, POLICY, fakeClock());
    expect(result.message.attempts[0]?.providerRef).toBe('');
  });

  it('policyForWireResult: permanent refusals collapse the ladder, retryable ones ride it', () => {
    expect(policyForWireResult(templateRejected, POLICY).maxAttempts).toBe(1);
    expect(policyForWireResult(rateLimited, POLICY).maxAttempts).toBe(3);
    expect(policyForWireResult({ ok: true, providerRef: 'wamid.X' }, POLICY).maxAttempts).toBe(3);
  });

  it('a collapsed permanent refusal dead-letters on the FIRST attempt', () => {
    const provider = preResolvedProvider('whatsapp', { status: 'rejected', failureReason: 'WA_TEMPLATE_REJECTED [permanent]' });
    const { conversation, result } = attemptSend(
      queuedConversation(),
      asUuid('m-1'),
      provider,
      baseCmd,
      policyForWireResult(templateRejected, POLICY),
      fakeClock(),
    );
    expect(result.message.status).toBe('deadLettered');
    expect(conversation.messages[0]?.attempts).toHaveLength(1);
    const names = result.events.map((e) => e.name);
    expect(names).toContain('comms.messageFailed');
    expect(names).toContain('comms.messageDeadLettered');
  });
});

describe('withConsentRequirement (fail-closed boundary)', () => {
  const cmd: OutboundCommand = {
    messageId: asUuid('m-1'),
    conversationId: asUuid('c-1'),
    channel: 'whatsapp',
    body: 'Payment reminder',
    to: '+254712345678',
  };

  it('refuses WITHOUT the wire when the probe says no', () => {
    const refusing = withConsentRequirement(preResolvedProvider('whatsapp', acceptedOutcome), () => false);
    expect(refusing.send(cmd, 1)).toEqual({
      status: 'rejected',
      failureReason: 'DUNNING_CONSENT_REQUIRED: no active grant covers this send (boundary refusal)',
    });
  });

  it('passes through when consented', () => {
    const guarded = withConsentRequirement(preResolvedProvider('whatsapp', acceptedOutcome), () => true);
    expect(guarded.send(cmd, 1)).toEqual({ status: 'accepted', providerRef: 'wamid.ACBO' });
  });

  it('a THROWING probe fails closed', () => {
    const guarded = withConsentRequirement(preResolvedProvider('whatsapp', acceptedOutcome), () => {
      throw new Error('registry unavailable');
    });
    const outcome = guarded.send(cmd, 1);
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.failureReason).toContain('DUNNING_CONSENT_REQUIRED');
  });
});

describe('parseWhatsAppStatusWebhook (delivery/read receipt ingestion)', () => {
  it('a delivered status becomes a delivered verdict', () => {
    expect(parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.DLV', status: 'delivered', timestamp: '1770000000' }))).toEqual([
      { kind: 'delivered', providerRef: 'wamid.DLV' },
    ]);
  });

  it('a read status becomes a read verdict', () => {
    expect(parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.RD', status: 'read', timestamp: '1770000001' }))).toEqual([
      { kind: 'read', providerRef: 'wamid.RD' },
    ]);
  });

  it('a sent status is an informational verdict', () => {
    expect(parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.S', status: 'sent' }))).toEqual([
      { kind: 'sent', providerRef: 'wamid.S' },
    ]);
  });

  it.each([
    ['rate limit 131048', [{ code: 131048, message: 'rate limited' }], 'WA_RATE_LIMITED'],
    ['token failure 190', [{ code: 190, message: 'session expired' }], 'WA_AUTH_REJECTED'],
    ['template rejection 132000', [{ code: 132000, message: 'param mismatch' }], 'WA_TEMPLATE_REJECTED'],
    ['unmapped code carries a scrubbed detail', [{ code: 131030, message: 'recipient 254712345678 not allowed' }], 'WA_PROVIDER_REFUSED_131030: recipient **** not allowed'],
    ['no errors array', undefined, 'WA_STATUS_FAILED'],
  ])('a failed status maps %s', (_name, errors, reason) => {
    const status: Record<string, unknown> = { id: 'wamid.F', status: 'failed' };
    if (errors !== undefined) status['errors'] = errors;
    expect(parseWhatsAppStatusWebhook(statusPayload(status))).toEqual([{ kind: 'failed', providerRef: 'wamid.F', reason }]);
  });

  it('multiple statuses in one payload yield one verdict each', () => {
    const verdicts = parseWhatsAppStatusWebhook(
      statusPayload(
        { id: 'wamid.1', status: 'sent' },
        { id: 'wamid.2', status: 'delivered' },
      ),
    );
    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]).toEqual({ kind: 'sent', providerRef: 'wamid.1' });
    expect(verdicts[1]).toEqual({ kind: 'delivered', providerRef: 'wamid.2' });
  });

  it('a deleted status is well-formed but not a delivery fact — filtered, never invented', () => {
    expect(parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.D', status: 'deleted' }))).toEqual([]);
  });

  it('inbound-message notifications carry no statuses — nothing to ingest', () => {
    const payload: unknown = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABIZ1', changes: [{ value: { messaging_product: 'whatsapp', messages: [{ from: '254712345678' }] }, field: 'messages' }] }],
    };
    expect(parseWhatsAppStatusWebhook(payload)).toEqual([]);
  });

  it.each([
    ['a non-object payload', '"just a string"', /payload is not an object/],
    ['a payload without entry', { object: 'whatsapp_business_account' }, /no 'entry' array/],
    ['an entry without changes', { entry: [{ id: 'WABIZ1' }] }, /no 'changes' array/],
    ['a status without id', statusPayload({ status: 'delivered' }), /status carries no 'id'/],
    ['a status without a state', statusPayload({ id: 'wamid.X' }), /status carries no 'status'/],
    ['an unknown status', statusPayload({ id: 'wamid.X', status: 'teleported' }), /unknown whatsapp status/],
  ])('malformed webhook input is refused: %s', (_name, payload, matches) => {
    expect(() => parseWhatsAppStatusWebhook(payload)).toThrowError(matches);
  });
});

describe('receipts applied through the pure domain (structured events)', () => {
  const baseCmd = { body: 'Payment reminder', to: '+254712345678' };

  const sentConversation = (): Conversation => {
    const started = startConversation(
      { id: asUuid('c-1'), orgId: asUuid('org-1'), customerId: asUuid('cust-1'), channel: 'whatsapp' },
      [],
      fakeClock(),
    );
    const { conversation } = queueOutboundMessage(started.conversation, {
      id: asUuid('m-1'),
      bodyRef: 'body-reminder-1',
      linkage: { customerId: asUuid('cust-1'), invoiceId: asUuid('inv-1') },
    });
    const { conversation: sent } = attemptSend(
      conversation,
      asUuid('m-1'),
      preResolvedProvider('whatsapp', acceptedOutcome),
      baseCmd,
      POLICY,
      fakeClock(),
    );
    return sent;
  };

  it('delivered receipt → comms.messageDelivered carrying the wamid', () => {
    const sent = sentConversation();
    const [verdict] = parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.ACBO', status: 'delivered' }));
    // the worker guard: the receipt must reference the attempt we hold
    expect(verdict?.providerRef).toBe(sent.messages[0]?.attempts[0]?.providerRef);
    expect(verdict?.kind).toBe('delivered');
    const { conversation, event } = markDelivered(sent, asUuid('m-1'), fakeClock());
    expect(conversation.messages[0]?.status).toBe('delivered');
    expect(event.name).toBe('comms.messageDelivered');
    expect(event.payload).toMatchObject({ conversationId: asUuid('c-1'), messageId: asUuid('m-1'), providerRef: 'wamid.ACBO' });
  });

  it('read receipt → comms.messageRead (delivered → read)', () => {
    const sent = sentConversation();
    const [readVerdict] = parseWhatsAppStatusWebhook(statusPayload({ id: 'wamid.ACBO', status: 'read' }));
    expect(readVerdict?.kind).toBe('read');
    const { conversation: delivered } = markDelivered(sent, asUuid('m-1'), fakeClock());
    const { conversation: read, event } = markRead(delivered, asUuid('m-1'), fakeClock());
    expect(read.messages[0]?.status).toBe('read');
    expect(event.name).toBe('comms.messageRead');
  });

  it('a failed receipt maps to the failure path evidence (reason carries the taxonomy)', () => {
    const [verdict] = parseWhatsAppStatusWebhook(
      statusPayload({ id: 'wamid.ACBO', status: 'failed', errors: [{ code: 131047, message: 're-engagement' }] }),
    );
    expect(verdict).toEqual({ kind: 'failed', providerRef: 'wamid.ACBO', reason: 'WA_WINDOW_CLOSED' });
  });
});
