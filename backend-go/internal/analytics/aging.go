package analytics

import (
	"time"
)

// Aging projection — the Go port of src/domain/projections/aging.ts
// (issue #24), formula for formula and boundary for boundary. The fixture
// tests (aging_test.go) cite the TS spec fixtures they mirror.
//
// Ported rules (aging.ts header):
//   - Whole days past due, FLOORED (a partial late day is not yet a full day
//     late) and CLAMPED at 0 — 'current' covers not-yet-due AND due-now.
//   - Boundaries: day 1 → '1-30', day 30 → '1-30', day 31 → '31-60',
//     day 60 → '31-60', day 61 → '61-90', day 90 → '61-90', day 91 → '90+'.
//   - Zero-balance facts (settled debt) contribute nothing to age: counted,
//     never bucketed.
//   - Buckets are always present, zero-filled, in AGING_BUCKETS order.

// AGING_BUCKETS is the verbatim aging.ts bucket list and order.
var AGING_BUCKETS = [5]string{"current", "1-30", "31-60", "61-90", "90+"}

const dayNanos = int64(24 * 60 * 60 * 1_000_000_000)

// DaysOverdue ports aging.ts daysOverdue: whole days past due, floored and
// clamped at 0 (future dues are never negative).
//
// Float-floor parity: TS computes Math.max(0, Math.floor((asOf−due)/86400000)).
// Go integer division truncates toward zero, which differs from floor only
// for negative deltas — and every negative result clamps to 0 in both
// languages, so the composition is equivalent for all inputs (pinned by
// TestDaysOverdueMatchesTSFloorAndClamp).
func DaysOverdue(due, asOf time.Time) int64 {
	delta := asOf.UnixNano() - due.UnixNano()
	days := delta / dayNanos // trunc-toward-zero; negatives clamp below (see parity note)
	if days < 0 {
		return 0
	}
	return days
}

// AgingBucketFor ports aging.ts agingBucketFor: daysPastDue <= 0 → 'current';
// ±1-day boundary semantics are pinned by tests citing aging.spec.ts.
func AgingBucketFor(daysPastDue int64) string {
	switch {
	case daysPastDue <= 0:
		return AGING_BUCKETS[0]
	case daysPastDue <= 30:
		return AGING_BUCKETS[1]
	case daysPastDue <= 60:
		return AGING_BUCKETS[2]
	case daysPastDue <= 90:
		return AGING_BUCKETS[3]
	default:
		return AGING_BUCKETS[4]
	}
}

// agingBucketAccumulator accumulates one bucket's figures while folding the
// book at a day close (the fold-time analog of arAgingByBucket's per-bucket
// reduce).
type agingBucketAccumulator struct {
	amount int64
	refs   []string // receivable ids, canonical input order (aging.ts evidenceRefs)
}

// dayCloseAging computes the five aging bucket figures for one currency's
// book at one day close. receivables are the day's live facts in canonical
// input order (the fold order — the analog of arAgingByBucket's input
// order); zero-balance facts are skipped and counted (aging.ts
// zeroBalanceCount).
func dayCloseAging(asOf time.Time, receivables []receivableSnapshot) (buckets map[string]*agingBucketAccumulator, zeroBalanceCount int) {
	buckets = make(map[string]*agingBucketAccumulator, len(AGING_BUCKETS))
	for _, rec := range receivables {
		if rec.balance == 0 {
			zeroBalanceCount++ // settled debt has nothing left to age
			continue
		}
		bucket := AgingBucketFor(DaysOverdue(rec.dueTime, asOf))
		acc := buckets[bucket]
		if acc == nil {
			acc = &agingBucketAccumulator{}
			buckets[bucket] = acc
		}
		acc.amount += rec.balance
		acc.refs = append(acc.refs, rec.id)
	}
	return buckets, zeroBalanceCount
}
