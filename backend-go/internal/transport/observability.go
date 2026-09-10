package transport

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
)

// Serving-chain wiring (issue #176): the observability stack composed INTO
// the kernel's serving path. The library (#88/#159) was built to wrap the
// kernel FROM THE OUTSIDE — this file is that composition, owned by the
// transport lane:
//
//	request ──▶ /metrics ──▶ Metrics.Handler()   (public scrape route, OUTSIDE the pipeline)
//	        └─▶ anything else ──▶ observability.Middleware ──▶ Kernel.ServeHTTP
//
// Middleware order, outside → in (the runbook contract — every layer may
// assume the ones before it ran):
//
//	 1. route dispatch: GET/HEAD /metrics answers the Prometheus exposition
//	    and never enters the request pipeline — a scrape must not start a
//	    span, grow the duration histogram with a self-referential series or
//	    consume a rate-limit token. Every other path falls through.
//	 2. observability.Middleware: W3C trace context extract → SERVER span →
//	    requestId resolve-or-generate (same shape rule as the kernel, pinned
//	    back into X-Request-Id so the kernel accepts the SAME id) →
//	    request-scoped logger (requestId + traceId) → traceparent +
//	    X-Request-Id response headers BEFORE the first byte → next. Panics
//	    are recorded (span + counter + error log) and re-raised.
//	 3. kernel: security headers → body parse → route match → rate limit →
//	    authenticate/authorize → handler → §38 envelope; handler panics are
//	    recovered by the kernel into the fail-closed 500.
//
// The /metrics mount is deliberately NOT a RouteRecord: the kernel's table
// is the versioned /v1 OpenAPI contract (compileRoute refuses anything
// else), while the exposition is deployment infrastructure. It is public by
// design — the registry is push-fed, carries no secrets, and a scraper has
// no credentials to present; deployments that must restrict it put the
// restriction in front of the process (the same trust boundary that sees
// every other unauthenticated TCP byte).

// metricsMountPath is the public Prometheus scrape route (issue #176).
const metricsMountPath = "/metrics"

// ObservabilityWiring carries the observability handles the serving chain
// binds (issue #176). The zero value is the zero-config boot: the middleware
// still wraps the kernel (W3C pass-through, request ids, per-request logging
// context) but no series exist and /metrics is not mounted — the API then
// answers 404 there through the kernel, exactly like any other unknown path.
type ObservabilityWiring struct {
	// Metrics is the fuatilia_ Prometheus handle: mounted at /metrics and
	// observed per request by the middleware. nil = no mount, no records.
	Metrics *observability.Metrics
	// Tracing supplies the TracerProvider + propagator. nil = no-op tracing
	// — a remote traceparent still passes through to the response, so
	// upstream correlation survives a build without a collector.
	Tracing *observability.Tracing
}

// servingChain assembles the full public surface (see the type doc for the
// middleware order). log is the base (redacted) logger the middleware
// derives every per-request logger from; nil degrades to slog.Default().
func servingChain(kernel *Kernel, wiring ObservabilityWiring, security SecurityHeaders, log *slog.Logger) http.Handler {
	var metricsHandler http.Handler
	if wiring.Metrics != nil {
		metricsHandler = wiring.Metrics.Handler()
	}
	api := observability.Middleware(observability.MiddlewareOptions{
		Log:     log,
		Metrics: wiring.Metrics,
		Tracing: wiring.Tracing,
		Route:   kernel.RouteLabeler(),
	})(kernel)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if metricsHandler != nil && r.URL != nil && r.URL.Path == metricsMountPath {
			// The same hardening set the kernel applies — one surface, one
			// header policy, scrapes included.
			security.apply(w.Header())
			switch r.Method {
			case http.MethodGet, http.MethodHead:
				metricsHandler.ServeHTTP(w, r)
			default:
				w.Header().Set("Allow", "GET, HEAD")
				w.WriteHeader(http.StatusMethodNotAllowed)
			}
			return
		}
		api.ServeHTTP(w, r)
	})
}

// RouteLabeler builds the low-cardinality route resolver for the
// observability middleware from the kernel's mounted table (issue #176): it
// matches the request path against the registered patterns and answers the
// PATTERN ("/v1/ledger/:id"), never the URL path — raw paths (or path
// segments) would make every http_* label unbounded.
//
// Matching is method-agnostic on purpose: the HTTP method is already its own
// metric label, and a 405 (path exists under other methods) must still be
// attributed to the route that exists. A path no pattern covers answers ""
// — the middleware falls back to its shared "unresolved" label, so 404s and
// malformed escapes cost one series, not one per URL ever requested.
func (k *Kernel) RouteLabeler() func(*http.Request) string {
	patterns := make([]routePattern, 0, len(k.table))
	for _, record := range k.table {
		patterns = append(patterns, newRoutePattern(record.Pattern))
	}
	return func(r *http.Request) string {
		if r == nil || r.URL == nil {
			return ""
		}
		parts := splitPathParts(r.URL.EscapedPath())
		for _, p := range patterns {
			if p.matches(parts) {
				return p.pattern
			}
		}
		return ""
	}
}

// routePattern is one registered pattern pre-split for labeler matching.
type routePattern struct {
	pattern  string
	segments []string
}

func newRoutePattern(pattern string) routePattern {
	return routePattern{
		pattern:  pattern,
		segments: strings.Split(strings.TrimPrefix(pattern, "/"), "/"),
	}
}

// matches mirrors the kernel matcher's path rules (matchRoute): the segment
// count must agree, literals compare exactly and :params match any single
// segment. EscapedPath keeps percent-escapes ENCODED — a %2F can never split
// a segment, so the answer is always a registered pattern or "".
func (p routePattern) matches(parts []string) bool {
	if len(p.segments) != len(parts) {
		return false
	}
	for i, segment := range p.segments {
		if strings.HasPrefix(segment, ":") {
			continue
		}
		if segment != parts[i] {
			return false
		}
	}
	return true
}

// splitPathParts normalizes ONE trailing slash in place (the kernel matcher
// tolerates `/v1/health/` ≡ `/v1/health`) and splits into segments.
func splitPathParts(path string) []string {
	normalized := path
	if len(normalized) > 1 && strings.HasSuffix(normalized, "/") {
		normalized = normalized[:len(normalized)-1]
	}
	return strings.Split(strings.TrimPrefix(normalized, "/"), "/")
}
