package transport_test

// The Daraja rail-facing callback endpoints (issue #178) over REAL
// PostgreSQL: real signed-format payloads (the TS fixture bodies, byte for
// byte) flow parse (K1) → intake funnel (R9 durable journey claim) → the
// payments funnel, and the money movement matches the TS simulator's
// fixtures exactly — integer minor units, one payment per rail journey,
// balanced ledger entries, idempotent redeliveries, tamper refusals.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The TS fixture bodies (src/adapters/daraja/fixtures/c2b.ts + stk.ts),
// verbatim: synthetic Kenyan-realistic data, no real PII.
const (
	// c2b.validation/confirmation.paybill-single-invoice — KES 2500.00.
	c2bPaybillSingle = `{
                "TransactionType": "Pay Bill",
                "TransID": "SBK41XQ7RT",
                "TransTime": "20250912143015",
                "TransAmount": "2500.00",
                "BusinessShortCode": "412873",
                "BillRefNumber": "INV-1042",
                "OrgAccountBalance": "489230.00",
                "MSISDN": "254712345678"
        }`
	// The tampered twin of PAYBILL_SINGLE: SAME journey, different money.
	c2bPaybillSingleTampered = `{
                "TransactionType": "Pay Bill",
                "TransID": "SBK41XQ7RT",
                "TransTime": "20250912143015",
                "TransAmount": "3500.00",
                "BusinessShortCode": "412873",
                "BillRefNumber": "INV-1042",
                "OrgAccountBalance": "491730.00",
                "MSISDN": "254712345678"
        }`
	// stk.success.metadata-complete — KES 2500 paid, receipt SBK81KZ9QF.
	stkSuccess = `{
                "Body": {"stkCallback": {
                        "MerchantRequestID": "58234-11940372-1",
                        "CheckoutRequestID": "ws_CO_12092025143105741",
                        "ResultCode": 0,
                        "ResultDesc": "The service request is processed successfully.",
                        "CallbackMetadata": {"Item": [
                                {"Name": "Amount", "Value": 2500},
                                {"Name": "MpesaReceiptNumber", "Value": "SBK81KZ9QF"},
                                {"Name": "Balance"},
                                {"Name": "TransactionDate", "Value": "20250912143105"},
                                {"Name": "PhoneNumber", "Value": 254712345678}
                        ]}
                }}
        }`
	// stk.cancelled-by-user.code-1032 — abandonment, NO metadata amount.
	stkCancelled1032 = `{
                "Body": {"stkCallback": {
                        "MerchantRequestID": "58237-11941120-4",
                        "CheckoutRequestID": "ws_CO_12092025151022104",
                        "ResultCode": 1032,
                        "ResultDesc": "Request cancelled by user"
                }}
        }`
)

