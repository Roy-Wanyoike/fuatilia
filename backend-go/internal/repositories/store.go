// Package repositories is the pgx-backed persistence surface of the /v1 API
// kernel (issue #72): every store runs parameterized SQL over the
// db/migrations schema (0001–0014), filters by org_id on EVERY query and
// joins the caller's transaction when one is open — transactional boundaries
// belong to the application services (infra.Querier accepts *pgxpool.Pool,
// pgxpool.Conn and pgx.Tx alike).
package repositories

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Querier aliases the infra SQL surface so callers stay decoupled from pgx.
type Querier = infra.Querier

// UniqueViolation reports whether err is a PostgreSQL unique-index violation
// (the DDL face of the domain's first-write-wins / exclusivity refusals).
func UniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	return false
}

// CheckViolation reports whether err is a PostgreSQL CHECK-constraint
// violation (the DDL face of a domain invariant the schema encodes).
func CheckViolation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "23514"
	}
	return false
}

// ConstraintName digs the violated constraint name out of a pg error (""
// when err is not one) — the caller maps it to a stable domain code.
func ConstraintName(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.ConstraintName
	}
	return ""
}

// Stores is the composition root of every pgx-backed store. The pool is the
// only PostgreSQL surface the kernel owns.
type Stores struct {
	Pool *pgxpool.Pool
}

// RunInTx runs fn inside one transaction whose commit is the atomic boundary
// of the command (state change + outbox facts + audit facts + ledger rows
// commit together). fn receiving a non-tx Querier is a programming error —
// the command paths deliberately take pgx.Tx so a bare pool cannot sneak in.
func (s *Stores) RunInTx(ctx context.Context, fn func(tx pgx.Tx) error) error {
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(ctx)
		return err
	}
	return tx.Commit(ctx)
}

// nullTime renders an optional timestamp (nil → SQL NULL).
func nullTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

// nullText renders an optional string ("" → SQL NULL).
func nullText(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// isoTime is the wire timestamp layout the TS reference emits
// (Date.toISOString — millisecond precision, Z suffix).
const isoTime = "2006-01-02T15:04:05.000Z07:00"

// ISO renders t the way the TS reference does (ISO-8601, milliseconds).
func ISO(t time.Time) string { return t.UTC().Format(isoTime) }

// ISOPtr renders an optional timestamp (nil → nil).
func ISOPtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := ISO(*t)
	return &s
}

// scanErr wraps a row-scan failure with the query context; "no rows"
// becomes ErrNotFound (with pgx.ErrNoRows preserved in the chain) so the
// application layer's errors.Is checks hold regardless of which lookup
// raised it.
func scanErr(what string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("repositories: %s: %w", what, fmt.Errorf("%w (%w)", ErrNotFound, pgx.ErrNoRows))
	}
	return fmt.Errorf("repositories: %s: %w", what, err)
}
