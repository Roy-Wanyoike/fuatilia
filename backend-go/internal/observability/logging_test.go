package observability

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// emitJSON drives one record through the production factory and returns the
// parsed JSON object for assertion.
func emitJSON(t *testing.T, env func(string) string, build func(log *slog.Logger)) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	log := NewLogger(env, &buf)
	build(log)
	line := strings.TrimSpace(buf.String())
	if line == "" {
		t.Fatalf("expected one JSON log line, got none")
	}
	if strings.Contains(line, "\n") {
		t.Fatalf("expected one JSON log line, got %d", strings.Count(line, "\n")+1)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(line), &out); err != nil {
		t.Fatalf("log line is not valid JSON: %v\n%s", err, line)
	}
	return out
}

func staticEnv(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLevelFromEnv(t *testing.T) {
	cases := []struct {
		raw  string
		want slog.Level
		ok   bool
	}{
		{"", slog.LevelInfo, true},
		{"info", slog.LevelInfo, true},
		{"INFO", slog.LevelInfo, true},
		{"debug", slog.LevelDebug, true},
		{"Debug", slog.LevelDebug, true},
		{"warn", slog.LevelWarn, true},
		{"warning", slog.LevelWarn, true},
		{"WARN", slog.LevelWarn, true},
		{"error", slog.LevelError, true},
		{"ERROR", slog.LevelError, true},
		{"verbose", slog.LevelInfo, false},
		{"2", slog.LevelInfo, false},
		{" trace ", slog.LevelInfo, false},
	}
	for _, tc := range cases {
		got, ok := LevelFromEnv(staticEnv(map[string]string{EnvLogLevel: tc.raw}))
		if got != tc.want || ok != tc.ok {
			t.Errorf("LevelFromEnv(%q) = (%v, %v), want (%v, %v)", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

func TestNewLoggerJSONShapeAndLevel(t *testing.T) {
	out := emitJSON(t, staticEnv(nil), func(log *slog.Logger) {
		log.Info("http.request", slog.String("requestId", "req-1"), slog.Int("status", 200))
	})
	if out["msg"] != "http.request" {
		t.Errorf("msg = %v, want http.request", out["msg"])
	}
	if out["level"] != "INFO" {
		t.Errorf("level = %v, want INFO", out["level"])
	}
	if out["requestId"] != "req-1" || out["status"] != float64(200) {
		t.Errorf("attrs missing or wrong: %v", out)
	}

	// Level filtering: at warn, info records never reach the writer.
	var buf bytes.Buffer
	log := NewLogger(staticEnv(map[string]string{EnvLogLevel: "warn"}), &buf)
	log.Info("dropped")
	if buf.Len() != 0 {
		t.Errorf("info record emitted at warn level: %q", buf.String())
	}
	log.Warn("kept")
	if !strings.Contains(buf.String(), `"kept"`) {
		t.Errorf("warn record missing: %q", buf.String())
	}
}

func TestRedactionHostilePayloads(t *testing.T) {
	cases := []struct {
		name    string
		groups  []string
		emit    func(log *slog.Logger)
		dropped []string // JSON paths that must NOT appear (top-level keys)
		kept    map[string]any
	}{
		{
			name: "top-level authorization",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.String("authorization", "Bearer tok"), slog.String("user", "u"))
			},
			dropped: []string{"authorization"},
			kept:    map[string]any{"user": "u"},
		},
		{
			name: "case-insensitive password",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.String("PaSsWoRd", "hunter2"), slog.String("host", "db"))
			},
			dropped: []string{"PaSsWoRd"},
			kept:    map[string]any{"host": "db"},
		},
		{
			name: "substring containment",
			emit: func(log *slog.Logger) {
				log.Info("m",
					slog.String("x-authorization", "v"),
					slog.String("api_token", "v"),
					slog.String("clientSecret", "v"),
					slog.String("user_credentials", "v"),
					slog.String("ACCESS_TOKEN_VALUE", "v"),
				)
			},
			dropped: []string{"x-authorization", "api_token", "clientSecret", "user_credentials", "ACCESS_TOKEN_VALUE"},
			kept:    map[string]any{},
		},
		{
			name:   "nested groups",
			groups: []string{"http", "headers"},
			emit: func(log *slog.Logger) {
				log.Info("m", slog.String("token", "v"), slog.String("accept", "json"))
			},
			dropped: []string{"token"},
		},
		{
			name: "forbidden group name hides children",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Group("credentials", slog.String("username", "u"), slog.String("note", "n")))
			},
			dropped: []string{"credentials"},
		},
		{
			name: "inline group with mixed children",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Group("config",
					slog.String("host", "db.internal"),
					slog.String("secret", "s3cret"),
					slog.Int("port", 5432),
				))
			},
			dropped: []string{"secret"},
			kept:    map[string]any{"config": map[string]any{"host": "db.internal", "port": float64(5432)}},
		},
		{
			name: "deeply nested group child",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Group("db", slog.Group("primary",
					slog.String("host", "h"),
					slog.String("PASSWORD", "p"),
				)))
			},
			dropped: []string{"PASSWORD"},
			kept:    map[string]any{"db": map[string]any{"primary": map[string]any{"host": "h"}}},
		},
		{
			name: "map smuggled through slog.Any",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Any("body", map[string]any{
					"name":     "invoice",
					"password": "p",
					"nested":   map[string]any{"api_secret": "s", "amount": 42},
					"tags":     "fine",
				}))
			},
			dropped: []string{"password", "api_secret"},
			kept: map[string]any{"body": map[string]any{
				"name":   "invoice",
				"nested": map[string]any{"amount": float64(42)},
				"tags":   "fine",
			}},
		},
		{
			name: "string map smuggled through slog.Any",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Any("headers", map[string]string{
					"Authorization": "Bearer x",
					"Accept":        "json",
				}))
			},
			dropped: []string{"Authorization"},
			kept:    map[string]any{"headers": map[string]any{"Accept": "json"}},
		},
		{
			name: "group reduced to nothing disappears",
			emit: func(log *slog.Logger) {
				log.Info("m", slog.Group("secrets", slog.String("token", "t")), slog.String("keep", "k"))
			},
			dropped: []string{"secrets"},
			kept:    map[string]any{"keep": "k"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out := emitJSON(t, staticEnv(nil), func(log *slog.Logger) {
				for i := len(tc.groups) - 1; i >= 0; i-- {
					log = log.WithGroup(tc.groups[i])
				}
				tc.emit(log)
			})
			for _, path := range tc.dropped {
				if _, present := out[path]; present {
					t.Errorf("forbidden key %q leaked: %v", path, out)
				}
			}
			if tc.kept != nil {
				for key, want := range tc.kept {
					got, present := out[key]
					if !present {
						t.Errorf("expected key %q in %v", key, out)
						continue
					}
					wantJSON, _ := json.Marshal(want)
					gotJSON, _ := json.Marshal(got)
					if string(wantJSON) != string(gotJSON) {
						t.Errorf("key %q = %s, want %s", key, gotJSON, wantJSON)
					}
				}
			}
		})
	}
}

