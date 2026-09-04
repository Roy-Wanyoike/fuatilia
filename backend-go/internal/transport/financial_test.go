package transport_test

// Financial-core integration gates (issue #72 acceptance 3 and 4): the
// payments R9 idempotent intake funnel, the balanced double-entry ledger,
// the R6 refund ceiling with zero-row rollback, the R8 one-open-case
// exclusivity, the per-org controlled case sequence and the collections
// lifecycle — exercised through the REAL composed mux over REAL PostgreSQL,
// exactly the behavior the TS lanes' spec fixtures pin.

import (
	"testing"
	"time"
)

// TestPaymentsR9IntakeConfirmLedgerRefundCeiling walks the fund-truth
// lifecycle: intake → R9 replays (original result, no second payment) →
// confirmation (ledger rows posted in the SAME tx, Σdebits == Σcredits) →
// idempotent re-confirmation (never a double-post) → the R6 refund ceiling
// (over-draw refuses 422 and rolls back to zero rows).
func TestPaymentsR9IntakeConfirmLedgerRefundCeiling(t *testing.T) {
	server, pool, w := bootKernel(t)

	externalRef := "ext-" + randToken(t)
	idempotencyKey := "idem-" + randToken(t)

	// intake → 201 initiated; the R9 key is claimed durably in the same tx
	status, body := call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", externalRef, idempotencyKey, 10_000))
	if status != 201 {
		t.Fatalf("intake: %d %v", status, body)
	}
	payment := dataOf(t, body)["payment"].(map[string]any)
	paymentID := payment["id"].(string)
	if payment["state"] != "initiated" {
		t.Fatalf("intake state = %v, want initiated", payment["state"])
	}
	if got := dataOf(t, body)["duplicate"]; got != false {
		t.Fatalf("first intake duplicate = %v, want false", got)
	}
	if countOf(t, pool, `SELECT count(*) FROM idempotency_keys WHERE org_id = $1 AND scope = 'payments.intake' AND key = $2`,
		w.OrgID, idempotencyKey) != 1 {
		t.Fatalf("the intake key was not claimed durably in the intake transaction")
	}
	// the outbox fact commits WITH the payment (transactional outbox)
	if countOf(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.initiated' AND payload->>'paymentId' = $2`,
		w.OrgID, paymentID) != 1 {
		t.Fatalf("payment.initiated fact missing from the outbox")
	}

	// R9 replay A: same idempotency key, same money → 200 + THE ORIGINAL payment
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", externalRef, idempotencyKey, 10_000))
	if status != 200 {
		t.Fatalf("replay by key: %d %v", status, body)
	}
	replayed := dataOf(t, body)["payment"].(map[string]any)
	if dataOf(t, body)["duplicate"] != true || replayed["id"] != paymentID {
		t.Fatalf("replay must return the ORIGINAL result: duplicate=%v id=%v", dataOf(t, body)["duplicate"], replayed["id"])
	}

	// R9 replay B: same key, different money → untrusted input (409)
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", externalRef, idempotencyKey, 500))
	wantError(t, status, body, 409, "DUPLICATE_AMOUNT_MISMATCH")

	// R9 replay C: a FRESH key over the same externalRef with wrong money is
	// refused — and claims NOTHING (the failed attempt rolls back whole), so
	// the legitimate retry with the correct amount replays cleanly.
	freshKey := "idem-" + randToken(t)
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", externalRef, freshKey, 999))
	wantError(t, status, body, 409, "DUPLICATE_AMOUNT_MISMATCH")
	if countOf(t, pool, `SELECT count(*) FROM idempotency_keys WHERE org_id = $1 AND key = $2`, w.OrgID, freshKey) != 0 {
		t.Fatalf("a failed intake attempt must claim no idempotency key (R9: retries find a free key)")
	}
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("c2b", externalRef, freshKey, 10_000))
	if status != 200 || dataOf(t, body)["payment"].(map[string]any)["id"] != paymentID {
		t.Fatalf("legitimate retry after a failed attempt must replay the original: %d %v", status, body)
	}

	// exactly ONE payment exists no matter how many callbacks arrived
	if got := countOf(t, pool, `SELECT count(*) FROM payments WHERE org_id = $1 AND (idempotency_key = $2 OR external_ref = $3)`,
		w.OrgID, idempotencyKey, externalRef); got != 1 {
		t.Fatalf("duplicate callbacks created %d payments, want exactly 1 (R9)", got)
	}

	// confirm → 201; the balanced ledger entry posts in the SAME transaction
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 201 {
		t.Fatalf("confirm: %d %v", status, body)
	}
	if dataOf(t, body)["payment"].(map[string]any)["state"] != "confirmed" {
		t.Fatalf("confirm state: %v", dataOf(t, body)["payment"].(map[string]any)["state"])
	}
	journalRef := "payment_confirmed:" + paymentID
	var debits, credits int64
	if err := pool.QueryRow(t.Context(), `SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
                COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
                FROM ledger_entries WHERE org_id = $1 AND journal_ref = $2`, w.OrgID, journalRef).Scan(&debits, &credits); err != nil {
		t.Fatalf("ledger totals: %v", err)
	}
	if debits != 10_000 || credits != 10_000 {
		t.Fatalf("R4 broken: Σdebits=%d Σcredits=%d, want 10000/10000", debits, credits)
	}
	if countOf(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'payment.confirmed' AND payload->>'paymentId' = $2`,
		w.OrgID, paymentID) != 1 {
		t.Fatalf("payment.confirmed fact missing from the outbox")
	}

	// re-confirmation with the same amount → 200 no-op; NO second posting
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/confirmations", w.AdminToken, moneyBody(10_000))
	if status != 200 || dataOf(t, body)["alreadyConfirmed"] != true {
		t.Fatalf("idempotent re-confirm: %d %v", status, body)
	}
	if got := countOf(t, pool, `SELECT count(*) FROM ledger_entries WHERE org_id = $1 AND journal_ref = $2`, w.OrgID, journalRef); got != 2 {
		t.Fatalf("re-confirmation double-posted: %d ledger lines, want exactly 2", got)
	}

	// R6: over-draw refuses 422 REFUND_EXCEEDS_AVAILABLE and leaves ZERO rows
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken,
		refundBody(10_001, "over-draw"))
	wantError(t, status, body, 422, "REFUND_EXCEEDS_AVAILABLE")
	if got := countOf(t, pool, `SELECT count(*) FROM refunds WHERE org_id = $1 AND payment_id = $2`, w.OrgID, paymentID); got != 0 {
		t.Fatalf("a refused refund must roll back to zero rows, found %d", got)
	}

	// a legitimate reservation appends (201), and the ceiling tracks it
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken,
		refundBody(4_000, "goodwill"))
	if status != 201 {
		t.Fatalf("refund reservation: %d %v", status, body)
	}
	if got := countOf(t, pool, `SELECT count(*) FROM refunds WHERE org_id = $1 AND payment_id = $2 AND state = 'requested'`, w.OrgID, paymentID); got != 1 {
		t.Fatalf("refund reservation rows = %d, want 1", got)
	}
	status, body = call(t, server, "POST", "/v1/payments/"+paymentID+"/refund-reservations", w.AdminToken,
		refundBody(6_001, "second over-draw"))
	wantError(t, status, body, 422, "REFUND_EXCEEDS_AVAILABLE")

	// refunding against an UNconfirmed payment refuses (R6 draws on landed funds)
	otherRef := "ext-" + randToken(t)
	status, body = call(t, server, "POST", "/v1/payments/intake", w.AdminToken,
		intakeBody("stk", otherRef, "idem-"+randToken(t), 2_000))
	otherID := dataOf(t, body)["payment"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/payments/"+otherID+"/refund-reservations", w.AdminToken,
		refundBody(100, "too early"))
	wantError(t, status, body, 409, "PAYMENT_NOT_CONFIRMED")
}

// TestCollectionsR8ExclusivitySequenceAndLifecycle pins the collections
// core: the per-org controlled case sequence (CASE-000001 restarts per org),
// R8's at-most-one-open-case exclusivity, the lifecycle edges, the strictly
// upward escalations and the exactly-once action completion.
func TestCollectionsR8ExclusivitySequenceAndLifecycle(t *testing.T) {
	server, pool, w := bootKernel(t)

	receivableID := seedReceivable(t, pool, w.OrgID, "KES", 5_000_00, time.Now().Add(-24*time.Hour), true)
	status, body := call(t, server, "POST", "/v1/collections/cases", w.AdminToken,
		map[string]any{"receivableIds": []string{receivableID}, "collectorId": w.AdminID})
	if status != 201 {
		t.Fatalf("open case: %d %v", status, body)
	}
	cse := dataOf(t, body)["case"].(map[string]any)
	caseID := cse["id"].(string)
	if cse["caseNumber"] != "CASE-000001" || cse["sequence"] != float64(1) {
		t.Fatalf("first case in the org must be CASE-000001 seq 1, got %v seq %v", cse["caseNumber"], cse["sequence"])
	}
	if cse["status"] != "open" || cse["derivedStatus"] != "waiting" {
		t.Fatalf("new case state: %v / %v", cse["status"], cse["derivedStatus"])
	}

	// R8: a second open case over the SAME receivable is structurally refused
	status, body = call(t, server, "POST", "/v1/collections/cases", w.AdminToken,
		map[string]any{"receivableIds": []string{receivableID}, "collectorId": w.AdminID})
	wantError(t, status, body, 409, "CASE_ALREADY_OPEN")

	// the sequence is PER ORG: another org's first case is CASE-000001 again
	w2 := seedWorld(t, pool)
	otherReceivable := seedReceivable(t, pool, w2.OrgID, "KES", 1_000_00, time.Now().Add(-24*time.Hour), false)
	status, body = call(t, server, "POST", "/v1/collections/cases", w2.AdminToken,
		map[string]any{"receivableIds": []string{otherReceivable}, "collectorId": w2.AdminID})
	if status != 201 {
		t.Fatalf("other-org open case: %d %v", status, body)
	}
	if got := dataOf(t, body)["case"].(map[string]any)["caseNumber"]; got != "CASE-000001" {
		t.Fatalf("case sequence must be per-org, other org's first case = %v", got)
	}

	// lifecycle: open → in_progress → resolved; the resolved fact rides the outbox
	status, body = call(t, server, "POST", "/v1/collections/cases/"+caseID+"/transitions", w.AdminToken,
		map[string]any{"to": "in_progress", "reason": "collector picked it up"})
	if status != 200 || dataOf(t, body)["case"].(map[string]any)["status"] != "in_progress" {
		t.Fatalf("transition to in_progress: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/collections/cases/"+caseID+"/transitions", w.AdminToken,
		map[string]any{"to": "resolved", "reason": "paid in full"})
	if status != 200 || dataOf(t, body)["case"].(map[string]any)["status"] != "resolved" {
		t.Fatalf("transition to resolved: %d %v", status, body)
	}
	if countOf(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'case.resolved' AND payload->>'caseId' = $2`,
		w.OrgID, caseID) != 1 {
		t.Fatalf("case.resolved fact missing from the outbox")
	}
	// resolved is terminal — no further edges
	status, body = call(t, server, "POST", "/v1/collections/cases/"+caseID+"/transitions", w.AdminToken,
		map[string]any{"to": "in_progress", "reason": "reopen attempt"})
	// CASE_TRANSITION_INVALID carries the _INVALID suffix the TS suffix table
	// maps to 400 (only the payment family's INVALID_TRANSITION has a 409 exact
	// override) — the assertion pins the TS mapping, not an intuition.
	wantError(t, status, body, 400, "CASE_TRANSITION_INVALID")
	// a closed case's action log is sealed
	status, body = call(t, server, "POST", "/v1/collections/cases/"+caseID+"/actions", w.AdminToken,
		map[string]any{"type": "call", "scheduledFor": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	wantError(t, status, body, 409, "CASE_CLOSED")

	// escalations are strictly upward, on a live case
	secondReceivable := seedReceivable(t, pool, w.OrgID, "KES", 3_000_00, time.Now().Add(-48*time.Hour), true)
	status, body = call(t, server, "POST", "/v1/collections/cases", w.AdminToken,
		map[string]any{"receivableIds": []string{secondReceivable}, "collectorId": w.AdminID})
	if status != 201 {
		t.Fatalf("second case: %d %v", status, body)
	}
	if got := dataOf(t, body)["case"].(map[string]any)["caseNumber"]; got != "CASE-000002" {
		t.Fatalf("second case in the org must continue the sequence, got %v", got)
	}
	case2 := dataOf(t, body)["case"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/escalations", w.AdminToken,
		map[string]any{"to": "high", "reason": "aging into 31-60"})
	if status != 200 || dataOf(t, body)["case"].(map[string]any)["priority"] != "high" {
		t.Fatalf("escalation: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/escalations", w.AdminToken,
		map[string]any{"to": "normal", "reason": "downgrade attempt"})
	wantError(t, status, body, 400, "CASE_ESCALATION_INVALID")

	// actions record, complete exactly once; K2 gates automated outbound sends
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/actions", w.AdminToken,
		map[string]any{"type": "call", "scheduledFor": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	if status != 201 {
		t.Fatalf("record action: %d %v", status, body)
	}
	actionID := dataOf(t, body)["action"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/actions/"+actionID+"/completions", w.AdminToken,
		map[string]any{"outcome": "reached, promised to pay Friday"})
	if status != 200 {
		t.Fatalf("complete action: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/actions/"+actionID+"/completions", w.AdminToken,
		map[string]any{"outcome": "again"})
	wantError(t, status, body, 409, "CASE_ACTION_ALREADY_COMPLETED")

	// K2: an automated sms without an active consentRef is refused BEFORE
	// anything is sent — the compliance fact lands, the actions log does not
	// grow, and the wire carries 403 DUNNING_CONSENT_REQUIRED.
	actionsBefore := countOf(t, pool, `SELECT count(*) FROM case_actions WHERE org_id = $1 AND case_id = $2 AND action IN ('call','sms','whatsapp','letter','fieldVisit','escalation')`,
		w.OrgID, case2)
	status, body = call(t, server, "POST", "/v1/collections/cases/"+case2+"/actions", w.AdminToken,
		map[string]any{"type": "sms", "scheduledFor": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)})
	wantError(t, status, body, 403, "DUNNING_CONSENT_REQUIRED")
	if countOf(t, pool, `SELECT count(*) FROM outbox_events WHERE org_id = $1 AND event_type = 'collections.dunningBlockedNoConsent'`,
		w.OrgID) != 1 {
		t.Fatalf("the K2 refusal must append its compliance fact to the outbox")
	}
	if got := countOf(t, pool, `SELECT count(*) FROM case_actions WHERE org_id = $1 AND case_id = $2 AND action IN ('call','sms','whatsapp','letter','fieldVisit','escalation')`,
		w.OrgID, case2); got != actionsBefore {
		t.Fatalf("a consent-blocked send must not append to the actions log: %d → %d", actionsBefore, got)
	}
}

// TestReceivablesReadModelPaginationAndSorting pins the receivable read
// model: strict limit boundaries, the opaque offset cursor, whitelist
// sorting and the R1-generated balance — through the real mux.
func TestReceivablesReadModelPaginationAndSorting(t *testing.T) {
	server, pool, w := bootKernel(t)

	// seed with distinct due dates so the sort order is decisive
	seedReceivable(t, pool, w.OrgID, "KES", 1_000_00, time.Now().Add(-72*time.Hour), true)
	second := seedReceivable(t, pool, w.OrgID, "KES", 2_000_00, time.Now().Add(-48*time.Hour), true)
	third := seedReceivable(t, pool, w.OrgID, "KES", 3_000_00, time.Now().Add(-24*time.Hour), false)

	status, body := call(t, server, "GET", "/v1/receivables?limit=2", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("list: %d %v", status, body)
	}
	rows := dataOf(t, body)["receivables"].([]any)
	if len(rows) != 2 {
		t.Fatalf("limit=2 returned %d rows", len(rows))
	}
	meta := body["meta"].(map[string]any)["pagination"].(map[string]any)
	if meta["total"] != float64(3) || meta["nextCursor"] != "2" {
		t.Fatalf("pagination meta: %v", meta)
	}

	status, body = call(t, server, "GET", "/v1/receivables?limit=2&cursor=2", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("cursor page: %d %v", status, body)
	}
	rows = dataOf(t, body)["receivables"].([]any)
	if len(rows) != 1 {
		t.Fatalf("cursor=2 returned %d rows, want 1", len(rows))
	}
	if meta := body["meta"].(map[string]any)["pagination"].(map[string]any); meta["nextCursor"] != nil {
		t.Fatalf("exhausted page must answer nextCursor null, got %v", meta["nextCursor"])
	}

	// whitelist sorting: sort=dueDate&order=desc puts the LATEST due first
	status, body = call(t, server, "GET", "/v1/receivables?sort=dueDate&order=desc", w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("sorted list: %d %v", status, body)
	}
	rows = dataOf(t, body)["receivables"].([]any)
	if rows[0].(map[string]any)["id"] != third {
		t.Fatalf("dueDate desc must lead with the latest due date (%s), got %v", third, rows[0].(map[string]any)["id"])
	}

	// the strict boundaries refuse without clamping (§38 pagination)
	status, body = call(t, server, "GET", "/v1/receivables?limit=0", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")
	status, body = call(t, server, "GET", "/v1/receivables?limit=101", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")
	status, body = call(t, server, "GET", "/v1/receivables?limit=abc", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")
	status, body = call(t, server, "GET", "/v1/receivables?sort=notAField", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")
	// a percent-encoded injection lands as a literal value and STILL refuses
	// (URLSearchParams parity — the decoded string never reaches SQL)
	status, body = call(t, server, "GET", "/v1/receivables?sort=id%3Bdrop", w.AdminToken, nil)
	wantError(t, status, body, 400, "HTTP_QUERY_INVALID")

	// detail: the R1 balance is the DB's generated column (original − applied)
	status, body = call(t, server, "GET", "/v1/receivables/"+second, w.AdminToken, nil)
	if status != 200 {
		t.Fatalf("detail: %d %v", status, body)
	}
	detail := dataOf(t, body)["receivable"].(map[string]any)
	if detail["id"] != second {
		t.Fatalf("detail id: %v", detail["id"])
	}
	if got := detail["balance"].(map[string]any)["minor"]; got != float64(2_000_00) {
		t.Fatalf("R1 balance = %v, want %v", got, 2_000_00)
	}
	if got := detail["aging"].(map[string]any)["bucket"]; got != "0-30" {
		t.Fatalf("aging bucket = %v, want 0-30 (48h past due = 2 whole days)", got)
	}

	// a foreign-org id answers 404 — existence never leaks across orgs
	other := seedReceivable(t, pool, seedWorld(t, pool).OrgID, "KES", 1_00, time.Now(), false)
	status, body = call(t, server, "GET", "/v1/receivables/"+other, w.AdminToken, nil)
	wantError(t, status, body, 404, "HTTP_RECEIVABLE_NOT_FOUND")

	// an unknown but well-formed id answers 404, never 500
	status, body = call(t, server, "GET", "/v1/receivables/00000000-0000-4000-8000-00000000000f", w.AdminToken, nil)
	wantError(t, status, body, 404, "HTTP_RECEIVABLE_NOT_FOUND")
}
