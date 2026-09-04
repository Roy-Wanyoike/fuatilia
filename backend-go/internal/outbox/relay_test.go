package outbox

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestResolveConfigDefaultsAndRefusals(t *testing.T) {
	t.Run("zero config falls back to documented defaults", func(t *testing.T) {
		cfg, err := ResolveConfig(Config{})
		if err != nil {
			t.Fatalf("zero config must resolve: %v", err)
		}
		if cfg.BatchSize != DefaultBatchSize || cfg.PollInterval != DefaultPollInterval || cfg.MaxAttempts != DefaultMaxAttempts {
			t.Fatalf("defaults not applied: %+v", cfg)
		}
		if cfg.Logger == nil {
			t.Fatal("nil logger must default to slog.Default()")
		}
	})
	t.Run("explicit values survive", func(t *testing.T) {
		cfg, err := ResolveConfig(Config{BatchSize: 7, PollInterval: 3 * time.Second, MaxAttempts: 2, Logger: slog.New(slog.DiscardHandler)})
		if err != nil {
			t.Fatalf("explicit config refused: %v", err)
		}
		if cfg.BatchSize != 7 || cfg.MaxAttempts != 2 {
			t.Fatalf("explicit config mutated: %+v", cfg)
		}
	})
	t.Run("invalid values refuse with OUTBOX_CONFIG_INVALID", func(t *testing.T) {
		for name, cfg := range map[string]Config{
			"negative batch":    {BatchSize: -1},
			"negative poll":     {PollInterval: -time.Second},
			"zero max attempts": {MaxAttempts: -5},
		} {
			_, err := ResolveConfig(cfg)
			var oerr *Error
			if !errors.As(err, &oerr) || oerr.Code != CodeConfigInvalid {
				t.Fatalf("%s: err = %v, want %s", name, err, CodeConfigInvalid)
			}
		}
	})
}

func TestRelayPublishesAppendedEventsAndMarksPublished(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "relay-basic")
	appendEvent(t, pool, org, "11111111-1111-4111-8111-111111111111", "payment.confirmed", 1, `{"amountMinor":125050,"receipt":"SBK41XQ7RT"}`, time.Now())
	appendEvent(t, pool, org, "22222222-2222-4222-8222-222222222222", "invoicing.invoiceIssued", 1, `{"invoiceNumber":"INV-0001"}`, time.Now())

	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	got := drainStream(t, js)
	expectCount(t, got, "fuatilia.payment.confirmed.v1", 1, "publish")
	expectCount(t, got, "fuatilia.invoicing.invoiceIssued.v1", 1, "publish")

	// Envelope fidelity: org/event/version round-trip exactly, and the payload
	// equals the jsonb column's canonical text BYTE FOR BYTE (the verbatim
	// contract — asserted against the DB, not against the insert literal).
	env := got["fuatilia.payment.confirmed.v1"][0]
	if env.EventID != "11111111-1111-4111-8111-111111111111" || env.OrgID != org || env.Version != 1 {
		t.Fatalf("envelope identity drifted: %+v", env)
	}
	if want := payloadOf(t, pool, "11111111-1111-4111-8111-111111111111"); string(env.Payload) != want {
		t.Fatalf("payload was re-encoded — must be verbatim jsonb text:\n got %s\nwant %s", env.Payload, want)
	}
	if _, err := time.Parse(time.RFC3339Nano, env.CreatedAt); err != nil {
		t.Fatalf("createdAt not RFC3339: %v", err)
	}

	// Mark: both rows published, no backlog left.
	var published, pending int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='published'`).Scan(&published); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if published != 2 || pending != 0 {
		t.Fatalf("marks wrong: published=%d pending=%d", published, pending)
	}
}

func TestRelayPreservesPerOrgOrderAcrossEvents(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "relay-order")
	base := time.Now().Add(-time.Hour)

	// 25 events with strictly increasing created_at; the subject must carry
	// them in append order. Single-key payloads keep jsonb canonical text
	// stable, so the seq round-trip is directly assertable.
	for i := 0; i < 25; i++ {
		eventID := formatUUID(i + 1)
		appendEvent(t, pool, org, eventID, "receivable.partiallySettled", 1,
			`{"seq": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}
	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	got := drainStream(t, js)
	msgs := got["fuatilia.receivable.partiallySettled.v1"]
	if len(msgs) != 25 {
		t.Fatalf("published %d, want 25", len(msgs))
	}
	for i, env := range msgs {
		if string(env.Payload) != `{"seq": `+itoa(i)+`}` {
			t.Fatalf("order broken at %d: payload %s", i, env.Payload)
		}
	}
}

