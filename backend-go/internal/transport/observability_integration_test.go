package transport_test

// Serving-chain integration (issue #176): the REAL Compose chain over REAL
// PostgreSQL, asserting the acceptance criteria end-to-end — the live
// /metrics exposition (duration histogram grows, relay lag/DLQ gauges
// reflect a pushed probe), the W3C trace context round-trip (inbound
// traceparent → SERVER span → response traceparent) and the access log's
// requestId + traceId correlation.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// syncBuffer is a concurrency-safe log sink: the access line is written by
// the server goroutine after the response may already have reached the test.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// spanExporter is the injected exporter port's in-memory double: spans land
// here instead of a collector.
type spanExporter struct {
	mu    sync.Mutex
	spans []sdktrace.ReadOnlySpan
}

func (e *spanExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.spans = append(e.spans, spans...)
	return nil
}

func (e *spanExporter) Shutdown(context.Context) error { return nil }

func (e *spanExporter) recorded() []sdktrace.ReadOnlySpan {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sdktrace.ReadOnlySpan(nil), e.spans...)
}

// fakeBacklogProbe is the relay-side probe double (fakes live only in
// _test.go): the same BacklogSource seam the worker's relay implements with
// SQL, driven here through the push model to prove the gauges reflect it.
type fakeBacklogProbe struct {
	lag   observability.OutboxLag
	depth int64
}

func (f fakeBacklogProbe) OutboxLag(context.Context) (observability.OutboxLag, error) {
	return f.lag, nil
}

func (f fakeBacklogProbe) DLQDepth(context.Context) (int64, error) {
	return f.depth, nil
}

