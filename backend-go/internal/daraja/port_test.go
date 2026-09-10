// Port-seam tests (issue #178): the STKWire production adapter over the
// scriptable fake server — secret injection, R9 key passthrough, the
// business-layer refusal translation, and the boot-time configuration
// ladder. No test touches real network.
package daraja

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func testMerchant() MerchantConfig {
	return MerchantConfig{
		ShortCode:       "174379",
		Passkey:         "test-passkey-not-a-secret",
		TransactionType: TxTypeCustomerPayBillOnline,
		CallBackURL:     "https://api.example.com/v1/callbacks/daraja/stk/result",
	}
}

func testPushCommand() StkPushCommand {
	return StkPushCommand{
		ActionID:         "3f1d2c4e-5a6b-4c8d-9e0f-1a2b3c4d5e6f",
		OrgID:            "org-1",
		CustomerID:       "cust-1",
		AmountMinor:      250_000, // KES 2500.00 — whole shillings
		MSISDN:           "254712345678",
		AccountReference: "INV-1042",
		TransactionDesc:  "Collection for INV-1042",
		IdempotencyKey:   "stkpush:3f1d2c4e-5a6b-4c8d-9e0f-1a2b3c4d5e6f",
	}
}

func acceptedReceiptBody() map[string]any {
	return map[string]any{
		"MerchantRequestID":   "58234-11940372-1",
		"CheckoutRequestID":   "ws_CO_12092025143105741",
		"ResponseCode":        "0",
		"ResponseDescription": "Success. Request accepted for processing",
		"CustomerMessage":     "Success. Request accepted for processing",
	}
}

// The adapter injects the merchant secrets (short code, passkey, callback
// URL) the caller never carries; the amount crosses as WHOLE SHILLINGS.
func TestSTKWireInjectsMerchantContext(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	oauthScript(f, "tok-port", "3600")
	f.script(stkPushPath, scriptedResponse{status: 200, body: acceptedReceiptBody()})
	w, err := NewSTKWire(f.client(t, nil), testMerchant())
	if err != nil {
		t.Fatalf("NewSTKWire: %v", err)
	}

	receipt, err := w.Initiate(context.Background(), testPushCommand())
	if err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if receipt.CheckoutRequestID != "ws_CO_12092025143105741" || receipt.MerchantRequestID != "58234-11940372-1" {
		t.Fatalf("receipt echo drift: %+v", receipt)
	}
	if receipt.CustomerMessage == "" {
		t.Fatalf("customer message must ride the echo when the rail returns it")
	}

	var wire map[string]any
	if err := json.Unmarshal(f.lastBody(stkPushPath), &wire); err != nil {
		t.Fatalf("decode wire body: %v", err)
	}
	if wire["BusinessShortCode"] != "174379" || wire["PartyB"] != "174379" {
		t.Fatalf("short code not injected: %v", wire["BusinessShortCode"])
	}
	if wire["CallBackURL"] != "https://api.example.com/v1/callbacks/daraja/stk/result" {
		t.Fatalf("callback URL not injected: %v", wire["CallBackURL"])
	}
	if wire["PhoneNumber"] != "254712345678" || wire["PartyA"] != "254712345678" {
		t.Fatalf("msisdn not forwarded: %v", wire["PhoneNumber"])
	}
	// Amount crosses as WHOLE SHILLINGS (2500), never minor units.
	if wire["Amount"] != float64(2500) {
		t.Fatalf("amount must be whole shillings, got %v", wire["Amount"])
	}
	// The password is base64(shortCode+passkey+timestamp) — the passkey
	// never appears in plaintext on the wire.
	password, ok := wire["Password"].(string)
	if !ok || password == "" {
		t.Fatalf("password missing from wire body")
	}
	if strings.Contains(password, "test-passkey-not-a-secret") {
		t.Fatalf("passkey leaked in plaintext into the password field")
	}
	if ts, ok := wire["Timestamp"].(string); !ok || len(ts) != 14 {
		t.Fatalf("EAT timestamp missing: %v", wire["Timestamp"])
	}
}

// The R9 initiation key rides the CLIENT contract (the in-flight guard),
// not the wire body: sequential duplicate initiations with the SAME key
// both reach the wire — completed-initiation dedup is the caller's R9 job
// (the README's discipline), the client only collapses CONCURRENT ones.
func TestSTKWireDoesNotDurableDedup(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	oauthScript(f, "tok-port", "3600")
	f.script(stkPushPath,
		scriptedResponse{status: 200, body: acceptedReceiptBody()},
		scriptedResponse{status: 200, body: acceptedReceiptBody()},
	)
	w, err := NewSTKWire(f.client(t, nil), testMerchant())
	if err != nil {
		t.Fatalf("NewSTKWire: %v", err)
	}
	cmd := testPushCommand()
	if _, err := w.Initiate(context.Background(), cmd); err != nil {
		t.Fatalf("first initiation: %v", err)
	}
	if _, err := w.Initiate(context.Background(), cmd); err != nil {
		t.Fatalf("second initiation with the same key: %v", err)
	}
	if got := f.count(stkPushPath); got != 2 {
		t.Fatalf("completed initiations must re-reach the wire (caller owns R9), calls = %d", got)
	}
}

