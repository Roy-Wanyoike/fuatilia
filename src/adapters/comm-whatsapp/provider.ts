/**
 * The domain seam wiring (issue #128): how a REAL Cloud API wire result
 * satisfies the PURE `MessagingProvider` port, the fail-closed consent
 * boundary, and the INBOUND half of the rail — Meta webhook status
 * notifications (delivery + read receipts) parsed into verdicts.
 *
 *   transport.dispatch(cmd) → Promise<WhatsAppWireResult> → outcome value
 *     → preResolvedProvider(name, outcome)  (satisfies MessagingProvider)
 *     → attemptSend(...)                     (the pure ladder, unchanged)
 *
 *   webhook JSON → parseWhatsAppStatusWebhook → verdict VALUES
 *     → the worker applies them through the pure `markDelivered` /
 *       `markRead` / message-failure paths → comms.* structured events.
 *
 * `withConsentRequirement` wraps any provider so a send whose consent probe
 * returns false is REFUSED at the boundary (`DUNNING_CONSENT_REQUIRED`) —
 * defence in depth behind the comms guard, never a replacement for it.
 */
import { DomainError } from '../../domain/shared';
import type { OutboundCommand, ProviderOutcome, MessagingProvider, RetryPolicy } from '../../domain/communications/provider';
import type { WhatsAppTemplateSend, WhatsAppTransport, WhatsAppWireResult } from './transports';

/**
 * Map a wire result to the domain's outcome value. `retryable` is transport
 * knowledge carried in the failure reason's machine-readable prefix — the
 * retry DECISION itself stays with the pure `decideRetry` policy.
 */
export const outcomeFromWireResult = (result: WhatsAppWireResult): ProviderOutcome => {
  if (result.ok) {
    return { status: 'accepted', providerRef: result.providerRef };
  }
  const suffix = result.retryable ? ' [retryable]' : ' [permanent]';
  return { status: 'rejected', failureReason: `${result.failureReason}${suffix}` };
};

/**
 * Dispatch through a transport and resolve the outcome — the worker's async
 * half. Wire refusals never throw; only pre-I/O input validation
 * (unfixable phone, template name/language shape) throws `DomainError`,
 * mirroring the SMS lane.
 */
export const dispatchToOutcome = async (transport: WhatsAppTransport, req: WhatsAppTemplateSend): Promise<ProviderOutcome> => {
  const result = await transport.dispatch(req);
  return outcomeFromWireResult(result);
};

/**
 * A `MessagingProvider` whose `send` returns a PRE-RESOLVED outcome — the
 * edge wiring after the worker's async dispatch. Every send returns the same
 * outcome VALUE (the adapter stores nothing per message; the attempt ladder
 * is the domain's). The providerRef is already a real wire wamid.
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

// --- webhook status ingestion (the inbound half of the rail) ----------------------

/**
 * One Meta webhook status notification, normalized to a verdict VALUE the
 * worker can apply through the pure domain paths:
 *   - 'sent'      → informational (the send is already `sent` on accept);
 *   - 'delivered' → `markDelivered` → comms.messageDelivered;
 *   - 'read'      → `markRead` → comms.messageRead;
 *   - 'failed'    → the message-failure path → comms.messageFailed.
 */
export type WhatsAppStatusVerdict =
  | { readonly kind: 'sent'; readonly providerRef: string }
  | { readonly kind: 'delivered'; readonly providerRef: string }
  | { readonly kind: 'read'; readonly providerRef: string }
  | { readonly kind: 'failed'; readonly providerRef: string; readonly reason: string };

const asRecord = (payload: unknown): Record<string, unknown> | null => {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
};

/** Failure reason for a `failed` status: the shared taxonomy, never raw PII. */
const failureReasonFromErrors = (errors: unknown): string => {
  const first = Array.isArray(errors) ? asRecord(errors[0]) : null;
  const code = typeof first?.['code'] === 'number' ? first['code'] : 0;
  const message = typeof first?.['message'] === 'string' ? first['message'] : '';
  if (code === 190) return 'WA_AUTH_REJECTED';
  if (code === 131048) return 'WA_RATE_LIMITED';
  if (code === 131047) return 'WA_WINDOW_CLOSED';
  if (code === 131026) return 'WA_RECIPIENT_UNDELIVERABLE';
  if (code === 132000 || code === 132001) return 'WA_TEMPLATE_REJECTED';
  if (code !== 0) {
    const detail = message.trim() === '' ? '' : `: ${scrubLongDigitRuns(message)}`;
    const band = code >= 131000 && code <= 139999 ? 'WA_PROVIDER_REFUSED' : 'WA_PROVIDER_ERROR';
    return `${band}_${code}${detail}`;
  }
  return message.trim() === '' ? 'WA_STATUS_FAILED' : scrubLongDigitRuns(message);
};

