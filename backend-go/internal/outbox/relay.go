// Package outbox is the production transactional-outbox relay (ADR-0003,
// issue #74): it drains outbox_events (db/migrations/0013_audit_outbox.sql —
// the PostgreSQL face of src/domain/events/outbox.ts) and publishes every
// envelope to NATS JetStream, at-least-once, in per-org append order.
//
// Delivery contract (full detail in README.md):
//
//   - At-least-once: publish-then-mark in-cycle. Rows are selected FOR UPDATE
//     SKIP LOCKED under a per-org transaction advisory lock, each row is
//     published to JetStream and only then marked published — inside one
//     transaction per org batch. A crash between publish and mark rolls the
//     batch back, so the exact unmarked set is redelivered on restart;
//     duplicates are bounded by the batch window and collapsed for consumers
//     by the JetStream Nats-Msg-Id dedup key.
//   - Per-org order: one org's pending rows are processed strictly in
//     (created_at, id) order, and a failed publish stops that org's batch so
//     no successor can overtake it — two concurrent relays never reorder or
//     double-publish an org's stream (the concurrency proof lives in
//     jetstream_test.go).
//   - Envelope fidelity: the payload column's canonical JSON bytes are
//     published verbatim (buildEnvelope). The relay never re-encodes,
//     re-types or re-rounds a payload byte; money stays the integer literal
//     the producer wrote and is never parsed.
//   - Poison: a row whose publish fails OUTBOX_MAX_ATTEMPTS times, or whose
//     (event_type, version) cannot produce a grammar-valid subject, is
//     marked poisoned — the DLQ — requeueable through the replay CLI
//     (replay.go, cmd/worker).
//
// The relay never mutates financial state: its entire database footprint is
// SELECT plus status/attempts bookkeeping on outbox_events (the
// least-privilege role is documented in README.md). Consumers MUST be
// idempotent by eventId forever — at-least-once is the fabric's contract,
// exactly as ADR-0003 and the Daraja intake precedent (R9) assume.
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"
)

// Stable machine codes (SCREAMING_SNAKE_CASE), mirroring the TS families
// this package enforces at the wire: the first two are envelope.ts's own
// codes — the relay is the final enforcement point of the same rules.
const (
	CodeEventNameMalformed      = "EVENT_NAME_MALFORMED"
	CodeEventVersionUnsupported = "EVENT_VERSION_UNSUPPORTED"
	CodeReplayRangeInvalid      = "OUTBOX_REPLAY_RANGE_INVALID"
	CodeConfigInvalid           = "OUTBOX_CONFIG_INVALID"
)

// Error is the only error type this package produces: a stable machine Code
// plus a human Message. Errors are values — match with errors.As and compare
// Code, exactly like pkg/money and pkg/idempotency.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Relay defaults — overridable through Config (env mapping in cmd/worker).
const (
	// DefaultBatchSize caps one org's batch per cycle (OUTBOX_BATCH). It is
	// also the worst-case duplicate window after a crash between publish and
	// mark.
	DefaultBatchSize = 100
	// DefaultPollInterval is the idle wait between cycles (OUTBOX_POLL_INTERVAL).
	DefaultPollInterval = time.Second
	// DefaultMaxAttempts is the publish-attempt budget before a row is
	// poisoned into the DLQ (OUTBOX_MAX_ATTEMPTS).
	DefaultMaxAttempts = 5
	// DefaultDuplicateWindow is the JetStream server-side dedup window keyed
	// by Nats-Msg-Id ("<org_id>:<event_id>"). It must comfortably exceed the
	// poll interval plus a batch publish so crash redeliveries collapse
	// instead of duplicating consumer-visible messages.
	DefaultDuplicateWindow = 2 * time.Minute
)

// Config configures a Relay. Zero fields fall back to the documented
// defaults; negative/zero explicit values are refused by New.
type Config struct {
	// BatchSize caps how many pending rows one org contributes to a cycle.
	BatchSize int
	// PollInterval is the idle wait between cycles.
	PollInterval time.Duration
	// MaxAttempts is the publish-attempt budget before poisoning.
	MaxAttempts int
	// Logger receives the structured per-cycle and per-failure records.
	// Payload bytes are never logged — event_id and event_type only.
	Logger *slog.Logger
}

// batchRow is one outbox_events row as handed to the publish loop.
type batchRow struct {
	ID        string // outbox row id (uuid::text)
	OrgID     string // tenant root (uuid::text)
	EventID   string // the envelope eventId — consumers dedupe on it
	EventType string // the envelope name, e.g. "payment.confirmed"
	Version   int    // envelope payload schema version
	Payload   []byte // canonical jsonb text — published VERBATIM
	Attempts  int    // committed publish attempts so far
	CreatedAt time.Time
}

