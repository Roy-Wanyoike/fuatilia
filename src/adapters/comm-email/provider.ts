/**
 * The domain seam wiring (issue #127): how a REAL wire result satisfies the
 * PURE `MessagingProvider` port, and the fail-closed consent boundary — the
 * email mirror of `src/adapters/comm-sms/provider.ts`.
 *
 *   transport.dispatch(cmd) → Promise<EmailWireResult> → outcome value
 *     → preResolvedProvider(name, outcome)  (satisfies MessagingProvider)
 *     → attemptSend(...)                     (the pure ladder, unchanged)
 *
 * `withConsentRequirement` wraps any provider so a send whose consent probe
 * returns false is REFUSED at the boundary (`DUNNING_CONSENT_REQUIRED`) —
 * defence in depth behind the comms guard, never a replacement for it.
 */
import type { OutboundCommand, ProviderOutcome, MessagingProvider, RetryPolicy } from '../../domain/communications/provider';
import { DomainError } from '../../domain/shared';
import type { EmailWireResult, EmailWireRequest, EmailTransport } from './transports';
import { maskEmail } from './transports';

/**
 * Map a wire result to the domain's outcome value. `retryable` is transport
 * knowledge carried in the failure reason's machine-readable prefix — the
 * retry DECISION itself stays with the pure `decideRetry` policy.
 */
export const outcomeFromWireResult = (result: EmailWireResult): ProviderOutcome => {
  if (result.ok) {
    return { status: 'accepted', providerRef: result.providerRef };
  }
  const suffix = result.retryable ? ' [retryable]' : ' [permanent]';
  return { status: 'rejected', failureReason: `${result.failureReason}${suffix}` };
};

/**
 * Dispatch through a transport and resolve the outcome — the worker's async
 * half. Recipient addresses in thrown errors are masked; transport refusals
 * never throw (the transport classifies every failure into a VALUE).
 */
export const dispatchToOutcome = async (transport: EmailTransport, req: EmailWireRequest): Promise<ProviderOutcome> => {
  const result = await transport.dispatch(req);
  return outcomeFromWireResult(result);
};

/**
 * A `MessagingProvider` whose `send` returns a PRE-RESOLVED outcome — the
 * edge wiring after the worker's async dispatch. Every send returns the same
 * outcome VALUE (the adapter stores nothing per message; the attempt ladder
 * is the domain's). The providerRef is already a real wire reference (the
 * bracketed Message-ID the relay accepted).
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
 * Delivery status callback parsing (the inbound half of the rail). SMTP
 * acceptance is only an acceptance-for-RELAY; the delivery fact arrives
 * asynchronously as a Delivery Status Notification (RFC 3464). The worker
 * extracts the machine-readable DSN fields and hands them here; both
 * normalize to the same verdict VALUE, which the worker applies through the
 * pure `markDelivered` / message-failure paths.
 */
export type EmailCallbackVerdict =
  | { readonly kind: 'delivered'; readonly providerRef: string }
  | { readonly kind: 'failed'; readonly providerRef: string; readonly reason: string }
  | { readonly kind: 'sent'; readonly providerRef: string };

const asRecord = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  return payload as Record<string, unknown>;
};

/** RFC 3464 enhanced status code (e.g. 5.1.1, 4.2.2). */
const ENHANCED_STATUS = /^\d\.\d{1,3}\.\d{1,3}$/;

/**
 * Parse a DSN projection. `delayed` is NOT a delivery fact (the relay is
 * still working — mirrors the intermediate queued/accepted verdicts in
 * comm-sms). Diagnostic-Code text is deliberately NOT embedded in the
 * refusal: diagnostics quote recipient addresses, so the reason carries only
 * the machine status (`EMAIL_DSN_FAILED_5.1.1`) — redaction-safe metadata.
 */
export const parseDeliveryStatusNotification = (payload: unknown): EmailCallbackVerdict => {
  const record = asRecord(payload);
  const messageId = record?.messageId;
  if (typeof messageId !== 'string' || messageId === '') {
    throw new DomainError('EMAIL_CALLBACK_MALFORMED', "DSN carries no 'messageId'");
  }
  const action = typeof record?.action === 'string' ? record.action : '';
  switch (action) {
    case 'delivered':
      return { kind: 'delivered', providerRef: messageId };
    case 'delayed':
      // still in the relay's queue — not a terminal fact; the caller ignores it
      return { kind: 'sent', providerRef: messageId };
    case 'failed': {
      const status = typeof record?.status === 'string' && record.status !== '' ? record.status : '0.0.0';
      if (!ENHANCED_STATUS.test(status)) {
        throw new DomainError('EMAIL_CALLBACK_MALFORMED', `DSN status "${status}" is not an enhanced status code`);
      }
      return { kind: 'failed', providerRef: messageId, reason: `EMAIL_DSN_FAILED_${status}` };
    }
    default:
      throw new DomainError('EMAIL_CALLBACK_MALFORMED', `unknown DSN action "${action}"`);
  }
};

export { maskEmail };

/**
 * Policy selection per failure class: a PERMANENT refusal (unknown mailbox,
 * auth, policy rejection) must NOT ride the retry ladder — retrying it wastes
 * attempts and delays the terminal dead-letter. The worker derives the
 * attempt policy from the wire result: permanent → maxAttempts 1 (immediate
 * terminal), retryable → the org's standard ladder. The pure ladder itself is
 * unchanged; this only picks WHICH policy the caller hands attemptSend.
 */
export const policyForWireResult = (
  result: EmailWireResult,
  standard: RetryPolicy,
): RetryPolicy => (result.ok || result.retryable ? standard : { ...standard, maxAttempts: 1, backoffStepsMs: [] });
