package infra_test

// Concurrency + append-only proofs for the tamper-evident audit chain writer
// (internal/infra/audit.go, issue #179): parallel AppendAuditEvent calls to
// ONE org must serialize into a gapless per-org sequence — no sequence
// collisions, no gaps, hash chain unbroken end to end — under BOTH org
// states the writer knows (org-scoped denials and the pre-authentication
// NULL-org branch the bindable probe split introduced), and the §37
// append-only trigger must still refuse any edit or deletion of appended
// rows.
//
// Honest boot: a PRIVATE pgtest.StartTemp cluster (fresh initdb, migrations
// applied from scratch — which also proves the suite applies clean at the
// current file count), the restart-lane discipline. The shared :5435 lane
// cluster belongs to the transport tests; this suite must never truncate
// under their feet.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
)

const (
	auditWorkers      = 16 // appends issued concurrently per phase
	auditAppendsEach  = 25 // per worker — every goroutine fights for the same chain head
	auditRowsPerPhase = auditWorkers * auditAppendsEach
)

var (
	auditClusterOnce sync.Once
	auditCluster     *pgtest.Cluster
	auditClusterStop func()
	auditClusterErr  error
)

func TestMain(m *testing.M) {
	code := m.Run()
	if auditClusterStop != nil {
		auditClusterStop()
	}
	os.Exit(code)
}

// requireAuditCluster boots the file's private, fully migrated cluster once.
func requireAuditCluster(t *testing.T) *pgtest.Cluster {
	t.Helper()
	auditClusterOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		auditCluster, auditClusterStop, auditClusterErr = pgtest.StartTemp(ctx)
	})
	if auditClusterErr != nil {
		t.Fatalf("pgtest: provision private audit cluster (the merge gate includes REAL PostgreSQL): %v", auditClusterErr)
	}
	return auditCluster
}

// auditTestPool returns a pool over the private cluster with enough
// connections for the parallel phase and a clean lane state: the lane tables
// are truncated before AND after the test (TRUNCATE bypasses the row-level
// append-only trigger — it is the same cleanup pgtest.TruncateAll uses).
func auditTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	cluster := requireAuditCluster(t)
	ctx := context.Background()

	cfg, err := pgxpool.ParseConfig(cluster.DSN(pgtest.SharedDBName))
	if err != nil {
		t.Fatalf("pgxpool: parse config: %v", err)
	}
	cfg.MaxConns = int32(auditWorkers + 4) // every worker holds one append at a time
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("pgxpool: connect audit test pool: %v", err)
	}
	t.Cleanup(pool.Close)

	truncate := func() {
		truncCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := pool.Exec(truncCtx, `TRUNCATE audit_events, orgs CASCADE`); err != nil {
			t.Fatalf("truncate audit lane tables: %v", err)
		}
	}
	truncate()
	t.Cleanup(truncate)
	return pool
}

// auditEventSpec is one planned append: the event plus the exact payload JSON
// the writer will marshal (captured before the race so the chain verification
// recomputes hashes from byte-identical canonical input).
type auditEventSpec struct {
	event       infra.AuditEvent
	payloadJSON string
}

// planAuditEvents builds the append plan for one phase. The (worker, step)
// pair is encoded in the action string, so every appended row can be matched
// back to its plan entry after the storm reshuffles the sequence order.
func planAuditEvents(t *testing.T, prefix, orgID string) []auditEventSpec {
	t.Helper()
	specs := make([]auditEventSpec, auditRowsPerPhase)
	for g := 0; g < auditWorkers; g++ {
		for i := 1; i <= auditAppendsEach; i++ {
			payload := map[string]any{"lane": "audit-concurrency", "step": i, "worker": g}
			raw, err := json.Marshal(payload)
			if err != nil {
				t.Fatalf("marshal audit payload: %v", err)
			}
			idx := g*auditAppendsEach + (i - 1)
			specs[idx] = auditEventSpec{
				event: infra.AuditEvent{
					Action:     fmt.Sprintf("%s.w%02d.s%03d", prefix, g, i),
					ActorType:  "api",
					ActorID:    fmt.Sprintf("worker-%02d", g), // non-empty: the hash canonical uses the raw id, the column must echo it
					Resource:   "audit",
					ResourceID: infra.NewUUID(),
					Payload:    payload,
					Reason:     "NO_GRANT",
					OccurredAt: time.Now().UTC(),
					OrgID:      orgID,
				},
				payloadJSON: string(raw),
			}
		}
	}
	return specs
}

