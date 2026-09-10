// cmd/api is the production entry point of the Go /v1 API kernel (issue #72,
// ADR-0002): it composes the environment adapters over PostgreSQL and serves
// the mounted 22-operation surface, wrapped by the observability stack
// (issue #176): the Prometheus exposition rides /metrics, spans follow the
// STANDARD OTEL_* environment (no endpoint = no-op tracing), every record
// passes the redaction guard, and requestId + traceId ride the request
// scope end-to-end.
//
// Configuration comes from the environment (infra.LoadConfig): DATABASE_URL
// is required, LISTEN_ADDR defaults to :8080. Secrets are read from the
// environment and never logged — the structured request log carries only
// requestId, traceId, method, path, status, duration and the org id.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"
)

func main() {
	if err := run(); err != nil {
		slog.Error("api: fatal", slog.String("error", err.Error()))
		os.Exit(1)
	}
}

func run() error {
	cfg, err := infra.LoadConfig(os.Getenv)
	if err != nil {
		return err
	}
	// The redacted JSON logger (issue #88/#176): FUATILIA_LOG_LEVEL for
	// the level, the fail-closed redaction guard around every record.
	logger := observability.NewLogger(os.Getenv, os.Stdout)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Tracing (issue #176): the STANDARD OTEL_* env names drive the
	// OTLP/HTTP exporter; with no endpoint configured the provider is the
	// no-op (boot never requires a collector) and a malformed PRESENT
	// value fails the boot — config errors are deploy-time, never runtime.
	tracing, err := observability.NewTracing(ctx, observability.TracingOptions{})
	if err != nil {
		return fmt.Errorf("api: tracing config rejected: %w", err)
	}
	defer func() { _ = tracing.Shutdown(context.Background()) }()

	// PostgreSQL is REQUIRED — the kernel has no persistence-free mode. An
	// unreachable database is a hard boot failure (fail closed).
	pool, err := infra.ConnectPool(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

	// Metrics (issue #176): the private fuatilia_ registry, with the
	// process's own pool gauges wired onto the live pgxpool snapshot.
	metrics := observability.NewMetrics(observability.MetricsOptions{})
	metrics.SetPoolSource(poolStatsSource(pool))

	clock := infra.SystemClock{}
	stores := &repositories.Stores{Pool: pool}
	services := &application.Services{
		Stores:  stores,
		Clock:   clock,
		IDs:     infra.NewUUID,
		Replays: infra.NewIDRegistry(),
	}

	// Credential verification runs against the SAME org-scoped store; every
	// denial (401 and 403 alike) is appended to the tamper-evident audit
	// chain before it reaches the wire.
	verifier := repositories.NewAuthStore(pool, clock)
	authenticator := &auth.Authenticator{
		Verify: verifier,
		Clock:  clock,
		Audit: func(ctx context.Context, event infra.AuditEvent) error {
			return infra.AppendAuditEvent(ctx, pool, event)
		},
	}

	// Rate limiting + security headers (issue #130): the deployment contract
	// sizes both — malformed values are boot failures, never silently ignored.
	limits, err := transport.RateLimitConfigFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	headers, err := transport.SecurityHeadersFromEnv(os.Getenv)
	if err != nil {
		return err
	}

	composed, err := transport.Compose(transport.Deps{
		Services:        services,
		Auth:            authenticator,
		Clock:           clock,
		Limits:          limits,
		SecurityHeaders: headers,
		Observability: transport.ObservabilityWiring{
			Metrics: metrics,
			Tracing: tracing,
		},
	}, logger, func(err error, requestID string) {
		logger.Error("http.internal_error",
			slog.String("requestId", requestID),
			slog.String("error", err.Error()))
	})
	if err != nil {
		// A route-registration failure is a boot failure, never the wire.
		return fmt.Errorf("api: route table rejected: %w", err)
	}

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           composed.Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("api.listening",
			slog.String("addr", cfg.ListenAddr),
			slog.Int("routes", len(composed.Kernel.Table())),
			slog.String("metrics", "/metrics"),
		)
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		logger.Info("api.shutdown", slog.String("reason", "signal received"))
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		// Flush any pending spans after the listener drained (nil-safe:
		// disabled tracing is a no-op).
		return tracing.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
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