// A business-layer refusal (HTTP 200, ResponseCode != "0") is an ERROR —
// never a fabricated accepted echo.
func TestSTKWireRefusesNonZeroResponseCode(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	oauthScript(f, "tok-port", "3600")
	f.script(stkPushPath, scriptedResponse{status: 200, body: map[string]any{
		"MerchantRequestID":   "58234-11940372-1",
		"CheckoutRequestID":   "ws_CO_12092025143105741",
		"ResponseCode":        "1",
		"ResponseDescription": "Insufficient funds",
		"CustomerMessage":     "Insufficient funds",
	}})
	w, err := NewSTKWire(f.client(t, nil), testMerchant())
	if err != nil {
		t.Fatalf("NewSTKWire: %v", err)
	}
	_, err = w.Initiate(context.Background(), testPushCommand())
	if err == nil {
		t.Fatalf("ResponseCode 1 must be an error, not an accepted receipt")
	}
	var de *Error
	if !errors.As(err, &de) {
		t.Fatalf("refusal must be a *daraja.Error, got %T", err)
	}
	if de.Code != CodeAPIError || de.Kind != KindValidation {
		t.Fatalf("refusal taxonomy drift: code=%s kind=%s", de.Code, de.Kind)
	}
	if de.UpstreamCode != "1" {
		t.Fatalf("UpstreamCode must preserve Daraja's ResponseCode, got %q", de.UpstreamCode)
	}
	if !strings.Contains(de.Message, "Insufficient funds") {
		t.Fatalf("refusal must carry the rail's description, got %q", de.Message)
	}
}

// Wire-level failures pass through the client's taxonomy untouched.
func TestSTKWirePassesThroughUpstreamRefusals(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	oauthScript(f, "tok-port", "3600")
	f.script(stkPushPath, scriptedResponse{status: 500, body: map[string]any{
		"errorCode":    "500.001.1001",
		"errorMessage": "internal error",
	}})
	w, err := NewSTKWire(f.client(t, nil), testMerchant())
	if err != nil {
		t.Fatalf("NewSTKWire: %v", err)
	}
	_, err = w.Initiate(context.Background(), testPushCommand())
	if err == nil {
		t.Fatalf("500 must surface as an error")
	}
	var de *Error
	if !errors.As(err, &de) {
		t.Fatalf("expected *daraja.Error, got %T", err)
	}
	if de.Kind != KindUpstream {
		t.Fatalf("500 must be KindUpstream, got %s", de.Kind)
	}
}

// A cancelled context fails fast — the adapter honors the caller's deadline
// (deadline_expiry parity with the client's own tests).
func TestSTKWireHonorsContext(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	w, err := NewSTKWire(f.client(t, nil), testMerchant())
	if err != nil {
		t.Fatalf("NewSTKWire: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := w.Initiate(ctx, testPushCommand()); err == nil {
		t.Fatalf("cancelled context must fail")
	}
}

func TestNewSTKWireConfigLadder(t *testing.T) {
	t.Parallel()
	f := newFakeServer(t)
	client := f.client(t, nil)

	if _, err := NewSTKWire(nil, testMerchant()); err == nil {
		t.Fatalf("nil client must be refused")
	}

	merchant := testMerchant()
	merchant.ShortCode = ""
	if _, err := NewSTKWire(client, merchant); err == nil {
		t.Fatalf("empty short code must be refused")
	}

	merchant = testMerchant()
	merchant.Passkey = ""
	if _, err := NewSTKWire(client, merchant); err == nil {
		t.Fatalf("empty passkey must be refused")
	}

	merchant = testMerchant()
	merchant.CallBackURL = "http://api.example.com/callbacks"
	if _, err := NewSTKWire(client, merchant); err == nil {
		t.Fatalf("non-https callback URL must be refused")
	}

	// Empty transaction type defaults to CustomerPayBillOnline and reaches
	// the wire intact.
	merchant = testMerchant()
	merchant.TransactionType = ""
	w, err := NewSTKWire(client, merchant)
	if err != nil {
		t.Fatalf("default transaction type: %v", err)
	}
	if w.merchant.TransactionType != TxTypeCustomerPayBillOnline {
		t.Fatalf("default transaction type drift: %q", w.merchant.TransactionType)
	}
	oauthScript(f, "tok-port-ladder", "3600")
	f.script(stkPushPath, scriptedResponse{status: 200, body: acceptedReceiptBody()})
	if _, err := w.Initiate(context.Background(), testPushCommand()); err != nil {
		t.Fatalf("Initiate: %v", err)
	}
	if got := f.count(stkPushPath); got != 1 {
		t.Fatalf("wire calls = %d, want 1", got)
	}
}
