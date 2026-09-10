// Execute-path tests for the STK collections action (issue #178): the gate
// ladder, the R9 idempotency end-to-end, the wire-rejection record and the
// payments-funnel reconcile — REAL PostgreSQL, deterministic fake port
// (fakes live only in _test.go; the production adapter is exercised in the
// daraja package tests and the transport integration suite).
package application_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/daraja"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// fakeStkWire is the deterministic port double: scripted outcomes consumed
// in order, every dispatched command recorded for assertions.
type fakeStkWire struct {
	mu     sync.Mutex
	script []fakeStkOutcome
	cmds   []daraja.StkPushCommand
}

type fakeStkOutcome struct {
	receipt daraja.StkPushReceipt
	err     error
}

func (f *fakeStkWire) Initiate(_ context.Context, cmd daraja.StkPushCommand) (daraja.StkPushReceipt, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cmds = append(f.cmds, cmd)
	if len(f.script) == 0 {
		return daraja.StkPushReceipt{}, &daraja.Error{Code: "FAKE_SCRIPT_EXHAUSTED", Kind: daraja.KindConfig, Message: "the scripted fake has no outcome left"}
	}
	out := f.script[0]
	f.script = f.script[1:]
	return out.receipt, out.err
}

func (f *fakeStkWire) dispatched() []daraja.StkPushCommand {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]daraja.StkPushCommand{}, f.cmds...)
}

func (f *fakeStkWire) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.cmds)
}

func acceptedEcho(checkout string) fakeStkOutcome {
	return fakeStkOutcome{receipt: daraja.StkPushReceipt{
		MerchantRequestID: "58234-11940372-1",
		CheckoutRequestID: checkout,
		CustomerMessage:   "A payment request has been sent to the customer",
	}}
}

// stkWorld is one test's tenant state + wired services.
type stkWorld struct {
	Services   *application.Services
	Pool       *pgxpool.Pool
	OrgID      string
	CustomerID string
}

var stkWorldMu sync.Mutex

func bootStkWorld(t *testing.T) *stkWorld {
	t.Helper()
	ctx := context.Background()

	stkWorldMu.Lock()
	// The application lane owns its OWN database on the shared cluster: the
	// transport integration suite truncates fuatilia_api_test at boot AND
	// cleanup, and `go test ./...` runs packages concurrently — a shared row
	// space would let one package's truncate wipe the other's seed mid-run
	// (RequireSharedFor gives every truncating lane a named database).
	cluster, err := pgtest.RequireSharedFor(ctx, pgtest.ApplicationDBName)
	stkWorldMu.Unlock()
	if err != nil {
		t.Fatalf("pgtest: shared cluster bootstrap failed (the merge gate includes REAL PostgreSQL): %v", err)
	}
	databaseURL := cluster.DSN(pgtest.ApplicationDBName)
	if err := cluster.TruncateAll(ctx, pgtest.ApplicationDBName); err != nil {
		t.Fatalf("pgtest: truncate: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = cluster.TruncateAll(cleanupCtx, pgtest.ApplicationDBName)
	})

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool: %v", err)
	}
	t.Cleanup(pool.Close)

	orgID := mustStkExec(t, pool, `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`,
		"STK Org "+t.Name(), "stk-"+strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-"))[:24])
	customerID := mustStkExec(t, pool, `INSERT INTO customers (org_id, display_name, msisdn) VALUES ($1, $2, $3) RETURNING id::text`,
		orgID, "STK Customer "+t.Name(), "+254712345678")

	svc := &application.Services{
		Stores:  &repositories.Stores{Pool: pool},
		Clock:   infra.SystemClock{},
		IDs:     infra.NewUUID,
		Replays: infra.NewIDRegistry(),
	}
	return &stkWorld{Services: svc, Pool: pool, OrgID: orgID, CustomerID: customerID}
}

func mustStkExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) string {
	t.Helper()
	var out string
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&out); err != nil {
		t.Fatalf("seed %q: %v", sql, err)
	}
	return out
}

