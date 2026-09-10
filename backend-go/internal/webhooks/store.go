package webhooks

// PostgreSQL persistence for the delivery worker, over webhook_deliveries /
// webhook_endpoints (db/migrations/0012). The transactional shape is the
// issue's constraint, restated:
//
//   - CLAIM (one short transaction): SELECT … FOR UPDATE SKIP LOCKED the
//     oldest due delivery of an ACTIVE endpoint, flip it to `delivering`,
//     COMMIT — the row lock is released BEFORE any network I/O.
//   - POST: outside any transaction (worker.go owns it).
//   - RECORD (one transaction): the attempt record (attempt_count,
//     last_error, delivered_at) AND the ladder advance (state, next_attempt_at,
//     dead_lettered_at) commit together or not at all — a crash mid-way
//     leaves the row `delivering`, which the claim lease recovers.
//
// State mapping (pure model ↔ SQL enum webhook_state): the TS aggregate's
// "failure with retries left → queued + nextAttemptAt" persists as `failed`
// with next_attempt_at — webhook_state has no separate retry-pending name,
// and the due index (idx_webhook_deliveries_due) covers exactly
// ('queued','failed'). The schedule itself comes from the shared pure
// functions (WillRetry / BackoffFor), so parity is by construction.
//
// Least-privilege footprint: SELECT + UPDATE on webhook_deliveries, SELECT on
// webhook_endpoints. Terminal rows (delivered / dead_lettered) are frozen by
// the schema trigger (0012); the `state = 'delivering'` predicate on every
// record statement keeps this worker from ever touching them.

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Store executes claims and attempt records against PostgreSQL.
type Store struct {
	pool  *pgxpool.Pool
	clock infra.Clock
}

// NewStore wires a store over the kernel's pool.
func NewStore(pool *pgxpool.Pool, clock infra.Clock) *Store {
	return &Store{pool: pool, clock: clock}
}

// Claimed is one delivery row won by ClaimDue. AttemptNo is this attempt's
// 1-based number (attempt_count + 1): the POST is about to become attempt N.
type Claimed struct {
	ID           string
	OrgID        string
	EndpointID   string
	EventID      string
	EventType    string
	EndpointURL  string
	Payload      []byte // canonical jsonb text — signed and sent VERBATIM
	AttemptCount int    // committed attempts before this one
	AttemptNo    int    // AttemptCount + 1
	CreatedAt    time.Time
}

// claimDueSQL wins the oldest due delivery of an active endpoint.
//
// Due means:
//   - queued (or failed-with-retries, the retry-pending state) whose
//     schedule (next_attempt_at, falling back to created_at for rows the
//     API lane enqueued without one) has arrived, or
//   - `delivering` whose claim lease has expired — the at-least-once
//     recovery path for a worker that died between POST and record.
//
// Endpoints with active = false are excluded at the source: revoked or
// disabled endpoints are never delivered (their rows simply wait).
// FOR UPDATE OF d SKIP LOCKED: two workers claiming simultaneously can never
// win the same row — the loser skips it and takes the next one.
const claimDueSQL = `
SELECT d.id::text, d.org_id::text, d.endpoint_id::text, d.event_id::text,
       d.event_type, d.payload::text, d.attempt_count, d.created_at, e.url
  FROM webhook_deliveries d
  JOIN webhook_endpoints  e ON e.org_id = d.org_id AND e.id = d.endpoint_id
 WHERE e.active
   AND (
        (d.state IN ('queued', 'failed')
         AND COALESCE(d.next_attempt_at, d.created_at) <= $1)
        OR
        (d.state = 'delivering' AND d.updated_at <= $2)
       )
 ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.created_at, d.id
 LIMIT 1
   FOR UPDATE OF d SKIP LOCKED`

