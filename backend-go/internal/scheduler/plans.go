package scheduler

import (
	"time"
)

// Pure Go port of the payment-plan scheduler semantics in
// src/domain/receivables/payment-plan.ts (issue #7, H5). Parity contract: the
// defaulting rule, the whole-day lateness arithmetic and the state-machine
// guards are the TS module's, verbatim; plans_test.go pins them against the
// TS spec fixtures (payment-plan.spec.ts) and cites the source lines.
//
// Plan state machine (issue #7):
//
//	active → completed   every installment fully paid (payment lane's doing)
//	active → defaulted   an unpaid installment is overdue by policy days
//	active → cancelled   an explicit decision with a recorded reason
//
// Every other transition is illegal (INVALID_PAYMENT_PLAN_TRANSITION). The
// scheduler executes the second one — installment due/expiry — and never
// touches completed, defaulted or cancelled plans: they are dead to the job
// by construction (state-guarded UPDATEs in store.go).
//
// The schedule CREATION side (createPaymentPlan / buildSchedule with
// Money.allocate splitting and month-end-clamped due dates) is not a
// scheduler concern — the schedule already lives in payment_plans +
// installments (db/migrations/0010). What the scheduler ports is the
// EXECUTION math: daysLateOf (whole floored days), unpaidInstallmentsOf
// (unpaid = any paid portion outstanding) and markPlanDefaulted's trigger
// search ("overdue by N days" — day N counts, fully-paid late installments
// never trigger a default).

// Codes the plan port refuses with (TS DomainError families, verbatim).
const (
	CodePaymentPlanDefaultPolicyInvalid = "PAYMENT_PLAN_DEFAULT_POLICY_INVALID"
	CodePaymentPlanNotDefaultable       = "PAYMENT_PLAN_NOT_DEFAULTABLE"
)

// PlanInstallment is the slice of an installment row the default trigger
// needs (TS PlanInstallment). DueDate is the installment's due date at UTC
// midnight — due_date is a DATE column (0010), and the TS daysLateOf math
// runs on whole floored days from that anchor.
type PlanInstallment struct {
	No          int // 1-based installment number
	DueDate     time.Time
	AmountMinor int64
	PaidMinor   int64
}

// planDaysLateOf returns whole floored days past an installment's due date,
// clamped at 0 (payment-plan.ts daysLateOf: max(0, floor((now − due) /
// 86_400_000))).
func planDaysLateOf(installment PlanInstallment, now time.Time) int {
	days := floorDiv(now.Sub(installment.DueDate).Nanoseconds(), dayNanos)
	if days < 0 {
		return 0
	}
	return int(days)
}

// isFullyPaid mirrors payment-plan.ts isFullyPaid: paidMinor >= amountMinor.
func isFullyPaid(installment PlanInstallment) bool {
	return installment.PaidMinor >= installment.AmountMinor
}

// UnpaidInstallments returns the unpaid installments (any paid portion
// outstanding), in schedule order (payment-plan.ts unpaidInstallmentsOf).
func UnpaidInstallments(installments []PlanInstallment) []PlanInstallment {
	unpaid := make([]PlanInstallment, 0, len(installments))
	for _, inst := range installments {
		if !isFullyPaid(inst) {
			unpaid = append(unpaid, inst)
		}
	}
	return unpaid
}

// DefaultTrigger is the outcome of the default search: the earliest unpaid
// installment overdue by at least the policy window, with its days-late
// count (payment-plan.ts markPlanDefaulted).
type DefaultTrigger struct {
	InstallmentNo int
	DaysOverdue   int
}

// FindDefaultTrigger ports markPlanDefaulted's trigger search: active →
// defaulted is legal only while some UNPAID installment is overdue by at
// least defaultAfterDays whole days ("overdue by N days" — day N counts,
// fully-paid late installments never trigger a default). Refusals:
//
//	PAYMENT_PLAN_DEFAULT_POLICY_INVALID — defaultAfterDays negative (the TS
//	  "safe integer" row is unrepresentable in Go's typed field)
//	PAYMENT_PLAN_NOT_DEFAULTABLE       — no unpaid installment crosses the window
//
// The TS "plan is dead afterwards" guard (payments/cancellation/re-defaulting
// throw) is enforced by the store's state-guarded UPDATE — a defaulted plan
// is never re-scanned.
func FindDefaultTrigger(installments []PlanInstallment, defaultAfterDays int, now time.Time) (DefaultTrigger, error) {
	if defaultAfterDays < 0 {
		return DefaultTrigger{}, &Error{Code: CodePaymentPlanDefaultPolicyInvalid,
			Message: sprintf("defaultAfterDays must be a safe integer ≥ 0, got %d", defaultAfterDays)}
	}
	for _, inst := range UnpaidInstallments(installments) {
		daysLate := planDaysLateOf(inst, now)
		if daysLate >= defaultAfterDays {
			return DefaultTrigger{InstallmentNo: inst.No, DaysOverdue: daysLate}, nil
		}
	}
	return DefaultTrigger{}, &Error{Code: CodePaymentPlanNotDefaultable,
		Message: sprintf("no unpaid installment of the plan is overdue by %d day(s)", defaultAfterDays)}
}