func stkCount(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

func validStkCommand(w *stkWorld) application.StkPushCommand {
	return application.StkPushCommand{
		ActionID:         "act-1",
		CustomerID:       w.CustomerID,
		AmountMinor:      250_000, // KES 2500.00
		Currency:         "KES",
		MSISDN:           "+254712345678",
		AccountReference: "INV104200042",
		TransactionDesc:  "Collection for INV-1042",
		ActorID:          "collector-1",
		Clearance: &application.StkClearance{
			Decision:        "allow",
			OrgID:           w.OrgID,
			MaxAmountMinor:  500_000,
			AllowedChannels: []string{"sms", "whatsapp"},
		},
	}
}

// The gate ladder: malformed/ungoverned attempts refuse BEFORE any port
// call, with the TS lane's STK_* vocabulary.
func TestExecuteStkPushGateRefusals(t *testing.T) {
	w := bootStkWorld(t)
	fake := &fakeStkWire{script: []fakeStkOutcome{acceptedEcho("ws_CO_12092025143105741")}}
	w.Services.StkPush = fake
	ctx := context.Background()

	cases := []struct {
		name string
		mut  func(*application.StkPushCommand)
		code string
	}{
		{"missing actor", func(c *application.StkPushCommand) { c.ActorID = "" }, "STK_ACTOR_INVALID"},
		{"missing action", func(c *application.StkPushCommand) { c.ActionID = "" }, "STK_ACTION_REQUIRED"},
		{"autonomy contradicts approval", func(c *application.StkPushCommand) {
			c.Autonomous = true
			c.ConsentRef = "consent-1"
			c.Clearance = nil
			c.Approval = &application.StkApproval{Ref: "app-1", ApproverID: "human-1"}
		}, "STK_AUTONOMY_MISMATCH"},
		{"non-KES currency", func(c *application.StkPushCommand) { c.Currency = "USD" }, "STK_CURRENCY_UNSUPPORTED"},
		{"zero amount", func(c *application.StkPushCommand) { c.AmountMinor = 0 }, "STK_AMOUNT_INVALID"},
		{"amount over the safe ceiling", func(c *application.StkPushCommand) { c.AmountMinor = 1 << 53 }, "STK_AMOUNT_INVALID"},
		{"unnormalizable msisdn", func(c *application.StkPushCommand) { c.MSISDN = "12345" }, "STK_MSISDN_INVALID"},
		{"long account reference", func(c *application.StkPushCommand) { c.AccountReference = "INVOICE20260042LONG" }, "STK_REFERENCE_INVALID"},
		{"blank description", func(c *application.StkPushCommand) { c.TransactionDesc = "   " }, "STK_REFERENCE_INVALID"},
		{"negative ttl", func(c *application.StkPushCommand) { c.TTL = -time.Second }, "STK_TTL_INVALID"},
		{"no clearance and no approval", func(c *application.StkPushCommand) { c.Clearance = nil }, "STK_CLEARANCE_INVALID"},
		{"non-allow clearance", func(c *application.StkPushCommand) { c.Clearance.Decision = "requires_approval" }, "STK_CLEARANCE_INVALID"},
		{"foreign-org clearance", func(c *application.StkPushCommand) { c.Clearance.OrgID = "another-org" }, "STK_DECISION_MISMATCH"},
		{"amount over the grant", func(c *application.StkPushCommand) { c.Clearance.MaxAmountMinor = 100 }, "STK_CLEARANCE_AMOUNT_EXCEEDED"},
		{"channel forbidden by the grant", func(c *application.StkPushCommand) { c.Clearance.AllowedChannels = []string{"email"} }, "STK_CLEARANCE_CHANNEL_FORBIDDEN"},
		{"lapsed grant", func(c *application.StkPushCommand) {
			past := time.Now().Add(-time.Hour)
			c.Clearance.ExpiresAt = &past
		}, "STK_CLEARANCE_EXPIRED"},
	}
	for _, tc := range cases {
		cmd := validStkCommand(w)
		tc.mut(&cmd)
		_, err := w.Services.ExecuteStkPush(ctx, w.OrgID, cmd)
		if err == nil {
			t.Fatalf("%s: expected refusal", tc.name)
		}
		de, ok := infra.DomainErrorOf(err)
		if !ok {
			t.Fatalf("%s: expected *infra.DomainError, got %T", tc.name, err)
		}
		if tc.code != "" && de.Code != tc.code {
			t.Fatalf("%s: code = %s, want %s", tc.name, de.Code, tc.code)
		}
	}
	if fake.calls() != 0 {
		t.Fatalf("gates must refuse before the port, port calls = %d", fake.calls())
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM stk_initiations`); n != 0 {
		t.Fatalf("refusals must not write initiations, rows = %d", n)
	}

	// Autonomous without a consent reference: compliance refusal + fact.
	consentCmd := validStkCommand(w)
	consentCmd.Autonomous = true
	consentCmd.ConsentRef = ""
	_, err := w.Services.ExecuteStkPush(ctx, w.OrgID, consentCmd)
	if mustCode(err) != "STK_CONSENT_REQUIRED" {
		t.Fatalf("autonomous without consent: got %v", err)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'collections.stkPushRefused'`); n != 1 {
		t.Fatalf("consent refusal must be compliance-recorded, facts = %d", n)
	}

	// The missing-org probe (ExecuteStkPush with a blank org).
	if _, err := w.Services.ExecuteStkPush(ctx, "", validStkCommand(w)); mustCode(err) != "STK_ORG_REQUIRED" {
		t.Fatalf("missing org: expected STK_ORG_REQUIRED, got %v", err)
	}
}

func mustCode(err error) string {
	if de, ok := infra.DomainErrorOf(err); ok {
		return de.Code
	}
	return ""
}

// Happy path: gates pass, the port is dispatched with the R9 key and the
// E11/E.164 encodings, the initiation + key claim + fact commit together,
// and a retry REPLAYS the committed initiation without a second prompt.
func TestExecuteStkPushAcceptsAndIsRetrySafe(t *testing.T) {
	w := bootStkWorld(t)
	fake := &fakeStkWire{script: []fakeStkOutcome{acceptedEcho("ws_CO_12092025143105741")}}
	w.Services.StkPush = fake
	ctx := context.Background()

	cmd := validStkCommand(w)
	cmd.MSISDN = "0712 345-678" // any Kenyan shape normalizes + encodes
	result, err := w.Services.ExecuteStkPush(ctx, w.OrgID, cmd)
	if err != nil {
		t.Fatalf("ExecuteStkPush: %v", err)
	}
	if !result.Accepted || result.Replayed {
		t.Fatalf("first execution must be a fresh acceptance: %+v", result)
	}
	if result.Receipt.CheckoutRequestID != "ws_CO_12092025143105741" {
		t.Fatalf("receipt echo drift: %+v", result.Receipt)
	}
	if result.IdempotencyKey != "stkpush:act-1" {
		t.Fatalf("R9 initiation key drift: %q", result.IdempotencyKey)
	}
	cmds := fake.dispatched()
	if len(cmds) != 1 {
		t.Fatalf("port dispatch count = %d", len(cmds))
	}
	if cmds[0].MSISDN != "254712345678" {
		t.Fatalf("msisdn must encode to Daraja wire form, got %q", cmds[0].MSISDN)
	}
	if cmds[0].IdempotencyKey != "stkpush:act-1" {
		t.Fatalf("port command must carry the R9 key, got %q", cmds[0].IdempotencyKey)
	}
	if cmds[0].AmountMinor != 250_000 {
		t.Fatalf("port command amount drift: %d", cmds[0].AmountMinor)
	}

	if n := stkCount(t, w.Pool, `SELECT count(*) FROM stk_initiations WHERE org_id = $1 AND checkout_request_id = 'ws_CO_12092025143105741'`, w.OrgID); n != 1 {
		t.Fatalf("initiation row missing, rows = %d", n)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM idempotency_keys WHERE org_id = $1 AND scope = 'collections.stk' AND key = 'stkpush:act-1'`, w.OrgID); n != 1 {
		t.Fatalf("durable key claim missing, rows = %d", n)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'collections.stkPushInitiated' AND payload->>'checkoutRequestId' = 'ws_CO_12092025143105741'`); n != 1 {
		t.Fatalf("stkPushInitiated fact missing, facts = %d", n)
	}
	// The MSISDN is PII: it must never ride the event payload.
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM outbox_events WHERE payload::text LIKE '%254712345678%'`); n != 0 {
		t.Fatalf("the MSISDN leaked into an event payload")
	}

	// Retry the SAME action: the committed initiation replays, no second
	// prompt, no second row.
	replay, err := w.Services.ExecuteStkPush(ctx, w.OrgID, cmd)
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Accepted || !replay.Replayed {
		t.Fatalf("retry must replay: %+v", replay)
	}
	if replay.Receipt.CheckoutRequestID != result.Receipt.CheckoutRequestID {
		t.Fatalf("replay must return the SAME receipt: %+v", replay)
	}
	if fake.calls() != 1 {
		t.Fatalf("retry must not re-prompt, port calls = %d", fake.calls())
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM stk_initiations`); n != 1 {
		t.Fatalf("retry must not create money, initiation rows = %d", n)
	}
}

