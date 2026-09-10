// The Daraja rail-facing callback endpoints (issue #178): the mounts that
// connect Safaricom's M-Pesa pipes to the EXISTING payments intake funnel.
// Three rows, three semantics (mirroring the TS simulator's delivery
// pipeline, src/adapters/daraja/simulator.ts):
//
//	POST /v1/callbacks/daraja/:orgId/c2b/validation    — the pre-acceptance
//	    GATE: parse (K1) and acknowledge. Never ledgered, never money — the
//	    confirmation callback is the money fact.
//	POST /v1/callbacks/daraja/:orgId/c2b/confirmation  — the money fact:
//	    parse → R9 intake funnel (durable journey claim) → payments intake →
//	    idempotent confirm (state + payment.confirmed + the balanced ledger
//	    entry, one transaction).
//	POST /v1/callbacks/daraja/stk/result               — the STK push result:
//	    routed by the globally-unique rail-minted CheckoutRequestID (the
//	    initiation record IS the org router — uq_stk_initiations_checkout),
//	    then the same funnel through ReconcileStkResult (confirm or fail).
//
// These rows are PUBLIC by necessity: Daraja's callbacks carry no Fuatilia
// credentials ("callbacks are not signed by the provider" — the threat
// model's B1 boundary), so the kernel rate-limits them per client IP and
// every payload is processed as hostile evidence: parse → IntakeCallback →
// only on a fresh-or-recoverable journey does the domain move money.
// Structurally-wrong payloads are refused with their promised DARAJA_* code
// and dead-lettered (never retried into the domain, SPEC §14).
//
// The response body is the §38 envelope like every mounted row; its data
// carries the Daraja-shaped acknowledgment ({ResultCode, ResultDesc} — the
// rail's own convention) plus the funnel verdict for ops correlation.
package transport

