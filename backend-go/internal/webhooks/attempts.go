package webhooks

// Attempt-ladder semantics — ported from src/domain/webhooks/attempts.ts
// (issue #47, SPEC §53): the pure configuration and transition rules the
// delivery worker executes. The TS spec's scenarios are ported 1:1 into
// attempts_test.go (ladder parity, acceptance criterion 2).
//
// Model (attempts.ts):
//   - the ladder is pure configuration: attempt N's failure retries after
//     ladder[N-1] ms (strictly ascending positive steps);
//   - willRetry = attemptNo <= len(ladder); exhausting the ladder
//     dead-letters the delivery (terminal);
//   - every outcome appends to an immutable attempt log — attempts are never
//     edited; a failed attempt with retries left returns the delivery to
//     `queued` with a deterministic nextAttemptAt (failure lives in the
//     attempt log, not a phantom status).

import (
	"fmt"
	"strings"
	"time"
)

// DefaultRetryLadder is the bounded exponential ladder from attempts.ts
// DEFAULT_RETRY_LADDER_MS: ~30s, 2m, 10m, 30m, 2h, 6h.
var DefaultRetryLadder = []time.Duration{
	30 * time.Second,
	2 * time.Minute,
	10 * time.Minute,
	30 * time.Minute,
	2 * time.Hour,
	6 * time.Hour,
}

// AssertRetryLadder validates a retry ladder: non-empty, positive steps,
// strictly ascending (deterministic backoff) — WEBHOOK_RETRY_LADDER_INVALID
// otherwise. Ported from attempts.ts assertRetryLadder.
func AssertRetryLadder(ladder []time.Duration) error {
	if len(ladder) == 0 {
		return &Error{Code: CodeRetryLadderInvalid, Message: "a retry ladder requires at least one backoff step"}
	}
	for _, step := range ladder {
		// Steps are integers of milliseconds (the TS ladder's unit): a
		// sub-millisecond Duration is the Go face of the spec's 1.5 refusal,
		// and steps beyond 2^53-1 ms are outside the safe-integer bound.
		if step <= 0 || step%time.Millisecond != 0 || step/time.Millisecond > time.Duration(maxSafeInteger) {
			return &Error{Code: CodeRetryLadderInvalid,
				Message: fmt.Sprintf("retry backoff steps must be positive safe integers of milliseconds, got %s", step)}
		}
	}
	for i := 1; i < len(ladder); i++ {
		if ladder[i] <= ladder[i-1] {
			return &Error{Code: CodeRetryLadderInvalid,
				Message: "retry backoff steps must be strictly ascending (deterministic exponential backoff)"}
		}
	}
	return nil
}

// MaxAttemptsFor is the total attempts the ladder buys: the first try plus
// one retry per step (attempts.ts maxAttemptsFor).
func MaxAttemptsFor(ladder []time.Duration) int { return len(ladder) + 1 }

// WillRetry is the ladder's decision for a failed attempt N (1-based):
// attemptNo <= len(ladder) (attempts.ts recordAttemptOutcome).
func WillRetry(attemptNo int, ladder []time.Duration) bool {
	return attemptNo <= len(ladder)
}

// BackoffFor returns ladder[attemptNo-1] — the delay AFTER a failed attempt N
// (attempts.ts: nextAttemptAt = now + ladder[attemptNo-1]). Out-of-range
// attempt numbers are a programming error and refuse loudly.
func BackoffFor(attemptNo int, ladder []time.Duration) (time.Duration, error) {
	if attemptNo < 1 || attemptNo > len(ladder) {
		return 0, &Error{Code: CodeRetryLadderInvalid,
			Message: fmt.Sprintf("attempt %d is outside the retry ladder (1..%d)", attemptNo, len(ladder))}
	}
	return ladder[attemptNo-1], nil
}

// DeliveryStatus is the pure aggregate's status set (attempts.ts
// DeliveryStatus). The database enum (webhook_state) spells the retry-pending
// state `failed`; store.go maps the two — the schedule and decisions are the
// contract, and they are shared through WillRetry/BackoffFor.
type DeliveryStatus string

const (
	StatusQueued       DeliveryStatus = "queued"
	StatusDelivering   DeliveryStatus = "delivering"
	StatusDelivered    DeliveryStatus = "delivered"
	StatusDeadLettered DeliveryStatus = "deadLettered"
)

// AttemptRecord is one append-only attempt-log entry (attempts.ts
// AttemptRecord): outcome facts are never edited, never reordered.
type AttemptRecord struct {
	AttemptNo     int
	At            time.Time
	Outcome       string // "success" | "failure"
	FailureReason string // empty for successes
}

