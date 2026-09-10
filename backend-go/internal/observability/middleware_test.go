package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// W3C fixtures (the same remote context tracing_test.go pins).
const (
	remoteTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	remoteTraceID     = "4bf92f3577b34da6a3ce929d0e0e4736"
	remoteSpanID      = "00f067aa0ba902b7"
)

// parseLogLines decodes every JSON record the buffer collected — the
// per-request logger emits exactly what a shipper would consume.
func parseLogLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	var out []map[string]any
	for dec.More() {
		var line map[string]any
		if err := dec.Decode(&line); err != nil {
			t.Fatalf("log line is not valid JSON: %v\n%s", err, buf.String())
		}
		out = append(out, line)
	}
	if len(out) == 0 {
		t.Fatalf("expected JSON log lines, got none:\n%s", buf.String())
	}
	return out
}

// flushSpans forces the batcher through the injected fake exporter.
func flushSpans(t *testing.T, tracing *Tracing) {
	t.Helper()
	provider, ok := tracing.TracerProvider.(*sdktrace.TracerProvider)
	if !ok {
		t.Fatalf("enabled provider is %T, want *sdktrace.TracerProvider", tracing.TracerProvider)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := provider.ForceFlush(ctx); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}
}

func spanAttrValue(span sdktrace.ReadOnlySpan, key attribute.Key) (attribute.Value, bool) {
	for _, kv := range span.Attributes() {
		if kv.Key == key {
			return kv.Value, true
		}
	}
	return attribute.Value{}, false
}

func TestMiddlewareExtractsInjectsAndLogsTraceContext(t *testing.T) {
	tracing, fake, _ := newFakeTracing(t, staticEnv(map[string]string{EnvOTLPEndpoint: "http://collector:4318"}))
	var buf bytes.Buffer
	log := NewRedactedLogger(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))

	var downstreamRequestID string
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamRequestID = RequestIDFrom(r.Context())
		RequestLoggerFrom(r.Context()).Info("handled", slog.String("phase", "next"))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	handler := Middleware(MiddlewareOptions{
		Log:     log,
		Tracing: tracing,
		Route:   func(*http.Request) string { return "/v1/payments" },
	})(next)

	req := httptest.NewRequest(http.MethodPost, "/v1/payments", nil)
	req.Header.Set("traceparent", remoteTraceparent)
	req.Header.Set("baggage", "tenant=africa")
	req.Header.Set(headerRequestID, "abc_DEF-123")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if downstreamRequestID != "abc_DEF-123" {
		t.Errorf("downstream requestId = %q, want the accepted incoming id", downstreamRequestID)
	}

	// Outbound response: W3C trace context injected (same trace id), baggage
	// round-tripped, request id echoed.
	parent := rec.Header().Get("traceparent")
	parts := strings.Split(parent, "-")
	if len(parts) != 4 || parts[0] != "00" {
		t.Fatalf("injected traceparent = %q", parent)
	}
	if parts[1] != remoteTraceID {
		t.Errorf("injected trace id = %s, want the remote id", parts[1])
	}
	if got := rec.Header().Get("baggage"); got != "tenant=africa" {
		t.Errorf("baggage = %q, want round-tripped", got)
	}
	if got := rec.Header().Get(headerRequestID); got != "abc_DEF-123" {
		t.Errorf("response X-Request-Id = %q, want the accepted id", got)
	}

	flushSpans(t, tracing)
	spans := fake.recorded()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	span := spans[0]
	if span.Name() != "POST /v1/payments" {
		t.Errorf("span name = %q", span.Name())
	}
	if span.SpanKind() != trace.SpanKindServer {
		t.Errorf("span kind = %v, want server", span.SpanKind())
	}
	if got := span.Parent().SpanID().String(); got != remoteSpanID {
		t.Errorf("span parent = %s, want the remote span id", got)
	}
	if v, ok := spanAttrValue(span, spanAttrHTTPMethod); !ok || v.AsString() != http.MethodPost {
		t.Errorf("span http.method = %v (present %v)", v, ok)
	}
	if v, ok := spanAttrValue(span, spanAttrHTTPRoute); !ok || v.AsString() != "/v1/payments" {
		t.Errorf("span http.route = %v (present %v)", v, ok)
	}

	lines := parseLogLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1", len(lines))
	}
	if lines[0][AttrRequestID] != "abc_DEF-123" {
		t.Errorf("log requestId = %v, want abc_DEF-123", lines[0][AttrRequestID])
	}
	if lines[0][AttrTraceID] != remoteTraceID {
		t.Errorf("log traceId = %v, want the remote trace id", lines[0][AttrTraceID])
	}
}

