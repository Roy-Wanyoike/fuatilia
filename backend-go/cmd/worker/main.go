// Command worker is the Fuatilia background process surface: it drains the
// transactional outbox (ADR-0003, issue #74) and — env-gated (issue #177) —
// runs the webhook delivery loop (internal/webhooks, PR #125): claim due
// webhook_deliveries rows, sign the canonical envelope with the endpoint's
// resolved secret, POST via the delivery transport, record through the
// attempt ladder. It never mutates financial state.
//
// Usage:
//
//	worker                          # run the relay + (gated) webhook loop until SIGTERM/SIGINT
//	worker replay poisons           # requeue the whole DLQ (poisoned rows)
//	worker replay --from T --to T   # republish events appended in [from, to)
//
// Configuration (environment; see internal/outbox/README.md for semantics):
//
//	DATABASE_URL           required — least-privilege relay role (SELECT/UPDATE
//	                       on outbox_events only; grants in the outbox README)
//	NATS_URL               default nats://127.0.0.1:4222 — credentials belong
//	                       in the URL or NATS env, never in code or logs
//	OUTBOX_BATCH           default 100  — max rows per org per cycle
//	OUTBOX_POLL_INTERVAL   default 1s   — idle wait between cycles (Go duration)
//	OUTBOX_MAX_ATTEMPTS    default 5    — publish attempts before poisoning
//	FUATILIA_METRICS_ADDR  unset = off  — when set (e.g. ":9090"), serves the
//	                       Prometheus exposition at /metrics on that address;
//	                       the relay runs HERE, so the lag/DLQ series are
//	                       exposed here, not on the api process
//
// Webhook delivery loop (issue #177), in addition to the relay variables:
//
//	WEBHOOKS_ENABLED         default off — a ParseBool truthy value ("1",
//	                         "true", …) boots the loop alongside the relay
//	WEBHOOK_SIGNING_SECRETS  required when enabled — entries of
//	                         <orgUUID>:<endpointUUID>:<secret>, comma or
//	                         newline separated (webhooks.ParseEnvSigningKeys)
//
// The event source is PostgreSQL itself: a webhook claim needs the row's
// transactional state machine (claim → `delivering` → record under FOR UPDATE
// SKIP LOCKED, distributed across replicas), so the loop consumes the table
// directly and deliberately does NOT ride NATS — the outbox relay publishes
// the same domain events downstream for every other consumer. Enabling the
// loop without at least one usable signing secret is a boot failure: a worker
// that could not sign would only dead-letter real deliveries (fail closed).
// Secrets live in the deployment env until a KMS adapter binds the same
// SigningKeys port at this wiring site — rotation and the hash-only schema
// contract are documented in docs/security/secrets.md.
//
// Graceful shutdown: SIGTERM/SIGINT lets the in-flight relay org batch finish
// and commit, stops the webhook loop from claiming, lets any in-flight
// delivery complete or time out on a context DETACHED from the run context
// (bounded by its delivery timeout), records its outcome, closes broker and
// pool, and exits 0. Killing between publish/mark or POST/record is always
// safe: the at-least-once recovery paths (unmarked batch redelivery, claim
// lease expiry) redeliver — consumers and receivers are idempotent by id.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats.go"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/outbox"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/webhooks"
)

// Exit codes: 0 = graceful stop / replay done; 1 = configuration or
// infrastructure failure; 2 = CLI usage error.
const (
	exitOK    = 0
	exitFail  = 1
	exitUsage = 2
)

const (
	envDatabaseURL  = "DATABASE_URL"
	envNATSURL      = "NATS_URL"
	envBatch        = "OUTBOX_BATCH"
	envPollInterval = "OUTBOX_POLL_INTERVAL"
	envMaxAttempts  = "OUTBOX_MAX_ATTEMPTS"
	envMetricsAddr  = "FUATILIA_METRICS_ADDR"

	envWebhooksEnabled = "WEBHOOKS_ENABLED"
	envWebhookSecrets  = "WEBHOOK_SIGNING_SECRETS"

	defaultNATSURL = "nats://127.0.0.1:4222"
)

// config is the worker's resolved configuration.
type config struct {
	databaseURL string
	natsURL     string
	metricsAddr string
	relay       outbox.Config

	// webhooks gates the webhook delivery loop; keys is its env-resolved
	// signing binding (nil unless WEBHOOK_SIGNING_SECRETS parsed). When
	// webhooks is true, keys is always non-nil — loadConfig refuses an
	// enabled loop that could not sign.
	webhooks bool
	keys     webhooks.SigningKeys
}

