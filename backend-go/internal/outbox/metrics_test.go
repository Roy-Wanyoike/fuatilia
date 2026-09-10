package outbox

// Relay → observability feed tests (issue #176): the REAL relay over the
// REAL pool/broker drives a REAL enabled Metrics registry; the assertions
// read the Prometheus text exposition — exactly what a scraper consumes.
// The relay side of the seam is SQL (nothing to fake); the metrics-side
// probe double (BacklogSource fake) lives in the observability package's
// own tests.

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
)

// scrape parses the registry's exposition through the mounted handler.
func scrape(t *testing.T, m *observability.Metrics) map[string]*dto.MetricFamily {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != 200 {
		t.Fatalf("/metrics status = %d, body %q", rec.Code, rec.Body.String())
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	parsed, err := parser.TextToMetricFamilies(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("exposition is not valid Prometheus text format: %v\n%s", err, rec.Body.String())
	}
	return parsed
}

func sampleValue(t *testing.T, families map[string]*dto.MetricFamily, name string) float64 {
	t.Helper()
	family, ok := families[name]
	if !ok {
		t.Fatalf("metric family %q missing from exposition", name)
	}
	if len(family.GetMetric()) != 1 {
		t.Fatalf("metric family %q has %d samples, want 1", name, len(family.GetMetric()))
	}
	return family.GetMetric()[0].GetGauge().GetValue() + family.GetMetric()[0].GetCounter().GetValue()
}

func TestRelayImplementsBacklogSource(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "probe-org")

	oneHourAgo := time.Now().Add(-time.Hour)
	appendEvent(t, pool, org, probeEventID(1), "payment.confirmed", 1, "", oneHourAgo)
	appendEvent(t, pool, org, probeEventID(2), "payment.confirmed", 1, "", oneHourAgo)

	relay := newTestRelay(t, pool, js, nil)

	lag, err := relay.OutboxLag(context.Background())
	if err != nil {
		t.Fatalf("OutboxLag probe: %v", err)
	}
	if lag.PendingRows != 2 {
		t.Fatalf("OutboxLag.PendingRows = %d, want 2", lag.PendingRows)
	}
	if lag.OldestPending < 55*time.Minute || lag.OldestPending > 2*time.Hour {
		t.Fatalf("OutboxLag.OldestPending = %s, want ~1h", lag.OldestPending)
	}
	if depth, err := relay.DLQDepth(context.Background()); err != nil || depth != 0 {
		t.Fatalf("DLQDepth = %d, %v, want 0, nil", depth, err)
	}

	// One poisoned row moves the DLQ probe.
	appendEvent(t, pool, org, probeEventID(3), "definitely not a subject name", 1, "", oneHourAgo)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce (poison cycle): %v", err)
	}
	if depth, err := relay.DLQDepth(context.Background()); err != nil || depth != 1 {
		t.Fatalf("DLQDepth after poison = %d, %v, want 1, nil", depth, err)
	}
}

func TestRelayFeedsMetricsThroughRealCycles(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "metrics-org")

	appendEvent(t, pool, org, probeEventID(11), "payment.confirmed", 1, "", time.Now().Add(-time.Minute))
	appendEvent(t, pool, org, probeEventID(12), "payment.confirmed", 1, "", time.Now().Add(-time.Minute))
	// Grammar-poison: the (event_type, version) cannot yield a valid subject.
	appendEvent(t, pool, org, probeEventID(13), "not a subject", 1, "", time.Now().Add(-time.Minute))

	metrics := observability.NewMetrics(observability.MetricsOptions{})
	relay := newTestRelay(t, pool, js, func(cfg *Config) { cfg.Metrics = metrics })

	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	families := scrape(t, metrics)
	if got := sampleValue(t, families, "fuatilia_outbox_published_total"); got != 2 {
		t.Fatalf("fuatilia_outbox_published_total = %v, want 2", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_dlq_in_total"); got != 1 {
		t.Fatalf("fuatilia_outbox_dlq_in_total = %v, want 1 (the grammar poison)", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_dlq_depth"); got != 1 {
		t.Fatalf("fuatilia_outbox_dlq_depth = %v, want 1", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_lag_rows"); got != 0 {
		t.Fatalf("fuatilia_outbox_lag_rows = %v, want 0 — the drain left nothing pending", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_failed_total"); got != 0 {
		t.Fatalf("fuatilia_outbox_failed_total = %v, want 0 (no broker failures)", got)
	}

	// A second cycle with fresh pending rows pushes the residual-lag gauge
	// up again: the gauges are PUSHED per cycle, never scraped from the DB.
	appendEvent(t, pool, org, probeEventID(14), "payment.confirmed", 1, "", time.Now())
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("second RunOnce: %v", err)
	}
	families = scrape(t, metrics)
	if got := sampleValue(t, families, "fuatilia_outbox_lag_rows"); got != 0 {
		t.Fatalf("fuatilia_outbox_lag_rows after drain = %v, want 0", got)
	}
	if got := sampleValue(t, families, "fuatilia_outbox_published_total"); got != 3 {
		t.Fatalf("fuatilia_outbox_published_total after second cycle = %v, want 3", got)
	}
}

func TestRelayUnwiredMetricsRecordsNothing(t *testing.T) {
	pool := testPool(t)
	js, _ := testBroker(t)
	org := testOrg(t, pool, "unwired-org")
	appendEvent(t, pool, org, probeEventID(21), "payment.confirmed", 1, "", time.Now())

	// nil sink: the cycle must run clean and record nothing anywhere.
	relay := newTestRelay(t, pool, js, nil)
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce with nil metrics: %v", err)
	}

	disabled := observability.NewMetrics(observability.MetricsOptions{Disabled: true})
	relay = newTestRelay(t, pool, js, func(cfg *Config) { cfg.Metrics = disabled })
	if err := relay.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce with disabled metrics: %v", err)
	}
	rec := httptest.NewRecorder()
	disabled.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Body.Len() != 0 {
		t.Fatalf("disabled mode must serve an EMPTY exposition, got:\n%s", rec.Body.String())
	}
}

func probeEventID(n int) string {
	return "00000000-0000-4000-8000-" + pad12(n)
}

func pad12(n int) string {
	raw := "000000000000"
	digits := []byte(raw)
	s := itoaTest(n)
	copy(digits[len(digits)-len(s):], s)
	return string(digits)
}

func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