func TestMiddlewareObservesHTTPMetrics(t *testing.T) {
	metrics := NewMetrics(MetricsOptions{})
	disabled, err := NewTracing(context.Background(), TracingOptions{Env: staticEnv(nil)})
	if err != nil {
		t.Fatalf("NewTracing: %v", err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body) // drain: the request counter sees actual reads
		time.Sleep(6 * time.Millisecond)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("hello"))
	})
	handler := Middleware(MiddlewareOptions{
		Metrics: metrics,
		Tracing: disabled,
		Route:   func(*http.Request) string { return "/v1/payments" },
	})(next)

	req := httptest.NewRequest(http.MethodPost, "/v1/payments", strings.NewReader("hello world"))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d", rec.Code)
	}

	families := scrapeMetrics(t, metrics)
	requests := labeledSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "201"})
	if got := requests.GetCounter().GetValue(); got != 1 {
		t.Errorf("fuatilia_http_requests_total = %v, want 1", got)
	}

	_, buckets, count, sum := histogramBucketCounts(t, families, "fuatilia_http_request_duration_seconds",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "201"})
	if count != 1 {
		t.Errorf("histogram count = %d, want 1", count)
	}
	if buckets[0.005] != 0 {
		t.Errorf("bucket le=5ms = %d, want 0 (the handler slept ≥6ms)", buckets[0.005])
	}
	if buckets[10] != 1 {
		t.Errorf("bucket le=10s = %d, want 1", buckets[10])
	}
	if sum < 0.006 {
		t.Errorf("histogram sum = %v, want ≥ 6ms", sum)
	}

	if got := labeledSample(t, families, "fuatilia_http_request_bytes_total",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "201"}).GetCounter().GetValue(); got != 11 {
		t.Errorf("fuatilia_http_request_bytes_total = %v, want 11 (drained body)", got)
	}
	if got := labeledSample(t, families, "fuatilia_http_response_bytes_total",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "201"}).GetCounter().GetValue(); got != 5 {
		t.Errorf("fuatilia_http_response_bytes_total = %v, want 5", got)
	}
}

func TestMiddlewarePanicCapturedAndReraised(t *testing.T) {
	tracing, fake, _ := newFakeTracing(t, staticEnv(map[string]string{EnvOTLPEndpoint: "http://collector:4318"}))
	metrics := NewMetrics(MetricsOptions{})
	var buf bytes.Buffer
	log := NewRedactedLogger(slog.NewJSONHandler(&buf, nil))

	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	})
	handler := Middleware(MiddlewareOptions{
		Log:     log,
		Metrics: metrics,
		Tracing: tracing,
		Route:   func(*http.Request) string { return "/v1/payments" },
	})(next)

	req := httptest.NewRequest(http.MethodPost, "/v1/payments", nil)
	req.Header.Set("traceparent", remoteTraceparent)
	rec := httptest.NewRecorder()

	recovered := func() (r any) {
		defer func() { r = recover() }()
		handler.ServeHTTP(rec, req)
		return nil
	}()
	if recovered != "boom" {
		t.Fatalf("panic not re-raised: got %v, want boom", recovered)
	}

	families := scrapeMetrics(t, metrics)
	if got := labeledSample(t, families, "fuatilia_http_panics_total",
		map[string]string{"method": "POST", "route": "/v1/payments"}).GetCounter().GetValue(); got != 1 {
		t.Errorf("fuatilia_http_panics_total = %v, want 1", got)
	}
	if got := labeledSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "500"}).GetCounter().GetValue(); got != 1 {
		t.Errorf("requests_total[500] = %v, want 1", got)
	}
	_, _, count, _ := histogramBucketCounts(t, families, "fuatilia_http_request_duration_seconds",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "500"})
	if count != 1 {
		t.Errorf("panicked-request histogram count = %d, want 1", count)
	}

	flushSpans(t, tracing)
	spans := fake.recorded()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	span := spans[0]
	if span.Status().Code != codes.Error {
		t.Errorf("span status = %v, want Error", span.Status().Code)
	}
	if !strings.Contains(span.Status().Description, "boom") {
		t.Errorf("span status description = %q, want the panic", span.Status().Description)
	}
	found := false
	for _, ev := range span.Events() {
		if ev.Name != "exception" {
			continue
		}
		for _, kv := range ev.Attributes {
			if kv.Key == attribute.Key("exception.message") && strings.Contains(kv.Value.AsString(), "boom") {
				found = true
			}
		}
	}
	if !found {
		t.Errorf("span events lack an exception carrying the panic: %+v", span.Events())
	}

	lines := parseLogLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1 (http.panic)", len(lines))
	}
	if lines[0]["msg"] != "http.panic" {
		t.Errorf("log msg = %v, want http.panic", lines[0]["msg"])
	}
	if lines[0]["panic"] != "boom" {
		t.Errorf("log panic = %v, want boom", lines[0]["panic"])
	}
	if lines[0][AttrTraceID] != remoteTraceID {
		t.Errorf("panic-log traceId = %v, want the remote trace id", lines[0][AttrTraceID])
	}
	if id, _ := lines[0][AttrRequestID].(string); id == "" {
		t.Errorf("panic-log requestId = %v, want a generated id", lines[0][AttrRequestID])
	}
}