func TestRelayIsolatesOrgsButDrainsAll(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	orgA := testOrg(t, pool, "relay-org-a")
	orgB := testOrg(t, pool, "relay-org-b")
	appendEvent(t, pool, orgA, "33333333-3333-4333-8333-333333333331", "payment.initiated", 1, `{"org":"a"}`, time.Now())
	appendEvent(t, pool, orgB, "33333333-3333-4333-8333-333333333332", "payment.initiated", 1, `{"org":"b"}`, time.Now())

	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	got := drainStream(t, js)
	expectCount(t, got, "fuatilia.payment.initiated.v1", 2, "both orgs")
	envA, envB := got["fuatilia.payment.initiated.v1"][0], got["fuatilia.payment.initiated.v1"][1]
	if envA.OrgID == envB.OrgID || (envA.OrgID != orgA && envA.OrgID != orgB) {
		t.Fatalf("org identity missing from envelopes: %+v %+v", envA, envB)
	}
}

func TestRelayBatchLimitLeavesRemainderPending(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "relay-batch")
	base := time.Now().Add(-time.Hour)
	for i := 1; i <= 7; i++ {
		appendEvent(t, pool, org, formatUUID(i), "allocation.executed", 1, `{"n": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}
	relay := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 3 })
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	var pending int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 4 {
		t.Fatalf("pending after batch of 3 over 7 rows = %d, want 4", pending)
	}
	// Second cycle drains the remainder; per-org order still holds.
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce 2: %v", err)
	}
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce 3: %v", err)
	}
	got := drainStream(t, js)
	msgs := got["fuatilia.allocation.executed.v1"]
	if len(msgs) != 7 {
		t.Fatalf("total published %d, want 7", len(msgs))
	}
	for i, env := range msgs {
		if string(env.Payload) != `{"n": `+itoa(i+1)+`}` {
			t.Fatalf("cross-batch order broken at %d: %s", i, env.Payload)
		}
	}
}

func TestRelayRunOnceLogsCycleWithLag(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "relay-lag")
	appendEvent(t, pool, org, "44444444-4444-4444-8444-444444444441", "payment.failed", 1, `{"why":"C116"}`, time.Now())

	var buf logBuffer
	relay := newTestRelay(t, pool, js, func(c *Config) { c.Logger = slog.New(slog.NewJSONHandler(&buf, nil)) })
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	logs := buf.String()
	if !strings.Contains(logs, `"outbox.cycle"`) || !strings.Contains(logs, "lag_rows") {
		t.Fatalf("cycle record missing lag fields:\n%s", logs)
	}
	// PII discipline: payload bytes never appear in logs.
	if strings.Contains(logs, "C116") {
		t.Fatalf("payload bytes leaked into logs:\n%s", logs)
	}
}

// logBuffer is a slog sink (single-goroutine in these tests).
type logBuffer struct {
	buf []byte
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *logBuffer) String() string { return string(b.buf) }

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var d []byte
	for i > 0 {
		d = append([]byte{byte('0' + i%10)}, d...)
		i /= 10
	}
	if neg {
		return "-" + string(d)
	}
	return string(d)
}

func formatUUID(n int) string {
	// Deterministic UUIDv7-shaped id from a small int — unique per test row,
	// valid uuid for the column's type.
	base := "00000000-0000-7000-8000-"
	tail := itoa(n)
	for len(tail) < 12 {
		tail = "0" + tail
	}
	return base + tail
}
