package webhooks

// Integration evidence against REAL PostgreSQL 16.4 (the private cluster
// bootstrapped in testmain_test.go, migrations 0001–0014 applied) — the
// half of the acceptance criteria pure table tests cannot evidence:
//
//   - AC2 (ladder parity, executed): success / 4xx / 5xx / network-error
//     transitions drive webhook_deliveries through the exact attempts.ts
//     schedule (willRetry = attemptNo <= len(ladder),
//     nextAttemptAt = now + ladder[attemptNo-1], exhaustion → dead_lettered).
//   - AC3 (concurrency): parallel workers claim with FOR UPDATE SKIP LOCKED —
//     a receiver counting POSTs proves no delivery is ever double-claimed.
//   - AC4 (restart safety): a crash between POST and record (the afterPost
//     fault-injection seam) redelivers after the claim lease — at-least-once.
//
// Test seams (all fakes live in _test.go only):
//
//   - receiver: a real httptest server that counts POSTs per event id
//     (the aggregateId of the signed envelope), records the bytes and the
//     signature header, and serves a scripted status sequence.
//   - rewriteTransport: the schema (0012) refuses loopback/insecure endpoint
//     URLs, so tests seed the schema-honest https URL and this injected
//     transport rewrites it to the local receiver before delegating to the
//     REAL HTTPTransport — the wire hop (net/http POST → server → status)
//     stays fully real.
//   - staticKeys: the SigningKeys port returning the shared test secret.
//   - stepClock: an advancing clock for deterministic ladder schedules (the
//     record path reads Now() once per phase, so next_attempt_at is exactly
//     cur + ladder[attemptNo-1] at each step).

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Test fixtures. The endpoint URL must satisfy 0012's constraints
// (https-only, no loopback) — rewriteTransport maps its host to the receiver.
const (
	testSecret       = "sk_whx_0123456789abcdef0123456789abcdef"
	testEndpointHost = "https://hooks.fuatilia-test.example"
	testEndpointURL  = testEndpointHost + "/fuatilia"
	testEventType    = "payment.confirmed"
	testPayload      = `{"amountMinor": 125050, "ref": "KES-001"}`
)

// uuidFor builds the spec's deterministic uuid shape: 00000000-0000-4000-8000-%012d.
func uuidFor(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }

// --- test clock -------------------------------------------------------------

// stepClock is an advancing clock: deterministic schedules (every claim and
// record within one phase reads the same Now()), real progress between phases.
type stepClock struct {
	mu  sync.Mutex
	cur time.Time
}

func newStepClock() *stepClock { return &stepClock{cur: time.Now().UTC()} }

func (c *stepClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cur
}

func (c *stepClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cur = c.cur.Add(d)
}

// --- the signing-keys port (static) ------------------------------------------

type staticKeys struct{ secret string }

func (k staticKeys) SecretFor(context.Context, string, string) (string, error) { return k.secret, nil }

// --- the HTTP receiver --------------------------------------------------------

// receiver is a real HTTP server counting POSTs per event id. statuses
// scripts the next status per event id (default 200); every request records
// the raw body and the signature header for later verification.
type receiver struct {
	mu      sync.Mutex
	counts  map[string]int
	bodies  map[string][]string
	sigs    map[string][]string
	script  map[string][]int
	server  *httptest.Server
	postfix func(status int)
}

func newReceiver(t *testing.T) *receiver {
	t.Helper()
	rec := &receiver{
		counts: map[string]int{},
		bodies: map[string][]string{},
		sigs:   map[string][]string{},
		script: map[string][]int{},
	}
	rec.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
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
		status := 200
		if seq := rec.script[env.AggregateID]; len(seq) > 0 {
			status, rec.script[env.AggregateID] = seq[0], seq[1:]
		}
		rec.counts[env.AggregateID]++
		rec.bodies[env.AggregateID] = append(rec.bodies[env.AggregateID], string(body))
		rec.sigs[env.AggregateID] = append(rec.sigs[env.AggregateID], r.Header.Get(SignatureHeaderName))
		rec.mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(rec.server.Close)
	return rec
}

