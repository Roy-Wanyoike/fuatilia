package scheduler

// Parity tests for the late-fee port — every table below is the TypeScript
// spec's own fixture table, cited per test:
//
//	SOURCE: src/domain/receivables/late-fee.ts       (the ported module)
//	SPEC:   src/domain/receivables/late-fee.spec.ts  (the fixture tables)
//
// A change to either side that these tests do not pin is a parity break.

import (
	"strings"
	"testing"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// SPEC fixtures: REC uid(3), DUE 2025-03-01, PERCENT_POLICY bps 333 grace 5,
// FLAT_POLICY 500 minor grace 5, NOW = +15 days (beyond grace).
const (
	lateFeeReceivableID = "00000000-0000-4000-8000-000000000003"
	lateFeeDueISO       = "2025-03-01T00:00:00.000Z"
	lateFeeNowISO       = "2025-03-16T00:00:00.000Z" // 15 days past due
)

func percentPolicy333Grace5() LateFeePolicy {
	bps := 333
	return LateFeePolicy{Kind: LateFeePercent, PercentBps: &bps, GraceDays: 5}
}

func flatPolicy500Grace5() LateFeePolicy {
	flat := int64(500)
	return LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &flat, GraceDays: 5}
}

// owing mirrors the SPEC owing() fixture: overdue, state open, 123457 KES
// outstanding.
func owing(over func(*LateFeeReceivableLike)) LateFeeReceivableLike {
	original, err := money.New(123_457, money.KES)
	if err != nil {
		panic(err)
	}
	applied, err := money.Zero(money.KES)
	if err != nil {
		panic(err)
	}
	rec := LateFeeReceivableLike{
		ID:       lateFeeReceivableID,
		Currency: money.KES,
		DueDate:  mustTimeT(lateFeeDueISO),
		Overdue:  true,
		Original: original,
		Applied:  applied,
		State:    "open",
	}
	if over != nil {
		over(&rec)
	}
	return rec
}

func accrualOptions(nowISO string) LateFeeAccrualOptions {
	return LateFeeAccrualOptions{PeriodKey: "2025-03", Now: mustTimeT(nowISO)}
}

// SPEC: 'validateLateFeePolicy' refusal table. The non-integer rows
// (flatMinor 10.5, percentBps 33.3, capMinor 1.5, graceDays 1.5) are
// unrepresentable in Go's typed int/int64 fields — the compile-time boundary
// IS that validation; every representable row is pinned here.
func TestValidateLateFeePolicyRefusals(t *testing.T) {
	bps := 100
	flat := int64(500)
	negBps := -333
	negFlat := int64(-500)
	negCap := int64(-1)
	table := []struct {
		name   string
		policy LateFeePolicy
		code   string
	}{
		{"kind is neither flat nor percent", LateFeePolicy{Kind: "linear", PercentBps: &bps, GraceDays: 5}, CodeLateFeePolicyKindInvalid},
		{"both flat and percent supplied", LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &flat, PercentBps: &bps, GraceDays: 5}, CodeLateFeePolicyFlatAndPercent},
		{"kind 'flat' without flatMinor", LateFeePolicy{Kind: LateFeeFlat, GraceDays: 5}, CodeLateFeePolicyFlatRequired},
		{"kind 'percent' without percentBps", LateFeePolicy{Kind: LateFeePercent, GraceDays: 5}, CodeLateFeePolicyPercentRequired},
		{"negative flatMinor", LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &negFlat, GraceDays: 5}, CodeLateFeePolicyFlatInvalid},
		{"negative percentBps", LateFeePolicy{Kind: LateFeePercent, PercentBps: &negBps, GraceDays: 5}, CodeLateFeePolicyBpsInvalid},
		{"negative capMinor", LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &flat, CapMinor: &negCap, GraceDays: 5}, CodeLateFeePolicyCapInvalid},
		{"negative graceDays", LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &flat, GraceDays: -1}, CodeLateFeePolicyGraceInvalid},
	}
	for _, tc := range table {
		_, err := ValidateLateFeePolicy(tc.policy)
		if err == nil {
			t.Fatalf("%s: expected %s, got nil", tc.name, tc.code)
		}
		expectCode(t, err, tc.code)
	}
}

