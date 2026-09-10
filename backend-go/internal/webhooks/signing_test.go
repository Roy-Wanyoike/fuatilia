package webhooks

// Signature-parity suite (acceptance criterion 1): the test vectors of
// src/domain/webhooks/signing.spec.ts ported 1:1 into Go table tests. The
// deterministic fake digest below is the SPEC's own fake (the domain never
// imports crypto; the production binding is HMACSHA256, stdlib), so every
// expected value here is byte-identical to the TS spec's.
//
// Source of truth: src/domain/webhooks/signing.ts + signing.spec.ts.

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// fakeDigest ports the signing.spec.ts deterministic digest:
//
//	let h = 0; const input = `${secret}::${canonical}`;
//	for (i…) h = (h * 31 + input.charCodeAt(i)) % 0xffffffff;
//	return h.toString(16).padStart(8, '0').repeat(4);
//
// charCodeAt yields UTF-16 code units, so the port encodes through utf16 —
// byte-identical on every input, not just ASCII.
func fakeDigest(canonical, secret string) string {
	h := uint64(0)
	for _, unit := range utf16.Encode([]rune(secret + "::" + canonical)) {
		h = (h*31 + uint64(unit)) % 0xffffffff
	}
	return fmt.Sprintf("%08x%08x%08x%08x", h, h, h, h) // 32 lowercase hex chars
}

// Spec fixtures (signing.spec.ts).
const (
	specEndpointID = "00000000-0000-4000-8000-000000000601" // uid(601)
	specDeliveryID = "00000000-0000-4000-8000-000000000602" // uid(602)
	specSecret     = "sk_whx_0123456789abcdef0123456789abcdef"
	specPayload    = `{"name":"payment.confirmed","version":1}`
)

var specNowMs = time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC).UnixMilli() // T0

// signedHeader ports the spec's signedHeader() helper: sign with the fake
// digest and format the wire header.
func signedHeader(t *testing.T, payload string, timestampMs int64, secret string) string {
	t.Helper()
	sig, err := Sign(payload, secret, timestampMs, fakeDigest)
	if err != nil {
		t.Fatalf("fixture sign: %v", err)
	}
	return FormatSignatureHeader(sig)
}

func mustSign(t *testing.T, payload, secret string, timestampMs int64) WebhookSignature {
	t.Helper()
	sig, err := Sign(payload, secret, timestampMs, fakeDigest)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return sig
}

// --- canonicalString + sign (the pure signing contract) -------------------

func TestCanonicalStringIsUnixMillisDotPayload(t *testing.T) {
	// 'canonical string is `<unixMillis>.<payload>`'
	got := CanonicalString(1700000000000, specPayload)
	if got != "1700000000000."+specPayload {
		t.Fatalf("canonical string drifted: %q", got)
	}
}

func TestSignRunsDigestOverCanonicalString(t *testing.T) {
	// 'sign runs the injected digest over the canonical string'
	sig := mustSign(t, specPayload, specSecret, specNowMs)
	if sig.TimestampMs != specNowMs {
		t.Fatalf("timestampMs = %d, want %d", sig.TimestampMs, specNowMs)
	}
	if want := fakeDigest(CanonicalString(specNowMs, specPayload), specSecret); sig.Signature != want {
		t.Fatalf("signature = %s, want %s", sig.Signature, want)
	}
	if header := FormatSignatureHeader(sig); header != fmt.Sprintf("t=%d,v1=%s", specNowMs, sig.Signature) {
		t.Fatalf("header = %s, want t=%d,v1=<sig>", header, specNowMs)
	}
}

func TestSignValidationTable(t *testing.T) {
	// 'validation table' — negative timestamps refuse; the TS spec's 1.5
	// case is unrepresentable here (int64), and empty payload/secret refuse.
	if _, err := Sign(specPayload, specSecret, -1, fakeDigest); !isCode(err, CodeTimestampInvalid) {
		t.Fatalf("negative timestamp: got %v, want %s", err, CodeTimestampInvalid)
	}
	if _, err := Sign("", specSecret, specNowMs, fakeDigest); !isCode(err, CodePayloadRequired) {
		t.Fatalf("empty payload: got %v, want %s", err, CodePayloadRequired)
	}
	if _, err := Sign(specPayload, "", specNowMs, fakeDigest); !isCode(err, CodeSecretRequired) {
		t.Fatalf("empty secret: got %v, want %s", err, CodeSecretRequired)
	}
}

