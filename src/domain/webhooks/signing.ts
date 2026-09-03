/**
 * Signing contract (issue #47, SPEC §53) — PURE.
 *
 * The domain owns the CANONICAL-STRING contract and the decision semantics;
 * the HMAC-SHA256 computation itself stays behind an INJECTED DIGEST PORT so
 * this module never imports a crypto library and tests use a fake
 * deterministic digest. The canonical string is:
 *
 *     `<unixMillis>.<payload>`
 *
 * The wire header is `t=<unixMillis>,v1=<lowercase-hex>`.
 *
 * verifySignature returns a DECISION VALUE distinguishing MALFORMED
 * (unparseable header), STALE_TIMESTAMP (outside the ±maxSkewMs clock-skew
 * window — replay protection) and MISMATCH (digest comparison failed);
 * VERIFIED otherwise. Check order is pinned: MALFORMED → STALE_TIMESTAMP →
 * MISMATCH.
 *
 * Replay protection is idempotent (R9-style): verifyDeliverySignature keys
 * decisions by (endpointId, deliveryId) in an injected immutable ledger — a
 * replay returns the SAME decision without recomputing; a replayed rejection
 * re-emits webhook.signatureRejected with replay: true so the audit trail
 * records the repeat attempt, and a replayed VERIFIED stays silent.
 */
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import { signatureRejectedEvent, webhookNow } from './events';
import type { SignatureRejectReason, SignatureRejectedPayload, WebhookEvent } from './events';

/** The injected digest port — adapters bind HMAC-SHA256 here, the domain stays pure. */
export type DigestPort = (canonical: string, secret: string) => string;

/** Clock-skew window for replay protection (inclusive on both edges). */
export const DEFAULT_MAX_SKEW_MS = 300_000; // 5 minutes
export const MIN_SIGNATURE_CHARS = 16;
export const MAX_SIGNATURE_CHARS = 256;

export interface WebhookSignature {
  readonly timestampMs: number;
  readonly signature: string;
}

/** The canonical-string contract: what the digest actually covers. */
export const canonicalString = (timestampMs: number, payload: string): string => `${timestampMs}.${payload}`;

const assertTimestamp = (timestampMs: number): void => {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) {
    throw new DomainError(
      'WEBHOOK_TIMESTAMP_INVALID',
      `signature timestamp must be a non-negative safe integer (unix millis), got ${String(timestampMs)}`,
    );
  }
};

/**
 * Sign a payload: digest over the canonical string `timestamp + "." + payload`
 * with the endpoint secret. Pure — the digest port is injected.
 */
export const sign = (payload: string, secret: string, timestampMs: number, digest: DigestPort): WebhookSignature => {
  assertTimestamp(timestampMs);
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new DomainError('WEBHOOK_PAYLOAD_REQUIRED', 'signing requires a non-empty payload');
  }
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new DomainError('WEBHOOK_SECRET_REQUIRED', 'signing requires the endpoint secret');
  }
  return { timestampMs, signature: digest(canonicalString(timestampMs, payload), secret) };
};

/** Wire format: `t=<unixMillis>,v1=<lowercase-hex>`. */
export const formatSignatureHeader = (sig: WebhookSignature): string => `t=${sig.timestampMs},v1=${sig.signature}`;

const HEADER_PATTERN = new RegExp(`^t=(\\d{1,19}),v1=([0-9a-f]{${MIN_SIGNATURE_CHARS},${MAX_SIGNATURE_CHARS}})$`);

export type ParsedSignatureHeader =
  | { readonly ok: true; readonly signature: WebhookSignature }
  | { readonly ok: false; readonly detail: string };

/** Total parser — never throws, feeds the MALFORMED decision. */
export const parseSignatureHeader = (header: string): ParsedSignatureHeader => {
  const match = typeof header === 'string' ? HEADER_PATTERN.exec(header) : null;
  if (!match) {
    return { ok: false, detail: `expected "t=<unixMillis>,v1=<${MIN_SIGNATURE_CHARS}-${MAX_SIGNATURE_CHARS} lowercase hex chars>"` };
  }
  const timestampMs = Number(match[1]);
  if (!Number.isSafeInteger(timestampMs)) {
    return { ok: false, detail: 'timestamp is outside the safe integer range' };
  }
  return { ok: true, signature: { timestampMs, signature: match[2]! } };
};

export type SignatureDecision =
  | { readonly decision: 'VERIFIED' }
  | { readonly decision: 'MISMATCH'; readonly detail: string }
  | { readonly decision: 'STALE_TIMESTAMP'; readonly detail: string }
  | { readonly decision: 'MALFORMED'; readonly detail: string };

export type SignatureDecisionKind = SignatureDecision['decision'];

export interface VerifySignatureArgs {
  /** Received signature header (`t=...,v1=...`). */
  readonly header: string;
  /** Raw received body — digested exactly as received, never re-serialized. */
  readonly payload: string;
  readonly secret: string;
  /** Verification instant (unix millis) — the adapter reads the clock. */
  readonly now: number;
  readonly digest: DigestPort;
  readonly maxSkewMs?: number; // default DEFAULT_MAX_SKEW_MS
}

