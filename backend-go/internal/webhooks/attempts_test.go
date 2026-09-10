package webhooks

// Ladder-parity suite (acceptance criterion 2, pure half): the scenarios of
// src/domain/webhooks/attempts.spec.ts ported into Go table tests.
//
// Source of truth: src/domain/webhooks/attempts.ts + attempts.spec.ts.

import (
	"strings"
	"testing"
	"time"
)

var specLadder = []time.Duration{30 * time.Second, 60 * time.Second} // attempts.spec.ts's [30_000, 60_000]

// --- assertRetryLadder (bounded, ascending, positive) -----------------------

func TestAssertRetryLadderAcceptsDefaultAndReportsBudget(t *testing.T) {
	// 'accepts the default ladder and reports the attempt budget'
	if err := AssertRetryLadder(DefaultRetryLadder); err != nil {
		t.Fatalf("default ladder refused: %v", err)
	}
	if got, want := len(DefaultRetryLadder), 6; got != want {
		t.Fatalf("default ladder drifted: %d steps, want %d (attempts.ts ~30s,2m,10m,30m,2h,6h)", got, want)
	}
	if MaxAttemptsFor(DefaultRetryLadder) != len(DefaultRetryLadder)+1 {
		t.Fatalf("maxAttemptsFor = %d, want len+1", MaxAttemptsFor(DefaultRetryLadder))
	}
}

func TestAssertRetryLadderRefusalTable(t *testing.T) {
	// 'refusal table'
	cases := [][]time.Duration{
		{},                             // empty
		{0},                            // zero step
		{-1},                           // negative step
		{1500 * time.Microsecond},      // sub-millisecond fraction (TS 1.5 analog)
		{time.Second, time.Second},     // duplicate → not strictly ascending
		{2 * time.Second, time.Second}, // descending
	}
	for _, ladder := range cases {
		if err := AssertRetryLadder(ladder); !isCode(err, CodeRetryLadderInvalid) {
			t.Fatalf("ladder %v: got %v, want %s", ladder, err, CodeRetryLadderInvalid)
		}
	}
}

// --- recordAttemptOutcome (queued → delivering → delivered | deadLettered) --

func fixtureDelivery() Delivery {
	queuedAt := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC) // T0
	return Delivery{
		DeliveryID:    "00000000-0000-4000-8000-000000000703", // uid(703)
		EndpointID:    "00000000-0000-4000-8000-000000000705",
		OrgID:         "00000000-0000-4000-8000-000000000701", // uid(701)
		EventID:       "00000000-0000-4000-8000-000000000702", // uid(702)
		EventType:     "payment.confirmed",
		Status:        StatusQueued,
		NextAttemptAt: &queuedAt,
	}
}

func begin(delivery Delivery) Delivery {
	delivery.Status = StatusDelivering
	return delivery
}

func TestRecordOutcomeSuccessStampsDelivered(t *testing.T) {
	// 'success stamps deliveredAt, appends the attempt log, emits
	// deliverySucceeded'
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	at := T0.Add(1100 * time.Millisecond)
	delivered, decision, err := RecordAttemptOutcome(begin(fixtureDelivery()), AttemptOutcome{Success: true}, DefaultRetryLadder, at)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if decision.Terminal || decision.WillRetry || !decision.Delivered {
		t.Fatalf("decision drifted: %+v", decision)
	}
	if delivered.Status != StatusDelivered || delivered.Attempts != 1 || delivered.NextAttemptAt != nil {
		t.Fatalf("delivery drifted: status=%s attempts=%d next=%v", delivered.Status, delivered.Attempts, delivered.NextAttemptAt)
	}
	if delivered.DeliveredAt == nil || !delivered.DeliveredAt.Equal(at) {
		t.Fatalf("deliveredAt = %v, want %v", delivered.DeliveredAt, at)
	}
	wantLog := []AttemptRecord{{AttemptNo: 1, At: at, Outcome: "success"}}
	if len(delivered.AttemptLog) != 1 || delivered.AttemptLog[0] != wantLog[0] {
		t.Fatalf("attempt log drifted: %+v", delivered.AttemptLog)
	}
}

func TestRecordOutcomeFailureWithRetriesLeftFollowsLadder(t *testing.T) {
	// 'failure with retries left: back to queued with deterministic
	// nextAttemptAt (ladder boundary)'
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	d := begin(fixtureDelivery())

	at1 := T0.Add(100 * time.Millisecond)
	retried1, decision1, err := RecordAttemptOutcome(d, AttemptOutcome{Reason: "ECONNRESET"}, specLadder, at1)
	if err != nil {
		t.Fatalf("first failure: %v", err)
	}
	if retried1.Status != StatusQueued {
		t.Fatalf("status = %s, want queued", retried1.Status)
	}
	wantNext1 := at1.Add(30 * time.Second)
	if retried1.NextAttemptAt == nil || !retried1.NextAttemptAt.Equal(wantNext1) {
		t.Fatalf("nextAttemptAt = %v, want %v", retried1.NextAttemptAt, wantNext1)
	}
	if !decision1.WillRetry || decision1.Terminal || decision1.NextAttemptAt == nil || !decision1.NextAttemptAt.Equal(wantNext1) {
		t.Fatalf("decision drifted: %+v", decision1)
	}

	at2 := at1.Add(30*time.Second + 100*time.Millisecond) // the spec's second attempt instant
	_, decision2, err := RecordAttemptOutcome(begin(retried1), AttemptOutcome{Reason: "timeout"}, specLadder, at2)
	if err != nil {
		t.Fatalf("second failure: %v", err)
	}
	wantNext2 := at2.Add(60 * time.Second)
	if decision2.NextAttemptAt == nil || !decision2.NextAttemptAt.Equal(wantNext2) {
		t.Fatalf("second nextAttemptAt = %v, want %v", decision2.NextAttemptAt, wantNext2)
	}
	if retried1.LastFailureReason != "ECONNRESET" {
		t.Fatalf("lastFailureReason = %q", retried1.LastFailureReason)
	}
	if len(retried1.AttemptLog) != 1 || retried1.AttemptLog[0].FailureReason != "ECONNRESET" || retried1.AttemptLog[0].AttemptNo != 1 {
		t.Fatalf("attempt log drifted: %+v", retried1.AttemptLog)
	}
}

