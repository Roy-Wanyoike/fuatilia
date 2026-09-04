package outbox

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Grammar-poison: a row whose (event_type, version) cannot yield a subject
// never reaches the wire, is poisoned immediately with attempts untouched,
// and its successors in the same batch still publish (a poisoned row is
// terminal, so it cannot reorder the stream behind it).
func TestPoisonGrammarInvalidRowTerminalSuccessorsProceed(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "poison-grammar")
	base := time.Now().Add(-time.Hour)
	appendEvent(t, pool, org, "55555555-5555-4555-8555-555555555001", "NOT a catalog name", 1, `{"bad":true}`, base)
	appendEvent(t, pool, org, "55555555-5555-4555-8555-555555555002", "payment.confirmed", 1, `{"good":true}`, base.Add(time.Second))
	// NOTE: a version-0 row cannot be INSERTed here at all — the DDL face of
	// the same rule (ck_outbox_version, db/migrations/0013) refuses it before
	// the relay could see it. The relay-side version guard is pinned purely in
	// subjects_test.go (TestSubjectForVersions); this test proves the
	// grammar-poison path over the wire.

	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	var status string
	var attempts int
	if err := pool.QueryRow(context.Background(),
		`SELECT status, attempts FROM outbox_events WHERE event_id::text = $1`, "55555555-5555-4555-8555-555555555001",
	).Scan(&status, &attempts); err != nil {
		t.Fatal(err)
	}
	if status != "poisoned" || attempts != 0 {
		t.Fatalf("grammar-poison: status=%s attempts=%d, want poisoned/0", status, attempts)
	}

	got := drainStream(t, js)
	expectCount(t, got, "fuatilia.payment.confirmed.v1", 1, "successor must proceed")
	var lastError *string
	if err := pool.QueryRow(context.Background(),
		`SELECT last_error FROM outbox_events WHERE event_id::text = $1`, "55555555-5555-4555-8555-555555555001",
	).Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if lastError == nil || *lastError == "" {
		t.Fatal("grammar-poison must record last_error for the runbook")
	}
}

// Attempt-poison: with MaxAttempts=2, a publish that always fails is
// attempted twice (attempts committed per cycle), then poisoned with the
// final error recorded.
func TestPoisonAttemptsExhaustedCommittedPerCycle(t *testing.T) {
	pool := testPool(t)
	js, srv := testBroker(t)
	org := testOrg(t, pool, "poison-attempts")
	appendEvent(t, pool, org, "66666666-6666-4666-8666-666666666001", "payment.confirmed", 1, `{"tries":true}`, time.Now())

	relay := newTestRelay(t, pool, js, func(c *Config) { c.MaxAttempts = 2 })

	// Kill the broker after the stream is ensured: publishes fail from here on.
	if err := EnsureStream(context.Background(), js); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}
	srv.Shutdown()
	// Bounded cycles: a dead broker makes the publish path wait on reconnect;
	// production bounds this with the worker's shutdown context too.
	deadCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := relay.RunOnce(deadCtx); err != nil {
		// Cycle-level infra failure is retried by Run; RunOnce may surface it.
		t.Logf("cycle 1 returned (expected publish path handled): %v", err)
	}
	var status string
	var attempts int
	check := func() {
		t.Helper()
		if err := pool.QueryRow(context.Background(),
			`SELECT status, attempts FROM outbox_events WHERE event_id::text = $1`, "66666666-6666-4666-8666-666666666001",
		).Scan(&status, &attempts); err != nil {
			t.Fatal(err)
		}
	}
	check()
	if status != "pending" || attempts != 1 {
		t.Fatalf("after failed cycle: status=%s attempts=%d, want pending/1", status, attempts)
	}
	deadCtx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel2()
	if err := relay.RunOnce(deadCtx2); err != nil {
		t.Logf("cycle 2 returned: %v", err)
	}
	check()
	if status != "poisoned" || attempts != 2 {
		t.Fatalf("after second failed cycle: status=%s attempts=%d, want poisoned/2", status, attempts)
	}
	var lastError *string
	if err := pool.QueryRow(context.Background(),
		`SELECT last_error FROM outbox_events WHERE event_id::text = $1`, "66666666-6666-4666-8666-666666666001",
	).Scan(&lastError); err != nil {
		t.Fatal(err)
	}
	if lastError == nil || *lastError == "" {
		t.Fatal("attempt-poison must record last_error")
	}
}

