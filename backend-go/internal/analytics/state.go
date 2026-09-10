package analytics

import (
	"sort"
	"time"
)

// Per-org fold state. The org's event log is THE state — everything else
// is derived by refold() as a pure function of the log in canonical
// (created_at, eventId) order. Out-of-order delivery inserts into the log
// and re-folds; replays rebuild the log and re-fold; determinism is a
// structural property, not a discipline.

// receivableSnapshot is one receivable's live fact at a day close (the
// analog of aging.ts ReceivableFact, projected from the fold).
type receivableSnapshot struct {
	id      string
	balance int64
	dueTime time.Time
}

type balanceTransition struct {
	day     int64 // UTC epoch-day key of the event that changed the balance
	balance int64 // balance AFTER the event
}

// bookEntry is one receivable in the fold's book. Balance truth:
// receivable.opened (E05 originalMinor), receivable.partiallySettled
// (E06 remainingMinor — authoritative), receivable.settled (E07 → 0),
// receivable.writtenOff (E09 → 0). Written-off recoveries (E10) are
// collection facts, never a balance resurrection.
type bookEntry struct {
	receivableID string
	invoiceID    string
	currency     string // resolved from the billing invoice (E02); "" while unresolved
	original     int64
	balance      int64 // end-of-log balance
	dueTime      time.Time
	openedDay    int64
	writtenOff   bool
	settled      bool
	transitions  []balanceTransition // non-decreasing day, by construction (canonical order)
}

// invoiceRecord is one billed invoice (E02). First-write-wins on invoiceId:
// a re-issued duplicate billing is a producer fault and is refused (counted
// skip) rather than double-counted (R9 first-write-wins discipline).
type invoiceRecord struct {
	invoiceID string
	currency  string
	day       int64
	total     int64
}

// skipRecord is an expected, counted fold refusal — a data gap the v1 fabric
// can present (e.g. a settlement for a receivable whose open event never
// arrived), never a crash. Skips are surfaced in Stats and the cycle log;
// they never silently alter a figure.
type skipRecord struct {
	code    string
	message string
}

// orgState holds one org's log and its derived fold.
type orgState struct {
	orgID string
	log   []Envelope // canonical (created_at, eventId) order, unique by eventId

	// --- derived (reset + recomputed by refold) ---
	book                  map[string]*bookEntry
	bookOrder             []*bookEntry // canonical insertion (first-open) order
	voidedInvoices        map[string]struct{}
	invoices              map[string]*invoiceRecord
	invoiceOrder          []*invoiceRecord           // canonical insertion order
	billedByDay           map[string]map[int64]int64 // currency → day → NET billed (void-adjusted)
	collectedByReceivable map[string]map[int64]int64 // receivableID → day → collected minor
	promisesBrokenByDay   map[int64]int64
	promiseDays           map[int64]struct{} // days a promise outcome landed (moves the effectiveness evidence, not the book)
	activityDays          map[int64]struct{} // days whose events move money/book figures (dso_daily/aging closes)
	skips                 []skipRecord
}

func newOrgState(orgID string) *orgState {
	return &orgState{
		orgID:                 orgID,
		book:                  map[string]*bookEntry{},
		voidedInvoices:        map[string]struct{}{},
		invoices:              map[string]*invoiceRecord{},
		billedByDay:           map[string]map[int64]int64{},
		collectedByReceivable: map[string]map[int64]int64{},
		promisesBrokenByDay:   map[int64]int64{},
		promiseDays:           map[int64]struct{}{},
		activityDays:          map[int64]struct{}{},
	}
}

// upsertLog inserts new envelopes into the canonical log. Returns the count
// of events actually added (the caller pre-deduped, so this is len(batch)
// for a healthy stream). The log is kept sorted by (created_at, eventId).
func (s *orgState) upsertLog(batch []Envelope) int {
	s.log = append(s.log, batch...)
	sort.SliceStable(s.log, func(i, j int) bool {
		return canonicalLess(s.log[i], s.log[j])
	})
	return len(batch)
}

// dayKey is the UTC epoch-day of an instant.
func dayKey(t time.Time) int64 {
	u := t.UTC()
	return u.Unix() / 86400
}

// cohortMonthStartDay is the UTC epoch-day of the first day of t's month.
func cohortMonthStartDay(t time.Time) int64 {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), 1, 0, 0, 0, 0, time.UTC).Unix() / 86400
}