import (
	"encoding/json"
	"errors"
	"log/slog"
	"strings"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/daraja"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// Transport-level codes for the callback surface (the rail-routing refusals
// the parser cannot know about). Both fall under the status table's suffix
// rules (400) — a misrouted callback is dead-lettered, never processed.
const (
	CodeDarajaCallbackOrgInvalid = "DARAJA_CALLBACK_ORG_INVALID"
	CodeDarajaCallbackOrgUnknown = "DARAJA_CALLBACK_ORG_UNKNOWN"
)

// darajaCallbackRoutes mounts the three rail-facing rows. They are appended
// AFTER the capability derivation (public rows never become capabilities)
// and are excluded from the OpenAPI console parity by the pinned rail set in
// parity_test.go — the rail is an integration surface, not a console op.
func darajaCallbackRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method:  "POST",
			Pattern: "/v1/callbacks/daraja/:orgId/c2b/validation",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				orgID, err := callbackOrg(rc, svc)
				if err != nil {
					return HandlerResult{}, err
				}
				parsed, err := parseCallbackBody(rc, daraja.ParseOptions{C2BKind: daraja.KindC2BValidation})
				if err != nil {
					return HandlerResult{}, err
				}
				c2b, ok := parsed.(daraja.ParsedC2bCallback)
				if !ok || c2b.Kind != daraja.KindC2BValidation {
					return HandlerResult{}, misroutedCallback()
				}
				// The gate: IntakeCallback classifies a validation as
				// `acknowledged` — no journey claim, no money state, no intake
				// (the TS lane documents exactly this: it keeps the R9 tripwire
				// a meaningful ops signal for the confirmation that follows).
				verdict, err := daraja.IntakeCallback(rc.context(), journeyLedger(svc, orgID, daraja.KindC2BValidation), parsed, darajaIntakeHooks(rc))
				if err != nil {
					return HandlerResult{}, darajaRefusal(err)
				}
				if verdict.Outcome != daraja.OutcomeAcknowledged {
					return HandlerResult{}, misroutedCallback()
				}
				return HandlerResult{Status: 200, Data: map[string]any{
					"ResultCode": 0,
					"ResultDesc": "Accepted",
					"journeyKey": verdict.JourneyKey,
				}}, nil
			},
		},
		{
			Method:  "POST",
			Pattern: "/v1/callbacks/daraja/:orgId/c2b/confirmation",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				orgID, err := callbackOrg(rc, svc)
				if err != nil {
					return HandlerResult{}, err
				}
				parsed, err := parseCallbackBody(rc, daraja.ParseOptions{C2BKind: daraja.KindC2BConfirm})
				if err != nil {
					return HandlerResult{}, err
				}
				c2b, ok := parsed.(daraja.ParsedC2bCallback)
				if !ok || c2b.Kind != daraja.KindC2BConfirm {
					return HandlerResult{}, misroutedCallback()
				}
				verdict, err := daraja.IntakeCallback(rc.context(), journeyLedger(svc, orgID, daraja.KindC2BConfirm), parsed, darajaIntakeHooks(rc))
				if err != nil {
					return HandlerResult{}, darajaRefusal(err)
				}
				if verdict.Outcome != daraja.OutcomeAccepted && verdict.Outcome != daraja.OutcomeDuplicate {
					return HandlerResult{}, misroutedCallback()
				}
				// Settle through the ONE payments funnel — on fresh journeys
				// AND on duplicates alike. Both halves are idempotent by
				// design: the intake replays the existing payment under the
				// R9 key (firing its own duplicate tripwire), and a re-confirm
				// of the same amount is the domain's no-op — so a redelivery
				// that arrives while a prior delivery died mid-settle still
				// lands the money exactly once.
				intake, err := svc.Intake(rc.context(), orgID, application.IntakeCommand{
					Channel:        "c2b",
					ExternalRef:    c2b.TransID,
					IdempotencyKey: c2bPaymentKey(c2b.TransID),
					AmountMinor:    c2b.AmountMinor,
					Currency:       "KES", // R10 — the M-Pesa rail is KES-only; the wire carries no currency
					DeclaredRefs:   c2b.DeclaredRefs,
				})
				if err != nil {
					return HandlerResult{}, err
				}
				confirm, err := svc.Confirm(rc.context(), orgID, intake.Payment.ID, c2b.AmountMinor, "KES")
				if err != nil {
					return HandlerResult{}, err
				}
				return callbackAck(c2b.JourneyKey,
					verdict.Outcome == daraja.OutcomeDuplicate || intake.Duplicate,
					confirm.Payment.ID, confirm.Payment.State), nil
			},
		},
		{
			Method:  "POST",
			Pattern: "/v1/callbacks/daraja/stk/result",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				// The org router (E11): the rail-minted checkout id is the ONLY
				// field a result callback carries, and it is globally unique.
				// The peek is a hint only — the K1 parse still validates every
				// wire rule; the hint selects the initiation row that backs the
				// intake amount (failure results carry NO amount on the wire).
				checkout := peekCheckoutRequestID(body)
				var initiation repositories.StkInitiationRow
				requested := map[string]int64{}
				if checkout != "" {
					row, err := svc.Stores.StkInitiationByCheckout(rc.context(), svc.Stores.Pool, checkout)
					if errors.Is(err, repositories.ErrNotFound) {
						return HandlerResult{}, infra.NewDomainError(application.CodeStkStateInvalid,
							"checkout "+checkout+" has no initiation record — the callback routes to nothing", nil)
					}
					if err != nil {
						return HandlerResult{}, err
					}
					initiation = row
					requested[checkout] = row.RequestedMinor
				}
				parsed, err := parseCallbackBody(rc, daraja.ParseOptions{STKRequested: requested})
				if err != nil {
					return HandlerResult{}, err
				}
				stk, ok := parsed.(daraja.ParsedSTKCallback)
				if !ok || stk.Kind != daraja.KindSTKResult {
					return HandlerResult{}, misroutedCallback()
				}
				// Unreachable by construction (the parser requires
				// CheckoutRequestID, so a parsed STK result always routed), but
				// the money path refuses to run org-blind — fail closed.
				if initiation.OrgID == "" {
					return HandlerResult{}, infra.NewDomainError(application.CodeStkStateInvalid,
						"STK result carried no routable checkout id", nil)
				}
				verdict, err := daraja.IntakeCallback(rc.context(),
					journeyLedger(svc, initiation.OrgID, daraja.KindSTKResult), parsed, darajaIntakeHooks(rc))
				if err != nil {
					return HandlerResult{}, darajaRefusal(err)
				}
				if verdict.Outcome != daraja.OutcomeAccepted && verdict.Outcome != daraja.OutcomeDuplicate {
					return HandlerResult{}, misroutedCallback()
				}
				duplicate := verdict.Outcome == daraja.OutcomeDuplicate
				if duplicate {
					// R9 crash-window recovery: a CLAIMED journey whose
					// initiation is STILL 'initiated' means the prior delivery
					// died before the settle finished — re-run the idempotent
					// funnel below instead of acking money into a void. A
					// settled initiation (reconciled|failed) only acks: the
					// SAME journey with the SAME money was already processed,
					// and ReconcileStkResult must never re-run it.
					fresh, err := svc.Stores.StkInitiationByCheckout(rc.context(), svc.Stores.Pool, stk.CheckoutRequestID)
					if errors.Is(err, repositories.ErrNotFound) {
						return HandlerResult{}, infra.NewDomainError(application.CodeStkStateInvalid,
							"checkout "+stk.CheckoutRequestID+" has no initiation record — the callback routes to nothing", nil)
					}
					if err != nil {
						return HandlerResult{}, err
					}
					if fresh.State != "initiated" {
						return callbackAck(stk.JourneyKey, true, "", ""), nil
					}
				}
				result, err := svc.ReconcileStkResult(rc.context(), initiation.OrgID, application.StkReconcileCommand{
					CheckoutRequestID: stk.CheckoutRequestID,
					Success:           stk.Success,
					ReceiptNumber:     stk.ReceiptNumber,
					FailureCode:       stk.FailureCode,
					HasPaid:           stk.HasPaid,
					PaidMinor:         stk.PaidMinor,
				})
				if err != nil {
					return HandlerResult{}, err
				}
				return callbackAck(stk.JourneyKey, duplicate, result.Payment.ID, result.Payment.State), nil
			},
		},
	}
}

