package application

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// Stable codes the payments surface produces (the port of
// src/domain/payments/{intake,payment}.ts + the wire's 404s).
const (
	CodePaymentNotFound         = "HTTP_PAYMENT_NOT_FOUND"
	CodeIntakeChannelInvalid    = "INTAKE_CHANNEL_INVALID"
	CodeIntakeExternalRef       = "INTAKE_EXTERNAL_REF_REQUIRED"
	CodeIntakeIdempotencyKey    = "INTAKE_IDEMPOTENCY_KEY_REQUIRED"
	CodeIntakeDeclaredRefBlank  = "INTAKE_DECLARED_REF_BLANK"
	CodeAmountMustBePositive    = "AMOUNT_MUST_BE_POSITIVE"
	CodeDuplicateAmountMismatch = "DUPLICATE_AMOUNT_MISMATCH"
	CodeCurrencyMismatch        = "CURRENCY_MISMATCH"
	CodeConfirmedAmountMismatch = "CONFIRMED_AMOUNT_MISMATCH"
	CodePaymentTerminal         = "PAYMENT_TERMINAL"
	CodePaymentNotConfirmed     = "PAYMENT_NOT_CONFIRMED"
	CodeInvalidTransition       = "INVALID_TRANSITION"
	CodeRefundExceedsAvailable  = "REFUND_EXCEEDS_AVAILABLE"
	CodeRefundReasonRequired    = "REFUND_REASON_REQUIRED"
)

// terminalPaymentStates are docs/03's terminal edges (nothing can act on them).
var terminalPaymentStates = map[string]bool{"failed": true, "reversed": true, "refunded": true}

// confirmedFamilyStates imply the money has landed (a success callback was
// processed) — matching and refunds draw only on this family.
var confirmedFamilyStates = map[string]bool{
	"confirmed": true, "partially_allocated": true, "allocated": true,
	"unapplied": true, "partially_refunded": true, "refunded": true,
}

// IntakeCommand is the one intake funnel's input (C2B + STK converge here).
type IntakeCommand struct {
	Channel        string
	ExternalRef    string
	IdempotencyKey string
	AmountMinor    int64
	Currency       string
	CustomerID     string // "" = unknown payer (C2B paybill)
	DeclaredRefs   []string
}

// IntakeResult carries the fund truth and the R9 verdict.
type IntakeResult struct {
	Payment   repositories.PaymentRow
	Duplicate bool
}

