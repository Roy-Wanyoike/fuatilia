package observability

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"go.opentelemetry.io/otel/trace/noop"
)

// Tracing (issue #88): the TracerProvider factory. Configuration comes from
// the STANDARD OTEL_* environment names; the OTLP/HTTP exporter is built
// behind the injected ExporterFactory port (production default = the real
// otlphttp exporter, tests inject an in-memory one). With no endpoint
// configured the provider is the no-op — a prod/dev boot NEVER requires a
// collector, and a malformed PRESENT value fails the boot (config errors
// are deploy-time, never runtime).
//
// Propagation is W3C tracecontext + baggage and is always active: even in
// disabled mode a remote traceparent is passed through untouched, so
// upstream correlation survives a build without tracing.
const (
	EnvOTLPEndpoint          = "OTEL_EXPORTER_OTLP_ENDPOINT"
	EnvOTLPTracesEndpoint    = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
	EnvOTLPHeaders           = "OTEL_EXPORTER_OTLP_HEADERS"
	EnvOTLPTimeout           = "OTEL_EXPORTER_OTLP_TIMEOUT"
	EnvOTLPInsecure          = "OTEL_EXPORTER_OTLP_INSECURE"
	EnvOTLPTracesInsecure    = "OTEL_EXPORTER_OTLP_TRACES_INSECURE"
	EnvTracesSampler         = "OTEL_TRACES_SAMPLER"
	EnvTracesSamplerArg      = "OTEL_TRACES_SAMPLER_ARG"
	EnvServiceName           = "OTEL_SERVICE_NAME"
	EnvResourceAttributes    = "OTEL_RESOURCE_ATTRIBUTES"
	defaultServiceName       = "fuatilia"
	defaultTracesURLPath     = "/v1/traces"
	defaultTracesSamplerName = "parentbased_always_on"
)

// OTLPConfig is the derived OTLP/HTTP exporter configuration — what the
// env parsing produced (the injected factory receives it verbatim, so tests
// can assert the derivation without dialing anything).
type OTLPConfig struct {
	// Endpoint is the exporter target WITHOUT scheme (host[:port]).
	Endpoint string
	// URLPath overrides the export path ("" = exporter default). Generic
	// endpoints get the signal path appended; signal-specific endpoints are
	// used verbatim, per the OTLP env specification.
	URLPath string
	// Insecure selects plain HTTP transport.
	Insecure bool
	// Headers are sent with every export (auth headers etc.).
	Headers map[string]string
	// Timeout bounds each export request (0 = exporter default).
	Timeout time.Duration
}

// ExporterFactory is the injected exporter port. Production leaves it nil
// and gets the real OTLP/HTTP exporter; tests inject a fake that records
// spans in memory.
type ExporterFactory func(ctx context.Context, cfg OTLPConfig) (sdktrace.SpanExporter, error)

// Tracing is the boot-time tracing handle. A nil *Tracing behaves like a
// disabled one in every method.
type Tracing struct {
	// TracerProvider is the ready provider (the no-op one when disabled) —
	// callers never nil-check.
	TracerProvider trace.TracerProvider
	// Propagator is W3C tracecontext + baggage (both modes).
	Propagator propagation.TextMapPropagator
	enabled    bool
	shutdown   func(context.Context) error
}

// Enabled reports whether spans are recorded (not the no-op provider).
func (t *Tracing) Enabled() bool { return t != nil && t.enabled }

// Tracer returns a named tracer from the provider (nil-safe).
func (t *Tracing) Tracer(name string) trace.Tracer {
	if t == nil || t.TracerProvider == nil {
		return noop.NewTracerProvider().Tracer(name)
	}
	return t.TracerProvider.Tracer(name)
}

// Shutdown flushes and releases the provider (nil-safe no-op when disabled).
func (t *Tracing) Shutdown(ctx context.Context) error {
	if t == nil || t.shutdown == nil {
		return nil
	}
	return t.shutdown(ctx)
}

// TracingOptions configures the factory.
type TracingOptions struct {
	// ServiceName is the fallback resource service.name when
	// OTEL_SERVICE_NAME is unset (default "fuatilia").
	ServiceName string
	// Exporter overrides the OTLP/HTTP exporter construction — the injected
	// port. nil → production otlphttp factory.
	Exporter ExporterFactory
	// Env is the environment reader (nil → os.Getenv); injected so tests
	// never race on process-wide env.
	Env func(string) string
}

