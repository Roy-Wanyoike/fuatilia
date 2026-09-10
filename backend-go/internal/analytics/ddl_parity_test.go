package analytics

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// DDL parity: the SQL-string contract (sql.go) is the only writer, and
// db/clickhouse/*.sql is the only schema — this test fails the gate when the
// two drift apart, without needing a ClickHouse server (no such server exists
// in this environment; see db/clickhouse/README.md "Honesty notes").

// ddlDir locates <repo>/db/clickhouse relative to this test file.
func ddlDir(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// internal/analytics/<test>.go → repo root is three levels up.
	dir := filepath.Dir(thisFile)
	for i := 0; i < 3; i++ {
		dir = filepath.Dir(dir)
	}
	return filepath.Join(dir, "db", "clickhouse")
}

// ddlTable is the parsed shape of one CREATE TABLE statement.
type ddlTable struct {
	name            string
	file            string
	columns         []string // declared order
	orderBy         string   // the ORDER BY clause text, normalized
	engine          string
	labelHasDefault bool
}

// parseDDL extracts every CREATE TABLE IF NOT EXISTS statement from the
// lane's DDL files (file-number order). It understands exactly the dialect
// subset the lane writes: column lines `name Type ...`, an ENGINE line and
// an ORDER BY line after the column block.
func parseDDL(t *testing.T, dir string) []ddlTable {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		t.Fatalf("glob ddl: %v", err)
	}
	if len(files) == 0 {
		t.Fatalf("no DDL files found in %s", dir)
	}
	var tables []ddlTable
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		text := string(raw)
		idx := strings.Index(text, "CREATE TABLE IF NOT EXISTS ")
		for idx >= 0 {
			rest := text[idx+len("CREATE TABLE IF NOT EXISTS "):]
			end := strings.Index(rest, ";")
			if end < 0 {
				t.Fatalf("%s: unterminated CREATE TABLE", file)
			}
			stmt := rest[:end]
			tables = append(tables, parseCreateTable(t, file, stmt))
			text = rest[end:]
			idx = strings.Index(text, "CREATE TABLE IF NOT EXISTS ")
		}
	}
	return tables
}

func parseCreateTable(t *testing.T, file, stmt string) ddlTable {
	t.Helper()
	tbl := ddlTable{file: filepath.Base(file)}
	open := strings.Index(stmt, "(")
	if open < 0 {
		t.Fatalf("%s: malformed CREATE TABLE: %q", file, stmt)
	}
	tbl.name = strings.TrimSpace(stmt[:open])
	// The column block ends at the paren that MATCHES the opening one —
	// not the last paren in the statement (the ENGINE/ORDER BY clauses
	// carry their own).
	depth := 1
	close := -1
	for i := open + 1; i < len(stmt); i++ {
		switch stmt[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				close = i
			}
		}
		if close >= 0 {
			break
		}
	}
	if close < 0 {
		t.Fatalf("%s: unterminated column block: %q", file, stmt)
	}
	body := stmt[open+1 : close]

	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(line), ","))
		if line == "" || strings.HasPrefix(line, "--") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		tbl.columns = append(tbl.columns, fields[0])
		if fields[0] == "label" && strings.Contains(line, "DEFAULT 'derived_from_events'") {
			tbl.labelHasDefault = true
		}
	}

	tail := stmt[close+1:]
	for _, line := range strings.Split(tail, "\n") {
		line = normalizeSpace(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(line, "ENGINE"):
			engine := strings.TrimSpace(strings.TrimPrefix(line, "ENGINE"))
			engine = strings.TrimSpace(strings.TrimPrefix(engine, "="))
			tbl.engine = engine
		case strings.HasPrefix(line, "ORDER BY"):
			tbl.orderBy = normalizeSpace(strings.TrimPrefix(line, "ORDER BY"))
		}
	}
	return tbl
}

// insertColumns parses the column list out of one contract INSERT.
func insertColumns(t *testing.T, stmt string) []string {
	t.Helper()
	open := strings.Index(stmt, "(")
	close := strings.Index(stmt, ")")
	if open < 0 || close < open {
		t.Fatalf("malformed contract INSERT: %q", stmt)
	}
	var cols []string
	for _, c := range strings.Split(stmt[open+1:close], ",") {
		cols = append(cols, strings.TrimSpace(c))
	}
	return cols
}

// insertTable parses the target table of one contract INSERT.
func insertTable(stmt string) string {
	rest := strings.TrimPrefix(stmt, "INSERT INTO ")
	return strings.Fields(rest)[0]
}

// placeholderCount counts the ? markers in the VALUES tail.
func placeholderCount(t *testing.T, stmt string) int {
	t.Helper()
	i := strings.Index(stmt, "VALUES (")
	if i < 0 {
		t.Fatalf("contract INSERT has no VALUES tail: %q", stmt)
	}
	return strings.Count(stmt[i:], "?")
}

func normalizeSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// contractInserts maps table → contract statement (sql.go). Adding a table
// or statement here is deliberate and reviewed.
func contractInserts() map[string]string {
	return map[string]string{
		TableEventFact:              SQLInsertEventFact,
		TableDSODaily:               SQLInsertDSODaily,
		TableAgingMigration:         SQLInsertAgingMigration,
		TableCollectorEffectiveness: SQLInsertCollectorEffectiveness,
		TableCohortRecovery:         SQLInsertCohortRecovery,
	}
}

// wantOrderBy pins each table's ORDER BY to the dashboard scans documented
// in the DDL headers — a key change must be a reviewed DDL diff.
func wantOrderBy() map[string]string {
	return map[string]string{
		TableEventFact:              "(org_id, event_id)",
		TableDSODaily:               "(org_id, currency, day)",
		TableAgingMigration:         "(org_id, currency, day, bucket)",
		TableCollectorEffectiveness: "(org_id, currency, window_end, collector_id)",
		TableCohortRecovery:         "(org_id, currency, cohort_month, days_since_open)",
	}
}

func TestDDLParityWithSQLContract(t *testing.T) {
	tables := parseDDL(t, ddlDir(t))

	gotByName := map[string]ddlTable{}
	for _, tbl := range tables {
		if _, dup := gotByName[tbl.name]; dup {
			t.Errorf("duplicate CREATE TABLE for %s", tbl.name)
		}
		gotByName[tbl.name] = tbl
	}

	for table, stmt := range contractInserts() {
		tbl, ok := gotByName[table]
		if !ok {
			t.Errorf("contract writes table %s but the DDL does not create it", table)
			continue
		}
		// Column names AND order must match exactly (the INSERT column
		// list is the wire shape of every row).
		wantCols := insertColumns(t, stmt)
		if len(wantCols) != len(tbl.columns) {
			t.Errorf("table %s: DDL has %d columns, contract INSERT has %d\nddl:  %v\nsql:  %v",
				table, len(tbl.columns), len(wantCols), tbl.columns, wantCols)
			continue
		}
		for i, col := range wantCols {
			if tbl.columns[i] != col {
				t.Errorf("table %s: column %d is %q in the contract INSERT but %q in the DDL",
					table, i, col, tbl.columns[i])
			}
		}
		// Every bound parameter has a column and vice versa.
		if n := placeholderCount(t, stmt); n != len(wantCols) {
			t.Errorf("table %s: INSERT binds %d placeholders for %d columns", table, n, len(wantCols))
		}
		// Engine + key honesty.
		if tbl.engine != "ReplacingMergeTree(computed_at)" {
			t.Errorf("table %s: ENGINE = %q, want ReplacingMergeTree(computed_at) (the deterministic fold-win contract)", table, tbl.engine)
		}
		if want := wantOrderBy()[table]; tbl.orderBy != want {
			t.Errorf("table %s: ORDER BY = %s, want %s (the documented dashboard scan)", table, tbl.orderBy, want)
		}
		// Labeling discipline is enforced at the storage layer.
		if !tbl.labelHasDefault {
			t.Errorf("table %s: label column must DEFAULT 'derived_from_events' (REAL-labels)", table)
		}
	}
}

// TestDDLCoversExactlyTheContractTables guards against a table added on one
// side only.
func TestDDLCoversExactlyTheContractTables(t *testing.T) {
	tables := parseDDL(t, ddlDir(t))
	got := map[string]bool{}
	for _, tbl := range tables {
		got[tbl.name] = true
	}
	for table := range contractInserts() {
		if !got[table] {
			t.Errorf("contract table %s missing from the DDL", table)
		}
	}
	if want, gotN := len(contractInserts()), len(tables); gotN != want {
		t.Errorf("DDL declares %d tables, contract covers %d — both sides must agree", gotN, want)
	}
}

// TestDDLZeroSecrets is the honesty scan: no connection strings, hosts,
// users or credentials anywhere in the lane's DDL (issue #89: "zero
// connection strings / secrets").
func TestDDLZeroSecrets(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(ddlDir(t), "*.sql"))
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		text := strings.ToLower(string(raw))
		for _, banned := range []string{"postgres://", "postgresql://", "clickhouse://", "http://", "https://", "password=", "password:", "secret=", "secret:", "apikey", "api_key=", "127.0.0.1", "localhost"} {
			if strings.Contains(text, banned) {
				t.Errorf("%s contains banned token %q — the DDL must carry zero connection knowledge", filepath.Base(file), banned)
			}
		}
	}
}

// TestSQLContractZeroSecrets applies the same scan to the Go contract.
func TestSQLContractZeroSecrets(t *testing.T) {
	for _, stmt := range contractInserts() {
		text := strings.ToLower(stmt)
		for _, banned := range []string{"postgres://", "clickhouse://", "password", "secret", "localhost"} {
			if strings.Contains(text, banned) {
				t.Errorf("contract statement contains banned token %q: %q", banned, stmt)
			}
		}
	}
}