// SPEC: 'accepts the boundaries and resolves to canonical minor units'.
func TestValidateLateFeePolicyBoundaries(t *testing.T) {
	zeroFlat := int64(0)
	zeroCap := int64(0)
	zeroBps := 0
	flat, err := ValidateLateFeePolicy(LateFeePolicy{Kind: LateFeeFlat, FlatMinor: &zeroFlat, CapMinor: &zeroCap})
	if err != nil {
		t.Fatal(err)
	}
	if flat.Kind != LateFeeFlat || flat.FlatMinor == nil || *flat.FlatMinor != 0 || flat.PercentBps != nil || flat.CapMinor == nil || *flat.CapMinor != 0 || flat.GraceDays != 0 {
		t.Fatalf("flat resolution mismatch: %+v", flat)
	}
	percent, err := ValidateLateFeePolicy(LateFeePolicy{Kind: LateFeePercent, PercentBps: &zeroBps})
	if err != nil {
		t.Fatal(err)
	}
	if percent.FlatMinor != nil || percent.PercentBps == nil || *percent.PercentBps != 0 || percent.CapMinor != nil {
		t.Fatalf("percent resolution mismatch: %+v", percent)
	}
}

// SPEC: 'accrueLateFee — eligibility'.
func TestAccrueLateFeeEligibility(t *testing.T) {
	// Refuses a receivable that is neither flagged overdue nor past due.
	_, err := AccrueLateFee(owing(func(r *LateFeeReceivableLike) { r.Overdue = false }), percentPolicy333Grace5(),
		accrualOptions("2025-02-20T00:00:00.000Z"))
	expectCode(t, err, CodeLateFeeNotOverdue)

	// Accrues on the past-due date alone (flag not yet set — flag OR past-due);
	// SPEC pins 4111 minor for bps 333 on 123457.
	result, err := AccrueLateFee(owing(func(r *LateFeeReceivableLike) { r.Overdue = false }), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeAccrued || result.Fee.Amount.Amount() != 4111 {
		t.Fatalf("past-due-date accrual = %s %d", result.Outcome, result.Fee.Amount.Amount())
	}

	// Refuses while exactly at the grace boundary (5 full days) and while
	// still inside grace one millisecond before day 6.
	for _, now := range []string{"2025-03-06T00:00:00.000Z", "2025-03-06T23:59:59.999Z"} {
		_, err := AccrueLateFee(owing(nil), percentPolicy333Grace5(), accrualOptions(now))
		expectCode(t, err, CodeLateFeeWithinGrace)
	}

	// Accrues on the first day after the grace window (graceDays + 1).
	result, err = AccrueLateFee(owing(nil), percentPolicy333Grace5(), accrualOptions("2025-03-07T00:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomeAccrued || result.Fee.DaysLate != 6 {
		t.Fatalf("first-day-after-grace: %s daysLate=%d", result.Outcome, result.Fee.DaysLate)
	}

	// Respects the grace window even when the stored overdue flag is set.
	_, err = AccrueLateFee(owing(nil), percentPolicy333Grace5(), accrualOptions("2025-03-03T00:00:00.000Z"))
	expectCode(t, err, CodeLateFeeWithinGrace)

	// Refuses settled / written-off / voided debts (not live receivables).
	for _, state := range []string{"settled", "written_off", "voided"} {
		_, err := AccrueLateFee(owing(func(r *LateFeeReceivableLike) { r.State = state }), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
		expectCode(t, err, CodeLateFeeReceivableNotLive)
	}

	// Refuses a fully applied (zero-balance) receivable.
	_, err = AccrueLateFee(owing(func(r *LateFeeReceivableLike) {
		r.Applied = mustMoney(123_457, money.KES)
	}), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
	expectCode(t, err, CodeLateFeeZeroBalance)

	// Requires a non-blank periodKey.
	_, err = AccrueLateFee(owing(nil), percentPolicy333Grace5(), LateFeeAccrualOptions{PeriodKey: "   ", Now: mustTimeT(lateFeeNowISO)})
	expectCode(t, err, CodeLateFeePeriodKeyRequired)
}

func mustMoney(amount int64, currency money.Currency) money.Money {
	m, err := money.New(amount, currency)
	if err != nil {
		panic(err)
	}
	return m
}

// SPEC: 'accrueLateFee — amount computation' (flat verbatim, percent floor
// table, cap table).
func TestAccrueLateFeeAmounts(t *testing.T) {
	// Charges the flat amount verbatim.
	result, err := AccrueLateFee(owing(nil), flatPolicy500Grace5(), accrualOptions(lateFeeNowISO))
	if err != nil {
		t.Fatal(err)
	}
	if result.Fee.Amount.Amount() != 500 || result.Fee.Amount.Currency() != money.KES {
		t.Fatalf("flat fee = %s", result.Fee.Amount)
	}

	// Percent bps=333 rounds DOWN to the cent (floor division).
	for _, tc := range []struct{ balance, want int64 }{
		{123_457, 4111}, // 123457 × 333 / 10000 = 4111.1181 → 4111
		{9_999, 332},    //  9999 × 333 / 10000 =  332.9667 →  332
		{10_001, 333},   // 10001 × 333 / 10000 =  333.0333 →  333
		{1, 0},          // rounds down to nothing — a legal zero fee
	} {
		got, err := AccrueLateFee(owing(func(r *LateFeeReceivableLike) {
			r.Original = mustMoney(tc.balance, money.KES)
		}), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
		if err != nil {
			t.Fatalf("balance %d: %v", tc.balance, err)
		}
		if got.Outcome != OutcomeAccrued || got.Fee.Amount.Amount() != tc.want {
			t.Fatalf("balance %d: fee %d, want %d", tc.balance, got.Fee.Amount.Amount(), tc.want)
		}
	}

	// Cap table: percent capped, flat capped, below-cap unchanged, cap 0.
	caps := []struct {
		policy LateFeePolicy
		cap    int64
		want   int64
	}{
		{percentPolicy333Grace5(), 1_000, 1_000}, // uncapped would be 4111
		{flatPolicy500Grace5(), 100, 100},
		{flatPolicy500Grace5(), 1_000, 500},
		{flatPolicy500Grace5(), 0, 0},
	}
	for _, tc := range caps {
		policy := tc.policy
		policy.CapMinor = &tc.cap
		got, err := AccrueLateFee(owing(nil), policy, accrualOptions(lateFeeNowISO))
		if err != nil {
			t.Fatalf("cap %d: %v", tc.cap, err)
		}
		if got.Fee.Amount.Amount() != tc.want {
			t.Fatalf("cap %d: fee %d, want %d", tc.cap, got.Fee.Amount.Amount(), tc.want)
		}
	}
}

// SPEC: 'accrueLateFee — idempotency per (receivableId, periodKey)' (H4).
func TestAccrueLateFeeIdempotency(t *testing.T) {
	// Never double-charges: re-running the same period returns already_accrued
	// with no events.
	first, err := AccrueLateFee(owing(nil), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
	if err != nil || first.Outcome != OutcomeAccrued || len(first.Events) != 1 {
		t.Fatalf("first accrual: %+v %v", first, err)
	}
	opts := accrualOptions(lateFeeNowISO)
	opts.PreviouslyAccruedPeriodKeys = []string{"2025-03"}
	second, err := AccrueLateFee(owing(nil), percentPolicy333Grace5(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if second.Outcome != OutcomeAlreadyAccrued || len(second.Events) != 0 {
		t.Fatalf("re-run outcome = %s events = %d", second.Outcome, len(second.Events))
	}
	if second.Fee.Amount.Amount() != first.Fee.Amount.Amount() {
		t.Fatalf("re-run fee %d ≠ first fee %d", second.Fee.Amount.Amount(), first.Fee.Amount.Amount())
	}

	// Returns the SAME fee verbatim when the posted row is supplied — even if
	// the balance changed (a payment landed between the two accrual runs).
	paidDown := owing(func(r *LateFeeReceivableLike) { r.Applied = mustMoney(100_000, money.KES) })
	opts = accrualOptions(lateFeeNowISO)
	opts.PreviouslyAccruedFees = []LateFee{first.Fee}
	verbatim, err := AccrueLateFee(paidDown, percentPolicy333Grace5(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if verbatim.Outcome != OutcomeAlreadyAccrued || len(verbatim.Events) != 0 {
		t.Fatalf("verbatim re-run: %s %d events", verbatim.Outcome, len(verbatim.Events))
	}
	if verbatim.Fee.Amount.Amount() != first.Fee.Amount.Amount() || verbatim.Fee.PeriodKey != first.Fee.PeriodKey {
		t.Fatalf("verbatim fee drifted: %+v vs %+v", verbatim.Fee, first.Fee)
	}

	// Stays safe on a keys-only re-run after the receivable settled (marker,
	// no throw, no charge, zero amount).
	settled := owing(func(r *LateFeeReceivableLike) {
		r.Applied = mustMoney(123_457, money.KES)
		r.State = "settled"
		r.Overdue = false
	})
	opts = accrualOptions(lateFeeNowISO)
	opts.PreviouslyAccruedPeriodKeys = []string{"2025-03"}
	marker, err := AccrueLateFee(settled, percentPolicy333Grace5(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if marker.Outcome != OutcomeAlreadyAccrued || !marker.Fee.Amount.IsZero() || len(marker.Events) != 0 {
		t.Fatalf("settled marker: %+v", marker)
	}

	// Accrues again for a DIFFERENT periodKey (period-scoped, not
	// one-fee-forever).
	opts = accrualOptions(lateFeeNowISO)
	opts.PreviouslyAccruedPeriodKeys = []string{"2025-02"}
	march, err := AccrueLateFee(owing(nil), percentPolicy333Grace5(), opts)
	if err != nil {
		t.Fatal(err)
	}
	if march.Outcome != OutcomeAccrued || len(march.Events) != 1 {
		t.Fatalf("different period: %s %d events", march.Outcome, len(march.Events))
	}
}

// SPEC: 'accrueLateFee — event and posting-matrix hook'.
func TestAccrueLateFeeEventAndPosting(t *testing.T) {
	result, err := AccrueLateFee(owing(nil), percentPolicy333Grace5(), accrualOptions(lateFeeNowISO))
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Events) != 1 {
		t.Fatalf("expected exactly one event, got %d", len(result.Events))
	}
	ev := result.Events[0]
	if ev.Type != "receivable.lateFeeAccrued" || ev.Version != 1 || ev.AggregateID != lateFeeReceivableID {
		t.Fatalf("envelope mismatch: %+v", ev)
	}
	if iso(ev.OccurredAt) != lateFeeNowISO {
		t.Fatalf("occurredAt = %s, want %s", iso(ev.OccurredAt), lateFeeNowISO)
	}
	payload := payloadMap(t, ev)
	for k, want := range map[string]any{
		"receivableId": lateFeeReceivableID,
		"periodKey":    "2025-03",
		"amountMinor":  float64(4111),
		"currency":     "KES",
		"policyKind":   "percent",
		"percentBps":   float64(333),
		"balanceMinor": float64(123_457),
		"daysLate":     float64(15),
		"graceDays":    float64(5),
	} {
		if got := payload[k]; got != want {
			t.Fatalf("payload[%s] = %v, want %v", k, got, want)
		}
	}
	if got := payload["flatMinor"]; got != nil {
		t.Fatalf("payload[flatMinor] = %v, want null", got)
	}
	posting, ok := payload["posting"].(map[string]any)
	if !ok || posting["debit"] != "ar_control" || posting["credit"] != "fee_income" {
		t.Fatalf("posting hook mismatch: %v", payload["posting"])
	}
	// The fee row carries the same posting hook + idempotency scope.
	fee := result.Fee
	if fee.Posting != feePosting {
		t.Fatalf("fee posting = %+v", fee.Posting)
	}
	if fee.ReceivableID != lateFeeReceivableID || fee.PeriodKey != "2025-03" {
		t.Fatalf("fee scope = %s/%s", fee.ReceivableID, fee.PeriodKey)
	}
	if !fee.AccruedAt.Equal(mustTimeT(lateFeeNowISO)) {
		t.Fatalf("accruedAt = %s", iso(fee.AccruedAt))
	}

	// Flat row exposes its policy fields (SPEC 'exposes the fee row ...').
	flatResult, err := AccrueLateFee(owing(nil), flatPolicy500Grace5(), accrualOptions(lateFeeNowISO))
	if err != nil {
		t.Fatal(err)
	}
	fee = flatResult.Fee
	if fee.PolicyKind != LateFeeFlat || fee.FlatMinor == nil || *fee.FlatMinor != 500 || fee.PercentBps != nil || fee.BalanceMinor != 123_457 {
		t.Fatalf("flat fee row = %+v", fee)
	}
}

// WholeDaysLate parity (late-fee.ts wholeDaysLate — elapsed-ms flooring,
// clamped at 0): partial days floor, future dues clamp.
func TestWholeDaysLate(t *testing.T) {
	due := mustTimeT(lateFeeDueISO)
	table := []struct {
		now  string
		want int
	}{
		{"2025-02-28T00:00:00.000Z", 0},  // before due — never negative
		{"2025-03-01T00:00:00.000Z", 0},  // due date today
		{"2025-03-01T12:00:00.000Z", 0},  // half a day late is still day 0
		{"2025-03-02T00:00:00.000Z", 1},  // day boundary at midnight
		{"2025-03-16T00:00:00.000Z", 15}, // the SPEC's NOW
		{"2025-03-06T23:59:59.999Z", 5},  // one ms before day 6
		{"2025-03-07T00:00:00.000Z", 6},  // day 6 exactly
	}
	for _, tc := range table {
		if got := WholeDaysLate(due, mustTimeT(tc.now)); got != tc.want {
			t.Fatalf("wholeDaysLate(%s) = %d, want %d", tc.now, got, tc.want)
		}
	}
}

// safeInt refuses amounts beyond the JSON safe-integer range
// (EVENT_AMOUNT_NOT_SAFE_INTEGER — events.ts minorToNumber).
func TestSafeIntGuard(t *testing.T) {
	if _, err := safeInt(9007199254740991); err != nil {
		t.Fatalf("max safe integer refused: %v", err)
	}
	_, err := safeInt(9007199254740992)
	expectCode(t, err, "EVENT_AMOUNT_NOT_SAFE_INTEGER")
	if !strings.Contains(err.Error(), "safe-integer") {
		t.Fatalf("error message lost context: %v", err)
	}
}
