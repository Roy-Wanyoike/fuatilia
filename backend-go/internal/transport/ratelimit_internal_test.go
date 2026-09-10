package transport

// Unit tests for the rate limiter and security headers (issue #130): the
// token-bucket math runs against a hand-driven clock — burst, sustain and
// refill are asserted exactly, never approximately — and the kernel wiring
// is exercised through ServeHTTP with httptest.ResponseRecorders.

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// --- the token bucket: burst / sustain / refill at exact instants ----------

func TestTokenBucketBurstSustainRefill(t *testing.T) {
	// 60 requests/minute = 1 token/second, burst 60: the whole minute budget
	// is spendable at once, then the key lives at the refill rate.
	store := NewInMemoryRateLimitStore(RateLimitConfig{RequestsPerMinute: 60})
	t0 := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)

	// burst: exactly 60 requests pass in the same instant…
	for i := 0; i < 60; i++ {
		d := store.Take("k", t0)
		if !d.Allowed {
			t.Fatalf("request %d of the burst must pass at the same instant: %+v", i+1, d)
		}
		if d.Limit != 60 {
			t.Fatalf("decision.Limit = %d, want the burst capacity 60", d.Limit)
		}
		if want := 59 - i; d.Remaining != want {
			t.Fatalf("request %d Remaining = %d, want %d", i+1, d.Remaining, want)
		}
	}
	// …and the 61st refuses with the one-second wait.
	refused := store.Take("k", t0)
	if refused.Allowed || refused.Remaining != 0 {
		t.Fatalf("exhausted bucket must refuse: %+v", refused)
	}
	if refused.RetryAfter != time.Second {
		t.Fatalf("RetryAfter = %v, want 1s (the wait for one token)", refused.RetryAfter)
	}

	// sustain: a long idle never overfills — the bucket caps at the burst.
	d := store.Take("k", t0.Add(10*time.Minute))
	if !d.Allowed || d.Remaining != 59 {
		t.Fatalf("after a long idle the bucket is full minus this token: %+v", d)
	}
	// burn the remaining 59 tokens at that same instant.
	for i := 0; i < 59; i++ {
		if d := store.Take("k", t0.Add(10*time.Minute)); !d.Allowed {
			t.Fatalf("burn request %d must pass: %+v", i+1, d)
		}
	}
	// refill: half a second in, the half-token is not spendable — and the
	// sub-second wait floors the RetryAfter to one second.
	d = store.Take("k", t0.Add(10*time.Minute+500*time.Millisecond))
	if d.Allowed {
		t.Fatalf("0.5 tokens must not pass: %+v", d)
	}
	if d.RetryAfter != time.Second {
		t.Fatalf("sub-second wait must floor the RetryAfter to 1s: %v", d.RetryAfter)
	}
	// half a second more makes exactly one token spendable, once.
	d = store.Take("k", t0.Add(10*time.Minute+time.Second))
	if !d.Allowed || d.Remaining != 0 {
		t.Fatalf("one refilled token must pass once: %+v", d)
	}
	d = store.Take("k", t0.Add(10*time.Minute+time.Second))
	if d.Allowed {
		t.Fatalf("continuous refill is not an instant grant: %+v", d)
	}
}

func TestTokenBucketRefillRateFollowsConfig(t *testing.T) {
	// 6/minute = 0.1 tokens/second: after exhaustion the wait for one token
	// is 10 seconds.
	store := NewInMemoryRateLimitStore(RateLimitConfig{RequestsPerMinute: 6})
	t0 := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 6; i++ {
		if d := store.Take("k", t0); !d.Allowed {
			t.Fatalf("burst request %d must pass: %+v", i+1, d)
		}
	}
	d := store.Take("k", t0)
	if d.Allowed || d.RetryAfter != 10*time.Second {
		t.Fatalf("want refusal with RetryAfter 10s, got %+v", d)
	}
	// 9.9 seconds in: still not enough for a whole token.
	if d := store.Take("k", t0.Add(9900*time.Millisecond)); d.Allowed {
		t.Fatalf("0.99 tokens must not pass: %+v", d)
	}
	// 10 seconds in: exactly one token.
	if d := store.Take("k", t0.Add(10*time.Second)); !d.Allowed || d.Remaining != 0 {
		t.Fatalf("one token must pass at the 10s mark: %+v", d)
	}
}

