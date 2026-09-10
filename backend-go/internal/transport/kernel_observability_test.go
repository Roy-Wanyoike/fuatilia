package transport_test

// Request-scoped logging end-to-end (issue #176): the observability
// middleware wraps the kernel exactly like the serving chain does and every
// record — access line and handler line alike — must carry the SAME
// requestId + traceId, with the redaction guard between every emitter and
// the buffer. Driven synchronously through httptest.Recorder (no server
// goroutine), so buffer reads cannot race the writes.

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"
)

// hostileHandler logs through the request-scoped logger with keys a hostile
// (or merely buggy) emitter might produce, then answers 200.
func hostileHandler(rc *transport.RequestContext) (transport.HandlerResult, error) {
	rc.Log().Info("handler.event",
		slog.String("api_token", "leak-me"),
		slog.String("detail", "clean-value"),
		slog.Group("creds",
			slog.String("password", "leak-me-too"),
			slog.String("note", "group-note"),
		),
	)
	return transport.HandlerResult{Status: http.StatusOK, Data: map[string]any{"ok": true}}, nil
}

// wiredKernel is the middleware-over-kernel chain with a fixed generator so
// generated ids are deterministic assertions, not uuid decoding.
func wiredKernel(t *testing.T, buf *bytes.Buffer) http.Handler {
	t.Helper()
	kernel, err := transport.NewKernel(transport.KernelOptions{
		Routes: []transport.RouteRecord{
			{Method: "GET", Pattern: "/v1/hostile", Handler: hostileHandler},
		},
		Log: slog.New(slog.NewJSONHandler(buf, nil)),
	})
	if err != nil {
		t.Fatalf("NewKernel: %v", err)
	}
	return observability.Middleware(observability.MiddlewareOptions{
		Log:     observability.NewRedactedLogger(slog.NewJSONHandler(buf, nil)),
		Metrics: observability.NewMetrics(observability.MetricsOptions{}),
		NewRequestID: func() string {
			return "gen-fixed-id"
		},
	})(kernel)
}

func drive(t *testing.T, handler http.Handler, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/hostile", nil)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// findLine decodes the buffer's JSON records and returns the one whose msg
// matches (failing when it is missing).
func findLine(t *testing.T, buf *bytes.Buffer, msg string) map[string]any {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(buf.Bytes()))
	found := false
	var line map[string]any
	for dec.More() {
		var candidate map[string]any
		if err := dec.Decode(&candidate); err != nil {
			t.Fatalf("log line is not valid JSON: %v\n%s", err, buf.String())
		}
		if candidate["msg"] == msg {
			if found {
				t.Fatalf("log buffer carries two %q records:\n%s", msg, buf.String())
			}
			line, found = candidate, true
		}
	}
	if !found {
		t.Fatalf("log buffer has no %q record:\n%s", msg, buf.String())
	}
	return line
}

