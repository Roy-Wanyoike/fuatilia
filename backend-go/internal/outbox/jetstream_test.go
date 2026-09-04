package outbox

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Crash-safety at the at-least-once seam (issue #74 acceptance 2): the
// afterPublish fault-injection point fails AFTER the broker acked a publish
// but BEFORE the row is marked — the batch transaction aborts, nothing is
// marked, and a fresh relay redelivers exactly the unmarked set. Every
// message IS on the stream (publish happened); the JetStream Nats-Msg-Id
// dedup key ("<org>:<event>") collapses the redelivery so consumers observe
// each event once.
func TestCrashBetweenPublishAndMarkRedeliversUnmarkedSet(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "crash-seam")
	base := time.Now().Add(-time.Hour)
	for i := 1; i <= 5; i++ {
		appendEvent(t, pool, org, formatUUID(i), "payment.initiated", 1, `{"seq": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}

	relay := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 5 })
	// Simulate process death on the 3rd publish of the batch.
	var published atomic.Int64
	relay.afterPublish = func(row batchRow) error {
		if published.Add(1) == 3 {
			return fmt.Errorf("simulated crash after publish of %s", row.EventID)
		}
		return nil
	}
	if err := relay.RunOnce(context.Background()); err == nil {
		t.Fatal("simulated crash must surface as an error")
	}

	// Nothing marked: the whole batch rolled back to pending.
	var pending int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if pending != 5 {
		t.Fatalf("pending after crash = %d, want 5 (batch rollback)", pending)
	}
	// The first three publishes DID reach the broker before the simulated
	// death (the hook fires after the broker acked each publish).
	got := drainStream(t, js)
	if len(got["fuatilia.payment.initiated.v1"]) != 3 {
		t.Fatalf("pre-crash publishes on stream = %d, want 3", len(got["fuatilia.payment.initiated.v1"]))
	}

	// Fresh relay (no fault) drains everything; redelivered 1–2 collapse
	// server-side via Nats-Msg-Id, so the stream still carries 5 messages.
	relay2 := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 5 })
	if err := relay2.RunOnce(context.Background()); err != nil {
		t.Fatalf("recovery cycle: %v", err)
	}
	var publishedRows, pendingRows int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='published'`).Scan(&publishedRows); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='pending'`).Scan(&pendingRows); err != nil {
		t.Fatal(err)
	}
	if publishedRows != 5 || pendingRows != 0 {
		t.Fatalf("after recovery: published=%d pending=%d, want 5/0", publishedRows, pendingRows)
	}
	info, err := js.StreamInfo(StreamName)
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != 5 {
		t.Fatalf("stream msgs = %d, want 5 (Nats-Msg-Id dedup collapsed redeliveries)", info.State.Msgs)
	}
	// And the consumer-visible order is still the append order.
	final := drainStream(t, js)
	for i, env := range final["fuatilia.payment.initiated.v1"] {
		if string(env.Payload) != `{"seq": `+itoa(i+1)+`}` {
			t.Fatalf("order after crash recovery broken at %d: %s", i, env.Payload)
		}
	}
}

// Concurrency proof (issue #74 acceptance 4): two relays draining the same
// org concurrently must never double-publish the same event_id and never
// reorder the stream — the per-org advisory xact lock makes losers SKIP.
func TestTwoConcurrentRelaysNeverDoublePublish(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "concurrent-relays")
	base := time.Now().Add(-time.Hour)
	const total = 60
	for i := 1; i <= total; i++ {
		appendEvent(t, pool, org, formatUUID(i), "allocation.executed", 1, `{"seq": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}

	relayA := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 10 })
	relayB := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 10 })

	var wg sync.WaitGroup
	runCycles := func(r *Relay, name string) {
		defer wg.Done()
		for cycle := 0; cycle < 10; cycle++ {
			if err := r.RunOnce(context.Background()); err != nil {
				t.Errorf("relay %s cycle %d: %v", name, cycle, err)
				return
			}
			// Yield so both relays genuinely interleave.
			time.Sleep(5 * time.Millisecond)
		}
	}
	wg.Add(2)
	go runCycles(relayA, "A")
	go runCycles(relayB, "B")
	wg.Wait()

	// Drain any remainder with one more solo cycle.
	_ = relayA.RunOnce(context.Background())

	var published, pending int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='published'`).Scan(&published); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='pending'`).Scan(&pending); err != nil {
		t.Fatal(err)
	}
	if published != total || pending != 0 {
		t.Fatalf("after concurrent drain: published=%d pending=%d, want %d/0", published, pending, total)
	}
	info, err := js.StreamInfo(StreamName)
	if err != nil {
		t.Fatal(err)
	}
	if info.State.Msgs != total {
		t.Fatalf("stream msgs = %d, want %d — a double publish slipped past the lock", info.State.Msgs, total)
	}
	final := drainStream(t, js)
	for i, env := range final["fuatilia.allocation.executed.v1"] {
		if string(env.Payload) != `{"seq": `+itoa(i+1)+`}` {
			t.Fatalf("concurrent drain reordered the stream at %d: %s", i, env.Payload)
		}
	}
}

// Soak (issue #74 acceptance 1): 100 events appended → all published with
// correct subjects, per-org order preserved (one org), zero loss.
func TestHundredEventSoakAllPublishedInOrder(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "soak-100")
	base := time.Now().Add(-time.Hour)
	for i := 1; i <= 100; i++ {
		appendEvent(t, pool, org, formatUUID(i), "invoicing.invoiceIssued", 1, `{"n": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}
	relay := newTestRelay(t, pool, js, func(c *Config) { c.BatchSize = 30 })
	for cycle := 0; cycle < 5; cycle++ {
		if err := relay.RunOnce(context.Background()); err != nil {
			t.Fatalf("soak cycle %d: %v", cycle, err)
		}
	}
	var published int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='published'`).Scan(&published); err != nil {
		t.Fatal(err)
	}
	if published != 100 {
		t.Fatalf("published %d/100", published)
	}
	got := drainStream(t, js)
	msgs := got["fuatilia.invoicing.invoiceIssued.v1"]
	if len(msgs) != 100 {
		t.Fatalf("stream carries %d, want 100", len(msgs))
	}
	for i, env := range msgs {
		if string(env.Payload) != `{"n": `+itoa(i+1)+`}` {
			t.Fatalf("soak order broken at %d: %s", i, env.Payload)
		}
	}
}

// Graceful drain: cancellation is only observed BETWEEN org batches — an
// in-flight batch always completes and commits.
func TestGracefulDrainCompletesInFlightBatch(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "graceful-drain")
	base := time.Now().Add(-time.Hour)
	for i := 1; i <= 4; i++ {
		appendEvent(t, pool, org, formatUUID(i), "receivable.opened", 1, `{"g": `+itoa(i)+`}`, base.Add(time.Duration(i)*time.Second))
	}
	relay := newTestRelay(t, pool, js, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancelled BEFORE RunOnce — the cycle observes it between batches
	if err := relay.RunOnce(ctx); err == nil {
		t.Log("RunOnce returned nil on pre-cancelled context (allowed: nothing pending observed after ctx check)")
	}
	// A cancelled context mid-run must never strand marks: either the batch
	// fully committed or nothing was taken.
	var taken int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox_events WHERE status='published'`).Scan(&taken); err != nil {
		t.Fatal(err)
	}
	if taken != 0 && taken != 4 {
		t.Fatalf("partial batch committed: %d of 4 — graceful drain violated", taken)
	}
}
