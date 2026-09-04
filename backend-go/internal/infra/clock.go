// Package infra hosts the /v1 kernel's environment adapters (issue #72):
// configuration, the clock port, typed domain errors, the transactional
// outbox helper and the audited-denial sink.
package infra

import "time"

// Clock is the injected time port — every audited timestamp, expiry check and
// event occurrence flows through it (deterministic tests inject a fixed clock;
// the domain never reads the wall clock directly).
type Clock interface {
	Now() time.Time
}

// SystemClock is the production clock.
type SystemClock struct{}

// Now returns the current wall-clock time (UTC).
func (SystemClock) Now() time.Time { return time.Now().UTC() }

// FixedClock is the deterministic test clock.
type FixedClock struct{ At time.Time }

// Now returns the frozen instant.
func (c FixedClock) Now() time.Time { return c.At }