func TestBoundContextSecretNeverLeaks(t *testing.T) {
	var buf bytes.Buffer
	log := NewLogger(staticEnv(nil), &buf)
	bound := log.With(slog.String("authorization", "Bearer x"), slog.String("org", "o1"))
	bound.Info("first")
	// The same derived logger must stay clean for every later record.
	bound.Info("second", slog.String("status", "ok"))
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("want 2 records, got %d: %s", len(lines), buf.String())
	}
	for i, line := range lines {
		var out map[string]any
		if err := json.Unmarshal([]byte(line), &out); err != nil {
			t.Fatalf("record %d is not valid JSON: %v", i, err)
		}
		if _, present := out["authorization"]; present {
			t.Errorf("record %d leaked the bound secret: %s", i, line)
		}
	}
	var second map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil {
		t.Fatalf("second record unparsable: %v", err)
	}
	if second["org"] != "o1" || second["status"] != "ok" {
		t.Errorf("benign bound attrs lost: %v", second)
	}
}

func TestRedactionDoesNotMutateCallerMaps(t *testing.T) {
	input := map[string]any{"password": "p", "keep": 1}
	var buf bytes.Buffer
	log := NewLogger(staticEnv(nil), &buf)
	log.Info("m", slog.Any("body", input))
	if _, present := input["password"]; !present {
		t.Fatal("redaction mutated the caller's map")
	}
	if input["password"] != "p" || input["keep"] != 1 {
		t.Fatalf("caller map changed: %v", input)
	}
}

func TestRedactionPreservesRecordCore(t *testing.T) {
	out := emitJSON(t, staticEnv(nil), func(log *slog.Logger) {
		log.Error("boom", slog.String("secret", "s"), slog.String("requestId", "r"))
	})
	if out["level"] != "ERROR" || out["msg"] != "boom" {
		t.Errorf("record core lost: %v", out)
	}
	if out["requestId"] != "r" {
		t.Errorf("benign sibling lost: %v", out)
	}
}

// compile-time guard: the redaction wrapper is a drop-in slog.Handler.
var _ slog.Handler = redactHandler{}
