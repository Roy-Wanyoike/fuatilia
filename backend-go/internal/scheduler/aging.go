package scheduler

import (
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// Pure Go port of the two aging modules the aging job materializes:
//
//   - src/domain/receivables/aging.ts — the receivable-lane bucket table
//     ('0-30' | '31-60' | '61-90' | '90+', AGING_NOT_APPLICABLE for settled
//     debt), ported for parity and pinned by aging_test.go against
//     aging.spec.ts.
//   - src/domain/projections/aging.ts — the AR aging & portfolio snapshot
//     (issue #24, SPEC §66): per-currency totals across the standard buckets
//     'current' | '1-30' | '31-60' | '61-90' | '90+', zero-balance facts
//     skipped (settled debt has nothing left to age), every figure carrying
//     its asOf and evidence refs (input order). The aging job materializes
//     THIS snapshot and emits projections.agingSnapshotTaken.
//
// Both share the day arithmetic: whole days past due, floored (a partial
// late day is not yet a full day late) and clamped at 0. All sums run through
// the shared money kernel (R10: per-currency only — cross-currency sums are
// structurally impossible). Pure: reads nothing, mutates nothing, emits no
// event — the caller decides whether to persist/emit (projections/aging.ts
// docstring), and the aging job's decision is the outbox append.

// Codes the aging port refuses with (TS DomainError families, verbatim).
const (
	CodeAgingNotApplicable      = "AGING_NOT_APPLICABLE"
	CodeProjAsOfInvalid         = "PROJ_AS_OF_INVALID"
	CodeProjReceivableInvalid   = "PROJ_RECEIVABLE_INVALID"
	CodeProjReceivableDuplicate = "PROJ_RECEIVABLE_DUPLICATE"
)

// receivableAgingBuckets is the receivable-lane bucket set
// (receivables/aging.ts AgingBucket).
const (
	ReceivableBucket030   = "0-30"
	ReceivableBucket3160  = "31-60"
	ReceivableBucket6190  = "61-90"
	ReceivableBucket90Loc = "90+"
)

// projectionAgingBuckets is the snapshot bucket set in canonical order
// (projections/aging.ts AGING_BUCKETS).
var projectionAgingBuckets = []string{"current", "1-30", "31-60", "61-90", "90+"}

// DaysPastDue returns whole days past the due date, floored and clamped at 0
// — current receivables are never negative (receivables/aging.ts
// daysPastDue).
func DaysPastDue(dueDate, now time.Time) int {
	days := floorDiv(now.Sub(dueDate).Nanoseconds(), dayNanos)
	if days < 0 {
		return 0
	}
	return int(days)
}

// ReceivableAgingBucket maps a live receivable's days past due onto the
// receivable-lane bucket table (receivables/aging.ts agingBucket). Boundary
// semantics: day 30 → '0-30', day 31 → '31-60', day 60 → '31-60', day 61 →
// '61-90', day 90 → '61-90', day 91 → '90+'.
func ReceivableAgingBucket(daysPastDue int) string {
	switch {
	case daysPastDue <= 30:
		return ReceivableBucket030
	case daysPastDue <= 60:
		return ReceivableBucket3160
	case daysPastDue <= 90:
		return ReceivableBucket6190
	default:
		return ReceivableBucket90Loc
	}
}

// AssertAgeable refuses to age a settled receivable — nothing left to collect
// (receivables/aging.ts agingBucket's AGING_NOT_APPLICABLE). Terminal-but-
// decided states (written_off, uncollectible, recovered, voided, draft) still
// compute — reporting needs their history.
func AssertAgeable(state string) error {
	if state == "settled" {
		return &Error{Code: CodeAgingNotApplicable, Message: "receivable is settled — nothing left to age"}
	}
	return nil
}

// DaysOverdue returns whole days past due, floored and clamped at 0 — future
// dues are never negative (projections/aging.ts daysOverdue).
func DaysOverdue(dueTime, asOfTime time.Time) int {
	return DaysPastDue(dueTime, asOfTime)
}

// AgingBucketFor maps days past due onto a snapshot bucket:
// `daysPastDue <= 0` (nothing past due) → 'current'; the ±1-day boundary
// semantics are pinned by tests (projections/aging.ts agingBucketFor).
func AgingBucketFor(daysPastDue int) string {
	switch {
	case daysPastDue <= 0:
		return "current"
	case daysPastDue <= 30:
		return "1-30"
	case daysPastDue <= 60:
		return "31-60"
	case daysPastDue <= 90:
		return "61-90"
	default:
		return "90+"
	}
}

// AgingFact is one receivable fact the snapshot consumes (the schema-honest
// slice of projections/aging.ts's ReceivableFact: id, currency, due instant
// and outstanding balance — balance is the 0004 GENERATED column
// original − applied, structurally ≥ 0).
type AgingFact struct {
	ReceivableID string
	Currency     money.Currency
	DueDate      time.Time
	Balance      money.Money
}

// AgingBucketTotal is one bucket's figure with its evidence (TS
// AgingBucketTotal): the receivables that contributed, in input order, so
// every figure is self-contained and traceable (VISION §3.7).
type AgingBucketTotal struct {
	Bucket          string
	AmountMinor     int64
	ReceivableCount int
	AsOf            string
	EvidenceRefs    []string
}

// AgingCurrencyView is one currency's snapshot (TS AgingCurrencyView): the
// five buckets, always present in canonical order (zero-filled).
type AgingCurrencyView struct {
	Currency   money.Currency
	TotalMinor int64
	Buckets    []AgingBucketTotal
}

// AgingSnapshot is the ACTUALS portfolio snapshot (TS AgingSnapshot) —
// structurally distinct from any projection: kind is pinned to 'actual' by
// construction (the Go type carries no kind field to corrupt).
type AgingSnapshot struct {
	AsOf             string
	Currencies       []AgingCurrencyView
	ReceivablesAged  int
	ZeroBalanceCount int
}

// ArAgingByBucket snapshots the outstanding AR portfolio by aging bucket,
// per currency, as of asOf (projections/aging.ts arAgingByBucket). Refusals:
// PROJ_AS_OF_INVALID for a broken asOf instant; PROJ_RECEIVABLE_INVALID for a
// non-uuid receivable id and PROJ_RECEIVABLE_DUPLICATE for a repeated one
// (the fact-shape guards of projections/facts.ts parseReceivableFacts that
// survive into Go's typed facts — currency/balance/dueDate shape is enforced
// at fact construction by the money kernel and the store scan).
func ArAgingByBucket(receivables []AgingFact, asOf time.Time) (AgingSnapshot, error) {
	if asOf.IsZero() {
		return AgingSnapshot{}, &Error{Code: CodeProjAsOfInvalid, Message: "asOf is not a valid instant"}
	}
	seen := make(map[string]bool, len(receivables))
	for _, fact := range receivables {
		if !infra.IsUUID(fact.ReceivableID) {
			return AgingSnapshot{}, &Error{Code: CodeProjReceivableInvalid,
				Message: sprintf("receivableId %q is not uuid-shaped", fact.ReceivableID)}
		}
		if seen[fact.ReceivableID] {
			return AgingSnapshot{}, &Error{Code: CodeProjReceivableDuplicate,
				Message: sprintf("duplicate receivableId %s", fact.ReceivableID)}
		}
		seen[fact.ReceivableID] = true
	}
	asOfIso := iso(asOf)

	order := make([]money.Currency, 0, 4)
	type accumulator struct {
		total   money.Money
		buckets map[string]*bucketAccumulator
	}
	byCurrency := make(map[money.Currency]*accumulator)
	snapshot := AgingSnapshot{AsOf: asOfIso}

	for _, receivable := range receivables {
		if receivable.Balance.IsZero() {
			snapshot.ZeroBalanceCount++ // settled debt has nothing left to age
			continue
		}
		snapshot.ReceivablesAged++

		acc, seen := byCurrency[receivable.Currency]
		if !seen {
			zero, err := money.Zero(receivable.Currency)
			if err != nil {
				return AgingSnapshot{}, err
			}
			acc = &accumulator{total: zero, buckets: make(map[string]*bucketAccumulator)}
			byCurrency[receivable.Currency] = acc
			order = append(order, receivable.Currency)
		}

		bucket := AgingBucketFor(DaysOverdue(receivable.DueDate, asOf))
		entry := acc.buckets[bucket]
		if entry == nil {
			zero, err := money.Zero(receivable.Currency)
			if err != nil {
				return AgingSnapshot{}, err
			}
			entry = &bucketAccumulator{amount: zero}
			acc.buckets[bucket] = entry
		}
		summed, err := entry.amount.Add(receivable.Balance)
		if err != nil {
			return AgingSnapshot{}, err
		}
		entry.amount = summed
		entry.refs = append(entry.refs, receivable.ReceivableID)
		total, err := acc.total.Add(receivable.Balance)
		if err != nil {
			return AgingSnapshot{}, err
		}
		acc.total = total
	}

	for _, currency := range order {
		acc := byCurrency[currency]
		view := AgingCurrencyView{Currency: currency, Buckets: make([]AgingBucketTotal, 0, len(projectionAgingBuckets))}
		for _, bucket := range projectionAgingBuckets {
			entry := acc.buckets[bucket]
			total := AgingBucketTotal{Bucket: bucket, AsOf: asOfIso}
			if entry != nil {
				total.AmountMinor = entry.amount.Amount()
				total.ReceivableCount = len(entry.refs)
				total.EvidenceRefs = append([]string(nil), entry.refs...)
			}
			view.Buckets = append(view.Buckets, total)
		}
		view.TotalMinor = acc.total.Amount()
		snapshot.Currencies = append(snapshot.Currencies, view)
	}
	return snapshot, nil
}

type bucketAccumulator struct {
	amount money.Money
	refs   []string
}

// AgingSnapshotEvent builds the projections.agingSnapshotTaken event (aggregate
// = the org, projections/events.ts agingSnapshotTakenEvent): kind is 'actual'
// by construction, evidenceRefs flatten every bucket's contributors in view
// order, and monetary values pass the safe-integer guard.
func AgingSnapshotEvent(orgID string, snapshot AgingSnapshot, clockAt time.Time) (Event, error) {
	payload := AgingSnapshotTakenPayload{
		OrgID:            orgID,
		AsOf:             snapshot.AsOf,
		ReceivablesAged:  snapshot.ReceivablesAged,
		ZeroBalanceCount: snapshot.ZeroBalanceCount,
		EvidenceRefs:     []string{},
		Currencies:       []AgingCurrencyTotals{},
	}
	for _, view := range snapshot.Currencies {
		count := 0
		for _, bucket := range view.Buckets {
			count += bucket.ReceivableCount
			payload.EvidenceRefs = append(payload.EvidenceRefs, bucket.EvidenceRefs...)
		}
		totalMinor, err := safeInt(view.TotalMinor)
		if err != nil {
			return Event{}, err
		}
		bucketMinors := make(map[string]int64, len(view.Buckets))
		for _, bucket := range view.Buckets {
			minor, err := safeInt(bucket.AmountMinor)
			if err != nil {
				return Event{}, err
			}
			bucketMinors[bucket.Bucket] = minor
		}
		payload.Currencies = append(payload.Currencies, AgingCurrencyTotals{
			Currency:        string(view.Currency),
			TotalMinor:      totalMinor,
			ReceivableCount: count,
			BucketMinors:    bucketMinors,
		})
	}
	return newEvent("projections.agingSnapshotTaken", orgID, clockAt, payload)
}
