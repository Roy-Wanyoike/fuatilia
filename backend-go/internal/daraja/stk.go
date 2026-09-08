// STK Push (M-Pesa Express / Lipa na M-Pesa Online) — initiate + query
// (issue #96). Wire contract: amounts are WHOLE SHILLINGS on initiation; the
// password is base64(shortCode + passkey + timestamp) with the timestamp in
// Kenyan local time (EAT, UTC+3, "YYYYMMDDHHmmss").
package daraja

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
	"sync"
	"time"
)

// STK endpoints (Daraja v1 paths, stable across sandbox/production).
const (
	stkPushPath  = "/mpesa/stkpush/v1/processrequest"
	stkQueryPath = "/mpesa/stkpushquery/v1/query"
)

// TransactionType for STK: CustomerPayBillOnline (Pay Bill) or
// CustomerBuyGoodsOnline (Till). No other values are accepted by Daraja.
const (
	TxTypeCustomerPayBillOnline  = "CustomerPayBillOnline"
	TxTypeCustomerBuyGoodsOnline = "CustomerBuyGoodsOnline"
)

// STKInitiate is the caller's request. AmountMinor MUST be whole shillings
// (refused otherwise — never rounded). PhoneNumber is the payer MSISDN in
// 2547XXXXXXXX / 2541XXXXXXXX form (validated, not normalized: normalization
// belongs to the domain, not the wire client). CallBackURL is the HTTPS
// endpoint that will receive the result callback.
type STKInitiate struct {
	ShortCode        string // 5–7 digit business short code
	Passkey          string // Lipa na M-Pesa Online passkey (env-injected)
	TransactionType  string
	AmountMinor      int64
	PhoneNumber      string // 2547XXXXXXXX / 2541XXXXXXXX
	AccountReference string // invoice/payer reference shown on the SIM prompt
	TransactionDesc  string // prompt description
	CallBackURL      string // absolute https URL for the result callback
}

// STKReceipt echoes the accepted initiation.
type STKReceipt struct {
	MerchantRequestID   string
	CheckoutRequestID   string
	ResponseCode        string // "0" accepted
	ResponseDescription string
	CustomerMessage     string
}

// STKStatus is the query result for an outstanding push.
type STKStatus struct {
	ResponseCode        string
	ResponseDescription string
	MerchantRequestID   string
	CheckoutRequestID   string
	ResultCode          string // "0" success; "1032" cancelled; "1037" timeout; …
	ResultDesc          string
}

// stkWire is the exact initiation payload Daraja expects.
type stkWire struct {
	BusinessShortCode string `json:"BusinessShortCode"`
	Password          string `json:"Password"`
	Timestamp         string `json:"Timestamp"`
	TransactionType   string `json:"TransactionType"`
	Amount            int64  `json:"Amount"` // whole shillings
	PartyA            string `json:"PartyA"`
	PartyB            string `json:"PartyB"`
	PhoneNumber       string `json:"PhoneNumber"`
	CallBackURL       string `json:"CallBackURL"`
	AccountReference  string `json:"AccountReference"`
	TransactionDesc   string `json:"TransactionDesc"`
}

type stkReceiptWire struct {
	MerchantRequestID   string `json:"MerchantRequestID"`
	CheckoutRequestID   string `json:"CheckoutRequestID"`
	ResponseCode        string `json:"ResponseCode"`
	ResponseDescription string `json:"ResponseDescription"`
	CustomerMessage     string `json:"CustomerMessage"`
}

type stkStatusWire struct {
	ResponseCode        string `json:"ResponseCode"`
	ResponseDescription string `json:"ResponseDescription"`
	MerchantRequestID   string `json:"MerchantRequestID"`
	CheckoutRequestID   string `json:"CheckoutRequestID"`
	ResultCode          string `json:"ResultCode"`
	ResultDesc          string `json:"ResultDesc"`
}

// inFlight collapses concurrent identical initiations onto ONE wire call
// (double-click guard). join returns a finish function for BOTH roles: the
// lead DEFERS it (releases the slot and wakes followers); a follower CALLS
// it synchronously to wait for the lead's outcome. Completed-key dedup is
// the domain's R9 job; see the package comment.
type inFlight struct {
	mu   sync.Mutex
	live map[string]*sync.WaitGroup
}

