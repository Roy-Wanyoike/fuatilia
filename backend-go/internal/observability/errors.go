package observability

// Error is the only error type this package produces: a stable machine Code
// plus a human Message. Errors are values — match with errors.As and compare
// Code, exactly like pkg/money, pkg/idempotency and internal/outbox.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// CodeConfigInvalid marks a malformed configuration value (env or option).
// Composition treats it as a boot failure, never a runtime 500 — a broken
// observability setting must be visible at deploy time, not on the wire.
const CodeConfigInvalid = "OBSERVABILITY_CONFIG_INVALID"

func errConfig(msg string) error {
	return &Error{Code: CodeConfigInvalid, Message: msg}
}