// cycleStats aggregates one RunOnce across orgs.
type cycleStats struct {
	orgs      int
	taken     int
	published int
	failed    int
	poisoned  int
	skipped   int
}

// Relay drains outbox_events into JetStream. It is safe for concurrent use
// as long as each Relay owns its own pool and connection; the intended
// production shape is one Relay per process (see README "Deployment").
type Relay struct {
	pool *pgxpool.Pool
	js   nats.JetStreamContext
	cfg  Config
	log  *slog.Logger

	// afterPublish is the package-private fault-injection point required by
	// issue #74's crash-safety proof: when non-nil it is invoked after a row
	// has been published to JetStream but BEFORE the row is marked published,
	// inside the open batch transaction. Returning an error simulates a
	// process crash at the exact at-least-once seam (publish done, mark not):
	// the transaction aborts, nothing is marked, and a fresh relay must
	// redeliver the unmarked set. Production code never sets it.
	afterPublish func(row batchRow) error
}

// ResolveConfig validates cfg and fills zero fields with the documented
// defaults. It is exported so the worker binary can log the EFFECTIVE
// configuration at startup, and New enforces exactly what it returns.
func ResolveConfig(cfg Config) (Config, error) {
	if cfg.BatchSize == 0 {
		cfg.BatchSize = DefaultBatchSize
	}
	if cfg.BatchSize < 1 {
		return cfg, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("batch size must be >= 1, got %d", cfg.BatchSize)}
	}
	if cfg.PollInterval == 0 {
		cfg.PollInterval = DefaultPollInterval
	}
	if cfg.PollInterval < 0 {
		return cfg, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("poll interval must be >= 0, got %s", cfg.PollInterval)}
	}
	if cfg.MaxAttempts == 0 {
		cfg.MaxAttempts = DefaultMaxAttempts
	}
	if cfg.MaxAttempts < 1 {
		return cfg, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("max attempts must be >= 1, got %d", cfg.MaxAttempts)}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return cfg, nil
}

// New validates cfg (zero fields become the documented defaults) and returns
// a Relay over pool and js.
func New(pool *pgxpool.Pool, js nats.JetStreamContext, cfg Config) (*Relay, error) {
	cfg, err := ResolveConfig(cfg)
	if err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: "pool is required"}
	}
	if js == nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: "jetstream context is required"}
	}
	return &Relay{pool: pool, js: js, cfg: cfg, log: cfg.Logger}, nil
}

// Run drives relay cycles until ctx is cancelled (SIGTERM in cmd/worker).
// The first cycle starts immediately. A cycle that fails on transient
// infrastructure (database or broker unreachable) is logged and retried on
// the next tick — the worker stays up. Graceful-drain semantics: the
// in-flight org batch always completes (its marks commit), cancellation is
// only observed between org batches, so a SIGTERM never strands half a batch.
func (r *Relay) Run(ctx context.Context) error {
	for {
		if err := r.RunOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil // graceful stop — the in-flight batch already drained
			}
			r.log.Error("outbox.cycle_failed", "error", err.Error())
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(r.cfg.PollInterval):
		}
	}
}

// RunOnce performs one relay cycle: measure lag, take every org that has
// pending work (oldest org first), and drain a bounded batch per org.
func (r *Relay) RunOnce(ctx context.Context) error {
	lag, err := r.pendingLag(ctx)
	if err != nil {
		return fmt.Errorf("outbox: lag probe: %w", err)
	}
	orgs, err := r.candidateOrgs(ctx)
	if err != nil {
		return fmt.Errorf("outbox: candidate orgs: %w", err)
	}
	var stats cycleStats
	var loopErr error
	for _, org := range orgs {
		// Graceful-drain stop point: between org batches. The batch in
		// flight when SIGTERM arrived has already completed and committed.
		if ctx.Err() != nil {
			loopErr = ctx.Err()
			break
		}
		s, err := r.drainOrg(ctx, org)
		stats.orgs++
		stats.taken += s.taken
		stats.published += s.published
		stats.failed += s.failed
		stats.poisoned += s.poisoned
		stats.skipped += s.skipped
		if err != nil {
			loopErr = err
			break
		}
	}
	// Per-cycle observability record (issue #74): batch size, published,
	// poison count, lag rows + oldest pending age. Payload bytes and PII
	// never appear here — counts and ids only.
	r.log.Info("outbox.cycle",
		"orgs", stats.orgs,
		"batch", stats.taken,
		"published", stats.published,
		"failed", stats.failed,
		"poisoned", stats.poisoned,
		"skipped_locked", stats.skipped,
		"lag_rows", lag.rows,
		"lag_oldest_ms", lag.oldestMS,
	)
	return loopErr
}