func TestTokenBucketPerKeyIsolation(t *testing.T) {
	store := NewInMemoryRateLimitStore(RateLimitConfig{RequestsPerMinute: 3})
	t0 := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 3; i++ {
		if d := store.Take("principal-a|10.0.0.1", t0); !d.Allowed {
			t.Fatalf("principal A request %d must pass: %+v", i+1, d)
		}
	}
	if d := store.Take("principal-a|10.0.0.1", t0); d.Allowed {
		t.Fatalf("principal A is exhausted: %+v", d)
	}
	// a different principal from the SAME IP owns an independent bucket…
	if d := store.Take("principal-b|10.0.0.1", t0); !d.Allowed {
		t.Fatalf("principal B must not inherit A's exhaustion: %+v", d)
	}
	// …and the same principal from a different IP too.
	if d := store.Take("principal-a|10.0.0.2", t0); !d.Allowed {
		t.Fatalf("principal A from another IP owns an independent bucket: %+v", d)
	}
}

func TestTokenBucketNeverMintsTokensFromSteppedBackClocks(t *testing.T) {
	store := NewInMemoryRateLimitStore(RateLimitConfig{RequestsPerMinute: 60})
	t0 := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 60; i++ {
		store.Take("k", t0)
	}
	// the clock steps backwards: no retroactive refill…
	if d := store.Take("k", t0.Add(-time.Hour)); d.Allowed {
		t.Fatalf("a stepped-back clock must not mint tokens: %+v", d)
	}
	// …and `last` did not move backwards — one second forward grants
	// exactly ONE token, not an hour's worth.
	if d := store.Take("k", t0.Add(time.Second)); !d.Allowed || d.Remaining != 0 {
		t.Fatalf("exactly one token must refill: %+v", d)
	}
	if d := store.Take("k", t0.Add(time.Second)); d.Allowed {
		t.Fatalf("the hour that 'never happened' must not refill: %+v", d)
	}
}

func TestInMemoryStoreEvictsIdleBucketsLosslessly(t *testing.T) {
	store := NewInMemoryRateLimitStore(RateLimitConfig{RequestsPerMinute: 60})
	t0 := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	// pressure: fill past the sweep threshold (nothing is idle yet).
	for i := 0; i <= rateLimitSweepThreshold; i++ {
		store.Take(fmt.Sprintf("k%d", i), t0)
	}
	if len(store.buckets) <= rateLimitSweepThreshold {
		t.Fatalf("expected %d live buckets before the idle window, have %d", rateLimitSweepThreshold+1, len(store.buckets))
	}
	// beyond the idle TTL a sweep runs on the next Take…
	store.Take("fresh", t0.Add(5*time.Minute))
	if got := len(store.buckets); got != 1 {
		t.Fatalf("idle buckets must be evicted, %d remain", got)
	}
	// …and eviction is lossless: an evicted key restarts full (its untouched
	// bucket had refilled to capacity long before the sweep).
	if d := store.Take("k0", t0.Add(5*time.Minute)); !d.Allowed || d.Remaining != 59 {
		t.Fatalf("evicted key must restart at a full bucket: %+v", d)
	}
}

func TestRateLimitConfigNormalized(t *testing.T) {
	if (RateLimitConfig{}).enabled() {
		t.Fatalf("the zero config must DISABLE limiting")
	}
	if !(RateLimitConfig{RequestsPerMinute: 1}).enabled() {
		t.Fatalf("a positive RPM enables limiting")
	}
	// Burst defaults to the RPM budget…
	if got := (RateLimitConfig{RequestsPerMinute: 300}).normalized().Burst; got != 300 {
		t.Fatalf("default Burst = %d, want 300", got)
	}
	// …and an explicit larger burst is respected (slow refill, big capacity).
	if got := (RateLimitConfig{RequestsPerMinute: 5, Burst: 100}).normalized().Burst; got != 100 {
		t.Fatalf("explicit Burst = %d, want 100", got)
	}
}

// --- the env contract ---------------------------------------------------------

