package webhooks

// Integration-test backend — REAL PostgreSQL 16.4 on a PRIVATE ephemeral
// cluster (internal/infra/pgtest.StartTemp, db/migrations 0001–0014 applied),
// exactly the honest-boot discipline of the transport and outbox lanes:
// unreachable PostgreSQL or missing portable binaries fail the run, they
// never silently skip (the merge gate includes booting the cluster). A
// private cluster keeps this package's tests isolated from sibling lanes
// sharing the port-5435 cluster, even under `go test ./... -race`, which
// runs packages in parallel.

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
)

// pg is the package's private, fully migrated PostgreSQL 16.4 cluster.
var pg *pgtest.Cluster

func TestMain(m *testing.M) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cluster, stop, err := pgtest.StartTemp(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "webhooks test bootstrap: %v\n", err)
		os.Exit(1)
	}
	pg = cluster
	code := m.Run()
	stop()
	os.Exit(code)
}

// testPool returns a pool over the private cluster with a clean lane state:
// every test truncates the org-rooted graph (webhook_endpoints,
// webhook_deliveries and everything else CASCADEs from orgs) after itself —
// tests never leak rows into each other.
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), pg.DSN(pgtest.SharedDBName))
	if err != nil {
		t.Fatalf("connect webhooks test pool: %v", err)
	}
	t.Cleanup(pool.Close) // registered first so the truncate below runs before the pool closes

	truncate := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := pool.Exec(ctx, `TRUNCATE audit_events, orgs CASCADE`); err != nil {
			t.Fatalf("truncate lane tables: %v", err)
		}
	}
	t.Cleanup(truncate)
	return pool
}