// --- parseSignatureHeader (total parser, never throws) --------------------

func TestParseSignatureHeaderWellFormed(t *testing.T) {
	// 'parses a well-formed header'
	sig, ok := ParseSignatureHeader(fmt.Sprintf("t=%d,v1=%s", specNowMs, strings.Repeat("a", 32)))
	if !ok {
		t.Fatal("well-formed header refused")
	}
	if sig.TimestampMs != specNowMs || sig.Signature != strings.Repeat("a", 32) {
		t.Fatalf("parsed {%d %s}, want {%d %s}", sig.TimestampMs, sig.Signature, specNowMs, strings.Repeat("a", 32))
	}
}

func TestParseSignatureHeaderMalformedTable(t *testing.T) {
	// 'malformed header table' — every row must refuse.
	cases := []string{
		"",
		"t=abc,v1=x",
		fmt.Sprintf("t=%d,v1=%s", specNowMs, strings.Repeat("A", 32)), // uppercase hex
		fmt.Sprintf("t=%d,v1=%s", specNowMs, strings.Repeat("a", 15)), // < 16 chars
		fmt.Sprintf("t=%d,v1=short", specNowMs),
		"v1=abcdef,t=1", // reordered
	}
	for _, header := range cases {
		if sig, ok := ParseSignatureHeader(header); ok {
			t.Fatalf("header %q parsed as {%d %s}, want refusal", header, sig.TimestampMs, sig.Signature)
		}
	}
}

func TestParseSignatureHeaderUnsafeTimestampRefuses(t *testing.T) {
	// 19 digits can exceed the JS safe-integer bound — the TS parser returns
	// not-ok ("timestamp is outside the safe integer range"); the Go parser
	// must refuse identically (a TS receiver could never see this instant).
	if _, ok := ParseSignatureHeader("t=9999999999999999999,v1=" + strings.Repeat("a", 32)); ok {
		t.Fatal("timestamp beyond 2^53-1 must refuse")
	}
	if _, ok := ParseSignatureHeader("t=" + fmt.Sprint(maxSafeInteger) + ",v1=" + strings.Repeat("a", 32)); !ok {
		t.Fatal("timestamp exactly 2^53-1 must parse")
	}
}

// --- verifySignature (decision table, order pinned) ------------------------

func TestVerifySignatureVerified(t *testing.T) {
	// 'VERIFIED when everything matches inside the skew window'
	decision, err := VerifySignature(VerifySignatureArgs{
		Header:  signedHeader(t, specPayload, specNowMs, specSecret),
		Payload: specPayload, Secret: specSecret, NowMs: specNowMs, Digest: fakeDigest,
	})
	if err != nil || decision.Decision != DecisionVerified {
		t.Fatalf("decision = %+v err = %v, want VERIFIED", decision, err)
	}
}

func TestVerifySignatureMalformedFirst(t *testing.T) {
	// 'MALFORMED first — an unparseable header never reaches the digest'
	decision, err := VerifySignature(VerifySignatureArgs{
		Header: "garbage", Payload: specPayload, Secret: specSecret, NowMs: specNowMs, Digest: fakeDigest,
	})
	if err != nil || decision.Decision != DecisionMalformed {
		t.Fatalf("decision = %+v err = %v, want MALFORMED", decision, err)
	}
}

