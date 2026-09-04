package transport_test

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// mustExec runs one INSERT ... RETURNING id::text.
func mustExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	var id string
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
		t.Fatalf("seed query %q failed: %v", firstLine(sql), err)
	}
	return id
}

// mustExecNoReturn runs a mutating seed statement.
func mustExecNoReturn(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatalf("seed exec %q failed: %v", firstLine(sql), err)
	}
}

// countOf returns a scalar count for assertions.
func countOf(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count query %q failed: %v", firstLine(sql), err)
	}
	return n
}

func firstLine(sql string) string {
	if idx := strings.IndexByte(sql, '\n'); idx >= 0 {
		return strings.TrimSpace(sql[:idx])
	}
	return strings.TrimSpace(sql)
}

// randToken mints a random lowercase token (uniqueness for seeded handles).
func randToken(t *testing.T) string {
	t.Helper()
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("rand: %v", err)
	}
	return hex.EncodeToString(buf)
}

// slug renders a per-test unique, URL/SQL-safe suffix that is STABLE within
// one test's lifetime: the same t.Name() hashes to the same suffix on every
// call, so a test can build "the same" email/username twice when it asserts
// a uniqueness refusal (uniqueness across tests rides the test name).
func slug(t *testing.T) string {
	t.Helper()
	name := t.Name()
	var b strings.Builder
	for _, c := range name {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteRune(c)
		case c >= 'A' && c <= 'Z':
			b.WriteRune(c - 'A' + 'a')
		default:
			b.WriteByte('-')
		}
	}
	sum := sha256.Sum256([]byte(name))
	return strings.Trim(b.String(), "-")[:12] + "-" + hex.EncodeToString(sum[:])[:8]
}

func sha256Hex(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// unusableHash is the seeded users' password_hash: an unusable verifier (no
// plaintext path exists on this kernel — SPEC §34).
func unusableHash(t *testing.T) string {
	t.Helper()
	return "unusable:" + infra.RandomHex(32)
}
