package analytics

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The fake Driver: an in-memory implementation of the SQL-string contract
// (ports.go). It is the only ClickHouse stand-in this lane tests against —
// no ClickHouse server exists in this environment — so it implements the
// contract honestly:
//
//   - Exec accepts ONLY the five INSERT statements this lane defines
//     (sql.go); anything else is a contract violation and fails the test.
//   - The event_fact insert is applied to an in-memory ledger keyed by
//     (org, event) — ReplacingMergeTree collapse semantics.
//   - Projection inserts are applied as upserts keyed by the table's
//     ORDER BY key, last-write-wins — the deterministic face of
//     ReplacingMergeTree(computed_at) background merges for this test.
//   - Query accepts ONLY LedgerSelectSQL and replays the ledger in exactly
//     the canonical order the SQL declares (org_id, created_at, event_id).
//
// Every accepted statement (query + args) is recorded verbatim; the golden
// files (golden_test.go) snapshot that log, and the determinism tests
// compare final row state across replays.
type fakeDriver struct {
	mu       sync.Mutex
	stmts    []fakeStmt                  // every accepted Exec, in order
	ledger   map[string]ledgerRow        // (org\x00event) → row
	projRows map[string]map[string][]any // table → rendered key → args (last write wins)
	queries  []string                    // every Query issued (must all be LedgerSelectSQL)
	execErr  error                       // when set, Exec fails with this error
	queryErr error                       // when set, Query fails with this error
}

type fakeStmt struct {
	query string
	args  []any
}

type ledgerRow struct {
	orgID     string
	eventID   string
	name      string
	version   int64
	createdAt time.Time
	payload   string
}

func newFakeDriver() *fakeDriver {
	return &fakeDriver{
		ledger:   map[string]ledgerRow{},
		projRows: map[string]map[string][]any{},
	}
}

// projectionKeys maps each projection table to its ORDER BY key column
// indexes in the INSERT column list (the parity test pins the column
// order; these indexes are stated against that order).
var projectionKeys = map[string][]int{
	TableDSODaily:               {0, 1, 2},    // org_id, currency, day
	TableAgingMigration:         {0, 1, 2, 3}, // org_id, currency, day, bucket
	TableCollectorEffectiveness: {0, 1, 3, 4}, // org_id, currency, window_end, collector_id
	TableCohortRecovery:         {0, 1, 2, 3}, // org_id, currency, cohort_month, days_since_open
}

func (f *fakeDriver) Exec(_ context.Context, query string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.execErr != nil {
		return f.execErr
	}
	switch {
	case query == SQLInsertEventFact:
		row := ledgerRow{
			orgID:     args[0].(string),
			eventID:   args[1].(string),
			name:      args[2].(string),
			version:   args[3].(int64),
			createdAt: args[4].(time.Time),
			payload:   args[5].(string),
		}
		// ReplacingMergeTree((org_id, event_id)) collapse: same key →
		// keep the newer computed_at (= created_at here).
		key := row.orgID + "\x00" + row.eventID
		if old, ok := f.ledger[key]; !ok || row.createdAt.After(old.createdAt) {
			f.ledger[key] = row
		}
	case strings.HasPrefix(query, "INSERT INTO "):
		table := strings.Fields(strings.TrimPrefix(query, "INSERT INTO "))[0]
		keyIdx, ok := projectionKeys[table]
		if !ok {
			return errf(CodeDriverContractInvalid, "fake driver: no key contract for table %s", table)
		}
		parts := make([]string, 0, len(keyIdx))
		for _, i := range keyIdx {
			parts = append(parts, renderArg(args[i]))
		}
		key := strings.Join(parts, "\x00")
		if f.projRows[table] == nil {
			f.projRows[table] = map[string][]any{}
		}
		f.projRows[table][key] = append([]any(nil), args...) // last write wins
	default:
		return errf(CodeDriverContractInvalid, "fake driver: statement is not part of the SQL contract: %q", query)
	}
	f.stmts = append(f.stmts, fakeStmt{query: query, args: append([]any(nil), args...)})
	return nil
}

func (f *fakeDriver) Query(_ context.Context, query string, args ...any) (Rows, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	if query != LedgerSelectSQL {
		return nil, errf(CodeProjQueryUnsupported, "fake driver: the only supported query is LedgerSelectSQL, got %q", query)
	}
	if len(args) != 0 {
		return nil, errf(CodeDriverContractInvalid, "fake driver: LedgerSelectSQL takes no parameters, got %d", len(args))
	}
	f.queries = append(f.queries, query)
	rows := make([]ledgerRow, 0, len(f.ledger))
	for _, r := range f.ledger {
		rows = append(rows, r)
	}
	// The canonical order the SQL declares: org_id, created_at, event_id.
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].orgID != rows[j].orgID {
			return rows[i].orgID < rows[j].orgID
		}
		if !rows[i].createdAt.Equal(rows[j].createdAt) {
			return rows[i].createdAt.Before(rows[j].createdAt)
		}
		return rows[i].eventID < rows[j].eventID
	})
	return &fakeRows{rows: rows}, nil
}

