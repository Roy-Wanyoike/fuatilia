package observability

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// HTTP middleware (issue #88): the net/http-native seam the kernel is
// wrapped with FROM THE OUTSIDE — no kernel file changes. Per request it:
//
//   - extracts W3C tracecontext (+baggage) from the incoming headers and
//     injects it into the outbound response (disabled tracing passes the
//     remote context through untouched — the noop tracer preserves it);
//   - starts a SERVER span and observes the duration histogram, the
//     request/response size counters and the requests counter;
//   - captures panics (span status + event, panic counter, error log) and
//     RE-RAISES them — behavior of whatever runs underneath is unchanged;
//   - resolves the requestId exactly like the transport kernel
//     (X-Request-Id → X-Correlation-ID → generated, [A-Za-z0-9._-] ≤128,
//     ill-formed values regenerated — the generated id is written back into
//     the request headers so the kernel accepts the SAME id) and places
//     requestId + traceId into the per-request slog context, retrievable
//     downstream with RequestLoggerFrom / RequestIDFrom.

const (
	// Header names mirror the transport kernel's constants (kernel files are
	// untouched this wave — the literals are pinned by parity tests).
	headerRequestID     = "X-Request-Id"
	headerCorrelationID = "X-Correlation-ID"

	// slog attribute keys of the per-request logger context — the same
	// names the kernel's access log uses.
	AttrRequestID = "requestId"
	AttrTraceID   = "traceId"

	tracerName = "github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"

	spanAttrHTTPMethod        = attribute.Key("http.method")
	spanAttrHTTPRoute         = attribute.Key("http.route")
	spanAttrHTTPStatusCode    = attribute.Key("http.status_code")
	spanAttrHTTPRequestBytes  = attribute.Key("http.request_content_length")
	spanAttrHTTPResponseBytes = attribute.Key("http.response_content_length")
)

// MiddlewareOptions compose the observability middleware. Every field is
// optional: nil Metrics / nil Tracing degrade to no-ops, nil Log falls back
// to slog.Default(), nil Route labels every request "unresolved".
type MiddlewareOptions struct {
	// Log is the base (redacted) logger; per-request loggers derive from it.
	Log *slog.Logger
	// Metrics receives the duration/size/request/panic records.
	Metrics *Metrics
	// Tracing supplies the tracer + propagator; nil = no-op tracing with
	// W3C propagation.
	Tracing *Tracing
	// Route resolves the low-cardinality route label (next wave: built from
	// Kernel.Table()). It must NEVER return the raw URL path.
	Route func(r *http.Request) string
	// NewRequestID generates ids for requests without a valid incoming one
	// (nil → infra.NewUUID, the kernel's generator).
	NewRequestID func() string
}

// Middleware wraps next with the observability pipeline. Composition bug
// (nil next) fails fast at wrap time.
func Middleware(opts MiddlewareOptions) func(http.Handler) http.Handler {
	base := opts.Log
	if base == nil {
		base = slog.Default()
	}
	newRequestID := opts.NewRequestID
	if newRequestID == nil {
		newRequestID = infra.NewUUID
	}
	tracer := noop.NewTracerProvider().Tracer(tracerName)
	if opts.Tracing != nil {
		tracer = opts.Tracing.Tracer(tracerName)
	}
	propagator := propagation.TextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{}))
	if opts.Tracing != nil {
		propagator = opts.Tracing.Propagator
	}

	return func(next http.Handler) http.Handler {
		if next == nil {
			panic("observability: Middleware wrapped without a next handler")
		}
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			route := unresolvedRoute
			if opts.Route != nil {
				if resolved := opts.Route(r); resolved != "" {
					route = resolved
				}
			}
			requestID := acceptOrGenerateRequestID(r, newRequestID)

			// Request size: count actual reads; fall back to the declared
			// Content-Length when the handler never drains the body.
			var bodyCounter *countingReadCloser
			if r.Body != nil && r.Body != http.NoBody {
				bodyCounter = &countingReadCloser{rc: r.Body}
				r.Body = bodyCounter
			}

			start := time.Now()
			ctx := propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
			ctx, span := tracer.Start(ctx, r.Method+" "+route, trace.WithSpanKind(trace.SpanKindServer))
			span.SetAttributes(
				spanAttrHTTPMethod.String(r.Method),
				spanAttrHTTPRoute.String(route),
			)
			spanContext := span.SpanContext()
			if !spanContext.IsValid() {
				// Disabled (or unsampled-to-noop) provider: carry the remote
				// context through so correlation survives without a collector.
				spanContext = trace.SpanContextFromContext(ctx)
			}

			reqLog := base.With(
				slog.String(AttrRequestID, requestID),
				slog.String(AttrTraceID, traceIDString(spanContext)),
			)
			ctx = context.WithValue(ctx, contextKeyRequestID{}, requestID)
			ctx = context.WithValue(ctx, contextKeyRequestLogger{}, reqLog)
			r = r.WithContext(ctx)

			// Outbound response: trace context + the accepted request id,
			// both before the first write so nothing is ever too late.
			w.Header().Set(headerRequestID, requestID)
			propagator.Inject(ctx, propagation.HeaderCarrier(w.Header()))

			recorder := &countingResponseWriter{ResponseWriter: w}
			defer func() {
				elapsed := time.Since(start)
				if recovered := recover(); recovered != nil {
					cause := fmt.Errorf("panic: %v", recovered)
					span.RecordError(cause)
					span.SetStatus(codes.Error, cause.Error())
					status := http.StatusInternalServerError
					if recorder.wroteHeader {
						status = recorder.status
					}
					opts.Metrics.ObserveHTTP(r.Method, route, status, elapsed, requestBytes(r, bodyCounter), recorder.bytes)
					opts.Metrics.CountHTTPPanic(r.Method, route)
					reqLog.Error("http.panic",
						slog.String("method", r.Method),
						slog.String("route", route),
						slog.String("panic", fmt.Sprint(recovered)),
					)
					span.End()
					panic(recovered) // re-raise: unchanged behavior upstream
				}
				status := recorder.status
				span.SetAttributes(
					spanAttrHTTPStatusCode.Int(status),
					spanAttrHTTPRequestBytes.Int64(requestBytes(r, bodyCounter)),
					spanAttrHTTPResponseBytes.Int64(recorder.bytes),
				)
				if status >= 500 {
					span.SetStatus(codes.Error, strconv.Itoa(status))
				}
				opts.Metrics.ObserveHTTP(r.Method, route, status, elapsed, requestBytes(r, bodyCounter), recorder.bytes)
				span.End()
			}()

			next.ServeHTTP(recorder, r)
		})
	}
}