// runParallelAppends fires the whole plan at the chain concurrently. Workers
// that hit an error stop early and record it — the caller fails on any.
func runParallelAppends(t *testing.T, ctx context.Context, pool *pgxpool.Pool, specs []auditEventSpec) {
	t.Helper()
	errs := make([]error, len(specs))
	var wg sync.WaitGroup
	for g := 0; g < auditWorkers; g++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 1; i <= auditAppendsEach; i++ {
				idx := worker*auditAppendsEach + (i - 1)
				if err := infra.AppendAuditEvent(ctx, pool, specs[idx].event); err != nil {
					errs[idx] = fmt.Errorf("worker %d step %d: %w", worker, i, err)
					return
				}
			}
		}(g)
	}
	wg.Wait()
	for idx, err := range errs {
		if err != nil {
			t.Fatalf("parallel append failed (idx %d, action %s): %v", idx, specs[idx].event.Action, err)
		}
	}
}

// verifyChain fetches one org state's rows in seq order and proves the
// append-only guarantees the unique index + advisory lock are meant to give:
// gapless 1..N sequence (no collisions, no holes), prev_hash linkage and
// byte-exact hash recomputation over the canonical serialization.
func verifyChain(t *testing.T, ctx context.Context, pool *pgxpool.Pool, specs []auditEventSpec, scopeSQL string, scopeArgs ...any) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT seq, actor_type, actor_id, action, resource, COALESCE(resource_id, ''), prev_hash, hash
                FROM audit_events WHERE `+scopeSQL+` ORDER BY seq`, scopeArgs...)
	if err != nil {
		t.Fatalf("fetch appended rows: %v", err)
	}
	defer rows.Close()

	byAction := make(map[string]auditEventSpec, len(specs))
	for _, spec := range specs {
		byAction[spec.event.Action] = spec
	}

	type row struct {
		seq        int64
		actorType  string
		actorID    string
		action     string
		resource   string
		resourceID string
		prevHash   string
		hash       string
	}
	var got []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.seq, &r.actorType, &r.actorID, &r.action, &r.resource, &r.resourceID, &r.prevHash, &r.hash); err != nil {
			t.Fatalf("scan appended row: %v", err)
		}
		got = append(got, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate appended rows: %v", err)
	}

	if len(got) != len(specs) {
		t.Fatalf("appended %d rows, want %d (lost or duplicated appends)", len(got), len(specs))
	}
	for i, r := range got {
		if r.seq != int64(i+1) {
			t.Fatalf("sequence collision/gap: position %d holds seq %d, want %d (rows must be exactly 1..N)", i, r.seq, i+1)
		}
		wantPrev := "0000000000000000000000000000000000000000000000000000000000000000"
		if i > 0 {
			wantPrev = got[i-1].hash
		}
		if r.prevHash != wantPrev {
			t.Fatalf("chain broken at seq %d: prev_hash = %s, want previous row's hash %s", r.seq, r.prevHash, wantPrev)
		}
		spec, ok := byAction[r.action]
		if !ok {
			t.Fatalf("row at seq %d has action %q which no planned append used (unexpected/foreign row)", r.seq, r.action)
		}
		e := spec.event
		if r.actorType != e.ActorType || r.actorID != e.ActorID || r.resource != e.Resource || r.resourceID != e.ResourceID {
			t.Fatalf("row at seq %d does not match its planned event: got (%s/%s/%s/%s), want (%s/%s/%s/%s)",
				r.seq, r.actorType, r.actorID, r.resource, r.resourceID, e.ActorType, e.ActorID, e.Resource, e.ResourceID)
		}
		wantHash := infra.AuditChainHash(r.seq, e.OrgID, r.actorType, r.actorID, r.action, r.resource, r.resourceID, spec.payloadJSON, r.prevHash)
		if r.hash != wantHash {
			t.Fatalf("hash mismatch at seq %d: stored %s, recomputed %s (chain hash canonical drifted)", r.seq, r.hash, wantHash)
		}
	}
}

// TestAuditAppendParallelAppendsUpholdPerOrgSequence is the issue #179
// acceptance proof: storm ONE org's chain from 16 goroutines (and the
// pre-authentication NULL-org branch the same way) — every append must
// succeed, the sequence must come out exactly 1..N per state with no
// collisions, and the hash chain must be intact row to row.
func TestAuditAppendParallelAppendsUpholdPerOrgSequence(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	pool := auditTestPool(t)

	orgID := func() string {
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`,
			"Audit Concurrency Org", "audit-concurrency").Scan(&id); err != nil {
			t.Fatalf("seed org: %v", err)
		}
		return id
	}()

	// Phase A — org-scoped denials: org_id = $1 probe, unique index enforces
	// (org_id, seq).
	orgSpecs := planAuditEvents(t, "auditconc.org", orgID)
	runParallelAppends(t, ctx, pool, orgSpecs)
	verifyChain(t, ctx, pool, orgSpecs, `org_id = $1`, orgID)

	// Phase B — pre-authentication denials: org_id IS NULL probe. NULLs are
	// distinct to uq_audit_events_org_seq, so contiguity here is carried by
	// the per-org advisory lock alone — exactly the guarantee that must
	// survive the query-shape change.
	nullSpecs := planAuditEvents(t, "auditconc.null", "")
	runParallelAppends(t, ctx, pool, nullSpecs)
	verifyChain(t, ctx, pool, nullSpecs, `org_id IS NULL`)
}