// ClaimDue claims the next due delivery, or returns nil when nothing is due.
// The claim transaction commits (releasing the row lock) before the caller
// performs any network I/O. The lease must comfortably exceed the delivery
// timeout: an in-flight attempt whose lease lapses may be stolen by a peer —
// at-least-once, receivers dedupe by event id.
func (s *Store) ClaimDue(ctx context.Context, lease time.Duration) (*Claimed, error) {
	now := s.clock.Now()
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("webhooks: begin claim: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit

	var c Claimed
	err = tx.QueryRow(ctx, claimDueSQL, now, now.Add(-lease)).
		Scan(&c.ID, &c.OrgID, &c.EndpointID, &c.EventID, &c.EventType,
			&c.Payload, &c.AttemptCount, &c.CreatedAt, &c.EndpointURL)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("webhooks: claim due delivery: %w", err)
	}
	// Stamp the claim: state → delivering refreshes updated_at (the schema
	// touch trigger), which starts this claim's lease.
	if _, err := tx.Exec(ctx,
		`UPDATE webhook_deliveries SET state = 'delivering' WHERE id = $1::uuid`, c.ID); err != nil {
		return nil, fmt.Errorf("webhooks: mark claim %s delivering: %w", c.ID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("webhooks: commit claim %s: %w", c.ID, err)
	}
	c.AttemptNo = c.AttemptCount + 1
	return &c, nil
}

// RecordSuccess commits a delivered attempt. It reports false when the claim
// was lost (a peer stole the expired lease, or the delivery already reached a
// terminal state) — the outcome is then discarded: exactly one worker's
// record ever lands. The row shape mirrors the pure transition exactly
// (attempts.go RecordAttemptOutcome success branch): delivered_at stamped,
// next_attempt_at cleared, last_error cleared.
func (s *Store) RecordSuccess(ctx context.Context, deliveryID string, attemptNo int, at time.Time) (bool, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE webhook_deliveries
            SET state = 'delivered', delivered_at = $2, attempt_count = $3,
                next_attempt_at = NULL, last_error = NULL
          WHERE id = $1::uuid AND state = 'delivering'`,
		deliveryID, at, attemptNo)
	if err != nil {
		return false, fmt.Errorf("webhooks: record success %s: %w", deliveryID, err)
	}
	return tag.RowsAffected() == 1, nil
}

// FailureRecord is the committed result of a failed attempt.
type FailureRecord struct {
	Recorded      bool // false when the claim was lost — outcome discarded
	WillRetry     bool
	NextAttemptAt *time.Time // set exactly when WillRetry
	DeadLettered  bool       // ladder exhausted — terminal
}

// RecordFailure commits the attempt record AND the ladder advance in ONE
// transaction (the issue's constraint): attempt_count/last_error and the
// resulting state/next_attempt_at/dead_lettered_at are written atomically,
// guarded by `state = 'delivering'` under the row lock.
//
// The schedule is computed by the pure ported functions — WillRetry decides,
// BackoffFor (ladder[attemptNo-1]) times the retry, exhaustion dead-letters:
// success/4xx/5xx/network errors all walk the identical attempts.ts schedule.
func (s *Store) RecordFailure(ctx context.Context, deliveryID string, attemptNo int, reason string, at time.Time, ladder []time.Duration) (FailureRecord, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return FailureRecord{}, fmt.Errorf("webhooks: begin failure record %s: %w", deliveryID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit

	var state string
	var attempts int
	err = tx.QueryRow(ctx,
		`SELECT state, attempt_count FROM webhook_deliveries WHERE id = $1::uuid FOR UPDATE`,
		deliveryID).Scan(&state, &attempts)
	if err == pgx.ErrNoRows {
		return FailureRecord{}, nil
	}
	if err != nil {
		return FailureRecord{}, fmt.Errorf("webhooks: lock delivery %s: %w", deliveryID, err)
	}
	// Lost claim (or drift): another worker owns this attempt now — discard.
	if state != string(StatusDelivering) || attempts != attemptNo-1 {
		return FailureRecord{}, nil
	}

	willRetry := WillRetry(attemptNo, ladder)
	nextState := "failed" // retry-pending: back to the due set at next_attempt_at
	var nextAttemptAt *time.Time
	var deadLetteredAt *time.Time
	if willRetry {
		backoff, err := BackoffFor(attemptNo, ladder)
		if err != nil {
			return FailureRecord{}, err
		}
		next := at.Add(backoff)
		nextAttemptAt = &next
	} else {
		nextState = "dead_lettered"
		deadLetteredAt = &at
	}

	tag, err := tx.Exec(ctx,
		`UPDATE webhook_deliveries
            SET attempt_count = $2, last_error = $3, state = $4,
                next_attempt_at = $5, dead_lettered_at = $6
          WHERE id = $1::uuid AND state = 'delivering'`,
		deliveryID, attemptNo, reason, nextState, nextAttemptAt, deadLetteredAt)
	if err != nil {
		return FailureRecord{}, fmt.Errorf("webhooks: record failure %s: %w", deliveryID, err)
	}
	if tag.RowsAffected() != 1 {
		return FailureRecord{}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return FailureRecord{}, fmt.Errorf("webhooks: commit failure record %s: %w", deliveryID, err)
	}
	return FailureRecord{Recorded: true, WillRetry: willRetry, NextAttemptAt: nextAttemptAt, DeadLettered: !willRetry}, nil
}