// parseCallbackBody re-encodes the kernel-parsed JSON and runs it through
// the K1 boundary (daraja.ParseCallback). The kernel already bounded the
// body (413) and refused non-JSON (400); the parse applies the wire rules
// and refuses structurally-wrong payloads with their promised DARAJA_* code.
func parseCallbackBody(rc *RequestContext, opts daraja.ParseOptions) (daraja.ParsedCallback, error) {
	body, derr := bodyObject(rc.Body)
	if derr != nil {
		return nil, derr
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, infra.NewDomainError(infra.CodeInternal, "callback payload re-encode failed", nil)
	}
	parsed, perr := daraja.ParseCallback(raw, opts)
	if perr != nil {
		return nil, darajaRefusal(perr)
	}
	return parsed, nil
}

// callbackOrg resolves + verifies the :orgId path segment: the URL is the
// operator-configured Daraja routing (each merchant account registers its
// own callback URL), so the org binding never derives from untrusted payload
// data — but a stale or foreign org id must never become a money event.
func callbackOrg(rc *RequestContext, svc *application.Services) (string, error) {
	orgID := strings.TrimSpace(rc.Params["orgId"])
	if !infra.IsUUID(orgID) {
		return "", infra.NewDomainError(CodeDarajaCallbackOrgInvalid,
			"the org segment must be a UUID", nil)
	}
	exists, err := svc.Stores.OrgExists(rc.context(), svc.Stores.Pool, orgID)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", infra.NewDomainError(CodeDarajaCallbackOrgUnknown,
			"org "+orgID+" does not exist — the callback routes to nothing", nil)
	}
	return orgID, nil
}

// journeyLedger binds the durable R9 claim store to one request (the
// org-scoped PostgreSQL implementation of daraja.JourneyLedger).
func journeyLedger(svc *application.Services, orgID string, kind daraja.CallbackKind) daraja.JourneyLedger {
	return repositories.JourneyClaim{Stores: svc.Stores, OrgID: orgID, Kind: string(kind)}
}

// darajaIntakeHooks carries the R9 duplicate tripwire: the funnel fires it
// once per duplicate delivery — the transport surfaces it in the structured
// log (the payments funnel records the durable duplicateCallbackObserved
// event itself when the replay reaches the intake).
func darajaIntakeHooks(rc *RequestContext) daraja.IntakeHooks {
	return daraja.IntakeHooks{OnDuplicate: func(cb daraja.ParsedCallback) {
		rc.Log().Info("daraja.callback.duplicate",
			slog.String("requestId", rc.RequestID),
			slog.String("journeyKey", cb.IntakeFacts().JourneyKey))
	}}
}

// darajaRefusal converts the K1 boundary's *daraja.Error into the kernel's
// domain-error envelope under the SAME stable code, so a refused callback
// dead-letters with its promised DARAJA_* code instead of the fail-closed
// generic 500 (which is reserved for internals that must never leak).
func darajaRefusal(err error) error {
	var de *daraja.Error
	if errors.As(err, &de) {
		return infra.NewDomainError(de.Code, de.Message, nil)
	}
	return err
}

// misroutedCallback refuses a payload that parsed but carries no semantics
// for the endpoint that received it (an STK result on a C2B URL, a B2C
// outflow on an inflow endpoint): dead-letter, never processed.
func misroutedCallback() error {
	return infra.NewDomainError(daraja.CodePayloadUnrecognized,
		"payload carries no semantics for this callback endpoint", nil)
}

// callbackAck renders the rail-facing acknowledgment: the Daraja-shaped
// {ResultCode, ResultDesc} pair plus the funnel verdict. paymentId/state are
// included when the settle ran (fresh journeys and crash-window recoveries);
// a settled-journey duplicate ack reports the delivery verdict only.
func callbackAck(journeyKey string, duplicate bool, paymentID, paymentState string) HandlerResult {
	data := map[string]any{
		"ResultCode": 0,
		"ResultDesc": "Success",
		"journeyKey": journeyKey,
		"duplicate":  duplicate,
	}
	if paymentID != "" {
		data["paymentId"] = paymentID
		data["paymentState"] = paymentState
	}
	return HandlerResult{Status: 200, Data: data}
}

// c2bPaymentKey is the R9 payment journey key for C2B confirmations — the
// same "daraja:<family>:<rail id>" convention as the STK lane's
// paymentIdempotencyKey ("daraja:stk:<checkoutRequestId>"), so both families
// reconcile onto ONE payment per rail journey.
func c2bPaymentKey(transID string) string {
	return "daraja:c2b:" + transID
}

// peekCheckoutRequestID extracts the CheckoutRequestID hint from the raw
// payload WITHOUT validating it — a missing/non-string hint simply routes no
// lookup, and the K1 parse produces the promised refusal for the shape.
func peekCheckoutRequestID(body map[string]any) string {
	envelope, _ := body["Body"].(map[string]any)
	callback, _ := envelope["stkCallback"].(map[string]any)
	raw, _ := callback["CheckoutRequestID"].(string)
	return strings.TrimSpace(raw)
}
