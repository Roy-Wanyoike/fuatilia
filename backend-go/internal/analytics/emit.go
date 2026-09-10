package analytics

import (
	"context"
	"sort"
	"time"
)

// Emission: the pure projection of fold state onto the SQL contract.
//
// Full-state re-emission: after every batch (and every rebuild) the org's
// affected projections are re-derived from CURRENT state and upserted —
// every key that exists in state is re-emitted with the current watermark.
// This is what makes replays byte-identical regardless of batching: the last
// batch's re-emission covers every key with final values, and
// ReplacingMergeTree(computed_at) collapses intermediate versions. Row keys
// are monotonic in the event stream (a key, once created, always exists),
// so no stale keys survive.
//
// Emission order is canonical everywhere (days ascending, currencies sorted,
// buckets in AGING_BUCKETS order, cohorts by month then currency, points
// ascending) — the SQL log itself is deterministic, which is what the
// golden files snapshot.

type emitter struct {
	ctx    context.Context
	driver Driver
	rows   int
}

func (e *emitter) exec(query string, args ...any) error {
	if err := e.driver.Exec(e.ctx, query, args...); err != nil {
		return err
	}
	e.rows++
	return nil
}

// emitProjections re-derives and upserts every projection row for the org.
func emitProjections(ctx context.Context, driver Driver, s *orgState) (int, error) {
	e := &emitter{ctx: ctx, driver: driver}
	watermark := s.watermark()

	for _, day := range s.activityDayList() {
		for _, cur := range s.currencies() {
			if err := e.emitDSO(s, cur, day, watermark); err != nil {
				return e.rows, err
			}
			if err := e.emitAging(s, cur, day, watermark); err != nil {
				return e.rows, err
			}
			if err := e.emitEffectiveness(s, cur, day, watermark); err != nil {
				return e.rows, err
			}
		}
	}
	if err := e.emitCohorts(s, watermark); err != nil {
		return e.rows, err
	}
	return e.rows, nil
}

// emitDSO writes the (org, currency, day) portfolio snapshot: closing AR,
// aging counts, trailing-window billed, and the DSO figure — NULL with a
// reason when the trailing window has no billed amount.
func (e *emitter) emitDSO(s *orgState, cur string, day int64, watermark time.Time) error {
	receivables := s.receivablesAt(cur, day)
	var ar int64
	var aged int
	var zero int
	var refs []string
	for _, rec := range receivables {
		if rec.balance == 0 {
			zero++
			continue
		}
		aged++
		ar += rec.balance
		refs = append(refs, rec.id)
	}
	billedTrailing := s.billedTrailing(cur, day, DSOWindowDays)
	dso := dsoFigure(ar, billedTrailing, DSOWindowDays)
	reason := ""
	if dso == nil {
		reason = NullReasonNoBilledTrailing
	}

	return e.exec(SQLInsertDSODaily,
		s.orgID,
		cur,
		dayStartInstant(day),   // day (Date)
		ar,                     // ar_balance_minor
		uint32(aged),           // receivables_aged
		uint32(zero),           // zero_balance_receivables
		billedTrailing,         // billed_trailing_minor
		uint32(DSOWindowDays),  // dso_window_days
		dso,                    // dso (Nullable(Float64)) — nil when not computable
		reason,                 // null_reason
		refs,                   // evidence_refs — receivables contributing to AR
		LabelDerivedFromEvents, // label
		endOfDayInstant(day),   // as_of
		watermark,              // computed_at
	)
}

// emitAging writes ALL FIVE bucket rows for the (org, currency, day) close,
// zero-filled, in AGING_BUCKETS order — the arAgingByBucket parity contract.
func (e *emitter) emitAging(s *orgState, cur string, day int64, watermark time.Time) error {
	asOf := endOfDayInstant(day)
	receivables := s.receivablesAt(cur, day)
	buckets, _ := dayCloseAging(asOf, receivables) // zero-balance count goes to the dso_daily row

	for _, bucket := range AGING_BUCKETS {
		acc := buckets[bucket]
		var amount int64
		var refs []string
		if acc != nil {
			amount = acc.amount
			refs = acc.refs
		}
		if err := e.exec(SQLInsertAgingMigration,
			s.orgID,
			cur,
			dayStartInstant(day),   // day (Date)
			bucket,                 // bucket
			amount,                 // amount_minor
			uint32(len(refs)),      // receivable_count
			refs,                   // evidence_refs — bucket contributors, input order
			LabelDerivedFromEvents, // label
			asOf,                   // as_of
			watermark,              // computed_at
		); err != nil {
			return err
		}
	}
	return nil
}