/** The rejection kind of a decision, or null for VERIFIED. */
export const signatureRejectReason = (decision: SignatureDecision): SignatureRejectReason | null =>
  decision.decision === 'VERIFIED' ? null : decision.decision;

/** The rejection detail of a decision, or '' for VERIFIED (never leaks digests). */
export const signatureRejectDetail = (decision: SignatureDecision): string =>
  decision.decision === 'VERIFIED' ? '' : decision.detail;

/**
 * Verify a received signature. Decision table (order pinned):
 *   1. header does not parse                      → MALFORMED
 *   2. |now − timestamp| > maxSkewMs (inclusive)  → STALE_TIMESTAMP
 *   3. digest(canonical) ≠ received signature     → MISMATCH
 *   4. otherwise                                  → VERIFIED
 * Details never echo computed digests or secret material.
 */
export const verifySignature = (args: VerifySignatureArgs): SignatureDecision => {
  const maxSkewMs = args.maxSkewMs ?? DEFAULT_MAX_SKEW_MS;
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 0) {
    throw new DomainError(
      'WEBHOOK_SKEW_INVALID',
      `maxSkewMs must be a non-negative safe integer, got ${String(maxSkewMs)}`,
    );
  }
  const parsed = parseSignatureHeader(args.header);
  if (!parsed.ok) {
    return { decision: 'MALFORMED', detail: parsed.detail };
  }
  const skew = args.now - parsed.signature.timestampMs;
  if (Math.abs(skew) > maxSkewMs) {
    return {
      decision: 'STALE_TIMESTAMP',
      detail: `signature timestamp ${parsed.signature.timestampMs} is ${Math.abs(skew)}ms outside the ±${maxSkewMs}ms skew window (now ${args.now})`,
    };
  }
  const expected = args.digest(canonicalString(parsed.signature.timestampMs, args.payload), args.secret);
  if (expected !== parsed.signature.signature) {
    return { decision: 'MISMATCH', detail: 'computed digest does not match the received signature' };
  }
  return { decision: 'VERIFIED' };
};

/* ------------------------------------------------------------------ *
 * Idempotent per-delivery verification (replay-protection semantics)
 * ------------------------------------------------------------------ */

/** Prior decisions keyed by (endpointId, deliveryId) — immutable view. */
export type VerificationLedger = ReadonlyMap<string, SignatureDecision>;

/** The sticky key: one decision per (endpoint, delivery) — replays return it. */
export const verificationKey = (endpointId: Uuid, deliveryId: Uuid): string => `${endpointId}:${deliveryId}`;

export interface VerifyDeliveryArgs {
  readonly endpointId: Uuid;
  readonly deliveryId: Uuid;
  readonly header: string;
  readonly payload: string;
  readonly secret: string;
  readonly digest: DigestPort;
  readonly maxSkewMs?: number;
}

export interface DeliveryVerificationResult {
  /** The SAME decision value on replay (idempotent, R9-style). */
  readonly decision: SignatureDecision;
  readonly replay: boolean;
  /** NEW ledger (fresh copy) when a decision was recorded; same instance on replay. */
  readonly ledger: VerificationLedger;
  /** webhook.signatureRejected for rejections — including replays of rejections. */
  readonly events: readonly WebhookEvent<'webhook.signatureRejected', SignatureRejectedPayload>[];
}

/**
 * Verify a delivery's signature against the sticky ledger. First sight
 * computes + records the decision (fresh ledger copy); a (endpointId,
 * deliveryId) replay returns the SAME decision without recomputing.
 * Rejections — first sight AND replays — emit webhook.signatureRejected
 * (replay: true marks the repeat); VERIFIED never emits.
 */
export const verifyDeliverySignature = (
  ledger: VerificationLedger,
  args: VerifyDeliveryArgs,
  clock: Clock,
): DeliveryVerificationResult => {
  const key = verificationKey(args.endpointId, args.deliveryId);
  const previous = ledger.get(key);
  if (previous !== undefined) {
    const reason = signatureRejectReason(previous);
    return {
      decision: previous,
      replay: true,
      ledger,
      events:
        reason === null
          ? []
          : [
              signatureRejectedEvent(
                {
                  endpointId: args.endpointId,
                  deliveryId: args.deliveryId,
                  reason,
                  detail: signatureRejectDetail(previous),
                  replay: true,
                },
                clock,
              ),
            ],
    };
  }
  const now = webhookNow(clock).getTime();
  const decision = verifySignature({
    header: args.header,
    payload: args.payload,
    secret: args.secret,
    now,
    digest: args.digest,
    maxSkewMs: args.maxSkewMs,
  });
  const next = new Map(ledger);
  next.set(key, decision);
  const reason = signatureRejectReason(decision);
  return {
    decision,
    replay: false,
    ledger: next,
    events:
      reason === null
        ? []
        : [
            signatureRejectedEvent(
              {
                endpointId: args.endpointId,
                deliveryId: args.deliveryId,
                reason,
                detail: signatureRejectDetail(decision),
                replay: false,
              },
              clock,
            ),
          ],
  };
};
