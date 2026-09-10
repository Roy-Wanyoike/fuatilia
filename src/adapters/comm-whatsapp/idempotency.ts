/**
 * Wire-layer idempotency for the WhatsApp lane (issue #128, R9 discipline for
 * comms) — mirrors `../comm-sms/idempotency.ts`. The crash window between
 * "the Cloud API ACCEPTED the send" and "the worker persisted the wamid"
 * must never re-charge the provider call. A durable store records (key →
 * wire result); the wrapper replays the recorded result for a repeated key
 * INSTEAD of dispatching.
 *
 * Concurrency + crash semantics:
 *   - the FIRST caller reserves the key with an IN_FLIGHT placeholder, pays
 *     the wire call, then records the real result;
 *   - a concurrent follower sees the placeholder and is refused
 *     (`WA_IN_FLIGHT` — the worker replays later, R9);
 *   - a follower after the winner recorded sees the REAL result and replays
 *     it unchanged (same wamid — the same-outcome guarantee);
 *   - a crash BEFORE recording leaves a placeholder that goes STALE — the
 *     lease (default 5 minutes) makes it reclaimable so a crashed dispatch
 *     never wedges a message forever. Production stores implement the lease
 *     in SQL (claimed_at < now() - lease); the in-memory store takes an
 *     injectable clock for tests.
 *
 * The key composes over the NORMALIZED wa_id, so `+254712345678` and
 * `0712345678` replay to the same key — the discipline is E.164 canonical
 * end to end. Unfixable phones are refused BEFORE a reservation is claimed,
 * so a malformed dispatch can never leak a placeholder into the store.
 */
import { DomainError } from '../../domain/shared';
import { normalizeKenyanPhone, type WhatsAppTemplateSend, type WhatsAppTransport, type WhatsAppWireResult } from './transports';

const IN_FLIGHT = 'IN_FLIGHT';
const DEFAULT_LEASE_MS = 5 * 60 * 1000;

/** The durable record of dispatched wire calls. */
export interface WhatsAppDispatchStore {
  /**
   * Reserve-or-read: records an in-flight reservation unless a live record
   * exists, returning whether THIS call won plus the recorded result when
   * it did not. Implementations MUST be atomic (unique constraint / INSERT
   * ON CONFLICT with lease handling) so concurrent workers with one key
   * produce exactly one wire call.
   */
  claim(key: string): { won: boolean; recorded: WhatsAppWireResult | null };
  /** The winner records the real result after the wire call resolves. */
  record(key: string, result: WhatsAppWireResult): void;
}

interface Entry {
  readonly result: WhatsAppWireResult;
  readonly reservedAt: number;
  readonly placeholder: boolean;
}

/** In-memory store (tests + fakes). `now` is injectable for lease tests. */
export const inMemoryWhatsAppDispatchStore = (options: { readonly now?: () => number; readonly leaseMs?: number } = {}): WhatsAppDispatchStore => {
  const now = options.now ?? Date.now;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const entries = new Map<string, Entry>();
  return {
    claim(key) {
      const prior = entries.get(key);
      if (prior !== undefined) {
        const stale = prior.placeholder && now() - prior.reservedAt > leaseMs;
        if (!stale) return { won: false, recorded: prior.result };
      }
      const placeholder: Entry = { result: { ok: false, failureReason: IN_FLIGHT, retryable: true }, reservedAt: now(), placeholder: true };
      entries.set(key, placeholder);
      return { won: true, recorded: null };
    },
    record(key, result) {
      entries.set(key, { result, reservedAt: now(), placeholder: false });
    },
  };
};

/**
 * Compose the wire idempotency key. Stable across retries of the SAME
 * message-lifecycle: messageId + attemptNo (each attempt is its own
 * chargeable provider call, so the key is per-attempt, not per-message).
 * The worker carries the clientRef as `"<messageId>#<attemptNo>"`. The
 * destination is normalized to the canonical E.164 wa_id first — an
 * unfixable phone throws `WA_MSISDN_MALFORMED` here, before any claim.
 */
export const whatsappDispatchKey = (req: WhatsAppTemplateSend, clientRef: string): string => {
  const parts = clientRef.split('#');
  const messageId = parts[0] ?? '';
  const attemptNo = Number(parts[1] ?? 0);
  if (messageId.trim() === '' || !Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new DomainError('WA_IDEMPOTENCY_KEY_INVALID', `clientRef must be "<messageId>#<attemptNo>", got "${clientRef}"`);
  }
  return `wa:${normalizeKenyanPhone(req.to)}:${messageId}:${attemptNo}`;
};

/**
 * Wrap a transport with the durable key. The clientRef travels on the
 * request as `"<messageId>#<attemptNo>"`; a request without one is refused
 * (the worker ALWAYS has both — a dispatch that cannot be keyed is one that
 * cannot be made safe, so it does not happen).
 */
export const withWireIdempotency = (transport: WhatsAppTransport, store: WhatsAppDispatchStore): WhatsAppTransport => ({
  name: transport.name,
  async dispatch(req: WhatsAppTemplateSend): Promise<WhatsAppWireResult> {
    if (req.clientRef === undefined || req.clientRef === '') {
      throw new DomainError('WA_IDEMPOTENCY_KEY_REQUIRED', 'a dispatch without a clientRef cannot be made idempotent — refuse, never guess');
    }
    const key = whatsappDispatchKey(req, req.clientRef);
    const probe = store.claim(key);
    if (!probe.won) {
      const recorded = probe.recorded;
      if (recorded === null) {
        throw new DomainError('WA_IDEMPOTENCY_STORE_INVALID', 'claim lost but no recorded result — store is not atomic');
      }
      if (!recorded.ok && recorded.failureReason === IN_FLIGHT) {
        throw new DomainError('WA_IN_FLIGHT', `dispatch ${key} is in flight — replay after it resolves (R9)`);
      }
      return recorded;
    }
    const result = await transport.dispatch(req);
    store.record(key, result);
    return result;
  },
});
