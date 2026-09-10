// Package webhooks is the Go webhook delivery worker (issue #91): it executes
// the pure TS attempt ladder (src/domain/webhooks/attempts.ts) against
// PostgreSQL (webhook_deliveries, db/migrations/0012) with HMAC-SHA256 signed
// HTTP POSTs whose wire contract is the one pinned by
// src/domain/webhooks/signing.ts.
//
// Delivery contract (full detail in README.md):
//
//   - At-least-once: claim-then-post-then-record. A delivery is claimed with
//     SELECT … FOR UPDATE SKIP LOCKED (row locks released at that commit,
//     strictly BEFORE the POST); the POST runs OUTSIDE any transaction; the
//     attempt record + ladder advance commit in ONE transaction afterwards.
//     A crash between POST and record leaves the row in `delivering` until
//     the claim lease expires, after which a fresh worker redelivers it —
//     receivers dedupe by event id (the aggregateId of the signed envelope).
//   - Ladder parity: willRetry = attemptNo <= len(ladder),
//     nextAttemptAt = now + ladder[attemptNo-1], exhaustion → dead-letter
//     terminal. The schedule lives in attempts.go (ported, single source).
//   - Signature parity: canonical string `<unixMillis>.<payload>`, header
//     value `t=<unixMillis>,v1=<lowercase hex>` over stdlib HMAC-SHA256.
//
// Signing secrets never come from the schema (0012 stores only hashes): the
// worker resolves them through the injected SigningKeys port — a KMS adapter
// is the production drop-in.
package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strconv"
)

// Error is the only error type this package produces: a stable machine code
// plus a human message — values, matched with errors.As and compared by Code,
// exactly like pkg/money, pkg/idempotency and internal/outbox.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Stable machine codes ported from the TS lanes (src/domain/webhooks — see
// that lane's README for the authoritative list).
const (
	CodeTimestampInvalid      = "WEBHOOK_TIMESTAMP_INVALID"
	CodePayloadRequired       = "WEBHOOK_PAYLOAD_REQUIRED"
	CodeSecretRequired        = "WEBHOOK_SECRET_REQUIRED"
	CodeSkewInvalid           = "WEBHOOK_SKEW_INVALID"
	CodeRetryLadderInvalid    = "WEBHOOK_RETRY_LADDER_INVALID"
	CodeDeliveryNotDelivering = "WEBHOOK_DELIVERY_NOT_DELIVERING"
	CodeFailureReasonRequired = "WEBHOOK_FAILURE_REASON_REQUIRED"
	CodeConfigInvalid         = "WEBHOOK_CONFIG_INVALID"
)

/* ------------------------------------------------------------------ *
 * Signing contract — ported from src/domain/webhooks/signing.ts.
 * The canonical string, the wire header format, the parser table and the
 * verify decision table below are the TS module's exact semantics; the TS
 * spec's test vectors are ported 1:1 into signing_test.go.
 * ------------------------------------------------------------------ */

// Clock-skew window for replay protection, inclusive on both edges
// (signing.ts DEFAULT_MAX_SKEW_MS).
const DefaultMaxSkewMs int64 = 300_000

// Bounds on the v1 signature hex (signing.ts MIN/MAX_SIGNATURE_CHARS).
const (
	MinSignatureChars = 16
	MaxSignatureChars = 256
)

// maxSafeInteger mirrors JavaScript's Number.isSafeInteger bound (2^53-1):
// the header's timestamp digits must survive the TS receiver's Number()
// round-trip, so the Go sender refuses anything a TS peer would see as
// unsafe.
const maxSafeInteger int64 = 1<<53 - 1

// DigestPort computes the signature digest over the canonical string with the
// endpoint secret — the injected digest seam. HMACSHA256 is the production
// binding; tests may inject deterministic fakes (as the TS spec does).
type DigestPort func(canonical, secret string) string