// currencies returns the sorted currencies present in the org's billing and
// book — deterministic emission order.
func (s *orgState) currencies() []string {
	set := map[string]struct{}{}
	for cur := range s.billedByDay {
		set[cur] = struct{}{}
	}
	for _, e := range s.bookOrder {
		if e.currency != "" {
			set[e.currency] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for cur := range set {
		out = append(out, cur)
	}
	sort.Strings(out)
	return out
}

// activityDayList returns the org's activity days ascending — the days that
// carry projection rows (event-driven, not calendar-filled). These are the
// book/billing activity days: dso_daily and aging_migration close on exactly
// these (their DDL: "a row exists only for days on which the org's book or
// billing actually changed").
func (s *orgState) activityDayList() []int64 {
	days := make([]int64, 0, len(s.activityDays))
	for d := range s.activityDays {
		days = append(days, d)
	}
	sort.Slice(days, func(i, j int) bool { return days[i] < days[j] })
	return days
}

// effectivenessDayList returns the days on which a collector_effectiveness
// window closes: the book/billing activity days PLUS days on which a promise
// outcome landed — a break moves the row's promises_broken evidence on its
// own day (an input of THIS table), so the window that sees it exists the
// moment it happens. A promise-only day never opens a dso_daily or aging
// row: the book and billing did not change (0002/0003 headers).
func (s *orgState) effectivenessDayList() []int64 {
	days := make([]int64, 0, len(s.activityDays)+len(s.promiseDays))
	seen := make(map[int64]struct{}, len(s.activityDays)+len(s.promiseDays))
	for d := range s.activityDays {
		days = append(days, d)
		seen[d] = struct{}{}
	}
	for d := range s.promiseDays {
		if _, ok := seen[d]; !ok {
			days = append(days, d)
		}
	}
	sort.Slice(days, func(i, j int) bool { return days[i] < days[j] })
	return days
}

// billedTrailing sums the NET billed amount for one currency over the
// inclusive trailing window [day-window+1, day], from the final
// (void-adjusted) billing map — a voided invoice never inflates a window,
// even a historical one.
func (s *orgState) billedTrailing(cur string, day int64, window int64) int64 {
	byDay := s.billedByDay[cur]
	if byDay == nil {
		return 0
	}
	var sum int64
	for d := day - window + 1; d <= day; d++ {
		sum += byDay[d]
	}
	return sum
}

// receivablesAt returns the day-close facts for one currency, in canonical
// book order: live (opened ≤ day), invoice never voided, currency resolved.
// Balance as of the day comes from the entry's transition history — the fold
// trajectory, not the end-of-log balance. Zero-balance facts are INCLUDED
// here (the aging close skips-and-counts them, aging.ts parity).
func (s *orgState) receivablesAt(cur string, day int64) []receivableSnapshot {
	out := make([]receivableSnapshot, 0, len(s.bookOrder))
	for _, e := range s.bookOrder {
		if e.currency != cur || e.openedDay > day {
			continue
		}
		if _, voided := s.voidedInvoices[e.invoiceID]; voided {
			continue
		}
		out = append(out, receivableSnapshot{
			id:      e.receivableID,
			balance: e.balanceAsOf(day),
			dueTime: e.dueTime,
		})
	}
	return out
}

// balanceAsOf returns the entry's balance at end of `day` from its
// transition history (last transition with day ≤ day; the first transition
// is the opening balance, so an entry opened ≤ day always has one).
func (e *bookEntry) balanceAsOf(day int64) int64 {
	var bal int64
	for _, tr := range e.transitions {
		if tr.day > day {
			break
		}
		bal = tr.balance
	}
	return bal
}

// collectedByDay returns the collected-per-day map of one receivable.
func (s *orgState) collectedByDay(receivableID string) map[int64]int64 {
	return s.collectedByReceivable[receivableID]
}

// collectedInWindow sums one receivable's collected amounts inside the
// inclusive [from, to] day window.
func (s *orgState) collectedInWindow(receivableID string, from, to int64) int64 {
	byDay := s.collectedByReceivable[receivableID]
	if byDay == nil {
		return 0
	}
	var sum int64
	for d, amt := range byDay {
		if d >= from && d <= to {
			sum += amt
		}
	}
	return sum
}

// collectedRefsInWindow returns the receivable ids with a collected amount
// inside the inclusive window, in canonical book order (deterministic).
func (s *orgState) collectedRefsInWindow(cur string, from, to int64) []string {
	var refs []string
	for _, e := range s.bookOrder {
		if e.currency != cur {
			continue
		}
		if _, voided := s.voidedInvoices[e.invoiceID]; voided {
			continue
		}
		if s.collectedInWindow(e.receivableID, from, to) > 0 {
			refs = append(refs, e.receivableID)
		}
	}
	return refs
}

// billedRefsInWindow returns the invoice ids billed inside the inclusive
// window for one currency, in canonical billing order (deterministic).
func (s *orgState) billedRefsInWindow(cur string, from, to int64) []string {
	var refs []string
	for _, inv := range s.invoiceOrder {
		if inv.currency == cur && inv.day >= from && inv.day <= to {
			refs = append(refs, inv.invoiceID)
		}
	}
	return refs
}
