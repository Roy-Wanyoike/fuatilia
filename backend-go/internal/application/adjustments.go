package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// The adjustments surface (issue #132): the org's refund/credit-note feed
// plus the two INTENT evaluators. The evaluators are the Go port of the
// adjustments lane's refusal tables — src/domain/adjustments/credit-note.ts
// (`draftCreditNote`) and src/domain/adjustments/refund.ts (`requestRefund`)
// — and they REFUSE WITH VALUES, never by mutating anything: an intent is a
// dry-run evaluation, no row is written and no ledger entry is appended
// (R3/R6/R7 — the write path belongs to the adjustments lane's own
// aggregate lifecycle, issue #4).

// Stable refusal codes (ported verbatim — the TS modules' DomainError codes).
// CodeRefundReasonRequired ("REFUND_REASON_REQUIRED") and CodeCurrencyMismatch
// are shared with the payments surface (application/payments.go) — the same
// stable code; the refusal MESSAGES are the adjustments lane's own
// (refund.ts), not the payments lane's (payment.ts).
const (
	CodeCreditNoteReasonRequired = "CREDIT_NOTE_REASON_REQUIRED"
	CodeCreditNoteTotalInvalid   = "CREDIT_NOTE_TOTAL_INVALID"
	CodeRefundRequesterRequired  = "REFUND_REQUESTER_REQUIRED"
	CodeRefundAmountInvalid      = "REFUND_AMOUNT_INVALID"
	CodeRefundExceedsCeiling     = "REFUND_EXCEEDS_CEILING"
)

// AdjustmentRefusal is one domain refusal carried as a VALUE in the 200
// body — code/message verbatim from the TS modules, field naming the body
// path the refusal is about, details the domain error's structured payload.
type AdjustmentRefusal struct {
	Code    string
	Message string
	Field   string
	Details map[string]any
}

// AdjustmentQuery is the feed route's parsed query.
type AdjustmentQuery struct {
	SortCol string
	Order   string
	Limit   int
	Offset  int
}

// ListAdjustments is the org-scoped paginated adjustments feed (refunds +
// credit notes as one deterministic set).
func (s *Services) ListAdjustments(ctx context.Context, q repositories.Querier, orgID string, query AdjustmentQuery) ([]repositories.AdjustmentRow, int, error) {
	return s.Stores.AdjustmentsByOrg(ctx, q, orgID, query.SortCol, query.Order, query.Limit, query.Offset)
}

// ListLedgerAccounts is the org-scoped paginated chart of accounts.
func (s *Services) ListLedgerAccounts(ctx context.Context, q repositories.Querier, orgID, sortCol, order string, limit, offset int) ([]repositories.LedgerAccountRow, int, error) {
	return s.Stores.LedgerAccountsByOrg(ctx, q, orgID, sortCol, order, limit, offset)
}

// ListLedgerEntries is the org-scoped paginated journal (line-grained).
func (s *Services) ListLedgerEntries(ctx context.Context, q repositories.Querier, orgID, sortCol, order string, limit, offset int) ([]repositories.LedgerEntryLineRow, int, error) {
	return s.Stores.LedgerEntryLinesByOrg(ctx, q, orgID, sortCol, order, limit, offset)
}

// ---------------------------------------------------------------------------
// Credit-note intent — the port of draftCreditNote's refusal table
// (src/domain/adjustments/credit-note.ts:92-111).
// ---------------------------------------------------------------------------

// CreditNoteIntentCommand is the wire proposal (shape-validated; the values
// here are exactly what the lane evaluates).
type CreditNoteIntentCommand struct {
	CustomerID string
	InvoiceID  string // "" = absent
	Reason     string
	TotalMinor int64
	Currency   string
}

// CreditNoteIntent is the evaluated draft — a proposal, never a stored row.
type CreditNoteIntent struct {
	ID         string
	CustomerID string
	InvoiceID  string
	Reason     string
	TotalMinor int64
	Currency   string
	State      string // "draft"
}

// CreditNoteIntentResult answers the dry run: accepted with the draft, or
// the refusal table as values (collected — one proposal can fail several
// independent guards at once).
type CreditNoteIntentResult struct {
	Accepted bool
	Intent   *CreditNoteIntent
	Refusals []AdjustmentRefusal
}

