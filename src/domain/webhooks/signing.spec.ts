import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  DEFAULT_MAX_SKEW_MS,
  canonicalString,
  formatSignatureHeader,
  parseSignatureHeader,
  sign,
  verifyDeliverySignature,
  verifySignature,
  type DigestPort,
  type VerificationLedger,
} from './signing';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ENDPOINT = uid(601);
const DELIVERY = uid(602);
const ORG = uid(603);
const T0 = '2026-03-01T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

/** Deterministic fake digest — the domain never imports crypto. */
const digest: DigestPort = (canonical, secret) => {
  let h = 0;
  const input = `${secret}::${canonical}`;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) % 0xffffffff;
  }
  return h.toString(16).padStart(8, '0').repeat(4); // 32 lowercase hex chars
};

const SECRET = 'sk_whx_0123456789abcdef0123456789abcdef';
const PAYLOAD = '{"name":"payment.confirmed","version":1}';
const NOW_MS = Date.parse(T0);

const signedHeader = (payload = PAYLOAD, timestampMs = NOW_MS, secret = SECRET): string =>
  formatSignatureHeader(sign(payload, secret, timestampMs, digest));

// --- the contract ---------------------------------------------------------------

describe('canonicalString + sign — the pure signing contract', () => {
  it('canonical string is `<unixMillis>.<payload>`', () => {
    expect(canonicalString(1700000000000, PAYLOAD)).toBe(`1700000000000.${PAYLOAD}`);
  });

  it('sign runs the injected digest over the canonical string', () => {
    const sig = sign(PAYLOAD, SECRET, NOW_MS, digest);
    expect(sig.timestampMs).toBe(NOW_MS);
    expect(sig.signature).toBe(digest(canonicalString(NOW_MS, PAYLOAD), SECRET));
    expect(formatSignatureHeader(sig)).toBe(`t=${NOW_MS},v1=${sig.signature}`);
  });

  it('validation table', () => {
    expect(() => sign(PAYLOAD, SECRET, -1, digest)).toThrow(DomainError);
    expect(() => sign(PAYLOAD, SECRET, 1.5, digest)).toThrow(DomainError);
    expect(() => sign('', SECRET, NOW_MS, digest)).toThrow(DomainError);
    expect(() => sign(PAYLOAD, '', NOW_MS, digest)).toThrow(DomainError);
  });
});