func TestRateLimitConfigFromEnv(t *testing.T) {
	t.Run("defaults enable the limiter", func(t *testing.T) {
		cfg, err := RateLimitConfigFromEnv(func(string) string { return "" })
		if err != nil {
			t.Fatalf("defaults must parse: %v", err)
		}
		if cfg.RequestsPerMinute != DefaultRateLimitRPM {
			t.Fatalf("default RPM = %d, want %d", cfg.RequestsPerMinute, DefaultRateLimitRPM)
		}
		if got := NewInMemoryRateLimitStore(cfg).burst; got != DefaultRateLimitRPM {
			t.Fatalf("default burst = %d, want %d", got, DefaultRateLimitRPM)
		}
	})
	t.Run("explicit rpm and burst", func(t *testing.T) {
		cfg, err := RateLimitConfigFromEnv(func(name string) string {
			if name == "FUATILIA_RATE_LIMIT_RPM" {
				return " 120 "
			}
			if name == "FUATILIA_RATE_LIMIT_BURST" {
				return "30"
			}
			return ""
		})
		if err != nil {
			t.Fatalf("explicit values must parse: %v", err)
		}
		if cfg.RequestsPerMinute != 120 || cfg.Burst != 30 {
			t.Fatalf("cfg = %+v, want RPM 120 burst 30", cfg)
		}
	})
	t.Run("zero disables", func(t *testing.T) {
		cfg, err := RateLimitConfigFromEnv(func(string) string { return "0" })
		if err != nil {
			t.Fatalf("zero must parse: %v", err)
		}
		if cfg.enabled() {
			t.Fatalf("RPM=0 must disable the limiter: %+v", cfg)
		}
	})
	t.Run("malformed values are boot failures", func(t *testing.T) {
		for name, env := range map[string]map[string]string{
			"rpm garbage":   {"FUATILIA_RATE_LIMIT_RPM": "soon"},
			"rpm negative":  {"FUATILIA_RATE_LIMIT_RPM": "-5"},
			"burst zero":    {"FUATILIA_RATE_LIMIT_RPM": "60", "FUATILIA_RATE_LIMIT_BURST": "0"},
			"burst garbage": {"FUATILIA_RATE_LIMIT_RPM": "60", "FUATILIA_RATE_LIMIT_BURST": "ten"},
		} {
			if _, err := RateLimitConfigFromEnv(func(k string) string { return env[k] }); err == nil {
				t.Fatalf("%s: must fail composition, never silently ignore", name)
			}
		}
	})
}

// --- security headers ----------------------------------------------------------

func TestSecurityHeadersApply(t *testing.T) {
	h := http.Header{}
	SecurityHeaders{}.apply(h)
	for name, want := range map[string]string{
		"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
		"X-Content-Type-Options":  "nosniff",
		"Referrer-Policy":         "no-referrer",
		"X-Frame-Options":         "DENY",
	} {
		if got := h.Get(name); got != want {
			t.Fatalf("%s = %q, want %q", name, got, want)
		}
	}
	if h.Get(securityHSTSHeader) != "" {
		t.Fatalf("HSTS must stay off unless the deployment flag turns it on")
	}

	h = http.Header{}
	SecurityHeaders{HSTSEnabled: true}.apply(h)
	if got := h.Get(securityHSTSHeader); got != "max-age=31536000; includeSubDomains" {
		t.Fatalf("default HSTS = %q", got)
	}

	h = http.Header{}
	SecurityHeaders{HSTSEnabled: true, HSTSMaxAgeSeconds: 600}.apply(h)
	if got := h.Get(securityHSTSHeader); got != "max-age=600; includeSubDomains" {
		t.Fatalf("configured HSTS = %q", got)
	}
}

