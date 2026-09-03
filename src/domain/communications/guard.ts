/**
 * Automated-send guard — the consent-before-send boundary (K2, issue #22).
 *
 * Review finding K2 (WhatsApp opt-in / DPA 2019): OUTBOUND AUTOMATED
 * messages may only leave through this boundary, and the boundary refuses
 * unless the conversation's consent trail shows an active grant for the
 * consentRef the send claims:
 *
 *   1. the command carries a consentRef at all (missing → blocked);
 *   2. that consentRef was granted on the conversation (no implied or
 *      inherited consent — an org registry row alone never unlocks a send);
 *   3. the latest fact for that consentRef is not a revocation — once a
 *      revocation fact is appended, EVERY subsequent automated send on the
 *      conversation is blocked, before and forever after (until a NEW grant
 *      fact is appended, K3 re-consent).
 *
 * House style (matching consent/guard.ts): a refusal is a VALUE carrying the
 * stable code `COMMS_SEND_BLOCKED_NO_CONSENT` AND the `comms.sendBlockedNoConsent`
 * event — never an exception — so the audit trail records every blocked
 * attempt. Only malformed input (unknown channel, empty bodyRef) throws.
 *
 * Manual agent replies are NOT automated sends and bypass this boundary
 * (queueOutboundMessage) — a human answering a customer's question is not
 * bulk automated contact; policy may still require consent per channel at
 * the adapter layer.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { TemplateRef } from './templates';
import {
  queueOutboundMessage,
  type Conversation,
  type Message,
  type OutboundMessageInput,
} from './conversation';
import { sendBlockedNoConsentEvent, type CommsEvent, type SendBlockedNoConsentPayload } from './events';

/** Stable machine code for the K2 refusal — adapters match on this. */
export const COMMS_SEND_BLOCKED_NO_CONSENT = 'COMMS_SEND_BLOCKED_NO_CONSENT';

export interface AutomatedSendInput {
  readonly id: Uuid;
  readonly bodyRef: string;
  readonly templateRef?: TemplateRef | null;
  readonly linkage: OutboundMessageInput['linkage'];
  /** REQUIRED for automated sends (K2) — the grant this send runs under. */
  readonly consentRef?: Uuid;
}

export type BlockedReason = SendBlockedNoConsentPayload['reason'];

export type AutomatedSendResult =
  | { readonly accepted: true; readonly conversation: Conversation; readonly message: Message }
  | {
      readonly accepted: false;
      /** Stable code — always COMMS_SEND_BLOCKED_NO_CONSENT (exported const). */
      readonly code: typeof COMMS_SEND_BLOCKED_NO_CONSENT;
      readonly reason: BlockedReason;
      readonly detail: string;
      /** comms.sendBlockedNoConsent — persist next to the refusal decision. */
      readonly event: CommsEvent<'comms.sendBlockedNoConsent', SendBlockedNoConsentPayload>;
    };

/**
 * Screen + queue one automated outbound message through the K2 boundary.
 * Pure: reads the conversation's consent fact trail, never mutates it.
 */
export const sendAutomatedMessage = (
  conversation: Conversation,
  input: AutomatedSendInput,
  clock: Clock,
): AutomatedSendResult => {
  const blocked = (
    reason: BlockedReason,
    detail: string,
    consentRef: Uuid | null,
  ): AutomatedSendResult => ({
    accepted: false,
    code: COMMS_SEND_BLOCKED_NO_CONSENT,
    reason,
    detail,
    event: sendBlockedNoConsentEvent(
      {
        conversationId: conversation.id,
        channel: conversation.channel,
        consentRef: consentRef,
        reason,
        detail,
      },
      clock,
    ),
  });

  if (!input.bodyRef.trim()) {
    throw new DomainError('COMMS_BODY_REF_REQUIRED', 'a message requires a bodyRef');
  }

  // 1. The command must claim a consentRef at all.
  const consentRef = input.consentRef;
  if (consentRef === undefined) {
    return blocked(
      'NO_CONSENT_REF',
      `automated ${conversation.channel} send refused: no consentRef supplied (K2 — automated sends require consent)`,
      null,
    );
  }

  // 2. The ref must have been granted on this conversation...
  const grant = conversation.facts.find((f) => f.type === 'consentGranted' && f.consentRef === consentRef);
  if (!grant) {
    return blocked(
      'CONSENT_NOT_GRANTED',
      `automated ${conversation.channel} send refused: consent ${consentRef} was never granted on conversation ${conversation.id} (no implied consent)`,
      consentRef,
    );
  }

  // 3. ...and not revoked since (latest fact for the ref wins).
  let latest: 'consentGranted' | 'consentRevoked' | null = null;
  let revokedAt: string | null = null;
  for (const fact of conversation.facts) {
    if (fact.consentRef !== consentRef) continue;
    latest = fact.type;
    if (fact.type === 'consentRevoked') revokedAt = fact.at;
  }
  if (latest === 'consentRevoked') {
    return blocked(
      'CONSENT_REVOKED',
      `automated ${conversation.channel} send refused: consent ${consentRef} was revoked at ${revokedAt} — all subsequent automated sends are blocked`,
      consentRef,
    );
  }

  const queued = queueOutboundMessage(conversation, { ...input, consentRef });
  return { accepted: true, conversation: queued.conversation, message: queued.message };
};