// HMACSHA256 is the production digest: stdlib HMAC-SHA256, lowercase hex.
func HMACSHA256(canonical, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

// WebhookSignature is a signed payload: the unix-millis timestamp that opens
// the canonical string plus the digest output.
type WebhookSignature struct {
	TimestampMs int64
	Signature   string
}

// CanonicalString is the signing contract: `<unixMillis>.<payload>` — what
// the digest actually covers (signing.ts canonicalString).
func CanonicalString(timestampMs int64, payload string) string {
	return strconv.FormatInt(timestampMs, 10) + "." + payload
}

// Sign a payload: digest over the canonical string `timestamp + "." + payload`
// with the endpoint secret. Validation order mirrors signing.ts sign():
// timestamp, then payload, then secret.
func Sign(payload, secret string, timestampMs int64, digest DigestPort) (WebhookSignature, error) {
	if timestampMs < 0 {
		// Go int64 cannot carry the TS spec's 1.5 case — non-integers are
		// unrepresentable at this seam; the header PARSER refuses digit
		// shapes that would not survive the receiver's safe-integer check.
		return WebhookSignature{}, &Error{Code: CodeTimestampInvalid,
			Message: fmt.Sprintf("signature timestamp must be a non-negative safe integer (unix millis), got %d", timestampMs)}
	}
	if payload == "" {
		return WebhookSignature{}, &Error{Code: CodePayloadRequired, Message: "signing requires a non-empty payload"}
	}
	if secret == "" {
		return WebhookSignature{}, &Error{Code: CodeSecretRequired, Message: "signing requires the endpoint secret"}
	}
	return WebhookSignature{TimestampMs: timestampMs, Signature: digest(CanonicalString(timestampMs, payload), secret)}, nil
}

// FormatSignatureHeader renders the wire format
// `t=<unixMillis>,v1=<lowercase-hex>` (signing.ts formatSignatureHeader).
func FormatSignatureHeader(sig WebhookSignature) string {
	return fmt.Sprintf("t=%d,v1=%s", sig.TimestampMs, sig.Signature)
}

// signatureHeaderPattern is signing.ts HEADER_PATTERN:
//
//	t=(1..19 digits),v1=(16..256 lowercase hex)
var signatureHeaderPattern = regexp.MustCompile(
	fmt.Sprintf(`^t=(\d{1,19}),v1=([0-9a-f]{%d,%d})$`, MinSignatureChars, MaxSignatureChars))

// ParseSignatureHeader is the TOTAL parser (never throws, feeds the MALFORMED
// decision): a well-formed header yields the signature and true; anything
// else — empty, reordered, uppercase hex, wrong lengths, unsafe timestamp —
// yields false. Ported from signing.ts parseSignatureHeader, including the
// safe-integer guard on the timestamp digits.
func ParseSignatureHeader(header string) (WebhookSignature, bool) {
	m := signatureHeaderPattern.FindStringSubmatch(header)
	if m == nil {
		return WebhookSignature{}, false
	}
	timestampMs, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || timestampMs > maxSafeInteger {
		// 19 digits can overflow int64 or exceed Number.isSafeInteger — the
		// TS parser rejects both with the same outcome.
		return WebhookSignature{}, false
	}
	return WebhookSignature{TimestampMs: timestampMs, Signature: m[2]}, true
}

/* ------------------------------------------------------------------ *
 * Verify decision table — ported from signing.ts verifySignature.
 * ------------------------------------------------------------------ */

// DecisionKind is the rejection-or-success discriminant of a verification.
type DecisionKind string

const (
	DecisionVerified       DecisionKind = "VERIFIED"
	DecisionMismatch       DecisionKind = "MISMATCH"
	DecisionStaleTimestamp DecisionKind = "STALE_TIMESTAMP"
	DecisionMalformed      DecisionKind = "MALFORMED"
)

// SignatureDecision is the decision VALUE. Check order is pinned in
// VerifySignature: MALFORMED → STALE_TIMESTAMP → MISMATCH. Details never echo
// computed digests or secret material.
type SignatureDecision struct {
	Decision DecisionKind
	Detail   string
}

// RejectionReason reports the rejection kind, false for VERIFIED
// (signing.ts signatureRejectReason).
func (d SignatureDecision) RejectionReason() (DecisionKind, bool) {
	if d.Decision == DecisionVerified {
		return "", false
	}
	return d.Decision, true
}

// RejectionDetail returns the non-leaking detail, "" for VERIFIED
// (signing.ts signatureRejectDetail).
func (d SignatureDecision) RejectionDetail() string {
	if d.Decision == DecisionVerified {
		return ""
	}
	return d.Detail
}

// VerifySignatureArgs carries the received header/payload plus the context
// needed to judge them. MaxSkewMs nil falls back to DefaultMaxSkewMs (the TS
// `maxSkewMs ?? DEFAULT_MAX_SKEW_MS` semantics — an explicit 0 is honored).
type VerifySignatureArgs struct {
	Header    string
	Payload   string
	Secret    string
	NowMs     int64
	Digest    DigestPort
	MaxSkewMs *int64
}

// VerifySignature judges a received signature. Decision table (order pinned,
// ported from signing.ts verifySignature):
//
//  1. header does not parse                      → MALFORMED
//  2. |now − timestamp| > maxSkewMs (inclusive)  → STALE_TIMESTAMP
//  3. digest(canonical) ≠ received signature     → MISMATCH
//  4. otherwise                                  → VERIFIED
//
// The error return fires only for a broken skew configuration (the TS
// DomainError) — never for a rejected signature, which is a VALUE.
func VerifySignature(args VerifySignatureArgs) (SignatureDecision, error) {
	maxSkewMs := DefaultMaxSkewMs
	if args.MaxSkewMs != nil {
		maxSkewMs = *args.MaxSkewMs
	}
	if maxSkewMs < 0 {
		return SignatureDecision{}, &Error{Code: CodeSkewInvalid,
			Message: fmt.Sprintf("maxSkewMs must be a non-negative safe integer, got %d", maxSkewMs)}
	}
	parsed, ok := ParseSignatureHeader(args.Header)
	if !ok {
		return SignatureDecision{Decision: DecisionMalformed,
			Detail: fmt.Sprintf("expected \"t=<unixMillis>,v1=<%d-%d lowercase hex chars>\"", MinSignatureChars, MaxSignatureChars)}, nil
	}
	skew := args.NowMs - parsed.TimestampMs
	if skew < 0 {
		skew = -skew
	}
	if skew > maxSkewMs {
		return SignatureDecision{Decision: DecisionStaleTimestamp,
			Detail: fmt.Sprintf("signature timestamp %d is %dms outside the ±%dms skew window (now %d)",
				parsed.TimestampMs, skew, maxSkewMs, args.NowMs)}, nil
	}
	expected := args.Digest(CanonicalString(parsed.TimestampMs, args.Payload), args.Secret)
	// hmac.Equal is a constant-time byte comparison — the same MISMATCH
	// decision as the TS `!==`, without a timing side channel.
	if !hmac.Equal([]byte(expected), []byte(parsed.Signature)) {
		return SignatureDecision{Decision: DecisionMismatch,
			Detail: "computed digest does not match the received signature"}, nil
	}
	return SignatureDecision{Decision: DecisionVerified}, nil
}

/* ------------------------------------------------------------------ *
 * Idempotent per-delivery verification — ported from signing.ts
 * verifyDeliverySignature (the sticky replay ledger, R9-style).
 * ------------------------------------------------------------------ */

// VerificationLedger records prior decisions keyed by (endpointId,
// deliveryId) — the injected, immutable-from-the-caller's-view map.
type VerificationLedger map[string]SignatureDecision

// VerificationKey is the sticky key: one decision per (endpoint, delivery).
func VerificationKey(endpointID, deliveryID string) string {
	return endpointID + ":" + deliveryID
}

// SignatureRejected is the audit fact a rejection emits — including replays
// of rejections (replay: true marks the repeat). VERIFIED never emits.
type SignatureRejected struct {
	EndpointID string
	DeliveryID string
	Reason     DecisionKind
	Detail     string
	Replay     bool
}

// VerifyDeliveryArgs identifies the delivery being verified.
type VerifyDeliveryArgs struct {
	EndpointID string
	DeliveryID string
	Header     string
	Payload    string
	Secret     string
	Digest     DigestPort
	MaxSkewMs  *int64
}

// DeliveryVerificationResult is the outcome of a sticky verification: the
// SAME decision on replay, whether it was a replay, the (fresh-copy) ledger
// when a decision was recorded, and the signatureRejected audit events.
type DeliveryVerificationResult struct {
	Decision SignatureDecision
	Replay   bool
	Ledger   VerificationLedger
	Events   []SignatureRejected
}

// VerifyDeliverySignature verifies a delivery's signature against the sticky
// ledger. First sight computes + records the decision (fresh ledger copy); a
// (endpointId, deliveryId) replay returns the SAME decision without
// recomputing. Rejections — first sight AND replays — emit
// webhook.signatureRejected; VERIFIED never emits. Ported 1:1 from
// signing.ts verifyDeliverySignature.
func VerifyDeliverySignature(ledger VerificationLedger, args VerifyDeliveryArgs, nowMs int64) (DeliveryVerificationResult, error) {
	key := VerificationKey(args.EndpointID, args.DeliveryID)
	if previous, hit := ledger[key]; hit {
		result := DeliveryVerificationResult{Decision: previous, Replay: true, Ledger: ledger}
		if reason, rejected := previous.RejectionReason(); rejected {
			result.Events = []SignatureRejected{{
				EndpointID: args.EndpointID,
				DeliveryID: args.DeliveryID,
				Reason:     reason,
				Detail:     previous.RejectionDetail(),
				Replay:     true,
			}}
		}
		return result, nil
	}
	decision, err := VerifySignature(VerifySignatureArgs{
		Header:    args.Header,
		Payload:   args.Payload,
		Secret:    args.Secret,
		NowMs:     nowMs,
		Digest:    args.Digest,
		MaxSkewMs: args.MaxSkewMs,
	})
	if err != nil {
		return DeliveryVerificationResult{}, err
	}
	next := make(VerificationLedger, len(ledger)+1)
	for k, v := range ledger {
		next[k] = v
	}
	next[key] = decision
	result := DeliveryVerificationResult{Decision: decision, Replay: false, Ledger: next}
	if reason, rejected := decision.RejectionReason(); rejected {
		result.Events = []SignatureRejected{{
			EndpointID: args.EndpointID,
			DeliveryID: args.DeliveryID,
			Reason:     reason,
			Detail:     decision.RejectionDetail(),
			Replay:     false,
		}}
	}
	return result, nil
}
