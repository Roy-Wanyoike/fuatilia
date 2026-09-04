package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// Test backend — REAL PostgreSQL 16.4 (db/migrations 0001–0014 applied) and
// REAL JetStream from the embedded nats-server. No stubs, no fake brokers:
// issue #74's acceptance criteria are delivery guarantees, and guarantees
// can only be evidenced against the real pieces.
//
// PG: default postgres://postgres@127.0.0.1:5435/fuatilia_test — the
// per-lane cluster documented in README.md ("Integration tests"); override
// with FUATILIA_TEST_DATABASE_URL. Unreachable PG fails the run (the merge
// gate includes booting the cluster), it never silently skips.

const testDatabaseURL = "postgres://postgres@127.0.0.1:5435/fuatilia_test"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("FUATILIA_TEST_DATABASE_URL")
	if url == "" {
		url = testDatabaseURL
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse FUATILIA_TEST_DATABASE_URL: %v", err)
	}
	cfg.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("connect outbox test pool: %v", err)
	}
	t.Cleanup(pool.Close)

	ctx := context.Background()
	if err := pool.Ping(ctx); err != nil {
		t.Fatalf("PostgreSQL for outbox integration tests is not reachable at %s — boot the per-lane cluster (README: initdb + pg_ctl -o \"-p 5435\"): %v", url, err)
	}
	// Fresh outbox per test: the FK graph roots at orgs, so truncating the
	// whole chain is the honest reset (TRAVERSE GRAPH handles composite FKs).
	_, err = pool.Exec(ctx, `TRUNCATE outbox_events, orgs CASCADE`)
	if err != nil {
		t.Fatalf("truncate test tables: %v", err)
	}
	return pool
}