// Intake runs the R9/C5 idempotent funnel: a duplicate
// (channel, externalRef) OR idempotencyKey replays the EXISTING payment
// (200 + duplicate:true + the duplicateCallbackObserved tripwire) and never
// creates a second Payment; a duplicate carrying different money is untrusted
// input (409). First contact inserts the payment + payment.initiated fact and
// claims the durable idempotency key — one transaction, org-scoped by the
// principal's org. A failed attempt claims nothing: the tx rolls back whole,
// so a legitimate retry always finds a free key.
func (s *Services) Intake(ctx context.Context, orgID string, cmd IntakeCommand) (IntakeResult, error) {
	channel := cmd.Channel
	if channel != "c2b" && channel != "stk" {
		return IntakeResult{}, infra.NewDomainError(CodeIntakeChannelInvalid, "unknown channel: "+channel, nil)
	}
	externalRef := trim(cmd.ExternalRef)
	if externalRef == "" {
		return IntakeResult{}, infra.NewDomainError(CodeIntakeExternalRef, "externalRef (Daraja transaction id) is required", nil)
	}
	idempotencyKey := trim(cmd.IdempotencyKey)
	if idempotencyKey == "" {
		return IntakeResult{}, infra.NewDomainError(CodeIntakeIdempotencyKey, "idempotencyKey is required (R9)", nil)
	}
	if cmd.AmountMinor <= 0 {
		return IntakeResult{}, infra.NewDomainError(CodeAmountMustBePositive, "intake amounts must be > 0", nil)
	}
	refs := make([]string, 0, len(cmd.DeclaredRefs))
	for _, raw := range cmd.DeclaredRefs {
		ref := trim(raw)
		if ref == "" {
			return IntakeResult{}, infra.NewDomainError(CodeIntakeDeclaredRefBlank, "declared references cannot be blank", nil)
		}
		if !contains(refs, ref) {
			refs = append(refs, ref)
		}
	}

	var result IntakeResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		// R9 probe 1 (durable): the idempotency key may already name the
		// original outcome — hot replays never re-enter the insert path.
		if ref := s.lookupIdempotencyKey(ctx, tx, orgID, idempotencyKey); ref != "" {
			prior, err := s.stores().PaymentByID(ctx, tx, orgID, ref)
			if err == nil {
				return s.replayDuplicate(ctx, tx, orgID, prior, cmd.AmountMinor, cmd.Currency, &result)
			}
			if !errors.Is(err, repositories.ErrNotFound) {
				return err
			}
		}
		// R9 probe 2 (the lane's own uniqueness axes): unique(channel,
		// externalRef) OR unique(idempotencyKey) over the payments table.
		prior, err := s.findPriorPayment(ctx, tx, orgID, channel, externalRef, idempotencyKey)
		if err != nil {
			return err
		}
		if prior != nil {
			if err := s.assertDuplicateMoney(*prior, cmd.AmountMinor, cmd.Currency); err != nil {
				return err
			}
			// Bind this key to the original outcome too, so future replays
			// carrying the same key find it through the durable registry.
			if _, _, err := s.claimIdempotencyKey(ctx, tx, orgID, idempotencyKey, prior.ID); err != nil {
				return err
			}
			if err := s.appendDuplicateTripwire(ctx, tx, orgID, *prior); err != nil {
				return err
			}
			s.rememberReplay(orgID, idempotencyKey, prior.ID)
			result = IntakeResult{Payment: *prior, Duplicate: true}
			return nil
		}

		// First contact: claim the key, insert the payment, append the fact.
		payment := repositories.PaymentRow{
			ID:             s.IDs(),
			OrgID:          orgID,
			CustomerID:     strPtrOf(cmd.CustomerID),
			Channel:        channel,
			ExternalRef:    externalRef,
			IdempotencyKey: idempotencyKey,
			State:          "initiated",
			Currency:       cmd.Currency,
			RequestedMinor: cmd.AmountMinor,
			UnappliedMinor: zeroPtr(),
			DeclaredRefs:   refs,
			InitiatedAt:    s.Clock.Now(),
		}
		if _, _, err := s.claimIdempotencyKey(ctx, tx, orgID, idempotencyKey, payment.ID); err != nil {
			return err
		}
		if err := s.stores().InsertPayment(ctx, tx, payment); err != nil {
			if repositories.UniqueViolation(err) {
				// A concurrent callback won the race. This transaction is
				// aborted (PostgreSQL semantics); it rolls back whole — the
				// durable key claim included — and the replay is resolved on
				// a fresh read below against the winner's committed state.
				return errRetryReplay
			}
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "payment.initiated", payment.ID, map[string]any{
			"paymentId":      payment.ID,
			"channel":        channel,
			"requestedMinor": cmd.AmountMinor,
		}); err != nil {
			return err
		}
		s.rememberReplay(orgID, idempotencyKey, payment.ID)
		result = IntakeResult{Payment: payment, Duplicate: false}
		return nil
	})
	if errors.Is(err, errRetryReplay) {
		// The winner committed between our probe and our insert; replay it.
		return s.replayAfterRace(ctx, orgID, channel, externalRef, idempotencyKey, cmd.AmountMinor, cmd.Currency)
	}
	if err != nil {
		return IntakeResult{}, err
	}
	return result, nil
}

// errRetryReplay signals "this tx lost an insert race — replay the winner on
// a fresh transaction". Internal only; never leaves the service.
var errRetryReplay = errors.New("application: intake insert lost a race — replay the committed winner")

// replayAfterRace resolves the concurrent winner's payment in a fresh
// transaction (the losing tx rolled back, so nothing it claimed survives).
func (s *Services) replayAfterRace(ctx context.Context, orgID, channel, externalRef, idempotencyKey string, amountMinor int64, currency string) (IntakeResult, error) {
	var result IntakeResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		prior, err := s.findPriorPayment(ctx, tx, orgID, channel, externalRef, idempotencyKey)
		if err != nil {
			return err
		}
		if prior == nil {
			return infra.NewDomainError(infra.CodeInternal, "intake race resolved without a committed payment", nil)
		}
		if err := s.assertDuplicateMoney(*prior, amountMinor, currency); err != nil {
			return err
		}
		if _, _, err := s.claimIdempotencyKey(ctx, tx, orgID, idempotencyKey, prior.ID); err != nil {
			return err
		}
		if err := s.appendDuplicateTripwire(ctx, tx, orgID, *prior); err != nil {
			return err
		}
		s.rememberReplay(orgID, idempotencyKey, prior.ID)
		result = IntakeResult{Payment: *prior, Duplicate: true}
		return nil
	})
	if err != nil {
		return IntakeResult{}, err
	}
	return result, nil
}