// TestAuditAppendOnlyTriggerStillGuardsTheChain pins the §37 invariant the
// brief calls out: the rewrite touches only the READ shape — the append-only
// guard trigger must still refuse UPDATE and DELETE on appended rows, and the
// refused statement must leave the row untouched.
func TestAuditAppendOnlyTriggerStillGuardsTheChain(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pool := auditTestPool(t)

	var orgID string
	if err := pool.QueryRow(ctx, `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`,
		"Audit Append-Only Org", "audit-append-only").Scan(&orgID); err != nil {
		t.Fatalf("seed org: %v", err)
	}

	if err := infra.AppendAuditEvent(ctx, pool, infra.AuditEvent{
		Action:     "audit.appendOnly.probe",
		ActorType:  "system",
		ActorID:    "probe",
		Resource:   "audit",
		ResourceID: infra.NewUUID(),
		Reason:     "NO_GRANT",
		OccurredAt: time.Now().UTC(),
		OrgID:      orgID,
	}); err != nil {
		t.Fatalf("append audit event: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE audit_events SET reason = 'tampered' WHERE org_id = $1`, orgID); err == nil {
		t.Fatalf("UPDATE on audit_events succeeded — §37 append-only guard regressed")
	} else if !strings.Contains(err.Error(), "AUDIT_APPEND_ONLY") {
		t.Fatalf("UPDATE refused with unexpected error: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM audit_events WHERE org_id = $1`, orgID); err == nil {
		t.Fatalf("DELETE on audit_events succeeded — §37 append-only guard regressed")
	} else if !strings.Contains(err.Error(), "AUDIT_APPEND_ONLY") {
		t.Fatalf("DELETE refused with unexpected error: %v", err)
	}

	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE org_id = $1 AND reason = 'NO_GRANT'`, orgID).Scan(&rows); err != nil {
		t.Fatalf("count rows after refused edits: %v", err)
	}
	if rows != 1 {
		t.Fatalf("refused edits mutated the chain: %d rows still carrying the original reason, want the 1 untouched append", rows)
	}
}
