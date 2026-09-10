// The collections STK execute path (issue #178) — the Go wiring of the
// policy-gated `collect_now_stk_push` execution action (issue #113's TS
// lane) to the OUTBOUND Daraja client behind the StkPushWire port:
//
//	gates (amount/currency/MSISDN/prompt text + clearance or approval +
//	K2 consent) ──▶ StkPushWire.Initiate (R9 key "stkpush:<actionId>")
//	  ├─ accepted  → stk_initiations row + durable key claim +
//	│                collections.stkPushInitiated fact (one transaction)
//	└─ rejected   → collections.stkPushNotInitiated fact; the attempt is
//	                 UNCHANGED (retryable) — the refusal is on the record
//
// and the callback-side settle path (ReconcileStkResult) that drives the
// EXISTING payments intake funnel — the same R9 semantics C2B uses.
//
// House rules carried over from the TS lane: money only in KES integer
// minor units (R10); the MSISDN is PII — it normalizes here, encodes to the
// Daraja wire form for the transient port command, and NEVER enters an
// event payload; refusal is a first-class outcome with machine-readable
// codes surfaced as contract envelopes by the transport.
package application

import (
	"context"
	"errors"
	"regexp"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/daraja"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// The durable scope the STK execute path claims its R9 initiation keys
// under (idempotency_keys.scope — UNIQUE (org_id, scope, key)).
const idempotencyScopeStk = "collections.stk"

// The STK consent surface (the TS lane's DPA modeling): an STK push is an
// automated outbound dunning contact delivered to the customer's handset —
// the sms/dunning pair. A dunning grant on whatsapp/email never unlocks a
// push, and a marketing grant never implies dunning.
const (
	StkConsentChannel = "sms"
	StkConsentPurpose = "dunning"
)

// DefaultStkPushTTL is the stuck-push deadline: Daraja itself abandons the
// prompt in ~2 minutes.
const DefaultStkPushTTL = 2 * time.Minute

// Stable codes the STK execute path produces (the port of the TS lane's
// STK_* vocabulary; the transport's status table maps them onto the wire).
const (
	CodeStkOrgRequired               = "STK_ORG_REQUIRED"
	CodeStkCustomerRequired          = "STK_CUSTOMER_REQUIRED"
	CodeStkActionRequired            = "STK_ACTION_REQUIRED"
	CodeStkActorInvalid              = "STK_ACTOR_INVALID"
	CodeStkAutonomyMismatch          = "STK_AUTONOMY_MISMATCH"
	CodeStkAmountInvalid             = "STK_AMOUNT_INVALID"
	CodeStkCurrencyUnsupported       = "STK_CURRENCY_UNSUPPORTED"
	CodeStkMsisdnInvalid             = "STK_MSISDN_INVALID"
	CodeStkReferenceInvalid          = "STK_REFERENCE_INVALID"
	CodeStkApprovalInvalid           = "STK_APPROVAL_INVALID"
	CodeStkClearanceInvalid          = "STK_CLEARANCE_INVALID"
	CodeStkDecisionMismatch          = "STK_DECISION_MISMATCH"
	CodeStkClearanceAmountExceeded   = "STK_CLEARANCE_AMOUNT_EXCEEDED"
	CodeStkClearanceChannelForbidden = "STK_CLEARANCE_CHANNEL_FORBIDDEN"
	CodeStkClearanceExpired          = "STK_CLEARANCE_EXPIRED"
	CodeStkConsentRequired           = "STK_CONSENT_REQUIRED"
	CodeStkTTLInvalid                = "STK_TTL_INVALID"
	CodeStkWireEchoInvalid           = "STK_WIRE_ECHO_INVALID"
	CodeStkStateInvalid              = "STK_STATE_INVALID"
	CodeStkAmountMismatch            = "STK_AMOUNT_MISMATCH"
	// STK_WIRE_UNAVAILABLE is the disabled-port refusal (no adapter bound —
	// a composition misconfiguration); the status table leaves it unmapped
	// so it fails closed to the generic 500.
	CodeStkWireUnavailable = "STK_WIRE_UNAVAILABLE"
)

// Daraja prompt constraints (the conformance mirror in the TS lane).
var (
	accountReferencePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,12}$`)
	checkoutEchoPattern     = regexp.MustCompile(`^ws_CO_[A-Za-z0-9]{6,24}$`)
)

// maxSafeJSONInteger is the lossless-JSON ceiling the TS lane asserts
// (Number.MAX_SAFE_INTEGER): an event payload must carry the amount
// losslessly, so a bigger amount is a bug, not a collection.
const maxSafeJSONInteger = int64(1)<<53 - 1

// StkClearance is the policy engine's ALLOW decision, carried to the
// execute path as its permission. A refusal never initiates: the gate stage
// upstream answers refusals as values; this type only transports an allow.
type StkClearance struct {
	// Decision must be exactly "allow" — anything else refuses.
	Decision string
	// OrgID must equal the executing org (a foreign-org clearance grants
	// nothing — STK_DECISION_MISMATCH).
	OrgID string
	// MaxAmountMinor caps the collection when > 0.
	MaxAmountMinor int64
	// AllowedChannels constrains the contact channel when non-empty; the
	// STK push rides the sms channel (StkConsentChannel).
	AllowedChannels []string
	// ExpiresAt lapses the grant — a lapsed clearance never initiates.
	ExpiresAt *time.Time
}

// StkApproval is the human approval that unlocks a parked attempt (the
// require_approval path): a non-blank reference and approver.
type StkApproval struct {
	Ref        string
	ApproverID string
}

// StkPushCommand is one collect-now execution attempt.
type StkPushCommand struct {
	// ActionID is the collections execution action's opaque id — the R9
	// initiation key derives from it ("stkpush:<actionId>").
	ActionID string
	// CustomerID is the payer ("" = unattributed — money parks unapplied).
	CustomerID string
	// AmountMinor is what the customer is asked to pay: KES integer minor
	// units (R10), > 0, JSON-lossless.
	AmountMinor int64
	// Currency must be KES (the M-Pesa rail; R10).
	Currency string
	// MSISDN is the payer handset in ANY Kenyan shape (07… / 254… / +254… /
	// 00254…) — normalized here, re-encoded to Daraja wire form for the
	// transient port command only.
	MSISDN string
	// AccountReference is shown on the SIM prompt (≤ 12 alphanumerics).
	AccountReference string
	// TransactionDesc is shown on the SIM prompt (≤ 26 chars).
	TransactionDesc string
	// ActorID names the executor (human collector or the AI agent) for the
	// audit trail.
	ActorID string
	// Autonomous marks a no-human-in-the-loop push — it REQUIRES a dunning
	// consent reference (K2) and refuses an approval.
	Autonomous bool
	// ConsentRef is the verified dunning consent reference (K2); required
	// for autonomous pushes.
	ConsentRef string
	// Approval unlocks an approved attempt (the human-in-the-loop path);
	// exactly one of Approval / Clearance must be carried.
	Approval *StkApproval
	// Clearance is the policy engine's allow decision (the proposed path).
	Clearance *StkClearance
	// TTL overrides the stuck-push deadline; 0 = DefaultStkPushTTL.
	TTL time.Duration
}

// StkPushExecution is the execute outcome: the rail echo + the durable
// initiation identity. Accepted=false carries RejectionReason (the rail's
// machine-readable refusal) and is NOT an error — the attempt is retryable.
type StkPushExecution struct {
	Accepted        bool
	Replayed        bool // the R9 replay of an already-committed initiation
	InitiationID    string
	IdempotencyKey  string
	Receipt         daraja.StkPushReceipt
	RejectionReason string
	ExpiresAt       time.Time
}

// initiationIdempotencyKey is the R9 retry-safe initiation key: retrying
// the same action collapses onto one prompt.
func initiationIdempotencyKey(actionID string) string {
	return "stkpush:" + actionID
}

// paymentIdempotencyKey is the R9 payment journey key — byte-identical to
// the TS lane's convention, so a callback that traveled through the parser
// and a re-delivered one reconcile onto the SAME payment.
func paymentIdempotencyKey(checkoutRequestID string) string {
	return "daraja:stk:" + checkoutRequestID
}

// ExecuteStkPush runs the gates, hands the initiation to the injected port
// and records the outcome. Idempotency is end-to-end: the R9 key
// "stkpush:<actionId>" rides the port command (the client collapses
// CONCURRENT duplicates onto one wire call), the durable registry replays
// COMMITTED initiations across processes, and the (org, key) unique index
// is the final guard.
func (s *Services) ExecuteStkPush(ctx context.Context, orgID string, cmd StkPushCommand) (StkPushExecution, error) {
	if trim(orgID) == "" {
		return StkPushExecution{}, infra.NewDomainError(CodeStkOrgRequired, "an org is required to execute an STK push", nil)
	}
	actionID := trim(cmd.ActionID)
	if actionID == "" {
		return StkPushExecution{}, infra.NewDomainError(CodeStkActionRequired, "an execution action id is required", nil)
	}
	actorID := trim(cmd.ActorID)
	if actorID == "" {
		return StkPushExecution{}, infra.NewDomainError(CodeStkActorInvalid, "an execution requires an actor", nil)
	}
	if cmd.Autonomous && cmd.Approval != nil {
		return StkPushExecution{}, infra.NewDomainError(CodeStkAutonomyMismatch,
			"autonomous means no human in the loop — an approval contradicts an autonomous push", nil)
	}

	if cmd.Currency != "KES" {
		return StkPushExecution{}, infra.NewDomainError(CodeStkCurrencyUnsupported,
			"STK push collects on the M-Pesa rail (KES only), got "+cmd.Currency+" (R10)", nil)
	}
	if cmd.AmountMinor <= 0 {
		return StkPushExecution{}, infra.NewDomainError(CodeStkAmountInvalid, "the collection amount must be > 0", nil)
	}
	if cmd.AmountMinor > maxSafeJSONInteger {
		return StkPushExecution{}, infra.NewDomainError(CodeStkAmountInvalid,
			"the collection amount exceeds the safe-integer ceiling (cannot be carried losslessly)", nil)
	}

	wireMSISDN, err := darajaWireMSISDN(cmd.MSISDN)
	if err != nil {
		return StkPushExecution{}, err
	}
	reference := trim(cmd.AccountReference)
	if !accountReferencePattern.MatchString(reference) {
		return StkPushExecution{}, infra.NewDomainError(CodeStkReferenceInvalid,
			"accountReference \""+reference+"\" must be 1–12 alphanumerics (the SIM prompt reference)", nil)
	}
	description := trim(cmd.TransactionDesc)
	if description == "" || len(description) > 26 {
		return StkPushExecution{}, infra.NewDomainError(CodeStkReferenceInvalid,
			"transactionDesc must be 1–26 characters (the SIM prompt description)", nil)
	}

	ttl := cmd.TTL
	if ttl == 0 {
		ttl = DefaultStkPushTTL
	}
	if ttl <= 0 {
		return StkPushExecution{}, infra.NewDomainError(CodeStkTTLInvalid, "ttl must be a positive duration", nil)
	}

	if cmd.Approval != nil {
		if trim(cmd.Approval.Ref) == "" || trim(cmd.Approval.ApproverID) == "" {
			return StkPushExecution{}, infra.NewDomainError(CodeStkApprovalInvalid,
				"an approval requires a non-blank reference and approver", nil)
		}
	} else if cmd.Clearance != nil {
		if err := assertStkClearance(s.Now(), orgID, cmd.AmountMinor, *cmd.Clearance); err != nil {
			return StkPushExecution{}, err
		}
	} else {
		return StkPushExecution{}, infra.NewDomainError(CodeStkClearanceInvalid,
			"execution requires the policy engine's allow clearance or a human approval", nil)
	}

	// K2 consent gate: an automated outbound handset contact is dunning on
	// the sms channel — no verified consent reference, no push, and the
	// refusal is compliance-recorded (nothing was sent).
	if cmd.Autonomous && trim(cmd.ConsentRef) == "" {
		refusal := infra.NewDomainError(CodeStkConsentRequired,
			"an autonomous STK push requires an active dunning consent reference (K2) — nothing was sent", nil)
		if factErr := s.appendStkFact(ctx, orgID, actionID, "collections.stkPushRefused", map[string]any{
			"actionId":   actionID,
			"stage":      "consent",
			"reasonCode": refusal.Code,
			"detail":     refusal.Message,
			"refusedAt":  repositories.ISO(s.Clock.Now()),
		}); factErr != nil {
			return StkPushExecution{}, factErr
		}
		return StkPushExecution{}, refusal
	}

	// R9 replay probe (durable): a committed initiation replays its receipt.
	idempotencyKey := initiationIdempotencyKey(actionID)
	if ref := s.lookupIdempotencyKey(ctx, s.Stores.Pool, orgID, idempotencyScopeStk, idempotencyKey); ref != "" {
		row, err := s.Stores.StkInitiationByID(ctx, s.Stores.Pool, orgID, ref)
		if err == nil {
			return s.stkReplay(row), nil
		}
		if !errors.Is(err, repositories.ErrNotFound) {
			return StkPushExecution{}, err
		}
		// The claimed ref no longer resolves (row deleted out-of-band):
		// fall through and refuse the re-execution below — a claimed key
		// never silently re-prompts.
		return StkPushExecution{}, infra.NewDomainError(CodeStkStateInvalid,
			"initiation key "+idempotencyKey+" is claimed but its record is gone — resolve the stuck attempt before re-prompting", nil)
	}

	if s.StkPush == nil {
		return StkPushExecution{}, infra.NewDomainError(CodeStkWireUnavailable,
			"no STK wire adapter is bound — the Daraja client is not configured in this deployment", nil)
	}

	receipt, wireErr := s.StkPush.Initiate(ctx, daraja.StkPushCommand{
		ActionID:         actionID,
		OrgID:            orgID,
		CustomerID:       cmd.CustomerID,
		AmountMinor:      cmd.AmountMinor,
		MSISDN:           wireMSISDN,
		AccountReference: reference,
		TransactionDesc:  description,
		IdempotencyKey:   idempotencyKey,
	})
	attemptedAt := s.Clock.Now()
	if wireErr != nil {
		// Wire rejection: the attempt is UNCHANGED (retryable) — the refusal
		// is on the record (stk.pushNotInitiated family), the reason is the
		// rail's own machine-readable code.
		reason := CodeStkWireEchoInvalid
		var de *daraja.Error
		if errors.As(wireErr, &de) {
			reason = de.Code
		}
		if factErr := s.appendStkFact(ctx, orgID, actionID, "collections.stkPushNotInitiated", map[string]any{
			"actionId":    actionID,
			"reason":      reason,
			"detail":      wireErr.Error(),
			"attemptedAt": repositories.ISO(attemptedAt),
		}); factErr != nil {
			return StkPushExecution{}, factErr
		}
		return StkPushExecution{IdempotencyKey: idempotencyKey, RejectionReason: reason}, nil
	}

	if receipt.CheckoutRequestID == "" || !checkoutEchoPattern.MatchString(receipt.CheckoutRequestID) {
		return StkPushExecution{}, infra.NewDomainError(CodeStkWireEchoInvalid,
			"rail echo checkoutRequestId \""+receipt.CheckoutRequestID+"\" must match ws_CO_<alphanumerics> — dead attempt", nil)
	}
	if trim(receipt.MerchantRequestID) == "" {
		return StkPushExecution{}, infra.NewDomainError(CodeStkWireEchoInvalid,
			"rail echo merchantRequestId is required — dead attempt", nil)
	}

	initiation := repositories.StkInitiationRow{
		ID:                s.IDs(),
		OrgID:             orgID,
		ActionID:          actionID,
		CheckoutRequestID: receipt.CheckoutRequestID,
		MerchantRequestID: receipt.MerchantRequestID,
		CustomerID:        strPtrOf(trim(cmd.CustomerID)),
		IdempotencyKey:    idempotencyKey,
		RequestedMinor:    cmd.AmountMinor,
		Currency:          "KES",
		State:             "initiated",
		InitiatedAt:       attemptedAt,
	}
	err = s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		if err := s.Stores.InsertStkInitiation(ctx, tx, initiation); err != nil {
			if repositories.UniqueViolation(err) {
				// A concurrent execution of the SAME action committed first:
				// this transaction rolls back whole and the winner replays.
				return errStkRaceReplay
			}
			return err
		}
		if _, _, err := s.claimIdempotencyKey(ctx, tx, orgID, idempotencyScopeStk, idempotencyKey, initiation.ID); err != nil {
			return err
		}
		expiresAt := attemptedAt.Add(ttl)
		return s.appendOutbox(ctx, tx, orgID, "collections.stkPushInitiated", actionID, map[string]any{
			"actionId":          actionID,
			"initiationId":      initiation.ID,
			"merchantRequestId": receipt.MerchantRequestID,
			"checkoutRequestId": receipt.CheckoutRequestID,
			"idempotencyKey":    idempotencyKey,
			"amountMinor":       cmd.AmountMinor,
			"currency":          "KES",
			"actorId":           actorID,
			"autonomous":        cmd.Autonomous,
			"ttlMs":             ttl.Milliseconds(),
			"expiresAt":         repositories.ISO(expiresAt),
			"initiatedAt":       repositories.ISO(attemptedAt),
		})
	})
	if errors.Is(err, errStkRaceReplay) {
		row, rerr := s.Stores.StkInitiationByIdempotencyKey(ctx, s.Stores.Pool, orgID, idempotencyKey)
		if rerr != nil {
			return StkPushExecution{}, rerr
		}
		return s.stkReplay(row), nil
	}
	if err != nil {
		return StkPushExecution{}, err
	}
	s.rememberReplay(orgID, idempotencyScopeStk, idempotencyKey, initiation.ID)

	return StkPushExecution{
		Accepted:       true,
		InitiationID:   initiation.ID,
		IdempotencyKey: idempotencyKey,
		Receipt:        receipt,
		ExpiresAt:      attemptedAt.Add(ttl),
	}, nil
}

// errStkRaceReplay signals "a concurrent execution of the same action won
// the (org, initiation key) race — replay the committed winner". Internal
// only; never leaves the service.
var errStkRaceReplay = errors.New("application: stk initiation lost the insert race — replay the committed winner")

// stkReplay renders a committed initiation as the accepted result (the R9
// duplicate is the SAME logical command: same receipt, replay flag set).
func (s *Services) stkReplay(row repositories.StkInitiationRow) StkPushExecution {
	return StkPushExecution{
		Accepted:       true,
		Replayed:       true,
		InitiationID:   row.ID,
		IdempotencyKey: row.IdempotencyKey,
		Receipt: daraja.StkPushReceipt{
			MerchantRequestID: row.MerchantRequestID,
			CheckoutRequestID: row.CheckoutRequestID,
		},
		ExpiresAt: row.InitiatedAt.Add(DefaultStkPushTTL),
	}
}

// appendStkFact appends one STK execution fact to the outbox in its own
// transaction (the refusal records carry no state change of their own).
func (s *Services) appendStkFact(ctx context.Context, orgID, actionID, name string, payload map[string]any) error {
	return s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		return s.appendOutbox(ctx, tx, orgID, name, actionID, payload)
	})
}

// assertStkClearance is the port of the TS lane's assertClearance: a
// clearance that does not clear refuses the initiation (a refusal grants
// nothing; a foreign-org grant never applies; a lapsed grant never
// initiates).
func assertStkClearance(now time.Time, orgID string, amountMinor int64, clearance StkClearance) error {
	if clearance.Decision != "allow" {
		return infra.NewDomainError(CodeStkClearanceInvalid,
			"initiation requires an allow decision, got "+clearance.Decision+" (a refusal grants nothing)", nil)
	}
	if clearance.OrgID != orgID {
		return infra.NewDomainError(CodeStkDecisionMismatch, "the clearance belongs to another org", nil)
	}
	if clearance.MaxAmountMinor > 0 && amountMinor > clearance.MaxAmountMinor {
		return infra.NewDomainError(CodeStkClearanceAmountExceeded,
			"the collection amount exceeds the granted maxAmountMinor", nil)
	}
	if len(clearance.AllowedChannels) > 0 {
		allowed := false
		for _, channel := range clearance.AllowedChannels {
			if channel == StkConsentChannel {
				allowed = true
				break
			}
		}
		if !allowed {
			return infra.NewDomainError(CodeStkClearanceChannelForbidden,
				"the grant allows channels other than "+StkConsentChannel+" — the STK push rides "+StkConsentChannel, nil)
		}
	}
	if clearance.ExpiresAt != nil && !now.Before(*clearance.ExpiresAt) {
		return infra.NewDomainError(CodeStkClearanceExpired, "the grant lapsed — a lapsed clearance never initiates", nil)
	}
	return nil
}

// StkReconcileCommand is one parsed STK result callback reduced to the
// settle facts the payments funnel needs (the K1 parse happened at the
// transport boundary; the intake amount is the E11 initiation record).
type StkReconcileCommand struct {
	CheckoutRequestID string
	Success           bool
	ReceiptNumber     string // success only ('' otherwise)
	FailureCode       string // STK_* family, failures only
	// HasPaid/PaidMinor carry the callback metadata Amount (success only):
	// it is EVIDENCE and must agree with the initiated amount exactly or the
	// callback is refused as tampered before anything is written (K1).
	HasPaid   bool
	PaidMinor int64
}

// StkReconcileResult carries the ONE payment the checkout maps to and the
// R9 verdict.
type StkReconcileResult struct {
	Payment   repositories.PaymentRow
	Duplicate bool
	Failed    bool
}

// ReconcileStkResult settles one fresh STK result callback through the
// EXISTING payments intake core (the same funnel C2B uses — R9 idempotency
// on "daraja:stk:<checkoutRequestId>"):
//
//   - success: intake → confirm (state, payment.confirmed fact and the
//     balanced ledger entry commit in ONE transaction);
//   - failure: intake → fail (failed_at + failure_code, STK_RESULT family);
//   - duplicate: the SAME payment replays, nothing re-runs (the intake's
//     duplicateCallbackObserved tripwire already fired inside it).
//
// The success metadata amount must agree with the initiation's requested
// amount exactly, or the callback is refused as tampered (K1) BEFORE
// anything is written — the merchant knows what it asked for (E11).
func (s *Services) ReconcileStkResult(ctx context.Context, orgID string, cmd StkReconcileCommand) (StkReconcileResult, error) {
	initiation, err := s.Stores.StkInitiationByCheckout(ctx, s.Stores.Pool, cmd.CheckoutRequestID)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return StkReconcileResult{}, infra.NewDomainError(CodeStkStateInvalid,
				"no initiation record for checkout "+cmd.CheckoutRequestID+" — the callback routes to nothing", nil)
		}
		return StkReconcileResult{}, err
	}
	if initiation.OrgID != orgID {
		return StkReconcileResult{}, infra.NewDomainError(CodeStkStateInvalid,
			"checkout "+cmd.CheckoutRequestID+" does not belong to this org", nil)
	}
	if cmd.Success && cmd.HasPaid && cmd.PaidMinor != initiation.RequestedMinor {
		return StkReconcileResult{}, infra.NewDomainError(CodeStkAmountMismatch,
			"success metadata carries different money than the attempt initiated — refusing to confirm untrusted money (K1)", nil)
	}
	if initiation.State != "initiated" {
		// The initiation already settled: the journey claim upstream should
		// have caught this — refuse rather than re-run (fail closed).
		return StkReconcileResult{}, infra.NewDomainError(CodeStkStateInvalid,
			"initiation for checkout "+cmd.CheckoutRequestID+" is already "+initiation.State, nil)
	}

	intake, err := s.Intake(ctx, orgID, IntakeCommand{
		Channel:        "stk",
		ExternalRef:    cmd.ReceiptNumberOrCheckout(),
		IdempotencyKey: paymentIdempotencyKey(cmd.CheckoutRequestID),
		AmountMinor:    initiation.RequestedMinor,
		Currency:       initiation.Currency,
		CustomerID:     derefString(initiation.CustomerID),
	})
	if err != nil {
		return StkReconcileResult{}, err
	}
	// R9: the SAME logical payment, the tripwire event, nothing else.
	if intake.Duplicate {
		return StkReconcileResult{Payment: intake.Payment, Duplicate: true}, nil
	}

	if !cmd.Success {
		if err := s.Stores.FailPayment(ctx, s.Stores.Pool, orgID, intake.Payment.ID, cmd.FailureCode, s.Clock.Now()); err != nil {
			return StkReconcileResult{}, err
		}
		if err := s.Stores.ResolveStkInitiation(ctx, s.Stores.Pool, orgID, cmd.CheckoutRequestID, "failed", cmd.FailureCode, s.Clock.Now()); err != nil {
			return StkReconcileResult{}, err
		}
		failed, err := s.Stores.PaymentByID(ctx, s.Stores.Pool, orgID, intake.Payment.ID)
		if err != nil {
			return StkReconcileResult{}, err
		}
		return StkReconcileResult{Payment: failed, Failed: true}, nil
	}

	confirm, err := s.Confirm(ctx, orgID, intake.Payment.ID, initiation.RequestedMinor, initiation.Currency)
	if err != nil {
		return StkReconcileResult{}, err
	}
	if err := s.Stores.ResolveStkInitiation(ctx, s.Stores.Pool, orgID, cmd.CheckoutRequestID, "reconciled", "", s.Clock.Now()); err != nil {
		return StkReconcileResult{}, err
	}
	return StkReconcileResult{Payment: confirm.Payment}, nil
}

// ReceiptNumberOrCheckout mirrors the TS intake command: the receipt is the
// money-facing external ref when the rail issued one; an abandonment falls
// back to the checkout id (never a blank ref).
func (c StkReconcileCommand) ReceiptNumberOrCheckout() string {
	if c.ReceiptNumber != "" {
		return c.ReceiptNumber
	}
	return c.CheckoutRequestID
}

// darajaWireMSISDN normalizes ANY Kenyan shape (the ussd lane's
// normalizeMsisdn semantics: 07… / 254… / +254… / 00254…, separators
// ignored) and re-encodes the result into Daraja wire form (the + stripped).
// The MSISDN is PII: it lives on the transient port command only.
func darajaWireMSISDN(raw string) (string, error) {
	stripped := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if c == ' ' || c == '-' || c == '(' || c == ')' || c == '.' {
			continue
		}
		stripped = append(stripped, c)
	}
	s := string(stripped)
	for _, prefix := range []string{"+254", "00254", "254", "0"} {
		if len(s) > len(prefix) && s[:len(prefix)] == prefix {
			s = s[len(prefix):]
			break
		}
	}
	if len(s) != 9 || (s[0] != '7' && s[0] != '1') {
		return "", infra.NewDomainError(CodeStkMsisdnInvalid,
			"msisdn is not a normalizable Kenyan number (expected +254 / 254 / 0 / local shapes, subscriber 9 digits starting 7 or 1)", nil)
	}
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return "", infra.NewDomainError(CodeStkMsisdnInvalid, "msisdn must be digits only", nil)
		}
	}
	return "254" + s, nil
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
