package transport

import (
	"log/slog"
	"net/http"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
)

// ComposeResult is the wired kernel plus the authenticator the composition
// bound into it (tests reach the same sink the kernel uses) and the FULL
// serving chain (issue #176).
type ComposeResult struct {
	Kernel *Kernel
	Auth   *auth.Authenticator
	// Handler is the complete serving chain (issue #176): the public /metrics
	// dispatch plus the observability middleware wrapping the kernel — see
	// servingChain for the documented layer order. The http.Server serves
	// THIS; Kernel remains for tests and callers that drive the pipeline
	// directly.
	Handler http.Handler
}

// Compose is the transport composition root (server.ts is the TS twin): it
// derives the capability list from the mounted tables, mounts the meta row
// LAST (the same derivation order the TS composition runs) and compiles the
// kernel — a broken table is a boot failure, never a runtime 500.
func Compose(deps Deps, log *slog.Logger, onError func(err error, requestID string)) (ComposeResult, error) {
	table, err := mountRoutes(deps)
	if err != nil {
		return ComposeResult{}, err
	}
	kernel, err := NewKernel(KernelOptions{
		Routes:          table,
		Auth:            deps.Auth,
		Clock:           deps.Clock,
		MaxBodyBytes:    DefaultMaxBodyBytes,
		Log:             log,
		OnError:         onError,
		Limits:          deps.Limits,
		SecurityHeaders: deps.SecurityHeaders,
	})
	if err != nil {
		return ComposeResult{}, err
	}
	return ComposeResult{
		Kernel:  kernel,
		Auth:    deps.Auth,
		Handler: servingChain(kernel, deps.Observability, deps.SecurityHeaders, log),
	}, nil
}
