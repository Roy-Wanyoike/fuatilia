package analytics

import (
	"context"
)

// Consumer is the injected event-fabric port: it delivers raw relay
// envelopes (the wire JSON documented in backend-go/internal/outbox/README.md
// "Consumer idempotency contract") in batches.
//
// Contract:
//   - A batch is a []byte slice per envelope; the ingester parses and
//     validates every byte (ParseEnvelope) — the port stays dumb, the lane
//     owns its wire contract.
//   - At-least-once forever: the same envelope MAY be redelivered any number
//     of times (crash between publish and mark, consumer restart, replay).
//     Idempotency is the INGESTER's obligation (dedupe on (orgId, eventId)),
//     never the Consumer's.
//   - Any delivery order is legal: batches may arrive out of order, split
//     arbitrarily, or interleave orgs. The ingester imposes the per-org
//     canonical (created_at, eventId) order itself.
//   - (nil, nil) means "no work available this tick"; an error is terminal
//     for the Run loop (the caller decides the retry policy — the later-wave
//     JetStream wiring owns redelivery/backoff).
//
// The production face (a JetStream durable, filtered consumer over
// FUATILIA_EVENTS with explicit ack) is wired in a later wave — see
// README.md. This lane ships the port and its fake; cmd/ and internal/outbox
// are untouched.
type Consumer interface {
	Consume(ctx context.Context) ([][]byte, error)
}

// Rows is the minimal read cursor the Driver port returns — the ledger
// replay scan is the ONLY read this lane performs.
type Rows interface {
	Next() bool
	// Scan copies the current row's columns into dest. The rebuild read
	// scans, in order: org_id (string), event_id (string), name (string),
	// version (int64), created_at (time.Time), payload (string).
	Scan(dest ...any) error
	Close() error
	Err() error
}

// Driver is the ONLY database surface of this lane (issue #89 acceptance:
// "the Driver port is the only DB surface") — a ClickHouse-compatible
// execution seam. The production face is the real clickhouse-go driver
// (later wave); tests inject an in-memory fake that implements the SQL-string
// contract and is snapshot-tested via golden files (no ClickHouse server
// exists in this environment).
//
// Contract:
//   - Exec runs one parameterized statement (INSERT — the ingester only ever
//     appends/upserts; ReplacingMergeTree semantics make re-upserts of the
//     same key converge to the newest computed_at).
//   - Query runs exactly one statement: LedgerSelectSQL (the rebuild replay).
//     Any other query string is a programming error and must be refused.
//   - args are positional (? placeholders): string | int | int64 | uint32 |
//     float64 | time.Time | nil (NULL) | []string. The lane never builds SQL
//     by string concatenation of values — parameters only, so no payload
//     bytes ever land in a statement string.
//   - Zero connection knowledge: no DSN, no host, no credentials cross this
//     interface — ever.
type Driver interface {
	Exec(ctx context.Context, query string, args ...any) error
	Query(ctx context.Context, query string, args ...any) (Rows, error)
}