func (r *receiver) posts(eventID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.counts[eventID]
}

func (r *receiver) totalPosts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, c := range r.counts {
		n += c
	}
	return n
}

func (r *receiver) body(eventID string, i int) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bodies[eventID][i]
}

// rewriteTransport maps the schema-honest endpoint host onto the local
// receiver and delegates to the REAL HTTPTransport (the test seam documented
// in the file header). It implements the worker's Transport port.
type rewriteTransport struct {
	next   Transport
	toBase string
}

func (t *rewriteTransport) Deliver(ctx context.Context, endpointURL, signatureHeader string, payload []byte) (int, error) {
	return t.next.Deliver(ctx, strings.Replace(endpointURL, testEndpointHost, t.toBase, 1), signatureHeader, payload)
}

// --- seeding + row reads -------------------------------------------------------

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

func seedEndpoint(t *testing.T, pool *pgxpool.Pool, orgID string, active bool) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_endpoints (org_id, url, secret_hash, secret_prefix, active)
                 VALUES ($1::uuid, $2, 'test-only-hash-ref', 'sk_whx_', $3) RETURNING id::text`,
		orgID, testEndpointURL, active,
	).Scan(&id); err != nil {
		t.Fatalf("seed endpoint: %v", err)
	}
	return id
}

func enqueueDelivery(t *testing.T, pool *pgxpool.Pool, orgID, endpointID, eventID string, nextAt *time.Time) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(),
		`INSERT INTO webhook_deliveries (org_id, endpoint_id, event_id, event_type, payload, next_attempt_at)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6) RETURNING id::text`,
		orgID, endpointID, eventID, testEventType, testPayload, nextAt,
	).Scan(&id); err != nil {
		t.Fatalf("enqueue delivery for event %s: %v", eventID, err)
	}
	return id
}

// deliveryRow is the persisted shape of one webhook_deliveries row.
type deliveryRow struct {
	State          string
	AttemptCount   int
	NextAttemptAt  *time.Time
	DeliveredAt    *time.Time
	DeadLetteredAt *time.Time
	LastError      *string
	CreatedAt      time.Time
}

func readDelivery(t *testing.T, pool *pgxpool.Pool, id string) deliveryRow {
	t.Helper()
	var row deliveryRow
	if err := pool.QueryRow(context.Background(),
		`SELECT state::text, attempt_count, next_attempt_at, delivered_at, dead_lettered_at,
                        last_error, created_at
                   FROM webhook_deliveries WHERE id = $1::uuid`, id,
	).Scan(&row.State, &row.AttemptCount, &row.NextAttemptAt, &row.DeliveredAt,
		&row.DeadLetteredAt, &row.LastError, &row.CreatedAt); err != nil {
		t.Fatalf("read delivery %s: %v", id, err)
	}
	return row
}

func payloadText(t *testing.T, pool *pgxpool.Pool, id string) string {
	t.Helper()
	var payload string
	if err := pool.QueryRow(context.Background(),
		`SELECT payload::text FROM webhook_deliveries WHERE id = $1::uuid`, id,
	).Scan(&payload); err != nil {
		t.Fatalf("read payload of %s: %v", id, err)
	}
	return payload
}

// --- worker wiring --------------------------------------------------------------

// testWorkerConfig: short ladder + short lease so whole ladders drain in
// milliseconds; ResolveConfig requires lease >= delivery timeout.
func testWorker(t *testing.T, pool *pgxpool.Pool, transport Transport, clock infra.Clock, mutate func(*Config)) *Worker {
	t.Helper()
	cfg := Config{
		PollInterval:    2 * time.Millisecond,
		DeliveryTimeout: 250 * time.Millisecond,
		ClaimLease:      300 * time.Millisecond,
		Ladder:          []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 40 * time.Millisecond},
		Clock:           clock,
		Logger:          slog.New(slog.DiscardHandler),
	}
	if mutate != nil {
		mutate(&cfg)
	}
	w, err := New(pool, staticKeys{testSecret}, transport, cfg)
	if err != nil {
		t.Fatalf("new worker: %v", err)
	}
	return w
}

func newTestTransport(rec *receiver) Transport {
	return &rewriteTransport{next: NewHTTPTransport(nil), toBase: rec.server.URL}
}

// assertInstantAlmostEqual tolerates the timestamptz microsecond round-trip.
func assertInstantAlmostEqual(t *testing.T, what string, got, want time.Time) {
	t.Helper()
	delta := got.Sub(want)
	if delta < 0 {
		delta = -delta
	}
	if delta > 2*time.Millisecond {
		t.Fatalf("%s = %v, want %v (±2ms), drifted %s", what, got, want, delta)
	}
}

func waitUntil(t *testing.T, within time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal(msg)
}

// --- AC2 executed: the success transition against real PostgreSQL ----------------

func TestWorkerDeliversSignedEnvelopeAndStampsDelivered(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-success")
	endpointID := seedEndpoint(t, pool, orgID, true)
	eventID := uuidFor(901)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)

	clock := newStepClock() // started AFTER seeding: created_at <= now → due
	worker := testWorker(t, pool, newTestTransport(rec), clock, nil)

	progressed, err := worker.RunOnce(ctx)
	if err != nil || !progressed {
		t.Fatalf("RunOnce = (%v, %v), want (true, nil)", progressed, err)
	}

	if got := rec.posts(eventID); got != 1 {
		t.Fatalf("receiver saw %d POSTs for event %s, want 1", got, eventID)
	}

	// Wire parity (AC1): the exact bytes POSTed verify under the pinned
	// decision table with the production digest, and carry the canonical
	// envelope shape (aggregateId = the event id).
	body := rec.body(eventID, 0)
	header := rec.sigs[eventID][0]
	decision, err := VerifySignature(VerifySignatureArgs{
		Header: rec.sigs[eventID][0], Payload: body, Secret: testSecret,
		NowMs: time.Now().UnixMilli(), Digest: HMACSHA256,
	})
	if err != nil || decision.Decision != DecisionVerified {
		t.Fatalf("POSTed signature does not verify: %+v err = %v", decision, err)
	}
	row := readDelivery(t, pool, deliveryID)
	wantEnvelope := fmt.Sprintf(`{"name":%q,"version":1,"aggregateId":%q,"orgId":%q,`+
		`"occurredAt":%q,"payload":%s}`,
		testEventType, eventID, orgID, MillisecondISO(row.CreatedAt), payloadText(t, pool, deliveryID))
	if body != wantEnvelope {
		t.Fatalf("envelope drifted:\n got %s\nwant %s", body, wantEnvelope)
	}
	if !strings.HasPrefix(header, "t=") || !strings.Contains(header, ",v1=") {
		t.Fatalf("signature header drifted: %q", header)
	}

	// Persisted success shape = the pure transition (attempts.go): delivered,
	// attempt 1 recorded, schedule cleared, no failure residue.
	if row.State != "delivered" || row.AttemptCount != 1 {
		t.Fatalf("row = %s/%d, want delivered/1", row.State, row.AttemptCount)
	}
	if row.DeliveredAt == nil {
		t.Fatal("delivered_at must be stamped")
	}
	if row.NextAttemptAt != nil || row.LastError != nil {
		t.Fatalf("success row residue: next_attempt_at=%v last_error=%v", row.NextAttemptAt, row.LastError)
	}
}

// --- AC2 executed: the full failure ladder against real PostgreSQL ---------------

func TestWorkerWalksTheLadderAgainstPostgreSQL(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-ladder")
	endpointID := seedEndpoint(t, pool, orgID, true)
	eventID := uuidFor(902)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)
	rec.mu.Lock()
	rec.script[eventID] = []int{500, 503, 500, 500}
	rec.mu.Unlock()

	clock := newStepClock()
	worker := testWorker(t, pool, newTestTransport(rec), clock, nil)

	// Attempt 1: 500 → failed + next_attempt_at = now + ladder[0].
	before := clock.Now()
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("attempt 1: %v", err)
	}
	row := readDelivery(t, pool, deliveryID)
	if row.State != "failed" || row.AttemptCount != 1 {
		t.Fatalf("after attempt 1: %s/%d, want failed/1", row.State, row.AttemptCount)
	}
	if row.NextAttemptAt == nil {
		t.Fatal("retry-pending row must carry next_attempt_at")
	}
	assertInstantAlmostEqual(t, "next_attempt_at[1]", *row.NextAttemptAt, before.Add(10*time.Millisecond))
	if row.LastError == nil || !strings.Contains(*row.LastError, "http 500") {
		t.Fatalf("last_error = %v, want the http 500 reason", row.LastError)
	}

	// Attempt 2 (after ladder[0]): 503 → next = now + ladder[1].
	clock.Advance(10 * time.Millisecond)
	before = clock.Now()
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("attempt 2: %v", err)
	}
	row = readDelivery(t, pool, deliveryID)
	if row.State != "failed" || row.AttemptCount != 2 {
		t.Fatalf("after attempt 2: %s/%d, want failed/2", row.State, row.AttemptCount)
	}
	assertInstantAlmostEqual(t, "next_attempt_at[2]", *row.NextAttemptAt, before.Add(20*time.Millisecond))

	// Attempt 3 (after ladder[1]): 500 → next = now + ladder[2].
	clock.Advance(20 * time.Millisecond)
	before = clock.Now()
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("attempt 3: %v", err)
	}
	row = readDelivery(t, pool, deliveryID)
	assertInstantAlmostEqual(t, "next_attempt_at[3]", *row.NextAttemptAt, before.Add(40*time.Millisecond))

	// Attempt 4: the ladder is spent → dead_lettered terminal.
	clock.Advance(40 * time.Millisecond)
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("attempt 4: %v", err)
	}
	row = readDelivery(t, pool, deliveryID)
	if row.State != "dead_lettered" || row.AttemptCount != 4 {
		t.Fatalf("after exhaustion: %s/%d, want dead_lettered/4", row.State, row.AttemptCount)
	}
	if row.NextAttemptAt != nil || row.DeadLetteredAt == nil {
		t.Fatalf("terminal shape: next=%v dead_lettered_at=%v", row.NextAttemptAt, row.DeadLetteredAt)
	}
	if got := rec.posts(eventID); got != 4 {
		t.Fatalf("receiver saw %d POSTs, want 4 (maxAttemptsFor = len+1)", got)
	}
	// Every attempt signs and sends byte-identical bytes (dedupe contract).
	for i := 1; i < 4; i++ {
		if rec.body(eventID, i) != rec.body(eventID, 0) {
			t.Fatalf("attempt %d body drifted from attempt 1", i+1)
		}
	}
}

// --- AC2 executed: success after retries clears the retry-pending shape ----------

func TestWorkerSuccessAfterRetriesDeliversAndClearsSchedule(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-retry-success")
	endpointID := seedEndpoint(t, pool, orgID, true)
	eventID := uuidFor(903)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)
	rec.mu.Lock()
	rec.script[eventID] = []int{500, 200}
	rec.mu.Unlock()

	clock := newStepClock()
	worker := testWorker(t, pool, newTestTransport(rec), clock, nil)

	if _, err := worker.RunOnce(ctx); err != nil { // attempt 1 fails
		t.Fatalf("attempt 1: %v", err)
	}
	if row := readDelivery(t, pool, deliveryID); row.State != "failed" || row.NextAttemptAt == nil {
		t.Fatalf("after attempt 1: %s next=%v, want failed + scheduled retry", row.State, row.NextAttemptAt)
	}

	clock.Advance(10 * time.Millisecond)
	if _, err := worker.RunOnce(ctx); err != nil { // attempt 2 succeeds
		t.Fatalf("attempt 2: %v", err)
	}

	row := readDelivery(t, pool, deliveryID)
	if row.State != "delivered" || row.AttemptCount != 2 || row.DeliveredAt == nil {
		t.Fatalf("final row: %s/%d delivered_at=%v, want delivered/2", row.State, row.AttemptCount, row.DeliveredAt)
	}
	if row.NextAttemptAt != nil || row.LastError != nil {
		t.Fatalf("delivered row residue: next=%v last_error=%v", row.NextAttemptAt, row.LastError)
	}
	if got := rec.posts(eventID); got != 2 {
		t.Fatalf("receiver saw %d POSTs, want 2", got)
	}
}

// --- AC2 executed: network errors walk the identical schedule --------------------

func TestNetworkErrorsWalkTheSameLadder(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-network")
	endpointID := seedEndpoint(t, pool, orgID, true)
	eventID := uuidFor(904)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)

	// The receiver is CLOSED before the first attempt: every POST fails at
	// transport level (connection refused) — no HTTP status ever exists.
	closedURL := rec.server.URL
	rec.server.Close()

	clock := newStepClock()
	ladder := []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}
	worker := testWorker(t, pool, &rewriteTransport{next: NewHTTPTransport(nil), toBase: closedURL}, clock,
		func(c *Config) { c.Ladder = ladder })

	// Attempts 1..2 record network failures on the ladder schedule.
	for attemptNo := 1; attemptNo <= len(ladder); attemptNo++ {
		before := clock.Now()
		if _, err := worker.RunOnce(ctx); err != nil {
			t.Fatalf("attempt %d: %v", attemptNo, err)
		}
		row := readDelivery(t, pool, deliveryID)
		if row.State != "failed" || row.AttemptCount != attemptNo {
			t.Fatalf("after attempt %d: %s/%d, want failed/%d", attemptNo, row.State, row.AttemptCount, attemptNo)
		}
		assertInstantAlmostEqual(t, "next_attempt_at", *row.NextAttemptAt, before.Add(ladder[attemptNo-1]))
		if row.LastError == nil || !strings.Contains(*row.LastError, "transport error") {
			t.Fatalf("last_error = %v, want a transport error", row.LastError)
		}
		clock.Advance(ladder[attemptNo-1])
	}
	// Attempt 3 exhausts the ladder → dead-letter terminal.
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatalf("exhaustion attempt: %v", err)
	}
	row := readDelivery(t, pool, deliveryID)
	if row.State != "dead_lettered" || row.AttemptCount != len(ladder)+1 || row.DeadLetteredAt == nil {
		t.Fatalf("after network-error exhaustion: %s/%d, want dead_lettered/%d",
			row.State, row.AttemptCount, len(ladder)+1)
	}
	if got := rec.totalPosts(); got != 0 {
		t.Fatalf("closed receiver saw %d POSTs — impossible", got)
	}
}

// --- constraint: revoked/disabled endpoints are never delivered -------------------

func TestInactiveEndpointsAreNeverDelivered(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-inactive")
	endpointID := seedEndpoint(t, pool, orgID, false) // active = false
	eventID := uuidFor(905)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)

	clock := newStepClock()
	worker := testWorker(t, pool, newTestTransport(rec), clock, nil)

	for i := 0; i < 3; i++ {
		progressed, err := worker.RunOnce(ctx)
		if err != nil {
			t.Fatalf("cycle %d: %v", i, err)
		}
		if progressed {
			t.Fatal("an inactive endpoint's delivery must never be claimed")
		}
		clock.Advance(time.Hour) // far past any schedule
	}
	if got := rec.totalPosts(); got != 0 {
		t.Fatalf("inactive endpoint received %d POSTs", got)
	}
	if row := readDelivery(t, pool, deliveryID); row.State != "queued" || row.AttemptCount != 0 {
		t.Fatalf("row = %s/%d, want queued/0 (delivery waits for reactivation)", row.State, row.AttemptCount)
	}
}

// --- claim mechanics: order, lease, recovery --------------------------------------

func TestClaimDueTakesTheOldestDueFirst(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := seedOrg(t, pool, "webhooks-order")
	endpointID := seedEndpoint(t, pool, orgID, true)
	clock := newStepClock()

	ids := make([]string, 0, 3)
	for i, age := range []time.Duration{3 * time.Second, 2 * time.Second, 1 * time.Second} {
		due := clock.Now().Add(-age)
		ids = append(ids, enqueueDelivery(t, pool, orgID, endpointID, uuidFor(910+i), &due))
	}

	store := NewStore(pool, clock)
	lease := time.Minute
	for i, want := range ids {
		claimed, err := store.ClaimDue(ctx, lease)
		if err != nil || claimed == nil {
			t.Fatalf("claim %d = (%v, %v), want a delivery", i, claimed, err)
		}
		if claimed.ID != want {
			t.Fatalf("claim %d = %s, want the oldest due %s", i, claimed.ID, want)
		}
		if claimed.AttemptNo != 1 {
			t.Fatalf("first claim of a fresh row is attempt %d, want 1", claimed.AttemptNo)
		}
	}
	if claimed, err := store.ClaimDue(ctx, lease); err != nil || claimed != nil {
		t.Fatalf("exhausted queue claim = (%v, %v), want (nil, nil)", claimed, err)
	}
}

func TestClaimDueLeaseRecoveryIsTheAtLeastOncePath(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := seedOrg(t, pool, "webhooks-lease")
	endpointID := seedEndpoint(t, pool, orgID, true)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, uuidFor(920), nil)

	store := NewStore(pool, infra.SystemClock{})
	const lease = 300 * time.Millisecond

	first, err := store.ClaimDue(ctx, lease)
	if err != nil || first == nil || first.ID != deliveryID {
		t.Fatalf("first claim = (%v, %v), want the delivery", first, err)
	}
	// Within the lease the `delivering` row is not claimable — a peer cannot
	// steal an in-flight attempt.
	if stolen, err := store.ClaimDue(ctx, lease); err != nil || stolen != nil {
		t.Fatalf("claim inside the lease = (%v, %v), want (nil, nil)", stolen, err)
	}
	// After the lease lapses the row is claimable again — the recovery path
	// for a worker that died between POST and record (at-least-once).
	waitUntil(t, 5*time.Second, func() bool {
		again, err := store.ClaimDue(ctx, lease)
		if err != nil {
			t.Fatalf("recovery claim: %v", err)
		}
		return again != nil
	}, "delivery never became claimable after the lease expired")
}

// --- AC4: crash between POST and record redelivers on restart ---------------------

func TestCrashBetweenPostAndRecordRedeliversOnRestart(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-restart")
	endpointID := seedEndpoint(t, pool, orgID, true)
	eventID := uuidFor(930)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, eventID, nil)

	// Worker A: the POST completes, then the process "crashes" at the
	// documented at-least-once seam (afterPost) — the outcome is never
	// recorded, the row stays `delivering`.
	crashed := testWorker(t, pool, newTestTransport(rec), infra.SystemClock{}, nil)
	crashed.afterPost = func(Claimed) error { return fmt.Errorf("simulated crash: SIGKILL before record") }
	if _, err := crashed.RunOnce(ctx); err == nil {
		t.Fatal("the simulated crash must surface as an error")
	}
	if got := rec.posts(eventID); got != 1 {
		t.Fatalf("receiver saw %d POSTs after the crashed attempt, want 1", got)
	}
	if row := readDelivery(t, pool, deliveryID); row.State != "delivering" || row.AttemptCount != 0 {
		t.Fatalf("post-crash row: %s/%d, want delivering/0 (record never landed)", row.State, row.AttemptCount)
	}

	// Worker B (the restart): claims nothing until the lease expires, then
	// redelivers the same delivery to completion.
	restarted := testWorker(t, pool, newTestTransport(rec), infra.SystemClock{}, nil)
	waitUntil(t, 10*time.Second, func() bool {
		if _, err := restarted.RunOnce(ctx); err != nil {
			t.Fatalf("restart cycle: %v", err)
		}
		return readDelivery(t, pool, deliveryID).State == "delivered"
	}, "the restart never redelivered the crashed delivery")

	row := readDelivery(t, pool, deliveryID)
	if row.State != "delivered" || row.AttemptCount != 1 {
		t.Fatalf("after restart: %s/%d, want delivered/1", row.State, row.AttemptCount)
	}
	if got := rec.posts(eventID); got != 2 {
		t.Fatalf("receiver saw %d POSTs total, want 2 (the crashed POST + the redelivery)", got)
	}
}

// --- AC3: parallel workers never double-claim (SKIP LOCKED + receiver counts) ----

func TestConcurrentWorkersNeverDoubleClaim(t *testing.T) {
	pool := testPool(t)
	rec := newReceiver(t)
	ctx := context.Background()

	orgID := seedOrg(t, pool, "webhooks-concurrent")
	endpointID := seedEndpoint(t, pool, orgID, true)

	const deliveries = 8
	eventIDs := make([]string, deliveries)
	for i := range eventIDs {
		eventIDs[i] = uuidFor(940 + i)
		enqueueDelivery(t, pool, orgID, endpointID, eventIDs[i], nil)
	}

	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	const workers = 4
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		w := testWorker(t, pool, newTestTransport(rec), infra.SystemClock{}, nil)
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- w.Run(runCtx)
		}()
	}

	waitUntil(t, 20*time.Second, func() bool {
		var done int
		if err := pool.QueryRow(ctx,
			`SELECT count(*) FROM webhook_deliveries WHERE state = 'delivered'`,
		).Scan(&done); err != nil {
			t.Fatalf("count delivered: %v", err)
		}
		return done == deliveries
	}, "parallel workers never delivered every delivery")
	cancel()
	wg.Wait()
	for i := 0; i < workers; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("worker %d: %v", i, err)
		}
	}

	// Every delivery was POSTed EXACTLY once and is terminal-delivered:
	// SKIP LOCKED claims distributed the rows; nobody double-claimed.
	for _, eventID := range eventIDs {
		if got := rec.posts(eventID); got != 1 {
			t.Fatalf("event %s received %d POSTs, want exactly 1", eventID, got)
		}
	}
	if total := rec.totalPosts(); total != deliveries {
		t.Fatalf("receiver saw %d POSTs total, want %d", total, deliveries)
	}
	var bad int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM webhook_deliveries
                  WHERE state <> 'delivered' OR attempt_count <> 1 OR next_attempt_at IS NOT NULL`,
	).Scan(&bad); err != nil || bad != 0 {
		t.Fatalf("delivered shape drifted: %d bad rows (err=%v)", bad, err)
	}
}