describe('parseSignatureHeader — total parser (never throws)', () => {
  it('parses a well-formed header', () => {
    const parsed = parseSignatureHeader(`t=${NOW_MS},v1=${'a'.repeat(32)}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.signature.timestampMs).toBe(NOW_MS);
      expect(parsed.signature.signature).toBe('a'.repeat(32));
    }
  });

  it('malformed header table', () => {
    expect(parseSignatureHeader('').ok).toBe(false);
    expect(parseSignatureHeader('t=abc,v1=x').ok).toBe(false);
    expect(parseSignatureHeader(`t=${NOW_MS},v1=${'A'.repeat(32)}`).ok).toBe(false); // uppercase hex
    expect(parseSignatureHeader(`t=${NOW_MS},v1=${'a'.repeat(15)}`).ok).toBe(false); // < 16 chars
    expect(parseSignatureHeader(`t=${NOW_MS},v1=short`).ok).toBe(false);
    expect(parseSignatureHeader('v1=abcdef,t=1').ok).toBe(false);
  });
});

describe('verifySignature — decision table (order pinned)', () => {
  it('VERIFIED when everything matches inside the skew window', () => {
    const decision = verifySignature({
      header: signedHeader(),
      payload: PAYLOAD,
      secret: SECRET,
      now: NOW_MS,
      digest,
    });
    expect(decision.decision).toBe('VERIFIED');
  });

  it('MALFORMED first — an unparseable header never reaches the digest', () => {
    const decision = verifySignature({
      header: 'garbage',
      payload: PAYLOAD,
      secret: SECRET,
      now: NOW_MS,
      digest,
    });
    expect(decision.decision).toBe('MALFORMED');
  });

  it('STALE_TIMESTAMP — outside the ±skew window, checked before the digest (boundaries inclusive)', () => {
    const args = { header: signedHeader(), payload: PAYLOAD, secret: SECRET, digest };
    const atEdge = verifySignature({ ...args, now: NOW_MS + DEFAULT_MAX_SKEW_MS }); // inclusive edge
    expect(atEdge.decision).toBe('VERIFIED');
    const past = verifySignature({ ...args, now: NOW_MS + DEFAULT_MAX_SKEW_MS + 1 });
    expect(past.decision).toBe('STALE_TIMESTAMP');
    const before = verifySignature({ ...args, now: NOW_MS - DEFAULT_MAX_SKEW_MS - 1 });
    expect(before.decision).toBe('STALE_TIMESTAMP');
  });

  it('MISMATCH — wrong payload or wrong secret, with a non-leaking detail', () => {
    const wrongPayload = verifySignature({
      header: signedHeader(),
      payload: '{"name":"payment.identified"}',
      secret: SECRET,
      now: NOW_MS,
      digest,
    });
    expect(wrongPayload.decision).toBe('MISMATCH');
    const wrongSecret = verifySignature({
      header: signedHeader(),
      payload: PAYLOAD,
      secret: 'sk_whx_ffffffffffffffffffffffffffffffff',
      now: NOW_MS,
      digest,
    });
    expect(wrongSecret.decision).toBe('MISMATCH');
    if (wrongSecret.decision === 'MISMATCH') {
      expect(wrongSecret.detail).not.toContain(digest(canonicalString(NOW_MS, PAYLOAD), SECRET));
      expect(wrongSecret.detail).not.toContain(SECRET);
    }
  });

  it('a custom skew window is honored and validated', () => {
    const args = { header: signedHeader(), payload: PAYLOAD, secret: SECRET, digest, maxSkewMs: 1000 };
    expect(verifySignature({ ...args, now: NOW_MS + 1000 }).decision).toBe('VERIFIED');
    expect(verifySignature({ ...args, now: NOW_MS + 1001 }).decision).toBe('STALE_TIMESTAMP');
    expect(() => verifySignature({ ...args, now: NOW_MS, maxSkewMs: -1 })).toThrow(DomainError);
  });
});

describe('verifyDeliverySignature — idempotent replay protection (R9-style)', () => {
  const args = {
    endpointId: ENDPOINT,
    deliveryId: DELIVERY,
    payload: PAYLOAD,
    secret: SECRET,
    digest,
  };

  it('first sight computes and records the decision; rejections emit signatureRejected', () => {
    const result = verifyDeliverySignature(new Map(), { ...args, header: 'garbage' }, at(T0));
    expect(result.replay).toBe(false);
    expect(result.decision.decision).toBe('MALFORMED');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.name).toBe('webhook.signatureRejected');
    expect(result.events[0]!.payload).toEqual({
      endpointId: ENDPOINT,
      deliveryId: DELIVERY,
      reason: 'MALFORMED',
      detail: expect.any(String),
      replay: false,
    });
    expect(result.ledger.get(`${ENDPOINT}:${DELIVERY}`)?.decision).toBe('MALFORMED');
  });

  it('a replay returns the SAME decision without recomputing — and re-audits with replay: true', () => {
    const ledger: VerificationLedger = new Map();
    const first = verifyDeliverySignature(ledger, { ...args, header: 'garbage' }, at(T0));
    const replay = verifyDeliverySignature(first.ledger, { ...args, header: 'garbage' }, at(T0));
    expect(replay.replay).toBe(true);
    expect(replay.decision).toBe(first.decision);
    expect(replay.ledger).toBe(first.ledger); // unchanged on replay
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0]!.payload.replay).toBe(true);
  });

  it('a replayed VERIFIED stays silent (no event)', () => {
    const first = verifyDeliverySignature(new Map(), { ...args, header: signedHeader() }, at(T0));
    expect(first.decision.decision).toBe('VERIFIED');
    expect(first.events).toHaveLength(1 - 1);
    const replay = verifyDeliverySignature(first.ledger, { ...args, header: 't=1,v1=deadbeefdeadbeef' }, at(T0));
    expect(replay.replay).toBe(true);
    expect(replay.decision.decision).toBe('VERIFIED');
    expect(replay.events).toHaveLength(0);
  });

  it('decisions are sticky per (endpointId, deliveryId) — different deliveries verify independently', () => {
    const first = verifyDeliverySignature(new Map(), { ...args, header: 'garbage' }, at(T0));
    const other = verifyDeliverySignature(
      first.ledger,
      { ...args, deliveryId: uid(604), header: signedHeader() },
      at(T0),
    );
    expect(other.replay).toBe(false);
    expect(other.decision.decision).toBe('VERIFIED');
  });

  it('the ledger passed in is never mutated (no-mutation pin)', () => {
    const ledger: VerificationLedger = new Map();
    verifyDeliverySignature(ledger, { ...args, header: signedHeader() }, at(T0));
    expect(ledger.size).toBe(0);
  });

  it('the verification clock comes from the injected clock (ORG context sanity)', () => {
    const stale = verifyDeliverySignature(
      new Map(),
      { ...args, header: signedHeader(PAYLOAD, Date.parse('2026-03-01T07:00:00.000Z')) },
      at(T0), // 1h after the signature timestamp — outside ±5min
    );
    expect(stale.decision.decision).toBe('STALE_TIMESTAMP');
  });
});