func TestRecordOutcomeLadderExhaustionDeadLetters(t *testing.T) {
	// 'ladder exhaustion dead-letters with TWO facts (deliveryFailed
	// willRetry:false + deliveryDeadLettered)' — exhaustion is the terminal.
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	ladder := []time.Duration{time.Second}

	d := begin(fixtureDelivery())
	retried, _, err := RecordAttemptOutcome(d, AttemptOutcome{Reason: "boom"}, ladder, T0.Add(10*time.Millisecond))
	if err != nil {
		t.Fatalf("first failure: %v", err)
	}
	final, decision, err := RecordAttemptOutcome(begin(retried), AttemptOutcome{Reason: "boom again"}, ladder, T0.Add(1010*time.Millisecond))
	if err != nil {
		t.Fatalf("second failure: %v", err)
	}
	if !decision.Terminal || decision.WillRetry {
		t.Fatalf("decision drifted: %+v", decision)
	}
	if final.Status != StatusDeadLettered {
		t.Fatalf("status = %s, want deadLettered", final.Status)
	}
	if final.DeadLetteredAt == nil || !final.DeadLetteredAt.Equal(T0.Add(1010*time.Millisecond)) {
		t.Fatalf("deadLetteredAt = %v", final.DeadLetteredAt)
	}
	if final.NextAttemptAt != nil {
		t.Fatalf("nextAttemptAt = %v, want nil", final.NextAttemptAt)
	}
	if decision.NextAttemptAt != nil {
		t.Fatalf("terminal decision carries nextAttemptAt %v", decision.NextAttemptAt)
	}
	if final.Attempts != 2 || len(final.AttemptLog) != 2 || final.AttemptLog[1].FailureReason != "boom again" {
		t.Fatalf("attempt log drifted: %+v", final.AttemptLog)
	}
}

func TestRecordOutcomeGuards(t *testing.T) {
	// 'outcomes record only against a delivering attempt; reasons are
	// mandatory'
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	if _, _, err := RecordAttemptOutcome(fixtureDelivery(), AttemptOutcome{Success: true}, DefaultRetryLadder, T0); !isCode(err, CodeDeliveryNotDelivering) {
		t.Fatalf("non-delivering record: got %v, want %s", err, CodeDeliveryNotDelivering)
	}
	if _, _, err := RecordAttemptOutcome(begin(fixtureDelivery()), AttemptOutcome{Reason: "  "}, DefaultRetryLadder, T0); !isCode(err, CodeFailureReasonRequired) {
		t.Fatalf("blank reason: got %v, want %s", err, CodeFailureReasonRequired)
	}
	reason := strings.TrimSpace("  boom  ")
	if reason != "boom" {
		t.Fatal("failure reasons are trimmed before the blank guard")
	}
}

func TestIsDeliveryDueInclusiveBoundary(t *testing.T) {
	// 'isDeliveryDue — inclusive boundary (±1ms) and status discipline'
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	d := fixtureDelivery() // nextAttemptAt == T0 → due at T0
	if !IsDeliveryDue(d, T0) {
		t.Fatal("nextAttemptAt == now must be due (inclusive)")
	}
	if IsDeliveryDue(d, T0.Add(-time.Millisecond)) {
		t.Fatal("one millisecond early must not be due")
	}
	d.Status = StatusDelivering
	if IsDeliveryDue(d, T0.Add(time.Second)) {
		t.Fatal("delivering deliveries are never due")
	}
}

func TestInputAggregateNeverMutated(t *testing.T) {
	// 'the input aggregate is never mutated (no-mutation pin)'
	T0 := time.Date(2026, 3, 1, 8, 0, 0, 0, time.UTC)
	d := begin(fixtureDelivery())
	_, _, err := RecordAttemptOutcome(d, AttemptOutcome{Success: true}, DefaultRetryLadder, T0)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if d.Status != StatusDelivering || d.Attempts != 0 || len(d.AttemptLog) != 0 {
		t.Fatalf("input aggregate mutated: %+v", d)
	}
}

func TestWillRetryAndBackoffBoundaries(t *testing.T) {
	// The exact formulas the acceptance criterion pins:
	// willRetry = attemptNo <= len(ladder); nextAttemptAt = now + ladder[attemptNo-1].
	ladder := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond}
	if MaxAttemptsFor(ladder) != 4 {
		t.Fatalf("max attempts = %d, want 4", MaxAttemptsFor(ladder))
	}
	for attemptNo := 1; attemptNo <= len(ladder); attemptNo++ {
		if !WillRetry(attemptNo, ladder) {
			t.Fatalf("attempt %d must retry", attemptNo)
		}
		backoff, err := BackoffFor(attemptNo, ladder)
		if err != nil || backoff != ladder[attemptNo-1] {
			t.Fatalf("backoff(%d) = %v err %v, want %v", attemptNo, backoff, err, ladder[attemptNo-1])
		}
	}
	if WillRetry(len(ladder)+1, ladder) {
		t.Fatal("exhaustion must not retry")
	}
	if _, err := BackoffFor(len(ladder)+1, ladder); !isCode(err, CodeRetryLadderInvalid) {
		t.Fatalf("out-of-range backoff: got %v, want %s", err, CodeRetryLadderInvalid)
	}
}