/** Meta messages can embed the recipient's number — same discipline as send time. */
const scrubLongDigitRuns = (text: string): string => text.replace(/\d{6,}/g, '****');

const parseStatusEntry = (item: unknown): WhatsAppStatusVerdict | null => {
  const status = asRecord(item);
  const id = status?.['id'];
  if (typeof id !== 'string' || id === '') {
    throw new DomainError('WA_CALLBACK_MALFORMED', "whatsapp status carries no 'id'");
  }
  const state = status?.['status'];
  if (typeof state !== 'string') {
    throw new DomainError('WA_CALLBACK_MALFORMED', "whatsapp status carries no 'status'");
  }
  switch (state) {
    case 'sent':
      return { kind: 'sent', providerRef: id };
    case 'delivered':
      return { kind: 'delivered', providerRef: id };
    case 'read':
      return { kind: 'read', providerRef: id };
    case 'failed':
      return { kind: 'failed', providerRef: id, reason: failureReasonFromErrors(status?.['errors']) };
    case 'deleted':
      // well-formed, but not a delivery fact this lane acts on — filtered out
      return null;
    default:
      throw new DomainError('WA_CALLBACK_MALFORMED', `unknown whatsapp status "${state}"`);
  }
};

/**
 * Parse the status notifications out of a Meta Cloud API webhook payload.
 * The envelope is untrusted: the canonical shape is
 * `{ object, entry: [{ changes: [{ value: { statuses: [...] } }] }] }`.
 * A payload without a `statuses` array (e.g. an inbound-message
 * notification) yields NO verdicts — nothing is invented; malformed status
 * entries throw `WA_CALLBACK_MALFORMED` so the worker dead-letters the
 * webhook for review instead of guessing.
 */
export const parseWhatsAppStatusWebhook = (payload: unknown): readonly WhatsAppStatusVerdict[] => {
  const record = asRecord(payload);
  if (record === null) {
    throw new DomainError('WA_CALLBACK_MALFORMED', 'whatsapp webhook payload is not an object');
  }
  const entries = record['entry'];
  if (!Array.isArray(entries)) {
    throw new DomainError('WA_CALLBACK_MALFORMED', "whatsapp webhook payload carries no 'entry' array");
  }
  const verdicts: WhatsAppStatusVerdict[] = [];
  for (const entry of entries) {
    const changes = asRecord(entry)?.['changes'];
    if (!Array.isArray(changes)) {
      throw new DomainError('WA_CALLBACK_MALFORMED', "whatsapp webhook entry carries no 'changes' array");
    }
    for (const change of changes) {
      const statuses = asRecord(asRecord(change)?.['value'])?.['statuses'];
      if (!Array.isArray(statuses)) continue; // e.g. inbound-message notifications — nothing to ingest
      for (const item of statuses) {
        const verdict = parseStatusEntry(item);
        if (verdict !== null) verdicts.push(verdict);
      }
    }
  }
  return verdicts;
};

export { scrubLongDigitRuns };

/**
 * Policy selection per failure class: a PERMANENT refusal (template
 * rejection, auth, window closed, undeliverable recipient) must NOT ride the
 * retry ladder — retrying it wastes attempts and delays the terminal
 * dead-letter. The worker derives the attempt policy from the wire result:
 * permanent → maxAttempts 1 (immediate terminal), retryable (rate limit
 * 131048, outage, network) → the org's standard ladder. The pure ladder
 * itself is unchanged; this only picks WHICH policy the caller hands
 * attemptSend.
 */
export const policyForWireResult = (
  result: WhatsAppWireResult,
  standard: RetryPolicy,
): RetryPolicy => (result.ok || result.retryable ? standard : { ...standard, maxAttempts: 1, backoffStepsMs: [] });
