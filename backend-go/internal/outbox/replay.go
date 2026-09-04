package outbox

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Replay — the DLQ and range-replay operations behind `worker replay`
// (issue #74, ADR-0003 "replay is deterministic").
//
// Both operations requeue rows by flipping status back to pending; neither
// inserts new rows. Because outbox_events carries UNIQUE (org_id, event_id)
// and the relay republishes the SAME event_id, replay is idempotent at every
// layer: repeated invocations converge, the JetStream Nats-Msg-Id dedup key
// collapses redeliveries inside the duplicate window, and consumers remain
// idempotent by eventId forever (their binding contract — see README).
//
// Replay resets the attempt budget: a replayed row starts a fresh lifecycle
// (attempts = 0, last_error cleared, published_at cleared until the broker
// acks again).
const (
	replayPoisonsSQL = `UPDATE outbox_events
	                       SET status = 'pending', attempts = 0, last_error = NULL, published_at = NULL
	                     WHERE status = 'poisoned'`
	replayRangeSQL = `UPDATE outbox_events
	                     SET status = 'pending', attempts = 0, last_error = NULL, published_at = NULL
	                   WHERE created_at >= $1 AND created_at < $2`
)

// ReplayPoisons requeues every poisoned event (the whole DLQ) — the
// `worker replay poisons` subcommand. Returns the number of rows requeued.
//
// Callers should only replay after the underlying cause is fixed (broker
// back up, malformed producer corrected) — replaying into a still-broken
// pipeline simply re-poisons after MaxAttempts, which is safe but wasteful.
func ReplayPoisons(ctx context.Context, pool *pgxpool.Pool) (int64, error) {
	tag, err := pool.Exec(ctx, replayPoisonsSQL)
	if err != nil {
		return 0, fmt.Errorf("outbox: replay poisons: %w", err)
	}
	return tag.RowsAffected(), nil
}

// ReplayRange republishes every event appended in the [from, to) window of
// created_at, regardless of current status — the projection-rebuild path for
// consumers that need a deterministic re-feed of a time range. Returns the
// number of rows requeued.
//
// Rows the relay already published are flipped pending → they republish on
// the same event_id (dedup collapses them inside the window for consumers
// that kept up; consumers rebuilding from scratch read the full stream).
// A range that does not advance (to <= from) is refused with
// OUTBOX_REPLAY_RANGE_INVALID rather than silently replaying nothing.
func ReplayRange(ctx context.Context, pool *pgxpool.Pool, from, to time.Time) (int64, error) {
	if !from.Before(to) {
		return 0, &Error{
			Code: CodeReplayRangeInvalid,
			Message: fmt.Sprintf(
				"replay window must advance: from %s is not before to %s ([from, to) on created_at)",
				from.Format(time.RFC3339), to.Format(time.RFC3339)),
		}
	}
	tag, err := pool.Exec(ctx, replayRangeSQL, from, to)
	if err != nil {
		return 0, fmt.Errorf("outbox: replay range [%s, %s): %w",
			from.Format(time.RFC3339), to.Format(time.RFC3339), err)
	}
	return tag.RowsAffected(), nil
}
