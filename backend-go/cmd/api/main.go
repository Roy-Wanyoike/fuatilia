// cmd/api is the production entry point of the Go /v1 API kernel (issue #72,
// ADR-0002): it composes the environment adapters over PostgreSQL and serves
// the mounted 22-operation surface.
//
// Configuration comes from the environment (infra.LoadConfig): DATABASE_URL
// is required, LISTEN_ADDR defaults to :8080. Secrets are read from the
// environment and never logged — the structured request log carries only
// requestId, method, path, status, duration and the org id.
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

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
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
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// PostgreSQL is REQUIRED — the kernel has no persistence-free mode. An
	// unreachable database is a hard boot failure (fail closed).
	pool, err := infra.ConnectPool(ctx, cfg)
	if err != nil {
		return err
	}
	defer pool.Close()

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

	composed, err := transport.Compose(transport.Deps{
		Services: services,
		Auth:     authenticator,
		Clock:    clock,
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
		Handler:           composed.Kernel,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("api.listening",
			slog.String("addr", cfg.ListenAddr),
			slog.Int("routes", len(composed.Kernel.Table())))
		errCh <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		logger.Info("api.shutdown", slog.String("reason", "signal received"))
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}