// findPriorPayment is the R9 duplicate probe: same (channel, externalRef) OR
// same idempotencyKey replays the same logical payment.
func (s *Services) findPriorPayment(ctx context.Context, q repositories.Querier, orgID, channel, externalRef, idempotencyKey string) (*repositories.PaymentRow, error) {
	prior, err := s.stores().PaymentByExternalRef(ctx, q, orgID, channel, externalRef)
	if err == nil {
		return &prior, nil
	}
	if !errors.Is(err, repositories.ErrNotFound) {
		return nil, err
	}
	prior, err = s.stores().PaymentByIdempotencyKey(ctx, q, orgID, idempotencyKey)
	if err == nil {
		return &prior, nil
	}
	if errors.Is(err, repositories.ErrNotFound) {
		return nil, nil
	}
	return nil, err
}

// replayDuplicate runs the duplicate path against a payment resolved by the
// durable key: money parity first (a tampered replay is untrusted input,
// never a benign retry), then the tripwire + the ORIGINAL result.
func (s *Services) replayDuplicate(ctx context.Context, tx repositories.Querier, orgID string, prior repositories.PaymentRow, amountMinor int64, currency string, result *IntakeResult) error {
	if err := s.assertDuplicateMoney(prior, amountMinor, currency); err != nil {
		return err
	}
	if err := s.appendDuplicateTripwire(ctx, tx, orgID, prior); err != nil {
		return err
	}
	result.Payment = prior
	result.Duplicate = true
	return nil
}

// appendDuplicateTripwire records the C5 ops fact
// (payments.duplicateCallbackObserved) beside the replayed payment — the
// at-least-once channel's observable heartbeat (E15's payload shape).
func (s *Services) appendDuplicateTripwire(ctx context.Context, tx repositories.Querier, orgID string, prior repositories.PaymentRow) error {
	return s.appendOutbox(ctx, tx, orgID, "payments.duplicateCallbackObserved", prior.ID, map[string]any{
		"paymentId":   prior.ID,
		"externalRef": prior.ExternalRef,
		"seenAt":      repositories.ISO(s.Clock.Now()),
	})
}

// assertDuplicateMoney mirrors intake.ts: same transaction id must mean the
// same money — a different currency (R10) or amount is untrusted input.
func (s *Services) assertDuplicateMoney(prior repositories.PaymentRow, amountMinor int64, currency string) error {
	if prior.Currency != currency {
		return infra.NewDomainError(CodeCurrencyMismatch,
			"payment "+prior.ID+" is "+prior.Currency+"; duplicate callback arrived as "+currency+" (R10)", nil)
	}
	if prior.RequestedMinor != amountMinor {
		priorAmount, _ := moneyString(prior.RequestedMinor, prior.Currency)
		callbackAmount, _ := moneyString(amountMinor, currency)
		return infra.NewDomainError(CodeDuplicateAmountMismatch,
			"duplicate callback for "+prior.ExternalRef+" carries "+callbackAmount+" but the payment was initiated for "+priorAmount, nil)
	}
	return nil
}

// ConfirmResult is the success callback's verdict.
type ConfirmResult struct {
	Payment          repositories.PaymentRow
	AlreadyConfirmed bool
}

