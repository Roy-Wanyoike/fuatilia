package infra

import (
	"strings"
	"testing"
	"time"
)

func TestLoadConfigDefaults(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://postgres@127.0.0.1:5435/db"}
	cfg, err := LoadConfig(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if cfg.ListenAddr != ":8080" || cfg.MaxBodyBytes != DefaultMaxBodyBytes {
		t.Fatalf("defaults drifted: %+v", cfg)
	}
	if cfg.PGMaxConns != 10 || cfg.PGConnMaxLifetime != 30*time.Minute || cfg.PGConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("pool knobs drifted: %+v", cfg)
	}
}

func TestLoadConfigRequiresDatabaseURL(t *testing.T) {
	if _, err := LoadConfig(func(string) string { return "" }); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("DATABASE_URL is required, got %v", err)
	}
}

func TestLoadConfigKnobs(t *testing.T) {
	env := map[string]string{
		"DATABASE_URL":          "postgres://postgres@127.0.0.1:5435/db",
		"LISTEN_ADDR":           "127.0.0.1:9090",
		"FUATILIA_PG_MAX_CONNS": "42",
		"FUATILIA_PG_LIFETIME":  "10m",
		"FUATILIA_PG_IDLE_TIME": "90s",
	}
	cfg, err := LoadConfig(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	if cfg.ListenAddr != "127.0.0.1:9090" || cfg.PGMaxConns != 42 ||
		cfg.PGConnMaxLifetime != 10*time.Minute || cfg.PGConnMaxIdleTime != 90*time.Second {
		t.Fatalf("knobs: %+v", cfg)
	}

	// invalid values refuse at boot
	env["FUATILIA_PG_MAX_CONNS"] = "zero"
	if _, err := LoadConfig(func(key string) string { return env[key] }); err == nil {
		t.Fatalf("a non-integer max-conns must fail boot")
	}
	env["FUATILIA_PG_LIFETIME"] = "500ms"
	if _, err := LoadConfig(func(key string) string { return env[key] }); err == nil {
		t.Fatalf("a sub-second lifetime must fail boot")
	}
}

func TestNewUUIDShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := NewUUID()
		if seen[id] {
			t.Fatalf("uuid collision: %s", id)
		}
		seen[id] = true
		if !IsUUID(id) {
			t.Fatalf("malformed uuid: %s", id)
		}
		// RFC 4122: version nibble 4, variant 10xx
		if id[14] != '4' {
			t.Fatalf("version nibble = %q, want 4", id[14])
		}
		if id[19] != '8' && id[19] != '9' && id[19] != 'a' && id[19] != 'b' {
			t.Fatalf("variant nibble = %q, want 8/9/a/b", id[19])
		}
	}
}

func TestIsUUIDShape(t *testing.T) {
	if IsUUID("") || IsUUID("not-a-uuid") || IsUUID("6f9619ff8b86d011b42d00c04fc964ff") {
		t.Fatalf("non-canonical shapes must refuse")
	}
	if !IsUUID("6f9619ff-8b86-d011-b42d-00c04fc964ff") {
		t.Fatalf("historical (non-v4) uuids must remain accepted on the wire")
	}
}

func TestRandomHex(t *testing.T) {
	h := RandomHex(32)
	if len(h) != 64 {
		t.Fatalf("length = %d, want 64 hex chars", len(h))
	}
	if strings.ToLower(h) != h {
		t.Fatalf("must be lowercase hex")
	}
}
