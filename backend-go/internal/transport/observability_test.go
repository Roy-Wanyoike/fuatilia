package transport_test

// Serving-chain wiring tests (issue #176): the route labeler's
// low-cardinality contract and the /metrics dispatch — through the REAL
// Compose chain (Componse mounts the whole table; these routes touch no
// database, so no cluster is needed here; the PG-backed end-to-end suite
// lives in observability_integration_test.go).

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"
)

// okHandler is the minimal 2xx handler the labeler's table needs (handlers
// never run in the labeler tests — only the compiled patterns matter).
func okHandler(*transport.RequestContext) (transport.HandlerResult, error) {
	return transport.HandlerResult{Status: http.StatusOK, Data: map[string]any{"status": "ok"}}, nil
}

// labelerKernel is a tiny table with every pattern shape the resolver must
// tell apart: literal, :param, nested param, and cross-method rows.
func labelerKernel(t *testing.T) *transport.Kernel {
	t.Helper()
	kernel, err := transport.NewKernel(transport.KernelOptions{
		Routes: []transport.RouteRecord{
			{Method: "GET", Pattern: "/v1/health", Handler: okHandler},
			{Method: "GET", Pattern: "/v1/meta", Handler: okHandler},
			{Method: "GET", Pattern: "/v1/receivables/:id", Handler: okHandler},
			{Method: "POST", Pattern: "/v1/receivables/:id/refund", Handler: okHandler},
			{Method: "DELETE", Pattern: "/v1/cases/:id", Handler: okHandler},
		},
		Log: slog.New(slog.DiscardHandler),
	})
	if err != nil {
		t.Fatalf("NewKernel: %v", err)
	}
	return kernel
}

func TestRouteLabelerResolvesRegisteredPatternsOnly(t *testing.T) {
	label := labelerKernel(t).RouteLabeler()
	cases := []struct {
		name, method, target, want string
	}{
		{"literal", http.MethodGet, "/v1/health", "/v1/health"},
		{"trailing slash tolerated in place", http.MethodGet, "/v1/health/", "/v1/health"},
		{"param collapses to the pattern", http.MethodGet, "/v1/receivables/9f8c2f30-1111-2222-3333-444455556666", "/v1/receivables/:id"},
		{"another id, same series", http.MethodGet, "/v1/receivables/anything", "/v1/receivables/:id"},
		{"method-agnostic: 405 shapes still label the route", http.MethodPost, "/v1/receivables/anything", "/v1/receivables/:id"},
		{"nested param", http.MethodPost, "/v1/receivables/abc/refund", "/v1/receivables/:id/refund"},
		{"path-only match ignores the mounted method", http.MethodGet, "/v1/receivables/abc/refund", "/v1/receivables/:id/refund"},
		{"second param row", http.MethodDelete, "/v1/cases/case-1", "/v1/cases/:id"},
		{"unversioned root", http.MethodGet, "/", ""},
		{"unknown literal", http.MethodGet, "/v1/unknown", ""},
		{"extra segment", http.MethodGet, "/v1/receivables/abc/extra", ""},
		{"percent-escape never splits a segment", http.MethodGet, "/v1/health%2Fx", ""},
		{"double slash never matches", http.MethodGet, "//v1/health", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.target, nil)
			if got := label(r); got != tc.want {
				t.Fatalf("label(%s %s) = %q, want %q", tc.method, tc.target, got, tc.want)
			}
		})
	}
}

// composedChain mounts the REAL table over the wired chain (no database is
// touched: health/meta/404/405 answers run handler-free or fail before any
// store call).
func composedChain(t *testing.T, wiring transport.ObservabilityWiring) *httptest.Server {
	t.Helper()
	composed, err := transport.Compose(transport.Deps{Observability: wiring}, slog.New(slog.DiscardHandler), nil)
	if err != nil {
		t.Fatalf("Compose: %v", err)
	}
	server := httptest.NewServer(composed.Handler)
	t.Cleanup(server.Close)
	return server
}

func TestServingChainMountsMetricsOutsideThePipeline(t *testing.T) {
	server := composedChain(t, transport.ObservabilityWiring{
		Metrics: observability.NewMetrics(observability.MetricsOptions{}),
	})

	// One API request first: the exposition must then carry its series with
	// the low-cardinality route label — proof the middleware observed it.
	resp, err := http.Get(server.URL + "/v1/health")
	if err != nil {
		t.Fatalf("GET /v1/health: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /v1/health status = %d, body %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Request-Id") == "" {
		t.Fatal("GET /v1/health carried no X-Request-Id — the middleware did not wrap the kernel")
	}
	if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("kernel security headers missing on the API response")
	}

	scrape, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	exposition, _ := io.ReadAll(scrape.Body)
	_ = scrape.Body.Close()
	if scrape.StatusCode != http.StatusOK {
		t.Fatalf("GET /metrics status = %d, body %s", scrape.StatusCode, exposition)
	}
	if scrape.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("security headers missing on the /metrics response")
	}
	text := string(exposition)
	for _, want := range []string{
		`fuatilia_http_requests_total{method="GET",route="/v1/health",status="200"}`,
		"fuatilia_http_request_duration_seconds_bucket",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("exposition missing %q:\n%s", want, text)
		}
	}

	// Method gate: the scrape port is not an API surface.
	post, err := http.Post(server.URL+"/metrics", "text/plain", strings.NewReader("x"))
	if err != nil {
		t.Fatalf("POST /metrics: %v", err)
	}
	_ = post.Body.Close()
	if post.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /metrics status = %d, want 405", post.StatusCode)
	}
	if allow := post.Header.Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("POST /metrics Allow = %q, want %q", allow, "GET, HEAD")
	}
}

func TestServingChainZeroConfigKeepsKernelSurface(t *testing.T) {
	server := composedChain(t, transport.ObservabilityWiring{})

	resp, err := http.Get(server.URL + "/metrics")
	if err != nil {
		t.Fatalf("GET /metrics: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("zero-config GET /metrics status = %d, want 404", resp.StatusCode)
	}
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("zero-config /metrics must fall through to the §38 envelope, got %q: %v", body, err)
	}
	if envelope.Error.Code != transport.CodeRouteNotFound {
		t.Fatalf("zero-config /metrics error code = %q, want %q", envelope.Error.Code, transport.CodeRouteNotFound)
	}
	// The middleware still wraps: request ids survive a zero-config boot.
	if resp.Header.Get("X-Request-Id") == "" {
		t.Fatal("zero-config response carried no X-Request-Id — the middleware must always wrap")
	}
}