func TestMiddlewareRequestIDContract(t *testing.T) {
	cases := []struct {
		name        string
		requestID   string
		correlation string
		generator   func() string
		want        string
		wantUUID    bool
	}{
		{name: "valid incoming accepted", requestID: "abc_DEF-123", want: "abc_DEF-123"},
		{name: "correlation fallback accepted", correlation: "corr-42", want: "corr-42"},
		{
			name:      "ill-formed incoming regenerated via the injected generator",
			requestID: "bad id\nwith injection",
			generator: func() string { return "gen-1" },
			want:      "gen-1",
		},
		{
			name:      "missing id generated via the injected generator",
			generator: func() string { return "gen-2" },
			want:      "gen-2",
		},
		{
			name:      "broken generator falls back to the kernel uuid",
			requestID: "!!!",
			generator: func() string { return "" },
			wantUUID:  true,
		},
		{name: "missing everything defaults to the kernel uuid", wantUUID: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var downstream, rewritten string
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				downstream = RequestIDFrom(r.Context())
				rewritten = r.Header.Get(headerRequestID)
			})
			handler := Middleware(MiddlewareOptions{NewRequestID: tc.generator})(next)

			req := httptest.NewRequest(http.MethodGet, "/x", nil)
			if tc.requestID != "" {
				req.Header.Set(headerRequestID, tc.requestID)
			}
			if tc.correlation != "" {
				req.Header.Set(headerCorrelationID, tc.correlation)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if downstream == "" {
				t.Fatal("downstream saw an empty requestId")
			}
			if !validRequestID(downstream) {
				t.Errorf("resolved requestId %q is not kernel-valid", downstream)
			}
			if got := rec.Header().Get(headerRequestID); got != downstream {
				t.Errorf("response X-Request-Id = %q, want the resolved %q", got, downstream)
			}
			if rewritten != downstream {
				t.Errorf("rewritten request header = %q, want the resolved %q (the kernel must accept the SAME id)", rewritten, downstream)
			}
			if tc.wantUUID {
				if !infra.IsUUID(downstream) {
					t.Errorf("generated id = %q, want the kernel uuid shape", downstream)
				}
			} else if downstream != tc.want {
				t.Errorf("resolved requestId = %q, want %q", downstream, tc.want)
			}
		})
	}
}

