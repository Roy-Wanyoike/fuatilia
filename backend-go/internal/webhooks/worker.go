package webhooks

// The delivery worker: claims due deliveries from PostgreSQL, signs the
// canonical envelope with the endpoint's resolved secret, POSTs it through
// the INJECTED transport, and records the outcome through the ladder — the
// pure attempts.ts semantics executed against the real database.
//
// Constraint map (issue #91):
//
//   - Attempt record + ladder advance in ONE transaction → store.RecordFailure;
//     delivery execution (network I/O) OUTSIDE any transaction → processClaim
//     runs between two short store transactions; claim locks are released at
//     the claim commit, strictly before the POST.
//   - Revoked/disabled endpoints never deliver → the claim query joins
//     webhook_endpoints ON e.active.
//   - Graceful shutdown: Run observes ctx; SIGTERM stops CLAIMING, while the
//     in-flight delivery completes or times out (its context is detached from
//     the run context and bounded by Config.DeliveryTimeout), its outcome is
//     recorded, and only then does the worker exit. Run(nil-error) on
//     cancellation — testable via context cancellation.
//   - HTTP transport injected → the Transport port; httptest fakes in tests.
//   - Secrets: SigningKeys is the port; the schema (0012) stores only hashes,
//     so nothing here can ever read a plaintext secret from the database — a
//     KMS adapter is the production drop-in.
//
// At-least-once: a crash between POST and record leaves the row `delivering`
// until the claim lease (Config.ClaimLease) expires; the next claim re-POSTs
// it. Receivers dedupe by event id — the aggregateId of the signed envelope.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// SigningKeys resolves the signing secret for an endpoint. Production binds
// EnvSigningKeys (keys.go — the env-backed default; see
// docs/security/secrets.md for the rotation path) or a KMS adapter here
// (0012 stores endpoint secrets HASHED — secret_hash / secret_prefix are
// identification references, never plaintext); the port keeps this worker
// honest: it cannot sign with a secret it could not resolve, and
// implementations must never embed secret material in errors.
type SigningKeys interface {
	SecretFor(ctx context.Context, orgID, endpointID string) (string, error)
}

// Transport performs one signed delivery attempt. A non-nil error means the
// request failed at transport level (network, timeout); otherwise the HTTP
// status classifies the outcome. Injected — tests use httptest servers and
// scripted fakes.
type Transport interface {
	Deliver(ctx context.Context, endpointURL, signatureHeader string, payload []byte) (int, error)
}

// Worker defaults — overridable through Config.
const (
	// DefaultPollInterval is the idle wait when nothing was due.
	DefaultPollInterval = time.Second
	// DefaultDeliveryTimeout bounds one POST (and the in-flight completion
	// after SIGTERM: the delivery completes or times out).
	DefaultDeliveryTimeout = 15 * time.Second
	// DefaultClaimLease is how long a claim (state `delivering` + stamped
	// updated_at) is honored before a peer may steal the delivery. It must
	// comfortably exceed DefaultDeliveryTimeout.
	DefaultClaimLease = 2 * time.Minute
)

// Config configures a Worker. Zero fields fall back to the documented
// defaults; invalid explicit values are refused by ResolveConfig.
type Config struct {
	// PollInterval is the idle wait between cycles that found nothing due.
	PollInterval time.Duration
	// DeliveryTimeout bounds one in-flight delivery (POST + completion on
	// shutdown). A delivery that outlives it is recorded as a failed attempt
	// ("delivery timed out") and retried per the ladder.
	DeliveryTimeout time.Duration
	// ClaimLease is the claim-holding window before a stuck `delivering` row
	// becomes claimable again (crash recovery). Must exceed DeliveryTimeout.
	ClaimLease time.Duration
	// Ladder is the retry schedule; nil falls back to DefaultRetryLadder
	// (attempts.ts DEFAULT_RETRY_LADDER_MS).
	Ladder []time.Duration
	// Clock is the injected time port — every claim, schedule and attempt
	// timestamp flows through it (deterministic tests inject a fixed clock).
	Clock infra.Clock
	// Logger receives per-cycle and per-failure records. Payload bytes and
	// secret material never appear — ids, statuses and counts only.
	Logger *slog.Logger
}