// Confirm processes the Daraja success callback idempotently: confirmed is
// set exactly ONCE; a same-amount replay is a 200 no-op, a different amount
// is CONFIRMED_AMOUNT_MISMATCH. The state change, the payment.confirmed fact
// AND the balanced ledger entry (R4: Σdebits == Σcredits) commit in ONE
// transaction — the journal ref is the replay key, so a re-confirm can never
// double-post.
func (s *Services) Confirm(ctx context.Context, orgID, paymentID string, amountMinor int64, currency string) (ConfirmResult, error) {
	if amountMinor <= 0 {
		return ConfirmResult{}, infra.NewDomainError(CodeAmountMustBePositive, "confirmation amounts must be > 0", nil)
	}
	var result ConfirmResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		payment, err := s.stores().PaymentByID(ctx, tx, orgID, paymentID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodePaymentNotFound, "payment "+paymentID+" does not exist", nil)
			}
			return err
		}
		if payment.Currency != currency {
			return infra.NewDomainError(CodeCurrencyMismatch,
				"cannot confirm "+currency+" against a "+payment.Currency+" payment (R10)", nil)
		}
		if terminalPaymentStates[payment.State] {
			return infra.NewDomainError(CodePaymentTerminal,
				"payment "+payment.ID+" is "+payment.State+" (terminal); confirmation is not allowed", nil)
		}
		if payment.State == "confirmed" {
			if payment.ConfirmedMinor == nil {
				return infra.NewDomainError(infra.CodeInternal, "payment "+payment.ID+" is confirmed but has no confirmed amount", nil)
			}
			if *payment.ConfirmedMinor != amountMinor {
				return infra.NewDomainError(CodeConfirmedAmountMismatch,
					"payment "+payment.ID+" already confirmed for "+moneyStringOf(*payment.ConfirmedMinor, payment.Currency)+
						", cannot re-confirm for "+moneyStringOf(amountMinor, payment.Currency), nil)
			}
			result = ConfirmResult{Payment: payment, AlreadyConfirmed: true}
			return nil
		}
		if payment.State == "initiated" {
			// The callback may race ahead of the platform's
			// awaiting-confirmation step — advance through the lane's own
			// transition first.
			if err := s.stores().StagePaymentForConfirmation(ctx, tx, orgID, payment.ID); err != nil {
				return err
			}
			payment.State = "pending_confirmation"
		}
		if payment.State != "pending_confirmation" {
			return infra.NewDomainError(CodeInvalidTransition,
				"confirmation applies to pending_confirmation payments, got "+payment.State, nil)
		}
		now := s.Clock.Now()
		if err := s.stores().ConfirmPayment(ctx, tx, orgID, payment.ID, amountMinor, now); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "payment.confirmed", payment.ID, map[string]any{
			"paymentId":      payment.ID,
			"confirmedMinor": amountMinor,
			"externalRef":    payment.ExternalRef,
			"confirmedAt":    repositories.ISO(now),
		}); err != nil {
			return err
		}
		if err := s.stores().EnsureConfirmationLedgerSeed(ctx, tx, orgID, currency); err != nil {
			return err
		}
		if err := s.stores().PostConfirmationEntry(ctx, tx, orgID, payment.ID, payment.ExternalRef, currency, amountMinor, now); err != nil {
			return err
		}
		payment.State = "confirmed"
		payment.ConfirmedMinor = &amountMinor
		unapplied := amountMinor
		payment.UnappliedMinor = &unapplied
		payment.ConfirmedAt = &now
		result = ConfirmResult{Payment: payment, AlreadyConfirmed: false}
		return nil
	})
	if err != nil {
		return ConfirmResult{}, err
	}
	return result, nil
}

// RefundResult carries the payment view after the reservation appended.
type RefundResult struct {
	Payment repositories.PaymentRow
}

// RefundReservation records an append-only refund reservation (R6): refunds
// draw ONLY on funds not already allocated/refunded — over-draw refuses with
// REFUND_EXCEEDS_AVAILABLE (422) and the tx rolls back with zero rows.
// State-neutral by design: the Refunded/PartiallyRefunded edges belong to the
// adjustments lane's Refund aggregate; the reservation row keeps the
// payment-side ceiling honest (the DDL re-proves it at COMMIT).
func (s *Services) RefundReservation(ctx context.Context, orgID, paymentID, requestedBy string, amountMinor int64, currency, reason string) (RefundResult, error) {
	why := trim(reason)
	if why == "" {
		return RefundResult{}, infra.NewDomainError(CodeRefundReasonRequired, "a refund reservation requires a reason", nil)
	}
	if amountMinor <= 0 {
		return RefundResult{}, infra.NewDomainError(CodeAmountMustBePositive, "refund amounts must be > 0", nil)
	}
	var result RefundResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		payment, err := s.stores().PaymentByID(ctx, tx, orgID, paymentID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodePaymentNotFound, "payment "+paymentID+" does not exist", nil)
			}
			return err
		}
		if payment.Currency != currency {
			return infra.NewDomainError(CodeCurrencyMismatch,
				"cannot refund "+currency+" against a "+payment.Currency+" payment (R10)", nil)
		}
		if terminalPaymentStates[payment.State] {
			return infra.NewDomainError(CodePaymentTerminal,
				"payment "+payment.ID+" is "+payment.State+" (terminal); refund is not allowed", nil)
		}
		if !confirmedFamilyStates[payment.State] {
			return infra.NewDomainError(CodePaymentNotConfirmed,
				"refunds draw on confirmed funds; payment "+payment.ID+" is "+payment.State+" (R6)", nil)
		}
		if payment.ConfirmedMinor == nil {
			return infra.NewDomainError(infra.CodeInternal, "payment "+payment.ID+" is confirmed but has no confirmed amount", nil)
		}
		allocations, refunds, err := s.stores().CommittedAgainstPayment(ctx, tx, orgID, payment.ID)
		if err != nil {
			return err
		}
		committed := allocations + refunds + amountMinor
		if committed > *payment.ConfirmedMinor {
			return infra.NewDomainError(CodeRefundExceedsAvailable, exceedsMessage(committed, *payment.ConfirmedMinor, currency), nil)
		}
		row := repositories.RefundRow{
			ID:        s.IDs(),
			OrgID:     orgID,
			PaymentID: payment.ID,
			Amount:    amountMinor,
			Currency:  currency,
			Reason:    why,
			CreatedAt: s.Clock.Now(),
		}
		if err := s.stores().InsertRefundReservation(ctx, tx, row, trim(requestedBy)); err != nil {
			// The deferrable R6 trigger re-proves the ceiling at COMMIT —
			// its refusal is the same domain outcome as the pre-check.
			if repositories.CheckViolation(err) {
				return infra.NewDomainError(CodeRefundExceedsAvailable, exceedsMessage(committed, *payment.ConfirmedMinor, currency), nil)
			}
			return err
		}
		result = RefundResult{Payment: payment}
		return nil
	})
	if err != nil {
		return RefundResult{}, err
	}
	return result, nil
}