// NewTracing resolves the OTEL_* env, builds the provider and returns the
// boot handle. Disabled mode (no endpoint configured) is an explicit value,
// not an error.
func NewTracing(ctx context.Context, opts TracingOptions) (*Tracing, error) {
	env := opts.Env
	if env == nil {
		env = os.Getenv
	}
	propagator := propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{})

	cfg, enabled, err := parseOTLPEnv(env)
	if err != nil {
		return nil, err
	}
	if !enabled {
		return &Tracing{
			TracerProvider: noop.NewTracerProvider(),
			Propagator:     propagator,
		}, nil
	}
	sampler, err := samplerFromEnv(env)
	if err != nil {
		return nil, err
	}
	res, err := tracingResource(env, opts.ServiceName)
	if err != nil {
		return nil, err
	}
	factory := opts.Exporter
	if factory == nil {
		factory = otlpExporterFactory
	}
	exporter, err := factory(ctx, cfg)
	if err != nil {
		return nil, err
	}
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)
	return &Tracing{
		TracerProvider: provider,
		Propagator:     propagator,
		enabled:        true,
		shutdown:       provider.Shutdown,
	}, nil
}

// otlpExporterFactory is the production exporter port: the real OTLP/HTTP
// exporter with the derived options. Construction never dials — an
// unreachable collector surfaces on export (the batcher retries), so boot
// cannot block on infrastructure.
func otlpExporterFactory(ctx context.Context, cfg OTLPConfig) (sdktrace.SpanExporter, error) {
	var opts []otlptracehttp.Option
	if cfg.Endpoint != "" {
		opts = append(opts, otlptracehttp.WithEndpoint(cfg.Endpoint))
	}
	if cfg.URLPath != "" {
		opts = append(opts, otlptracehttp.WithURLPath(cfg.URLPath))
	}
	if cfg.Insecure {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	if len(cfg.Headers) > 0 {
		opts = append(opts, otlptracehttp.WithHeaders(cfg.Headers))
	}
	if cfg.Timeout > 0 {
		opts = append(opts, otlptracehttp.WithTimeout(cfg.Timeout))
	}
	exporter, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("OTLP/HTTP exporter: %v", err)}
	}
	return exporter, nil
}

// parseOTLPEnv resolves the OTLP env trio (generic endpoint, signal-specific
// endpoint, security). enabled is false exactly when no endpoint variable is
// set — the disabled-by-default contract.
func parseOTLPEnv(env func(string) string) (OTLPConfig, bool, error) {
	generic := strings.TrimSpace(env(EnvOTLPEndpoint))
	traces := strings.TrimSpace(env(EnvOTLPTracesEndpoint))
	if generic == "" && traces == "" {
		return OTLPConfig{}, false, nil
	}
	cfg := OTLPConfig{}

	var rawEndpoint, insecureEnv string
	// The signal-specific INSECURE override wins over the generic one —
	// regardless of which endpoint variable supplied the URL.
	insecureEnv = firstNonEmpty(env(EnvOTLPTracesInsecure), env(EnvOTLPInsecure))
	switch {
	case traces != "":
		// Signal-specific endpoint: used verbatim (path included).
		rawEndpoint = traces
		scheme, host, path, hasScheme := splitEndpoint(rawEndpoint)
		if hasScheme {
			cfg.Endpoint = host
			cfg.URLPath = path
			cfg.Insecure = scheme == "http"
		} else {
			cfg.Endpoint = rawEndpoint
		}
		insecure, err := parseInsecure(insecureEnv)
		if err != nil {
			return OTLPConfig{}, false, err
		}
		cfg.Insecure = cfg.Insecure || insecure
	default:
		// Generic endpoint: the signal path is appended (replacing any
		// trailing slash), per the OTLP env specification.
		rawEndpoint = generic
		scheme, host, path, hasScheme := splitEndpoint(rawEndpoint)
		if hasScheme {
			cfg.Endpoint = host
			cfg.URLPath = appendTracesPath(path)
			cfg.Insecure = scheme == "http"
		} else {
			cfg.Endpoint = rawEndpoint
			cfg.URLPath = defaultTracesURLPath
		}
		insecure, err := parseInsecure(insecureEnv)
		if err != nil {
			return OTLPConfig{}, false, err
		}
		cfg.Insecure = cfg.Insecure || insecure
	}

	headers, err := parseHeaders(env(EnvOTLPHeaders))
	if err != nil {
		return OTLPConfig{}, false, err
	}
	cfg.Headers = headers

	timeout, err := parseTimeout(env(EnvOTLPTimeout))
	if err != nil {
		return OTLPConfig{}, false, err
	}
	cfg.Timeout = timeout
	return cfg, true, nil
}

// splitEndpoint separates an endpoint value into scheme/host/path. Only
// http:// and https:// count as schemes — "host:4318" (opaque to
// url.Parse's scheme detector) stays a bare host.
func splitEndpoint(raw string) (scheme, host, path string, hasScheme bool) {
	marker := strings.Index(raw, "://")
	if marker < 0 {
		return "", raw, "", false
	}
	candidate := strings.ToLower(raw[:marker])
	if candidate != "http" && candidate != "https" {
		return "", raw, "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return "", raw, "", false
	}
	return candidate, parsed.Host, parsed.Path, true
}

// appendTracesPath appends the signal path to a generic endpoint's path.
func appendTracesPath(basePath string) string {
	basePath = strings.TrimSuffix(basePath, "/")
	if basePath == "" {
		return defaultTracesURLPath
	}
	return basePath + defaultTracesURLPath
}

