package scheduler

import (
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// Pure Go port of src/domain/receivables/late-fee.ts (issue #7, review
// finding H4 — "Late fees missing, common in Kenyan B2B terms"). Parity
// contract: the policy refusal table, the eligibility ladder, the
// floor-to-the-cent amount formula and the idempotency outcomes are the TS
// module's, verbatim; latefee_test.go pins them against the TS spec fixtures
// (late-fee.spec.ts) and cites the source lines.
//
// A LateFeePolicy describes HOW a customer is penalized for paying late:
//   - flat:    a fixed minor-unit amount per accrual period
//   - percent: basis points of the outstanding balance per accrual period
//
// both optionally capped, both behind a grace window measured in whole days
// past the due date.
//
// H4 core requirement — IDEMPOTENCE per (receivableId, periodKey): accrual
// jobs re-run daily and must never double-charge. A re-run for a charged
// period returns outcome 'already_accrued' with the SAME fee (verbatim when
// the original row is supplied) and NO events.
//
// Posting matrix (docs/05): Late fee accrued → Debit AR control / Credit Fee
// income. The hook travels on both the fee row and the event payload so the
// ledger module can post without re-deriving it.
//
// Everything is a pure function: no I/O, no time.Now(), time only via the
// injected clock's instants. Errors carry stable SCREAMING_SNAKE codes.

// LateFeePolicyKind picks the accrual formula: 'flat' or 'percent'.
type LateFeePolicyKind string

const (
	LateFeeFlat    LateFeePolicyKind = "flat"
	LateFeePercent LateFeePolicyKind = "percent"
)

// Codes the late-fee port refuses with (TS DomainError families, verbatim —
// late-fee.ts validateLateFeePolicy + accrueLateFee).
const (
	CodeLateFeePolicyKindInvalid     = "LATE_FEE_POLICY_KIND_INVALID"
	CodeLateFeePolicyFlatAndPercent  = "LATE_FEE_POLICY_FLAT_AND_PERCENT"
	CodeLateFeePolicyFlatRequired    = "LATE_FEE_POLICY_FLAT_REQUIRED"
	CodeLateFeePolicyPercentRequired = "LATE_FEE_POLICY_PERCENT_REQUIRED"
	CodeLateFeePolicyFlatInvalid     = "LATE_FEE_POLICY_FLAT_INVALID"
	CodeLateFeePolicyBpsInvalid      = "LATE_FEE_POLICY_BPS_INVALID"
	CodeLateFeePolicyCapInvalid      = "LATE_FEE_POLICY_CAP_INVALID"
	CodeLateFeePolicyGraceInvalid    = "LATE_FEE_POLICY_GRACE_INVALID"
	CodeLateFeePeriodKeyRequired     = "LATE_FEE_PERIOD_KEY_REQUIRED"
	CodeLateFeeReceivableNotLive     = "LATE_FEE_RECEIVABLE_NOT_LIVE"
	CodeLateFeeNotOverdue            = "LATE_FEE_NOT_OVERDUE"
	CodeLateFeeWithinGrace           = "LATE_FEE_WITHIN_GRACE"
	CodeLateFeeZeroBalance           = "LATE_FEE_ZERO_BALANCE"
)

// LateFeePolicy is the accrual policy. Kind picks the formula; FlatMinor and
// PercentBps are mutually exclusive (validated). Amounts are minor units
// (cents) as non-negative integers — the TS "non-negative safe integer"
// refusal rows for non-integer inputs are unrepresentable in Go's typed
// fields (documented in the tests).
type LateFeePolicy struct {
	Kind LateFeePolicyKind
	// FlatMinor is kind 'flat' only — fee per accrual period, minor units.
	FlatMinor *int64
	// PercentBps is kind 'percent' only — basis points of the outstanding
	// balance. 150 bps = 1.5 %; 333 bps = 3.33 %. The computed fee is rounded
	// DOWN to the cent (integer floor division — no floats anywhere near the
	// ledger).
	PercentBps *int
	// CapMinor is the per-accrual ceiling in minor units. Optional.
	CapMinor *int64
	// GraceDays are whole free days after the due date. A fee accrues on the
	// first full day AFTER the grace window: daysLate > graceDays.
	GraceDays int
}

// ResolvedLateFeePolicy is the policy with every optional field validated
// (the TS resolver's canonical bigint form, typed).
type ResolvedLateFeePolicy struct {
	Kind       LateFeePolicyKind
	FlatMinor  *int64
	PercentBps *int
	CapMinor   *int64
	GraceDays  int
}

// ValidateLateFeePolicy validates a late fee policy and resolves it to the
// canonical form. Refusals (stable codes, late-fee.ts validateLateFeePolicy):
//
//	LATE_FEE_POLICY_KIND_INVALID     — kind is neither 'flat' nor 'percent'
//	LATE_FEE_POLICY_FLAT_AND_PERCENT — both flatMinor and percentBps supplied
//	LATE_FEE_POLICY_FLAT_REQUIRED    — kind 'flat' without flatMinor
//	LATE_FEE_POLICY_PERCENT_REQUIRED — kind 'percent' without percentBps
//	LATE_FEE_POLICY_FLAT_INVALID     — flatMinor negative
//	LATE_FEE_POLICY_BPS_INVALID      — percentBps negative
//	LATE_FEE_POLICY_CAP_INVALID      — capMinor negative
//	LATE_FEE_POLICY_GRACE_INVALID    — graceDays negative
func ValidateLateFeePolicy(policy LateFeePolicy) (ResolvedLateFeePolicy, error) {
	if policy.Kind != LateFeeFlat && policy.Kind != LateFeePercent {
		return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyKindInvalid,
			Message: sprintf("late fee policy kind must be 'flat' or 'percent', got %q", string(policy.Kind))}
	}
	hasFlat := policy.FlatMinor != nil
	hasPercent := policy.PercentBps != nil
	if hasFlat && hasPercent {
		return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyFlatAndPercent,
			Message: "a late fee policy is flat OR percent — both formulas supplied"}
	}
	var flatMinor *int64
	var percentBps *int
	if policy.Kind == LateFeeFlat {
		if !hasFlat {
			return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyFlatRequired,
				Message: "a 'flat' late fee policy requires flatMinor"}
		}
		if *policy.FlatMinor < 0 {
			return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyFlatInvalid,
				Message: sprintf("flatMinor must be a non-negative safe integer, got %d", *policy.FlatMinor)}
		}
		flatMinor = policy.FlatMinor
	} else {
		if !hasPercent {
			return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyPercentRequired,
				Message: "a 'percent' late fee policy requires percentBps"}
		}
		if *policy.PercentBps < 0 {
			return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyBpsInvalid,
				Message: sprintf("percentBps must be a non-negative safe integer, got %d", *policy.PercentBps)}
		}
		percentBps = policy.PercentBps
	}
	var capMinor *int64
	if policy.CapMinor != nil {
		if *policy.CapMinor < 0 {
			return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyCapInvalid,
				Message: sprintf("capMinor must be a non-negative safe integer, got %d", *policy.CapMinor)}
		}
		capMinor = policy.CapMinor
	}
	if policy.GraceDays < 0 {
		return ResolvedLateFeePolicy{}, &Error{Code: CodeLateFeePolicyGraceInvalid,
			Message: sprintf("graceDays must be a non-negative safe integer, got %d", policy.GraceDays)}
	}
	return ResolvedLateFeePolicy{Kind: policy.Kind, FlatMinor: flatMinor, PercentBps: percentBps, CapMinor: capMinor, GraceDays: policy.GraceDays}, nil
}

