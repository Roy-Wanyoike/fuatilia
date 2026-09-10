package observability

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Prometheus metrics (issue #88): a PRIVATE registry — the default global
// registry is never touched, so process/Go collectors and other packages'
// instruments cannot leak into the fuatilia_ exposition, and disabled mode
// is a genuinely empty (but valid) scrape.
//
// Relay-facing series are fed through two seams the next wave wires to
// internal/outbox (issue #74's relay logs the same numbers per cycle):
//
//   - BacklogSource — the read-only probe port (outbox lag: pending rows +
//     oldest-pending age; DLQ depth) pulled once per relay cycle via
//     RefreshBacklog; tests drive it with fakes.
//   - explicit counter adds — published / failed / DLQ-in, recorded from
//     the relay's cycle stats.
//
// HTTP series are observed per request by Middleware. PG pool gauges are
// registered only when SetPoolSource wires a read-only stats source.

// metricsNamespace prefixes every series (fuatilia_outbox_lag_rows, …).
const metricsNamespace = "fuatilia"

// unresolvedRoute is the route label when no resolver answered — a URL path
// must NEVER become a label (unbounded cardinality).
const unresolvedRoute = "unresolved"

// HTTPDurationBuckets pins the API latency ladder: 5ms through 10s
// (PRODUCT_ROADMAP P1 per-phase SLOs). Middleware observes every request
// against exactly this ladder.
var HTTPDurationBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

// OutboxLag is one probe of the relay backlog.
type OutboxLag struct {
	// PendingRows is the count of outbox_events rows still pending.
	PendingRows int64
	// OldestPending is the age of the oldest pending row (0 when none).
	OldestPending time.Duration
}

// BacklogSource is the read-only probe seam the relay implements (SQL over
// outbox_events) and tests fake. Implementations must be safe for
// concurrent use; RefreshBacklog calls each method once per relay cycle.
type BacklogSource interface {
	// OutboxLag probes the pending-row backlog (count + oldest-pending age).
	OutboxLag(ctx context.Context) (OutboxLag, error)
	// DLQDepth counts poisoned rows (the dead-letter queue).
	DLQDepth(ctx context.Context) (int64, error)
}

// PoolStats is the read-only pgxpool snapshot (pool.Stat() fields subset —
// the metrics package stays pgx-free).
type PoolStats struct {
	Acquired int32
	Idle     int32
	Total    int32
	Max      int32
}

// MetricsOptions configures the metrics registry.
type MetricsOptions struct {
	// Disabled short-circuits every recorder into a no-op and serves a
	// valid EMPTY exposition — the zero-config boot needs no scraper.
	Disabled bool
}

// Metrics owns the fuatilia_ Prometheus series. All recorder methods are
// nil-receiver and disabled-mode safe (no-ops), so callers never guard.
type Metrics struct {
	enabled bool
	reg     *prometheus.Registry

	outboxLagRows     prometheus.Gauge
	outboxLagOldest   prometheus.Gauge
	dlqDepth          prometheus.Gauge
	dlqIn             prometheus.Counter
	outboxPublished   prometheus.Counter
	outboxFailed      prometheus.Counter
	httpRequests      *prometheus.CounterVec
	httpDuration      *prometheus.HistogramVec
	httpRequestBytes  *prometheus.CounterVec
	httpResponseBytes *prometheus.CounterVec
	httpPanics        *prometheus.CounterVec
	poolSource        func() PoolStats
	poolSourceWired   bool
}

// NewMetrics builds the registry and registers every series. Disabled mode
// registers nothing — Handler() still serves a valid empty exposition.
func NewMetrics(opts MetricsOptions) *Metrics {
	reg := prometheus.NewRegistry()
	if opts.Disabled {
		return &Metrics{enabled: false, reg: reg}
	}
	m := &Metrics{enabled: true, reg: reg}

	m.outboxLagRows = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_lag_rows",
		Help:      "Pending outbox_events rows awaiting publication to JetStream.",
	})
	m.outboxLagOldest = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_lag_oldest_seconds",
		Help:      "Age in seconds of the oldest pending outbox_events row.",
	})
	m.dlqDepth = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_dlq_depth",
		Help:      "Rows poisoned into the dead-letter queue (requeueable via the replay CLI).",
	})
	m.dlqIn = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_dlq_in_total",
		Help:      "Cumulative rows moved into the dead-letter queue.",
	})
	m.outboxPublished = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_published_total",
		Help:      "Outbox envelopes published to JetStream (at-least-once).",
	})
	m.outboxFailed = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "outbox_failed_total",
		Help:      "Failed publish attempts recorded on outbox rows (retried up to the attempt budget).",
	})

	httpLabels := []string{"method", "route", "status"}
	m.httpRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "http_requests_total",
		Help:      "HTTP requests served, by method, route and status.",
	}, httpLabels)
	m.httpDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: metricsNamespace,
		Name:      "http_request_duration_seconds",
		Help:      "End-to-end request duration (5ms–10s SLO ladder).",
		Buckets:   HTTPDurationBuckets,
	}, httpLabels)
	m.httpRequestBytes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "http_request_bytes_total",
		Help:      "Cumulative request body bytes received.",
	}, httpLabels)
	m.httpResponseBytes = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "http_response_bytes_total",
		Help:      "Cumulative response body bytes written.",
	}, httpLabels)
	m.httpPanics = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: metricsNamespace,
		Name:      "http_panics_total",
		Help:      "Panics captured (and re-raised) by the middleware, by method and route.",
	}, []string{"method", "route"})

	m.reg.MustRegister(
		m.outboxLagRows, m.outboxLagOldest, m.dlqDepth, m.dlqIn,
		m.outboxPublished, m.outboxFailed,
		m.httpRequests, m.httpDuration, m.httpRequestBytes, m.httpResponseBytes, m.httpPanics,
	)
	return m
}

