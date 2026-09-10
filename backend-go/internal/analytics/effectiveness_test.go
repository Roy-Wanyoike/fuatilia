package analytics

import (
	"strings"
	"testing"
	"time"
)

// Fixture tests for the effectiveness projection — the Go port of
// src/domain/projections/effectiveness.ts (issue #24, SPEC §66). Every test
// cites the effectiveness.spec.ts fixture it mirrors (issue #89 acceptance:
// "at least one fixture/property test per projection citing its TS source").

// TestCollectedVsBilledMatchesTSSpecStandardBook ports effectiveness.spec.ts
// "computes collected-vs-billed as a money ratio" (the standard book: 2
// billed — 1_000_000 + 500_000 — and one collection of 600_000):
//
//	numeratorMinor = 600_000, denominatorMinor = 1_500_000, value = 0.4 (exact)
//	evidenceRefs = [collected ref 10, billed refs 1, 2] — numerator first
func TestCollectedVsBilledMatchesTSSpecStandardBook(t *testing.T) {
	fig := collectedVsBilledFigure(
		600_000, 1_500_000,
		[]string{uid(10)},
		[]string{uid(1), uid(2)},
	)
	if fig.numerator != 600_000 || fig.denominator != 1_500_000 {
		t.Fatalf("numerator/denominator = %d/%d, want 600000/1500000 (effectiveness.spec.ts standard book)", fig.numerator, fig.denominator)
	}
	if fig.value == nil || *fig.value != 0.4 {
		t.Fatalf("value = %v, want exactly 0.4 (600k / 1.5M — effectiveness.spec.ts 'exact')", fig.value)
	}
	if fig.reason != "" {
		t.Errorf("reason = %q, want empty (figure computable)", fig.reason)
	}
	if got := fig.refs; len(got) != 3 || got[0] != uid(10) || got[1] != uid(1) || got[2] != uid(2) {
		t.Errorf("evidenceRefs = %v, want [10 1 2] — numerator contributors first, then denominator-only (effectiveness.spec.ts evidence fixture)", got)
	}
}

// TestCollectedVsBilledNeverClamps ports effectiveness.spec.ts "never clamps
// ratios above 1 — collecting pre-window invoices is legal": 1_500_000
// collected against 1_000_000 billed → 1.5, reported as-is.
func TestCollectedVsBilledNeverClamps(t *testing.T) {
	fig := collectedVsBilledFigure(1_500_000, 1_000_000, []string{uid(10)}, []string{uid(1)})
	if fig.value == nil || *fig.value != 1.5 {
		t.Fatalf("value = %v, want 1.5 unclamped (effectiveness.spec.ts no-clamp fixture)", fig.value)
	}
}

// TestCollectedVsBilledNullWithReason ports effectiveness.spec.ts "returns
// value:null WITH a reason when a figure cannot be computed honestly" —
// denominator 0 → value null, reason 'no billed amount in window' VERBATIM
// (the TS wording is the contract), numerator/denominator still reported.
func TestCollectedVsBilledNullWithReason(t *testing.T) {
	fig := collectedVsBilledFigure(600_000, 0, []string{uid(10)}, nil)
	if fig.value != nil {
		t.Fatalf("value = %v, want nil (zero billed — never a misleading 0)", fig.value)
	}
	if fig.reason != "no billed amount in window" {
		t.Errorf("reason = %q, want verbatim 'no billed amount in window' (effectiveness.spec.ts)", fig.reason)
	}
	if fig.numerator != 600_000 || fig.denominator != 0 {
		t.Errorf("numerator/denominator = %d/%d, want 600000/0 (carried alongside the null)", fig.numerator, fig.denominator)
	}
}

// TestCollectedVsBilledRealZero ports effectiveness.spec.ts "never fakes a
// 0: a billed-only window keeps collectedVsBilled a REAL zero": 0 collected /
// 1 billed → 0 (a real zero, not a null).
func TestCollectedVsBilledRealZero(t *testing.T) {
	fig := collectedVsBilledFigure(0, 1_000_000, nil, []string{uid(1)})
	if fig.value == nil || *fig.value != 0 {
		t.Fatalf("value = %v, want a real 0 (0 collected / 1 billed — effectiveness.spec.ts)", fig.value)
	}
	if fig.reason != "" {
		t.Errorf("reason = %q, want empty", fig.reason)
	}
}

// TestEvidenceRefsDeduped ports effectiveness.spec.ts "dedupes evidence refs
// shared between numerator and denominator": the same opaque id on both
// sides appears once, in numerator position.
func TestEvidenceRefsDeduped(t *testing.T) {
	got := evidenceRefs([]string{uid(1)}, []string{uid(1), uid(2)})
	if len(got) != 2 || got[0] != uid(1) || got[1] != uid(2) {
		t.Fatalf("evidenceRefs = %v, want [1 2] deduped, input order (effectiveness.spec.ts dedupe fixture)", got)
	}
	// Empty inputs yield an empty (non-nil in the TS sense) list.
	if got := evidenceRefs(nil, nil); len(got) != 0 {
		t.Errorf("evidenceRefs(nil, nil) = %v, want empty", got)
	}
}