// floorDiv is floor division for int64 (Go's / truncates toward zero; the
// TS ports need a true floor for negative elapsed spans).
func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

const dayNanos = int64(24 * time.Hour)

// WholeDaysLate returns whole floored days past the due date, clamped at 0
// (late-fee.ts wholeDaysLate — elapsed-millisecond flooring, the same
// semantics as aging.ts's daysPastDue).
func WholeDaysLate(dueDate, now time.Time) int {
	days := floorDiv(now.Sub(dueDate).Nanoseconds(), dayNanos)
	if days < 0 {
		return 0
	}
	return int(days)
}

// feeAmountOf returns the fee for a balance: flat, or balance × bps / 10000
// floored to the cent (integer floor division — both operands non-negative,
// so truncation IS floor), then clamped to the cap when present (late-fee.ts
// feeAmountOf).
func feeAmountOf(resolved ResolvedLateFeePolicy, balanceMinor int64) int64 {
	var uncapped int64
	if resolved.Kind == LateFeeFlat {
		uncapped = *resolved.FlatMinor
	} else {
		uncapped = (balanceMinor * int64(*resolved.PercentBps)) / 10_000
	}
	if resolved.CapMinor != nil && uncapped > *resolved.CapMinor {
		return *resolved.CapMinor
	}
	return uncapped
}