func TestMiddlewareDisabledModeZeroConfigBoot(t *testing.T) {
	metrics := NewMetrics(MetricsOptions{Disabled: true})
	tracing, err := NewTracing(context.Background(), TracingOptions{Env: staticEnv(nil)})
	if err != nil {
		t.Fatalf("NewTracing with no OTEL_* env: %v", err)
	}
	if tracing.Enabled() {
		t.Fatal("disabled tracing reports enabled")
	}
	var buf bytes.Buffer
	log := NewRedactedLogger(slog.NewJSONHandler(&buf, nil))

	mux := http.NewServeMux()
	mux.Handle("/metrics", metrics.Handler())
	mux.Handle("/v1/payments", Middleware(MiddlewareOptions{
		Log:     log,
		Metrics: metrics,
		Tracing: tracing,
		Route:   func(*http.Request) string { return "/v1/payments" },
	})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		RequestLoggerFrom(r.Context()).Info("handled")
		w.WriteHeader(http.StatusOK)
	})))

	// /metrics: a valid EMPTY exposition — zero-config boots scrape clean.
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("/metrics body = %q, want empty", rec.Body.String())
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	families, err := parser.TextToMetricFamilies(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("empty exposition not valid Prometheus text: %v", err)
	}
	if len(families) != 0 {
		t.Errorf("empty exposition parsed families: %v", familyNames(families))
	}

	// A normal request: the remote traceparent passes through untouched (the
	// noop tracer preserves it) and the log context still carries both ids.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/payments", nil)
	req.Header.Set("traceparent", remoteTraceparent)
	req.Header.Set(headerRequestID, "req-9")
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	parts := strings.Split(rec.Header().Get("traceparent"), "-")
	if len(parts) != 4 || parts[1] != remoteTraceID {
		t.Fatalf("disabled-mode injected traceparent = %q, want the remote trace id round-trip", rec.Header().Get("traceparent"))
	}
	lines := parseLogLines(t, &buf)
	if len(lines) != 1 {
		t.Fatalf("got %d log lines, want 1", len(lines))
	}
	if lines[0][AttrRequestID] != "req-9" {
		t.Errorf("disabled-mode log requestId = %v, want req-9", lines[0][AttrRequestID])
	}
	if lines[0][AttrTraceID] != remoteTraceID {
		t.Errorf("disabled-mode log traceId = %v, want the remote trace id", lines[0][AttrTraceID])
	}
}

func TestMiddlewareNilDependenciesStillServes(t *testing.T) {
	handler := Middleware(MiddlewareOptions{})(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if RequestIDFrom(r.Context()) == "" {
			t.Error("requestId missing from the context even with nil dependencies")
		}
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get(headerRequestID); !validRequestID(got) {
		t.Errorf("default request id = %q, not kernel-valid", got)
	}
}

func TestMiddlewareUnresolvedRouteFallback(t *testing.T) {
	for name, route := range map[string]func(*http.Request) string{
		"resolver returns empty": func(*http.Request) string { return "" },
		"nil resolver":           nil,
	} {
		t.Run(name, func(t *testing.T) {
			metrics := NewMetrics(MetricsOptions{})
			handler := Middleware(MiddlewareOptions{Metrics: metrics, Route: route})(
				http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/some/deep/path", nil))
			families := scrapeMetrics(t, metrics)
			sample := labeledSample(t, families, "fuatilia_http_requests_total", map[string]string{"method": "GET"})
			if labels := sampleLabels(sample); labels["route"] != unresolvedRoute {
				t.Errorf("route label = %q, want %q (URL paths must never become labels)", labels["route"], unresolvedRoute)
			}
		})
	}
}

func TestRequestContextAccessorsDefault(t *testing.T) {
	if RequestIDFrom(nil) != "" {
		t.Error("RequestIDFrom(nil) must be empty")
	}
	if RequestIDFrom(context.Background()) != "" {
		t.Error("RequestIDFrom(background) must be empty")
	}
	if RequestLoggerFrom(nil) != slog.Default() {
		t.Error("RequestLoggerFrom(nil) must fall back to slog.Default()")
	}
	if RequestLoggerFrom(context.Background()) != slog.Default() {
		t.Error("RequestLoggerFrom(background) must fall back to slog.Default()")
	}
}

func TestMiddlewareNilNextFailsFast(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("composition accepted a nil next handler")
		}
	}()
	_ = Middleware(MiddlewareOptions{})(nil)
}
