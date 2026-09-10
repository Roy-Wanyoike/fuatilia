// The outbound STK wiring seam (issue #178): the port the collections STK
// execute action binds behind and the production adapter that drives the
// real client. This is the Go twin of the domain's injected port in
// src/domain/collections/stk/wire.ts (StkPushWire): the DOMAIN owns the
// port, the ADAPTER owns the wire — the application layer never imports a
// transport, tests never touch the network.
//
//	application.ExecuteStkPush ──▶ StkPushWire (port, this file)
//	                                      ▲                    ▲
//	daraja.STKWire (production, below) ───┘        fake in _test.go
package daraja

import (
	"context"
	"strings"
)

// StkPushCommand is the initiation command exactly what the rail needs,
// nothing more (the parity of StkPushInitiationCommand in wire.ts). The
// MSISDN arrives in Daraja WIRE form (2547XXXXXXXX / 2541XXXXXXXX — the
// caller encodes it; encoding is a wire step, normalization is the domain's).
// AmountMinor is KES minor units (R10: integer, > 0, never a float).
type StkPushCommand struct {
	// ActionID is the collections execution action this push serves (opaque
	// to the wire; audit/diagnostics only).
	ActionID string
	// OrgID and CustomerID name the tenant and payer (audit only — Daraja
	// never sees them).
	OrgID      string
	CustomerID string
	// AmountMinor is the whole-prompt amount in KES minor units; the STK
	// wire carries whole shillings, so minor == shillings × 100 and a
	// non-whole-shilling amount is refused by the client (never rounded).
	AmountMinor int64
	// MSISDN is the payer handset in Daraja wire form.
	MSISDN string
	// AccountReference is what the customer sees on the SIM prompt
	// (≤ 12 alphanumerics — Daraja's constraint, enforced by the client).
	AccountReference string
	// TransactionDesc is the prompt description (≤ 26 chars).
	TransactionDesc string
	// IdempotencyKey is the R9 initiation key ("stkpush:<actionId>"). The
	// adapter passes it through verbatim: the client's in-flight guard
	// collapses concurrent duplicates onto ONE wire call, and the caller's
	// durable registry collapses retries across processes.
	IdempotencyKey string
}

// StkPushReceipt echoes an accepted initiation (the rail's identity for the
// live push — the callback reconciles against CheckoutRequestID).
type StkPushReceipt struct {
	MerchantRequestID string
	CheckoutRequestID string
	// CustomerMessage is the human-facing confirmation the rail returned,
	// when it does ('' when absent).
	CustomerMessage string
}

// StkPushWire is the outbound initiation port (the injected seam). A
// production adapter drives the Daraja client; tests bind a deterministic
// fake. Implementations must be at-least-once safe: the command carries the
// R9 initiation key for exactly that.
type StkPushWire interface {
	Initiate(ctx context.Context, cmd StkPushCommand) (StkPushReceipt, error)
}

// MerchantConfig is the merchant-side STK context the ADAPTER injects per
// call — the client keeps passkeys/short codes out of its own surface (the
// README's credential-hygiene rule: per-call inputs the service layer
// injects from its own secret source, never literals, never logged).
type MerchantConfig struct {
	// ShortCode is the 5–7 digit business short code collecting the money.
	ShortCode string
	// Passkey is the Lipa na M-Pesa Online passkey (env-injected).
	Passkey string
	// TransactionType is CustomerPayBillOnline (default when '') or
	// CustomerBuyGoodsOnline.
	TransactionType string
	// CallBackURL is the absolute https URL that will receive the result
	// callback (the mounted /v1/callbacks/daraja/stk/result endpoint).
	CallBackURL string
}

// STKWire is the production StkPushWire adapter: a configured client plus
// the merchant context, driving Client.InitiateSTK with the R9 key passed
// through. Zero-value is unusable; construct with NewSTKWire.
type STKWire struct {
	client   *Client
	merchant MerchantConfig
}

// NewSTKWire binds the adapter over a live client. Configuration errors are
// boot failures (composition time), never runtime surprises: the merchant
// context is validated exactly as the client would validate it, so a
// deployment that boots can initiate.
func NewSTKWire(client *Client, merchant MerchantConfig) (*STKWire, error) {
	if client == nil {
		return nil, errf(CodeConfigInvalid, "STKWire requires a configured client")
	}
	if merchant.TransactionType == "" {
		merchant.TransactionType = TxTypeCustomerPayBillOnline
	}
	// The client validates the full request per call; these are the
	// merchant-injected fields this adapter owns — fail them at boot.
	if merchant.ShortCode == "" {
		return nil, errf(CodeShortCodeMalformed, "merchant ShortCode is required (DARAJA_SHORT_CODE)")
	}
	if merchant.Passkey == "" {
		return nil, errf(CodeConfigInvalid, "merchant Passkey is required (DARAJA_PASSKEY, env-injected, never hardcoded)")
	}
	if merchant.CallBackURL == "" || !strings.HasPrefix(merchant.CallBackURL, "https://") {
		return nil, errf(CodeConfigInvalid, "merchant CallBackURL must be an absolute https URL (DARAJA_CALLBACK_BASE_URL)")
	}
	return &STKWire{client: client, merchant: merchant}, nil
}

// Initiate implements StkPushWire over the real client. A receipt the rail
// accepted at the HTTP layer but refused at the business layer
// (ResponseCode != "0") is an ERROR, never a fabricated echo — the caller
// records stk.pushNotInitiated and the attempt stays retryable.
func (w *STKWire) Initiate(ctx context.Context, cmd StkPushCommand) (StkPushReceipt, error) {
	receipt, err := w.client.InitiateSTK(ctx, STKInitiate{
		ShortCode:        w.merchant.ShortCode,
		Passkey:          w.merchant.Passkey,
		TransactionType:  w.merchant.TransactionType,
		AmountMinor:      cmd.AmountMinor,
		PhoneNumber:      cmd.MSISDN,
		AccountReference: cmd.AccountReference,
		TransactionDesc:  cmd.TransactionDesc,
		CallBackURL:      w.merchant.CallBackURL,
	}, cmd.IdempotencyKey)
	if err != nil {
		return StkPushReceipt{}, err
	}
	if receipt.ResponseCode != "0" {
		return StkPushReceipt{}, &Error{
			Code:         CodeAPIError,
			Kind:         KindValidation,
			Message:      "STK initiation refused: " + receipt.ResponseDescription,
			UpstreamCode: receipt.ResponseCode,
		}
	}
	return StkPushReceipt{
		MerchantRequestID: receipt.MerchantRequestID,
		CheckoutRequestID: receipt.CheckoutRequestID,
		CustomerMessage:   receipt.CustomerMessage,
	}, nil
}
