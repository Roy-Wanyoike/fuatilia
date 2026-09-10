// Package analytics is the ClickHouse analytics ingester (issue #89, RICE #7
// "Collections analytics on ClickHouse"): it consumes the event fabric
// (FUATILIA_EVENTS, ADR-0003) and maintains the four dashboard read models —
// dso_daily, aging_migration, collector_effectiveness, cohort_recovery —
// plus the event_fact ledger that makes every figure provably
// derived-from-events.
//
// Read-model discipline (ADR-0002): PostgreSQL is the only financial source
// of truth. This package never writes PostgreSQL, never owns a balance, and
// is the only writer of the ClickHouse projection tables. Its ENTIRE database
// surface is the injected Driver port — no clickhouse-go dependency, no DSN,
// no credentials (stdlib only; the real driver is a later wave's wiring).
//
// Guarantees (each with its proof test):
//
//   - Idempotent by eventId, forever: the fabric is at-least-once
//     (Outbox.drain → JetStream), so every delivery is deduped on
//     (orgId, eventId) — the outbox README "Consumer idempotency contract"
//     verbatim — and the ledger's ReplacingMergeTree(org_id, event_id)
//     collapses redeliveries at rest (ingester_test.go).
//   - Deterministic replays: a projection is a pure fold of the org's
//     event log in canonical (created_at, eventId) order — the same order
//     the relay drains in — and computed_at is the watermark of that fold,
//     never the wall clock. Replaying the same stream, in any delivery
//     order, through any batching, yields byte-identical projections
//     (ingester_test.go determinism battery).
//   - Out-of-order tolerated: late deliveries are inserted into the org's
//     canonical log and the org is re-folded from scratch — the fold is
//     cheap and pure, so reordering degrades to recomputation, never to a
//     wrong figure.
//   - Formula parity: aging buckets/flooring/zero-balance are the Go port of
//     src/domain/projections/aging.ts (agingBucketFor/daysOverdue/
//     arAgingByBucket), effectiveness ratios/windows/null-reasons/no-clamp
//     are the Go port of src/domain/projections/effectiveness.ts
//     (collectionEffectiveness) — fixture tests cite the TS spec fixtures
//     they mirror (aging_test.go, effectiveness_test.go).
//   - NULL-with-reason: where the v1 catalog cannot honestly produce a
//     figure (no promise-made/kept event, no dispute event), the figure is
//     NULL with a prose reason — never a silently misleading 0.
//   - Honest labeling: every exported row carries label='derived_from_events',
//     as_of (the measured instant) and computed_at (the deterministic
//     processing watermark); freshness lag is now() − computed_at at query
//     time. Nothing here is a prediction; actuals only.
//
// Ports (both injected, both faked in tests):
//
//   - Consumer delivers raw relay envelopes (the wire JSON of
//     backend-go/internal/outbox README). The production face is a NATS
//     JetStream durable consumer wired in a later wave (see README.md);
//     this lane touches neither cmd/ nor the outbox package.
//   - Driver is the only database surface: Exec for projection upserts and
//     ledger appends, Query for exactly one read — the ledger replay that
//     powers RebuildFromLedger. Golden-file tests snapshot the exact SQL.
//
// Package layout: envelope.go (wire contract), ports.go, sql.go (the SQL
// string contract — mirrors db/clickhouse/*.sql), state.go (per-org fold
// state), fold.go (event application), emit.go (projection rows), and
// ingester.go (batch/rebuild orchestration).
package analytics

import (
	"fmt"
)

// LabelDerivedFromEvents is the value of the label column on every row this
// package writes. Nothing in the analytics store is a prediction; actuals
// only (mirroring src/domain/projections kind:'actual' discipline).
const LabelDerivedFromEvents = "derived_from_events"

// Error is the only error type this package produces: a stable machine Code
// plus a human Message. Errors are values — match with errors.As and compare
// Code, exactly like pkg/money, the outbox lane and the scheduler lane.
// Domain-parity refusals carry the TS codes verbatim (PROJ_AMOUNT_INVALID,
// PROJ_CURRENCY_INVALID, PROJ_DUE_DATE_INVALID, PROJ_RECEIVABLE_INVALID,
// PROJ_RECEIVABLE_DUPLICATE); the ingester's own refusals are prefixed
// ANALYTICS_.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Is matches any *Error carrying the same Code, so errors.Is works across
// contextual message differences.
func (e *Error) Is(target error) bool {
	if t, ok := target.(*Error); ok {
		return t.Code == e.Code
	}
	return false
}

func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Stable machine codes this package produces. PROJ_* codes are the verbatim
// TS codes of src/domain/projections/facts.ts (the parity contract); the
// EVENT_* codes are the outbox relay's envelope codes (the wire this lane
// consumes enforces the same rules one hop upstream).
const (
	CodeEnvelopeInvalid       = "ANALYTICS_ENVELOPE_INVALID"
	CodePayloadInvalid        = "ANALYTICS_PAYLOAD_INVALID"
	CodeVersionUnsupported    = "EVENT_VERSION_UNSUPPORTED" // relay's wire code, enforced again here (pinned v1 for handled events)
	CodeConfigInvalid         = "ANALYTICS_CONFIG_INVALID"
	CodeDriverContractInvalid = "ANALYTICS_DRIVER_CONTRACT_INVALID"
	CodeUnknownReceivable     = "ANALYTICS_UNKNOWN_RECEIVABLE" // counted skip, never a crash
	CodeProjQueryUnsupported  = "ANALYTICS_PROJECTION_QUERY_UNSUPPORTED"
	CodeLedgerSelectMismatch  = "ANALYTICS_LEDGER_SELECT_MISMATCH"
	// PROJ_* — verbatim TS parity codes (src/domain/projections/facts.ts).
	CodeAmountInvalid     = "PROJ_AMOUNT_INVALID"
	CodeCurrencyInvalid   = "PROJ_CURRENCY_INVALID"
	CodeDueDateInvalid    = "PROJ_DUE_DATE_INVALID"
	CodeReceivableInvalid = "PROJ_RECEIVABLE_INVALID"
	CodeReceivableDup     = "PROJ_RECEIVABLE_DUPLICATE"
	CodeFactDateInvalid   = "PROJ_FACT_DATE_INVALID"
)