// A wire rejection is a RECORDED refusal (not an error): the attempt stays
// retryable, the fact lands, and a later attempt can still succeed.
func TestExecuteStkPushWireRejectionRecordsFact(t *testing.T) {
	w := bootStkWorld(t)
	fake := &fakeStkWire{script: []fakeStkOutcome{
		{err: &daraja.Error{Code: "DARAJA_AUTH_FAILED", Kind: daraja.KindAuth, Message: "oauth refused"}},
		acceptedEcho("ws_CO_12092025143109999"),
	}}
	w.Services.StkPush = fake
	ctx := context.Background()

	result, err := w.Services.ExecuteStkPush(ctx, w.OrgID, validStkCommand(w))
	if err != nil {
		t.Fatalf("wire rejection must not be a Go error: %v", err)
	}
	if result.Accepted || result.RejectionReason != "DARAJA_AUTH_FAILED" {
		t.Fatalf("rejection drift: %+v", result)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM outbox_events WHERE event_type = 'collections.stkPushNotInitiated' AND payload->>'reason' = 'DARAJA_AUTH_FAILED'`); n != 1 {
		t.Fatalf("pushNotInitiated fact missing, facts = %d", n)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM stk_initiations`); n != 0 {
		t.Fatalf("a rejected attempt must not write initiations, rows = %d", n)
	}

	retry, err := w.Services.ExecuteStkPush(ctx, w.OrgID, validStkCommand(w))
	if err != nil {
		t.Fatalf("retry after rejection: %v", err)
	}
	if !retry.Accepted || retry.Replayed {
		t.Fatalf("retry after a rejection is a FRESH attempt: %+v", retry)
	}
	if fake.calls() != 2 {
		t.Fatalf("port calls = %d, want 2", fake.calls())
	}
}