// TestStructuralV1NullsAreHonest pins the v1-catalog structural NULLs
// (issue #89 labeling discipline, 0004_collector_effectiveness.sql):
// promise_kept and dispute_rate are NULL ALWAYS with their prose reasons —
// never 0 — because the v1 event catalog has no promise-made/kept event
// (only collections.promiseBroken) and no dispute event. The reasons are
// data: the figures light up without a schema change when the catalog grows.
func TestStructuralV1NullsAreHonest(t *testing.T) {
	kept := promiseKeptFigureV1()
	if kept.value != nil {
		t.Errorf("promise_kept value = %v, want structurally nil in v1 (no promise-made/kept event)", kept.value)
	}
	if !strings.Contains(kept.reason, "no promise-made/kept event in the v1 event catalog") {
		t.Errorf("promise_kept reason %q must carry the structural explanation (0004 header wording)", kept.reason)
	}
	dispute := disputeRateFigureV1()
	if dispute.value != nil {
		t.Errorf("dispute_rate value = %v, want structurally nil in v1 (no dispute event)", dispute.value)
	}
	if dispute.reason != "no dispute event in the v1 event catalog" {
		t.Errorf("dispute_rate reason = %q, want the structural explanation", dispute.reason)
	}
}

// TestDSOFigureWindowMath pins the DSO figure: ar / billedTrailing × window,
// NULL exactly when billedTrailing = 0 with the DSO reason (0002 header:
// "DSO against zero sales is meaningless"), never clamped — collecting
// faster than you bill is a real, reportable state.
func TestDSOFigureWindowMath(t *testing.T) {
	if got := dsoFigure(1_500_000, 1_000_000, DSOWindowDays); got == nil || *got != 45.0 {
		t.Errorf("dsoFigure(1.5M, 1.0M, 30) = %v, want 45 (1.5 × 30)", got)
	}
	// A book that collected faster than it bills: AR below trailing sales →
	// small DSO; and an over-collected book cannot exceed the window span
	// here by construction, but the formula stays unclamped either way.
	if got := dsoFigure(100, 1_000_000, DSOWindowDays); got == nil || *got <= 0 {
		t.Errorf("dsoFigure small positive = %v, want > 0 unclamped", got)
	}
	if got := dsoFigure(5_000_000, 0, DSOWindowDays); got != nil {
		t.Errorf("dsoFigure(*, 0, *) = %v, want nil with reason (0002 null-with-reason)", got)
	}
	if NullReasonNoBilledTrailing == "" {
		t.Error("DSO null reason must be non-empty prose (never a silent NULL)")
	}
}

// TestEffectivenessWindowBoundsInclusive ports effectiveness.spec.ts
// "includes facts dated exactly at from and at to; excludes 1ms outside" —
// the Go window is day-aligned, so the inclusive-bound property is asserted
// on day keys: [day-29, day] for the 30-day trailing window.
func TestEffectivenessWindowBoundsInclusive(t *testing.T) {
	day := dayKey(at(100, 0))
	w := effectivenessWindow{startDay: day - int64(DSOWindowDays) + 1, endDay: day}
	if !windowContains(w, w.startDay) || !windowContains(w, w.endDay) {
		t.Fatal("window bounds must be inclusive (effectiveness.spec.ts inclusive-window fixture)")
	}
	if windowContains(w, w.startDay-1) || windowContains(w, w.endDay+1) {
		t.Fatal("facts 1 day outside the window must be excluded")
	}
	if w.startDay != day-29 {
		t.Fatalf("30-day window start = %d, want day-29 (0004 header: [day − 29, day] inclusive)", w.startDay)
	}
}