// fakeRows is the ledger replay cursor.
type fakeRows struct {
	rows []ledgerRow
	i    int
	err  error
}

func (r *fakeRows) Next() bool { return r.i < len(r.rows) }

func (r *fakeRows) Scan(dest ...any) error {
	if r.i >= len(r.rows) {
		return errf(CodeDriverContractInvalid, "fake driver: Scan past end of rows")
	}
	row := r.rows[r.i]
	if len(dest) != 6 {
		return errf(CodeDriverContractInvalid, "fake driver: Scan needs exactly 6 destinations, got %d", len(dest))
	}
	*(dest[0].(*string)) = row.orgID
	*(dest[1].(*string)) = row.eventID
	*(dest[2].(*string)) = row.name
	*(dest[3].(*int64)) = row.version
	*(dest[4].(*time.Time)) = row.createdAt
	*(dest[5].(*string)) = row.payload
	return nil
}

func (r *fakeRows) Close() error { return nil }
func (r *fakeRows) Err() error   { return r.err }

// statementLog renders every recorded Exec as the golden-file text: one
// numbered block per statement — the SQL line, then one indented line per
// argument in positional order. Deterministic by construction (the log is
// append-only).
func (f *fakeDriver) statementLog() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var b strings.Builder
	for i, s := range f.stmts {
		fmt.Fprintf(&b, "exec %03d: %s\n", i+1, s.query)
		for _, arg := range s.args {
			fmt.Fprintf(&b, "    %s\n", renderArg(arg))
		}
	}
	return b.String()
}

// projectionState renders the final upserted row state of every projection
// table (key-sorted) — the value the determinism tests compare byte-for-byte
// across replays. event_fact is excluded: it is the input, not a projection.
func (f *fakeDriver) projectionState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	tables := make([]string, 0, len(f.projRows))
	for t := range f.projRows {
		tables = append(tables, t)
	}
	sort.Strings(tables)
	var b strings.Builder
	for _, t := range tables {
		fmt.Fprintf(&b, "table %s\n", t)
		keys := make([]string, 0, len(f.projRows[t]))
		for k := range f.projRows[t] {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			args := f.projRows[t][k]
			parts := make([]string, 0, len(args))
			for _, a := range args {
				parts = append(parts, renderArg(a))
			}
			fmt.Fprintf(&b, "  row[%s]: %s\n", strings.ReplaceAll(k, "\x00", "|"), strings.Join(parts, ", "))
		}
	}
	return b.String()
}

// ledgerSize returns the collapsed ledger row count.
func (f *fakeDriver) ledgerSize() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ledger)
}

// resetProjections truncates every projection table but keeps the ledger —
// the ADR-0002 rebuild drill (db/clickhouse/README.md).
func (f *fakeDriver) resetProjections() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.projRows = map[string]map[string][]any{}
	f.stmts = nil
}

// renderArg renders one bound parameter deterministically — the golden-file
// text format. NULL binds as <NULL>; strings as Go-quoted; times as UTC
// RFC3339Nano; floats with strconv 'g' -1 (shortest round-trip); string
// arrays space-separated inside brackets.
func renderArg(arg any) string {
	switch v := arg.(type) {
	case nil:
		return "<NULL>"
	case string:
		return strconv.Quote(v)
	case int64:
		return strconv.FormatInt(v, 10)
	case uint32:
		return strconv.FormatUint(uint64(v), 10) + "u"
	case int:
		return strconv.Itoa(v)
	case float64:
		if math.IsInf(v, 0) || math.IsNaN(v) {
			return fmt.Sprintf("%v", v)
		}
		return strconv.FormatFloat(v, 'g', -1, 64)
	case *float64:
		if v == nil {
			return "<NULL>"
		}
		return renderArg(*v)
	case time.Time:
		return v.UTC().Format(time.RFC3339Nano)
	case []string:
		parts := make([]string, 0, len(v))
		for _, s := range v {
			parts = append(parts, strconv.Quote(s))
		}
		return "[" + strings.Join(parts, " ") + "]"
	default:
		panic(fmt.Sprintf("fake driver: unrenderable argument type %T (extend renderArg)", arg))
	}
}

// ---------------------------------------------------------------------------
// Envelope + event builders — deterministic fixtures.
// ---------------------------------------------------------------------------

var testOrgA = "00000000-0000-4000-8000-000000000001"
var testOrgB = "00000000-0000-4000-8000-000000000002"

