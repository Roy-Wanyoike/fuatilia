// Package idempotency is the Go production port of the R9/C5 idempotency
// semantics enforced in src/domain/payments/intake.ts and
// src/domain/events/outbox.ts — the write-side twin of "Daraja is
// at-least-once (K1)": duplicate callbacks and double-submits are NORMAL, and
// a logical command must produce exactly ONE outcome.
//
// Semantics (mirroring the TS domain):
//
//   - first-write-wins per (scope, key): the FIRST execution that commits an
//     outcome owns the key forever (intake.ts: "a duplicate returns the
//     EXISTING Payment ... it never creates a second Payment"; outbox.ts:
//     "dedupes on eventId so replays of the same command cannot
//     double-append");
//   - replays return the ORIGINAL outcome handle, flagged Replayed (the
//     intake duplicate path; the caller observes the first result, never a
//     second execution);
//   - a FAILED execution claims nothing: the key stays free so a legitimate
//     retry can run (TS intake only ever records created payments — a failed
//     funnel run leaves nothing behind to replay);
//   - Put is the outbox-style put-if-absent primitive: claiming an already-
//     taken key is refused with IDEMPOTENCY_KEY_TAKEN (OUTBOX_DUPLICATE's
//     registry twin).
//
// Concurrency model — deterministic double-submit resolution:
//
// A Registry is a single-threaded critical section guarded by one explicit
// sync.Mutex. Execute holds the lock across lookup → run → commit, so a
// concurrent double-submit BLOCKS until the first attempt commits, then
// observes the committed outcome as a replay. The winner is deterministic:
// whichever goroutine acquires the lock first wins; every loser gets the
// winner's outcome. This deliberately trades execution parallelism for
// strict, race-free first-write-wins — appropriate for the pure, fast domain
// functions this package exists for. Two obligations come with it:
//
//   - fn must NOT call back into the same Registry (sync.Mutex is not
//     reentrant — it would deadlock);
//   - fn runs while the registry lock is held, so keep it short and
//     side-effect-light. Long-running work should claim with Put first and
//     publish the outcome later through its own storage.
//
// Durable deployments (Postgres unique index on (scope, key)) will implement
// the identical first-write-wins contract in storage; this in-memory
// registry pins the semantics the storage adapter must reproduce.
package idempotency

import (
	"fmt"
	"strings"
	"sync"
)

// Stable machine codes (SCREAMING_SNAKE_CASE), mirroring the TS families
// this package ports: IDEMPOTENCY_KEY_TAKEN is the registry twin of the
// outbox's OUTBOX_DUPLICATE put-if-absent refusal; IDEMPOTENCY_KEY_REQUIRED
// mirrors intake.ts's INTAKE_IDEMPOTENCY_KEY_REQUIRED ("idempotencyKey is
// required (R9)").
const (
	CodeKeyTaken      = "IDEMPOTENCY_KEY_TAKEN"
	CodeKeyRequired   = "IDEMPOTENCY_KEY_REQUIRED"
	CodeScopeRequired = "IDEMPOTENCY_SCOPE_REQUIRED"
	CodeFnRequired    = "IDEMPOTENCY_FUNCTION_REQUIRED"
)

// Sentinel errors — one per stable code. Every *Error this package returns
// reports the same Code as its sentinel, so errors.Is matching and code
// comparison are always equivalent.
var (
	// ErrKeyTaken: the (scope, key) already carries an outcome —
	// first-write-wins refuses the second write (outbox OUTBOX_DUPLICATE twin).
	ErrKeyTaken = &Error{Code: CodeKeyTaken, Message: "key already claimed by an earlier outcome"}
	// ErrKeyRequired mirrors intake.ts: the idempotency key is required (R9).
	ErrKeyRequired = &Error{Code: CodeKeyRequired, Message: "idempotency key is required (R9)"}
	// ErrScopeRequired: the registry partition is required.
	ErrScopeRequired = &Error{Code: CodeScopeRequired, Message: "idempotency scope is required"}
	// ErrFnRequired: Execute was handed no operation to run.
	ErrFnRequired = &Error{Code: CodeFnRequired, Message: "execute function is required"}
)

// Error is the only error type pkg/idempotency produces: a stable machine
// Code plus a human Message. Errors are values — match with errors.Is
// against the sentinels or compare Code directly.
type Error struct {
	// Code is the stable SCREAMING_SNAKE_CASE machine code.
	Code string
	// Message is the human-readable context (scope/key involved).
	Message string
}

// Error implements the error interface as "<code>: <message>".
func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