// bootWiredKernel composes the REAL kernel over the shared lane cluster's
// migrated database and serves the FULL wired chain (issue #176): /metrics
// mount + observability middleware with an in-memory span exporter.
func bootWiredKernel(t *testing.T) (*httptest.Server, *observability.Metrics, *observability.Tracing, *spanExporter, *syncBuffer) {
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

	clock := infra.SystemClock{}
	services := &application.Services{
		Stores:  &repositories.Stores{Pool: pool},
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

	metrics := observability.NewMetrics(observability.MetricsOptions{})
	exporter := &spanExporter{}
	// ENABLED tracing over the injected fake exporter: an OTEL endpoint is
	// configured, so the provider is real and spans must land in memory.
	tracing, err := observability.NewTracing(ctx, observability.TracingOptions{
		Env: func(key string) string {
			if key == observability.EnvOTLPEndpoint {
				return "http://127.0.0.1:4318"
			}
			return ""
		},
		Exporter: func(context.Context, observability.OTLPConfig) (sdktrace.SpanExporter, error) {
			return exporter, nil
		},
	})
	if err != nil {
		t.Fatalf("NewTracing: %v", err)
	}
	if !tracing.Enabled() {
		t.Fatal("tracing must be enabled with an OTEL endpoint configured")
	}

	buf := &syncBuffer{}
	composed, err := transport.Compose(transport.Deps{
		Services: services,
		Auth:     authenticator,
		Clock:    clock,
		Observability: transport.ObservabilityWiring{
			Metrics: metrics,
			Tracing: tracing,
		},
	}, observability.NewRedactedLogger(slog.NewJSONHandler(buf, nil)), func(err error, requestID string) {
		t.Logf("kernel internal error (requestId=%s): %v", requestID, err)
	})
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	server := httptest.NewServer(composed.Handler)
	t.Cleanup(server.Close)
	return server, metrics, tracing, exporter, buf
}

func flushTracing(t *testing.T, tracing *observability.Tracing) {
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

// scrapeExposition drives the live /metrics mount and parses the Prometheus
// text format — the AC asserts values through what a scraper consumes.
func scrapeExposition(t *testing.T, baseURL string) map[string]*dto.MetricFamily {
	t.Helper()
	resp, err := http.Get(baseURL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics status = %d, body %s", resp.StatusCode, body)
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	parsed, err := parser.TextToMetricFamilies(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("exposition is not valid Prometheus text format: %v\n%s", err, body)
	}
	return parsed
}

// counterSample returns the fuatilia_http_requests_total value for one
// (method, route, status) label triple.
func counterSample(t *testing.T, families map[string]*dto.MetricFamily, name string, want map[string]string) float64 {
	t.Helper()
	family, ok := families[name]
	if !ok {
		t.Fatalf("metric family %q missing from exposition", name)
	}
	for _, sample := range family.GetMetric() {
		labels := map[string]string{}
		for _, lp := range sample.GetLabel() {
			labels[lp.GetName()] = lp.GetValue()
		}
		if len(labels) != len(want) {
			continue
		}
		match := true
		for key, value := range want {
			if labels[key] != value {
				match = false
				break
			}
		}
		if match {
			return sample.GetCounter().GetValue()
		}
	}
	t.Fatalf("no %s sample with labels %v in exposition", name, want)
	return 0
}

func findLogLine(t *testing.T, buf *syncBuffer, msg, path string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(buf.String()))
	for dec.More() {
		var line map[string]any
		if err := dec.Decode(&line); err != nil {
			t.Fatalf("log line is not valid JSON: %v\n%s", err, buf.String())
		}
		if line["msg"] == msg && line["path"] == path {
			return line
		}
	}
	t.Fatalf("no %q record for path %q in the log:\n%s", msg, path, buf.String())
	return nil
}

func TestServingChainMetricsAndTraceRoundTripIntegration(t *testing.T) {
	server, metrics, tracing, exporter, buf := bootWiredKernel(t)

	const (
		inboundTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
		inboundTraceID     = "4bf92f3577b34da6a3ce929d0e0e4736"
	)

	// 1) Public route, inbound traceparent: response echoes the trace id and
	// carries the resolved request id.
	healthReq, err := http.NewRequest(http.MethodGet, server.URL+"/v1/health", nil)
	if err != nil {
		t.Fatalf("new health request: %v", err)
	}
	healthReq.Header.Set("traceparent", inboundTraceparent)
	healthResp, err := http.DefaultClient.Do(healthReq)
	if err != nil {
		t.Fatalf("GET /v1/health: %v", err)
	}
	healthBody, _ := io.ReadAll(healthResp.Body)
	_ = healthResp.Body.Close()
	if healthResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/health status = %d, body %s", healthResp.StatusCode, healthBody)
	}
	requestID := healthResp.Header.Get("X-Request-Id")
	if requestID == "" {
		t.Fatal("response carries no X-Request-Id")
	}
	if got := healthResp.Header.Get("traceparent"); !strings.Contains(got, inboundTraceID) {
		t.Fatalf("response traceparent = %q, want trace id %q echoed", got, inboundTraceID)
	}

	// 2) Param route without credentials: two 401s on two DIFFERENT ids must
	// land on ONE series — the low-cardinality pattern label.
	for i := 0; i < 2; i++ {
		unauthReq, err := http.NewRequest(http.MethodGet,
			fmt.Sprintf("%s/v1/receivables/9f8c2f30-0000-4000-8000-%012d", server.URL, i), nil)
		if err != nil {
			t.Fatalf("new receivable request: %v", err)
		}
		unauthResp, err := http.DefaultClient.Do(unauthReq)
		if err != nil {
			t.Fatalf("GET /v1/receivables/…: %v", err)
		}
		_, _ = io.Copy(io.Discard, unauthResp.Body)
		_ = unauthResp.Body.Close()
		if unauthResp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unauthenticated GET /v1/receivables/… status = %d, want 401", unauthResp.StatusCode)
		}
	}

	// 3) Unknown route: 404 on the shared unresolved series.
	missingResp, err := http.Get(server.URL + "/v1/definitely-not-a-route")
	if err != nil {
		t.Fatalf("GET unknown route: %v", err)
	}
	_, _ = io.Copy(io.Discard, missingResp.Body)
	_ = missingResp.Body.Close()
	if missingResp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET unknown route status = %d, want 404", missingResp.StatusCode)
	}

	// 4) Live exposition: the duration histogram grew with route labels.
	families := scrapeExposition(t, server.URL)
	if got := counterSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "GET", "route": "/v1/health", "status": "200"}); got != 1 {
		t.Fatalf("http_requests_total{route=/v1/health,status=200} = %v, want 1", got)
	}
	if got := counterSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "GET", "route": "/v1/receivables/:receivableId", "status": "401"}); got != 2 {
		t.Fatalf("http_requests_total{route=/v1/receivables/:receivableId,status=401} = %v, want 2 (param collapse)", got)
	}
	if got := counterSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "GET", "route": "unresolved", "status": "404"}); got != 1 {
		t.Fatalf("http_requests_total{route=unresolved,status=404} = %v, want 1", got)
	}
	duration, ok := families["fuatilia_http_request_duration_seconds"]
	if !ok || len(duration.GetMetric()) == 0 {
		t.Fatalf("fuatilia_http_request_duration_seconds missing or empty in exposition")
	}
	foundHealthHistogram := false
	for _, sample := range duration.GetMetric() {
		for _, lp := range sample.GetLabel() {
			if lp.GetName() == "route" && lp.GetValue() == "/v1/health" && sample.GetHistogram().GetSampleCount() == 1 {
				foundHealthHistogram = true
			}
		}
	}
	if !foundHealthHistogram {
		t.Fatal("duration histogram has no /v1/health sample with count 1")
	}

	// 5) Scrapes never enter the pipeline: more scrapes move nothing.
	families = scrapeExposition(t, server.URL)
	if got := counterSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "GET", "route": "unresolved", "status": "404"}); got != 1 {
		t.Fatalf("the /metrics scrape entered the pipeline: unresolved grew to %v", got)
	}

	// 6) Relay-side probe seam: a pushed fake BacklogSource (the push model
	// the worker's relay drives once per cycle) must show on the next scrape.
	if err := metrics.RefreshBacklog(context.Background(), fakeBacklogProbe{
		lag:   observability.OutboxLag{PendingRows: 42, OldestPending: 90 * time.Second},
		depth: 3,
	}); err != nil {
		t.Fatalf("RefreshBacklog: %v", err)
	}
	families = scrapeExposition(t, server.URL)
	for name, want := range map[string]float64{
		"fuatilia_outbox_lag_rows":           42,
		"fuatilia_outbox_lag_oldest_seconds": 90,
		"fuatilia_outbox_dlq_depth":          3,
	} {
		family, ok := families[name]
		if !ok || len(family.GetMetric()) != 1 {
			t.Fatalf("gauge %q missing from exposition", name)
		}
		if got := family.GetMetric()[0].GetGauge().GetValue(); got != want {
			t.Fatalf("%s = %v, want %v", name, got, want)
		}
	}

	// 7) Spans: the health request produced a SERVER span on the inbound
	// trace, with the low-cardinality route and the 200.
	flushTracing(t, tracing)
	var healthSpan sdktrace.ReadOnlySpan
	for _, span := range exporter.recorded() {
		if span.Name() == "GET /v1/health" {
			healthSpan = span
			break
		}
	}
	if healthSpan == nil {
		t.Fatalf("no SERVER span for GET /v1/health recorded (%d spans)", len(exporter.recorded()))
	}
	if healthSpan.SpanKind() != trace.SpanKindServer {
		t.Fatalf("span kind = %v, want SERVER", healthSpan.SpanKind())
	}
	if got := healthSpan.SpanContext().TraceID().String(); got != inboundTraceID {
		t.Fatalf("span trace id = %s, want the inbound %s", got, inboundTraceID)
	}
	attrs := map[string]string{}
	for _, kv := range healthSpan.Attributes() {
		attrs[string(kv.Key)] = kv.Value.Emit()
	}
	if attrs["http.route"] != "/v1/health" || attrs["http.status_code"] != "200" {
		t.Fatalf("span attributes = %v, want http.route=/v1/health and http.status_code=200", attrs)
	}

	// 8) Access log correlation: requestId + traceId ride the record.
	access := findLogLine(t, buf, "http.request", "/v1/health")
	if access["requestId"] != requestID {
		t.Fatalf("access line requestId = %v, want the response's %q", access["requestId"], requestID)
	}
	if access["traceId"] != inboundTraceID {
		t.Fatalf("access line traceId = %v, want the inbound %s", access["traceId"], inboundTraceID)
	}
}
