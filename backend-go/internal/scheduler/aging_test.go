package scheduler

// Parity tests for the aging ports — the fixture tables are the TypeScript
// specs' own, cited per test:
//
//      SOURCE: src/domain/receivables/aging.ts        (receivable-lane buckets)
//      SPEC:   src/domain/receivables/aging.spec.ts
//      SOURCE: src/domain/projections/aging.ts        (AR aging snapshot)
//      SPEC:   src/domain/projections/aging.spec.ts
//
// A change to either side that these tests do not pin is a parity break.

import (
	"reflect"
	"testing"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

const agingDueISO = "2025-03-01T00:00:00.000Z" // aging day 0 (both specs)

// SPEC (receivables/aging.spec.ts): 'aging buckets (0-30 / 31-60 / 61-90 /
// 90+ days past dueDate)' — day table.
func TestReceivableAgingBucketTable(t *testing.T) {
	due := mustTimeT(agingDueISO)
	table := []struct {
		days int
		want string
	}{
		{-28, ReceivableBucket030},  // before the due date — current, never negative
		{0, ReceivableBucket030},    // due date today
		{1, ReceivableBucket030},    //
		{30, ReceivableBucket030},   //
		{31, ReceivableBucket3160},  //
		{60, ReceivableBucket3160},  //
		{61, ReceivableBucket6190},  //
		{90, ReceivableBucket6190},  //
		{91, ReceivableBucket90Loc}, //
		{365, ReceivableBucket90Loc},
	}
	for _, tc := range table {
		days := DaysPastDue(due, mustTimeT("2025-03-01T00:00:00.000Z").Add(timeDay(tc.days)))
		if days < 0 {
			t.Fatalf("daysPastDue must clamp at 0, got %d for %+d", days, tc.days)
		}
		if got := ReceivableAgingBucket(days); got != tc.want {
			t.Fatalf("day %+d → %s, want %s", tc.days, got, tc.want)
		}
	}
}

// SPEC (receivables/aging.spec.ts): 'floors partial days' — half a day late
// is still day 0; day 30 23:59:59.999 is still day 30.
func TestReceivableDaysPastDueFloors(t *testing.T) {
	due := mustTimeT(agingDueISO)
	if got := DaysPastDue(due, mustTimeT("2025-03-01T12:00:00.000Z")); got != 0 {
		t.Fatalf("half-day-late = %d, want 0", got)
	}
	if got := DaysPastDue(due, mustTimeT("2025-03-31T23:59:59.999Z")); got != 30 {
		t.Fatalf("day-30 23:59:59.999 = %d, want 30", got)
	}
}

// SPEC (receivables/aging.spec.ts): 'refuses to age a settled receivable —
// nothing left to collect' (AGING_NOT_APPLICABLE); decided states still age.
func TestAssertAgeable(t *testing.T) {
	expectCode(t, AssertAgeable("settled"), CodeAgingNotApplicable)
	for _, state := range []string{"open", "partially_paid", "written_off", "uncollectible", "recovered", "voided", "draft"} {
		if err := AssertAgeable(state); err != nil {
			t.Fatalf("state %s must still age: %v", state, err)
		}
	}
}

// SPEC (projections/aging.spec.ts): 'aging bucket boundaries (±1 day past
// due)' — bucket function table.
func TestAgingBucketForTable(t *testing.T) {
	table := []struct {
		days int
		want string
	}{
		{-28, "current"}, // far before the due date
		{0, "current"},   // due exactly now — nothing past due yet
		{1, "1-30"},      // day 1 crosses into the first bucket
		{30, "1-30"},     // last day of the first bucket
		{31, "31-60"},    // day 31 crosses
		{60, "31-60"},
		{61, "61-90"},
		{90, "61-90"},
		{91, "90+"},
		{365, "90+"},
	}
	for _, tc := range table {
		if got := AgingBucketFor(tc.days); got != tc.want {
			t.Fatalf("agingBucketFor(%+d) = %s, want %s", tc.days, got, tc.want)
		}
	}
}

// SPEC (projections/aging.spec.ts): 'asOf due +Nd Nms → bucket' — the
// instant-level boundary table (1ms past the due instant is still day 0, 30d
// 23:59:59.999 is still day 30, 31 full days crosses).
func TestArAgingByBucketInstantBoundaries(t *testing.T) {
	table := []struct {
		days     int
		offsetMS int64
		want     string
	}{
		{0, 1, "current"},
		{0, 0, "current"},
		{1, 0, "1-30"},
		{30, 86_400_000 - 1, "1-30"},
		{31, 0, "31-60"},
		{60, 86_400_000 - 1, "31-60"},
		{61, 0, "61-90"},
		{90, 86_400_000 - 1, "61-90"},
		{91, 0, "90+"},
	}
	due := mustTimeT(agingDueISO)
	for _, tc := range table {
		asOf := due.Add(timeDay(tc.days)).Add(msDuration(tc.offsetMS))
		fact := agingFact("00000000-0000-4000-8000-000000000001", money.KES, due, 1_000_000)
		snapshot, err := ArAgingByBucket([]AgingFact{fact}, asOf)
		if err != nil {
			t.Fatalf("days=%d offset=%dms: %v", tc.days, tc.offsetMS, err)
		}
		aged := nonEmptyBuckets(t, snapshot)
		if len(aged) != 1 {
			t.Fatalf("days=%d: %d non-empty buckets, want 1", tc.days, len(aged))
		}
		if aged[0].Bucket != tc.want {
			t.Fatalf("days=%d offset=%dms: bucket %s, want %s", tc.days, tc.offsetMS, aged[0].Bucket, tc.want)
		}
	}
	// SPEC: 'floors whole days past due and clamps future dues at 0'.
	if got := DaysOverdue(due, due.Add(-time.Second)); got != 0 {
		t.Fatalf("not-yet-due = %d, want 0", got)
	}
}

// SPEC (projections/aging.spec.ts): 'labels the snapshot kind:"actual" and
// stamps asOf on the report AND every figure' (kind is pinned by the Go type
// — there is no field to corrupt).
func TestArAgingByBucketAsOfStamping(t *testing.T) {
	due := mustTimeT(agingDueISO)
	receivables := []AgingFact{
		agingFact("00000000-0000-4000-8000-000000000001", money.KES, due, 1_000_000),
		agingFact("00000000-0000-4000-8000-000000000002", money.KES, due.Add(-45*timeDay(1)), 1_000_000),
	}
	snapshot, err := ArAgingByBucket(receivables, due)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.AsOf != agingDueISO {
		t.Fatalf("asOf = %s, want %s", snapshot.AsOf, agingDueISO)
	}
	for _, view := range snapshot.Currencies {
		for _, bucket := range view.Buckets {
			if bucket.AsOf != snapshot.AsOf {
				t.Fatalf("bucket %s carries asOf %s, want %s", bucket.Bucket, bucket.AsOf, snapshot.AsOf)
			}
		}
	}
}

// SPEC (projections/aging.spec.ts): 'totals per currency in minor units
// (multi-currency, first-seen order)' + zero-filled AGING_BUCKETS order.
func TestArAgingByBucketMultiCurrency(t *testing.T) {
	due := mustTimeT(agingDueISO)
	receivables := []AgingFact{
		agingFact("00000000-0000-4000-8000-000000000001", money.KES, due, 1_000_000),                    // current
		agingFact("00000000-0000-4000-8000-000000000002", money.KES, due.Add(-45*timeDay(1)), 500_000),  // 31-60
		agingFact("00000000-0000-4000-8000-000000000003", money.USD, due.Add(-120*timeDay(1)), 250_000), // 90+
	}
	snapshot, err := ArAgingByBucket(receivables, due)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Currencies) != 2 || snapshot.Currencies[0].Currency != money.KES || snapshot.Currencies[1].Currency != money.USD {
		t.Fatalf("currency order = %v, want [KES USD] (first-seen)", snapshot.Currencies)
	}
	kes, usd := snapshot.Currencies[0], snapshot.Currencies[1]
	if kes.TotalMinor != 1_500_000 || usd.TotalMinor != 250_000 {
		t.Fatalf("totals: KES %d USD %d, want 1500000 / 250000", kes.TotalMinor, usd.TotalMinor)
	}
	if got := bucketTotal(t, snapshot, money.KES, "current"); got.AmountMinor != 1_000_000 {
		t.Fatalf("KES current = %d, want 1000000", got.AmountMinor)
	}
	if got := bucketTotal(t, snapshot, money.KES, "31-60"); got.AmountMinor != 500_000 {
		t.Fatalf("KES 31-60 = %d, want 500000", got.AmountMinor)
	}
	if got := bucketTotal(t, snapshot, money.USD, "90+"); got.AmountMinor != 250_000 {
		t.Fatalf("USD 90+ = %d, want 250000", got.AmountMinor)
	}
	// Buckets are always zero-filled, in AGING_BUCKETS order.
	wantOrder := []string{"current", "1-30", "31-60", "61-90", "90+"}
	gotOrder := make([]string, 0, len(kes.Buckets))
	for _, b := range kes.Buckets {
		gotOrder = append(gotOrder, b.Bucket)
	}
	if !reflect.DeepEqual(gotOrder, wantOrder) {
		t.Fatalf("bucket order = %v, want %v", gotOrder, wantOrder)
	}
	empty := bucketTotal(t, snapshot, money.KES, "90+")
	if empty.AmountMinor != 0 || empty.ReceivableCount != 0 {
		t.Fatalf("zero-filled bucket drifted: %+v", empty)
	}
}