func TestVerifySignatureStaleTimestampBoundariesInclusive(t *testing.T) {
	// 'STALE_TIMESTAMP — outside the ±skew window, checked before the digest
	// (boundaries inclusive)': the +maxSkew edge VERIFIES, one millisecond
	// past it on either side is STALE.
	args := VerifySignatureArgs{
		Header:  signedHeader(t, specPayload, specNowMs, specSecret),
		Payload: specPayload, Secret: specSecret, Digest: fakeDigest,
	}
	atEdge, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret, Digest: args.Digest,
		NowMs: specNowMs + DefaultMaxSkewMs})
	if err != nil || atEdge.Decision != DecisionVerified {
		t.Fatalf("inclusive edge: decision = %+v err = %v, want VERIFIED", atEdge, err)
	}
	past, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret, Digest: args.Digest,
		NowMs: specNowMs + DefaultMaxSkewMs + 1})
	if err != nil || past.Decision != DecisionStaleTimestamp {
		t.Fatalf("past edge: decision = %+v err = %v, want STALE_TIMESTAMP", past, err)
	}
	before, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret, Digest: args.Digest,
		NowMs: specNowMs - DefaultMaxSkewMs - 1})
	if err != nil || before.Decision != DecisionStaleTimestamp {
		t.Fatalf("future edge: decision = %+v err = %v, want STALE_TIMESTAMP", before, err)
	}
}

func TestVerifySignatureMismatchNonLeakingDetail(t *testing.T) {
	// 'MISMATCH — wrong payload or wrong secret, with a non-leaking detail'
	args := VerifySignatureArgs{Header: signedHeader(t, specPayload, specNowMs, specSecret),
		Secret: specSecret, NowMs: specNowMs, Digest: fakeDigest}
	wrongPayload, err := VerifySignature(VerifySignatureArgs{Header: args.Header,
		Payload: `{"name":"payment.identified"}`, Secret: args.Secret, NowMs: args.NowMs, Digest: args.Digest})
	if err != nil || wrongPayload.Decision != DecisionMismatch {
		t.Fatalf("wrong payload: %+v err = %v, want MISMATCH", wrongPayload, err)
	}
	wrongSecret, err := VerifySignature(VerifySignatureArgs{Header: args.Header,
		Payload: specPayload, Secret: "sk_whx_ffffffffffffffffffffffffffffffff", NowMs: args.NowMs, Digest: args.Digest})
	if err != nil || wrongSecret.Decision != DecisionMismatch {
		t.Fatalf("wrong secret: %+v err = %v, want MISMATCH", wrongSecret, err)
	}
	if leaked := fakeDigest(CanonicalString(specNowMs, specPayload), specSecret); strings.Contains(wrongSecret.Detail, leaked) {
		t.Fatal("MISMATCH detail leaks the computed digest")
	}
	if strings.Contains(wrongSecret.Detail, specSecret) {
		t.Fatal("MISMATCH detail leaks the secret")
	}
}

func TestVerifySignatureCustomSkewWindow(t *testing.T) {
	// 'a custom skew window is honored and validated'
	skew := int64(1000)
	args := VerifySignatureArgs{Header: signedHeader(t, specPayload, specNowMs, specSecret),
		Payload: specPayload, Secret: specSecret, Digest: fakeDigest, MaxSkewMs: &skew}
	ok, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret,
		Digest: args.Digest, MaxSkewMs: args.MaxSkewMs, NowMs: specNowMs + 1000})
	if err != nil || ok.Decision != DecisionVerified {
		t.Fatalf("at custom edge: %+v err = %v, want VERIFIED", ok, err)
	}
	stale, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret,
		Digest: args.Digest, MaxSkewMs: args.MaxSkewMs, NowMs: specNowMs + 1001})
	if err != nil || stale.Decision != DecisionStaleTimestamp {
		t.Fatalf("past custom edge: %+v err = %v, want STALE_TIMESTAMP", stale, err)
	}
	negative := int64(-1)
	if _, err := VerifySignature(VerifySignatureArgs{Header: args.Header, Payload: args.Payload, Secret: args.Secret,
		Digest: args.Digest, MaxSkewMs: &negative, NowMs: specNowMs}); !isCode(err, CodeSkewInvalid) {
		t.Fatalf("negative skew: got %v, want %s", err, CodeSkewInvalid)
	}
}