// exceedsMessage renders the R6 refusal exactly as the TS lane words it.
func exceedsMessage(committed, confirmed int64, currency string) string {
	committedStr, _ := moneyString(committed, currency)
	confirmedStr, _ := moneyString(confirmed, currency)
	return "Σ allocations+refunds " + committedStr + " would exceed confirmed " + confirmedStr + " (R6)"
}

// PaymentWithRows is the payment aggregate's full read shape.
type PaymentWithRows struct {
	Payment     repositories.PaymentRow
	Allocations []repositories.AllocationRow
	Refunds     []repositories.RefundRow
}

// GetPayment loads one org-scoped payment with its posting rows.
func (s *Services) GetPayment(ctx context.Context, q repositories.Querier, orgID, paymentID string) (PaymentWithRows, error) {
	payment, err := s.stores().PaymentByID(ctx, q, orgID, paymentID)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return PaymentWithRows{}, infra.NewDomainError(CodePaymentNotFound, "payment "+paymentID+" does not exist", nil)
		}
		return PaymentWithRows{}, err
	}
	allocations, err := s.stores().AllocationsForPayment(ctx, q, orgID, payment.ID)
	if err != nil {
		return PaymentWithRows{}, err
	}
	refunds, err := s.stores().RefundsForPayment(ctx, q, orgID, payment.ID)
	if err != nil {
		return PaymentWithRows{}, err
	}
	return PaymentWithRows{Payment: payment, Allocations: allocations, Refunds: refunds}, nil
}

// ListPayments is the org-scoped paginated read model.
func (s *Services) ListPayments(ctx context.Context, q repositories.Querier, orgID, sortCol, order string, limit, offset int) ([]repositories.PaymentRow, int, error) {
	return s.stores().PaymentsByOrg(ctx, q, orgID, sortCol, order, limit, offset)
}

func (s *Services) stores() *repositories.Stores { return s.Stores }

func trim(raw string) string {
	start, end := 0, len(raw)
	for start < end && (raw[start] == ' ' || raw[start] == '\t' || raw[start] == '\n' || raw[start] == '\r') {
		start++
	}
	for end > start && (raw[end-1] == ' ' || raw[end-1] == '\t' || raw[end-1] == '\n' || raw[end-1] == '\r') {
		end--
	}
	return raw[start:end]
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

func zeroPtr() *int64 {
	zero := int64(0)
	return &zero
}

// moneyStringOf renders via pkg/money — the TS Money.toString parity
// ("whole.cents CUR") the mismatch messages rely on. The plain literal is
// the honest fallback for a currency outside the closed set (which the DDL
// otherwise already refuses at the column).
func moneyStringOf(minor int64, currency string) string {
	out, err := moneyString(minor, currency)
	if err != nil {
		return itoa(minor) + " " + currency
	}
	return out
}

func moneyString(minor int64, currency string) (string, error) {
	m, err := money.New(minor, money.Currency(currency))
	if err != nil {
		return itoa(minor) + " " + currency, nil
	}
	return m.String(), nil
}