// ResolveConfig validates cfg and fills zero fields with the documented
// defaults — New enforces exactly what this returns.
func ResolveConfig(cfg Config) (Config, error) {
	if cfg.PollInterval == 0 {
		cfg.PollInterval = DefaultPollInterval
	}
	if cfg.PollInterval < 0 {
		return cfg, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("poll interval must be >= 0, got %s", cfg.PollInterval)}
	}
	if cfg.DeliveryTimeout == 0 {
		cfg.DeliveryTimeout = DefaultDeliveryTimeout
	}
	if cfg.DeliveryTimeout < 0 {
		return cfg, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("delivery timeout must be >= 0, got %s", cfg.DeliveryTimeout)}
	}
	if cfg.ClaimLease == 0 {
		cfg.ClaimLease = DefaultClaimLease
	}
	if cfg.ClaimLease < cfg.DeliveryTimeout {
		return cfg, &Error{Code: CodeConfigInvalid,
			Message: fmt.Sprintf("claim lease %s must be >= delivery timeout %s (an in-flight delivery must not lose its claim)", cfg.ClaimLease, cfg.DeliveryTimeout)}
	}
	if len(cfg.Ladder) == 0 {
		cfg.Ladder = DefaultRetryLadder
	}
	if err := AssertRetryLadder(cfg.Ladder); err != nil {
		return cfg, err
	}
	if cfg.Clock == nil {
		cfg.Clock = infra.SystemClock{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return cfg, nil
}

// Worker executes the delivery ladder. Create with New; drive with Run (or
// step manually with RunOnce). Safe for concurrent use: run as many workers
// as you like over the same schema — the SKIP LOCKED claim distributes rows
// and the record guard collapses duplicated outcomes.
type Worker struct {
	store     *Store
	keys      SigningKeys
	transport Transport
	cfg       Config
	clock     infra.Clock
	log       *slog.Logger

	// afterPost is the package-private fault-injection point required by the
	// issue's restart-safety proof: when non-nil it is invoked after the POST
	// has completed but BEFORE the outcome is recorded. Returning an error
	// simulates a process crash at the exact at-least-once seam — the row
	// stays `delivering` and a fresh worker redelivers it after the lease.
	// Production code never sets it.
	afterPost func(c Claimed) error
}

// New validates cfg and wires a Worker over pool, keys and transport.
func New(pool *pgxpool.Pool, keys SigningKeys, transport Transport, cfg Config) (*Worker, error) {
	cfg, err := ResolveConfig(cfg)
	if err != nil {
		return nil, err
	}
	if pool == nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: "pool is required"}
	}
	if keys == nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: "signing keys port is required"}
	}
	if transport == nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: "transport is required"}
	}
	return &Worker{
		store:     NewStore(pool, cfg.Clock),
		keys:      keys,
		transport: transport,
		cfg:       cfg,
		clock:     cfg.Clock,
		log:       cfg.Logger,
	}, nil
}

// Run drives delivery cycles until ctx is cancelled (SIGTERM/SIGINT in a
// production binary). Cancellation stops claiming; the in-flight delivery
// completes or times out, its outcome is recorded, and Run returns nil —
// graceful drain. Infrastructure failures are logged and retried on the next
// tick; the worker stays up.
func (w *Worker) Run(ctx context.Context) error {
	for {
		progressed, err := w.RunOnce(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil // graceful stop — the in-flight delivery already drained
			}
			w.log.Error("webhooks.cycle_failed", "error", err.Error())
		}
		if ctx.Err() != nil {
			return nil
		}
		if progressed && err == nil {
			continue // work is waiting — claim the next delivery immediately
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(w.cfg.PollInterval):
		}
	}
}

// RunOnce performs one cycle: claim at most one due delivery and carry it
// through POST + record. Reports whether a delivery was processed.
func (w *Worker) RunOnce(ctx context.Context) (bool, error) {
	if ctx.Err() != nil {
		return false, nil
	}
	claimed, err := w.store.ClaimDue(ctx, w.cfg.ClaimLease)
	if err != nil {
		return false, err
	}
	if claimed == nil {
		return false, nil
	}
	if err := w.processClaim(ctx, *claimed); err != nil {
		return true, err
	}
	return true, nil
}

// errorBudget bounds one detached phase of an in-flight completion (key
// resolution, outcome recording) after the run context is cancelled.
const errorBudget = 10 * time.Second

