package observability

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// fakeExporter is the injected exporter double: spans land in memory.
type fakeExporter struct {
	mu        sync.Mutex
	spans     []sdktrace.ReadOnlySpan
	shutdowns int
}

func (e *fakeExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.spans = append(e.spans, spans...)
	return nil
}

func (e *fakeExporter) Shutdown(context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.shutdowns++
	return nil
}

func (e *fakeExporter) recorded() []sdktrace.ReadOnlySpan {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]sdktrace.ReadOnlySpan(nil), e.spans...)
}

// newFakeTracing builds an ENABLED Tracing over the injected fake exporter
// and returns the handle plus the captured OTLPConfig.
func newFakeTracing(t *testing.T, env func(string) string) (*Tracing, *fakeExporter, OTLPConfig) {
	t.Helper()
	var (
		fake     *fakeExporter
		captured OTLPConfig
	)
	fake = &fakeExporter{}
	tracing, err := NewTracing(context.Background(), TracingOptions{
		Env: env,
		Exporter: func(_ context.Context, cfg OTLPConfig) (sdktrace.SpanExporter, error) {
			captured = cfg
			return fake, nil
		},
	})
	if err != nil {
		t.Fatalf("NewTracing: %v", err)
	}
	if !tracing.Enabled() {
		t.Fatal("expected enabled tracing")
	}
	return tracing, fake, captured
}

func TestDisabledByDefault(t *testing.T) {
	tracing, err := NewTracing(context.Background(), TracingOptions{Env: staticEnv(nil)})
	if err != nil {
		t.Fatalf("NewTracing with no OTEL_* env must not fail: %v", err)
	}
	if tracing.Enabled() {
		t.Fatal("tracing enabled with no endpoint configured")
	}
	if tracing.TracerProvider == nil || tracing.Propagator == nil {
		t.Fatal("disabled tracing must still carry a provider and propagator")
	}

	// Disabled mode is not context-blind: a remote traceparent passes through.
	carrier := propagation.MapCarrier{"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
	ctx := tracing.Propagator.Extract(context.Background(), carrier)
	ctx, span := tracing.Tracer("test").Start(ctx, "op")
	defer span.End()
	remote := trace.SpanContextFromContext(ctx)
	if !remote.IsValid() {
		t.Fatal("disabled mode lost the remote span context")
	}
	if remote.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("remote trace id = %s", remote.TraceID().String())
	}

	if err := tracing.Shutdown(context.Background()); err != nil {
		t.Errorf("disabled Shutdown: %v", err)
	}
}

func TestNilTracingIsDisabled(t *testing.T) {
	var tracing *Tracing
	if tracing.Enabled() {
		t.Fatal("nil tracing reports enabled")
	}
	if err := tracing.Shutdown(context.Background()); err != nil {
		t.Errorf("nil Shutdown: %v", err)
	}
	span := tracing.Tracer("test")
	if span == nil {
		t.Fatal("nil Tracer() returned nil")
	}
}

func TestEnabledFlowRecordsSpansThroughInjectedExporter(t *testing.T) {
	env := staticEnv(map[string]string{
		EnvOTLPEndpoint:       "http://collector:4318",
		EnvServiceName:        "fuatilia-api",
		EnvOTLPTimeout:        "2500",
		EnvOTLPHeaders:        "authorization=Bearer%20tok",
		EnvResourceAttributes: "deployment.environment=production",
	})
	tracing, fake, captured := newFakeTracing(t, env)

	if captured.Endpoint != "collector:4318" {
		t.Errorf("Endpoint = %q, want collector:4318", captured.Endpoint)
	}
	if captured.URLPath != defaultTracesURLPath {
		t.Errorf("URLPath = %q, want %q", captured.URLPath, defaultTracesURLPath)
	}
	if !captured.Insecure {
		t.Error("http:// scheme must derive Insecure")
	}
	if captured.Timeout != 2500*time.Millisecond {
		t.Errorf("Timeout = %v, want 2.5s", captured.Timeout)
	}
	if captured.Headers["authorization"] != "Bearer tok" {
		t.Errorf("Headers = %v, want decoded authorization", captured.Headers)
	}

	_, span := tracing.Tracer("test").Start(context.Background(), "unit.of.work", trace.WithSpanKind(trace.SpanKindServer))
	span.SetAttributes(attribute.String("work", "done"))
	span.End()

	provider, ok := tracing.TracerProvider.(*sdktrace.TracerProvider)
	if !ok {
		t.Fatalf("enabled provider is %T, want *sdktrace.TracerProvider", tracing.TracerProvider)
	}
	flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := provider.ForceFlush(flushCtx); err != nil {
		t.Fatalf("ForceFlush: %v", err)
	}

	spans := fake.recorded()
	if len(spans) != 1 {
		t.Fatalf("recorded %d spans, want 1", len(spans))
	}
	recorded := spans[0]
	if recorded.Name() != "unit.of.work" {
		t.Errorf("span name = %q", recorded.Name())
	}
	if recorded.SpanKind() != trace.SpanKindServer {
		t.Errorf("span kind = %v, want server", recorded.SpanKind())
	}
	serviceName := ""
	for _, kv := range recorded.Resource().Attributes() {
		if kv.Key == "service.name" {
			serviceName = kv.Value.AsString()
		}
		if kv.Key == "deployment.environment" && kv.Value.AsString() != "production" {
			t.Errorf("deployment.environment = %q", kv.Value.AsString())
		}
	}
	if serviceName != "fuatilia-api" {
		t.Errorf("service.name = %q, want fuatilia-api", serviceName)
	}

	if err := tracing.Shutdown(context.Background()); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if fake.shutdowns != 1 {
		t.Errorf("exporter shutdowns = %d, want 1", fake.shutdowns)
	}
}