// Enabled reports whether series are live (disabled mode records nothing).
func (m *Metrics) Enabled() bool { return m != nil && m.enabled }

// ObserveOutboxLag pins the latest backlog probe (push model: the relay
// probes once per cycle, the scrape never touches the database).
func (m *Metrics) ObserveOutboxLag(lag OutboxLag) {
	if !m.Enabled() {
		return
	}
	m.outboxLagRows.Set(float64(lag.PendingRows))
	m.outboxLagOldest.Set(lag.OldestPending.Seconds())
}

// ObserveDLQDepth pins the latest dead-letter depth.
func (m *Metrics) ObserveDLQDepth(depth int64) {
	if !m.Enabled() {
		return
	}
	m.dlqDepth.Set(float64(depth))
}

// AddOutboxPublished accounts n envelopes published (one relay cycle).
func (m *Metrics) AddOutboxPublished(n int64) {
	if !m.Enabled() || n == 0 {
		return
	}
	m.outboxPublished.Add(float64(n))
}

// AddOutboxFailed accounts n failed publish attempts (one relay cycle).
func (m *Metrics) AddOutboxFailed(n int64) {
	if !m.Enabled() || n == 0 {
		return
	}
	m.outboxFailed.Add(float64(n))
}

// AddOutboxDLQIn accounts n rows newly poisoned into the dead-letter queue.
func (m *Metrics) AddOutboxDLQIn(n int64) {
	if !m.Enabled() || n == 0 {
		return
	}
	m.dlqIn.Add(float64(n))
}

// RefreshBacklog pulls one probe from src and updates the lag/DLQ gauges.
// Gauges are left untouched when either probe fails (the caller logs the
// error — a failed probe must not present stale data as fresh).
func (m *Metrics) RefreshBacklog(ctx context.Context, src BacklogSource) error {
	if !m.Enabled() || src == nil {
		return nil
	}
	lag, err := src.OutboxLag(ctx)
	if err != nil {
		return fmt.Errorf("observability: outbox lag probe: %w", err)
	}
	depth, err := src.DLQDepth(ctx)
	if err != nil {
		return fmt.Errorf("observability: DLQ depth probe: %w", err)
	}
	m.ObserveOutboxLag(lag)
	m.ObserveDLQDepth(depth)
	return nil
}

// ObserveHTTP records one served request. route must be low-cardinality
// (the middleware's resolver contract); "" falls back to "unresolved".
func (m *Metrics) ObserveHTTP(method, route string, status int, d time.Duration, requestBytes, responseBytes int64) {
	if !m.Enabled() {
		return
	}
	if route == "" {
		route = unresolvedRoute
	}
	labels := prometheus.Labels{
		"method": method,
		"route":  route,
		"status": strconv.Itoa(status),
	}
	m.httpRequests.With(labels).Inc()
	m.httpDuration.With(labels).Observe(d.Seconds())
	m.httpRequestBytes.With(labels).Add(float64(requestBytes))
	m.httpResponseBytes.With(labels).Add(float64(responseBytes))
}

// CountHTTPPanic accounts one captured (and re-raised) panic.
func (m *Metrics) CountHTTPPanic(method, route string) {
	if !m.Enabled() {
		return
	}
	if route == "" {
		route = unresolvedRoute
	}
	m.httpPanics.WithLabelValues(method, route).Inc()
}

// SetPoolSource wires the optional read-only pool stats source (pool.Stat()
// in production). The gauges then read live values on every scrape. Returns
// false (and registers nothing) when already wired, when disabled or when
// the source is nil.
func (m *Metrics) SetPoolSource(source func() PoolStats) bool {
	if !m.Enabled() || source == nil || m.poolSourceWired {
		return false
	}
	m.poolSourceWired = true
	m.poolSource = source
	m.reg.MustRegister(
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: metricsNamespace,
			Name:      "pg_pool_acquired",
			Help:      "PostgreSQL pool connections currently acquired.",
		}, func() float64 { return float64(m.poolSource().Acquired) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: metricsNamespace,
			Name:      "pg_pool_idle",
			Help:      "PostgreSQL pool connections currently idle.",
		}, func() float64 { return float64(m.poolSource().Idle) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: metricsNamespace,
			Name:      "pg_pool_total",
			Help:      "PostgreSQL pool connections currently established.",
		}, func() float64 { return float64(m.poolSource().Total) }),
		prometheus.NewGaugeFunc(prometheus.GaugeOpts{
			Namespace: metricsNamespace,
			Name:      "pg_pool_max",
			Help:      "PostgreSQL pool maximum connection budget.",
		}, func() float64 { return float64(m.poolSource().Max) }),
	)
	return true
}

// Handler is the /metrics exposition handler (promhttp over the private
// registry). In disabled mode the registry is empty and the handler serves
// a valid EMPTY exposition — zero-config boots still scrape clean.
func (m *Metrics) Handler() http.Handler {
	reg := prometheus.NewRegistry()
	if m != nil && m.enabled {
		reg = m.reg
	}
	return promhttp.HandlerFor(reg, promhttp.HandlerOpts{
		ErrorHandling: promhttp.HTTPErrorOnError,
	})
}