// Is matches any *Error carrying the same Code, so errors.Is works across
// contextual message differences. Non-*Error targets never match.
func (e *Error) Is(target error) bool {
	if t, ok := target.(*Error); ok {
		return t.Code == e.Code
	}
	return false
}

func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Result is the handle returned for a (scope, key): either the fresh outcome
// of the caller's own execution (Replayed=false) or the ORIGINAL outcome of
// the first execution (Replayed=true — the intake duplicate path).
type Result[T any] struct {
	// Value is the committed outcome. On a replay this is the first
	// execution's value — for reference types, the ORIGINAL handle.
	Value T
	// Replayed reports whether this result came from the registry rather
	// than from a fresh execution (the ops tripwire intake.ts emits
	// duplicateCallbackObserved for).
	Replayed bool
}

// scopeKey is the registry's composite key: outcomes are unique per
// (scope, key) pair — the same key in different scopes never collides
// (intake's uniqueness is per channel+ref / per key, never global).
type scopeKey struct {
	scope string
	key   string
}

// Registry is the in-memory first-write-wins outcome registry keyed by
// (scope, key). See the package documentation for the concurrency model.
// The zero value is NOT usable — construct with NewRegistry.
type Registry[T any] struct {
	mu      sync.Mutex
	entries map[scopeKey]T
}

// NewRegistry builds an empty registry.
func NewRegistry[T any]() *Registry[T] {
	return &Registry[T]{entries: make(map[scopeKey]T)}
}

// Execute runs fn exactly once for the (scope, key) and commits its outcome;
// any later Execute — including a concurrent double-submit that loses the
// lock race — returns the ORIGINAL outcome with Replayed=true and never runs
// fn again. A failed fn claims nothing: the error is returned as-is and the
// key stays free for a legitimate retry (mirroring intake.ts, where a failed
// funnel run records nothing).
//
// Scope and key are trimmed and must be non-blank after trimming (intake.ts
// trims and refuses blanks). fn must be non-nil and must not call back into
// the same Registry (see the package concurrency model).
func (r *Registry[T]) Execute(scope, key string, fn func() (T, error)) (Result[T], error) {
	s, k, err := normalize(scope, key)
	if err != nil {
		var zero Result[T]
		return zero, err
	}
	if fn == nil {
		var zero Result[T]
		return zero, newError(CodeFnRequired, "execute function is required for (%s, %s)", s, k)
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if existing, ok := r.entries[scopeKey{s, k}]; ok {
		// R9/C5: a duplicate is the SAME logical command — return the
		// original outcome, never re-execute.
		return Result[T]{Value: existing, Replayed: true}, nil
	}
	value, err := fn()
	if err != nil {
		// Failure claims nothing: no outcome exists to replay, so the key
		// stays free for a retry.
		var zero Result[T]
		return zero, err
	}
	r.entries[scopeKey{s, k}] = value
	return Result[T]{Value: value, Replayed: false}, nil
}

// Put commits value as the (scope, key) outcome without executing anything —
// the outbox-style put-if-absent primitive (the OUTBOX_DUPLICATE twin).
// First-write-wins: if the key is already taken, the existing outcome is
// untouched and IDEMPOTENCY_KEY_TAKEN is returned. Callers can use Put to
// claim a key before doing work (multi-axis dedupe, e.g. intake's
// unique(channel, externalRef) OR unique(idempotencyKey): claim both axes,
// and if either refuses, look up the original via Lookup).
func (r *Registry[T]) Put(scope, key string, value T) error {
	s, k, err := normalize(scope, key)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	id := scopeKey{s, k}
	if _, taken := r.entries[id]; taken {
		return newError(CodeKeyTaken, "key (%s, %s) is already claimed", s, k)
	}
	r.entries[id] = value
	return nil
}

// Lookup reports the committed outcome for (scope, key), if any. It never
// executes anything and never mutates the registry.
func (r *Registry[T]) Lookup(scope, key string) (T, bool) {
	var zero T
	s, k, err := normalize(scope, key)
	if err != nil {
		return zero, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	value, ok := r.entries[scopeKey{s, k}]
	return value, ok
}

// Len reports how many (scope, key) outcomes the registry holds.
func (r *Registry[T]) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

// normalize trims scope/key and refuses blanks (intake.ts trims its inputs
// and refuses blank refs/keys with the same discipline).
func normalize(scope, key string) (string, string, error) {
	s := strings.TrimSpace(scope)
	k := strings.TrimSpace(key)
	if s == "" {
		return "", "", newError(CodeScopeRequired, "idempotency scope is required")
	}
	if k == "" {
		return "", "", newError(CodeKeyRequired, "idempotency key is required (R9)")
	}
	return s, k, nil
}
