package transport_test

// Integration evidence for issue #130 (rate limiting + security headers):
// every scenario here drives the REAL composed kernel over real HTTP
// (httptest.Server) with REAL PostgreSQL behind the auth lane, and a
// hand-stepped clock so burst/refill timing is asserted exactly, never
// slept over.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"
)

// steppingClock is the test's clock port: the kernel, the auth lane and the
// limiter all read it, so a single Advance moves the whole world.
type steppingClock struct {
	mu  sync.Mutex
	now time.Time
}

func newSteppingClock() *steppingClock {
	return &steppingClock{now: time.Now().UTC()}
}

func (c *steppingClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *steppingClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// bootRateLimitedKernel composes the REAL kernel with the limiter and header
// policy sized by the caller (config-only, the env contract is unit-pinned)
// and the clock under test control. Every test gets a private world.
func bootRateLimitedKernel(t *testing.T, limits transport.RateLimitConfig, headers transport.SecurityHeaders, clock infra.Clock) (*httptest.Server, *pgxpool.Pool, *world) {
	t.Helper()
	ctx := context.Background()

	cluster, err := pgtest.RequireShared(ctx)
	if err != nil {
		t.Fatalf("pgtest: shared cluster bootstrap failed (the merge gate includes REAL PostgreSQL): %v", err)
	}
	databaseURL := os.Getenv("FUATILIA_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = cluster.DSN(pgtest.SharedDBName)
	}
	if databaseURL == fallbackDatabaseURL && cluster.Port != "5435" {
		databaseURL = cluster.DSN(pgtest.SharedDBName)
	}

	if err := cluster.TruncateAll(ctx, pgtest.SharedDBName); err != nil {
		t.Fatalf("pgtest: truncate lane tables: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = cluster.TruncateAll(cleanupCtx, pgtest.SharedDBName)
	})

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool: %v", err)
	}
	t.Cleanup(pool.Close)

	stores := &repositories.Stores{Pool: pool}
	services := &application.Services{
		Stores:  stores,
		Clock:   clock,
		IDs:     infra.NewUUID,
		Replays: infra.NewIDRegistry(),
	}
	verifier := repositories.NewAuthStore(pool, clock)
	authenticator := &auth.Authenticator{
		Verify: verifier,
		Clock:  clock,
		Audit: func(ctx context.Context, event infra.AuditEvent) error {
			return infra.AppendAuditEvent(ctx, pool, event)
		},
	}
	composed, err := transport.Compose(transport.Deps{
		Services:        services,
		Auth:            authenticator,
		Clock:           clock,
		Limits:          limits,
		SecurityHeaders: headers,
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)), func(err error, requestID string) {
		t.Logf("kernel internal error (requestId=%s): %v", requestID, err)
	})
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	server := httptest.NewServer(composed.Kernel)
	t.Cleanup(server.Close)

	w := seedWorld(t, pool)
	return server, pool, w
}

