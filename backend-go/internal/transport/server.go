package transport

import (
	"log/slog"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
)

// ComposeResult is the wired kernel plus the authenticator the composition
// bound into it (tests reach the same sink the kernel uses).
type ComposeResult struct {
	Kernel *Kernel
	Auth   *auth.Authenticator
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
		Routes:       table,
		Auth:         deps.Auth,
		Clock:        deps.Clock,
		MaxBodyBytes: DefaultMaxBodyBytes,
		Log:          log,
		OnError:      onError,
	})
	if err != nil {
		return ComposeResult{}, err
	}
	return ComposeResult{Kernel: kernel, Auth: deps.Auth}, nil
}