func (f *inFlight) join(key string) (finish func(), lead bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.live == nil {
		f.live = map[string]*sync.WaitGroup{}
	}
	if wg, ok := f.live[key]; ok {
		return wg.Wait, false
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	f.live[key] = wg
	return func() {
		f.mu.Lock()
		if cur, ok := f.live[key]; ok && cur == wg {
			delete(f.live, key)
		}
		f.mu.Unlock()
		wg.Done()
	}, true
}

// InitiateSTK pushes a payment prompt to the payer's phone. idempotencyKey
// collapses CONCURRENT duplicate calls to a single wire request; a follower
// is refused with DARAJA_DUPLICATE_IN_FLIGHT (the domain records the R9
// duplicate rather than fabricating a second receipt).
func (c *Client) InitiateSTK(ctx context.Context, req STKInitiate, idempotencyKey string) (STKReceipt, error) {
	if err := validateSTKRequest(req); err != nil {
		return STKReceipt{}, err
	}
	finish, lead := c.inflight.join(idempotencyKey)
	if !lead {
		finish()
		return STKReceipt{}, errf(CodeDuplicateInFlight,
			"an initiation with key %q is already in flight — intake deduplicates (R9)", safeKey(idempotencyKey))
	}
	defer finish()

	amount, err := wholeShillings(req.AmountMinor)
	if err != nil {
		return STKReceipt{}, err
	}
	now := c.now().In(eatLocation)
	ts := now.Format("20060102150405")
	password := base64.StdEncoding.EncodeToString([]byte(req.ShortCode + req.Passkey + ts))

	wire := stkWire{
		BusinessShortCode: req.ShortCode,
		Password:          password,
		Timestamp:         ts,
		TransactionType:   req.TransactionType,
		Amount:            amount,
		PartyA:            req.PhoneNumber,
		PartyB:            req.ShortCode,
		PhoneNumber:       req.PhoneNumber,
		CallBackURL:       req.CallBackURL,
		AccountReference:  req.AccountReference,
		TransactionDesc:   req.TransactionDesc,
	}
	var out stkReceiptWire
	if err := c.callJSON(ctx, http.MethodPost, stkPushPath, wire, &out); err != nil {
		return STKReceipt{}, err
	}
	return STKReceipt{
		MerchantRequestID:   out.MerchantRequestID,
		CheckoutRequestID:   out.CheckoutRequestID,
		ResponseCode:        out.ResponseCode,
		ResponseDescription: out.ResponseDescription,
		CustomerMessage:     out.CustomerMessage,
	}, nil
}

// QuerySTK asks Daraja for the outcome of an outstanding push (used when the
// callback is slow; the callback remains the source of truth).
func (c *Client) QuerySTK(ctx context.Context, shortCode, passkey, checkoutRequestID string) (STKStatus, error) {
	if shortCode == "" {
		return STKStatus{}, errf(CodeShortCodeMalformed, "short code is required")
	}
	if passkey == "" {
		return STKStatus{}, errf(CodeConfigInvalid, "passkey is required (env-injected, never hardcoded)")
	}
	if checkoutRequestID == "" {
		return STKStatus{}, errf(CodeCheckoutRequestIDRequired, "checkout request id is required")
	}
	now := c.now().In(eatLocation)
	ts := now.Format("20060102150405")
	wire := map[string]string{
		"BusinessShortCode": shortCode,
		"Password":          base64.StdEncoding.EncodeToString([]byte(shortCode + passkey + ts)),
		"Timestamp":         ts,
		"CheckoutRequestID": checkoutRequestID,
	}
	var out stkStatusWire
	if err := c.callJSON(ctx, http.MethodPost, stkQueryPath, wire, &out); err != nil {
		return STKStatus{}, err
	}
	return STKStatus(out), nil
}

func validateSTKRequest(req STKInitiate) error {
	if req.ShortCode == "" {
		return errf(CodeShortCodeMalformed, "short code is required")
	}
	if req.Passkey == "" {
		return errf(CodeConfigInvalid, "passkey is required (env-injected, never hardcoded)")
	}
	if req.TransactionType != TxTypeCustomerPayBillOnline && req.TransactionType != TxTypeCustomerBuyGoodsOnline {
		return errf(CodeConfigInvalid,
			"transaction type %q must be CustomerPayBillOnline or CustomerBuyGoodsOnline", req.TransactionType)
	}
	if _, err := wholeShillings(req.AmountMinor); err != nil {
		return err
	}
	if !isValidMSISDN(req.PhoneNumber) {
		return errf(CodeMSISDNMalformed, "phone %q must be 2547XXXXXXXX or 2541XXXXXXXX", maskMSISDN(req.PhoneNumber))
	}
	if req.CallBackURL == "" || !strings.HasPrefix(req.CallBackURL, "https://") {
		return errf(CodeConfigInvalid, "CallBackURL must be an absolute https URL")
	}
	return nil
}

// eatLocation is Kenyan time (UTC+3, no DST) — TransTime/Timestamp are EAT.
var eatLocation = time.FixedZone("EAT", 3*3600)

// isValidMSISDN accepts exactly the two production shapes.
func isValidMSISDN(s string) bool {
	if len(s) != 12 {
		return false
	}
	if !strings.HasPrefix(s, "2547") && !strings.HasPrefix(s, "2541") {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// maskMSISDN keeps the last 4 digits for logs.
func maskMSISDN(s string) string {
	if len(s) <= 4 {
		return "****"
	}
	return "****" + s[len(s)-4:]
}

// safeKey avoids echoing raw idempotency keys (may embed refs) in errors.
func safeKey(k string) string {
	if len(k) > 8 {
		return k[:8] + "…"
	}
	return k
}