// SPEC (projections/aging.spec.ts): 'carries evidence refs per bucket, in
// input order'.
func TestArAgingByBucketEvidenceRefs(t *testing.T) {
	due := mustTimeT(agingDueISO)
	uid7 := "00000000-0000-4000-8000-000000000007"
	uid8 := "00000000-0000-4000-8000-000000000008"
	uid9 := "00000000-0000-4000-8000-000000000009"
	receivables := []AgingFact{
		agingFact(uid7, money.KES, due, 1_000_000),
		agingFact(uid8, money.KES, due, 1_000_000),
		agingFact(uid9, money.KES, due.Add(-45*timeDay(1)), 1_000_000),
	}
	snapshot, err := ArAgingByBucket(receivables, due)
	if err != nil {
		t.Fatal(err)
	}
	current := bucketTotal(t, snapshot, money.KES, "current")
	if !reflect.DeepEqual(current.EvidenceRefs, []string{uid7, uid8}) {
		t.Fatalf("current evidence = %v, want [%s %s] (input order)", current.EvidenceRefs, uid7, uid8)
	}
	if current.ReceivableCount != 2 {
		t.Fatalf("current count = %d, want 2", current.ReceivableCount)
	}
	if !reflect.DeepEqual(bucketTotal(t, snapshot, money.KES, "31-60").EvidenceRefs, []string{uid9}) {
		t.Fatalf("31-60 evidence = %v, want [%s]", bucketTotal(t, snapshot, money.KES, "31-60").EvidenceRefs, uid9)
	}
}