// callRaw drives one raw request through the real server and returns the
// status, the live header set and the parsed JSON body (call() above keeps
// the body only — the header assertions here are the point).
func callRaw(t *testing.T, server *httptest.Server, method, path, principal string, raw []byte) (int, http.Header, map[string]any) {
	t.Helper()
	var reader io.Reader
	if raw != nil {
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, server.URL+path, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if raw != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if principal != "" {
		req.Header.Set("Authorization", principal)
	}
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	rawBody, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	parsed := map[string]any{}
	if len(rawBody) > 0 {
		if err := json.Unmarshal(rawBody, &parsed); err != nil {
			t.Fatalf("response is not JSON: %v (%s)", err, string(rawBody))
		}
	}
	return res.StatusCode, res.Header, parsed
}

// wantSecurityHeaders asserts the hardening set of issue #130 on one
// response; hsts pins the Strict-Transport-Security flag's outcome.
func wantSecurityHeaders(t *testing.T, name string, header http.Header, hsts string) {
	t.Helper()
	for headerName, want := range map[string]string{
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
		"X-Frame-Options":         "DENY",
	} {
		if got := header.Get(headerName); got != want {
			t.Fatalf("%s: %s = %q, want %q", name, headerName, got, want)
		}
	}
	if got := header.Get("Strict-Transport-Security"); got != hsts {
		t.Fatalf("%s: Strict-Transport-Security = %q, want %q", name, got, hsts)
	}
	if header.Get("X-Request-Id") == "" {
		t.Fatalf("%s: the response must carry the request id", name)
	}
}

// --- limit exhaustion answers the exact contract envelope (AC 1) ---------------------

func TestRateLimitExhaustionAnswersTheContractEnvelope(t *testing.T) {
	server, _, _ := bootRateLimitedKernel(t, transport.RateLimitConfig{RequestsPerMinute: 5}, transport.SecurityHeaders{}, newSteppingClock())

	// the burst passes on the public row…
	for i := 0; i < 5; i++ {
		status, body := call(t, server, "GET", "/v1/health", "", nil)
		if status != 200 {
			t.Fatalf("burst request %d must pass: %d %v", i+1, status, body)
		}
	}
	// …then exhaustion answers 429 in the §38 shape: {error:{code,message},
	// requestId} and nothing else.
	status, header, parsed := callRaw(t, server, "GET", "/v1/health", "", nil)
	if status != 429 {
		t.Fatalf("exhausted bucket must answer 429, got %d (%v)", status, parsed)
	}
	if got := len(parsed); got != 2 {
		t.Fatalf("error envelope must carry exactly error + requestId, has %d keys: %v", got, parsed)
	}
	errObj, _ := parsed["error"].(map[string]any)
	if errObj == nil {
		t.Fatalf("the envelope carries no error object: %v", parsed)
	}
	if errObj["code"] != transport.CodeRateLimited {
		t.Fatalf("error.code = %v, want %s", errObj["code"], transport.CodeRateLimited)
	}
	if message, _ := errObj["message"].(string); message == "" {
		t.Fatalf("the 429 message must explain the refusal: %v", parsed)
	}
	requestID, _ := parsed["requestId"].(string)
	if requestID == "" || requestID != header.Get("X-Request-Id") {
		t.Fatalf("requestId %q must be echoed on x-request-id %q", requestID, header.Get("X-Request-Id"))
	}
	// Retry-After: whole seconds, at least one.
	retryAfter, err := strconv.Atoi(header.Get("Retry-After"))
	if err != nil || retryAfter < 1 {
		t.Fatalf("Retry-After = %q, want a positive integer of seconds", header.Get("Retry-After"))
	}
	wantSecurityHeaders(t, "429 refusal", header, "")
}

// --- authed routes are keyed per principal (AC 1) ------------------------------------

func TestRateLimitAuthedRoutesAreKeyedPerPrincipal(t *testing.T) {
	server, pool, w := bootRateLimitedKernel(t, transport.RateLimitConfig{RequestsPerMinute: 3}, transport.SecurityHeaders{}, newSteppingClock())

	// a second principal (its own api key = its own principal id) sharing the
	// same org AND the same client IP.
	secondKey := seedAPIKey(t, pool, w.OrgID, w.AdminID, "rate-limit-second-secret", []string{"payments:read"})
	second := "ApiKey " + secondKey + ".rate-limit-second-secret"

	// principal A burns its 3-token budget on the authed surface…
	for i := 0; i < 3; i++ {
		status, body := call(t, server, "GET", "/v1/payments", w.AdminToken, nil)
		if status != 200 {
			t.Fatalf("principal A request %d must pass: %d %v", i+1, status, body)
		}
	}
	status, body := call(t, server, "GET", "/v1/payments", w.AdminToken, nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)

	// …principal B — same org, same IP — owns an independent bucket.
	status, body = call(t, server, "GET", "/v1/payments", second, nil)
	if status != 200 {
		t.Fatalf("principal B must not inherit A's exhaustion: %d %v", status, body)
	}
	// B's budget is exhausted independently too.
	status, body = call(t, server, "GET", "/v1/payments", second, nil)
	if status != 200 {
		t.Fatalf("principal B request 2 must pass: %d %v", status, body)
	}
	status, body = call(t, server, "GET", "/v1/payments", second, nil)
	if status != 200 {
		t.Fatalf("principal B request 3 must pass: %d %v", status, body)
	}
	status, body = call(t, server, "GET", "/v1/payments", second, nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)

	// both buckets stay exhausted while the clock stands still.
	status, body = call(t, server, "GET", "/v1/payments", w.AdminToken, nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)
	status, body = call(t, server, "GET", "/v1/payments", second, nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)
}

// --- burst / refill timing with a fake clock (AC 1, issue scope) ----------------------

func TestRateLimitRefillAdvancesExactlyWithTheClock(t *testing.T) {
	clock := newSteppingClock()
	server, _, _ := bootRateLimitedKernel(t, transport.RateLimitConfig{RequestsPerMinute: 60}, transport.SecurityHeaders{}, clock)

	// burst: the whole minute budget is spendable in the same instant…
	for i := 0; i < 60; i++ {
		if status, body := call(t, server, "GET", "/v1/health", "", nil); status != 200 {
			t.Fatalf("burst request %d must pass: %d %v", i+1, status, body)
		}
	}
	// …then the bucket refuses; at 60/minute the wait for one token is 1s.
	_, header, _ := callRaw(t, server, "GET", "/v1/health", "", nil)
	if got := header.Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1 (one token at 60/minute)", got)
	}

	// refill is continuous: just past one refill interval exactly one more
	// request passes, and the next immediate one refuses again.
	clock.Advance(1250 * time.Millisecond)
	if status, body := call(t, server, "GET", "/v1/health", "", nil); status != 200 {
		t.Fatalf("the refilled token must pass: %d %v", status, body)
	}
	status, body := call(t, server, "GET", "/v1/health", "", nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)

	// sustain: a long idle never overfills — after two minutes the bucket is
	// back at exactly the 60-request burst, no more.
	clock.Advance(2 * time.Minute)
	for i := 0; i < 60; i++ {
		if status, body := call(t, server, "GET", "/v1/health", "", nil); status != 200 {
			t.Fatalf("post-idle request %d must pass: %d %v", i+1, status, body)
		}
	}
	status, body = call(t, server, "GET", "/v1/health", "", nil)
	wantError(t, status, body, 429, transport.CodeRateLimited)
}

