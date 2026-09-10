package transport_test

// The /v1 ledger + adjustments surface (issue #132): the append-only GL read
// models and the two dry-run INTENT evaluators, exercised through the REAL
// composed mux over REAL PostgreSQL. Contract discipline under test:
//   - the ledger read routes are strictly READ-ONLY (R3): no /v1 operation
//     mutates ledger truth — rows arrive only through the payments lane's
//     posting flow (a confirmed payment posts its balanced entry in the SAME
//     transaction, R4/R5);
//   - the intent evaluators answer 200 with domain validation refusals AS
//     VALUES (ported verbatim from src/domain/adjustments/{credit-note,
//     refund}.ts + shared/money.ts) and write NOTHING — no refunds row, no
//     credit note, no ledger entry (R3/R6/R7);
//   - envelope shape, error codes and §38 pagination behave exactly like the
//     mounted read models before them.

import (
	"testing"
)

// TestLedgerReadModelsAreReadOnlyAndPaginated walks the two GL read routes
// over rows the posting flow wrote: the per-currency cash/AR chart seeded at
// the first confirmation and the balanced two-line journal — then proves the
// strict pagination boundaries, the sort whitelists and the org scoping.
func TestLedgerReadModelsAreReadOnlyAndPaginated(t *testing.T) {
	server, pool, w := bootKernel(t)

	// two confirmed payments in two currencies → the per-currency cash/AR
	// chart pairs and one balanced two-line entry per confirmation. The rows
	// are written ONLY by the posting flow (repositories.PostConfirmationEntry
	// inside the confirmation transaction) — the reads below never write.
	kesRef := "ext-" + randToken(t)
	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", kesRef, "idem-"+randToken(t), 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	paymentID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}

	usdRef := "ext-" + randToken(t)
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		map[string]any{"channel": "c2b", "externalRef": usdRef, "idempotencyKey": "idem-" + randToken(t),
			"amount": map[string]any{"minor": 2_500, "currency": "USD"}})
	if status != 201 {
		t.Fatalf("usd intake: %d %v", status, body)
	}
	secondID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+secondID+"/confirmations", w.AdminToken,
		map[string]any{"amount": map[string]any{"minor": 2_500, "currency": "USD"}})
	if status != 201 {
		t.Fatalf("usd confirm: %d %v", status, body)
	}

	// --- GET /v1/ledger/accounts -----------------------------------------
	status, body = call(t, server, "GET", "/v1/ledger/accounts", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("accounts list: %d %v", status, body)
	}
	rows := dataOf(t, body)["accounts"].([]any)
	if len(rows) != 4 {
		t.Fatalf("two currencies seed exactly the two cash/AR pairs, got %d rows: %v", len(rows), rows)
	}
	codes := map[string]bool{}
	for _, raw := range rows {
		row := raw.(map[string]any)
		if _, ok := row["id"].(string); !ok {
			t.Fatalf("account view carries the surrogate id: %v", row)
		}
		if _, ok := row["name"].(string); !ok {
			t.Fatalf("account view carries a name: %v", row)
		}
		if row["kind"] != "asset" {
			t.Fatalf("the confirmation chart is all-asset (R5 mapping): %v", row)
		}
		codes[row["code"].(string)] = true
	}
	for _, want := range []string{"cash-KES", "ar-KES", "cash-USD", "ar-USD"} {
		if !codes[want] {
			t.Fatalf("chart missing %s: %v", want, codes)
		}
	}

	meta := body["meta"].(map[string]any)["pagination"].(map[string]any)
	if meta["total"] != float64(4) || meta["nextCursor"] != nil {
		t.Fatalf("accounts pagination meta: %v", meta)
	}
	// one page at limit=2, then the offset cursor page
	status, body = call(t, server, "GET", "/v1/ledger/accounts?limit=2", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("limited accounts: %d %v", status, body)
	}
	if meta = body["meta"].(map[string]any)["pagination"].(map[string]any); meta["nextCursor"] != "2" {
		t.Fatalf("limit=2 answers nextCursor 2: %v", meta)
	}
	status, body = call(t, server, "GET", "/v1/ledger/accounts?limit=2&cursor=2", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("cursor accounts page: %d %v", status, body)
	}
	if rows = dataOf(t, body)["accounts"].([]any); len(rows) != 2 {
		t.Fatalf("cursor=2 returned %d rows, want 2", len(rows))
	}
	if meta = body["meta"].(map[string]any)["pagination"].(map[string]any); meta["nextCursor"] != nil {
		t.Fatalf("exhausted page must answer nextCursor null, got %v", meta["nextCursor"])
	}

	// sort whitelist: the `code` field orders deterministically, an unknown
	// field refuses, and the strict pagination boundaries refuse without clamping
	status, body = call(t, server, "GET", "/v1/ledger/accounts?sort=code&order=desc", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("sorted accounts: %d %v", status, body)
	}
	rows = dataOf(t, body)["accounts"].([]any)
	if rows[0].(map[string]any)["code"] != "cash-USD" {
		t.Fatalf("code desc must lead with cash-USD, got %v", rows[0].(map[string]any)["code"])
	}
	status, body = call(t, server, "GET", "/v1/ledger/accounts?sort=notAField", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")
	status, body = call(t, server, "GET", "/v1/ledger/accounts?limit=0", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")

	// --- GET /v1/ledger/entries ------------------------------------------
	status, body = call(t, server, "GET", "/v1/ledger/entries", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("entries list: %d %v", status, body)
	}
	entries := dataOf(t, body)["entries"].([]any)
	if len(entries) != 4 {
		t.Fatalf("two confirmations post exactly four journal lines, got %d: %v", len(entries), entries)
	}
	if meta = body["meta"].(map[string]any)["pagination"].(map[string]any); meta["total"] != float64(4) {
		t.Fatalf("entries pagination meta: %v", meta)
	}
	// every entry is the balanced Dr cash / Cr AR pair in ONE currency (R4/R10),
	// with the posting flow's provenance riding every line
	assertEntryPair := func(payment, sourceRef, cashCode, arCode, currency string, minor float64) {
		t.Helper()
		var debit, credit map[string]any
		for _, raw := range entries {
			row := raw.(map[string]any)
			if row["journalRef"] != "payment_confirmed:"+payment {
				continue
			}
			if row["lineNo"] == float64(1) {
				debit = row
			} else {
				credit = row
			}
		}
		if debit == nil || credit == nil {
			t.Fatalf("entry %s is missing a line: %v", payment, entries)
		}
		if debit["direction"] != "DEBIT" || debit["accountCode"] != cashCode {
			t.Fatalf("line 1 is the %s cash debit: %v", currency, debit)
		}
		if credit["direction"] != "CREDIT" || credit["accountCode"] != arCode {
			t.Fatalf("line 2 is the %s AR credit: %v", currency, credit)
		}
		if debit["entryId"] != credit["entryId"] {
			t.Fatalf("both lines share the entry: %v vs %v", debit["entryId"], credit["entryId"])
		}
		if got := debit["amount"].(map[string]any); got["minor"] != minor || got["currency"] != currency {
			t.Fatalf("line amount rides integer minor units (R10): %v", got)
		}
		if debit["source"] != "payments" {
			t.Fatalf("line provenance: %v", debit)
		}
		if debit["sourceRef"] != sourceRef {
			t.Fatalf("the confirmation's external ref rides source_ref: %v vs %v", debit["sourceRef"], sourceRef)
		}
		if debit["reversalOf"] != nil {
			t.Fatalf("a fresh posting is not a reversal: %v", debit)
		}
		if _, ok := debit["postedAt"].(string); !ok {
			t.Fatalf("postedAt is an ISO timestamp: %v", debit)
		}
	}
	assertEntryPair(paymentID, kesRef, "cash-KES", "ar-KES", "KES", 10_000)
	assertEntryPair(secondID, usdRef, "cash-USD", "ar-USD", "USD", 2_500)

	// entries sort whitelist pins the id/postedAt/source fields; whatever the
	// order, the lines of one entry stay adjacent and in line-no order — a page
	// boundary can never shuffle lines within an entry (the tiebreak guarantee)
	status, body = call(t, server, "GET", "/v1/ledger/entries?sort=postedAt&order=desc", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("sorted entries: %d %v", status, body)
	}
	entries = dataOf(t, body)["entries"].([]any)
	// the entry order reverses with the sort, but the tiebreak keeps every
	// entry's lines adjacent and ascending — a page boundary can never shuffle
	// lines within an entry (the (entry_id, line_no) tiebreak guarantee)
	for i := 0; i < len(entries); i += 2 {
		a := entries[i].(map[string]any)
		b := entries[i+1].(map[string]any)
		if a["entryId"] != b["entryId"] || a["lineNo"] != float64(1) || b["lineNo"] != float64(2) {
			t.Fatalf("descending order keeps each entry's lines adjacent (1 then 2): %v / %v", a, b)
		}
	}
	status, body = call(t, server, "GET", "/v1/ledger/entries?sort=amount", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")

	// --- org scoping: a foreign org reads its own (empty) GL --------------
	other := seedWorld(t, pool)
	status, body = call(t, server, "GET", "/v1/ledger/accounts", other.AdminToken, nil)
	if status != 200 {
		t.Fatalf("foreign org accounts: %d %v", status, body)
	}
	if rows := dataOf(t, body)["accounts"].([]any); len(rows) != 0 {
		t.Fatalf("foreign-org rows leaked into the chart: %v", rows)
	}
	if meta := body["meta"].(map[string]any)["pagination"].(map[string]any); meta["total"] != float64(0) {
		t.Fatalf("foreign org total: %v", meta)
	}
	status, body = call(t, server, "GET", "/v1/ledger/entries", other.AdminToken, nil)
	if status != 200 {
		t.Fatalf("foreign org entries: %d %v", status, body)
	}
	if rows := dataOf(t, body)["entries"].([]any); len(rows) != 0 {
		t.Fatalf("foreign-org journal lines leaked: %v", rows)
	}
}

// TestAdjustmentsFeedIsTheOrgScopedRefundTruth walks GET /v1/adjustments over
// a refund reservation the payments surface wrote — the feed is the read
// model, never a second write path.
func TestAdjustmentsFeedIsTheOrgScopedRefundTruth(t *testing.T) {
	server, pool, w := bootKernel(t)

	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", "ext-"+randToken(t), "idem-"+randToken(t), 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	paymentID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken, refundBody(4_000, "goodwill"))
	if status != 201 {
		t.Fatalf("refund reservation: %d %v", status, body)
	}

	status, body = call(t, server, "GET", "/v1/adjustments", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("feed: %d %v", status, body)
	}
	rows := dataOf(t, body)["adjustments"].([]any)
	if len(rows) != 1 {
		t.Fatalf("feed holds exactly the one reservation, got %d: %v", len(rows), rows)
	}
	row := rows[0].(map[string]any)
	if row["kind"] != "refund" || row["state"] != "requested" || row["reason"] != "goodwill" {
		t.Fatalf("feed row shape: %v", row)
	}
	if row["paymentId"] != paymentID {
		t.Fatalf("refund provenance: %v", row)
	}
	// the payments surface's requester — an ApiKey principal's id IS the key
	// id (auth.Principal semantics), exactly what the reservation wrote
	if row["requestedBy"] != w.AdminKeyID {
		t.Fatalf("requestedBy is the payments surface's requester: %v vs %v", row["requestedBy"], w.AdminKeyID)
	}
	if got := row["total"].(map[string]any); got["minor"] != float64(4_000) || got["currency"] != "KES" {
		t.Fatalf("feed money: %v", got)
	}
	if row["externalRef"] != nil || row["rejectedReason"] != nil || row["failedReason"] != nil {
		t.Fatalf("a live requested refund carries none of the terminal columns: %v", row)
	}
	if _, ok := row["createdAt"].(string); !ok {
		t.Fatalf("feed row carries createdAt: %v", row)
	}
	if meta := body["meta"].(map[string]any)["pagination"].(map[string]any); meta["total"] != float64(1) {
		t.Fatalf("feed meta: %v", meta)
	}

	// a second reservation on the same payment (ceiling 10_000 − 4_000 still
	// covers it) makes the feed multi-row for the cursor page
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken, refundBody(2_000, "second overpayment"))
	if status != 201 {
		t.Fatalf("second refund reservation: %d %v", status, body)
	}

	// pagination + the discriminated union's sort whitelist
	status, body = call(t, server, "GET", "/v1/adjustments?limit=1", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("limited feed: %d %v", status, body)
	}
	if meta := body["meta"].(map[string]any)["pagination"].(map[string]any); meta["nextCursor"] != "1" || meta["total"] != float64(2) {
		t.Fatalf("limit=1 answers nextCursor 1 with total 2: %v", meta)
	}
	status, body = call(t, server, "GET", "/v1/adjustments?limit=1&cursor=1", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("cursor feed page: %d %v", status, body)
	}
	if rows := dataOf(t, body)["adjustments"].([]any); len(rows) != 1 {
		t.Fatalf("cursor=1 returned %d rows, want 1", len(rows))
	}
	status, body = call(t, server, "GET", "/v1/adjustments?sort=kind&order=desc", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("sorted feed: %d %v", status, body)
	}
	status, body = call(t, server, "GET", "/v1/adjustments?sort=total", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")

	// org scoping: a foreign org's feed is empty — existence never leaks
	other := seedWorld(t, pool)
	status, body = call(t, server, "GET", "/v1/adjustments", other.AdminToken, nil)
	if status != 200 {
		t.Fatalf("foreign feed: %d %v", status, body)
	}
	if rows := dataOf(t, body)["adjustments"].([]any); len(rows) != 0 {
		t.Fatalf("foreign-org adjustments leaked: %v", rows)
	}
}

// TestCreditNoteIntentEvaluatesWithoutWriting pins POST
// /v1/adjustments/credit-notes: the lane's refusal table
// (src/domain/adjustments/credit-note.ts, draftCreditNote) answers as 200-body
// VALUES (collected — one proposal can fail several guards at once), the
// accepted draft is minted by the kernel's id port, and NOTHING is persisted
// (no credit_notes row, no ledger entry, no refunds row — R3/R7).
func TestCreditNoteIntentEvaluatesWithoutWriting(t *testing.T) {
	server, pool, w := bootKernel(t)

	// a confirmed payment so the ledger holds rows the evaluator must not touch
	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", "ext-"+randToken(t), "idem-"+randToken(t), 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	paymentID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}
	ledgerLines := countOf(t, pool, `SELECT count(*) FROM ledger_entries WHERE org_id = $1`, w.OrgID)

	// accepted: the draft is a proposal — evaluated, never stored (the
	// optional invoice linkage rides the proposal when the body carries one)
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{
			"customerId": w.AdminKeyID, "invoiceId": "0f1e2d3c-4b5a-4968-8776-6554433221ff",
			"reason": "  goods returned — partial delivery shortfall  ",
			"total":  map[string]any{"minor": 250_000, "currency": "KES"},
		})
	if status != 200 {
		t.Fatalf("credit-note intent: %d %v", status, body)
	}
	data := dataOf(t, body)
	if data["accepted"] != true || data["refusals"].([]any) == nil || len(data["refusals"].([]any)) != 0 {
		t.Fatalf("accepted intent: %v", data)
	}
	intent := data["intent"].(map[string]any)
	if intent["state"] != "draft" {
		t.Fatalf("the evaluator ends at the lane's draft state: %v", intent)
	}
	if intent["reason"] != "goods returned — partial delivery shortfall" {
		t.Fatalf("the lane trims the reason (draftCreditNote guards blankness only): %v", intent["reason"])
	}
	if got := intent["total"].(map[string]any); got["minor"] != float64(250_000) || got["currency"] != "KES" {
		t.Fatalf("intent total: %v", got)
	}
	if _, ok := intent["id"].(string); !ok {
		t.Fatalf("the kernel's id port mints the draft id: %v", intent)
	}
	if intent["invoiceId"] != "0f1e2d3c-4b5a-4968-8776-6554433221ff" {
		t.Fatalf("the optional invoice linkage rides the draft: %v", intent)
	}

	// nothing was written anywhere (R3/R7): no credit note, no second ledger line
	if got := countOf(t, pool, `SELECT count(*) FROM credit_notes WHERE org_id = $1`, w.OrgID); got != 0 {
		t.Fatalf("an ACCEPTED intent is still a dry run — credit_notes rows = %d, want 0", got)
	}
	if got := countOf(t, pool, `SELECT count(*) FROM ledger_entries WHERE org_id = $1`, w.OrgID); got != ledgerLines {
		t.Fatalf("the intent surface appended %d ledger rows, want 0 (R3)", got-ledgerLines)
	}

	// the two independent value guards COLLECT (a proposal can fail both)
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		creditNoteBody(w.AdminID, "   ", -5))
	if status != 200 {
		t.Fatalf("refused intent must still answer 200: %d %v", status, body)
	}
	data = dataOf(t, body)
	if data["accepted"] != false || data["intent"] != nil {
		t.Fatalf("a refused proposal carries no intent: %v", data)
	}
	codes := map[string]any{}
	for _, raw := range data["refusals"].([]any) {
		refusal := raw.(map[string]any)
		codes[refusal["code"].(string)] = refusal
	}
	reasonRefusal, ok := codes["CREDIT_NOTE_REASON_REQUIRED"].(map[string]any)
	if !ok || reasonRefusal["message"] != "a credit note requires a reason" || reasonRefusal["field"] != "reason" {
		t.Fatalf("CREDIT_NOTE_REASON_REQUIRED travels verbatim: %v", reasonRefusal)
	}
	totalRefusal, ok := codes["CREDIT_NOTE_TOTAL_INVALID"].(map[string]any)
	if !ok || totalRefusal["message"] != "credit note total must be positive" || totalRefusal["field"] != "total.minor" {
		t.Fatalf("CREDIT_NOTE_TOTAL_INVALID travels verbatim: %v", totalRefusal)
	}

	// only JSON SHAPE is a transport 400 — blankness/non-positive are values
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{"customerId": w.AdminID, "reason": 123, "total": map[string]any{"minor": 100, "currency": "KES"}})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{"customerId": w.AdminID, "reason": "x", "total": map[string]any{"minor": "100", "currency": "KES"}})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{"customerId": w.AdminID, "reason": "x", "total": map[string]any{"minor": 100, "currency": "XYZ"}})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{"customerId": "not-a-uuid", "reason": "x", "total": map[string]any{"minor": 100, "currency": "KES"}})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		map[string]any{"reason": "x", "total": map[string]any{"minor": 100, "currency": "KES"}})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
}

