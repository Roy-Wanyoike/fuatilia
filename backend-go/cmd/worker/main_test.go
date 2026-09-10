package main

// Integration evidence for the process surface (issue #177): the cmd/worker
// composition — the exact code path the compose worker service binary
// executes — boots against REAL PostgreSQL 16.4 (private cluster,
// db/migrations 0001–0015) and REAL JetStream (embedded nats-server, the
// same binary production topologies run), claims a queued webhook delivery,
// signs it with the ENV-RESOLVED secret (WEBHOOK_SIGNING_SECRETS →
// webhooks.EnvSigningKeys), delivers it through the INJECTED Transport port,
// and drains like a SIGTERM: stops claiming, completes the in-flight
// delivery, records its outcome, exits 0. The compiled binary itself is
// booted as a subprocess and SIGTERMed for the end-to-end signal evidence.
//
// Test seams (all fakes live in _test.go only):
//
//   - receiver: a real httptest server that records the bytes and signature
//     header per event id (the signed envelope's aggregateId); a delivery can
//     be GATED so the test can SIGTERM mid-flight.
//   - rewriteTransport: the schema (0012) refuses loopback/insecure endpoint
//     URLs, so tests seed the schema-honest https URL and this injected
//     transport rewrites its host onto the local receiver before delegating
//     to the REAL webhooks.HTTPTransport — the wire hop stays fully real.
//     Production boots runWorker with transport = nil (the HTTP transport);
//     the injected transport is the webhooks Transport port doing its job.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	natsserver "github.com/nats-io/nats-server/v2/server"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/webhooks"
)

// pg is the package's private, fully migrated PostgreSQL 16.4 cluster.
var pg *pgtest.Cluster

func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cluster, stop, err := pgtest.StartTemp(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "worker test bootstrap: %v\n", err)
		os.Exit(1)
	}
	pg = cluster
	code := m.Run()
	stop()
	os.Exit(code)
}

// Fixtures. The endpoint URL must satisfy 0012's constraints (https-only, no
// loopback) — rewriteTransport maps its host onto the local receiver. Secrets
// here are fake-by-construction fixtures (docs/security/secrets.md §7).
const (
	testSecret       = "whsec_test_0123456789abcdef0123456789abcdef"
	testEndpointHost = "https://hooks.fuatilia-test.example"
	testEndpointURL  = testEndpointHost + "/fuatilia"
	testEventType    = "payment.confirmed"
	testPayload      = `{"amountMinor": 125050, "ref": "KES-001"}`
)

// uuidFor builds the spec's deterministic uuid shape: 00000000-0000-4000-8000-%012d.
func uuidFor(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

func testLogger() *slog.Logger { return slog.New(slog.DiscardHandler) }

// workerPool returns a pool over the private cluster with a clean lane state:
// every test truncates the org-rooted graph (webhook_endpoints,
// webhook_deliveries, outbox_events and everything else CASCADEs from orgs;
// audit_events is the one org-rooted table without an FK) after itself.
func workerPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), pg.DSN(pgtest.SharedDBName))
	if err != nil {
		t.Fatalf("connect worker test pool: %v", err)
	}
	t.Cleanup(pool.Close) // registered first so the truncate below runs before the pool closes

	truncate := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := pool.Exec(ctx, `TRUNCATE audit_events, orgs CASCADE`); err != nil {
			t.Fatalf("truncate lane tables: %v", err)
		}
	}
	t.Cleanup(truncate)
	return pool
}

