// The R9 at-least-once intake funnel — the Go parity of the TS simulator's
// delivery pipeline (src/adapters/daraja/simulator.ts), recovered from a
// partially-delivered draft of this lane and re-verified against the
// dispatcher's parser surface:
//
//	parse (K1 boundary, ParseCallback) → intake (R9 verdict, here) → the
//	caller's domain transitions (only on fresh deliveries).
//
// Outcome ledger per physical callback (identical vocabulary to the TS
// simulator's DeliveryStatus):
//
//	accepted      — first sight: recorded durably, the caller may run the
//	                domain funnel (intake command) / result-code transitions
//	duplicate     — R9 duplicate: the SAME journey with the SAME money was
//	                already processed → same result as the first delivery,
//	                tripwire fired ONCE, nothing downstream re-runs
//	acknowledged  — C2B validation: a GATE, not a money fact; never ledgered
//	observed      — B2C result: OUTFLOW evidence; never an inflow, never ledgered
//	rejected      — tampering (same journey, different money) or a ledger
//	                failure: dead-lettered, fail-closed
//
// Ledger errors are NEVER swallowed: if the durable check fails, the callback
// is refused (rejected) so at-least-once redelivery retries later — a wrong
// verdict here invents or destroys money.
package daraja

import (
	"context"
	"sync"
)

// New codes this funnel adds to the stable surface (K1 tamper parity with
// the TS conformance lane's promised domain code, plus fail-closed ledger).
const (
	CodeLedgerUnavailable       = "DARAJA_LEDGER_UNAVAILABLE"
	CodeDuplicateAmountMismatch = "DARAJA_DUPLICATE_AMOUNT_MISMATCH"
)

// Outcome is the delivery-status verdict for one physical callback.
type Outcome string

const (
	OutcomeAccepted     Outcome = "accepted"
	OutcomeDuplicate    Outcome = "duplicate"
	OutcomeAcknowledged Outcome = "acknowledged"
	OutcomeObserved     Outcome = "observed"
	OutcomeRejected     Outcome = "rejected"
)

// IntakeOutcome is the funnel verdict for one parsed callback.
type IntakeOutcome struct {
	Outcome    Outcome
	JourneyKey string // set when the payload parsed (same keys as the TS simulator)
	Callback   ParsedCallback
}

// JourneyLedger is the durable record of processed callback journeys. The
// production implementation is a store (idempotency registry / payments
// table); MemLedger backs tests and the fake harness.
type JourneyLedger interface {
	// ClaimJourney records (journeyKey → amountMinor) unless the journey
	// already exists, and reports whether THIS call won the claim (the
	// journey was fresh) plus the previously recorded amount when it was
	// not. Implementations MUST be ATOMIC (unique constraint / INSERT ON
	// CONFLICT semantics) so concurrent deliveries of one journey produce
	// exactly one winner — the R9 one-creation-funnel guarantee under
	// at-least-once concurrency.
	ClaimJourney(ctx context.Context, journeyKey string, amountMinor int64) (won bool, recordedMinor int64, err error)
}

// IntakeHooks carries the side-channel events the caller records. Hooks run
// synchronously, outside any lock.
type IntakeHooks struct {
	// OnDuplicate is the R9 tripwire — fires ONCE per duplicate delivery
	// (the equivalent of the payments.duplicateCallbackObserved event).
	OnDuplicate func(ParsedCallback)
}

// IntakeCallback runs the R9 verdict for one parsed callback:
//
//   - C2B VALIDATION → acknowledged: the gate is checked, no money state,
//     never ledgered (a validation is not a fact — the confirmation is).
//   - B2C RESULT → observed: outflow evidence, never an inflow command,
//     never ledgered.
//   - C2B CONFIRMATION / STK RESULT → ledgered by journey key
//     ('c2b:<TransID>' / 'stk:<CheckoutRequestID>') via an ATOMIC claim:
//     claim won         → accepted (first sight);
//     lost, same money  → duplicate + tripwire (OnDuplicate once);
//     lost, other money → rejected with DARAJA_DUPLICATE_AMOUNT_MISMATCH —
//     same TransID with different money is TAMPERING,
//     not a retry (K1/R9).
//
// The money comparison is on exact minor units — the same invariant the
// payments lane enforces (assertDuplicateMoney), enforced here at the
// transport boundary so a hostile replay never reaches intake.
func IntakeCallback(ctx context.Context, ledger JourneyLedger, cb ParsedCallback, hooks IntakeHooks) (IntakeOutcome, error) {
	facts := cb.IntakeFacts()
	outcome := IntakeOutcome{JourneyKey: facts.JourneyKey, Callback: cb}

	switch facts.Kind {
	case KindC2BValidation:
		outcome.Outcome = OutcomeAcknowledged
		return outcome, nil
	case KindB2CResult:
		outcome.Outcome = OutcomeObserved
		return outcome, nil
	case KindC2BConfirm, KindSTKResult:
		// money-journey families — fall through to the ledger
	default:
		return IntakeOutcome{}, errf(CodePayloadUnrecognized,
			"callback kind %q carries no intake semantics", facts.Kind)
	}

	if ledger == nil {
		return IntakeOutcome{}, errf(CodePayloadUnrecognized, "intake requires a journey ledger")
	}
	if facts.JourneyKey == "" {
		return IntakeOutcome{}, errf(CodePayloadUnrecognized, "callback carries no journey key")
	}

	won, prior, err := ledger.ClaimJourney(ctx, facts.JourneyKey, facts.AmountMinor)
	if err != nil {
		// Fail closed: an unreadable ledger must not let a replayed callback
		// masquerade as fresh. At-least-once redelivery will retry.
		outcome.Outcome = OutcomeRejected
		return outcome, &Error{
			Code:    CodeLedgerUnavailable,
			Kind:    KindNetwork,
			Message: "journey ledger unavailable — refusing to process blind (fail closed)",
			Cause:   err,
		}
	}

	if !won {
		if prior == facts.AmountMinor {
			outcome.Outcome = OutcomeDuplicate
			if hooks.OnDuplicate != nil {
				hooks.OnDuplicate(cb)
			}
			return outcome, nil
		}
		// Same journey, different money: tampering, not a retry (K1).
		outcome.Outcome = OutcomeRejected
		return outcome, &Error{
			Code:    CodeDuplicateAmountMismatch,
			Kind:    KindMoney,
			Message: "journey replayed with different money — tampering, not a retry",
		}
	}

	outcome.Outcome = OutcomeAccepted
	return outcome, nil
}

// MemLedger is an in-memory JourneyLedger (tests + fake harness). The claim
// is atomic under its mutex, mirroring the unique-constraint semantics a
// durable implementation must provide. Production lanes back IntakeCallback
// with a durable store instead.
type MemLedger struct {
	mu       sync.Mutex
	journeys map[string]int64
}

// NewMemLedger returns an empty in-memory journey ledger.
func NewMemLedger() *MemLedger {
	return &MemLedger{journeys: make(map[string]int64)}
}

// ClaimJourney implements JourneyLedger.
func (l *MemLedger) ClaimJourney(_ context.Context, journeyKey string, amountMinor int64) (bool, int64, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if prior, exists := l.journeys[journeyKey]; exists {
		return false, prior, nil
	}
	l.journeys[journeyKey] = amountMinor
	return true, 0, nil
}