// LateFeeReceivableLike is the slice of a Receivable accrual needs (TS
// LateFeeReceivableLike). Balance = original − applied (R1 receivable side).
// State is the optional live-state guard: when present, only
// 'open' | 'partially_paid' receivables may accrue — flag-based eligibility
// alone can never charge a conceded debt.
type LateFeeReceivableLike struct {
	ID       string
	Currency money.Currency
	DueDate  time.Time
	Overdue  bool
	Original money.Money
	Applied  money.Money
	State    string // optional; empty means "not supplied"
}

// LateFee is one accrued fee — one append-only row per (receivableID,
// periodKey) (TS LateFee).
type LateFee struct {
	ReceivableID string
	PeriodKey    string
	Amount       money.Money
	Currency     money.Currency
	PolicyKind   LateFeePolicyKind
	PercentBps   *int
	FlatMinor    *int64
	CapMinor     *int64
	// BalanceMinor is the outstanding balance the fee was computed on (before
	// this fee).
	BalanceMinor int64
	DaysLate     int
	GraceDays    int
	AccruedAt    time.Time
	Posting      LateFeePosting
}

// LateFeeAccrualOptions carry the accrual period (the idempotency scope) and
// the previously posted fees (TS LateFeeAccrualOptions). PreviouslyAccruedFees
// take precedence over PreviouslyAccruedPeriodKeys: a periodKey match against
// a full row returns the ORIGINAL fee verbatim.
type LateFeeAccrualOptions struct {
	// PeriodKey is the caller-defined accrual period (e.g. '2025-08') — the
	// idempotency scope.
	PeriodKey string
	// Now is the injected clock's instant (TS reads options.clock.now()).
	Now time.Time
	// PreviouslyAccruedPeriodKeys are bare periodKeys already charged for this
	// receivable.
	PreviouslyAccruedPeriodKeys []string
	// PreviouslyAccruedFees are full previously posted fee rows.
	PreviouslyAccruedFees []LateFee
}

// AccrualOutcome reports what one accrueLateFee call did (TS outcome union).
type AccrualOutcome string

const (
	OutcomeAccrued        AccrualOutcome = "accrued"
	OutcomeAlreadyAccrued AccrualOutcome = "already_accrued"
)

// LateFeeAccrual is the result of one accrual attempt: 'accrued' charged a
// new fee (exactly one event); 'already_accrued' re-observed a charged period
// and emits NOTHING (H4).
type LateFeeAccrual struct {
	Outcome AccrualOutcome
	Fee     LateFee
	Events  []Event
}