// TestEffectivenessRowThroughSQLContract is the end-to-end fixture: the
// effectiveness.spec.ts standard book driven through IngestBatch — the
// emitted collector_effectiveness row must carry the TS figures (600k/1.5M →
// 0.4, numerator-first evidence), the org-wide broken-promise count, the two
// structural NULLs with reasons, label + as_of + deterministic computed_at.
func TestEffectivenessRowThroughSQLContract(t *testing.T) {
	org := testOrgA
	invoice1, invoice2 := uid(1), uid(2)
	rec1 := uid(20)
	promiseID, caseID := uid(30), uid(31)

	// Day 10: invoice 1 (1_000_000) + receivable 1. Day 45: invoice 2
	// (500_000). Day 60: partial settlement 600_000 (remaining 400_000).
	// Day 70: a broken promise (an activity day of its own).
	driver := newFakeDriver()
	ing, err := New(newStubConsumer(), driver, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	day := func(n int) time.Time { return at(n, 0) }
	ingestAll(t, ing, [][]byte{
		envWire(org, "invoicing.invoiceIssued", 1, day(10), pInvoiceIssued(invoice1, 1_000_000, "KES", "2025-01-25")),
		envWire(org, "receivable.opened", 2, day(10).Add(time.Second), pReceivableOpened(rec1, invoice1, 1_000_000, "2025-01-25")),
		envWire(org, "invoicing.invoiceIssued", 3, day(45), pInvoiceIssued(invoice2, 500_000, "KES", "2025-02-20")),
		envWire(org, "receivable.partiallySettled", 4, day(60), pPartiallySettled(rec1, 600_000, 400_000)),
		envWire(org, "collections.promiseBroken", 5, day(70), pPromiseBroken(promiseID, caseID, day(65))),
	})

	// The day-60 window is [day 31, day 60]: billed 500_000 (invoice 2),
	// collected 600_000 against pre-window invoice 1's receivable — legal,
	// no-clamp → 1.2. The day-70 window is [day 41, day 70]: the broken
	// promise lands inside it. The TS-mirrored 0.4 standard-book figure is
	// pinned on the ported figure function above.
	rows := driver.projRows[TableCollectorEffectiveness]
	var row []any
	for _, args := range rows {
		if args[3].(time.Time) == dayStartInstant(dayKey(day(60))) { // window_end
			row = args
		}
	}
	if row == nil {
		t.Fatal("no collector_effectiveness row for window_end day 60")
	}
	if row[1].(string) != "KES" || row[4].(string) != "" {
		t.Errorf("currency/collector_id = %q/%q, want KES/'' (v1 carries no collector attribution — 0004 header)", row[1].(string), row[4].(string))
	}
	if got := row[5].(int64); got != 600_000 {
		t.Errorf("collected_minor = %d, want 600000 (effectiveness.spec.ts standard-book collection)", got)
	}
	if got := row[6].(int64); got != 500_000 {
		t.Errorf("billed_minor = %d, want 500000 (only invoice 2 is inside [day 31, day 60])", got)
	}
	if got := row[7].(*float64); got == nil || *got != 1.2 {
		t.Errorf("collected_vs_billed = %v, want 1.2 unclamped (600k/500k — collecting a pre-window invoice is legal)", got)
	}
	if got := row[8].(string); got != "" {
		t.Errorf("collected_vs_billed_reason = %q, want empty", got)
	}
	if got := row[9].(uint32); got != 0 {
		t.Errorf("promises_broken = %d, want 0 (the day-70 break is outside this [31,60] window — counts are window-scoped)", got)
	}
	if got := row[10].(*float64); got != nil {
		t.Errorf("promise_kept = %v, want structural nil (v1 catalog)", got)
	}
	if row[11].(string) == "" {
		t.Error("promise_kept_reason must carry the structural reason")
	}
	if got := row[12].(uint32); got != 0 {
		t.Errorf("disputes_raised = %d, want 0 (structurally — no dispute event exists)", got)
	}
	if got := row[13].(*float64); got != nil {
		t.Errorf("dispute_rate = %v, want structural nil", got)
	}
	if row[14].(string) == "" {
		t.Error("dispute_rate_reason must carry the structural reason")
	}
	// Evidence: numerator (collected) receivable first, then billed invoice.
	refs := row[15].([]string)
	if len(refs) != 2 || refs[0] != rec1 || refs[1] != invoice2 {
		t.Errorf("evidence_refs = %v, want [%s %s] — numerator first (effectiveness.spec.ts evidence shape)", refs, rec1, invoice2)
	}
	if row[16].(string) != LabelDerivedFromEvents {
		t.Errorf("label = %q, want %q", row[16].(string), LabelDerivedFromEvents)
	}
	if got := row[17].(time.Time); got != endOfDayInstant(dayKey(day(60))) {
		t.Errorf("as_of = %v, want day-60 closing instant (the window end — effectiveness.ts asOf)", got)
	}
	if got := row[18].(time.Time); got != day(70) {
		t.Errorf("computed_at = %v, want %v (the watermark: last canonical event's created_at)", got, day(70))
	}

	// The day-70 window [41, 70] carries the broken promise as observable
	// evidence (promises_broken = 1) while promise_kept stays structurally
	// NULL — the observable count is the row's evidence, not the figure.
	var row70 []any
	for _, args := range rows {
		if args[3].(time.Time) == dayStartInstant(dayKey(day(70))) {
			row70 = args
		}
	}
	if row70 == nil {
		t.Fatal("no collector_effectiveness row for window_end day 70")
	}
	if got := row70[9].(uint32); got != 1 {
		t.Errorf("day-70 promises_broken = %d, want 1 (effectiveness.ts discipline: carry the observable evidence alongside the structural null)", got)
	}
	if got := row70[10].(*float64); got != nil {
		t.Errorf("day-70 promise_kept = %v, want nil (still no promise-made/kept event)", got)
	}
}