// --- the record path at the store level: one transaction, guarded ----------------

func TestRecordFailureWritesRecordAndLadderAdvanceTogether(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	orgID := seedOrg(t, pool, "webhooks-record")
	endpointID := seedEndpoint(t, pool, orgID, true)
	deliveryID := enqueueDelivery(t, pool, orgID, endpointID, uuidFor(950), nil)

	clock := newStepClock()
	store := NewStore(pool, clock)
	ladder := []time.Duration{time.Second, 2 * time.Second}

	// Lost-claim drift: a record for an attempt nobody owns is discarded and
	// the row is untouched.
	claimed, err := store.ClaimDue(ctx, time.Minute)
	if err != nil || claimed == nil {
		t.Fatalf("claim: (%v, %v)", claimed, err)
	}
	drift, err := store.RecordFailure(ctx, claimed.ID, 7, "stale attempt", time.Now(), ladder)
	if err != nil || drift.Recorded {
		t.Fatalf("drift record = %+v err %v, want unrecorded", drift, err)
	}
	if row := readDelivery(t, pool, deliveryID); row.State != "delivering" || row.AttemptCount != 0 {
		t.Fatalf("drift mutated the row: %s/%d", row.State, row.AttemptCount)
	}

	// The honest failure: attempt record AND ladder advance commit together.
	at := clock.Now()
	rec1, err := store.RecordFailure(ctx, claimed.ID, claimed.AttemptNo, "endpoint returned http 503", at, ladder)
	if err != nil || !rec1.Recorded || !rec1.WillRetry || rec1.DeadLettered {
		t.Fatalf("failure record = %+v err %v", rec1, err)
	}
	if rec1.NextAttemptAt == nil {
		t.Fatal("a retrying failure must carry the deterministic next attempt")
	}
	row := readDelivery(t, pool, deliveryID)
	if row.State != "failed" || row.AttemptCount != 1 || row.NextAttemptAt == nil {
		t.Fatalf("row after failure: %s/%d next=%v", row.State, row.AttemptCount, row.NextAttemptAt)
	}
	assertInstantAlmostEqual(t, "next_attempt_at", *row.NextAttemptAt, at.Add(time.Second))
	if row.LastError == nil || *row.LastError != "endpoint returned http 503" {
		t.Fatalf("last_error = %v", row.LastError)
	}

	// The retry-pending row re-claims when its schedule arrives (attempt 2),
	// and the second failure schedules ladder[1].
	clock.Advance(time.Second + time.Millisecond)
	claimed2, err := store.ClaimDue(ctx, time.Minute)
	if err != nil || claimed2 == nil || claimed2.AttemptNo != 2 {
		t.Fatalf("retry claim = (%v, %v), want attempt 2", claimed2, err)
	}
	at2 := clock.Now()
	rec2, err := store.RecordFailure(ctx, claimed2.ID, claimed2.AttemptNo, "endpoint returned http 502", at2, ladder)
	if err != nil || !rec2.Recorded || !rec2.WillRetry {
		t.Fatalf("second failure record = %+v err %v", rec2, err)
	}
	row = readDelivery(t, pool, deliveryID)
	assertInstantAlmostEqual(t, "next_attempt_at[2]", *row.NextAttemptAt, at2.Add(2*time.Second))

	// Exhaustion dead-letters (terminal), clearing the schedule.
	clock.Advance(2 * time.Second)
	claimed3, err := store.ClaimDue(ctx, time.Minute)
	if err != nil || claimed3 == nil || claimed3.AttemptNo != len(ladder)+1 {
		t.Fatalf("exhaustion claim = (%v, %v), want attempt %d", claimed3, err, len(ladder)+1)
	}
	rec3, err := store.RecordFailure(ctx, claimed3.ID, claimed3.AttemptNo, "endpoint returned http 500", clock.Now(), ladder)
	if err != nil || !rec3.Recorded || rec3.WillRetry || !rec3.DeadLettered {
		t.Fatalf("exhaustion record = %+v err %v", rec3, err)
	}
	row = readDelivery(t, pool, deliveryID)
	if row.State != "dead_lettered" || row.AttemptCount != len(ladder)+1 || row.DeadLetteredAt == nil || row.NextAttemptAt != nil {
		t.Fatalf("terminal row: %s/%d dead=%v next=%v", row.State, row.AttemptCount, row.DeadLetteredAt, row.NextAttemptAt)
	}

	// Terminal rows are frozen: a further record is refused without touching
	// the row (the schema trigger never even fires — the guard filters it).
	late, err := store.RecordFailure(ctx, claimed3.ID, len(ladder)+2, "late attempt", time.Now(), ladder)
	if err != nil || late.Recorded {
		t.Fatalf("record against a terminal row = %+v err %v, want unrecorded", late, err)
	}
	if again, err := store.RecordSuccess(ctx, claimed3.ID, len(ladder)+2, time.Now()); err != nil || again {
		t.Fatalf("success against a terminal row = (%v, %v), want (false, nil)", again, err)
	}
}
