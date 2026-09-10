package observability

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

// fakeBacklogSource is the test double for the relay's read-only probe seam.
type fakeBacklogSource struct {
	lag      OutboxLag
	depth    int64
	lagErr   error
	depthErr error
}

func (f *fakeBacklogSource) OutboxLag(context.Context) (OutboxLag, error) {
	return f.lag, f.lagErr
}

func (f *fakeBacklogSource) DLQDepth(context.Context) (int64, error) {
	return f.depth, f.depthErr
}

// scrapeMetrics drives the exposition handler and parses the Prometheus
// text format — the AC asserts values through the text exposition, exactly
// what a scraper consumes.
func scrapeMetrics(t *testing.T, m *Metrics) map[string]*dto.MetricFamily {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, body %q", rec.Code, rec.Body.String())
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	parsed, err := parser.TextToMetricFamilies(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("exposition is not valid Prometheus text format: %v\n%s", err, rec.Body.String())
	}
	return parsed
}

func firstSample(t *testing.T, families map[string]*dto.MetricFamily, name string) *dto.Metric {
	t.Helper()
	family, ok := families[name]
	if !ok {
		t.Fatalf("metric family %q missing from exposition: %v", name, familyNames(families))
	}
	if len(family.GetMetric()) != 1 {
		t.Fatalf("metric family %q has %d samples, want 1", name, len(family.GetMetric()))
	}
	return family.GetMetric()[0]
}

// labeledSample finds the one sample of a multi-label family whose labels
// all match want (and reports the full label set for label assertions).
func labeledSample(t *testing.T, families map[string]*dto.MetricFamily, name string, want map[string]string) *dto.Metric {
	t.Helper()
	family, ok := families[name]
	if !ok {
		t.Fatalf("metric family %q missing from exposition: %v", name, familyNames(families))
	}
	for _, sample := range family.GetMetric() {
		labels := sampleLabels(sample)
		match := true
		for key, value := range want {
			if labels[key] != value {
				match = false
				break
			}
		}
		if match {
			return sample
		}
	}
	t.Fatalf("no %q sample with labels %v in %d samples", name, want, len(family.GetMetric()))
	return nil
}

func sampleValue(t *testing.T, families map[string]*dto.MetricFamily, name string) float64 {
	t.Helper()
	sample := firstSample(t, families, name)
	switch {
	case sample.GetGauge() != nil:
		return sample.GetGauge().GetValue()
	case sample.GetCounter() != nil:
		return sample.GetCounter().GetValue()
	default:
		t.Fatalf("metric %q is neither gauge nor counter", name)
		return 0
	}
}

func sampleLabels(sample *dto.Metric) map[string]string {
	out := map[string]string{}
	for _, lp := range sample.GetLabel() {
		out[lp.GetName()] = lp.GetValue()
	}
	return out
}

func histogramBucketCounts(t *testing.T, families map[string]*dto.MetricFamily, name string, wantLabels map[string]string) (map[string]string, map[float64]uint64, uint64, float64) {
	t.Helper()
	sample := labeledSample(t, families, name, wantLabels)
	hist := sample.GetHistogram()
	if hist == nil {
		t.Fatalf("metric %q is not a histogram", name)
	}
	buckets := map[float64]uint64{}
	for _, b := range hist.GetBucket() {
		buckets[b.GetUpperBound()] = b.GetCumulativeCount()
	}
	return sampleLabels(sample), buckets, hist.GetSampleCount(), hist.GetSampleSum()
}

func familyNames(families map[string]*dto.MetricFamily) []string {
	names := make([]string, 0, len(families))
	for name := range families {
		names = append(names, name)
	}
	return names
}