// testOrg inserts a tenant root and returns its uuid::text.
func testOrg(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO orgs (name, slug) VALUES ($1, $1) RETURNING id::text`, slug,
	).Scan(&id)
	if err != nil {
		t.Fatalf("insert org %s: %v", slug, err)
	}
	return id
}

// appendEvent inserts one outbox row the way a domain transaction would
// (INSERT only — the relay must never need more). Note payloads pass through
// the jsonb column, so what comes back is PostgreSQL's canonical jsonb text.
func appendEvent(t *testing.T, pool *pgxpool.Pool, orgID, eventID, eventType string, version int, payload string, createdAt time.Time) {
	t.Helper()
	if payload == "" {
		payload = `{"amountMinor": 125050}`
	}
	_, err := pool.Exec(context.Background(),
		`INSERT INTO outbox_events (org_id, event_id, event_type, version, payload, created_at)
                 VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)`,
		orgID, eventID, eventType, version, payload, createdAt)
	if err != nil {
		t.Fatalf("append event %s: %v", eventID, err)
	}
}

// payloadOf reads back the canonical jsonb text of one event's payload — the
// bytes the relay must publish verbatim (the envelope-fidelity contract).
func payloadOf(t *testing.T, pool *pgxpool.Pool, eventID string) string {
	t.Helper()
	var payload string
	err := pool.QueryRow(context.Background(),
		`SELECT payload::text FROM outbox_events WHERE event_id::text = $1`, eventID,
	).Scan(&payload)
	if err != nil {
		t.Fatalf("read payload of %s: %v", eventID, err)
	}
	return payload
}

// testBroker boots an embedded NATS server with JetStream enabled on a
// random port backed by a throwaway store dir — the same server that runs
// in production topologies, in-process.
func testBroker(t *testing.T) (nats.JetStreamContext, *server.Server) {
	t.Helper()
	srv, err := server.NewServer(&server.Options{
		JetStream: true,
		StoreDir:  filepath.Join(t.TempDir(), "jetstream"),
		NoLog:     true,
	})
	if err != nil {
		t.Fatalf("embedded nats-server: %v", err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatal("embedded nats-server never became ready")
	}
	t.Cleanup(srv.Shutdown)

	nc, err := nats.Connect(srv.ClientURL(), nats.Name("outbox-test"), nats.NoReconnect())
	if err != nil {
		t.Fatalf("connect to embedded server: %v", err)
	}
	t.Cleanup(nc.Close)
	js, err := nc.JetStream()
	if err != nil {
		t.Fatalf("jetstream context: %v", err)
	}
	return js, srv
}

// testBrokerNamed boots a second independent JetStream broker (unique name
// → unique temp dir) for tests that need a fresh stream after a shutdown.
func testBrokerNamed(t *testing.T, name string) (nats.JetStreamContext, *server.Server) {
	t.Helper()
	srv, err := server.NewServer(&server.Options{
		JetStream: true,
		StoreDir:  filepath.Join(t.TempDir(), "jetstream-"+name),
		NoLog:     true,
	})
	if err != nil {
		t.Fatalf("embedded nats-server %s: %v", name, err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(10 * time.Second) {
		t.Fatalf("embedded nats-server %s never became ready", name)
	}
	t.Cleanup(srv.Shutdown)

	nc, err := nats.Connect(srv.ClientURL(), nats.Name("outbox-test-"+name))
	if err != nil {
		t.Fatalf("connect to embedded server %s: %v", name, err)
	}
	t.Cleanup(nc.Close)
	js, err := nc.JetStream()
	if err != nil {
		t.Fatalf("jetstream context %s: %v", name, err)
	}
	return js, srv
}

// newTestRelay wires a relay over the real pool/broker with a quiet logger
// and ensures the FUATILIA_EVENTS stream exists first — the exact production
// order (cmd/worker calls EnsureStream before Run).
func newTestRelay(t *testing.T, pool *pgxpool.Pool, js nats.JetStreamContext, mutate func(*Config)) *Relay {
	t.Helper()
	if err := EnsureStream(context.Background(), js); err != nil {
		t.Fatalf("EnsureStream: %v", err)
	}
	cfg := Config{Logger: slog.New(slog.DiscardHandler)}
	if mutate != nil {
		mutate(&cfg)
	}
	relay, err := New(pool, js, cfg)
	if err != nil {
		t.Fatalf("New relay: %v", err)
	}
	return relay
}

// drainStream fetches every message currently retained on the stream via a
// JetStream pull consumer, keyed by subject, preserving per-subject order.
func drainStream(t *testing.T, js nats.JetStreamContext) map[string][]wireMessage {
	t.Helper()
	info, err := js.StreamInfo(StreamName)
	if err != nil {
		t.Fatalf("stream info: %v", err)
	}
	got := map[string][]wireMessage{}
	if info.State.Msgs == 0 {
		return got
	}
	sub, err := js.PullSubscribe("fuatilia.>", "", nats.BindStream(StreamName))
	if err != nil {
		t.Fatalf("probe pull subscribe: %v", err)
	}
	t.Cleanup(func() { _ = sub.Unsubscribe() })
	for remaining := info.State.Msgs; remaining > 0; {
		batch, err := sub.Fetch(int(remaining), nats.MaxWait(2*time.Second))
		if err != nil && len(batch) == 0 {
			break // drained
		}
		if err != nil && !errors.Is(err, nats.ErrTimeout) {
			t.Fatalf("probe fetch: %v", err)
		}
		for _, msg := range batch {
			remaining--
			var env wireMessage
			if err := json.Unmarshal(msg.Data, &env); err != nil {
				t.Fatalf("probe message not envelope JSON: %v\nbytes: %s", err, msg.Data)
			}
			got[msg.Subject] = append(got[msg.Subject], env)
		}
	}
	return got
}

// wireMessage is the envelope the relay publishes (buildEnvelope's shape).
type wireMessage struct {
	EventID   string          `json:"eventId"`
	Name      string          `json:"name"`
	Version   int             `json:"version"`
	OrgID     string          `json:"orgId"`
	CreatedAt string          `json:"createdAt"`
	Payload   json.RawMessage `json:"payload"`
}

// expectCount fails the test unless exactly n messages arrived on subject.
func expectCount(t *testing.T, got map[string][]wireMessage, subject string, n int, context string) {
	t.Helper()
	if len(got[subject]) != n {
		t.Fatalf("%s: subject %s carries %d messages, want %d (all: %v)", context, subject, len(got[subject]), n, keys(got))
	}
}

func keys(m map[string][]wireMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func fmtStats[T any](v T) string { return fmt.Sprintf("%+v", v) }