// EvaluateCreditNoteIntent ports draftCreditNote (credit-note.ts:92-111):
//   - a blank reason refuses CREDIT_NOTE_REASON_REQUIRED — "a credit note
//     requires a reason" (credit-note.ts:93-95);
//   - a non-positive total refuses CREDIT_NOTE_TOTAL_INVALID — "credit note
//     total must be positive" (credit-note.ts:96-98, docs/05: totalMinor > 0).
//
// Both guards are independent VALUE checks, so refusals are collected; on a
// clean proposal the draft is built exactly as the lane does (state 'draft',
// id from the injected id port). Nothing is persisted.
func (s *Services) EvaluateCreditNoteIntent(cmd CreditNoteIntentCommand) CreditNoteIntentResult {
	refusals := []AdjustmentRefusal{}
	if strings.TrimSpace(cmd.Reason) == "" {
		refusals = append(refusals, AdjustmentRefusal{
			Code:    CodeCreditNoteReasonRequired,
			Message: "a credit note requires a reason",
			Field:   "reason",
		})
	}
	if cmd.TotalMinor <= 0 {
		refusals = append(refusals, AdjustmentRefusal{
			Code:    CodeCreditNoteTotalInvalid,
			Message: "credit note total must be positive",
			Field:   "total.minor",
		})
	}
	if len(refusals) > 0 {
		return CreditNoteIntentResult{Accepted: false, Refusals: refusals}
	}
	// The lane's draft: Money is positive here by the guard above, so the
	// domain function cannot throw on this path (its only two guards are the
	// ones evaluated).
	return CreditNoteIntentResult{
		Accepted: true,
		Intent: &CreditNoteIntent{
			ID:         s.IDs(),
			CustomerID: cmd.CustomerID,
			InvoiceID:  cmd.InvoiceID,
			Reason:     strings.TrimSpace(cmd.Reason),
			TotalMinor: cmd.TotalMinor,
			Currency:   cmd.Currency,
			State:      "draft",
		},
		Refusals: []AdjustmentRefusal{},
	}
}

// ---------------------------------------------------------------------------
// Refund intent — the port of requestRefund's refusal table
// (src/domain/adjustments/refund.ts:91-134) evaluated against the R6
// ceiling computed from the org-scoped payment snapshot.
// ---------------------------------------------------------------------------

// RefundIntentCommand is the wire proposal. RequestedBy "" means "default to
// the authenticated principal" (the transport's identity IS the requester).
type RefundIntentCommand struct {
	PaymentID   string
	AmountMinor int64
	Currency    string
	Reason      string
	RequestedBy string
}

// RefundIntent is the proposed Requested refund plus the R6 ceiling it was
// evaluated against (an audit value).
type RefundIntent struct {
	ID              string
	PaymentID       string
	RequestedBy     string
	Reason          string
	TotalMinor      int64
	Currency        string
	State           string // "requested"
	CeilingMinor    int64
	CeilingCurrency string
}

// RefundIntentResult answers the dry run (same refusal-as-value shape).
type RefundIntentResult struct {
	Accepted bool
	Intent   *RefundIntent
	Refusals []AdjustmentRefusal
}

// moneyText renders minor units the way the TS Money.toString does
// ("whole.cents CCY" — src/domain/shared/money.ts:139-143): the refusal
// messages stay byte-identical across kernels.
func moneyText(minor int64, currency string) string {
	return fmt.Sprintf("%d.%02d %s", minor/100, minor%100, currency)
}