// SPEC (projections/aging.spec.ts): 'skips zero-balance facts (settled debt
// has nothing to age) but counts them' — and the zero-balance fact never
// opens a currency view.
func TestArAgingByBucketZeroBalance(t *testing.T) {
	due := mustTimeT(agingDueISO)
	receivables := []AgingFact{
		agingFact("00000000-0000-4000-8000-000000000001", money.KES, due, 1_000_000),
		agingFact("00000000-0000-4000-8000-000000000002", money.KES, due, 0),
	}
	snapshot, err := ArAgingByBucket(receivables, due)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ReceivablesAged != 1 || snapshot.ZeroBalanceCount != 1 {
		t.Fatalf("aged=%d zero=%d, want 1/1", snapshot.ReceivablesAged, snapshot.ZeroBalanceCount)
	}
	if len(snapshot.Currencies) != 1 {
		t.Fatalf("currency views = %d, want 1 (zero-balance never opens a view)", len(snapshot.Currencies))
	}
}

// SPEC (projections/aging.spec.ts): 'returns an empty snapshot for an empty
// book' + 'is deterministic' + stable error codes (PROJ_AS_OF_INVALID,
// PROJ_RECEIVABLE_DUPLICATE — the uuid-shape and fact-shape rows are enforced
// at fact construction in Go's typed model).
func TestArAgingByBucketEdges(t *testing.T) {
	snapshot, err := ArAgingByBucket(nil, mustTimeT(agingDueISO))
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Currencies) != 0 || snapshot.ReceivablesAged != 0 || snapshot.ZeroBalanceCount != 0 {
		t.Fatalf("empty book snapshot = %+v", snapshot)
	}

	_, err = ArAgingByBucket(nil, timeZero())
	expectCode(t, err, CodeProjAsOfInvalid)

	dup := agingFact("00000000-0000-4000-8000-000000000001", money.KES, mustTimeT(agingDueISO), 100)
	_, err = ArAgingByBucket([]AgingFact{dup, dup}, mustTimeT(agingDueISO))
	expectCode(t, err, CodeProjReceivableDuplicate)

	_, err = ArAgingByBucket([]AgingFact{agingFact("rec-1", money.KES, mustTimeT(agingDueISO), 100)}, mustTimeT(agingDueISO))
	expectCode(t, err, CodeProjReceivableInvalid)

	// Determinism: identical inputs yield identical snapshots.
	receivables := []AgingFact{
		agingFact("00000000-0000-4000-8000-000000000001", money.KES, mustTimeT(agingDueISO), 1_000_000),
		agingFact("00000000-0000-4000-8000-000000000002", money.KES, mustTimeT(agingDueISO).Add(-70*timeDay(1)), 500_000),
		agingFact("00000000-0000-4000-8000-000000000003", money.USD, mustTimeT(agingDueISO), 250_000),
	}
	first, err := ArAgingByBucket(receivables, mustTimeT(agingDueISO))
	if err != nil {
		t.Fatal(err)
	}
	second, err := ArAgingByBucket(receivables, mustTimeT(agingDueISO))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("identical inputs produced different snapshots")
	}
}