// Delivery is the pure aggregate the ladder transitions (attempts.ts
// Delivery). The worker's store projects the same transitions onto
// webhook_deliveries columns; this type keeps the parity tests honest.
type Delivery struct {
	DeliveryID        string
	EndpointID        string
	OrgID             string
	EventID           string
	EventType         string
	Status            DeliveryStatus
	Attempts          int
	NextAttemptAt     *time.Time
	DeliveredAt       *time.Time
	DeadLetteredAt    *time.Time
	LastFailureReason string
	AttemptLog        []AttemptRecord
}

// AttemptOutcome is what the wire produced for one attempt (attempts.ts
// AttemptOutcome): success, or failure with a mandatory non-blank reason.
type AttemptOutcome struct {
	Success bool
	Reason  string
}

// AttemptDecision is the ladder's ruling on an outcome: the next status,
// whether a retry is scheduled (with the deterministic instant), and whether
// the delivery reached its dead-letter terminal.
type AttemptDecision struct {
	AttemptNo     int
	Status        DeliveryStatus
	WillRetry     bool
	NextAttemptAt *time.Time
	Terminal      bool
	Delivered     bool
}

// RecordAttemptOutcome ports attempts.ts recordAttemptOutcome: only a
// `delivering` delivery records outcomes (WEBHOOK_DELIVERY_NOT_DELIVERING); a
// blank failure reason is refused (WEBHOOK_FAILURE_REASON_REQUIRED — an
// unexplained failure is not an audit fact).
//
//	success          → delivered (deliveredAt stamped, attempt logged)
//	failure, retries → queued with nextAttemptAt = at + ladder[attemptNo-1]
//	failure, spent   → deadLettered (terminal), nextAttemptAt cleared
func RecordAttemptOutcome(delivery Delivery, outcome AttemptOutcome, ladder []time.Duration, at time.Time) (Delivery, AttemptDecision, error) {
	if err := AssertRetryLadder(ladder); err != nil {
		return delivery, AttemptDecision{}, err
	}
	if delivery.Status != StatusDelivering {
		return delivery, AttemptDecision{}, &Error{Code: CodeDeliveryNotDelivering,
			Message: fmt.Sprintf("delivery %s is %s — outcomes record only against a delivering attempt", delivery.DeliveryID, delivery.Status)}
	}
	attemptNo := delivery.Attempts + 1

	if outcome.Success {
		logged := append(append([]AttemptRecord{}, delivery.AttemptLog...),
			AttemptRecord{AttemptNo: attemptNo, At: at, Outcome: "success"})
		delivered := delivery
		delivered.Status = StatusDelivered
		delivered.Attempts = attemptNo
		delivered.NextAttemptAt = nil
		delivered.DeliveredAt = &at
		delivered.AttemptLog = logged
		return delivered, AttemptDecision{AttemptNo: attemptNo, Status: StatusDelivered, Delivered: true}, nil
	}

	reason := strings.TrimSpace(outcome.Reason)
	if reason == "" {
		return delivery, AttemptDecision{}, &Error{Code: CodeFailureReasonRequired,
			Message: "a failed attempt requires a non-blank failure reason (audit)"}
	}
	logged := append(append([]AttemptRecord{}, delivery.AttemptLog...),
		AttemptRecord{AttemptNo: attemptNo, At: at, Outcome: "failure", FailureReason: reason})
	base := delivery
	base.Attempts = attemptNo
	base.LastFailureReason = reason
	base.AttemptLog = logged

	if WillRetry(attemptNo, ladder) {
		backoff, err := BackoffFor(attemptNo, ladder)
		if err != nil {
			return delivery, AttemptDecision{}, err
		}
		next := at.Add(backoff)
		retried := base
		retried.Status = StatusQueued
		retried.NextAttemptAt = &next
		return retried, AttemptDecision{AttemptNo: attemptNo, Status: StatusQueued, WillRetry: true, NextAttemptAt: &next}, nil
	}

	deadLettered := base
	deadLettered.Status = StatusDeadLettered
	deadLettered.NextAttemptAt = nil
	deadLettered.DeadLetteredAt = &at
	return deadLettered, AttemptDecision{AttemptNo: attemptNo, Status: StatusDeadLettered, Terminal: true}, nil
}

// IsDeliveryDue reports whether a queued delivery's schedule has arrived —
// inclusive boundary (attempts.ts isDeliveryDue: now >= nextAttemptAt; ±1ms
// is meaningful).
func IsDeliveryDue(delivery Delivery, now time.Time) bool {
	if delivery.Status != StatusQueued || delivery.NextAttemptAt == nil {
		return false
	}
	return !now.Before(*delivery.NextAttemptAt)
}