// uid mirrors the TS spec fixtures: uuid(`00000000-0000-4000-8000-${12 digits}`).
func uid(n int) string {
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", n)
}

// testBase is the fixed fixture epoch: 2025-01-01T00:00:00Z.
var testBase = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)

// at returns the fixture instant testBase + n days (+ optional extra ns).
func at(days int, extra time.Duration) time.Time {
	return testBase.Add(time.Duration(days) * 24 * time.Hour).Add(extra)
}

// envWire renders the relay's wire envelope (outbox README) with the payload
// bytes verbatim — exactly what a JetStream delivery carries.
func envWire(org, name string, n int, createdAt time.Time, payload string) []byte {
	return []byte(fmt.Sprintf(
		`{"eventId":%q,"name":%q,"version":1,"orgId":%q,"createdAt":%q,"payload":%s}`,
		uid(n), name, org, createdAt.UTC().Format(time.RFC3339Nano), payload,
	))
}

// --- catalog payload builders (src/domain/events/catalog.ts shapes) ---------

func pInvoiceIssued(invoiceID string, totalMinor int64, currency, dueDate string) string {
	return fmt.Sprintf(`{"invoiceId":%q,"customerId":%q,"totalMinor":%d,"currency":%q,"dueDate":%q}`,
		invoiceID, uid(900), totalMinor, currency, dueDate)
}

func pInvoiceVoided(invoiceID, reason string) string {
	return fmt.Sprintf(`{"invoiceId":%q,"reason":%q,"actorId":%q}`, invoiceID, reason, uid(901))
}

func pReceivableOpened(recID, invoiceID string, originalMinor int64, dueDate string) string {
	return fmt.Sprintf(`{"receivableId":%q,"invoiceId":%q,"originalMinor":%d,"dueDate":%q}`,
		recID, invoiceID, originalMinor, dueDate)
}

func pPartiallySettled(recID string, amountMinor, remainingMinor int64) string {
	return fmt.Sprintf(`{"receivableId":%q,"amountMinor":%d,"remainingMinor":%d}`, recID, amountMinor, remainingMinor)
}

func pSettled(recID string, settledAt time.Time) string {
	return fmt.Sprintf(`{"receivableId":%q,"settledAt":%q}`, recID, settledAt.UTC().Format(time.RFC3339Nano))
}

func pOverdue(recID string, daysLate int64, bucket string) string {
	return fmt.Sprintf(`{"receivableId":%q,"daysLate":%d,"agingBucket":%q}`, recID, daysLate, bucket)
}

func pWrittenOff(recID, reason string) string {
	return fmt.Sprintf(`{"receivableId":%q,"reason":%q,"approvedBy":%q}`, recID, reason, uid(902))
}

func pRecovered(recID string, amountMinor int64) string {
	return fmt.Sprintf(`{"receivableId":%q,"amountMinor":%d}`, recID, amountMinor)
}

func pPromiseBroken(promiseID, caseID string, expectedAt time.Time) string {
	return fmt.Sprintf(`{"promiseId":%q,"caseId":%q,"expectedAt":%q}`,
		promiseID, caseID, expectedAt.UTC().Format(time.RFC3339Nano))
}

// stubConsumer is a Consumer that hands out pre-queued batches (in order),
// then reports "no work" forever. Tests that drive IngestBatch directly pass
// it to New to satisfy the port contract.
type stubConsumer struct {
	mu     sync.Mutex
	queue  [][][]byte
	gen    int // synthetic tick counter once the queue drains
	genMax int
}

func newStubConsumer(batches ...[][]byte) *stubConsumer {
	c := &stubConsumer{}
	for _, b := range batches {
		c.queue = append(c.queue, b)
	}
	return c
}

func (c *stubConsumer) Consume(_ context.Context) ([][]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.queue) > 0 {
		b := c.queue[0]
		c.queue = c.queue[1:]
		return b, nil
	}
	if c.gen < c.genMax {
		c.gen++
		return nil, nil // no work available this tick
	}
	return nil, nil
}

// ingestAll feeds raw envelopes through IngestBatch one batch at a time.
func ingestAll(t interface {
	Helper()
	Fatalf(format string, args ...any)
}, ing *Ingester, batches ...[][]byte) Stats {
	t.Helper()
	var last Stats
	for i, batch := range batches {
		stats, err := ing.IngestBatch(context.Background(), batch)
		if err != nil {
			t.Fatalf("IngestBatch(batch %d) failed: %v", i+1, err)
		}
		last = stats
	}
	return last
}

// mustParseEnvelope parses one raw envelope or fails the test.
func mustParseEnvelope(t interface {
	Fatalf(format string, args ...any)
}, raw []byte) Envelope {
	env, err := ParseEnvelope(raw)
	if err != nil {
		t.Fatalf("ParseEnvelope(%s) failed: %v", raw, err)
	}
	return env
}