// --- security headers ride EVERY response (AC 1) --------------------------------------

func TestSecurityHeadersRideEveryResponse(t *testing.T) {
	server, pool, w := bootRateLimitedKernel(t, transport.RateLimitConfig{RequestsPerMinute: 50}, transport.SecurityHeaders{}, newSteppingClock())

	scopedKey := seedAPIKey(t, pool, w.OrgID, w.AdminID, "scoped-down-secret-x", []string{"payments:read"})
	scoped := "ApiKey " + scopedKey + ".scoped-down-secret-x"

	// The whole refusal matrix of the pipeline — success, authed success,
	// malformed body (pre-auth), unauthenticated, audited authorization
	// denial, unknown route, wrong method — hardening headers on all.
	matrix := []struct {
		name      string
		method    string
		path      string
		principal string
		raw       []byte
		status    int
	}{
		{"public success", "GET", "/v1/health", "", nil, 200},
		{"authed success", "GET", "/v1/receivables", w.AdminToken, nil, 200},
		{"malformed body", "POST", "/v1/auth/users", w.AdminToken, []byte("{nope"), 400},
		{"unauthenticated", "GET", "/v1/payments", "", nil, 401},
		{"audited denial", "POST", "/v1/auth/users", scoped, []byte(`{"email":"x@y.test","username":"hdr-matrix","displayName":"X"}`), 403},
		{"unknown route", "GET", "/v1/nope", "", nil, 404},
		{"wrong method", "DELETE", "/v1/health", "", nil, 405},
	}
	for _, tc := range matrix {
		status, header, parsed := callRaw(t, server, tc.method, tc.path, tc.principal, tc.raw)
		if status != tc.status {
			t.Fatalf("%s: status = %d, want %d (%v)", tc.name, status, tc.status, parsed)
		}
		wantSecurityHeaders(t, tc.name, header, "")
	}

	// exhaustion answers 429 — with the hardening set as well.
	for i := 0; i < 49; i++ { // the matrix already spent one public token
		if status, _ := call(t, server, "GET", "/v1/health", "", nil); status != 200 {
			t.Fatalf("burn request %d must pass: %d", i+1, status)
		}
	}
	status, header, parsed := callRaw(t, server, "GET", "/v1/health", "", nil)
	if status != 429 {
		t.Fatalf("exhausted public row must answer 429, got %d (%v)", status, parsed)
	}
	wantSecurityHeaders(t, "429", header, "")
}

// --- HSTS is strictly behind the deployment flag --------------------------------------

func TestHSTSRidesResponsesOnlyWhenTheFlagEnablesIt(t *testing.T) {
	server, _, _ := bootRateLimitedKernel(t, transport.RateLimitConfig{}, transport.SecurityHeaders{HSTSEnabled: true, HSTSMaxAgeSeconds: 600}, newSteppingClock())

	status, header, parsed := callRaw(t, server, "GET", "/v1/health", "", nil)
	if status != 200 {
		t.Fatalf("health: %d %v", status, parsed)
	}
	wantSecurityHeaders(t, "hsts enabled", header, "max-age=600; includeSubDomains")
}