// A disabled port (no Daraja in this deployment) refuses execution.
func TestExecuteStkPushWithoutPortFailsClosed(t *testing.T) {
	w := bootStkWorld(t)
	_, err := w.Services.ExecuteStkPush(context.Background(), w.OrgID, validStkCommand(w))
	if mustCode(err) != "STK_WIRE_UNAVAILABLE" {
		t.Fatalf("nil port must refuse with STK_WIRE_UNAVAILABLE, got %v", err)
	}
}

// seedInitiation writes the E11 merchant record directly (the callback-side
// tests drive the settle path the way the transport hands it over).
func seedInitiation(t *testing.T, w *stkWorld, checkout, state string, requested int64, customerID string) string {
	t.Helper()
	var cust any
	if customerID != "" {
		cust = customerID
	}
	return mustStkExec(t, w.Pool, `INSERT INTO stk_initiations (org_id, action_id, checkout_request_id, merchant_request_id, customer_id, idempotency_key, requested_minor, currency, state)
                VALUES ($1, 'act-cb', $2, '58234-11940372-1', $3, 'stkpush:act-cb', $4, 'KES', $5) RETURNING id::text`,
		w.OrgID, checkout, cust, requested, state)
}

// The success settle: intake → confirm through the EXISTING payments core
// (state + fact + balanced ledger entry in one transaction), then the
// initiation resolves reconciled.
func TestReconcileStkResultConfirms(t *testing.T) {
	w := bootStkWorld(t)
	seedInitiation(t, w, "ws_CO_12092025143105741", "initiated", 250_000, w.CustomerID)

	result, err := w.Services.ReconcileStkResult(context.Background(), w.OrgID, application.StkReconcileCommand{
		CheckoutRequestID: "ws_CO_12092025143105741",
		Success:           true,
		ReceiptNumber:     "SBK81KZ9QF",
		HasPaid:           true,
		PaidMinor:         250_000,
	})
	if err != nil {
		t.Fatalf("ReconcileStkResult: %v", err)
	}
	if result.Duplicate || result.Failed {
		t.Fatalf("fresh success drift: %+v", result)
	}
	if result.Payment.State != "confirmed" || result.Payment.ConfirmedMinor == nil || *result.Payment.ConfirmedMinor != 250_000 {
		t.Fatalf("payment must be confirmed for the initiated amount: %+v", result.Payment)
	}
	if result.Payment.ExternalRef != "SBK81KZ9QF" {
		t.Fatalf("external ref must be the receipt, got %q", result.Payment.ExternalRef)
	}
	if result.Payment.IdempotencyKey != "daraja:stk:ws_CO_12092025143105741" {
		t.Fatalf("payment journey key drift: %q", result.Payment.IdempotencyKey)
	}
	if result.Payment.Channel != "stk" {
		t.Fatalf("channel drift: %q", result.Payment.Channel)
	}
	// The balanced ledger entry rode the confirm (R4).
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM ledger_entries le JOIN ledger_accounts la ON la.id = le.account_id WHERE la.org_id = $1`, w.OrgID); n == 0 {
		t.Fatalf("the confirmation must post its ledger entry")
	}
	if state := mustStkExec(t, w.Pool, `SELECT state FROM stk_initiations WHERE checkout_request_id = 'ws_CO_12092025143105741'`); state != "reconciled" {
		t.Fatalf("initiation must resolve reconciled, got %q", state)
	}
	// A second settle refuses fail-closed (the journey claim upstream is the
	// at-least-once guard; a direct double-settle never re-runs).
	_, err = w.Services.ReconcileStkResult(context.Background(), w.OrgID, application.StkReconcileCommand{
		CheckoutRequestID: "ws_CO_12092025143105741",
		Success:           true,
		ReceiptNumber:     "SBK81KZ9QF",
		HasPaid:           true,
		PaidMinor:         250_000,
	})
	if mustCode(err) != "STK_STATE_INVALID" {
		t.Fatalf("double settle must refuse, got %v", err)
	}
}

// The failure settle: the payment lands through intake then fails with the
// STK_* family code; the initiation resolves failed.
func TestReconcileStkResultFails(t *testing.T) {
	w := bootStkWorld(t)
	seedInitiation(t, w, "ws_CO_12092025144000202", "initiated", 250_000, w.CustomerID)

	result, err := w.Services.ReconcileStkResult(context.Background(), w.OrgID, application.StkReconcileCommand{
		CheckoutRequestID: "ws_CO_12092025144000202",
		Success:           false,
		FailureCode:       "STK_CANCELLED_BY_USER",
	})
	if err != nil {
		t.Fatalf("ReconcileStkResult: %v", err)
	}
	if !result.Failed {
		t.Fatalf("failure drift: %+v", result)
	}
	if result.Payment.State != "failed" || result.Payment.FailureCode == nil || *result.Payment.FailureCode != "STK_CANCELLED_BY_USER" {
		t.Fatalf("payment must fail with the STK family code: %+v", result.Payment)
	}
	if state := mustStkExec(t, w.Pool, `SELECT state FROM stk_initiations WHERE checkout_request_id = 'ws_CO_12092025144000202'`); state != "failed" {
		t.Fatalf("initiation must resolve failed, got %q", state)
	}
}

// The K1 money guard: success metadata disagreeing with the initiated
// amount refuses BEFORE anything is written.
func TestReconcileStkResultRefusesAmountMismatch(t *testing.T) {
	w := bootStkWorld(t)
	seedInitiation(t, w, "ws_CO_12092025145530103", "initiated", 250_000, w.CustomerID)

	_, err := w.Services.ReconcileStkResult(context.Background(), w.OrgID, application.StkReconcileCommand{
		CheckoutRequestID: "ws_CO_12092025145530103",
		Success:           true,
		ReceiptNumber:     "SBK81KZ9QF",
		HasPaid:           true,
		PaidMinor:         350_000,
	})
	if mustCode(err) != "STK_AMOUNT_MISMATCH" {
		t.Fatalf("tampered metadata must refuse with STK_AMOUNT_MISMATCH, got %v", err)
	}
	if n := stkCount(t, w.Pool, `SELECT count(*) FROM payments`); n != 0 {
		t.Fatalf("a refused callback must write nothing, payments = %d", n)
	}
}

// An unknown checkout routes to nothing: the settle refuses (the transport
// dead-letters it — the parser without an initiation record refuses first).
func TestReconcileStkResultUnknownCheckout(t *testing.T) {
	w := bootStkWorld(t)
	_, err := w.Services.ReconcileStkResult(context.Background(), w.OrgID, application.StkReconcileCommand{
		CheckoutRequestID: "ws_CO_99999999999999",
		Success:           false,
		FailureCode:       "STK_TIMEOUT",
	})
	if mustCode(err) != "STK_STATE_INVALID" {
		t.Fatalf("unknown checkout must refuse, got %v", err)
	}
}
