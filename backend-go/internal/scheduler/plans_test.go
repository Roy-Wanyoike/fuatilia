package scheduler

// Parity tests for the payment-plan execution port — the fixture tables are
// the TypeScript spec's own, cited per test:
//
//      SOURCE: src/domain/receivables/payment-plan.ts        (the ported module)
//      SPEC:   src/domain/receivables/payment-plan.spec.ts   (the fixture tables)
//
// The schedule-creation side (buildSchedule's Money.allocate split and
// month-end-clamped due dates) is not a scheduler concern — the schedule
// already lives in payment_plans + installments (db/migrations/0010) — so the
// fixtures here reuse the spec's SCHEDULED PLAN shape: 3 installments due
// Feb 28 / Mar 31 / Apr 30, amounts 3334/3333/3333 (the spec's cent-exact
// split of 10_000 into 3).

import (
	"testing"
)

var specScheduledPlan = []PlanInstallment{
	{No: 1, DueDate: mustTimeT("2025-02-28T00:00:00.000Z"), AmountMinor: 3334, PaidMinor: 0},
	{No: 2, DueDate: mustTimeT("2025-03-31T00:00:00.000Z"), AmountMinor: 3333, PaidMinor: 0},
	{No: 3, DueDate: mustTimeT("2025-04-30T00:00:00.000Z"), AmountMinor: 3333, PaidMinor: 0},
}

// SPEC: 'plan state machine — defaults' → 'defaults an active plan once an
// unpaid installment is overdue by the policy days' (installment 1 due Feb 28
// → 10 days late on Mar 10; payload carries the trigger evidence).
func TestFindDefaultTriggerSpecDefault(t *testing.T) {
	trigger, err := FindDefaultTrigger(specScheduledPlan, 7, mustTimeT("2025-03-10T00:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	if trigger.InstallmentNo != 1 || trigger.DaysOverdue != 10 {
		t.Fatalf("trigger = %+v, want installment 1 at 10 days", trigger)
	}
}

// SPEC: 'defaults at exactly N overdue days and refuses at N−1'.
func TestFindDefaultTriggerBoundary(t *testing.T) {
	atThreshold, err := FindDefaultTrigger(specScheduledPlan, 7, mustTimeT("2025-03-07T00:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	if atThreshold.DaysOverdue != 7 {
		t.Fatalf("at-threshold daysOverdue = %d, want 7", atThreshold.DaysOverdue)
	}
	_, err = FindDefaultTrigger(specScheduledPlan, 7, mustTimeT("2025-03-06T23:59:59.999Z"))
	expectCode(t, err, CodePaymentPlanNotDefaultable)
}

// SPEC: 'ignores fully-paid (even very late) installments when looking for a
// default trigger' — installment 1 fully paid, plan defaults on installment 2
// once IT crosses the threshold.
func TestFindDefaultTriggerIgnoresFullyPaid(t *testing.T) {
	partiallyPaid := []PlanInstallment{
		{No: 1, DueDate: mustTimeT("2025-02-28T00:00:00.000Z"), AmountMinor: 3334, PaidMinor: 3334},
		{No: 2, DueDate: mustTimeT("2025-03-31T00:00:00.000Z"), AmountMinor: 3333, PaidMinor: 0},
		{No: 3, DueDate: mustTimeT("2025-04-30T00:00:00.000Z"), AmountMinor: 3333, PaidMinor: 0},
	}
	_, err := FindDefaultTrigger(partiallyPaid, 7, mustTimeT("2025-04-02T00:00:00.000Z"))
	expectCode(t, err, CodePaymentPlanNotDefaultable)
	// Once installment 2 crosses the threshold, the plan defaults on IT.
	trigger, err := FindDefaultTrigger(partiallyPaid, 7, mustTimeT("2025-04-08T00:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	if trigger.InstallmentNo != 2 {
		t.Fatalf("trigger installment = %d, want 2", trigger.InstallmentNo)
	}
	// SPEC: unpaidInstallmentsOf(partiallyPaid) = [2, 3].
	unpaid := UnpaidInstallments(partiallyPaid)
	if len(unpaid) != 2 || unpaid[0].No != 2 || unpaid[1].No != 3 {
		t.Fatalf("unpaid = %d installments, want [2 3]", len(unpaid))
	}
}

// SPEC: 'refuses a negative defaultAfterDays policy' (the non-integer row
// 0.5 is unrepresentable in Go's typed int field).
func TestFindDefaultTriggerPolicyRefusal(t *testing.T) {
	_, err := FindDefaultTrigger(specScheduledPlan, -1, mustTimeT("2025-03-10T00:00:00.000Z"))
	expectCode(t, err, CodePaymentPlanDefaultPolicyInvalid)
}

// day-N-counts arithmetic (payment-plan.ts daysLateOf): whole floored days
// past the due date, clamped at 0 — same elapsed-day flooring as late-fee.ts.
func TestPlanDaysLateOf(t *testing.T) {
	inst := PlanInstallment{No: 1, DueDate: mustTimeT("2025-02-28T00:00:00.000Z"), AmountMinor: 3334}
	for _, tc := range []struct {
		now  string
		want int
	}{
		{"2025-02-27T23:59:59.999Z", 0}, // not yet due — clamped
		{"2025-02-28T00:00:00.000Z", 0}, // due today
		{"2025-02-28T12:00:00.000Z", 0}, // partial day floors
		{"2025-03-01T00:00:00.000Z", 1}, // day 1
		{"2025-03-10T00:00:00.000Z", 10},
	} {
		if got := planDaysLateOf(inst, mustTimeT(tc.now)); got != tc.want {
			t.Fatalf("planDaysLateOf(%s) = %d, want %d", tc.now, got, tc.want)
		}
	}
}

// isFullyPaid parity (payment-plan.ts): paid >= amount.
func TestIsFullyPaid(t *testing.T) {
	if isFullyPaid(PlanInstallment{AmountMinor: 100, PaidMinor: 99}) {
		t.Fatal("99/100 must be unpaid")
	}
	if !isFullyPaid(PlanInstallment{AmountMinor: 100, PaidMinor: 100}) {
		t.Fatal("100/100 must be fully paid")
	}
	if !isFullyPaid(PlanInstallment{AmountMinor: 100, PaidMinor: 150}) {
		t.Fatal("overpaid counts as fully paid (TS paidMinor >= amountMinor)")
	}
}