// parseInsecure reads the OTEL_*_INSECURE booleans (empty = not set).
func parseInsecure(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return false, nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, errConfig(fmt.Sprintf("%s must be true or false, got %q", EnvOTLPInsecure, raw))
	}
}

// parseHeaders parses OTEL_EXPORTER_OTLP_HEADERS: comma-separated key=value
// with URL-escaped values (application/x-www-form-urlencoded, per spec).
func parseHeaders(raw string) (map[string]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	out := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return nil, errConfig(fmt.Sprintf("%s entry %q must be key=value", EnvOTLPHeaders, pair))
		}
		decoded, err := url.QueryUnescape(value)
		if err != nil {
			return nil, errConfig(fmt.Sprintf("%s value for %q is not URL-escaped: %v", EnvOTLPHeaders, key, err))
		}
		out[key] = decoded
	}
	return out, nil
}

// parseTimeout parses OTEL_EXPORTER_OTLP_TIMEOUT (milliseconds).
func parseTimeout(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, nil
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		return 0, errConfig(fmt.Sprintf("%s must be a positive integer of milliseconds, got %q", EnvOTLPTimeout, raw))
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// samplerFromEnv maps OTEL_TRACES_SAMPLER[+_ARG] onto the SDK samplers.
func samplerFromEnv(env func(string) string) (sdktrace.Sampler, error) {
	name := strings.TrimSpace(env(EnvTracesSampler))
	arg := strings.TrimSpace(env(EnvTracesSamplerArg))
	switch name {
	case "", defaultTracesSamplerName:
		return sdktrace.ParentBased(sdktrace.AlwaysSample()), nil
	case "always_on":
		return sdktrace.AlwaysSample(), nil
	case "always_off":
		return sdktrace.NeverSample(), nil
	case "traceidratio":
		return ratioSampler(arg)
	case "parentbased_always_off":
		return sdktrace.ParentBased(sdktrace.NeverSample()), nil
	case "parentbased_traceidratio":
		base, err := ratioSampler(arg)
		if err != nil {
			return nil, err
		}
		return sdktrace.ParentBased(base), nil
	default:
		return nil, errConfig(fmt.Sprintf("%s %q is not a supported sampler", EnvTracesSampler, name))
	}
}

func ratioSampler(arg string) (sdktrace.Sampler, error) {
	if arg == "" {
		// Spec default for ratio samplers: sample everything.
		return sdktrace.TraceIDRatioBased(1.0), nil
	}
	ratio, err := strconv.ParseFloat(arg, 64)
	if err != nil || ratio < 0 || ratio > 1 {
		return nil, errConfig(fmt.Sprintf("%s for a ratio sampler must be a number in [0,1], got %q", EnvTracesSamplerArg, arg))
	}
	return sdktrace.TraceIDRatioBased(ratio), nil
}

// tracingResource builds the SDK resource: service.name from
// OTEL_SERVICE_NAME (fallback option, then "fuatilia") merged with
// OTEL_RESOURCE_ATTRIBUTES (percent-decoded key=value pairs, sorted for
// determinism) on top of the SDK defaults.
func tracingResource(env func(string) string, fallbackServiceName string) (*resource.Resource, error) {
	serviceName := strings.TrimSpace(env(EnvServiceName))
	if serviceName == "" {
		serviceName = strings.TrimSpace(fallbackServiceName)
	}
	if serviceName == "" {
		serviceName = defaultServiceName
	}
	attrs := []attribute.KeyValue{attribute.String("service.name", serviceName)}
	decoded, err := parseResourceAttributes(env(EnvResourceAttributes))
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(decoded))
	for key := range decoded {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		attrs = append(attrs, attribute.String(key, decoded[key]))
	}
	merged, err := resource.Merge(resource.Default(), resource.NewSchemaless(attrs...))
	if err != nil {
		return nil, &Error{Code: CodeConfigInvalid, Message: fmt.Sprintf("OTEL resource: %v", err)}
	}
	return merged, nil
}

// parseResourceAttributes parses OTEL_RESOURCE_ATTRIBUTES: comma-separated
// key=value, both parts percent-decoded per spec.
func parseResourceAttributes(raw string) (map[string]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	out := map[string]string{}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		if !found || key == "" {
			return nil, errConfig(fmt.Sprintf("%s entry %q must be key=value", EnvResourceAttributes, pair))
		}
		decodedKey, err := url.QueryUnescape(key)
		if err != nil {
			return nil, errConfig(fmt.Sprintf("%s key %q is not URL-escaped: %v", EnvResourceAttributes, key, err))
		}
		decodedValue, err := url.QueryUnescape(value)
		if err != nil {
			return nil, errConfig(fmt.Sprintf("%s value for %q is not URL-escaped: %v", EnvResourceAttributes, key, err))
		}
		out[decodedKey] = decodedValue
	}
	return out, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