// pendingLag measures the backlog: pending rows and the age of the oldest.
func (r *Relay) pendingLag(ctx context.Context) (lagStats, error) {
	var lag lagStats
	var oldest *time.Time
	err := r.pool.QueryRow(ctx,
		`SELECT count(*), min(created_at) FROM outbox_events WHERE status = 'pending'`,
	).Scan(&lag.rows, &oldest)
	if err != nil {
		return lag, err
	}
	if oldest != nil {
		lag.oldestMS = time.Since(*oldest).Milliseconds()
		if lag.oldestMS < 0 {
			lag.oldestMS = 0
		}
	}
	return lag, nil
}

type lagStats struct {
	rows     int64
	oldestMS int64
}

// candidateOrgs lists orgs with pending work, oldest backlog first, so a
// relay always chews on the stalest org before the freshest.
func (r *Relay) candidateOrgs(ctx context.Context) ([]string, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT org_id::text FROM outbox_events WHERE status = 'pending' `+
			`GROUP BY org_id ORDER BY min(created_at), org_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var orgs []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, err
		}
		orgs = append(orgs, org)
	}
	return orgs, rows.Err()
}

// drainOrg takes one locked batch of a single org and publishes it in order.
//
// Concurrency protocol (the SKIP LOCKED proof under jetstream_test.go):
//
//  1. pg_try_advisory_xact_lock(hashtextextended(org, 0)) — only one relay
//     works an org at any instant; losers skip the org this cycle instead of
//     blocking (a second relay on other orgs keeps making progress).
//  2. SELECT ... FOR UPDATE SKIP LOCKED — belt and braces on top of the
//     advisory lock: rows locked by any other transaction (e.g. a replay
//     racing this cycle) are skipped, never double-published.
//  3. publish-then-mark per row inside THIS transaction; a failure stops the
//     org's batch so no successor overtakes the failed event.
//
// The transaction commits only after every publish of the batch succeeded
// (or was recorded as failed/poisoned), so a crash rolls the whole batch back
// to pending — the at-least-once seam.
func (r *Relay) drainOrg(ctx context.Context, orgID string) (orgStats, error) {
	var s orgStats
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return s, fmt.Errorf("outbox: begin org %s batch: %w", orgID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }() // no-op after Commit

	var locked bool
	if err := tx.QueryRow(ctx,
		`SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0))`, orgID,
	).Scan(&locked); err != nil {
		return s, fmt.Errorf("outbox: advisory lock org %s: %w", orgID, err)
	}
	if !locked {
		// Another relay is draining this org right now — skip, don't block.
		s.skipped++
		return s, nil
	}

	rows, err := tx.Query(ctx,
		`SELECT id::text, org_id::text, event_id::text, event_type, version, payload, attempts, created_at
                   FROM outbox_events
                  WHERE status = 'pending' AND org_id = $1
                  ORDER BY created_at, id
                  LIMIT $2
                  FOR UPDATE SKIP LOCKED`, orgID, r.cfg.BatchSize)
	if err != nil {
		return s, fmt.Errorf("outbox: select org %s batch: %w", orgID, err)
	}
	var batch []batchRow
	for rows.Next() {
		var b batchRow
		if err := rows.Scan(&b.ID, &b.OrgID, &b.EventID, &b.EventType, &b.Version, &b.Payload, &b.Attempts, &b.CreatedAt); err != nil {
			rows.Close()
			return s, fmt.Errorf("outbox: scan org %s batch: %w", orgID, err)
		}
		batch = append(batch, b)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return s, fmt.Errorf("outbox: iterate org %s batch: %w", orgID, err)
	}
	rows.Close()
	s.taken = len(batch)

	for i := range batch {
		row := batch[i]
		subject, serr := SubjectFor(row.EventType, row.Version)
		if serr != nil {
			// Grammar-invalid rows never reach the wire. Poison them and let
			// their successors proceed — a poisoned row is terminal, so it
			// cannot reorder the pending stream behind it.
			if perr := r.poisonInvalid(ctx, tx, &row, serr); perr != nil {
				return s, perr
			}
			s.poisoned++
			continue
		}
		if perr := r.publish(ctx, subject, &row); perr != nil {
			poisoned, ferr := r.markFailed(ctx, tx, &row, perr)
			if ferr != nil {
				return s, fmt.Errorf("outbox: record failure event %s: %w", row.EventID, ferr)
			}
			s.failed++
			if poisoned {
				s.poisoned++
			}
			// Per-org ordering: never let a successor overtake a failed
			// event. The failed row stays pending; the next cycle retries
			// it (and the rest of the batch) from here.
			break
		}
		// Crash-safety seam (issue #74 fault injection): publish succeeded,
		// mark not yet written. Tests fail this hook to simulate a process
		// death between the two steps; production never sets it.
		if r.afterPublish != nil {
			if herr := r.afterPublish(row); herr != nil {
				return s, fmt.Errorf("outbox: simulated crash after publish of event %s (org %s): %w",
					row.EventID, row.OrgID, herr)
			}
		}
		if err := r.markPublished(ctx, tx, &row); err != nil {
			return s, fmt.Errorf("outbox: mark event %s published: %w", row.EventID, err)
		}
		s.published++
	}

	if err := tx.Commit(ctx); err != nil {
		return s, fmt.Errorf("outbox: commit org %s batch: %w", orgID, err)
	}
	return s, nil
}

