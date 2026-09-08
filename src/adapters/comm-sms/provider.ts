/**
 * The domain seam wiring (issue #112): how a REAL wire result satisfies the
 * PURE `MessagingProvider` port, and the fail-closed consent boundary.
 *
 *   transport.dispatch(cmd) → Promise<SmsWireResult> → outcome value
 *     → preResolvedProvider(name, outcome)  (satisfies MessagingProvider)
 *     → attemptSend(...)                     (the pure ladder, unchanged)
 *
 * `withConsentRequirement` wraps any provider so a send whose consent probe
 * returns false is REFUSED at the boundary (`DUNNING_CONSENT_REQUIRED`) —
 * defence in depth behind the comms guard, never a replacement for it.
 */
import type { OutboundCommand, ProviderOutcome, MessagingProvider, RetryPolicy } from '../../domain/communications/provider';
import { DomainError } from '../../domain/shared';
import type { SmsWireResult, SmsTransport, SmsWireRequest } from './transports';
import { maskMsisdn } from './transports';

/**
 * Map a wire result to the domain's outcome value. `retryable` is transport
 * knowledge carried in the failure reason's machine-readable prefix — the
 * retry DECISION itself stays with the pure `decideRetry` policy.
 */
export const outcomeFromWireResult = (transport: SmsTransport, result: SmsWireResult): ProviderOutcome => {
  if (result.ok) {
    return { status: 'accepted', providerRef: result.providerRef };
  }
  const suffix = result.retryable ? ' [retryable]' : ' [permanent]';
  return { status: 'rejected', failureReason: `${result.failureReason}${suffix}` };
};

/**
 * Dispatch through a transport and resolve the outcome — the worker's async
 * half. MSISDNs in thrown errors are masked; transport refusals never throw.
 */
export const dispatchToOutcome = async (transport: SmsTransport, req: SmsWireRequest): Promise<ProviderOutcome> => {
  const result = await transport.dispatch(req);
  return outcomeFromWireResult(transport, result);
};

/**
 * A `MessagingProvider` whose `send` returns a PRE-RESOLVED outcome — the
 * edge wiring after the worker's async dispatch. Every send returns the same
 * outcome VALUE (the adapter stores nothing per message; the attempt ladder
 * is the domain's). The providerRef is already a real wire reference.
 */
export const preResolvedProvider = (name: string, outcome: ProviderOutcome): MessagingProvider => ({
  name,
  send(_cmd: OutboundCommand, _attemptNo: number): ProviderOutcome {
    return outcome;
  },
});

/** The consent probe: given the outbound command, is the send consented? */
export type ConsentProbe = (cmd: OutboundCommand) => boolean;

/**
 * Fail-closed consent boundary. A send without consent evidence is refused
 * with the domain's `DUNNING_CONSENT_REQUIRED` semantics — it NEVER falls
 * through to the wire. The probe is injected (the consent registry read
 * happens at the edge, outside the pure domain).
 */
export const withConsentRequirement = (provider: MessagingProvider, hasConsent: ConsentProbe): MessagingProvider => ({
  name: provider.name,
  send(cmd: OutboundCommand, attemptNo: number): ProviderOutcome {
    let consented: boolean;
    try {
      consented = hasConsent(cmd);
    } catch {
      consented = false; // a broken probe fails CLOSED
    }
    if (!consented) {
      return {
        status: 'rejected',
        failureReason: 'DUNNING_CONSENT_REQUIRED: no active grant covers this send (boundary refusal)',
      };
    }
    return provider.send(cmd, attemptNo);
  },
});

/**
 * Delivery status callback parsing (the inbound half of the rail). Twilio
 * posts form-encoded status callbacks; Africa's Talking posts JSON for
 * delivery reports. Both normalize to the same verdict VALUE, which the
 * worker applies through the pure `markDelivered` / message-failure paths.
 */
