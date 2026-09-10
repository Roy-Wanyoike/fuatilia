package transport

import (
	"net"
	"strings"
	"sync"
	"time"
)

// Rate limiting (issue #130, PRODUCTION_AUDIT §5.2): a stdlib-only
// token-bucket limiter keyed per principal+IP. One request consumes ONE
// token from exactly ONE bucket:
//
//   - public routes (no Permission) key the bucket by client IP — the abuse
//     surface the audit calls out (health/meta answer anonymous traffic);
//   - permission-carrying routes key the bucket by the authenticated
//     principal + client IP, checked after authentication succeeds (the
//     principal is the identity that owns the budget; the IP keeps tenants
//     sharing one egress address in distinct buckets).
//
// The bucket state sits behind the RateLimitStore PORT: the in-memory
// implementation below is the default, and a deployment may bind a different
// store (e.g. a shared cluster-wide one) through KernelOptions.LimitStore.

// DefaultRateLimitRPM is the per-key per-minute request budget the api
// composition enables when the environment names no explicit value: 300
// requests/minute per principal+IP (5/s sustained), burstable to the full
// minute budget at once.
const DefaultRateLimitRPM = 300

// rateLimitMinIdleTTL floors the eviction age: with the Burst default
// (capacity = the per-minute budget) a bucket refills to full within one
// minute, so any bucket idle past two minutes is provably full and can be
// dropped and re-created losslessly on the next request.
const rateLimitMinIdleTTL = 2 * time.Minute

// rateLimitSweepThreshold is the bucket count that triggers a lazy sweep:
// sweeps only run under pressure, so steady low-cardinality traffic never
// pays for one.
const rateLimitSweepThreshold = 4096

// RateLimitConfig sizes the token-bucket limiter (issue #130: config-only
// limits, env-tunable through RateLimitConfigFromEnv). The zero value
// DISABLES limiting entirely — existing compositions that leave it unset
// keep byte-identical wire behavior.
type RateLimitConfig struct {
	// RequestsPerMinute is the per-key refill budget: the bucket refills at
	// RequestsPerMinute/60 tokens per second. ≤ 0 disables the limiter.
	RequestsPerMinute int
	// Burst is the bucket capacity — the largest instantaneous burst the key
	// may spend. ≤ 0 defaults to RequestsPerMinute (a key may spend its whole
	// minute budget at once, then live at the refill rate).
	Burst int
}

// enabled reports whether the configuration turns the limiter on.
func (c RateLimitConfig) enabled() bool { return c.RequestsPerMinute > 0 }

// normalized applies the Burst default and clamps the refill rate.
func (c RateLimitConfig) normalized() RateLimitConfig {
	out := c
	if out.Burst <= 0 || out.Burst > out.RequestsPerMinute {
		out.Burst = out.RequestsPerMinute
	}
	return out
}

// ratePerSecond is the sustained refill rate (tokens per second).
func (c RateLimitConfig) ratePerSecond() float64 {
	return float64(c.RequestsPerMinute) / 60.0
}

// RateLimitDecision is one Take verdict with the wire-relevant facts.
type RateLimitDecision struct {
	// Allowed reports whether the request consumes a token.
	Allowed bool
	// Limit is the bucket capacity (the effective Burst).
	Limit int
	// Remaining is the token count left AFTER this Take (0 when refused).
	Remaining int
	// RetryAfter is how long until one token refills (0 when allowed; the
	// 429 response renders it as the Retry-After header, seconds).
	RetryAfter time.Duration
}

// RateLimitStore is the limiter STATE port: one atomic Take per request.
// Implementations must be safe for concurrent use and must treat now as the
// sole source of time (the kernel feeds its clock — tests drive a fake).
type RateLimitStore interface {
	Take(key string, now time.Time) RateLimitDecision
}

// tokenBucket is one key's state: floating tokens (fractional refill) and
// the instant the bucket was last touched.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

// InMemoryRateLimitStore is the default RateLimitStore: per-process
// token buckets in a mutex-guarded map. Buckets idle past the store's
// idleTTL are lazily evicted once the map passes rateLimitSweepThreshold, so
// the state is bounded by live key cardinality (principal+IP pairs), not by
// the historical key set.
type InMemoryRateLimitStore struct {
	mu      sync.Mutex
	burst   int
	rate    float64
	idleTTL time.Duration
	buckets map[string]*tokenBucket
}

// NewInMemoryRateLimitStore builds the default in-memory limiter state for
// the configuration (callers must pass a config with enabled() true; the
// kernel only constructs the store when limiting is on).
func NewInMemoryRateLimitStore(config RateLimitConfig) *InMemoryRateLimitStore {
	normalized := config.normalized()
	// Eviction age: 2× the worst-case refill-to-full window (burst / rate),
	// so a swept bucket is provably back at capacity — eviction never hands
	// a key MORE budget than its untouched bucket would have held.
	refillToFull := time.Duration(float64(normalized.Burst) / normalized.ratePerSecond() * float64(time.Second))
	idleTTL := 2 * refillToFull
	if idleTTL < rateLimitMinIdleTTL {
		idleTTL = rateLimitMinIdleTTL
	}
	return &InMemoryRateLimitStore{
		burst:   normalized.Burst,
		rate:    normalized.ratePerSecond(),
		idleTTL: idleTTL,
		buckets: make(map[string]*tokenBucket),
	}
}

