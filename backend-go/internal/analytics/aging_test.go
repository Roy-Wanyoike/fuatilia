package analytics

import (
	"testing"
	"time"
)

// Fixture tests for the aging projection — the Go port of
// src/domain/projections/aging.ts (issue #24). Every table below cites the
// aging.spec.ts test it mirrors; the port must stay formula-for-formula and
// boundary-for-boundary with the TS source (issue #89 acceptance: "at least
// one fixture/property test per projection citing its TS source").

// testDue is the TS fixture DUE = '2025-03-01T00:00:00.000Z' — aging day 0.
var testDue = time.Date(2025, 3, 1, 0, 0, 0, 0, time.UTC)

// duePlus mirrors aging.spec.ts asOfDay(days, offsetMs): DUE + days*24h + offset.
func duePlus(days int, offset time.Duration) time.Time {
	return testDue.Add(time.Duration(days) * 24 * time.Hour).Add(offset)
}

// TestAgingBucketForMatchesTSSpecTable ports aging.spec.ts
// "aging bucket boundaries (±1 day past due)" — the day-past-due → bucket
// table, verbatim:
//
//	[-28 current] [0 current] [1 1-30] [30 1-30] [31 31-60] [60 31-60]
//	[61 61-90] [90 61-90] [91 90+] [365 90+]
func TestAgingBucketForMatchesTSSpecTable(t *testing.T) {
	cases := []struct {
		daysPastDue int64
		want        string
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
	for _, tc := range cases {
		if got := AgingBucketFor(tc.daysPastDue); got != tc.want {
			t.Errorf("AgingBucketFor(%d) = %q, want %q (aging.spec.ts boundary table)", tc.daysPastDue, got, tc.want)
		}
	}
}

// TestDaysOverdueMatchesTSFloorAndClamp ports aging.spec.ts
// "floors whole days past due and clamps future dues at 0" plus the
// asOf-offset boundary rows of "asOf due ±dd → bucket":
//
//	1ms past the due instant is still day 0 (floor)
//	exactly the due instant → 0
//	exactly one full day late → 1
//	30d 23:59:59.999 is still day 30
func TestDaysOverdueMatchesTSFloorAndClamp(t *testing.T) {
	day := 24 * time.Hour
	cases := []struct {
		asOf time.Time
		want int64
	}{
		{testDue.Add(-time.Millisecond), 0},          // not yet due — clamped at 0
		{testDue, 0},                                 // exactly the due instant
		{testDue.Add(day - time.Millisecond), 0},     // floored: 23:59:59.999 is day 0
		{testDue.Add(day), 1},                        // exactly one full day late
		{testDue.Add(31*day - time.Millisecond), 30}, // asOfDay(30, DAY_MS−1): 30d 23:59:59.999 is still day 30
		{testDue.Add(31 * day), 31},                  // 31 full days crosses
	}
	for _, tc := range cases {
		if got := DaysOverdue(testDue, tc.asOf); got != tc.want {
			t.Errorf("DaysOverdue(due, %v) = %d, want %d (aging.spec.ts floor/clamp fixtures)", tc.asOf, got, tc.want)
		}
	}
	// Negative deltas clamp to 0 in both languages: Go trunc-toward-zero +
	// clamp composes to the TS Math.max(0, Math.floor(·)) for every input
	// (parity note in aging.go).
	for _, before := range []time.Duration{time.Nanosecond, 25 * time.Hour, 1000 * 24 * time.Hour} {
		if got := DaysOverdue(testDue.Add(before), testDue); got != 0 {
			t.Errorf("DaysOverdue(due-%v, due) = %d, want 0 (clamp)", before, got)
		}
	}
}

// recSnapshot builds a receivableSnapshot the way the fold projects book
// entries (balance + due time), in canonical input order.
func recSnapshot(id string, balance int64, due time.Time) receivableSnapshot {
	return receivableSnapshot{id: id, balance: balance, dueTime: due}
}

// TestDayCloseAgingParityWithTSSpec ports THREE aging.spec.ts fixtures at
// once against the day-close computation the ingester emits per
// (org, currency, day). dayCloseAging sees ONE currency's book (currency
// grouping happens upstream in the fold), so the USD side of the TS
// multi-currency fixture is pinned separately in
// TestDayCloseAgingZeroBalanceUSD:
//
//  1. "totals per currency in bigint minor units": KES current
//     1_000_000 + 700_000 + 800_000, KES 31-60 500_000 + 900_000; buckets
//     zero-filled in AGING_BUCKETS order (1-30 / 61-90 / 90+ = 0, count 0).
//  2. "carries evidence refs per bucket, in input order": current refs
//     [1, 7, 8], 31-60 refs [2, 9].
//  3. "skips zero-balance facts (settled debt has nothing to age) but counts
//     them": zeroBalanceCount = 1, aged = 6.
func TestDayCloseAgingParityWithTSSpec(t *testing.T) {
	// asOf = DUE (aging day 0); rec(2)/rec(9) due 45 days EARLIER → 45
	// days past due → '31-60'; rec(4) balance 0 — skipped and counted.
	asOf := testDue
	receivables := []receivableSnapshot{
		recSnapshot(uid(1), 1_000_000, testDue),       // current
		recSnapshot(uid(2), 500_000, duePlus(-45, 0)), // 31-60
		recSnapshot(uid(4), 0, testDue),               // zero balance — skipped, counted
		recSnapshot(uid(7), 700_000, testDue),         // current
		recSnapshot(uid(8), 800_000, testDue),         // current
		recSnapshot(uid(9), 900_000, duePlus(-45, 0)), // 31-60
	}

	buckets, zeroCount := dayCloseAging(asOf, receivables)

	// Fixture 3: zero-balance facts are counted, never aged.
	if zeroCount != 1 {
		t.Fatalf("zeroBalanceCount = %d, want 1 (aging.spec.ts 'skips zero-balance facts')", zeroCount)
	}

	// Fixture 1: per-bucket amounts, zero-filled, AGING_BUCKETS order.
	wantKES := map[string]int64{"current": 1_000_000 + 700_000 + 800_000, "1-30": 0, "31-60": 500_000 + 900_000, "61-90": 0, "90+": 0}
	for _, bucket := range AGING_BUCKETS {
		acc := buckets[bucket]
		var amount int64
		if acc != nil {
			amount = acc.amount
		}
		if amount != wantKES[bucket] {
			t.Errorf("bucket %q = %d, want %d (aging.spec.ts per-currency totals)", bucket, amount, wantKES[bucket])
		}
	}

	// Fixture 2: evidence refs per bucket, canonical input order.
	if refs := buckets["current"].refs; len(refs) != 3 || refs[0] != uid(1) || refs[1] != uid(7) || refs[2] != uid(8) {
		t.Errorf("current refs = %v, want [%s %s %s] (input order — aging.spec.ts evidence fixture)", refs, uid(1), uid(7), uid(8))
	}
	if refs := buckets["31-60"].refs; len(refs) != 2 || refs[0] != uid(2) || refs[1] != uid(9) {
		t.Errorf("31-60 refs = %v, want [%s %s] (input order)", refs, uid(2), uid(9))
	}
	if acc := buckets["90+"]; acc != nil {
		t.Errorf("90+ bucket should be zero-filled (absent), got %+v", acc)
	}
}

// TestDayCloseAgingZeroBalanceUSD pins the USD side of the aging.spec.ts
// multi-currency fixture: a USD-only book ages into 90+ alone.
func TestDayCloseAgingZeroBalanceUSD(t *testing.T) {
	asOf := testDue
	usd := []receivableSnapshot{recSnapshot(uid(3), 250_000, duePlus(-120, 0))}
	buckets, zero := dayCloseAging(asOf, usd)
	if zero != 0 {
		t.Fatalf("zeroBalanceCount = %d, want 0", zero)
	}
	if acc := buckets["90+"]; acc == nil || acc.amount != 250_000 || len(acc.refs) != 1 || acc.refs[0] != uid(3) {
		t.Fatalf("USD 90+ = %+v, want amount 250000 refs [%s] (aging.spec.ts multi-currency fixture)", acc, uid(3))
	}
	for _, b := range []string{"current", "1-30", "31-60", "61-90"} {
		if acc := buckets[b]; acc != nil {
			t.Errorf("USD bucket %q should be zero-filled (absent), got %+v", b, acc)
		}
	}
}

// TestAgingBoundariesThroughBucketRows is the end-to-end guard that the
// boundary semantics survive into emitted rows: one receivable due the day
// the book opens, observed at day 0/1/30/31/90/91 closes — each close must
// land in the bucket the aging.spec.ts table pins. Driven through
// IngestBatch + the fake driver (the SQL contract path, not just the helper).
func TestAgingBoundariesThroughBucketRows(t *testing.T) {
	org := testOrgA
	invoiceID := uid(100)
	recID := uid(1)

	// Billing opens the receivable on day 0 with dueDate = day 0.
	day := func(n int) time.Time { return at(n, 0) }
	dateOnly := func(n int) string { return day(n).Format("2006-01-02") }
	events := [][]byte{
		envWire(org, "invoicing.invoiceIssued", 1, day(0), pInvoiceIssued(invoiceID, 1_000_000, "KES", dateOnly(0))),
		envWire(org, "receivable.opened", 2, day(0).Add(time.Second), pReceivableOpened(recID, invoiceID, 1_000_000, dateOnly(0))),
	}

	cases := []struct {
		observeDay int
		wantBucket string
	}{
		{0, "current"}, // due exactly at close — nothing past due
		{1, "1-30"},
		{30, "1-30"},
		{31, "31-60"},
		{90, "61-90"},
		{91, "90+"},
	}
	for i, tc := range cases {
		driver := newFakeDriver()
		ing, err := New(newStubConsumer(), driver, nil)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		batches := [][][]byte{events}
		if i > 0 {
			// A settlement keeps the balance alive at later closes so
			// the bucket, not a zero-balance skip, is what's tested.
			batches = append(batches, [][]byte{
				envWire(org, "receivable.partiallySettled", 3, day(tc.observeDay).Add(time.Second),
					pPartiallySettled(recID, 0, 1_000_000)),
			})
		}
		ingestAll(t, ing, batches...)

		rows := driver.projRows[TableAgingMigration]
		var found bool
		for key, args := range rows {
			if args[3].(string) != tc.wantBucket {
				continue
			}
			if args[2].(time.Time) != dayStartInstant(dayKey(day(tc.observeDay))) {
				continue
			}
			found = true
			if amount := args[4].(int64); amount != 1_000_000 {
				t.Errorf("day %d bucket %q amount = %d, want 1000000", tc.observeDay, tc.wantBucket, amount)
			}
			_ = key
		}
		if !found {
			t.Errorf("day %d: no row in bucket %q (aging.spec.ts boundary table through the SQL contract)", tc.observeDay, tc.wantBucket)
		}
	}
}