// processClaim carries one claimed delivery to a recorded outcome: sign →
// POST (outside any transaction) → record. Every phase runs on a context
// DETACHED from the run context (shutdown cannot kill an in-flight delivery,
// only its own timeout can) — the graceful-shutdown contract.
func (w *Worker) processClaim(ctx context.Context, c Claimed) error {
	// 1. Resolve the signing secret through the port (never from the schema).
	keyCtx, cancelKey := context.WithTimeout(context.WithoutCancel(ctx), errorBudget)
	defer cancelKey()
	secret, err := w.keys.SecretFor(keyCtx, c.OrgID, c.EndpointID)
	if err != nil {
		return w.recordFailure(ctx, c, fmt.Sprintf("signing key unavailable: %v", err))
	}

	// 2. Sign the canonical envelope: `<unixMillis>.<payload>`, stdlib
	//    HMAC-SHA256, header `t=<unixMillis>,v1=<hex>`.
	envelope := BuildCanonicalEnvelope(c.EventType, c.EventID, c.OrgID, c.CreatedAt, c.Payload)
	sig, err := Sign(string(envelope), secret, w.clock.Now().UnixMilli(), HMACSHA256)
	if err != nil {
		return w.recordFailure(ctx, c, fmt.Sprintf("signing failed: %v", err))
	}

	// 3. POST — network I/O strictly outside any transaction (the claim lock
	//    was released at the claim commit).
	deliverCtx, cancelDeliver := context.WithTimeout(context.WithoutCancel(ctx), w.cfg.DeliveryTimeout)
	defer cancelDeliver()
	status, deliverErr := w.transport.Deliver(deliverCtx, c.EndpointURL, FormatSignatureHeader(sig), envelope)

	// Fault-injection seam (restart-safety proof): crash after POST, before
	// record. The row stays `delivering`; lease recovery redelivers it.
	if w.afterPost != nil {
		if hookErr := w.afterPost(c); hookErr != nil {
			return fmt.Errorf("webhooks: simulated crash after POST of delivery %s (event %s): %w", c.ID, c.EventID, hookErr)
		}
	}

	// 4. Record the attempt + advance the ladder — one transaction in store.
	outcome := classifyAttempt(status, deliverErr)
	if outcome.Success {
		recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), errorBudget)
		defer cancel()
		recorded, err := w.store.RecordSuccess(recordCtx, c.ID, c.AttemptNo, w.clock.Now())
		if err != nil {
			return err
		}
		if recorded {
			w.log.Info("webhooks.delivered",
				"delivery_id", c.ID, "event_id", c.EventID, "event_type", c.EventType,
				"endpoint_id", c.EndpointID, "attempt_no", c.AttemptNo, "status", status)
		} else {
			w.log.Warn("webhooks.claim_lost_outcome_discarded",
				"delivery_id", c.ID, "event_id", c.EventID, "outcome", "success")
		}
		return nil
	}
	return w.recordFailure(ctx, c, outcome.Reason)
}

// recordFailure commits the failed-attempt record + ladder advance and logs
// the transition (deliveryFailed willRetry:true / dead-letter terminal).
func (w *Worker) recordFailure(ctx context.Context, c Claimed, reason string) error {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), errorBudget)
	defer cancel()
	record, err := w.store.RecordFailure(recordCtx, c.ID, c.AttemptNo, reason, w.clock.Now(), w.cfg.Ladder)
	if err != nil {
		return err
	}
	if !record.Recorded {
		w.log.Warn("webhooks.claim_lost_outcome_discarded",
			"delivery_id", c.ID, "event_id", c.EventID, "outcome", reason)
		return nil
	}
	if record.DeadLettered {
		w.log.Warn("webhooks.dead_lettered",
			"delivery_id", c.ID, "event_id", c.EventID, "event_type", c.EventType,
			"endpoint_id", c.EndpointID, "attempts", c.AttemptNo, "failure_reason", reason)
		return nil
	}
	w.log.Info("webhooks.delivery_failed",
		"delivery_id", c.ID, "event_id", c.EventID, "event_type", c.EventType,
		"endpoint_id", c.EndpointID, "attempt_no", c.AttemptNo,
		"failure_reason", reason, "will_retry", record.WillRetry,
		"next_attempt_at", formatNextAttempt(record.NextAttemptAt))
	return nil
}

// attempt outcome classification (ladder parity note): attempts.ts does not
// distinguish 4xx, 5xx or network errors — every non-2xx wire result is a
// `failure` with a reason, and the ladder schedule is identical for all of
// them. The reason string is the only difference (audit detail, never secret
// material).
func classifyAttempt(status int, err error) AttemptOutcome {
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return AttemptOutcome{Success: false, Reason: "delivery timed out"}
		}
		return AttemptOutcome{Success: false, Reason: fmt.Sprintf("transport error: %v", err)}
	}
	if status >= 200 && status <= 299 {
		return AttemptOutcome{Success: true}
	}
	return AttemptOutcome{Success: false, Reason: fmt.Sprintf("endpoint returned http %d", status)}
}

func formatNextAttempt(t *time.Time) string {
	if t == nil {
		return ""
	}
	return MillisecondISO(*t)
}