// loadConfig reads the environment through getenv (injectable for tests).
// DATABASE_URL has no default on purpose: a relay pointed at an unintended
// database is worse than a relay that refuses to start.
func loadConfig(getenv func(string) string) (config, error) {
	var c config
	c.databaseURL = getenv(envDatabaseURL)
	if c.databaseURL == "" {
		return c, fmt.Errorf("%s is required (e.g. postgres://relay:…@host:5432/fuatilia?sslmode=disable)", envDatabaseURL)
	}
	c.natsURL = getenv(envNATSURL)
	if c.natsURL == "" {
		c.natsURL = defaultNATSURL
	}
	if v := getenv(envBatch); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, fmt.Errorf("%s must be a positive integer, got %q", envBatch, v)
		}
		c.relay.BatchSize = n
	}
	if v := getenv(envPollInterval); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			return c, fmt.Errorf("%s must be a positive Go duration (e.g. 500ms, 2s), got %q", envPollInterval, v)
		}
		c.relay.PollInterval = d
	}
	if v := getenv(envMaxAttempts); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return c, fmt.Errorf("%s must be a positive integer, got %q", envMaxAttempts, v)
		}
		c.relay.MaxAttempts = n
	}
	// Metrics exposition (issue #176): opt-in by address — a worker that
	// never opens a port stays the zero-config default. Malformed values
	// are boot failures, never silently ignored.
	c.metricsAddr = getenv(envMetricsAddr)
	if c.metricsAddr != "" {
		if _, _, err := net.SplitHostPort(c.metricsAddr); err != nil {
			return c, fmt.Errorf("%s must be a host:port address (e.g. :9090), got %q", envMetricsAddr, c.metricsAddr)
		}
	}
	if v := getenv(envWebhooksEnabled); v != "" {
		on, err := strconv.ParseBool(v)
		if err != nil {
			return c, fmt.Errorf("%s must be a boolean (1/t/TRUE/true, 0/f/FALSE/false), got %q", envWebhooksEnabled, v)
		}
		c.webhooks = on
	}
	if raw := getenv(envWebhookSecrets); raw != "" {
		keys, err := webhooks.ParseEnvSigningKeys(raw)
		if err != nil {
			return c, fmt.Errorf("%s: %w", envWebhookSecrets, err)
		}
		c.keys = keys
	}
	if c.webhooks && c.keys == nil {
		return c, fmt.Errorf("%s is enabled but %s carries no signing secrets — the delivery loop cannot sign, refusing to boot (fail closed)", envWebhooksEnabled, envWebhookSecrets)
	}
	return c, nil
}

// replayRequest is the parsed `replay` subcommand: either the whole DLQ
// (poisons) or a created_at range [from, to).
type replayRequest struct {
	poisons bool
	from    time.Time
	to      time.Time
}

// errReplayUsage signals a malformed replay invocation (usage is then
// printed and the worker exits 2).
var errReplayUsage = errors.New("replay: usage error")