type orgStats struct {
	taken     int
	published int
	failed    int
	poisoned  int
	skipped   int
}

// publish sends one envelope to JetStream synchronously (the ack is awaited
// before the row is marked) with the server-side dedup key
// Nats-Msg-Id = "<org_id>:<event_id>".
func (r *Relay) publish(ctx context.Context, subject string, row *batchRow) error {
	msg := &nats.Msg{Subject: subject, Data: buildEnvelope(row), Header: nats.Header{}}
	msg.Header.Set(nats.MsgIdHdr, row.OrgID+":"+row.EventID)
	_, err := r.js.PublishMsg(msg, nats.Context(ctx))
	return err
}

// markPublished stamps the row published — only ever called after the
// broker acked the publish, inside the batch transaction.
func (r *Relay) markPublished(ctx context.Context, tx pgx.Tx, row *batchRow) error {
	_, err := tx.Exec(ctx,
		`UPDATE outbox_events
                    SET status = 'published', published_at = now(), attempts = attempts + 1, last_error = NULL
                  WHERE id = $1`, row.ID)
	return err
}

// buildEnvelope renders the wire JSON for an outbox row:
//
//	{"eventId":"…","name":"…","version":1,"orgId":"…","createdAt":"…","payload":<verbatim>}
//
// The payload region is the row's canonical jsonb text appended BYTE FOR
// BYTE — manual assembly (not encoding/json re-marshalling) is deliberate so
// "published verbatim" is true by construction, not by library behaviour:
// no re-encoding, no key reordering, no number reinterpretation, no float
// conversion of money. eventId/org_id come from PostgreSQL's uuid type
// (charset [0-9a-f-]) and createdAt from RFC 3339 formatting — the only
// free-form string, event_type, goes through strict JSON escaping below.
func buildEnvelope(row *batchRow) []byte {
	buf := make([]byte, 0, len(row.Payload)+192)
	buf = append(buf, `{"eventId":"`...)
	buf = append(buf, row.EventID...)
	buf = append(buf, `","name":`...)
	buf = appendJSONString(buf, row.EventType)
	buf = append(buf, `,"version":`...)
	buf = strconv.AppendInt(buf, int64(row.Version), 10)
	buf = append(buf, `,"orgId":"`...)
	buf = append(buf, row.OrgID...)
	buf = append(buf, `","createdAt":"`...)
	buf = append(buf, row.CreatedAt.UTC().Format(time.RFC3339Nano)...)
	buf = append(buf, `","payload":`...)
	buf = append(buf, row.Payload...)
	buf = append(buf, '}')
	return buf
}

// appendJSONString appends s as a strict RFC 8259 JSON string (used for the
// only metadata field that originates as free-form text: event_type).
func appendJSONString(buf []byte, s string) []byte {
	enc, err := json.Marshal(s) // never fails for string inputs
	if err != nil {
		return append(buf, `""`...)
	}
	return append(buf, enc...)
}

// EnsureStream idempotently provisions the FUATILIA_EVENTS stream (ADR-0003):
// subjects fuatilia.>, limits retention on file storage, Nats-Msg-Id dedup
// window DefaultDuplicateWindow. The design decision (single stream vs.
// WorkQueue-per-subject) and its rationale are recorded in README.md. An
// existing stream is left untouched — the relay never fights an operator's
// tuned configuration; it only guarantees the minimum (subjects + dedup).
func EnsureStream(ctx context.Context, js nats.JetStreamContext) error {
	_, err := js.StreamInfo(StreamName)
	switch {
	case err == nil:
		return nil
	case errors.Is(err, nats.ErrStreamNotFound):
		_, err := js.AddStream(&nats.StreamConfig{
			Name:       StreamName,
			Subjects:   []string{SubjectFilter},
			Retention:  nats.LimitsPolicy,
			Storage:    nats.FileStorage,
			Discard:    nats.DiscardOld,
			Duplicates: DefaultDuplicateWindow,
		}, nats.Context(ctx))
		if err != nil {
			return fmt.Errorf("outbox: create stream %s: %w", StreamName, err)
		}
		return nil
	default:
		return fmt.Errorf("outbox: inspect stream %s: %w", StreamName, err)
	}
}