func TestSecurityHeadersFromEnv(t *testing.T) {
	t.Run("off by default", func(t *testing.T) {
		out, err := SecurityHeadersFromEnv(func(string) string { return "" })
		if err != nil || out.HSTSEnabled {
			t.Fatalf("HSTS defaults off: %+v %v", out, err)
		}
	})
	t.Run("truthy flags enable", func(t *testing.T) {
		for _, v := range []string{"1", "true", "on", "yes", "TRUE"} {
			out, err := SecurityHeadersFromEnv(func(name string) string {
				if name == "FUATILIA_HSTS_ENABLED" {
					return v
				}
				return ""
			})
			if err != nil || !out.HSTSEnabled {
				t.Fatalf("FUATILIA_HSTS_ENABLED=%q must enable: %+v %v", v, out, err)
			}
		}
	})
	t.Run("falsy flags keep it off", func(t *testing.T) {
		for _, v := range []string{"", "0", "false", "off", "no"} {
			out, err := SecurityHeadersFromEnv(func(name string) string {
				if name == "FUATILIA_HSTS_ENABLED" {
					return v
				}
				return ""
			})
			if err != nil || out.HSTSEnabled {
				t.Fatalf("FUATILIA_HSTS_ENABLED=%q must keep HSTS off: %+v %v", v, out, err)
			}
		}
	})
	t.Run("max-age parses or fails fast", func(t *testing.T) {
		out, err := SecurityHeadersFromEnv(func(name string) string {
			if name == "FUATILIA_HSTS_ENABLED" {
				return "1"
			}
			if name == "FUATILIA_HSTS_MAX_AGE" {
				return "600"
			}
			return ""
		})
		if err != nil || out.HSTSMaxAgeSeconds != 600 {
			t.Fatalf("max-age 600 must parse: %+v %v", out, err)
		}
		for _, v := range []string{"0", "-1", "a year"} {
			if _, err := SecurityHeadersFromEnv(func(name string) string {
				if name == "FUATILIA_HSTS_MAX_AGE" {
					return v
				}
				return ""
			}); err == nil {
				t.Fatalf("max-age %q must fail composition", v)
			}
		}
	})
	t.Run("garbage flag fails fast", func(t *testing.T) {
		if _, err := SecurityHeadersFromEnv(func(name string) string {
			if name == "FUATILIA_HSTS_ENABLED" {
				return "maybe"
			}
			return ""
		}); err == nil {
			t.Fatalf("a garbage boolean must fail composition")
		}
	})
}

// --- client IP extraction -------------------------------------------------------

func TestClientIP(t *testing.T) {
	if got := clientIP("203.0.113.7:51000"); got != "203.0.113.7" {
		t.Fatalf("ipv4 host = %q", got)
	}
	if got := clientIP("[2001:db8::1]:443"); got != "2001:db8::1" {
		t.Fatalf("ipv6 host = %q", got)
	}
	if got := clientIP("203.0.113.9"); got != "203.0.113.9" {
		t.Fatalf("portless addr passes through: %q", got)
	}
}

// --- the kernel wiring ------------------------------------------------------------

// fixedNower is the deterministic kernel clock for the wiring tests.
type fixedNower struct{ at time.Time }

func (c fixedNower) Now() time.Time { return c.at }

func publicLimitKernel(t *testing.T, limits RateLimitConfig, clock infra.Clock) *Kernel {
	t.Helper()
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{
			{Method: "GET", Pattern: "/v1/health", Handler: func(*RequestContext) (HandlerResult, error) {
				return HandlerResult{Status: 200, Data: map[string]any{"status": "ok"}}, nil
			}},
			{Method: "POST", Pattern: "/v1/things", Handler: noopHandler},
		},
		Clock:  clock,
		Limits: limits,
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	return k
}

func serveFromIP(k *Kernel, method, target, ip string, body io.Reader) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, body)
	req.RemoteAddr = ip + ":51000"
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, req)
	return rec
}