// --- verifyDeliverySignature (idempotent replay protection, R9-style) ------

func deliveryArgs(header string) VerifyDeliveryArgs {
	return VerifyDeliveryArgs{
		EndpointID: specEndpointID,
		DeliveryID: specDeliveryID,
		Header:     header,
		Payload:    specPayload,
		Secret:     specSecret,
		Digest:     fakeDigest,
	}
}

func TestVerifyDeliveryFirstSightRecordsAndEmits(t *testing.T) {
	// 'first sight computes and records the decision; rejections emit
	// signatureRejected'
	result, err := VerifyDeliverySignature(VerificationLedger{}, deliveryArgs("garbage"), specNowMs)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if result.Replay {
		t.Fatal("first sight must not be a replay")
	}
	if result.Decision.Decision != DecisionMalformed {
		t.Fatalf("decision = %s, want MALFORMED", result.Decision.Decision)
	}
	if len(result.Events) != 1 {
		t.Fatalf("events = %d, want 1", len(result.Events))
	}
	event := result.Events[0]
	if event.EndpointID != specEndpointID || event.DeliveryID != specDeliveryID ||
		event.Reason != DecisionMalformed || event.Replay {
		t.Fatalf("signatureRejected payload drifted: %+v", event)
	}
	if event.Detail == "" {
		t.Fatal("rejection detail must be present")
	}
	if got := result.Ledger[VerificationKey(specEndpointID, specDeliveryID)]; got.Decision != DecisionMalformed {
		t.Fatalf("ledger decision = %+v, want MALFORMED", got)
	}
}

func TestVerifyDeliveryReplayReturnsSameDecisionWithoutRecomputing(t *testing.T) {
	// 'a replay returns the SAME decision without recomputing — and
	// re-audits with replay: true'
	first, err := VerifyDeliverySignature(VerificationLedger{}, deliveryArgs("garbage"), specNowMs)
	if err != nil {
		t.Fatalf("first verify: %v", err)
	}
	replay, err := VerifyDeliverySignature(first.Ledger, deliveryArgs("garbage"), specNowMs)
	if err != nil {
		t.Fatalf("replay verify: %v", err)
	}
	if !replay.Replay {
		t.Fatal("second sight must be a replay")
	}
	if replay.Decision != first.Decision {
		t.Fatalf("replay decision %+v != first %+v", replay.Decision, first.Decision)
	}
	// TS pins `replay.ledger).toBe(first.ledger)` — the same instance, not a copy.
	if fmt.Sprintf("%p", replay.Ledger) != fmt.Sprintf("%p", first.Ledger) {
		t.Fatal("replay must return the identical ledger instance")
	}
	if len(replay.Events) != 1 || !replay.Events[0].Replay {
		t.Fatalf("replayed rejection must re-audit with replay:true, got %+v", replay.Events)
	}
}

func TestVerifyDeliveryReplayedVerifiedStaysSilent(t *testing.T) {
	// 'a replayed VERIFIED stays silent (no event)'
	first, err := VerifyDeliverySignature(VerificationLedger{}, deliveryArgs(signedHeader(t, specPayload, specNowMs, specSecret)), specNowMs)
	if err != nil {
		t.Fatalf("first verify: %v", err)
	}
	if first.Decision.Decision != DecisionVerified || len(first.Events) != 0 {
		t.Fatalf("first sight = %+v events %d, want VERIFIED and silence", first.Decision, len(first.Events))
	}
	replay, err := VerifyDeliverySignature(first.Ledger, deliveryArgs("t=1,v1=deadbeefdeadbeef"), specNowMs)
	if err != nil {
		t.Fatalf("replay verify: %v", err)
	}
	if !replay.Replay || replay.Decision.Decision != DecisionVerified || len(replay.Events) != 0 {
		t.Fatalf("replay = %+v, want silent VERIFIED replay", replay)
	}
}