// The snapshot event payload (projections/events.ts agingSnapshotTakenEvent):
// evidence flattening, per-currency bucketMinors, safe-integer minors.
func TestAgingSnapshotEventPayload(t *testing.T) {
	due := mustTimeT(agingDueISO)
	receivables := []AgingFact{
		agingFact("00000000-0000-4000-8000-000000000001", money.KES, due, 1_000_000),
		agingFact("00000000-0000-4000-8000-000000000002", money.KES, due, 0), // zero-balance — counted, not aged
		agingFact("00000000-0000-4000-8000-000000000003", money.USD, due.Add(-120*timeDay(1)), 250_000),
	}
	snapshot, err := ArAgingByBucket(receivables, due)
	if err != nil {
		t.Fatal(err)
	}
	orgID := "00000000-0000-4000-8000-000000000100"
	ev, err := AgingSnapshotEvent(orgID, snapshot, mustTimeT(agingDueISO))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "projections.agingSnapshotTaken" || ev.Version != 1 || ev.AggregateID != orgID {
		t.Fatalf("envelope mismatch: %+v", ev)
	}
	payload := payloadMap(t, ev)
	for k, want := range map[string]any{
		"orgId":            orgID,
		"asOf":             agingDueISO,
		"receivablesAged":  float64(2),
		"zeroBalanceCount": float64(1),
	} {
		if got := payload[k]; got != want {
			t.Fatalf("payload[%s] = %v, want %v", k, got, want)
		}
	}
	// Evidence flattening: the two aged receivables, view order.
	evidence := payload["evidenceRefs"].([]any)
	if len(evidence) != 2 ||
		evidence[0].(string) != "00000000-0000-4000-8000-000000000001" ||
		evidence[1].(string) != "00000000-0000-4000-8000-000000000003" {
		t.Fatalf("evidenceRefs = %v", evidence)
	}
	currencies := payload["currencies"].([]any)
	if len(currencies) != 2 {
		t.Fatalf("currencies = %d, want 2", len(currencies))
	}
	kes := currencies[0].(map[string]any)
	if kes["currency"] != "KES" || kes["totalMinor"] != float64(1_000_000) || kes["receivableCount"] != float64(1) {
		t.Fatalf("KES view = %v", kes)
	}
	buckets := kes["bucketMinors"].(map[string]any)
	if buckets["current"] != float64(1_000_000) || buckets["90+"] != float64(0) {
		t.Fatalf("KES bucketMinors = %v", buckets)
	}
	usd := currencies[1].(map[string]any)
	if usd["totalMinor"] != float64(250_000) {
		t.Fatalf("USD view = %v", usd)
	}
}

// --- helpers ----------------------------------------------------------------

func agingFact(id string, currency money.Currency, due time.Time, balanceMinor int64) AgingFact {
	return AgingFact{
		ReceivableID: id,
		Currency:     currency,
		DueDate:      due,
		Balance:      mustMoney(balanceMinor, currency),
	}
}

func bucketTotal(t *testing.T, snapshot AgingSnapshot, currency money.Currency, bucket string) AgingBucketTotal {
	t.Helper()
	for _, view := range snapshot.Currencies {
		if view.Currency != currency {
			continue
		}
		for _, b := range view.Buckets {
			if b.Bucket == bucket {
				return b
			}
		}
	}
	t.Fatalf("no %s bucket in the %s view", bucket, currency)
	return AgingBucketTotal{}
}

func nonEmptyBuckets(t *testing.T, snapshot AgingSnapshot) []AgingBucketTotal {
	t.Helper()
	var out []AgingBucketTotal
	for _, view := range snapshot.Currencies {
		for _, b := range view.Buckets {
			if b.ReceivableCount > 0 {
				out = append(out, b)
			}
		}
	}
	return out
}
