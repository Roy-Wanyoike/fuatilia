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
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/daraja"
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

	// The OUTBOUND Daraja rail (issue #178): the STK execution port binds
	// here — the production daraja.STKWire adapter over a live client.
	// All five DARAJA_* variables empty disables the rail (ExecuteStkPush
	// refuses with STK_WIRE_UNAVAILABLE — the example stack boots without
	// a Safaricom account); a partial set is a boot failure (a
	// half-configured rail would only fail on the first live push — fail
	// at boot instead). The INBOUND callback endpoints are unaffected:
	// C2B rail money flows through the intake funnel with no client.
	stkWire, err := darajaWireFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	services := &application.Services{
		Stores:  stores,
		Clock:   clock,
		IDs:     infra.NewUUID,
		Replays: infra.NewIDRegistry(),
		StkPush: stkWire,
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
			slog.Bool("stkRail", stkWire != nil),
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

// darajaRailEnvNames are the five variables the OUTBOUND STK rail needs —
// every one set enables it, every one empty disables it, a subset refuses
// the boot. DARAJA_BASE_URL is deliberately NOT in the list: it is optional
// (empty binds the Safaricom sandbox default in daraja.ConfigFromEnv).
var darajaRailEnvNames = []string{
	"DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET",
	"DARAJA_SHORT_CODE", "DARAJA_PASSKEY", "DARAJA_CALLBACK_BASE_URL",
}

// darajaWireFromEnv resolves the OUTBOUND STK rail (issue #178) from the
// environment: the production daraja.STKWire adapter over a live client, or
// nil when the rail is disabled. The merchant context (short code, passkey,
// callback URL) is the service-injected secret source the daraja package
// requires — values come from the environment only, never literals, and the
// adapter's own validation runs at boot so a deployment that boots can
// initiate. The http.Client is the wire cap the client's Config.Timeout
// documents (per-call deadline on the transport).
func darajaWireFromEnv(env func(string) string) (daraja.StkPushWire, error) {
	set := 0
	for _, name := range darajaRailEnvNames {
		if strings.TrimSpace(env(name)) != "" {
			set++
		}
	}
	if set == 0 {
		return nil, nil // rail disabled: ExecuteStkPush refuses with STK_WIRE_UNAVAILABLE
	}
	if set != len(darajaRailEnvNames) {
		return nil, fmt.Errorf("api: DARAJA_* configuration is partial (%d of %d set) — set all of %s to enable the STK rail, or none to disable it",
			set, len(darajaRailEnvNames), strings.Join(darajaRailEnvNames, ", "))
	}
	cfg, err := daraja.ConfigFromEnv(env)
	if err != nil {
		return nil, fmt.Errorf("api: daraja client config rejected: %w", err)
	}
	client, err := daraja.NewClient(&http.Client{Timeout: cfg.Timeout}, cfg)
	if err != nil {
		return nil, fmt.Errorf("api: daraja client rejected: %w", err)
	}
	wire, err := daraja.NewSTKWire(client, daraja.MerchantConfig{
		ShortCode:   strings.TrimSpace(env("DARAJA_SHORT_CODE")),
		Passkey:     strings.TrimSpace(env("DARAJA_PASSKEY")),
		CallBackURL: strings.TrimSpace(env("DARAJA_CALLBACK_BASE_URL")),
	})
	if err != nil {
		return nil, fmt.Errorf("api: daraja STK adapter rejected: %w", err)
	}
	return wire, nil
}