func TestOTLPEndpointDerivation(t *testing.T) {
	cases := []struct {
		name         string
		env          map[string]string
		wantEnabled  bool
		wantEndpoint string
		wantPath     string
		wantInsecure bool
	}{
		{
			name:        "no endpoint disabled",
			env:         map[string]string{},
			wantEnabled: false,
		},
		{
			name:         "generic https endpoint appends signal path",
			env:          map[string]string{EnvOTLPEndpoint: "https://collector.example.com:4318"},
			wantEnabled:  true,
			wantEndpoint: "collector.example.com:4318",
			wantPath:     "/v1/traces",
		},
		{
			name:         "generic endpoint with base path",
			env:          map[string]string{EnvOTLPEndpoint: "https://collector.example.com/otlp"},
			wantEnabled:  true,
			wantEndpoint: "collector.example.com",
			wantPath:     "/otlp/v1/traces",
		},
		{
			name:         "generic http scheme implies insecure",
			env:          map[string]string{EnvOTLPEndpoint: "http://collector:4318", EnvOTLPInsecure: "false"},
			wantEnabled:  true,
			wantEndpoint: "collector:4318",
			wantPath:     "/v1/traces",
			wantInsecure: true,
		},
		{
			name:         "bare host with insecure flag",
			env:          map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPInsecure: "true"},
			wantEnabled:  true,
			wantEndpoint: "collector:4318",
			wantPath:     "/v1/traces",
			wantInsecure: true,
		},
		{
			name: "signal-specific endpoint used verbatim",
			env: map[string]string{
				EnvOTLPEndpoint:       "https://generic.example.com:4318",
				EnvOTLPTracesEndpoint: "https://traces.example.com:4319/custom/path",
			},
			wantEnabled:  true,
			wantEndpoint: "traces.example.com:4319",
			wantPath:     "/custom/path",
		},
		{
			name: "signal-specific insecure override",
			env: map[string]string{
				EnvOTLPEndpoint:       "collector:4318",
				EnvOTLPInsecure:       "false",
				EnvOTLPTracesInsecure: "true",
			},
			wantEnabled:  true,
			wantEndpoint: "collector:4318",
			wantPath:     "/v1/traces",
			wantInsecure: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg, enabled, err := parseOTLPEnv(staticEnv(tc.env))
			if err != nil {
				t.Fatalf("parseOTLPEnv: %v", err)
			}
			if enabled != tc.wantEnabled {
				t.Fatalf("enabled = %v, want %v", enabled, tc.wantEnabled)
			}
			if !enabled {
				return
			}
			if cfg.Endpoint != tc.wantEndpoint {
				t.Errorf("Endpoint = %q, want %q", cfg.Endpoint, tc.wantEndpoint)
			}
			if cfg.URLPath != tc.wantPath {
				t.Errorf("URLPath = %q, want %q", cfg.URLPath, tc.wantPath)
			}
			if cfg.Insecure != tc.wantInsecure {
				t.Errorf("Insecure = %v, want %v", cfg.Insecure, tc.wantInsecure)
			}
		})
	}
}

func TestOTLPConfigInvalidValuesFailBoot(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"bad headers", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPHeaders: "authorization"}},
		{"bad header escape", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPHeaders: "authorization=%zz"}},
		{"bad timeout", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPTimeout: "soon"}},
		{"negative timeout", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPTimeout: "-5"}},
		{"bad insecure", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvOTLPInsecure: "maybe"}},
		{"bad sampler", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvTracesSampler: "jaeger_remote"}},
		{"bad ratio arg", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvTracesSampler: "traceidratio", EnvTracesSamplerArg: "2"}},
		{"non-numeric ratio arg", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvTracesSampler: "traceidratio", EnvTracesSamplerArg: "half"}},
		{"bad resource attrs", map[string]string{EnvOTLPEndpoint: "collector:4318", EnvResourceAttributes: "key-without-value"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewTracing(context.Background(), TracingOptions{Env: staticEnv(tc.env)}); err == nil {
				t.Fatalf("NewTracing accepted %v", tc.env)
			}
		})
	}
}

