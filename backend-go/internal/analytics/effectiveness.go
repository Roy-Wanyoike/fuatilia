package analytics

import "time"

// Effectiveness projection — the Go port of src/domain/projections/
// effectiveness.ts (issue #24, SPEC §66), ratio for ratio, refusal for
// refusal. Fixture tests (effectiveness_test.go) cite the TS spec fixtures
// they mirror.
//
// Ported rules (effectiveness.ts header):
//   - collectedVsBilled: Σ collected minor / Σ billed minor — a money ratio
//     reported as-is, NEVER clamped (ratios above 1 are legitimate).
//   - promiseKept / disputeRate: count ratios; in v1 BOTH are structurally
//     NULL-with-reason (no promise-made/kept event, no dispute event) —
//     the issue #89 labeling discipline, implemented as data.
//   - A figure that cannot be computed honestly is NULL WITH a reason —
//     never a silently misleading 0.
//   - Inclusive [from, to] window bounds (windowFacts).
//   - evidenceRefs: numerator contributors first, then denominator-only
//     contributors, input order, deduped.

// effectivenessWindow is the inclusive [start, end] day window (day-keyed:
// startDay and endDay are UTC epoch-day keys). The TS window is instant-based
// with inclusive bounds; the ingester's windows are day-aligned — facts enter
// the window when their event day is in [startDay, endDay].
type effectivenessWindow struct {
	startDay int64
	endDay   int64
}

// moneyRatioFigure is the row-shaped MoneyRatioFigure (effectiveness.ts):
// numerator/denominator as int64 minor units (the TS side keeps bigint;
// the wire carried safe integers), value as the float64 reporting figure
// or nil when not computable, with the reason alongside.
type moneyRatioFigure struct {
	value       *float64 // nil = not computable → reason says why
	reason      string
	numerator   int64
	denominator int64
	refs        []string
}

// countRatioFigure is the row-shaped CountRatioFigure.
type countRatioFigure struct {
	value       *float64
	reason      string
	numerator   int64
	denominator int64
	refs        []string
}

// evidenceRefs ports effectiveness.ts evidenceRefs: numerator contributors
// first, then denominator-only contributors, input order, deduped.
func evidenceRefs(numerator, denominator []string) []string {
	seen := make(map[string]struct{}, len(numerator)+len(denominator))
	refs := make([]string, 0, len(numerator)+len(denominator))
	for _, ref := range append(append([]string{}, numerator...), denominator...) {
		if _, dup := seen[ref]; dup {
			continue
		}
		seen[ref] = struct{}{}
		refs = append(refs, ref)
	}
	return refs
}

// collectedVsBilledFigure ports effectiveness.ts collectedVsBilled:
// value = collected/billed exactly when billed > 0, else nil with the
// verbatim TS reason. Division order matches the TS (Number(num)/Number(den))
// so the reporting float is reproducible.
func collectedVsBilledFigure(collected, billed int64, collectedRefs, billedRefs []string) moneyRatioFigure {
	refs := evidenceRefs(collectedRefs, billedRefs)
	if billed == 0 {
		return moneyRatioFigure{
			value:       nil,
			reason:      NullReasonNoBilledWindow,
			numerator:   collected,
			denominator: billed,
			refs:        refs,
		}
	}
	return moneyRatioFigure{
		value:       ratioValue(collected, billed),
		reason:      "",
		numerator:   collected,
		denominator: billed,
		refs:        refs,
	}
}

// promiseKeptFigureV1 is the v1-catalog-honest promise figure: always NULL
// with the structural reason (no promise-made/kept event — only
// collections.promiseBroken exists). The observable evidence (the broken
// count) is carried by the row's promises_broken column, not the figure.
// When the catalog grows the missing events, this function is the single
// place the real ratio lands (the schema does not change).
func promiseKeptFigureV1() countRatioFigure {
	return countRatioFigure{
		value:  nil,
		reason: NullReasonNoPromiseEvents,
	}
}

// disputeRateFigureV1 is the v1-catalog-honest dispute figure: always NULL
// with the structural reason (no dispute event in the v1 catalog).
func disputeRateFigureV1() countRatioFigure {
	return countRatioFigure{
		value:  nil,
		reason: NullReasonNoDisputeEvents,
	}
}

// dsoFigure computes the DSO reporting figure: ar / billedTrailing × window
// (the classic sales-weighted days-outstanding), reported as-is — never
// clamped. The division order is fixed (ratio first, then ×window) so the
// float is reproducible across replays.
func dsoFigure(arMinor, billedTrailingMinor int64, windowDays int64) *float64 {
	if billedTrailingMinor == 0 {
		return nil
	}
	v := float64(arMinor) / float64(billedTrailingMinor) * float64(windowDays)
	return &v
}

// ratioValue is the float64 the TS code computes with Number division; kept
// as a named function so the division discipline has exactly one home.
func ratioValue(numerator, denominator int64) *float64 {
	v := float64(numerator) / float64(denominator)
	return &v
}

// windowContains reports whether day is inside the inclusive window.
func windowContains(w effectivenessWindow, day int64) bool {
	return day >= w.startDay && day <= w.endDay
}

// endOfDayInstant is the as_of stamp for a day: the day's closing instant
// (UTC last millisecond) — the instant every figure of that day was measured
// at. Day-aligned windows close at the same instant, so dso_daily,
// aging_migration, collector_effectiveness and cohort_recovery agree for the
// same day.
func endOfDayInstant(day int64) time.Time {
	return time.Unix((day+1)*86400-1, int64(time.Millisecond)).UTC()
}

// dayStartInstant is the UTC midnight instant opening a day key.
func dayStartInstant(day int64) time.Time {
	return time.Unix(day*86400, 0).UTC()
}