// parseReplayArgs parses `replay` arguments. Sanctioned forms:
//
//	["poisons"]
//	["--from", "<RFC3339>", "--to", "<RFC3339>"]
//
// Mixing the flags with the poisons word, unknown args, or non-advancing
// ranges are usage errors (range ordering itself is validated by
// outbox.ReplayRange with a stable code).
func parseReplayArgs(args []string) (replayRequest, error) {
	fs := flag.NewFlagSet("replay", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	from := fs.String("from", "", "republish events appended at or after this instant (RFC 3339, e.g. 2026-01-31T00:00:00Z)")
	to := fs.String("to", "", "republish events appended before this instant (RFC 3339, exclusive)")
	if err := fs.Parse(args); err != nil {
		return replayRequest{}, errReplayUsage
	}
	switch {
	case fs.NArg() == 1 && fs.Arg(0) == "poisons" && *from == "" && *to == "":
		return replayRequest{poisons: true}, nil
	case fs.NArg() == 0 && *from != "" && *to != "":
		f, err := time.Parse(time.RFC3339, *from)
		if err != nil {
			return replayRequest{}, fmt.Errorf("replay: --from must be RFC 3339 (e.g. 2026-01-31T00:00:00Z): %w", err)
		}
		t, err := time.Parse(time.RFC3339, *to)
		if err != nil {
			return replayRequest{}, fmt.Errorf("replay: --to must be RFC 3339 (e.g. 2026-01-31T00:05:00Z): %w", err)
		}
		return replayRequest{from: f, to: t}, nil
	default:
		return replayRequest{}, errReplayUsage
	}
}

func replayUsage(w io.Writer) {
	fmt.Fprint(w, `usage: worker replay poisons
       worker replay --from <RFC3339> --to <RFC3339>

  poisons        requeue every poisoned event (the DLQ): status pending,
                 attempts reset, last_error cleared; the relay republishes
                 them under the same event_id, so consumers and the JetStream
                 dedup key stay idempotent.

  --from/--to    republish every event appended in [from, to) on created_at
                 (RFC 3339), regardless of status — the projection-rebuild
                 path. Idempotent by (org_id, event_id).
`)
}

func main() {
	os.Exit(run(os.Args[1:]))
}

// run dispatches the CLI: default = relay + (env-gated) webhook loop;
// `replay …` = one-shot DLQ or range replay against the database.
func run(args []string) int {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	slog.SetDefault(logger)

	if len(args) > 0 && args[0] == "replay" {
		return runReplay(args[1:], logger)
	}
	return runRelay(logger)
}

// runRelay is the production long-running mode: connect, ensure the stream,
// relay (and, env-gated, deliver webhooks) until SIGTERM/SIGINT, drain,
// exit 0. DSN and NATS credentials are read from the environment only and
// never logged.
func runRelay(logger *slog.Logger) int {
	return runWorker(context.Background(), logger, os.Getenv, nil)
}

// runWorker is the process composition core the binary executes: load the
// env config, connect to PostgreSQL, compose the env-gated webhook delivery
// loop and the outbox relay over one pool, and drain both on SIGTERM/SIGINT
// (or parent-context cancellation — the seam the integration tests drive).
//
// transport nil selects the production webhooks.HTTPTransport; non-nil (the
// tests) injects a Transport port implementation — the webhooks worker's
// documented injection point. Real deliveries stay on the production path:
// the schema's https-only, no-loopback endpoint constraint cannot point a
// configured endpoint at an in-process receiver.
func runWorker(parent context.Context, logger *slog.Logger, getenv func(string) string, transport webhooks.Transport) int {
	cfg, err := loadConfig(getenv)
	if err != nil {
		logger.Error("worker.config_invalid", "error", err.Error())
		return exitFail
	}

	ctx, stop := signal.NotifyContext(parent, syscall.SIGTERM, os.Interrupt)
	defer stop()

	pool, err := pgxpool.New(ctx, cfg.databaseURL)
	if err != nil {
		logger.Error("worker.database_unreachable", "error", err.Error())
		return exitFail
	}
	defer pool.Close()

	// Observability wiring (issue #176): when the deployment gives the
	// worker a scrape address, the relay feeds the fuatilia_ series —
	// lag/DLQ gauges through the BacklogSource seam and the cycle
	// counters — and the process serves them at /metrics beside the
	// pool gauges. Without the address the relay runs metrics-free.
	var metrics *observability.Metrics
	var metricsServer *http.Server
	if cfg.metricsAddr != "" {
		metrics = observability.NewMetrics(observability.MetricsOptions{})
		metrics.SetPoolSource(poolStatsSource(pool))
		cfg.relay.Metrics = metrics
		metricsServer = &http.Server{
			Addr:              cfg.metricsAddr,
			ReadHeaderTimeout: 5 * time.Second,
			Handler:           metricsServeMux(metrics.Handler()),
		}
	}

	// The webhook loop composes before the broker: it needs only the pool
	// and the env-resolved signing keys, and a broken webhook wiring is a
	// boot failure that must not half-start the process. drainWebhooks is
	// idempotent (sync.Once) so the deferred call covers the early-return
	// paths while the explicit call below orders the drain BEFORE the
	// worker.stopped record — the in-flight delivery records its outcome
	// while the pool is still open (this drain runs before pool.Close).
	var drainWebhooks func()
	if cfg.webhooks {
		if transport == nil {
			transport = webhooks.NewHTTPTransport(nil)
		}
		loop, err := webhooks.New(pool, cfg.keys, transport, webhooks.Config{Logger: logger})
		if err != nil {
			logger.Error("worker.webhooks_invalid", "error", err.Error())
			return exitFail
		}
		webhookDone := make(chan error, 1)
		go func() { webhookDone <- loop.Run(ctx) }()
		var once sync.Once
		drainWebhooks = func() {
			once.Do(func() {
				if err := <-webhookDone; err != nil {
					logger.Error("worker.webhooks_failed", "error", err.Error())
				}
			})
		}
		defer drainWebhooks()
	}

	nc, err := nats.Connect(cfg.natsURL,
		nats.Name("fuatilia-outbox-relay"),
		nats.MaxReconnects(-1), // a worker keeps retrying the broker forever
		nats.ReconnectWait(2*time.Second),
		nats.ReconnectJitter(500*time.Millisecond, 2*time.Second),
		nats.Timeout(5*time.Second),
	)
	if err != nil {
		logger.Error("worker.nats_unreachable", "error", err.Error())
		return exitFail
	}
	defer func() { _ = nc.Drain() }()

	js, err := nc.JetStream()
	if err != nil {
		logger.Error("worker.jetstream_unavailable", "error", err.Error())
		return exitFail
	}
	if err := outbox.EnsureStream(ctx, js); err != nil {
		logger.Error("worker.stream_ensure_failed", "error", err.Error())
		return exitFail
	}

	cfg.relay.Logger = logger
	relay, err := outbox.New(pool, js, cfg.relay)
	if err != nil {
		logger.Error("worker.relay_invalid", "error", err.Error())
		return exitFail
	}

	logger.Info("worker.started",
		"stream", outbox.StreamName,
		"batch", cfg.relay.BatchSize,
		"poll_interval_ms", cfg.relay.PollInterval.Milliseconds(),
		"max_attempts", cfg.relay.MaxAttempts,
		"webhooks", cfg.webhooks,
	)
	if metricsServer != nil {
		go func() {
			logger.Info("worker.metrics_listening", "addr", cfg.metricsAddr)
			if err := metricsServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				logger.Error("worker.metrics_failed", "error", err.Error())
			}
		}()
	}
	if err := relay.Run(ctx); err != nil {
		logger.Error("worker.relay_failed", "error", err.Error())
		return exitFail
	}
	if metricsServer != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = metricsServer.Shutdown(shutdownCtx)
	}
	// Graceful drain: relay stopped between org batches; the webhook loop
	// stopped claiming at the same cancellation and its in-flight
	// delivery (if any) completes or times out here — outcome recorded
	// while the pool is still open. Connections close via the defers.
	if drainWebhooks != nil {
		drainWebhooks()
	}
	logger.Info("worker.stopped")
	return exitOK
}