// testBroker boots an embedded NATS server with JetStream enabled on a random
// port — the real broker, in-process (the outbox lane's established seam).
func testBroker(t *testing.T) string {
	t.Helper()
	srv, err := natsserver.NewServer(&natsserver.Options{
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
	return srv.ClientURL()
}

// seedOrg inserts a tenant root and returns its uuid::text.
func seedOrg(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO orgs (name, slug) VALUES ($1, $1) RETURNING id::text`, slug,
	).Scan(&id); err != nil {
		t.Fatalf("seed org %s: %v", slug, err)
	}
	return id
}

// seedEndpoint registers an https endpoint whose secret is HASHED in the
// schema — the plaintext exists only in the test's WEBHOOK_SIGNING_SECRETS
// value, exactly the production discipline.
func seedEndpoint(t *testing.T, pool *pgxpool.Pool, orgID string) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_endpoints (org_id, url, secret_hash, secret_prefix, active)
                 VALUES ($1::uuid, $2, 'test-only-hash-ref', 'whsec_test_', true) RETURNING id::text`,
		orgID, testEndpointURL,
	).Scan(&id); err != nil {
		t.Fatalf("seed endpoint: %v", err)
	}
	return id
}

// enqueueDelivery inserts one queued delivery row due immediately; createdAt
// pins the claim order (the claim query orders by COALESCE(next_attempt_at,
// created_at), created_at, id).
func enqueueDelivery(t *testing.T, pool *pgxpool.Pool, orgID, endpointID, eventID string, createdAt time.Time) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload, created_at)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6) RETURNING id::text`,
		orgID, endpointID, eventID, testEventType, testPayload, createdAt,
	).Scan(&id); err != nil {
		t.Fatalf("enqueue delivery for event %s: %v", eventID, err)
	}
	return id
}

// deliveryRow is the persisted shape the drain test reads back.
type deliveryRow struct {
	State        string
	AttemptCount int
}

func readDelivery(t *testing.T, pool *pgxpool.Pool, id string) deliveryRow {
	t.Helper()
	var row deliveryRow
	if err := pool.QueryRow(context.Background(),
		`SELECT state::text, attempt_count FROM webhook_deliveries WHERE id = $1::uuid`, id,
	).Scan(&row.State, &row.AttemptCount); err != nil {
		t.Fatalf("read delivery %s: %v", id, err)
	}
	return row
}

func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// --- the HTTP receiver --------------------------------------------------------

type receiver struct {
	mu      sync.Mutex
	posts   map[string]int
	bodies  map[string][]string
	sigs    map[string][]string
	release map[string]chan struct{}
	started chan string
	server  *httptest.Server
}

// newReceiver starts a real HTTP receiver. A delivery whose event id was
// gated (gate) is answered only after the test closes its channel — the seam
// that holds a delivery in flight across the simulated SIGTERM.
func newReceiver(t *testing.T) *receiver {
	t.Helper()
	rec := &receiver{
		posts:   map[string]int{},
		bodies:  map[string][]string{},
		sigs:    map[string][]string{},
		release: map[string]chan struct{}{},
		started: make(chan string, 64),
	}
	rec.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Errorf("receiver: read body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var env struct {
			AggregateID string `json:"aggregateId"`
		}
		if err := json.Unmarshal(body, &env); err != nil || env.AggregateID == "" {
			t.Errorf("receiver: body is not the canonical envelope: %q (%v)", body, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		rec.mu.Lock()
		rec.posts[env.AggregateID]++
		rec.bodies[env.AggregateID] = append(rec.bodies[env.AggregateID], string(body))
		rec.sigs[env.AggregateID] = append(rec.sigs[env.AggregateID], req.Header.Get(webhooks.SignatureHeaderName))
		gate := rec.release[env.AggregateID]
		rec.mu.Unlock()

		select {
		case rec.started <- env.AggregateID:
		default: // the channel never blocks a request; tests read what they need
		}
		if gate != nil {
			select {
			case <-gate: // held open by the test across the simulated SIGTERM
			case <-req.Context().Done():
				return // the worker's delivery timeout gave up — recorded as a failure
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(rec.server.Close)
	return rec
}

func (r *receiver) gate(eventID string) chan struct{} {
	ch := make(chan struct{})
	r.mu.Lock()
	r.release[eventID] = ch
	r.mu.Unlock()
	return ch
}

func (r *receiver) postCount(eventID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.posts[eventID]
}

func (r *receiver) body(eventID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bodies[eventID][0]
}

func (r *receiver) sig(eventID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.sigs[eventID][0]
}

// waitStarted blocks until the receiver has accepted a request for eventID —
// the worker is provably inside the in-flight POST at that point.
func (r *receiver) waitStarted(t *testing.T, eventID string) {
	t.Helper()
	for {
		select {
		case got := <-r.started:
			if got == eventID {
				return
			}
		case <-time.After(15 * time.Second):
			t.Fatalf("receiver never saw a request for %s", eventID)
		}
	}
}

// --- the injected transport -----------------------------------------------------

// rewriteTransport maps the schema-honest endpoint host onto the local
// receiver and delegates to the REAL webhooks.HTTPTransport.
type rewriteTransport struct {
	next   webhooks.Transport
	toBase string
}

func (t *rewriteTransport) Deliver(ctx context.Context, endpointURL, signatureHeader string, payload []byte) (int, error) {
	return t.next.Deliver(ctx, strings.Replace(endpointURL, testEndpointHost, t.toBase, 1), signatureHeader, payload)
}

// --- composition helpers ---------------------------------------------------------

// bootWebhookEnv is the exact env contract cmd/worker resolves: the private
// cluster as DATABASE_URL, the embedded broker as NATS_URL, and the delivery
// loop enabled with the env-resolved per-endpoint secret.
func bootWebhookEnv(t *testing.T, brokerURL, orgID, endpointID string, extra map[string]string) func(string) string {
	t.Helper()
	m := map[string]string{
		"DATABASE_URL":            pg.DSN(pgtest.SharedDBName),
		"NATS_URL":                brokerURL,
		"WEBHOOKS_ENABLED":        "1",
		"WEBHOOK_SIGNING_SECRETS": orgID + ":" + endpointID + ":" + testSecret,
	}
	for k, v := range extra {
		m[k] = v
	}
	return func(k string) string { return m[k] }
}

// runWorkerAsync runs the composition core the binary executes, in the
// background; the returned channel carries the process exit code.
func runWorkerAsync(ctx context.Context, getenv func(string) string, transport webhooks.Transport) <-chan int {
	code := make(chan int, 1)
	go func() { code <- runWorker(ctx, testLogger(), getenv, transport) }()
	return code
}

// --- configuration gate (pure) ---------------------------------------------------

func TestLoadConfigWebhookGate(t *testing.T) {
	org, endpoint := uuidFor(1), uuidFor(101)
	entry := org + ":" + endpoint + ":" + testSecret

	t.Run("relay-only by default", func(t *testing.T) {
		cfg, err := loadConfig(func(string) string { return "" })
		if err == nil {
			t.Fatal("loadConfig without DATABASE_URL = nil error, want refusal")
		}
		cfg, err = loadConfig(func(k string) string {
			if k == "DATABASE_URL" {
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			}
			return ""
		})
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.webhooks {
			t.Fatal("webhooks enabled by default, want the relay-only default")
		}
		if cfg.keys != nil {
			t.Fatal("signing keys resolved by default, want nil")
		}
	})

	t.Run("enabled without secrets refuses to boot", func(t *testing.T) {
		_, err := loadConfig(func(k string) string {
			if k == "DATABASE_URL" {
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			}
			if k == "WEBHOOKS_ENABLED" {
				return "1"
			}
			return ""
		})
		if err == nil {
			t.Fatal("enabled without secrets = nil error, want boot refusal")
		}
		if !strings.Contains(err.Error(), "WEBHOOK_SIGNING_SECRETS") {
			t.Fatalf("error %q does not name the missing variable", err.Error())
		}
	})

	t.Run("malformed boolean refuses to boot", func(t *testing.T) {
		_, err := loadConfig(func(k string) string {
			if k == "DATABASE_URL" {
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			}
			if k == "WEBHOOKS_ENABLED" {
				return "yes"
			}
			return ""
		})
		if err == nil || !strings.Contains(err.Error(), "WEBHOOKS_ENABLED") {
			t.Fatalf("loadConfig = %v, want a WEBHOOKS_ENABLED refusal", err)
		}
	})

	t.Run("malformed secrets refuse to boot with the stable code", func(t *testing.T) {
		_, err := loadConfig(func(k string) string {
			switch k {
			case "DATABASE_URL":
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			case "WEBHOOKS_ENABLED":
				return "1"
			case "WEBHOOK_SIGNING_SECRETS":
				return "not-a-uuid:" + endpoint + ":" + testSecret
			}
			return ""
		})
		var domain *webhooks.Error
		if err == nil || !errors.As(err, &domain) || domain.Code != webhooks.CodeConfigInvalid {
			t.Fatalf("loadConfig = %v, want a wrapped %s refusal", err, webhooks.CodeConfigInvalid)
		}
		if !strings.Contains(err.Error(), "WEBHOOK_SIGNING_SECRETS") {
			t.Fatalf("error %q does not name the offending variable", err.Error())
		}
	})

	t.Run("enabled with secrets resolves the keys port", func(t *testing.T) {
		cfg, err := loadConfig(func(k string) string {
			switch k {
			case "DATABASE_URL":
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			case "WEBHOOKS_ENABLED":
				return "true"
			case "WEBHOOK_SIGNING_SECRETS":
				return entry
			}
			return ""
		})
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if !cfg.webhooks {
			t.Fatal("webhooks not enabled, want true")
		}
		secret, err := cfg.keys.SecretFor(context.Background(), org, endpoint)
		if err != nil || secret != testSecret {
			t.Fatalf("SecretFor = (%q, %v), want the env-resolved secret", secret, err)
		}
	})

	t.Run("disabled with secrets still validates the value", func(t *testing.T) {
		_, err := loadConfig(func(k string) string {
			switch k {
			case "DATABASE_URL":
				return "postgres://postgres@127.0.0.1:59999/fuatilia_worker_test"
			case "WEBHOOK_SIGNING_SECRETS":
				return "junk"
			}
			return ""
		})
		if err == nil {
			t.Fatal("malformed secrets with the loop disabled = nil error, want validation")
		}
	})
}

// --- boot failures never touch the infrastructure ---------------------------------

func TestRunWorkerRefusesToBootOnBrokenWebhookConfig(t *testing.T) {
	org, endpoint := uuidFor(2), uuidFor(102)
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"enabled without secrets", map[string]string{"WEBHOOKS_ENABLED": "1"}},
		{"malformed secrets", map[string]string{"WEBHOOKS_ENABLED": "1", "WEBHOOK_SIGNING_SECRETS": org + ":" + endpoint}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// DATABASE_URL still resolves (unused: the refusal is first),
			// proving the config gate fires before any connection.
			m := map[string]string{
				"DATABASE_URL": pg.DSN(pgtest.SharedDBName),
				"NATS_URL":     "nats://127.0.0.1:59999",
			}
			for k, v := range tc.env {
				m[k] = v
			}
			getenv := func(k string) string { return m[k] }
			if code := runWorker(context.Background(), testLogger(), getenv, nil); code != exitFail {
				t.Fatalf("runWorker exit = %d, want %d", code, exitFail)
			}
		})
	}
}

// --- acceptance criterion 1: boot, claim on real PG, sign with the
// env-resolved key, deliver via the injected transport -----------------------------

func TestWorkerBootsClaimsSignsAndDelivers(t *testing.T) {
	pool := workerPool(t)
	orgID := seedOrg(t, pool, "worker-delivers")
	endpointID := seedEndpoint(t, pool, orgID)
	eventID := uuidFor(201)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, time.Now().Add(-2*time.Second))

	rec := newReceiver(t)
	transport := &rewriteTransport{next: webhooks.NewHTTPTransport(nil), toBase: rec.server.URL}
	getenv := bootWebhookEnv(t, testBroker(t), orgID, endpointID, nil)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	code := runWorkerAsync(ctx, getenv, transport)

	// The delivery is carried to `delivered` on the real cluster: claimed →
	// signed with the env secret → POSTed → recorded through the ladder.
	waitFor(t, 20*time.Second, "the delivery to reach delivered on real PostgreSQL", func() bool {
		return readDelivery(t, pool, deliveryID).State == "delivered"
	})

	if got := rec.postCount(eventID); got != 1 {
		t.Fatalf("receiver saw %d POSTs for %s, want exactly 1", got, eventID)
	}
	body := rec.body(eventID)
	var env struct {
		Name        string          `json:"name"`
		Version     int             `json:"version"`
		AggregateID string          `json:"aggregateId"`
		OrgID       string          `json:"orgId"`
		OccurredAt  string          `json:"occurredAt"`
		Payload     json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("receiver body is not the canonical envelope: %v\n%s", err, body)
	}
	if env.AggregateID != eventID || env.OrgID != orgID || env.Name != testEventType || env.Version != 1 {
		t.Fatalf("envelope identity mismatch: %+v (event %s, org %s)", env, eventID, orgID)
	}

	// The wire signature verifies under the ENV-RESOLVED secret — and only
	// under it (negative control), pinning "signs with the env-resolved key".
	decision, err := webhooks.VerifySignature(webhooks.VerifySignatureArgs{
		Header:  rec.sig(eventID),
		Payload: body,
		Secret:  testSecret,
		NowMs:   time.Now().UnixMilli(),
		Digest:  webhooks.HMACSHA256,
	})
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if decision.Decision != webhooks.DecisionVerified {
		t.Fatalf("signature decision = %s (%s), want VERIFIED", decision.Decision, decision.Detail)
	}
	if rejected, err := webhooks.VerifySignature(webhooks.VerifySignatureArgs{
		Header:  rec.sig(eventID),
		Payload: body,
		Secret:  "whsec_test_wrong0000000000000000000000000",
		NowMs:   time.Now().UnixMilli(),
		Digest:  webhooks.HMACSHA256,
	}); err == nil && rejected.Decision != webhooks.DecisionMismatch {
		t.Fatalf("wrong-secret decision = %s, want MISMATCH", rejected.Decision)
	}

	// Graceful stop after the work: cancellation is the SIGTERM-produced
	// state; the process surface exits 0.
	cancel()
	select {
	case got := <-code:
		if got != exitOK {
			t.Fatalf("runWorker exit = %d, want %d", got, exitOK)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("runWorker did not exit after cancellation")
	}
}

// --- acceptance criterion 2: SIGTERM drain — stops claiming, completes the
// in-flight delivery, records it, exits 0 ------------------------------------------

func TestWorkerSigtermStopsClaimingAndDrainsInFlight(t *testing.T) {
	pool := workerPool(t)
	orgID := seedOrg(t, pool, "worker-drains")
	endpointID := seedEndpoint(t, pool, orgID)
	// Event ids key the receiver (the signed envelope's aggregateId); the
	// returned delivery-row ids key the PostgreSQL reads.
	inFlightEvent, queuedEvent := uuidFor(301), uuidFor(302)
	// Claim order is created_at: the gated delivery is strictly first.
	inFlightDelivery := enqueueDelivery(t, pool, orgID, endpointID, inFlightEvent, time.Now().Add(-2*time.Second))
	queuedDelivery := enqueueDelivery(t, pool, orgID, endpointID, queuedEvent, time.Now().Add(-1*time.Second))

	rec := newReceiver(t)
	gate := rec.gate(inFlightEvent) // holds delivery #1 inside the POST
	transport := &rewriteTransport{next: webhooks.NewHTTPTransport(nil), toBase: rec.server.URL}
	getenv := bootWebhookEnv(t, testBroker(t), orgID, endpointID, nil)

	ctx, cancel := context.WithCancel(context.Background())
	code := runWorkerAsync(ctx, getenv, transport)

	// Wait until delivery #1 is provably in flight, then SIGTERM (the
	// cancellation IS what the signal produces via signal.NotifyContext).
	rec.waitStarted(t, inFlightEvent)
	cancel()
	close(gate) // the in-flight POST completes only after the signal

	select {
	case got := <-code:
		if got != exitOK {
			t.Fatalf("runWorker exit = %d, want %d (graceful drain)", got, exitOK)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("runWorker did not drain after cancellation")
	}

	// The in-flight delivery completed and was RECORDED while the process
	// drained — not stranded `delivering`.
	waitFor(t, 10*time.Second, "the in-flight delivery to be recorded delivered", func() bool {
		return readDelivery(t, pool, inFlightDelivery).State == "delivered"
	})
	// Claiming stopped: the queued sibling was never claimed, never posted.
	if row := readDelivery(t, pool, queuedDelivery); row.State != "queued" || row.AttemptCount != 0 {
		t.Fatalf("queued sibling = %+v, want state queued with 0 attempts (claiming must stop)", row)
	}
	if got := rec.postCount(queuedEvent); got != 0 {
		t.Fatalf("receiver saw %d POSTs for the queued sibling, want 0", got)
	}
}

// --- the compiled binary boots and exits 0 on a real SIGTERM ----------------------

func TestWorkerBinaryBootsAndExitsOnSIGTERM(t *testing.T) {
	// Build the actual compose target: go build ./cmd/worker (the Dockerfile's
	// build-worker stage compiles exactly this path).
	goBin, err := exec.LookPath("go")
	if err != nil {
		goBin = filepath.Join(runtime.GOROOT(), "bin", "go")
		if _, statErr := os.Stat(goBin); statErr != nil {
			t.Fatalf("the go toolchain is not in PATH and GOROOT has no bin/go: %v", statErr)
		}
	}
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the module root from the test file")
	}
	moduleRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	bin := filepath.Join(t.TempDir(), "worker")
	build := exec.Command(goBin, "build", "-o", bin, "./cmd/worker")
	build.Dir = moduleRoot
	if out, buildErr := build.CombinedOutput(); buildErr != nil {
		t.Fatalf("go build ./cmd/worker: %v\n%s", buildErr, out)
	}

	brokerURL := testBroker(t)
	// No rows seeded: the loop boots, polls an empty queue, and idles —
	// a pure boot-and-drain proof of the binary path.
	getenv := bootWebhookEnv(t, brokerURL, uuidFor(3), uuidFor(103), nil)
	cmd := exec.Command(bin)
	cmd.Env = append(osEnvironWithout(
		"DATABASE_URL", "NATS_URL", "WEBHOOKS_ENABLED", "WEBHOOK_SIGNING_SECRETS",
	),
		"DATABASE_URL="+getenv("DATABASE_URL"),
		"NATS_URL="+getenv("NATS_URL"),
		"WEBHOOKS_ENABLED="+getenv("WEBHOOKS_ENABLED"),
		"WEBHOOK_SIGNING_SECRETS="+getenv("WEBHOOK_SIGNING_SECRETS"),
	)

	var logsMu sync.Mutex
	var logs strings.Builder
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatalf("stderr pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start worker binary: %v", err)
	}

	// Scan the structured log until the worker.started record appears — with
	// webhooks:true, proving the delivery loop actually booted alongside the
	// relay — while draining the pipe so the child never blocks on it.
	started := make(chan string, 1)
	scanErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			logsMu.Lock()
			logs.WriteString(line)
			logs.WriteString("\n")
			logsMu.Unlock()
			if strings.Contains(line, `"msg":"worker.started"`) {
				select {
				case started <- line:
				default:
				}
			}
		}
		scanErr <- scanner.Err()
	}()

	var startedLine string
	select {
	case startedLine = <-started:
	case err := <-scanErr:
		t.Fatalf("worker binary log stream ended before worker.started: %v\n%s", err, logSnapshot(&logsMu, &logs))
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("worker binary never logged worker.started within 30s\n%s", logSnapshot(&logsMu, &logs))
	}
	if !strings.Contains(startedLine, `"webhooks":true`) {
		t.Fatalf("worker.started record does not show the webhook loop enabled: %s", startedLine)
	}

	// The real signal: SIGTERM → stops claiming, drains, exits 0.
	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("send SIGTERM: %v", err)
	}
	waitErr := make(chan error, 1)
	go func() { waitErr <- cmd.Wait() }()
	select {
	case err := <-waitErr:
		if err != nil {
			t.Fatalf("worker binary did not exit 0 on SIGTERM: %v\n%s", err, logSnapshot(&logsMu, &logs))
		}
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("worker binary did not exit within 30s of SIGTERM\n%s", logSnapshot(&logsMu, &logs))
	}
}

// osEnvironWithout returns the process environment minus the named keys (the
// subprocess must resolve its own contract, not inherit the test's).
func osEnvironWithout(keys ...string) []string {
	drop := make(map[string]struct{}, len(keys))
	for _, k := range keys {
		drop[k] = struct{}{}
	}
	env := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			if _, ok := drop[kv[:i]]; ok {
				continue
			}
		}
		env = append(env, kv)
	}
	return env
}

func logSnapshot(mu *sync.Mutex, logs *strings.Builder) string {
	mu.Lock()
	defer mu.Unlock()
	return logs.String()
}