// postCallback drives one rail delivery with NO credentials (the rail has
// none to present) and decodes the §38 envelope.
func postCallback(t *testing.T, server *httptest.Server, path, payload string) (int, map[string]any) {
	t.Helper()
	res, err := http.Post(server.URL+path, "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer res.Body.Close()
	body := map[string]any{}
	dec := json.NewDecoder(res.Body)
	if err := dec.Decode(&body); err != nil {
		t.Fatalf("POST %s: response is not JSON: %v", path, err)
	}
	return res.StatusCode, body
}

func callbackData(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	data, _ := body["data"].(map[string]any)
	if data == nil {
		t.Fatalf("callback response carries no data object: %v", body)
	}
	return data
}

// seedStkInitiation inserts one E11 merchant record for a live push.
func seedStkInitiation(t *testing.T, pool *pgxpool.Pool, orgID, checkout, merchantRequest string, requestedMinor int64) {
	t.Helper()
	mustExecNoReturn(t, pool, `INSERT INTO stk_initiations (org_id, action_id, checkout_request_id, merchant_request_id,
                               idempotency_key, requested_minor, currency, state, initiated_at)
                               VALUES ($1, 'act-'||$2, $3, $4, 'stkpush:act-'||$2, $5, 'KES', 'initiated', now())`,
		orgID, randToken(t)[:8], checkout, merchantRequest, requestedMinor)
}

func countQuery(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

func intQuery(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	return n
}

func stringQuery(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", sql, err)
	}
	return s
}

// AC1: the C2B confirmation endpoint moves money exactly like the TS
// simulator does for the same fixture — one payment per rail journey,
// confirmed at the initiated amount, with the balanced ledger entry; a
// redelivery is the R9 duplicate and nothing re-runs.
func TestC2BConfirmationEndpointMoneyMovementParity(t *testing.T) {
	server, pool, w := bootKernel(t)
	path := "/v1/callbacks/daraja/" + w.OrgID + "/c2b/confirmation"

	status, body := postCallback(t, server, path, c2bPaybillSingle)
	if status != 200 {
		t.Fatalf("first delivery: status %d body %v", status, body)
	}
	data := callbackData(t, body)
	if data["ResultCode"].(float64) != 0 || data["ResultDesc"] != "Success" || data["duplicate"] != false {
		t.Fatalf("first delivery verdict: %v", data)
	}
	paymentID, _ := data["paymentId"].(string)
	if paymentID == "" || data["paymentState"] != "confirmed" {
		t.Fatalf("first delivery must settle the payment, got %v", data)
	}

	// The payment: the TS fixture's KES 2500.00 → 250000 minor, confirmed,
	// with the declared refs the bill reference carried (R10 integers).
	if got := stringQuery(t, pool, `SELECT state FROM payments WHERE id = $1`, paymentID); got != "confirmed" {
		t.Fatalf("payment state = %s, want confirmed", got)
	}
	if got := intQuery(t, pool, `SELECT requested_minor FROM payments WHERE id = $1`, paymentID); got != 250000 {
		t.Fatalf("requested minor = %d, want 250000 (KES 2500.00 exact)", got)
	}
	if got := intQuery(t, pool, `SELECT confirmed_minor FROM payments WHERE id = $1`, paymentID); got != 250000 {
		t.Fatalf("confirmed minor = %d, want 250000", got)
	}
	if got := stringQuery(t, pool, `SELECT external_ref FROM payments WHERE id = $1`, paymentID); got != "SBK41XQ7RT" {
		t.Fatalf("external ref = %s, want the rail TransID", got)
	}
	if got := stringQuery(t, pool, `SELECT idempotency_key FROM payments WHERE id = $1`, paymentID); got != "daraja:c2b:SBK41XQ7RT" {
		t.Fatalf("payment idempotency key = %s, want the R9 journey key", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 1 {
		t.Fatalf("payments rows = %d, want exactly one", got)
	}

	// The durable journey claim (the R9 ledger) recorded the money once.
	if got := intQuery(t, pool, `SELECT amount_minor FROM daraja_callback_journeys WHERE journey_key = $1`, "c2b:SBK41XQ7RT"); got != 250000 {
		t.Fatalf("journey claim = %d, want 250000", got)
	}

	// The audit trail: initiated + confirmed facts beside the payment.
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.initiated' AND payload->>'paymentId' = $2`, w.OrgID, paymentID); got != 1 {
		t.Fatalf("payment.initiated facts = %d, want 1", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.confirmed' AND payload->>'paymentId' = $2`, w.OrgID, paymentID); got != 1 {
		t.Fatalf("payment.confirmed facts = %d, want 1", got)
	}

	// The money moved in the ledger too: the confirmation entry is balanced
	// (R4) at exactly the confirmed amount.
	debits := intQuery(t, pool, `SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE org_id = $1 AND direction = 'debit' AND journal_ref = $2`,
		w.OrgID, "payment_confirmed:"+paymentID)
	credits := intQuery(t, pool, `SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE org_id = $1 AND direction = 'credit' AND journal_ref = $2`,
		w.OrgID, "payment_confirmed:"+paymentID)
	if debits != 250000 || credits != 250000 {
		t.Fatalf("ledger entry debits=%d credits=%d, want 250000/250000", debits, credits)
	}

	// At-least-once redelivery: the SAME journey acks as a duplicate, fires
	// the tripwire ONCE, and nothing re-runs.
	status, body = postCallback(t, server, path, c2bPaybillSingle)
	if status != 200 {
		t.Fatalf("redelivery: status %d body %v", status, body)
	}
	data = callbackData(t, body)
	if data["duplicate"] != true {
		t.Fatalf("redelivery must be the R9 duplicate, got %v", data)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 1 {
		t.Fatalf("redelivery created payments rows = %d, want still 1", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM daraja_callback_journeys`); got != 1 {
		t.Fatalf("journey rows = %d, want still 1", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.confirmed'`, w.OrgID); got != 1 {
		t.Fatalf("redelivery re-confirmed: payment.confirmed facts = %d, want 1", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payments.duplicateCallbackObserved'`, w.OrgID); got != 1 {
		t.Fatalf("duplicate tripwire facts = %d, want 1 (once per duplicate delivery)", got)
	}
}

// The validation endpoint is the pre-acceptance GATE: acknowledged, never
// ledgered, never money (the TS lane documents exactly this).
func TestC2BValidationEndpointAcknowledgesWithoutMoney(t *testing.T) {
	server, pool, w := bootKernel(t)
	path := "/v1/callbacks/daraja/" + w.OrgID + "/c2b/validation"

	status, body := postCallback(t, server, path, c2bPaybillSingle)
	if status != 200 {
		t.Fatalf("validation: status %d body %v", status, body)
	}
	data := callbackData(t, body)
	if data["ResultCode"].(float64) != 0 || data["ResultDesc"] != "Accepted" {
		t.Fatalf("validation verdict: %v", data)
	}
	if data["journeyKey"] != "c2b:SBK41XQ7RT" {
		t.Fatalf("validation journeyKey = %v", data["journeyKey"])
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 0 {
		t.Fatalf("validation created payments = %d, want 0", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM daraja_callback_journeys`); got != 0 {
		t.Fatalf("validation claimed journeys = %d, want 0 (a validation is not a fact)", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1`, w.OrgID); got != 0 {
		t.Fatalf("validation emitted events = %d, want 0", got)
	}
}

// Same journey with DIFFERENT money is tampering, not a retry: refused at
// the durable claim (409) with the payment untouched.
func TestC2BConfirmationTamperedAmountRefused(t *testing.T) {
	server, pool, w := bootKernel(t)
	path := "/v1/callbacks/daraja/" + w.OrgID + "/c2b/confirmation"

	if status, body := postCallback(t, server, path, c2bPaybillSingle); status != 200 {
		t.Fatalf("first delivery: status %d body %v", status, body)
	}

	status, body := postCallback(t, server, path, c2bPaybillSingleTampered)
	wantError(t, status, body, 409, "DARAJA_DUPLICATE_AMOUNT_MISMATCH")

	if got := intQuery(t, pool, `SELECT amount_minor FROM daraja_callback_journeys WHERE journey_key = $1`, "c2b:SBK41XQ7RT"); got != 250000 {
		t.Fatalf("journey claim changed: %d, want 250000", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1 AND confirmed_minor = 250000`, w.OrgID); got != 1 {
		t.Fatalf("payment altered by the tampered replay (rows = %d)", got)
	}
}

// The rail-routing refusals: a misshapen org segment, a foreign org and the
// K1 payload refusals all dead-letter with their promised codes — nothing
// guessed, nothing processed.
func TestCallbackEndpointsRefuseBadRoutingAndPayloads(t *testing.T) {
	server, pool, w := bootKernel(t)

	status, body := postCallback(t, server, "/v1/callbacks/daraja/not-a-uuid/c2b/validation", c2bPaybillSingle)
	wantError(t, status, body, 400, "DARAJA_CALLBACK_ORG_INVALID")

	status, body = postCallback(t, server, "/v1/callbacks/daraja/11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b/c2b/confirmation", c2bPaybillSingle)
	wantError(t, status, body, 400, "DARAJA_CALLBACK_ORG_UNKNOWN")

	// A lowercase TransID breaks the wire pattern (uppercase [A-Z0-9]).
	junkTransID := strings.Replace(c2bPaybillSingle, "SBK41XQ7RT", "sbk41xq7rt", 1)
	status, body = postCallback(t, server, "/v1/callbacks/daraja/"+w.OrgID+"/c2b/validation", junkTransID)
	wantError(t, status, body, 400, "DARAJA_TRANS_ID_MALFORMED")

	// A confirmation without its amount is refused before anything runs.
	noAmount := strings.Replace(c2bPaybillSingle, `"TransAmount": "2500.00",`, `"TransAmount": "",`, 1)
	status, body = postCallback(t, server, "/v1/callbacks/daraja/"+w.OrgID+"/c2b/confirmation", noAmount)
	wantError(t, status, body, 400, "DARAJA_AMOUNT_REQUIRED")

	// A non-object payload is the kernel's shape refusal.
	res, err := http.Post(server.URL+"/v1/callbacks/daraja/"+w.OrgID+"/c2b/confirmation", "application/json", strings.NewReader(`[1,2,3]`))
	if err != nil {
		t.Fatalf("array body: %v", err)
	}
	defer res.Body.Close()
	decoded := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&decoded)
	wantError(t, res.StatusCode, decoded, 400, "HTTP_BODY_INVALID")

	if got := countQuery(t, pool, `SELECT count(*) FROM daraja_callback_journeys`); got != 0 {
		t.Fatalf("refused deliveries must claim nothing (journeys = %d)", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 0 {
		t.Fatalf("refused deliveries must not move money (payments = %d)", got)
	}
}

// The STK result endpoint settles the push through ReconcileStkResult: the
// success fixture confirms the payment at the INITIATED amount (the metadata
// evidence must agree exactly), resolves the initiation and posts the
// balanced ledger entry.
func TestSTKResultEndpointConfirmsThePush(t *testing.T) {
	server, pool, w := bootKernel(t)
	seedStkInitiation(t, pool, w.OrgID, "ws_CO_12092025143105741", "58234-11940372-1", 250000)

	status, body := postCallback(t, server, "/v1/callbacks/daraja/stk/result", stkSuccess)
	if status != 200 {
		t.Fatalf("stk result: status %d body %v", status, body)
	}
	data := callbackData(t, body)
	if data["ResultCode"].(float64) != 0 || data["duplicate"] != false || data["paymentState"] != "confirmed" {
		t.Fatalf("stk result verdict: %v", data)
	}
	paymentID, _ := data["paymentId"].(string)
	if paymentID == "" {
		t.Fatalf("stk result must report the settled payment: %v", data)
	}
	if data["journeyKey"] != "stk:ws_CO_12092025143105741" {
		t.Fatalf("journeyKey = %v", data["journeyKey"])
	}

	// Money movement: channel stk, the rail receipt as the external ref,
	// confirmed exactly at the initiated 250000 (the metadata Amount 2500
	// agreed, KES integer minor units end-to-end).
	if got := stringQuery(t, pool, `SELECT channel FROM payments WHERE id = $1`, paymentID); got != "stk" {
		t.Fatalf("payment channel = %s, want stk", got)
	}
	if got := stringQuery(t, pool, `SELECT external_ref FROM payments WHERE id = $1`, paymentID); got != "SBK81KZ9QF" {
		t.Fatalf("external ref = %s, want the MpesaReceiptNumber", got)
	}
	if got := intQuery(t, pool, `SELECT confirmed_minor FROM payments WHERE id = $1`, paymentID); got != 250000 {
		t.Fatalf("confirmed minor = %d, want 250000", got)
	}
	if got := stringQuery(t, pool, `SELECT state FROM stk_initiations WHERE checkout_request_id = $1`, "ws_CO_12092025143105741"); got != "reconciled" {
		t.Fatalf("initiation state = %s, want reconciled", got)
	}
	if got := intQuery(t, pool, `SELECT amount_minor FROM daraja_callback_journeys WHERE journey_key = $1`, "stk:ws_CO_12092025143105741"); got != 250000 {
		t.Fatalf("journey claim = %d, want 250000", got)
	}
	debits := intQuery(t, pool, `SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE org_id = $1 AND direction = 'debit' AND journal_ref = $2`,
		w.OrgID, "payment_confirmed:"+paymentID)
	credits := intQuery(t, pool, `SELECT COALESCE(SUM(amount_minor), 0) FROM ledger_entries WHERE org_id = $1 AND direction = 'credit' AND journal_ref = $2`,
		w.OrgID, "payment_confirmed:"+paymentID)
	if debits != 250000 || credits != 250000 {
		t.Fatalf("ledger entry debits=%d credits=%d, want 250000/250000", debits, credits)
	}
}

// The failure fixture fails the payment (never confirms, never posts money)
// and resolves the initiation with the stable abandonment family.
func TestSTKResultEndpointFailsAbandonedPush(t *testing.T) {
	server, pool, w := bootKernel(t)
	seedStkInitiation(t, pool, w.OrgID, "ws_CO_12092025151022104", "58237-11941120-4", 150000)

	status, body := postCallback(t, server, "/v1/callbacks/daraja/stk/result", stkCancelled1032)
	if status != 200 {
		t.Fatalf("stk result: status %d body %v", status, body)
	}
	data := callbackData(t, body)
	paymentID, _ := data["paymentId"].(string)
	if paymentID == "" || data["paymentState"] != "failed" {
		t.Fatalf("abandonment must fail the payment, got %v", data)
	}
	if got := stringQuery(t, pool, `SELECT failure_code FROM payments WHERE id = $1`, paymentID); got != "STK_CANCELLED_BY_USER" {
		t.Fatalf("failure code = %s, want STK_CANCELLED_BY_USER", got)
	}
	if got := stringQuery(t, pool, `SELECT state FROM stk_initiations WHERE checkout_request_id = $1`, "ws_CO_12092025151022104"); got != "failed" {
		t.Fatalf("initiation state = %s, want failed", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM ledger_entries WHERE journal_ref = $1`, "payment_confirmed:"+paymentID); got != 0 {
		t.Fatalf("a failed push must post no ledger lines (got %d)", got)
	}
}

// At-least-once STK redelivery: the settled journey acks as the duplicate
// and nothing re-runs — one payment, one confirmation fact, one journey.
func TestSTKResultDuplicateRedeliveryAcksWithoutReRunning(t *testing.T) {
	server, pool, w := bootKernel(t)
	seedStkInitiation(t, pool, w.OrgID, "ws_CO_12092025143105741", "58234-11940372-1", 250000)

	first, firstBody := postCallback(t, server, "/v1/callbacks/daraja/stk/result", stkSuccess)
	if first != 200 {
		t.Fatalf("first delivery: %d %v", first, firstBody)
	}
	if paymentID := callbackData(t, firstBody)["paymentId"]; paymentID == "" {
		t.Fatalf("first delivery must report the settled payment: %v", firstBody)
	}

	second, secondBody := postCallback(t, server, "/v1/callbacks/daraja/stk/result", stkSuccess)
	if second != 200 {
		t.Fatalf("redelivery: %d %v", second, secondBody)
	}
	data := callbackData(t, secondBody)
	if data["duplicate"] != true {
		t.Fatalf("redelivery must be the duplicate, got %v", data)
	}
	if _, again := data["paymentId"]; again {
		t.Fatalf("a settled-journey ack reports the delivery verdict only, got %v", data)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 1 {
		t.Fatalf("payments = %d, want still 1", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.confirmed'`, w.OrgID); got != 1 {
		t.Fatalf("payment.confirmed facts = %d, want still 1", got)
	}
	if got := stringQuery(t, pool, `SELECT state FROM stk_initiations WHERE checkout_request_id = $1`, "ws_CO_12092025143105741"); got != "reconciled" {
		t.Fatalf("initiation state = %s, want reconciled", got)
	}
}

// A well-formed result for a checkout the merchant never initiated routes to
// nothing: refused (dead-letter) BEFORE any claim or money moves.
func TestSTKResultUnknownCheckoutRoutesToNothing(t *testing.T) {
	server, pool, w := bootKernel(t)

	status, body := postCallback(t, server, "/v1/callbacks/daraja/stk/result", stkSuccess)
	wantError(t, status, body, 400, "STK_STATE_INVALID")
	if got := countQuery(t, pool, `SELECT count(*) FROM daraja_callback_journeys`); got != 0 {
		t.Fatalf("unroutable results must claim nothing (journeys = %d)", got)
	}
	if got := countQuery(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1`, w.OrgID); got != 0 {
		t.Fatalf("unroutable results must not move money (payments = %d)", got)
	}
}
