package webhooks

// Pure (no-database) tests for the worker's building blocks: the canonical
// envelope shape, the attempt classification and the config resolution.

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// --- BuildCanonicalEnvelope -------------------------------------------------

func TestBuildCanonicalEnvelopePinsFieldOrder(t *testing.T) {
	// attempts.spec.ts 'canonicalEnvelope keeps insertion order stable (the
	// signed shape)' — the JSON keys appear in exactly this order.
	occurredAt := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	body := string(BuildCanonicalEnvelope("payment.confirmed",
		"00000000-0000-4000-8000-000000000702", "00000000-0000-4000-8000-000000000701",
		occurredAt, []byte(`{"paymentId":"pay_1"}`)))
	order := []string{`"name"`, `"version"`, `"aggregateId"`, `"orgId"`, `"occurredAt"`, `"payload"`}
	last := -1
	for _, frag := range order {
		i := strings.Index(body, frag)
		if i < 0 {
			t.Fatalf("envelope missing %s: %s", frag, body)
		}
		if i < last {
			t.Fatalf("field order drifted at %s: %s", frag, body)
		}
		last = i
	}
}

func TestBuildCanonicalEnvelopeContract(t *testing.T) {
	// The envelope contract: name = event type, version = 1,
	// aggregateId = the EVENT id (the payload contract receivers dedupe on),
	// occurredAt in JS toISOString form, payload byte-verbatim.
	occurredAt := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	const payload = `{"amountMinor": 125050, "note": "Wanjikũ"}`
	body := string(BuildCanonicalEnvelope("payment.confirmed",
		"ev-uuid", "org-uuid", occurredAt, []byte(payload)))
	want := `{"name":"payment.confirmed","version":1,"aggregateId":"ev-uuid","orgId":"org-uuid",` +
		`"occurredAt":"2026-03-01T08:00:00.000Z","payload":` + payload + `}`
	if body != want {
		t.Fatalf("envelope drifted:\n got %s\nwant %s", body, want)
	}
}

func TestBuildCanonicalEnvelopeEscapesEventType(t *testing.T) {
	// event_type is free-form text from the database — it must be strictly
	// JSON-escaped (the envelope stays valid JSON for any row).
	body := string(BuildCanonicalEnvelope("payment.\"quoted\"\n", "ev", "org",
		time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC), []byte(`{}`)))
	if !strings.Contains(body, `"name":"payment.\"quoted\"\n"`) {
		t.Fatalf("event type not escaped: %s", body)
	}
}

func TestMillisecondISOFormat(t *testing.T) {
	// JS toISOString(): exactly three fraction digits, Z suffix.
	got := MillisecondISO(time.Date(2026, 3, 1, 8, 0, 0, 123456789, time.UTC))
	if got != "2026-03-01T08:00:00.123Z" {
		t.Fatalf("MillisecondISO = %s", got)
	}
}

// --- classifyAttempt ---------------------------------------------------------

func TestClassifyAttemptMapsAllWireResults(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		err        error
		want       AttemptOutcome
		wantReason string
	}{
		{"2xx succeeds", 200, nil, AttemptOutcome{Success: true}, ""},
		{"201 succeeds", 201, nil, AttemptOutcome{Success: true}, ""},
		{"204 succeeds", 204, nil, AttemptOutcome{Success: true}, ""},
		{"4xx fails with status", 404, nil, AttemptOutcome{Success: false}, "endpoint returned http 404"},
		{"5xx fails with status", 500, nil, AttemptOutcome{Success: false}, "endpoint returned http 500"},
		{"3xx fails (redirects never followed)", 302, nil, AttemptOutcome{Success: false}, "endpoint returned http 302"},
		{"network error carries the cause", 0, errors.New("dial tcp: connect: connection refused"), AttemptOutcome{Success: false}, "transport error: dial tcp: connect: connection refused"},
		{"timeout is named", 0, context.DeadlineExceeded, AttemptOutcome{Success: false}, "delivery timed out"},
	}
	for _, tc := range cases {
		got := classifyAttempt(tc.status, tc.err)
		if got.Success != tc.want.Success {
			t.Fatalf("%s: success = %v, want %v", tc.name, got.Success, tc.want.Success)
		}
		if got.Reason != tc.wantReason {
			t.Fatalf("%s: reason = %q, want %q", tc.name, got.Reason, tc.wantReason)
		}
	}
}

func TestClassifyAttemptFailureKindsShareTheLadder(t *testing.T) {
	// Ladder parity: attempts.ts does not branch on the failure kind — a 4xx,
	// a 5xx and a network error must produce the IDENTICAL schedule (only the
	// reason differs). Pinned here so a future classification never drifts.
	ladder := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	kinds := []AttemptOutcome{
		{Reason: "endpoint returned http 404"},
		{Reason: "endpoint returned http 500"},
		{Reason: "transport error: connection refused"},
		{Reason: "delivery timed out"},
	}
	for _, kind := range kinds {
		_, decision, err := RecordAttemptOutcome(begin(fixtureDelivery()), kind, ladder, T0)
		if err != nil {
			t.Fatalf("%s: record: %v", kind.Reason, err)
		}
		want := T0.Add(10 * time.Millisecond)
		if !decision.WillRetry || decision.NextAttemptAt == nil || !decision.NextAttemptAt.Equal(want) {
			t.Fatalf("%s: schedule drifted: %+v, want retry at %v", kind.Reason, decision, want)
		}
	}
}

// --- ResolveConfig -----------------------------------------------------------

func TestResolveConfigFillsDefaults(t *testing.T) {
	cfg, err := ResolveConfig(Config{})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if cfg.PollInterval != DefaultPollInterval || cfg.DeliveryTimeout != DefaultDeliveryTimeout || cfg.ClaimLease != DefaultClaimLease {
		t.Fatalf("defaults drifted: %+v", cfg)
	}
	if len(cfg.Ladder) != len(DefaultRetryLadder) {
		t.Fatalf("ladder default drifted: %v", cfg.Ladder)
	}
	if cfg.Clock == nil || cfg.Logger == nil {
		t.Fatal("clock and logger must default to the production ports")
	}
}

func TestResolveConfigRefusals(t *testing.T) {
	negative := -time.Second
	if _, err := ResolveConfig(Config{PollInterval: negative}); !isCode(err, CodeConfigInvalid) {
		t.Fatalf("negative poll interval: %v", err)
	}
	if _, err := ResolveConfig(Config{DeliveryTimeout: negative}); !isCode(err, CodeConfigInvalid) {
		t.Fatalf("negative delivery timeout: %v", err)
	}
	// A lease shorter than the delivery timeout would steal in-flight claims.
	if _, err := ResolveConfig(Config{DeliveryTimeout: 10 * time.Second, ClaimLease: time.Second}); !isCode(err, CodeConfigInvalid) {
		t.Fatalf("lease below timeout: %v", err)
	}
	if _, err := ResolveConfig(Config{Ladder: []time.Duration{time.Second, time.Second}}); !isCode(err, CodeRetryLadderInvalid) {
		t.Fatalf("flat ladder: %v", err)
	}
}