// Take consumes one token from the key's bucket at instant now.
func (s *InMemoryRateLimitStore) Take(key string, now time.Time) RateLimitDecision {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(s.buckets) >= rateLimitSweepThreshold {
		s.sweep(now)
	}

	bucket, ok := s.buckets[key]
	if !ok {
		// First sight: the bucket starts full minus this request's token.
		s.buckets[key] = &tokenBucket{tokens: float64(s.burst) - 1, last: now}
		return RateLimitDecision{Allowed: true, Limit: s.burst, Remaining: s.burst - 1}
	}

	// Refill: elapsed time may be zero (a fast/fake clock) or negative (a
	// stepped clock moving backwards) — clamp so time can never mint tokens
	// retroactively or push the bucket past capacity. `last` only ever moves
	// FORWARD: a stepped-back clock must not widen later refill windows.
	elapsed := now.Sub(bucket.last).Seconds()
	if elapsed < 0 {
		elapsed = 0
	}
	bucket.tokens += elapsed * s.rate
	if bucket.tokens > float64(s.burst) {
		bucket.tokens = float64(s.burst)
	}
	if now.After(bucket.last) {
		bucket.last = now
	}

	if bucket.tokens >= 1 {
		bucket.tokens--
		return RateLimitDecision{Allowed: true, Limit: s.burst, Remaining: int(bucket.tokens)}
	}

	// Refused: report the wait for ONE token (Retry-After's honest minimum).
	waitSeconds := (1 - bucket.tokens) / s.rate
	retryAfter := time.Duration(waitSeconds * float64(time.Second))
	if retryAfter < time.Second {
		retryAfter = time.Second
	}
	return RateLimitDecision{Allowed: false, Limit: s.burst, Remaining: 0, RetryAfter: retryAfter}
}

// sweep evicts buckets idle past the store's idleTTL. Caller holds s.mu;
// only runs once the map is under pressure, and only drops provably-full
// buckets (see NewInMemoryRateLimitStore).
func (s *InMemoryRateLimitStore) sweep(now time.Time) {
	for key, bucket := range s.buckets {
		if now.Sub(bucket.last) > s.idleTTL {
			delete(s.buckets, key)
		}
	}
}

// rateLimitKey renders a bucket key: the identity half (principal id, or ""
// for anonymous IP-only buckets) paired with the client IP. The separators
// are unreachable in both components (UUIDs and IP literals never carry
// '|'), so the pair is collision-free.
func rateLimitKey(identity, clientIP string) string {
	return identity + "|" + clientIP
}

// clientIP extracts the bucket's IP half from the live request: the host
// part of RemoteAddr. X-Forwarded-For is deliberately NOT trusted — a
// spoofable identity would let a client rotate buckets and bypass its
// budget; a proxy deployment that terminates connections shares one bucket
// and must size the budget (or bind a proxy-aware store) accordingly.
func clientIP(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return strings.TrimSpace(remoteAddr)
}

// RateLimitConfigFromEnv reads the deployment contract (issue #130):
//
//	FUATILIA_RATE_LIMIT_RPM   — per-key per-minute request budget; "0"
//	                            DISABLES rate limiting; unset →
//	                            DefaultRateLimitRPM (the audit gap closes by
//	                            default, operators opt out explicitly).
//	FUATILIA_RATE_LIMIT_BURST — bucket capacity; unset/empty → the RPM value
//	                            (the whole minute budget may be spent at
//	                            once, then the key lives at the refill rate).
//
// A malformed value is a composition error (boot failure), never silently
// ignored — the same fail-fast rule infra.LoadConfig applies.
func RateLimitConfigFromEnv(env func(string) string) (RateLimitConfig, error) {
	raw := strings.TrimSpace(env("FUATILIA_RATE_LIMIT_RPM"))
	if raw == "" {
		return RateLimitConfig{RequestsPerMinute: DefaultRateLimitRPM}, nil
	}
	rpm, ok := parseEnvInt(raw)
	if !ok {
		return RateLimitConfig{}, errRateLimitConfig("FUATILIA_RATE_LIMIT_RPM must be a non-negative integer (0 disables rate limiting)")
	}
	if rpm == 0 {
		return RateLimitConfig{}, nil
	}
	burst := rpm
	if raw := strings.TrimSpace(env("FUATILIA_RATE_LIMIT_BURST")); raw != "" {
		parsed, ok := parseEnvInt(raw)
		if !ok || parsed < 1 {
			return RateLimitConfig{}, errRateLimitConfig("FUATILIA_RATE_LIMIT_BURST must be a positive integer")
		}
		burst = parsed
	}
	return RateLimitConfig{RequestsPerMinute: rpm, Burst: burst}, nil
}

type rateLimitConfigError string

func (e rateLimitConfigError) Error() string { return string(e) }

func errRateLimitConfig(msg string) error { return rateLimitConfigError("rate limit: " + msg) }