export type SmsCallbackVerdict =
  | { readonly kind: 'delivered'; readonly providerRef: string }
  | { readonly kind: 'failed'; readonly providerRef: string; readonly reason: string }
  | { readonly kind: 'sent'; readonly providerRef: string };

const asRecord = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  return payload as Record<string, unknown>;
};

/** Parse a Twilio status callback payload (form-encoded string or object). */
export const parseTwilioStatusCallback = (payload: unknown): SmsCallbackVerdict | never => {
  let record: Record<string, unknown> | null;
  if (typeof payload === 'string') {
    // form-encoded body — parse without URLSearchParams (ambient surface is minimal)
    const pairs: Record<string, string> = {};
    for (const piece of payload.split('&')) {
      if (piece === '') continue;
      const eq = piece.indexOf('=');
      const key = eq === -1 ? piece : piece.slice(0, eq);
      const value = eq === -1 ? '' : piece.slice(eq + 1);
      pairs[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '));
    }
    record = pairs;
  } else {
    record = asRecord(payload);
  }
  const sid = record?.MessageSid ?? record?.Sid;
  const status = record?.MessageStatus ?? record?.status;
  if (typeof sid !== 'string' || sid === '') {
    throw new DomainError('SMS_CALLBACK_MALFORMED', 'twilio status callback carries no MessageSid');
  }
  if (typeof status !== 'string') {
    throw new DomainError('SMS_CALLBACK_MALFORMED', 'twilio status callback carries no MessageStatus');
  }
  switch (status) {
    case 'delivered':
    case 'read':
      return { kind: 'delivered', providerRef: sid };
    case 'sent':
      return { kind: 'sent', providerRef: sid };
    case 'undelivered':
    case 'failed':
      return {
        kind: 'failed',
        providerRef: sid,
        reason: typeof record?.ErrorMessage === 'string' ? record.ErrorMessage : `TWILIO_${status.toUpperCase()}`,
      };
    case 'queued':
    case 'accepted':
      // intermediate states — not a delivery fact yet; the caller ignores them
      return { kind: 'sent', providerRef: sid };
    default:
      throw new DomainError('SMS_CALLBACK_MALFORMED', `unknown twilio MessageStatus "${status}"`);
  }
};

/**
 * Parse an Africa's Talking delivery report. AT's report JSON carries
 * `phoneNumbers`/`status`/`messageId` per recipient; the numeric mask keeps
 * any embedded MSISDN out of logs.
 */
export const parseAfricasTalkingDeliveryReport = (payload: unknown): SmsCallbackVerdict | never => {
  const record = asRecord(payload);
  const messageId = record?.messageId;
  if (typeof messageId !== 'string' || messageId === '') {
    throw new DomainError('SMS_CALLBACK_MALFORMED', "africastalking delivery report carries no 'messageId'");
  }
  const status = typeof record?.status === 'string' ? record.status : '';
  switch (status) {
    case 'Success':
      return { kind: 'delivered', providerRef: messageId };
    case 'Failed':
      return { kind: 'failed', providerRef: messageId, reason: 'AT_DELIVERY_FAILED' };
    default:
      throw new DomainError('SMS_CALLBACK_MALFORMED', `unknown africastalking status "${status}"`);
  }
};

export { maskMsisdn };

/**
 * Policy selection per failure class: a PERMANENT refusal (invalid recipient,
 * auth, blacklisted) must NOT ride the retry ladder — retrying it wastes
 * attempts and delays the terminal dead-letter. The worker derives the
 * attempt policy from the wire result: permanent → maxAttempts 1 (immediate
 * terminal), retryable → the org's standard ladder. The pure ladder itself is
 * unchanged; this only picks WHICH policy the caller hands attemptSend.
 */
export const policyForWireResult = (
  result: SmsWireResult,
  standard: RetryPolicy,
): RetryPolicy => (result.ok || result.retryable ? standard : { ...standard, maxAttempts: 1, backoffStepsMs: [] });