func TestKernelRateLimitsPublicRoutesPerIP(t *testing.T) {
	k := publicLimitKernel(t, RateLimitConfig{RequestsPerMinute: 3}, fixedNower{time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)})

	// the burst passes…
	for i := 0; i < 3; i++ {
		rec := serveFromIP(k, "GET", "/v1/health", "9.9.9.9", nil)
		if rec.Code != 200 {
			t.Fatalf("burst request %d: status = %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	// …then the SAME IP refuses with the contract envelope…
	rec := serveFromIP(k, "GET", "/v1/health", "9.9.9.9", nil)
	assertErrorEnvelope(t, rec, 429, CodeRateLimited)
	if got := rec.Header().Get("Retry-After"); got != "20" {
		t.Fatalf("Retry-After = %q, want 20 (one token at 3/minute)", got)
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("429 body is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body.Error.Message == "" {
		t.Fatalf("the 429 message must explain the refusal: %s", rec.Body.String())
	}
	if body.RequestID == "" || body.RequestID != rec.Header().Get("X-Request-Id") {
		t.Fatalf("the 429 envelope must carry the echoed requestId: %q vs %q", body.RequestID, rec.Header().Get("X-Request-Id"))
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("429 body is not an object: %v", err)
	}
	if _, ok := keys["data"]; ok || len(keys) != 2 {
		t.Fatalf("an error envelope carries exactly {error, requestId}: %s", rec.Body.String())
	}
	// …while a DIFFERENT IP owns its own bucket.
	if rec := serveFromIP(k, "GET", "/v1/health", "8.8.8.8", nil); rec.Code != 200 {
		t.Fatalf("another IP must not inherit the exhausted bucket: %d", rec.Code)
	}
}

// scriptedStore is the fake RateLimitStore proving the port is real: the
// kernel delegates every Take to the bound store and feeds it its own clock.
type scriptedStore struct {
	mu       sync.Mutex
	keys     []string
	nows     []time.Time
	decision RateLimitDecision
}

func (s *scriptedStore) Take(key string, now time.Time) RateLimitDecision {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys = append(s.keys, key)
	s.nows = append(s.nows, now)
	return s.decision
}

func TestKernelDelegatesToTheBoundLimitStore(t *testing.T) {
	now := time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)
	store := &scriptedStore{decision: RateLimitDecision{Allowed: false, Limit: 7, RetryAfter: 7 * time.Second}}
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{{Method: "GET", Pattern: "/v1/health", Handler: func(*RequestContext) (HandlerResult, error) {
			t.Fatalf("an exhausted store must stop the pipeline before the handler")
			return HandlerResult{}, nil
		}}},
		Clock:      fixedNower{now},
		Limits:     RateLimitConfig{RequestsPerMinute: 7},
		LimitStore: store,
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	rec := serveFromIP(k, "GET", "/v1/health", "9.9.9.9", nil)
	assertErrorEnvelope(t, rec, 429, CodeRateLimited)
	if got := rec.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After = %q, want the store's 7", got)
	}
	if len(store.keys) != 1 {
		t.Fatalf("exactly one Take must happen per request, got %d", len(store.keys))
	}
	if store.keys[0] != "|9.9.9.9" {
		t.Fatalf("anonymous public key = %q, want identity|ip", store.keys[0])
	}
	if !store.nows[0].Equal(now) {
		t.Fatalf("the store must receive the KERNEL's clock, got %v want %v", store.nows[0], now)
	}
}

func TestKernelSecurityHeadersRideEveryResponse(t *testing.T) {
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{
			{Method: "GET", Pattern: "/v1/health", Handler: noopHandler},
		},
		Clock:           fixedNower{time.Date(2025, 3, 4, 10, 0, 0, 0, time.UTC)},
		SecurityHeaders: SecurityHeaders{HSTSEnabled: true},
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	for _, tc := range []struct {
		name   string
		method string
		target string
		body   io.Reader
		status int
	}{
		{"success", "GET", "/v1/health", nil, 200},
		{"not found", "GET", "/v1/nope", nil, 404},
		{"method not allowed", "DELETE", "/v1/health", nil, 405},
		{"malformed body", "POST", "/v1/things", strings.NewReader("{nope"), 400},
	} {
		rec := serveFromIP(k, tc.method, tc.target, "9.9.9.9", tc.body)
		if rec.Code != tc.status {
			t.Fatalf("%s: status = %d, want %d (body %s)", tc.name, rec.Code, tc.status, rec.Body.String())
		}
		for name, want := range map[string]string{
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options":  "nosniff",
			"Referrer-Policy":         "no-referrer",
			"X-Frame-Options":         "DENY",
			securityHSTSHeader:        "max-age=31536000; includeSubDomains",
		} {
			if got := rec.Header().Get(name); got != want {
				t.Fatalf("%s: %s = %q, want %q", tc.name, name, got, want)
			}
		}
	}
}

func TestStatusForCodeRateLimited(t *testing.T) {
	if got := StatusForCode(CodeRateLimited); got != 429 {
		t.Fatalf("StatusForCode(HTTP_RATE_LIMITED) = %d, want 429", got)
	}
}