// acceptOrGenerateRequestID mirrors the kernel's resolveRequestID contract
// (X-Request-Id → X-Correlation-ID → generated; the same shape rule) and
// writes the resolved id back into the request so every layer downstream —
// the kernel included — reports the SAME id.
func acceptOrGenerateRequestID(r *http.Request, generate func() string) string {
	candidate := strings.TrimSpace(r.Header.Get(headerRequestID))
	if candidate == "" {
		candidate = strings.TrimSpace(r.Header.Get(headerCorrelationID))
	}
	if !validRequestID(candidate) {
		id := strings.TrimSpace(generate())
		if !validRequestID(id) {
			// A broken generator must not poison the header — fall back to the
			// kernel's own uuid shape.
			id = infra.NewUUID()
		}
		candidate = id
	}
	// Pin the resolved id into X-Request-Id — the generated one so the kernel
	// accepts the SAME id, and the correlation fallback so trimming or
	// promotion cannot fork the id across layers.
	r.Header.Set(headerRequestID, candidate)
	return candidate
}

// validRequestID is the kernel's opaque-token rule: [A-Za-z0-9._-], ≤128 —
// anything else could smuggle header/log injection.
func validRequestID(candidate string) bool {
	if candidate == "" || len(candidate) > 128 {
		return false
	}
	for _, c := range candidate {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

func traceIDString(sc trace.SpanContext) string {
	if !sc.IsValid() {
		return ""
	}
	return sc.TraceID().String()
}

func requestBytes(r *http.Request, counter *countingReadCloser) int64 {
	if counter != nil && counter.n > 0 {
		return counter.n
	}
	if r.ContentLength > 0 {
		return r.ContentLength
	}
	return 0
}

// context keys — observability-owned request context values.
type contextKeyRequestLogger struct{}
type contextKeyRequestID struct{}

// RequestLoggerFrom returns the per-request logger (requestId + traceId in
// its attribute context); slog.Default() when absent.
func RequestLoggerFrom(ctx context.Context) *slog.Logger {
	if ctx != nil {
		if log, ok := ctx.Value(contextKeyRequestLogger{}).(*slog.Logger); ok && log != nil {
			return log
		}
	}
	return slog.Default()
}

// RequestIDFrom returns the resolved request id ("" when absent).
func RequestIDFrom(ctx context.Context) string {
	if ctx != nil {
		if id, ok := ctx.Value(contextKeyRequestID{}).(string); ok {
			return id
		}
	}
	return ""
}

// countingResponseWriter captures status + bytes written; unwrappable for
// http.ResponseController, flushing transparently.
type countingResponseWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	bytes       int64
}

func (w *countingResponseWriter) WriteHeader(code int) {
	if !w.wroteHeader {
		w.status = code
		w.wroteHeader = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *countingResponseWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	return n, err
}

func (w *countingResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		if !w.wroteHeader {
			w.WriteHeader(http.StatusOK)
		}
		flusher.Flush()
	}
}

func (w *countingResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// countingReadCloser counts request body bytes as they are consumed.
type countingReadCloser struct {
	rc io.ReadCloser
	n  int64
}

func (c *countingReadCloser) Read(p []byte) (int, error) {
	n, err := c.rc.Read(p)
	c.n += int64(n)
	return n, err
}

func (c *countingReadCloser) Close() error { return c.rc.Close() }