func TestSamplerMapping(t *testing.T) {
	supported := map[string]bool{
		"":                         true,
		"always_on":                true,
		"always_off":               true,
		"traceidratio":             true,
		"parentbased_always_on":    true,
		"parentbased_always_off":   true,
		"parentbased_traceidratio": true,
	}
	for name := range supported {
		if _, err := samplerFromEnv(staticEnv(map[string]string{EnvTracesSampler: name})); err != nil {
			t.Errorf("sampler %q refused: %v", name, err)
		}
	}
	// Ratio default: sample everything when ARG is absent.
	sampler, err := samplerFromEnv(staticEnv(map[string]string{EnvTracesSampler: "traceidratio"}))
	if err != nil {
		t.Fatalf("traceidratio without ARG: %v", err)
	}
	if got := samplerDescription(sampler); got != "TraceIDRatioBased{1}" {
		t.Errorf("default ratio sampler = %q, want ratio 1", got)
	}
	// Explicit ratio honored (and visible through the parent-based wrapper).
	sampler, err = samplerFromEnv(staticEnv(map[string]string{EnvTracesSampler: "parentbased_traceidratio", EnvTracesSamplerArg: "0.25"}))
	if err != nil {
		t.Fatalf("parentbased_traceidratio: %v", err)
	}
	if got := samplerDescription(sampler); !strings.Contains(got, "TraceIDRatioBased{0.25}") {
		t.Errorf("ratio sampler = %q, want 0.25 inside", got)
	}
}

// samplerDescription renders the sampler (SDK samplers stringify their
// decision parameters — enough to assert the parsed ratio without
// probability-cracking the sampler itself).
func samplerDescription(sampler sdktrace.Sampler) string {
	return sampler.Description()
}

func TestServiceNameResolution(t *testing.T) {
	cases := []struct {
		name     string
		env      map[string]string
		fallback string
		want     string
	}{
		{"env wins", map[string]string{EnvServiceName: "env-name"}, "option-name", "env-name"},
		{"option fallback", map[string]string{}, "option-name", "option-name"},
		{"hard default", map[string]string{}, "", defaultServiceName},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := tracingResource(staticEnv(tc.env), tc.fallback)
			if err != nil {
				t.Fatalf("tracingResource: %v", err)
			}
			for _, kv := range res.Attributes() {
				if kv.Key == "service.name" && kv.Value.AsString() != tc.want {
					t.Errorf("service.name = %q, want %q", kv.Value.AsString(), tc.want)
				}
			}
		})
	}
}

func TestResourceAttributesParsing(t *testing.T) {
	decoded, err := parseResourceAttributes("deployment.environment=prod%2Ceu , team=obs")
	if err != nil {
		t.Fatalf("parseResourceAttributes: %v", err)
	}
	if decoded["deployment.environment"] != "prod,eu" || decoded["team"] != "obs" {
		t.Errorf("decoded = %v", decoded)
	}
}

func TestPropagatorInjectsW3CTraceContext(t *testing.T) {
	tracing, err := NewTracing(context.Background(), TracingOptions{Env: staticEnv(nil)})
	if err != nil {
		t.Fatalf("NewTracing: %v", err)
	}
	const remote = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	in := propagation.MapCarrier{"traceparent": remote}
	ctx := tracing.Propagator.Extract(context.Background(), in)
	ctx, span := tracing.Tracer("test").Start(ctx, "op")
	defer span.End()

	// The propagator round-trips the trace: extraction keeps the remote id,
	// injection writes a syntactically valid traceparent for downstream hops.
	out := propagation.MapCarrier{}
	tracing.Propagator.Inject(ctx, out)
	parts := strings.Split(out.Get("traceparent"), "-")
	if len(parts) != 4 || parts[0] != "00" {
		t.Fatalf("injected traceparent = %q", out.Get("traceparent"))
	}
	if parts[1] != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("injected trace id = %s, want the remote id", parts[1])
	}
	reextracted := tracing.Propagator.Extract(context.Background(), out)
	if got := trace.SpanContextFromContext(reextracted).TraceID().String(); got != parts[1] {
		t.Errorf("round-trip trace id = %s, want %s", got, parts[1])
	}
}