// emitEffectiveness writes the trailing-30-day effectiveness row for the
// (org, currency, window). Money figures are per currency (R10); the count
// figures are org-wide facts (counts have no currency) and identical across
// the org's currency rows — documented in 0004_collector_effectiveness.sql.
// promise_kept and dispute_rate are structurally NULL in v1 with reasons.
func (e *emitter) emitEffectiveness(s *orgState, cur string, day int64, watermark time.Time) error {
	window := effectivenessWindow{startDay: day - int64(DSOWindowDays) + 1, endDay: day}

	var collected int64
	for _, entry := range s.bookOrder {
		if entry.currency != cur {
			continue
		}
		if _, voided := s.voidedInvoices[entry.invoiceID]; voided {
			continue
		}
		collected += s.collectedInWindow(entry.receivableID, window.startDay, window.endDay)
	}
	billed := s.billedTrailing(cur, day, DSOWindowDays)

	figure := collectedVsBilledFigure(collected, billed,
		s.collectedRefsInWindow(cur, window.startDay, window.endDay),
		s.billedRefsInWindow(cur, window.startDay, window.endDay))

	var promisesBroken int64
	for d := window.startDay; d <= window.endDay; d++ {
		promisesBroken += s.promisesBrokenByDay[d]
	}
	kept := promiseKeptFigureV1()
	dispute := disputeRateFigureV1()

	return e.exec(SQLInsertCollectorEffectiveness,
		s.orgID,
		cur,
		dayStartInstant(window.startDay), // window_start (Date)
		dayStartInstant(window.endDay),   // window_end (Date)
		"",                               // collector_id — v1 events carry no collector attribution (0004 header)
		collected,                        // collected_minor
		billed,                           // billed_minor
		figure.value,                     // collected_vs_billed (Nullable)
		figure.reason,                    // collected_vs_billed_reason
		uint32(promisesBroken),           // promises_broken — the observable promise evidence
		kept.value,                       // promise_kept (Nullable) — structural NULL in v1
		kept.reason,                      // promise_kept_reason
		uint32(0),                        // disputes_raised — structurally 0 in v1
		dispute.value,                    // dispute_rate (Nullable) — structural NULL in v1
		dispute.reason,                   // dispute_rate_reason
		figure.refs,                      // evidence_refs — collected-side receivable ids, then billed invoice ids
		LabelDerivedFromEvents,           // label
		endOfDayInstant(window.endDay),   // as_of — the window end the figure is measured as of
		watermark,                        // computed_at
	)
}

// cohort is one (currency, opening month) group of receivables.
type cohort struct {
	month    int64 // UTC epoch-day of the month's first day
	currency string
	members  []*bookEntry // canonical book order
}

// emitCohorts writes every cohort's recovery curve points. Points are the
// cohort's collection-activity days plus the day-0 baseline (event-driven,
// never calendar-filled); the curve stops at the latest observed day — it
// NEVER extrapolates. Denominators are the full-state cohort originals,
// re-derived and re-upserted on every batch (0005 header).
func (e *emitter) emitCohorts(s *orgState, watermark time.Time) error {
	byKey := map[[2]string]*cohort{} // (month-day, currency) — string pair key for map use
	var order []*cohort
	for _, entry := range s.bookOrder {
		if entry.currency == "" {
			continue
		}
		if _, voided := s.voidedInvoices[entry.invoiceID]; voided {
			continue
		}
		month := cohortMonthStartDay(time.Unix(entry.openedDay*86400, 0).UTC())
		key := [2]string{formatDay(month), entry.currency}
		c, ok := byKey[key]
		if !ok {
			c = &cohort{month: month, currency: entry.currency}
			byKey[key] = c
			order = append(order, c)
		}
		c.members = append(c.members, entry)
	}
	// Canonical cohort order: month ascending, then currency.
	sort.Slice(order, func(i, j int) bool {
		if order[i].month != order[j].month {
			return order[i].month < order[j].month
		}
		return order[i].currency < order[j].currency
	})

	for _, c := range order {
		if err := e.emitCohort(s, c, watermark); err != nil {
			return err
		}
	}
	return nil
}

func (e *emitter) emitCohort(s *orgState, c *cohort, watermark time.Time) error {
	// Collection-activity days of this cohort's members (canonical point set).
	pointDays := map[int64]struct{}{0: {}} // day-0 baseline always present
	for _, m := range c.members {
		for d := range s.collectedByDay(m.receivableID) {
			if d >= c.month { // members cannot collect before the cohort opens
				pointDays[d-c.month] = struct{}{}
			}
		}
	}
	points := make([]int64, 0, len(pointDays))
	for p := range pointDays {
		points = append(points, p)
	}
	sortInt64s(points)

	var original int64
	var denominatorOnly []string
	for _, m := range c.members {
		original += m.original
	}
	for _, m := range c.members {
		if len(s.collectedByDay(m.receivableID)) > 0 {
			continue // numerator contributor — added per point below
		}
		denominatorOnly = append(denominatorOnly, m.receivableID)
	}

	var cumulative int64
	var collectedRefs []string
	prevPoint := int64(-1)
	for _, p := range points {
		// Money that landed on days in (prevPoint, p] joins the cumulative.
		for _, m := range c.members {
			byDay := s.collectedByDay(m.receivableID)
			for d, amt := range byDay {
				x := d - c.month
				if x > prevPoint && x <= p {
					cumulative += amt
					collectedRefs = appendUnique(collectedRefs, m.receivableID)
				}
			}
		}
		prevPoint = p

		rate := ratioValue(cumulative, original)
		reason := ""
		if original == 0 {
			rate = nil
			reason = NullReasonNoOriginal
		}
		refs := evidenceRefs(collectedRefs, denominatorOnly)

		asOfDay := c.month + p
		if err := e.exec(SQLInsertCohortRecovery,
			s.orgID,
			c.currency,
			dayStartInstant(c.month), // cohort_month (Date, first of month)
			uint32(p),                // days_since_open
			cumulative,               // collected_cumulative_minor
			original,                 // original_cumulative_minor (full-state cohort)
			rate,                     // recovery_rate (Nullable)
			reason,                   // null_reason
			refs,                     // evidence_refs — collected-side members, then denominator-only
			LabelDerivedFromEvents,
			endOfDayInstant(asOfDay), // as_of — the day the point was measured at
			watermark,                // computed_at
		); err != nil {
			return err
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// small deterministic helpers
// ---------------------------------------------------------------------------

func sortInt64s(v []int64) {
	sort.Slice(v, func(i, j int) bool { return v[i] < v[j] })
}

func appendUnique(refs []string, id string) []string {
	for _, r := range refs {
		if r == id {
			return refs
		}
	}
	return append(refs, id)
}

// formatDay renders a day key as YYYY-MM-DD (map-key use only).
func formatDay(day int64) string {
	return dayStartInstant(day).Format("2006-01-02")
}