// poolStatsSource adapts the live pgxpool snapshot onto the observability
// PoolStats port (the metrics package stays pgx-free by design).
func poolStatsSource(pool *pgxpool.Pool) func() observability.PoolStats {
	return func() observability.PoolStats {
		s := pool.Stat()
		return observability.PoolStats{
			Acquired: s.AcquiredConns(),
			Idle:     s.IdleConns(),
			Total:    s.TotalConns(),
			Max:      s.MaxConns(),
		}
	}
}

// metricsServeMux mounts the exposition at /metrics and nothing else —
// GET/HEAD answer, any other method or path refuses (the scrape port is not
// an API surface).
func metricsServeMux(exposition http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL == nil || r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			exposition.ServeHTTP(w, r)
		default:
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	})
}

// runReplay is the one-shot mode: requeue the DLQ or a created_at range, log
// the affected count, exit. It needs the database only — never the broker.
func runReplay(args []string, logger *slog.Logger) int {
	req, err := parseReplayArgs(args)
	if err != nil {
		if !errors.Is(err, errReplayUsage) {
			logger.Error("worker.replay_invalid", "error", err.Error())
		}
		replayUsage(os.Stderr)
		return exitUsage
	}

	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		logger.Error("worker.config_invalid", "error", err.Error())
		return exitFail
	}
	pool, err := pgxpool.New(context.Background(), cfg.databaseURL)
	if err != nil {
		logger.Error("worker.database_unreachable", "error", err.Error())
		return exitFail
	}
	defer pool.Close()

	ctx := context.Background()
	switch {
	case req.poisons:
		n, err := outbox.ReplayPoisons(ctx, pool)
		if err != nil {
			logger.Error("worker.replay_failed", "error", err.Error())
			return exitFail
		}
		logger.Info("worker.replay_poisons", "requeued", n)
		fmt.Printf("requeued %d poisoned event(s)\n", n)
	default:
		n, err := outbox.ReplayRange(ctx, pool, req.from, req.to)
		if err != nil {
			logger.Error("worker.replay_failed", "error", err.Error())
			return exitFail
		}
		logger.Info("worker.replay_range",
			"requeued", n,
			"from", req.from.Format(time.RFC3339),
			"to", req.to.Format(time.RFC3339))
		fmt.Printf("requeued %d event(s) in [%s, %s)\n",
			n, req.from.Format(time.RFC3339),
			req.to.Format(time.RFC3339))
	}
	return exitOK
}