func TestDisabledMetricsServesEmptyExposition(t *testing.T) {
	m := NewMetrics(MetricsOptions{Disabled: true})
	if m.Enabled() {
		t.Fatal("disabled metrics report enabled")
	}
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !bytes.Contains([]byte(ct), []byte("text/plain")) {
		t.Errorf("Content-Type = %q, want text/plain exposition", ct)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("disabled exposition not empty: %q", rec.Body.String())
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	parsed, err := parser.TextToMetricFamilies(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("empty exposition not valid Prometheus text: %v", err)
	}
	if len(parsed) != 0 {
		t.Errorf("empty exposition parsed families: %v", familyNames(parsed))
	}
	// Recorder methods must be safe no-ops in disabled mode.
	m.ObserveOutboxLag(OutboxLag{PendingRows: 1, OldestPending: time.Second})
	m.ObserveDLQDepth(1)
	m.AddOutboxPublished(1)
	m.AddOutboxFailed(1)
	m.AddOutboxDLQIn(1)
	m.ObserveHTTP("GET", "/v1/health", 200, time.Millisecond, 1, 1)
	m.CountHTTPPanic("GET", "/v1/health")
	if m.SetPoolSource(func() PoolStats { return PoolStats{} }) {
		t.Error("SetPoolSource must refuse in disabled mode")
	}
	if err := m.RefreshBacklog(context.Background(), &fakeBacklogSource{}); err != nil {
		t.Errorf("RefreshBacklog disabled-mode error: %v", err)
	}
}

func TestBacklogAndCountersThroughFakeSource(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	src := &fakeBacklogSource{
		lag:   OutboxLag{PendingRows: 7, OldestPending: 90 * time.Second},
		depth: 3,
	}
	if err := m.RefreshBacklog(context.Background(), src); err != nil {
		t.Fatalf("RefreshBacklog: %v", err)
	}
	m.AddOutboxPublished(5)
	m.AddOutboxFailed(2)
	m.AddOutboxDLQIn(3)

	families := scrapeMetrics(t, m)
	if got := sampleValue(t, families, "fuatilia_outbox_lag_rows"); got != 7 {
		t.Errorf("fuatilia_outbox_lag_rows = %v, want 7", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_lag_oldest_seconds"); got != 90 {
		t.Errorf("fuatilia_outbox_lag_oldest_seconds = %v, want 90", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_dlq_depth"); got != 3 {
		t.Errorf("fuatilia_outbox_dlq_depth = %v, want 3", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_dlq_in_total"); got != 3 {
		t.Errorf("fuatilia_outbox_dlq_in_total = %v, want 3", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_published_total"); got != 5 {
		t.Errorf("fuatilia_outbox_published_total = %v, want 5", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_failed_total"); got != 2 {
		t.Errorf("fuatilia_outbox_failed_total = %v, want 2", got)
	}
}

func TestRefreshBacklogPropagatesProbeErrors(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	src := &fakeBacklogSource{lagErr: errors.New("db down")}
	if err := m.RefreshBacklog(context.Background(), src); err == nil {
		t.Fatal("lag probe error swallowed")
	}
	src = &fakeBacklogSource{depthErr: errors.New("db down")}
	if err := m.RefreshBacklog(context.Background(), src); err == nil {
		t.Fatal("depth probe error swallowed")
	}
	families := scrapeMetrics(t, m)
	// A failed probe must not present stale data as fresh: gauges stay 0.
	if got := sampleValue(t, families, "fuatilia_outbox_lag_rows"); got != 0 {
		t.Errorf("fuatilia_outbox_lag_rows = %v after failed probe, want 0", got)
	}
}

func TestZeroAddsAreNoops(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	m.AddOutboxPublished(0)
	m.AddOutboxFailed(0)
	m.AddOutboxDLQIn(0)
	// Counters still exist (registered) but hold zero.
	families := scrapeMetrics(t, m)
	if got := sampleValue(t, families, "fuatilia_outbox_published_total"); got != 0 {
		t.Errorf("published = %v, want 0", got)
	}
}

func TestHTTPMetricsExposition(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	m.ObserveHTTP("GET", "/v1/health", 200, 6*time.Millisecond, 0, 41)
	m.ObserveHTTP("POST", "/v1/payments", 500, 700*time.Millisecond, 128, 96)
	// The 5ms boundary is INCLUSIVE (le semantics).
	m.ObserveHTTP("GET", "/v1/health", 200, 5*time.Millisecond, 0, 30)

	families := scrapeMetrics(t, m)

	_, buckets, count, sum := histogramBucketCounts(t, families, "fuatilia_http_request_duration_seconds",
		map[string]string{"method": "GET", "route": "/v1/health", "status": "200"})
	if count != 2 {
		t.Errorf("histogram count = %d, want 2", count)
	}
	if sum < 0.010 || sum > 0.012 {
		t.Errorf("histogram sum = %v, want ≈0.011", sum)
	}
	wantBuckets := map[float64]uint64{
		0.005: 1, // exactly 5ms lands on the first bound
		0.01:  2, // + the 6ms sample
		0.025: 2,
		0.05:  2,
		0.1:   2,
		0.25:  2,
		0.5:   2,
		1:     2,
		2.5:   2,
		5:     2,
		10:    2,
	}
	for bound, want := range wantBuckets {
		if got := buckets[bound]; got != want {
			t.Errorf("bucket le=%v = %d, want %d", bound, got, want)
		}
	}
	_, buckets500, count500, _ := histogramBucketCounts(t, families, "fuatilia_http_request_duration_seconds",
		map[string]string{"method": "POST", "route": "/v1/payments", "status": "500"})
	if count500 != 1 || buckets500[1] != 1 {
		t.Errorf("500-series histogram count=%d bucket(le=1)=%d, want 1/1", count500, buckets500[1])
	}

	requests := labeledSample(t, families, "fuatilia_http_requests_total",
		map[string]string{"method": "GET", "route": "/v1/health", "status": "200"})
	labels := sampleLabels(requests)
	if labels["method"] != "GET" || labels["route"] != "/v1/health" || labels["status"] != "200" {
		t.Errorf("requests labels = %v", labels)
	}
	if requests.GetCounter().GetValue() != 2 {
		t.Errorf("fuatilia_http_requests_total[GET /v1/health 200] = %v, want 2", requests.GetCounter().GetValue())
	}

	sizes := []struct {
		family string
		labels map[string]string
		want   float64
	}{
		{"fuatilia_http_request_bytes_total", map[string]string{"method": "POST", "route": "/v1/payments", "status": "500"}, 128},
		{"fuatilia_http_response_bytes_total", map[string]string{"method": "POST", "route": "/v1/payments", "status": "500"}, 96},
		{"fuatilia_http_response_bytes_total", map[string]string{"method": "GET", "route": "/v1/health", "status": "200"}, 71}, // 41 + 30
	}
	for _, tc := range sizes {
		got := labeledSample(t, families, tc.family, tc.labels).GetCounter().GetValue()
		if got != tc.want {
			t.Errorf("%s%v = %v, want %v", tc.family, tc.labels, got, tc.want)
		}
	}
}

func TestHTTPMetricsUnresolvedRouteFallback(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	m.ObserveHTTP("GET", "", 404, time.Millisecond, 0, 5)
	families := scrapeMetrics(t, m)
	sample := labeledSample(t, families, "fuatilia_http_requests_total", map[string]string{"method": "GET"})
	if labels := sampleLabels(sample); labels["route"] != "unresolved" {
		t.Errorf("route label = %q, want unresolved", labels["route"])
	}
}

func TestPanicCounterExposition(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	m.CountHTTPPanic("POST", "/v1/payments")
	m.CountHTTPPanic("POST", "/v1/payments")
	families := scrapeMetrics(t, m)
	if got := sampleValue(t, families, "fuatilia_http_panics_total"); got != 2 {
		t.Errorf("fuatilia_http_panics_total = %v, want 2", got)
	}
}

func TestPoolSourceGauges(t *testing.T) {
	m := NewMetrics(MetricsOptions{})
	stats := PoolStats{Acquired: 2, Idle: 3, Total: 5, Max: 10}
	if !m.SetPoolSource(func() PoolStats { return stats }) {
		t.Fatal("SetPoolSource refused the first wiring")
	}
	if m.SetPoolSource(func() PoolStats { return PoolStats{} }) {
		t.Fatal("SetPoolSource accepted a second source")
	}
	families := scrapeMetrics(t, m)
	for name, want := range map[string]float64{
		"fuatilia_pg_pool_acquired": 2,
		"fuatilia_pg_pool_idle":     3,
		"fuatilia_pg_pool_total":    5,
		"fuatilia_pg_pool_max":      10,
	} {
		if got := sampleValue(t, families, name); got != want {
			t.Errorf("%s = %v, want %v", name, got, want)
		}
	}
}

func TestDisabledMetricsNilReceiverSafety(t *testing.T) {
	var m *Metrics
	if m.Enabled() {
		t.Error("nil metrics report enabled")
	}
	// Every recorder must tolerate a nil receiver (middleware never guards).
	m.ObserveOutboxLag(OutboxLag{})
	m.ObserveDLQDepth(0)
	m.AddOutboxPublished(1)
	m.AddOutboxFailed(1)
	m.AddOutboxDLQIn(1)
	m.ObserveHTTP("GET", "/x", 200, time.Second, 1, 1)
	m.CountHTTPPanic("GET", "/x")
	if err := m.RefreshBacklog(context.Background(), &fakeBacklogSource{}); err != nil {
		t.Errorf("nil RefreshBacklog error: %v", err)
	}
	if m.SetPoolSource(nil) {
		t.Error("nil SetPoolSource wired")
	}
	m.Handler().ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/metrics", nil))
}