func TestVerifyDeliveryDecisionsStickyPerEndpointDelivery(t *testing.T) {
	// 'decisions are sticky per (endpointId, deliveryId) — different
	// deliveries verify independently'
	first, err := VerifyDeliverySignature(VerificationLedger{}, deliveryArgs("garbage"), specNowMs)
	if err != nil {
		t.Fatalf("first verify: %v", err)
	}
	other := deliveryArgs(signedHeader(t, specPayload, specNowMs, specSecret))
	other.DeliveryID = "00000000-0000-4000-8000-000000000604" // uid(604)
	result, err := VerifyDeliverySignature(first.Ledger, other, specNowMs)
	if err != nil {
		t.Fatalf("other delivery verify: %v", err)
	}
	if result.Replay {
		t.Fatal("a different deliveryId is never a replay")
	}
	if result.Decision.Decision != DecisionVerified {
		t.Fatalf("decision = %s, want VERIFIED", result.Decision.Decision)
	}
}

func TestVerifyDeliveryInputLedgerNeverMutated(t *testing.T) {
	// 'the ledger passed in is never mutated (no-mutation pin)'
	ledger := VerificationLedger{}
	if _, err := VerifyDeliverySignature(ledger, deliveryArgs(signedHeader(t, specPayload, specNowMs, specSecret)), specNowMs); err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(ledger) != 0 {
		t.Fatalf("input ledger mutated: %d entries", len(ledger))
	}
}

func TestVerifyDeliveryClockDrivesStaleness(t *testing.T) {
	// 'the verification clock comes from the injected clock (ORG context
	// sanity)': signed 1h before "now" — outside the ±5min window.
	header := signedHeader(t, specPayload, time.Date(2026, 3, 1, 7, 0, 0, 0, time.UTC).UnixMilli(), specSecret)
	result, err := VerifyDeliverySignature(VerificationLedger{}, deliveryArgs(header), specNowMs)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if result.Decision.Decision != DecisionStaleTimestamp {
		t.Fatalf("decision = %s, want STALE_TIMESTAMP", result.Decision.Decision)
	}
}

// --- the production digest (stdlib HMAC-SHA256) ----------------------------

func TestHMACSHA256KnownVector(t *testing.T) {
	// RFC 4231-style vector: key "key", message "The quick brown fox jumps
	// over the lazy dog".
	const want = "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
	if got := HMACSHA256("The quick brown fox jumps over the lazy dog", "key"); got != want {
		t.Fatalf("HMACSHA256 = %s, want %s", got, want)
	}
}

func TestProductionSignVerifyRoundTrip(t *testing.T) {
	// The wire discipline end to end with the PRODUCTION digest: sign →
	// format → parse → verify decision table.
	sig, err := Sign(specPayload, specSecret, specNowMs, HMACSHA256)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	header := FormatSignatureHeader(sig)
	parsed, ok := ParseSignatureHeader(header)
	if !ok || parsed.TimestampMs != specNowMs || parsed.Signature != sig.Signature {
		t.Fatalf("round-trip parse drifted: %v %v", parsed, ok)
	}
	if len(sig.Signature) != 64 || strings.ToLower(sig.Signature) != sig.Signature {
		t.Fatalf("production digest must be 64 lowercase hex chars, got %q", sig.Signature)
	}
	decision, err := VerifySignature(VerifySignatureArgs{Header: header, Payload: specPayload,
		Secret: specSecret, NowMs: specNowMs, Digest: HMACSHA256})
	if err != nil || decision.Decision != DecisionVerified {
		t.Fatalf("verified round trip: %+v err = %v", decision, err)
	}
	tampered, err := VerifySignature(VerifySignatureArgs{Header: header,
		Payload: specPayload + " ", Secret: specSecret, NowMs: specNowMs, Digest: HMACSHA256})
	if err != nil || tampered.Decision != DecisionMismatch {
		t.Fatalf("tampered round trip: %+v err = %v, want MISMATCH", tampered, err)
	}
}

// isCode reports whether err is the package Error with the given machine code.
func isCode(err error, code string) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	return e.Code == code
}
