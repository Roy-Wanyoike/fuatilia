package infra_test

// Pool-reconnect proof (issue #72 failure requirements): after PostgreSQL
// itself stops and starts again, the kernel's pgx pool recovers and serves
// queries without a process restart. The test provisions a PRIVATE portable
// cluster (pgtest.StartTemp) so it can own the server lifecycle; an
// unreachable cluster FAILS the run — the honest-boot rule admits no skips.

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
)

func TestPoolReconnectsAfterServerRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cluster, stop, err := pgtest.StartTemp(ctx)
	if err != nil {
		t.Fatalf("pgtest: provision private cluster: %v", err)
	}
	t.Cleanup(stop)

	pool, err := pgxpool.New(ctx, cluster.DSN(pgtest.SharedDBName))
	if err != nil {
		t.Fatalf("pgxpool: %v", err)
	}
	t.Cleanup(pool.Close)

	var one int
	if err := pool.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		t.Fatalf("pre-restart query: one=%d err=%v", one, err)
	}

	// take PostgreSQL DOWN (the pool's connections die with it)
	if err := cluster.Stop(context.Background()); err != nil {
		t.Fatalf("pg_ctl stop: %v", err)
	}

	// bring it back on the same data dir — migrations and rows survive
	if err := cluster.Start(context.Background()); err != nil {
		t.Fatalf("pg_ctl start: %v", err)
	}

	// the SAME pool serves a fresh query: pgxpool discards the dead
	// connections and dials replacements — no kernel restart involved
	retryCtx, retryCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer retryCancel()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var two int
		qErr := pool.QueryRow(retryCtx, `SELECT 1 + 1`).Scan(&two)
		if qErr == nil && two == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pool did not reconnect after server restart: last error %v", qErr)
		}
		time.Sleep(250 * time.Millisecond)
	}
}