// EvaluateRefundReservationIntent ports requestRefund (refund.ts:91-134)
// over the payment snapshot's R6 ceiling:
//   - a blank reason refuses REFUND_REASON_REQUIRED — "a refund requires a
//     reason (audit trail)" (refund.ts:96-98);
//   - a blank requester refuses REFUND_REQUESTER_REQUIRED — "a refund
//     requires a requester" (refund.ts:99-101); the body may omit it (the
//     authenticated principal is the requester — a USER/apiKey principal id
//     is never blank);
//   - a non-positive amount refuses REFUND_AMOUNT_INVALID — "refund amount
//     must be positive" (refund.ts:102-104);
//   - a cross-currency amount refuses CURRENCY_MISMATCH — Money.compareTo
//     surfaces the shared money guard BEFORE the ceiling comparison can
//     succeed ("cannot compare <amount> with <ceiling>", money.ts:56-63;
//     refund.ts:105-107 documents exactly this order);
//   - an amount above the ceiling refuses REFUND_EXCEEDS_CEILING —
//     "refund <amount> exceeds ceiling <ceiling>" with the domain's
//     {requestedMinor, ceilingMinor, paymentId} details (refund.ts:107-113).
//
// The ceiling is the schema's own R6 face (trg_refunds_check_r6,
// 0007_adjustments.sql: confirmed − Σ(active allocations) − Σ(live refunds);
// 'rejected'/'failed' attempts release their reservation) and the payments
// lane's committed/unapplied math (payment.ts:120-137): an unconfirmed
// payment has nothing landed → ceiling 0 → any positive amount refuses.
// The independent value guards collect refusals; the snapshot guards run
// only on a value-clean proposal (they depend on a valid amount). NOTHING is
// persisted — an unknown payment answers the payments surface's 404.
func (s *Services) EvaluateRefundReservationIntent(ctx context.Context, q repositories.Querier, orgID, principalID string, cmd RefundIntentCommand) (RefundIntentResult, error) {
	refusals := []AdjustmentRefusal{}
	if strings.TrimSpace(cmd.Reason) == "" {
		refusals = append(refusals, AdjustmentRefusal{
			Code:    CodeRefundReasonRequired,
			Message: "a refund requires a reason (audit trail)",
			Field:   "reason",
		})
	}
	requestedBy := cmd.RequestedBy
	if requestedBy == "" {
		requestedBy = principalID
	}
	if strings.TrimSpace(requestedBy) == "" {
		refusals = append(refusals, AdjustmentRefusal{
			Code:    CodeRefundRequesterRequired,
			Message: "a refund requires a requester",
			Field:   "requestedBy",
		})
	}
	if cmd.AmountMinor <= 0 {
		refusals = append(refusals, AdjustmentRefusal{
			Code:    CodeRefundAmountInvalid,
			Message: "refund amount must be positive",
			Field:   "amount.minor",
		})
	}
	if len(refusals) > 0 {
		return RefundIntentResult{Accepted: false, Refusals: refusals}, nil
	}

	// Org-scoped payment lookup — a foreign-org payment answers the same 404
	// (existence is never leaked across orgs).
	payment, err := s.Stores.PaymentByID(ctx, q, orgID, cmd.PaymentID)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return RefundIntentResult{}, infra.NewDomainError(CodePaymentNotFound, "payment "+cmd.PaymentID+" does not exist", nil)
		}
		return RefundIntentResult{}, err
	}

	// The R6 ceiling from the snapshot (see the doc comment): confirmed −
	// committed, clamped at zero the way unappliedMinorOf reports hand-built
	// data (payment.ts:132-137).
	ceilingMinor := int64(0)
	if payment.ConfirmedMinor != nil {
		allocations, refunds, err := s.Stores.CommittedAgainstPayment(ctx, q, orgID, cmd.PaymentID)
		if err != nil {
			return RefundIntentResult{}, err
		}
		ceilingMinor = *payment.ConfirmedMinor - allocations - refunds
		if ceilingMinor < 0 {
			ceilingMinor = 0
		}
	}

	if cmd.Currency != payment.Currency {
		return RefundIntentResult{Accepted: false, Refusals: []AdjustmentRefusal{{
			Code:    CodeCurrencyMismatch,
			Message: "cannot compare " + cmd.Currency + " with " + payment.Currency,
			Field:   "amount.currency",
		}}}, nil
	}
	if cmd.AmountMinor > ceilingMinor {
		return RefundIntentResult{Accepted: false, Refusals: []AdjustmentRefusal{{
			Code:    CodeRefundExceedsCeiling,
			Message: "refund " + moneyText(cmd.AmountMinor, cmd.Currency) + " exceeds ceiling " + moneyText(ceilingMinor, payment.Currency),
			Field:   "amount",
			Details: map[string]any{
				"requestedMinor": cmd.AmountMinor,
				"ceilingMinor":   ceilingMinor,
				"paymentId":      cmd.PaymentID,
			},
		}}}, nil
	}

	return RefundIntentResult{
		Accepted: true,
		Intent: &RefundIntent{
			ID:              s.IDs(),
			PaymentID:       cmd.PaymentID,
			RequestedBy:     requestedBy,
			Reason:          strings.TrimSpace(cmd.Reason),
			TotalMinor:      cmd.AmountMinor,
			Currency:        cmd.Currency,
			State:           "requested",
			CeilingMinor:    ceilingMinor,
			CeilingCurrency: payment.Currency,
		},
		Refusals: []AdjustmentRefusal{},
	}, nil
}