// AccrueLateFee accrues a late fee for one (receivable, periodKey) — H4.
//
// Eligibility (in order; every refusal is a stable Error, late-fee.ts
// accrueLateFee):
//  1. idempotency: periodKey already accrued → 'already_accrued' marker,
//     zero events, never a double charge;
//  2. live debt: when a state is supplied, only open | partially_paid
//     (LATE_FEE_RECEIVABLE_NOT_LIVE);
//  3. overdue: stored flag true OR clock strictly past the due date
//     (LATE_FEE_NOT_OVERDUE);
//  4. grace: daysLate (whole floored days) must EXCEED graceDays
//     (LATE_FEE_WITHIN_GRACE);
//  5. balance: original − applied > 0 (LATE_FEE_ZERO_BALANCE).
//
// Amount: flat flatMinor, or balance × percentBps / 10000 rounded DOWN to the
// cent via integer floor division (e.g. bps 333 on 123457 minor → 4111), then
// clamped to capMinor when present. A zero fee is legal (flat 0, cap 0, or a
// percent that rounds to nothing) and still marks the period as charged.
func AccrueLateFee(receivable LateFeeReceivableLike, policy LateFeePolicy, options LateFeeAccrualOptions) (LateFeeAccrual, error) {
	resolved, err := ValidateLateFeePolicy(policy)
	if err != nil {
		return LateFeeAccrual{}, err
	}

	periodKey := strings.TrimSpace(options.PeriodKey)
	if periodKey == "" {
		return LateFeeAccrual{}, &Error{Code: CodeLateFeePeriodKeyRequired,
			Message: "a late fee accrual requires a non-blank periodKey (idempotency scope)"}
	}

	// H4: a re-run for an already-charged period NEVER charges again — it
	// returns the same fee (verbatim row when supplied) or a marker, no events.
	var verbatim *LateFee
	alreadyCharged := false
	for i := range options.PreviouslyAccruedFees {
		if options.PreviouslyAccruedFees[i].PeriodKey == periodKey {
			verbatim = &options.PreviouslyAccruedFees[i]
			alreadyCharged = true
			break
		}
	}
	if !alreadyCharged {
		for _, key := range options.PreviouslyAccruedPeriodKeys {
			if key == periodKey {
				alreadyCharged = true
				break
			}
		}
	}
	if alreadyCharged {
		if verbatim != nil {
			return LateFeeAccrual{Outcome: OutcomeAlreadyAccrued, Fee: *verbatim, Events: nil}, nil
		}
		now := options.Now
		daysLate := WholeDaysLate(receivable.DueDate, now)
		// chargeableBalance degrades the corrupt-input case (applied > original)
		// to a zero balance — a safe no-charge marker, never a throw (TS catch).
		balance := chargeableBalance(receivable, resolved, now)
		var amountMinor, balanceMinor int64
		if balance.IsPositive() {
			amountMinor = feeAmountOf(resolved, balance.Amount())
			balanceMinor = balance.Amount()
		}
		marker, err := buildFeeRow(receivable, resolved, periodKey, amountMinor, balanceMinor, daysLate, now)
		if err != nil {
			return LateFeeAccrual{}, err
		}
		return LateFeeAccrual{Outcome: OutcomeAlreadyAccrued, Fee: marker, Events: nil}, nil
	}

	if receivable.State != "" && receivable.State != "open" && receivable.State != "partially_paid" {
		return LateFeeAccrual{}, &Error{Code: CodeLateFeeReceivableNotLive,
			Message: sprintf("late fees accrue on live debts only (open | partially_paid), got %s", receivable.State)}
	}

	now := options.Now
	if !receivable.Overdue && !now.After(receivable.DueDate) {
		return LateFeeAccrual{}, &Error{Code: CodeLateFeeNotOverdue,
			Message: sprintf("receivable %s is not overdue — no fee accrues", receivable.ID)}
	}

	daysLate := WholeDaysLate(receivable.DueDate, now)
	if daysLate <= resolved.GraceDays {
		return LateFeeAccrual{}, &Error{Code: CodeLateFeeWithinGrace,
			Message: sprintf("receivable %s is %d day(s) late — inside the %d-day grace window", receivable.ID, daysLate, resolved.GraceDays)}
	}

	balance, err := receivable.Original.Subtract(receivable.Applied)
	if err != nil {
		// TS parity: the fresh path's Money.subtract propagates the kernel
		// refusal (corrupt input — applied > original) instead of charging.
		return LateFeeAccrual{}, err
	}
	if balance.IsZero() {
		return LateFeeAccrual{}, &Error{Code: CodeLateFeeZeroBalance,
			Message: sprintf("receivable %s has no outstanding balance to fee", receivable.ID)}
	}

	fee, err := buildFeeRow(receivable, resolved, periodKey, feeAmountOf(resolved, balance.Amount()), balance.Amount(), daysLate, now)
	if err != nil {
		return LateFeeAccrual{}, err
	}
	amountMinor, err := safeInt(fee.Amount.Amount())
	if err != nil {
		return LateFeeAccrual{}, err
	}
	balanceMinor, err := safeInt(balance.Amount())
	if err != nil {
		return LateFeeAccrual{}, err
	}
	var flatMinor *int64
	if resolved.FlatMinor != nil {
		flatMinor = resolved.FlatMinor
	}
	event, err := newEvent("receivable.lateFeeAccrued", receivable.ID, now, LateFeeAccruedPayload{
		ReceivableID: receivable.ID,
		PeriodKey:    periodKey,
		AmountMinor:  amountMinor,
		Currency:     string(receivable.Currency),
		PolicyKind:   string(resolved.Kind),
		PercentBps:   resolved.PercentBps,
		FlatMinor:    flatMinor,
		BalanceMinor: balanceMinor,
		DaysLate:     daysLate,
		GraceDays:    resolved.GraceDays,
		Posting:      feePosting,
	})
	if err != nil {
		return LateFeeAccrual{}, err
	}
	return LateFeeAccrual{Outcome: OutcomeAccrued, Fee: fee, Events: []Event{event}}, nil
}

