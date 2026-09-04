// Package infra hosts the /v1 kernel's environment adapters (issue #72):
// configuration, the PostgreSQL pool, the clock port, typed domain errors,
// the transactional outbox helper and the audited-denial sink.
package infra

import (
	"strings"
	"time"
)

// Config is the env-driven composition configuration of cmd/api (issue #72):
// DATABASE_URL and LISTEN_ADDR, plus the pgx pool knobs the deployment
// contract (.env.example) names. Secrets are read from the environment and
// never logged by the kernel.
type Config struct {
	// DatabaseURL is the PostgreSQL target
	// (postgres://user[:pass]@host:port/db?sslmode=disable).
	DatabaseURL string
	// ListenAddr is the TCP bind address (e.g. ":8080").
	ListenAddr string
	// MaxBodyBytes caps request JSON bodies (kernel default 1 MiB, like the
	// TS kernel's body.ts; fixed by the wire contract, not an env knob).
	MaxBodyBytes int64
	// PGMaxConns is the pgxpool max connections (FUATILIA_PG_MAX_CONNS).
	PGMaxConns int32
	// PGConnMaxLifetime is the pool connection lifetime (FUATILIA_PG_LIFETIME).
	PGConnMaxLifetime time.Duration
	// PGConnMaxIdleTime is the pool idle timeout (FUATILIA_PG_IDLE_TIME).
	PGConnMaxIdleTime time.Duration
}

// Defaults mirroring src/adapters/http/kernel/body.ts and the deployment
// contract in .env.example (wave 10-d): the kernel reads ONLY the variables
// the environment contract lists.
const (
	DefaultMaxBodyBytes     = 1_048_576 // 1 MiB
	DefaultListenAddr       = ":8080"
	DefaultPGMaxConns       = 10
	DefaultPGConnLifetime   = 30 * time.Minute
	DefaultPGConnIdleTime   = 5 * time.Minute
	minPGMaxConns           = 1
	minPGConnLifetimeWindow = time.Second
)

// LoadConfig reads the environment. DATABASE_URL is required (the kernel has
// no persistence-free mode); LISTEN_ADDR defaults to :8080; the pool knobs
// default to conservative production values.
func LoadConfig(env func(string) string) (Config, error) {
	cfg := Config{
		DatabaseURL:       strings.TrimSpace(env("DATABASE_URL")),
		ListenAddr:        strings.TrimSpace(env("LISTEN_ADDR")),
		MaxBodyBytes:      DefaultMaxBodyBytes,
		PGMaxConns:        DefaultPGMaxConns,
		PGConnMaxLifetime: DefaultPGConnLifetime,
		PGConnMaxIdleTime: DefaultPGConnIdleTime,
	}
	if cfg.DatabaseURL == "" {
		return Config{}, errConfig("DATABASE_URL is required (postgres://user@host:port/db?sslmode=disable)")
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = DefaultListenAddr
	}
	if raw := strings.TrimSpace(env("FUATILIA_PG_MAX_CONNS")); raw != "" {
		n, ok := parsePositiveInt(raw)
		if !ok {
			return Config{}, errConfig("FUATILIA_PG_MAX_CONNS must be a positive integer")
		}
		cfg.PGMaxConns = int32(n)
	}
	if raw := strings.TrimSpace(env("FUATILIA_PG_LIFETIME")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < minPGConnLifetimeWindow {
			return Config{}, errConfig("FUATILIA_PG_LIFETIME must be a duration of at least 1s (e.g. 30m)")
		}
		cfg.PGConnMaxLifetime = d
	}
	if raw := strings.TrimSpace(env("FUATILIA_PG_IDLE_TIME")); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d < minPGConnLifetimeWindow {
			return Config{}, errConfig("FUATILIA_PG_IDLE_TIME must be a duration of at least 1s (e.g. 5m)")
		}
		cfg.PGConnMaxIdleTime = d
	}
	return cfg, nil
}

func parsePositiveInt(raw string) (int, bool) {
	n := 0
	if raw == "" {
		return 0, false
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
		if n > 1<<31-1 {
			return 0, false
		}
	}
	if n < minPGMaxConns {
		return 0, false
	}
	return n, true
}

type configError string

func (e configError) Error() string { return string(e) }

func errConfig(msg string) error { return configError("config: " + msg) }
