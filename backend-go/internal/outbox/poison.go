package outbox

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Poison — the dead-letter queue (DLQ) semantics of the relay (issue #74).
//
// A row is poisoned when it can never, or no longer, be published:
//
//   - Grammar-poison (terminal, zero publish attempts): the row's
//     (event_type, version) cannot produce a grammar-valid subject
//     (subjects.go). The relay refuses to publish what the catalog naming
//     convention rejects, and poisons immediately — retrying a malformed
//     name can never succeed.
//   - Attempt-poison (after budget exhaustion): publishing failed
//     OUTBOX_MAX_ATTEMPTS times. Each failed attempt is committed (attempts
//     +1, last_error recorded) so operators can see how hard the broker was
//     tried before the row gave up.
//
// Poisoned rows are the DLQ: they leave the pending stream (so they cannot
// reorder or block their successors) and stay queryable for the runbook in
// README.md ("DLQ runbook"). `worker replay poisons` requeues them; the
// relay then republishes under the SAME (org_id, event_id) — consumers and
// the JetStream Nats-Msg-Id dedup key stay idempotent.
//
// Structured logging carries event_id and event_type only — never payload
// bytes (payloads can carry customer identifiers; ids cannot be reassembled
// into PII).

// exhaustsBudget is the pure poison decision: a row that has just consumed
// its attempt-th failure is poisoned when attempts reaches MaxAttempts.
func exhaustsBudget(attempts, maxAttempts int) bool {
	return attempts >= maxAttempts
}

// poisonInvalid poisons a row whose envelope cannot yield a valid subject.
// attempts is left untouched — the event was never attempted, so the record
// shows a terminal grammar refusal, not a broker failure.
func (r *Relay) poisonInvalid(ctx context.Context, tx pgx.Tx, row *batchRow, cause error) error {
	_, err := tx.Exec(ctx,
		`UPDATE outbox_events SET status = 'poisoned', last_error = $2 WHERE id = $1`,
		row.ID, cause.Error())
	if err != nil {
		return err
	}
	r.log.Error("outbox.poisoned",
		"event_id", row.EventID,
		"event_type", row.EventType,
		"attempts", row.Attempts,
		"reason", "subject_grammar",
		"error", cause.Error())
	return nil
}

// markFailed records one failed publish attempt: attempts +1 and last_error
// committed, status pending — unless the attempt budget is exhausted, in
// which case the row is poisoned (DLQ). Reports whether the row was poisoned
// so the caller can account it.
func (r *Relay) markFailed(ctx context.Context, tx pgx.Tx, row *batchRow, cause error) (poisoned bool, err error) {
	attempts := row.Attempts + 1
	if exhaustsBudget(attempts, r.cfg.MaxAttempts) {
		_, err := tx.Exec(ctx,
			`UPDATE outbox_events SET status = 'poisoned', attempts = $2, last_error = $3 WHERE id = $1`,
			row.ID, attempts, cause.Error())
		if err != nil {
			return false, err
		}
		r.log.Error("outbox.poisoned",
			"event_id", row.EventID,
			"event_type", row.EventType,
			"attempts", attempts,
			"max_attempts", r.cfg.MaxAttempts,
			"reason", "attempts_exhausted",
			"error", cause.Error())
		return true, nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE outbox_events SET attempts = $2, last_error = $3 WHERE id = $1`,
		row.ID, attempts, cause.Error())
	if err != nil {
		return false, err
	}
	r.log.Warn("outbox.publish_failed",
		"event_id", row.EventID,
		"event_type", row.EventType,
		"attempt", attempts,
		"max_attempts", r.cfg.MaxAttempts,
		"error", cause.Error())
	return false, nil
}