// Replay: `ReplayPoisons` requeues the DLQ with a fresh attempt budget; the
// relay then republishes under the SAME (org_id, event_id) — consumers stay
// idempotent, the broker dedup collapses the redelivery window.
func TestReplayPoisonsRequeuesAndRepublishes(t *testing.T) {
	pool := testPool(t)
	js, srv := testBroker(t)
	org := testOrg(t, pool, "replay-poisons")
	appendEvent(t, pool, org, "77777777-7777-4777-8777-777777777001", "payment.confirmed", 1, `{"replay":true}`, time.Now())

	relay := newTestRelay(t, pool, js, func(c *Config) { c.MaxAttempts = 1 })
	if err := EnsureStream(context.Background(), js); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}
	srv.Shutdown()
	deadCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = relay.RunOnce(deadCtx) // publish fails → poisoned (budget 1)

	var status string
	if err := pool.QueryRow(context.Background(),
		`SELECT status FROM outbox_events WHERE event_id::text = $1`, "77777777-7777-4777-8777-777777777001",
	).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "poisoned" {
		t.Fatalf("row should be poisoned after budget exhausted, got %s", status)
	}

	requeued, err := ReplayPoisons(context.Background(), pool)
	if err != nil {
		t.Fatalf("ReplayPoisons: %v", err)
	}
	if requeued != 1 {
		t.Fatalf("requeued %d, want 1", requeued)
	}

	// A fresh relay on a FRESH broker publishes the replayed row.
	js2, _ := testBrokerNamed(t, "replay-2")
	if err := EnsureStream(context.Background(), js2); err != nil {
		t.Fatalf("EnsureStream 2: %v", err)
	}
	relay2 := newTestRelay(t, pool, js2, nil)
	if err := relay2.RunOnce(context.Background()); err != nil {
		t.Fatalf("republish cycle: %v", err)
	}
	got := drainStream(t, js2)
	expectCount(t, got, "fuatilia.payment.confirmed.v1", 1, "replayed row must publish")
	env := got["fuatilia.payment.confirmed.v1"][0]
	if env.EventID != "77777777-7777-4777-8777-777777777001" {
		t.Fatalf("replay changed event identity: %+v", env)
	}
}

func TestReplayRangeRefusesNonAdvancingWindow(t *testing.T) {
	pool := testPool(t)
	now := time.Now()
	if _, err := ReplayRange(context.Background(), pool, now, now); err == nil {
		t.Fatal("empty window must refuse")
	} else {
		var oerr *Error
		if !errors.As(err, &oerr) || oerr.Code != CodeReplayRangeInvalid {
			t.Fatalf("wrong refusal: %v", err)
		}
	}
	if _, err := ReplayRange(context.Background(), pool, now.Add(time.Hour), now); err == nil {
		t.Fatal("reversed window must refuse")
	}
}

// exhaustsBudget is the pure decision point — pin it directly too.
func TestExhaustsBudget(t *testing.T) {
	if exhaustsBudget(1, 5) {
		t.Fatal("attempt 1 of 5 must not poison")
	}
	if !exhaustsBudget(5, 5) {
		t.Fatal("attempt 5 of 5 must poison")
	}
	if !exhaustsBudget(6, 5) {
		t.Fatal("over budget must poison")
	}
}

// atomicPoisonCounter guards against accidental double-poison accounting if
// the poison path ever runs twice for one row in a batch.
func TestPoisonAccountingOncePerRow(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "poison-once")
	base := time.Now().Add(-time.Hour)
	appendEvent(t, pool, org, "88888888-8888-4888-8888-888888888001", "bad name one", 1, `{"a":1}`, base)
	appendEvent(t, pool, org, "88888888-8888-4888-8888-888888888002", "also bad", 1, `{"b":2}`, base.Add(time.Second))

	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	var poisoned int
	if err := pool.QueryRow(context.Background(),
		`SELECT count(*) FROM outbox_events WHERE status='poisoned'`).Scan(&poisoned); err != nil {
		t.Fatal(err)
	}
	if poisoned != 2 {
		t.Fatalf("poisoned rows = %d, want 2 (one per malformed row, no more)", poisoned)
	}
}