// TestRefundIntentEvaluatorPinsTheR6Ceiling pins POST
// /v1/adjustments/refund-reservations: the R6 ceiling is the payment
// snapshot's confirmed − Σ(allocations) − Σ(live refunds) (an unconfirmed
// payment has ceiling 0), the refusal table ports refund.ts verbatim
// (refusals as 200-body values), an unknown or foreign-org payment answers
// 404, and NOTHING is written (R3/R6).
func TestRefundIntentEvaluatorPinsTheR6Ceiling(t *testing.T) {
	server, pool, w := bootKernel(t)

	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", "ext-"+randToken(t), "idem-"+randToken(t), 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	paymentID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}
	// a 4_000 reservation from the payments surface drops the ceiling to 6_000
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken, refundBody(4_000, "goodwill"))
	if status != 201 {
		t.Fatalf("refund reservation: %d %v", status, body)
	}
	refundRows := countOf(t, pool, `SELECT count(*) FROM refunds WHERE org_id = $1`, w.OrgID)

	// accepted: the proposed Requested refund + the ceiling it was evaluated
	// against — and the requester defaults to the authenticated principal
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(paymentID, 2_000, "duplicate deposit — refunding the overpayment"))
	if status != 200 {
		t.Fatalf("refund intent: %d %v", status, body)
	}
	data := dataOf(t, body)
	if data["accepted"] != true || len(data["refusals"].([]any)) != 0 {
		t.Fatalf("accepted refund intent: %v", data)
	}
	intent := data["intent"].(map[string]any)
	if intent["state"] != "requested" || intent["paymentId"] != paymentID {
		t.Fatalf("intent shape: %v", intent)
	}
	if intent["requestedBy"] != w.AdminKeyID {
		t.Fatalf("requestedBy defaults to the authenticated principal's id (an ApiKey principal's id IS the key id): %v vs %v", intent["requestedBy"], w.AdminKeyID)
	}
	if got := intent["total"].(map[string]any); got["minor"] != float64(2_000) {
		t.Fatalf("intent total: %v", got)
	}
	if got := intent["ceiling"].(map[string]any); got["minor"] != float64(6_000) || got["currency"] != "KES" {
		t.Fatalf("the R6 ceiling is an audit value on the intent: %v", got)
	}
	if _, ok := intent["id"].(string); !ok {
		t.Fatalf("the kernel's id port mints the intent id: %v", intent)
	}
	// NOTHING was written (R3/R6): no second refunds row, no ledger line
	if got := countOf(t, pool, `SELECT count(*) FROM refunds WHERE org_id = $1`, w.OrgID); got != refundRows {
		t.Fatalf("an ACCEPTED intent is still a dry run — refunds rows = %d, want %d", got, refundRows)
	}
	if got := countOf(t, pool, `SELECT count(*) FROM ledger_entries WHERE org_id = $1`, w.OrgID); got != 2 {
		t.Fatalf("the intent surface appended ledger rows, want the posting flow's 2, got %d", got)
	}

	// over the ceiling → REFUND_EXCEEDS_CEILING with the domain's details
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(paymentID, 6_001, "over"))
	if status != 200 {
		t.Fatalf("over-ceiling intent answers 200: %d %v", status, body)
	}
	data = dataOf(t, body)
	if data["accepted"] != false || data["intent"] != nil {
		t.Fatalf("a refused proposal carries no intent: %v", data)
	}
	refusals := data["refusals"].([]any)
	if len(refusals) != 1 {
		t.Fatalf("exactly one refusal: %v", refusals)
	}
	refusal := refusals[0].(map[string]any)
	if refusal["code"] != "REFUND_EXCEEDS_CEILING" || refusal["field"] != "amount" {
		t.Fatalf("R6 refusal shape: %v", refusal)
	}
	details := refusal["details"].(map[string]any)
	if details["requestedMinor"] != float64(6_001) || details["ceilingMinor"] != float64(6_000) || details["paymentId"] != paymentID {
		t.Fatalf("R6 refusal details: %v", details)
	}
	if refusal["message"] != "refund 60.01 KES exceeds ceiling 60.00 KES" {
		t.Fatalf("the refusal message renders money the domain's way: %q", refusal["message"])
	}

	// cross-currency refuses CURRENCY_MISMATCH before the comparison (R10)
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		map[string]any{"paymentId": paymentID, "amount": map[string]any{"minor": 1_000, "currency": "USD"}, "reason": "wrong wallet"})
	if status != 200 {
		t.Fatalf("cross-currency intent answers 200: %d %v", status, body)
	}
	refusals = dataOf(t, body)["refusals"].([]any)
	if len(refusals) != 1 {
		t.Fatalf("exactly one refusal: %v", refusals)
	}
	refusal = refusals[0].(map[string]any)
	if refusal["code"] != "CURRENCY_MISMATCH" || refusal["message"] != "cannot compare USD with KES" {
		t.Fatalf("CURRENCY_MISMATCH travels verbatim (money.ts:56-63): %v", refusal)
	}

	// an unconfirmed payment has nothing landed → ceiling 0 → any amount refuses
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("stk", "ext-"+randToken(t), "idem-"+randToken(t), 2_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	unconfirmedID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(unconfirmedID, 100, "too early"))
	if status != 200 {
		t.Fatalf("unconfirmed intent answers 200: %d %v", status, body)
	}
	refusals = dataOf(t, body)["refusals"].([]any)
	if len(refusals) != 1 || refusals[0].(map[string]any)["code"] != "REFUND_EXCEEDS_CEILING" {
		t.Fatalf("an unconfirmed payment's ceiling is 0: %v", refusals)
	}
	if details := refusals[0].(map[string]any)["details"].(map[string]any); details["ceilingMinor"] != float64(0) {
		t.Fatalf("ceiling 0 for an unconfirmed payment: %v", details)
	}

	// the independent value guards COLLECT (reason + amount fail together)
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(paymentID, 0, "   "))
	if status != 200 {
		t.Fatalf("value-refused intent answers 200: %d %v", status, body)
	}
	codes := map[string]bool{}
	for _, raw := range dataOf(t, body)["refusals"].([]any) {
		codes[raw.(map[string]any)["code"].(string)] = true
	}
	if !codes["REFUND_REASON_REQUIRED"] || !codes["REFUND_AMOUNT_INVALID"] {
		t.Fatalf("the collected refusal table: %v", codes)
	}
	if codes["REFUND_REQUESTER_REQUIRED"] {
		t.Fatalf("an authenticated principal is always the requester: %v", codes)
	}

	// an unknown payment answers the payments surface's 404 — and so does a
	// foreign-org payment (existence is never leaked across orgs)
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody("00000000-0000-4000-8000-00000000000f", 100, "ghost"))
	wantError(t, status, body, 404, "HTTP_PAYMENT_NOT_FOUND")
	other := seedWorld(t, pool)
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", other.AdminToken,
		refundIntentBody(paymentID, 100, "cross-org"))
	wantError(t, status, body, 404, "HTTP_PAYMENT_NOT_FOUND")

	// only JSON SHAPE is a transport 400
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		map[string]any{"paymentId": paymentID, "amount": map[string]any{"minor": -1, "currency": 5}, "reason": "x"})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		map[string]any{"amount": map[string]any{"minor": 100, "currency": "KES"}, "reason": "x"})
	wantError(t, status, body, 400, "HTTP_BODY_INVALID")
}