func TestRequestScopedLogIDsEndToEnd(t *testing.T) {
	const (
		traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
		traceID     = "4bf92f3577b34da6a3ce929d0e0e4736"
	)

	t.Run("accepted id + no trace", func(t *testing.T) {
		var buf bytes.Buffer
		rec := drive(t, wiredKernel(t, &buf), map[string]string{"X-Request-Id": "client-id-1"})
		if got := rec.Header().Get("X-Request-Id"); got != "client-id-1" {
			t.Fatalf("response X-Request-Id = %q, want the accepted id", got)
		}
		access := findLine(t, &buf, "http.request")
		if got := access["requestId"]; got != "client-id-1" {
			t.Fatalf("access line requestId = %v, want the accepted id", got)
		}
		if got, ok := access["traceId"]; !ok || got != "" {
			t.Fatalf("access line traceId = %v (present=%v), want empty", got, ok)
		}
		handler := findLine(t, &buf, "handler.event")
		if got := handler["requestId"]; got != "client-id-1" {
			t.Fatalf("handler line requestId = %v, want the SAME accepted id", got)
		}
	})

	t.Run("generated id + remote trace round-trip", func(t *testing.T) {
		var buf bytes.Buffer
		rec := drive(t, wiredKernel(t, &buf), map[string]string{"traceparent": traceparent})
		if got := rec.Header().Get("X-Request-Id"); got != "gen-fixed-id" {
			t.Fatalf("response X-Request-Id = %q, want the generated id", got)
		}
		if got := rec.Header().Get("traceparent"); !strings.Contains(got, traceID) {
			t.Fatalf("response traceparent = %q, want trace id %q echoed", got, traceID)
		}
		for _, msg := range []string{"http.request", "handler.event"} {
			line := findLine(t, &buf, msg)
			if got := line["requestId"]; got != "gen-fixed-id" {
				t.Fatalf("%s requestId = %v, want the generated id", msg, got)
			}
			if got := line["traceId"]; got != traceID {
				t.Fatalf("%s traceId = %v, want %q", msg, got, traceID)
			}
		}
	})

	t.Run("hostile id regenerated and never logged", func(t *testing.T) {
		var buf bytes.Buffer
		rec := drive(t, wiredKernel(t, &buf), map[string]string{"X-Request-Id": "bad id\nwith<script>"})
		if got := rec.Header().Get("X-Request-Id"); got != "gen-fixed-id" {
			t.Fatalf("response X-Request-Id = %q, want the regenerated id", got)
		}
		if strings.Contains(buf.String(), "bad id") || strings.Contains(buf.String(), "<script>") {
			t.Fatalf("hostile request id leaked into the log:\n%s", buf.String())
		}
	})

	t.Run("hostile log keys redacted fail-closed", func(t *testing.T) {
		var buf bytes.Buffer
		drive(t, wiredKernel(t, &buf), nil)
		for _, leaked := range []string{"leak-me", "leak-me-too", "api_token", "password"} {
			if strings.Contains(buf.String(), leaked) {
				t.Fatalf("hostile key/value %q reached the log:\n%s", leaked, buf.String())
			}
		}
		handler := findLine(t, &buf, "handler.event")
		if _, gone := handler["api_token"]; gone {
			t.Fatal("api_token survived redaction on the handler line")
		}
		if got := handler["detail"]; got != "clean-value" {
			t.Fatalf("handler line detail = %v, want the clean attribute kept", got)
		}
		creds, ok := handler["creds"].(map[string]any)
		if !ok {
			t.Fatalf("handler line creds group missing or malformed: %v", handler["creds"])
		}
		if _, gone := creds["password"]; gone {
			t.Fatal("creds.password survived redaction inside the group")
		}
		if got := creds["note"]; got != "group-note" {
			t.Fatalf("creds.note = %v, want the non-secret sibling kept", got)
		}
	})
}

// TestPlainKernelAccessLogKeepsExplicitRequestID pins the unwrapped shape:
// without the middleware the access line carries the explicit requestId
// attribute (and stays one line with one requestId key).
func TestPlainKernelAccessLogKeepsExplicitRequestID(t *testing.T) {
	var buf bytes.Buffer
	kernel, err := transport.NewKernel(transport.KernelOptions{
		Routes: []transport.RouteRecord{
			{Method: "GET", Pattern: "/v1/hostile", Handler: hostileHandler},
		},
		Log: slog.New(slog.NewJSONHandler(&buf, nil)),
	})
	if err != nil {
		t.Fatalf("NewKernel: %v", err)
	}
	rec := drive(t, kernel, map[string]string{"X-Request-Id": "plain-id"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	line := findLine(t, &buf, "http.request")
	if got := line["requestId"]; got != "plain-id" {
		t.Fatalf("plain access line requestId = %v, want the accepted id", got)
	}
	if _, present := line["traceId"]; present {
		t.Fatal("plain access line must not fabricate a traceId")
	}
}