// chargeableBalance mirrors late-fee.ts's inner chargeableBalance(): is
// anything still chargeable here? Returns the balance when yes; the zero
// Money means "nothing chargeable" (not live / not past due / within grace /
// settled / corrupt input — applied > original — degrades to a safe no-charge
// marker instead of an error).
func chargeableBalance(receivable LateFeeReceivableLike, resolved ResolvedLateFeePolicy, now time.Time) money.Money {
	if receivable.State != "" && receivable.State != "open" && receivable.State != "partially_paid" {
		return money.Money{}
	}
	if !receivable.Overdue && !now.After(receivable.DueDate) {
		return money.Money{}
	}
	if WholeDaysLate(receivable.DueDate, now) <= resolved.GraceDays {
		return money.Money{}
	}
	balance, err := receivable.Original.Subtract(receivable.Applied)
	if err != nil {
		return money.Money{} // corrupt input (applied > original): safe no-charge marker
	}
	if balance.IsZero() {
		return money.Money{}
	}
	return balance
}

// buildFeeRow assembles the append-only fee row (late-fee.ts buildFeeRow) —
// the idempotency scope (receivableID, periodKey) rides on every row.
func buildFeeRow(receivable LateFeeReceivableLike, resolved ResolvedLateFeePolicy, periodKey string, amountMinor, balanceMinor int64, daysLate int, accruedAt time.Time) (LateFee, error) {
	amount, err := money.New(amountMinor, receivable.Currency)
	if err != nil {
		return LateFee{}, err
	}
	return LateFee{
		ReceivableID: receivable.ID,
		PeriodKey:    periodKey,
		Amount:       amount,
		Currency:     receivable.Currency,
		PolicyKind:   resolved.Kind,
		PercentBps:   resolved.PercentBps,
		FlatMinor:    resolved.FlatMinor,
		CapMinor:     resolved.CapMinor,
		BalanceMinor: balanceMinor,
		DaysLate:     daysLate,
		GraceDays:    resolved.GraceDays,
		AccruedAt:    accruedAt,
		Posting:      feePosting,
	}, nil
}