// TestIntentSurfaceNeverMutatesFundTruth is the acceptance-2 invariant proof:
// after a full walk of the adjustments surface (feed reads, both evaluators,
// accepted AND refused proposals) the fund truth holds exactly the rows the
// posting flows wrote — the /v1 surface has no ledger write path (R1–R10).
func TestIntentSurfaceNeverMutatesFundTruth(t *testing.T) {
	server, pool, w := bootKernel(t)

	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", "ext-"+randToken(t), "idem-"+randToken(t), 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	paymentID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}

	baseline := map[string]int64{
		"ledger_entries":  countOf(t, pool, `SELECT count(*) FROM ledger_entries WHERE org_id = $1`, w.OrgID),
		"ledger_accounts": countOf(t, pool, `SELECT count(*) FROM ledger_accounts WHERE org_id = $1`, w.OrgID),
		"credit_notes":    countOf(t, pool, `SELECT count(*) FROM credit_notes WHERE org_id = $1`, w.OrgID),
		"refunds":         countOf(t, pool, `SELECT count(*) FROM refunds WHERE org_id = $1`, w.OrgID),
	}

	// accepted credit note + accepted refund intent + refused proposals + reads
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		creditNoteBody(w.AdminID, "goods returned", 1_000))
	if status != 200 {
		t.Fatalf("credit-note intent: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/adjustments/credit-notes", w.AdminToken,
		creditNoteBody(w.AdminID, "", 0))
	if status != 200 {
		t.Fatalf("refused credit-note intent: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(paymentID, 1_000, "overpayment"))
	if status != 200 {
		t.Fatalf("refund intent: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/adjustments/refund-reservations", w.AdminToken,
		refundIntentBody(paymentID, 999_999, "over the ceiling"))
	if status != 200 {
		t.Fatalf("refused refund intent: %d %v", status, body)
	}
	for _, path := range []string{"/v1/adjustments", "/v1/ledger/accounts", "/v1/ledger/entries"} {
		status, body = call(t, server, "GET", path, w.AdminToken, nil)
		if status != 200 {
			t.Fatalf("read %s: %d %v", path, status, body)
		}
	}

	for table, want := range baseline {
		if got := countOf(t, pool, `SELECT count(*) FROM `+table+` WHERE org_id = $1`, w.OrgID); got != want {
			t.Fatalf("%s drifted during the intent walk: %d rows, want the posting flows' %d", table, got, want)
		}
	}
	// the R4 balance of the confirmation entry is untouched
	var debits, credits int64
	if err := pool.QueryRow(t.Context(), `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
                COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
                FROM ledger_entries WHERE org_id = $1 AND journal_ref = $2`, w.OrgID, "payment_confirmed:"+paymentID).Scan(&debits, &credits); err != nil {
		t.Fatalf("ledger totals: %v", err)
	}
	if debits != 10_000 || credits != 10_000 {
		t.Fatalf("R4 broken by the intent surface: Σdebits=%d Σcredits=%d", debits, credits)
	}
}
