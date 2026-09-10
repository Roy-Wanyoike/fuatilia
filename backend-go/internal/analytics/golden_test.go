package analytics

import (
	"context"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Golden-file SQL snapshot tests: the exact (statement, args) pairs a
// canonical event stream produces, snapshotted in testdata/golden/ so every
// SQL change is a reviewed diff (no ClickHouse server exists in this
// environment — the fake driver implements the SQL-string contract and this
// test pins its output).
//
// Regenerate with:
//
//      go test ./internal/analytics -run TestSQLGoldenFiles -update

var goldenUpdate = flag.Bool("update", false, "rewrite the golden files")

func TestSQLGoldenFiles(t *testing.T) {
	// The canonical scenario, one batch, canonical order — the reference
	// batching the determinism test proves is byte-stable across fresh
	// replays. The snapshot therefore covers: the event_fact ledger
	// inserts (verbatim payloads, canonical per-org order, orgs sorted),
	// every projection upsert (full-state re-emission, days ascending,
	// currencies sorted, buckets in AGING_BUCKETS order, cohorts by month
	// then currency then point) and their exact bound parameters, plus
	// the rebuild replay (the only Query the lane issues) and the final
	// collapsed projection state.
	ing, driver := newIngester(t, scenarioBatches())
	if _, err := ing.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if _, err := ing.RebuildFromLedger(context.Background()); err != nil {
		t.Fatalf("RebuildFromLedger: %v", err)
	}

	got := driver.statementLog() + "\n-- final projection state --\n" + driver.projectionState()

	path := filepath.Join("testdata", "golden", "canonical_stream.golden")
	if *goldenUpdate {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden (run with -update to write it): %v", err)
	}
	if string(want) != got {
		t.Fatalf("SQL log drifted from the golden file (a SQL or emission change is a reviewed diff); first divergence:\n%s", firstDivergence(string(want), got))
	}
}

// TestSQLGoldenFilesDeterministic proves the snapshot input itself is
// stable: two fresh ingesters replaying the same stream produce the same
// statement log byte-for-byte (the golden file would be useless otherwise).
func TestSQLGoldenFilesDeterministic(t *testing.T) {
	run := func() string {
		ing, driver := newIngester(t, scenarioBatches())
		if _, err := ing.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
			t.Fatalf("IngestBatch: %v", err)
		}
		return driver.statementLog()
	}
	if a, b := run(), run(); a != b {
		t.Fatal("two identical replays produced different SQL logs — emission order is non-deterministic")
	}
}

// TestSQLContractStatementsAreParameterized is the injection guard the
// Driver port promises: values only ever travel as parameters — the
// statement text is the fixed contract constant, so no payload byte can
// land in a statement string.
func TestSQLContractStatementsAreParameterized(t *testing.T) {
	ing, driver := newIngester(t, scenarioBatches())
	if _, err := ing.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	contract := map[string]bool{
		SQLInsertEventFact:              true,
		SQLInsertDSODaily:               true,
		SQLInsertAgingMigration:         true,
		SQLInsertCollectorEffectiveness: true,
		SQLInsertCohortRecovery:         true,
		LedgerSelectSQL:                 true,
	}
	firstBatch := scenarioBatches()[0]
	for _, s := range driver.stmts {
		if !contract[s.query] {
			t.Errorf("statement issued outside the SQL contract: %q", s.query)
			continue
		}
		if s.query != LedgerSelectSQL && !strings.Contains(s.query, "VALUES (?, ") && !strings.HasSuffix(s.query, "VALUES (?)") {
			t.Errorf("INSERT is not a pure placeholder VALUES tail: %q", s.query)
		}
		// No payload byte ever appears in the statement text.
		for _, raw := range firstBatch {
			env := mustParseEnvelope(t, raw)
			if strings.Contains(s.query, string(env.Payload)) {
				t.Errorf("payload bytes leaked into statement text: %q", s.query)
			}
		}
	}
}

// firstDivergence renders the first differing line pair of two logs.
func firstDivergence(want, got string) string {
	wantLines := strings.Split(want, "\n")
	gotLines := strings.Split(got, "\n")
	for i := 0; i < len(wantLines) || i < len(gotLines); i++ {
		var w, g string
		if i < len(wantLines) {
			w = wantLines[i]
		}
		if i < len(gotLines) {
			g = gotLines[i]
		}
		if w != g {
			return fmtLine("golden", i+1, w) + "\n" + fmtLine("got", i+1, g)
		}
	}
	return "no divergence found"
}

func fmtLine(which string, n int, line string) string {
	return which + " line " + strconv.Itoa(n) + ": " + line
}
