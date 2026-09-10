// Package observability is the kernel's OpenTelemetry/Prometheus/slog
// instrumentation lane (issue #88, PRODUCTION_AUDIT §4): tracing, metrics
// and redacted structured logging as THREE injected ports, so the transport
// kernel keeps serving without a collector, a scraper or any other
// infrastructure — the zero-config boot is the default, not a degraded mode.
//
// Composition (next wave, kernel files untouched — Middleware wraps the
// kernel from the outside and Handler() mounts at /metrics):
//
//	tracing, _ := observability.NewTracing(ctx, observability.TracingOptions{})
//	metrics := observability.NewMetrics(observability.MetricsOptions{})
//	log := observability.NewLogger(os.Getenv, os.Stdout)
//	handler := observability.Middleware(observability.MiddlewareOptions{
//		Log: log, Metrics: metrics, Tracing: tracing,
//		Route: routeResolverFromKernel,
//	})(composed.Kernel)
//
// Ports and seams:
//
//   - Tracing: the TracerProvider factory reads the STANDARD OTEL_* env
//     names (OTEL_EXPORTER_OTLP_ENDPOINT / _TRACES_ENDPOINT, _HEADERS,
//     _TIMEOUT, _INSECURE, OTEL_TRACES_SAMPLER[+_ARG], OTEL_SERVICE_NAME,
//     OTEL_RESOURCE_ATTRIBUTES) and dials OTLP/HTTP through the injected
//     ExporterFactory port. With no endpoint configured the provider is the
//     no-op — boot never requires a collector. W3C tracecontext + baggage
//     propagation is always active (disabled mode passes remote context
//     through untouched).
//   - Metrics: a private prometheus.Registry (namespace fuatilia_) fed by
//     the BacklogSource probe seam (outbox lag + DLQ depth) and explicit
//     counter adds (published / failed / DLQ-in), plus the HTTP duration
//     histogram (5ms–10s buckets) and request/response size counters the
//     middleware observes per request. Disabled mode serves a valid EMPTY
//     exposition.
//   - Logging: slog JSON factory (FUATILIA_LOG_LEVEL) wrapped in a
//     redaction handler — records carrying keys that contain
//     authorization/password/token/secret/credential (case-insensitive, at
//     any group depth, including smuggled map values) never reach the wire.
//
// The middleware is net/http-native: it extracts W3C trace context from the
// incoming request, injects it into the outbound response, observes the
// duration histogram and size counters, captures panics (span + metric) and
// RE-RAISES them — kernel behavior is unchanged — and places requestId +
// traceId into a per-request slog context retrievable with
// RequestLoggerFrom/RequestIDFrom.
//
// Fakes exist only in _test.go files; every production default is the real
// implementation. No TODO/FIXME anywhere in the package.
package observability
