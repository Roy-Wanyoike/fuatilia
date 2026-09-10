package scheduler

// REAL-PG integration tests (store.go + jobs.go executed against the private
// PostgreSQL 16.4 cluster, db/migrations 0001–0014): every job's end-to-end
// transitions, idempotency per run window through the durable
// idempotency_keys registry (0013), the FOR UPDATE SKIP LOCKED / guarded-UPDATE
// claim races, and the advisory-lock no-overlap discipline (AC1–AC3).
//
// Schema sources for the seeded shapes:
//      db/migrations/0003_customers_consent.sql  (consent_grants — the K2 gate)
//      db/migrations/0004_invoicing_receivables.sql (receivables, GENERATED balance)
//      db/migrations/0010_promises_plans.sql     (payment_plans + installments)
//      db/migrations/0013_audit_outbox.sql       (idempotency_keys, outbox_events)

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Compile-time: the Store is the production implementation of every job port.
var (
	_ DunningRepo = (*Store)(nil)
	_ LateFeeRepo = (*Store)(nil)
	_ PlanRepo    = (*Store)(nil)
	_ AgingRepo   = (*Store)(nil)
)

// --- seeding helpers (the real schema's minimum honest shapes) ---------------

var seqCounter atomic.Int64

func nextSeq() int64 { return seqCounter.Add(1) }

func seedOrg(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`,
		"Scheduler Org", fmt.Sprintf("sched-test-%d", nextSeq())).Scan(&id)
	if err != nil {
		t.Fatalf("seed org: %v", err)
	}
	return id
}

func seedCustomer(t *testing.T, pool *pgxpool.Pool, orgID string) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO customers (org_id, display_name, email) VALUES ($1::uuid, $2, $3) RETURNING id::text`,
		orgID, "Debitor Prime", "debitor@example.com").Scan(&id)
	if err != nil {
		t.Fatalf("seed customer: %v", err)
	}
	return id
}

// seedReceivable inserts invoice + line item (the frozen-sum trigger pair) and
// the receivable — the schema-honest debt row. Returns the receivable id.
func seedReceivable(t *testing.T, pool *pgxpool.Pool, orgID, customerID string, due time.Time, originalMinor, appliedMinor int64, state string, overdue bool) string {
	t.Helper()
	ctx := context.Background()
	// Schema-honest seeding order: lines are only insertable while the invoice
	// is a draft (INVOICE_LINES_FROZEN), so seed draft -> add the line -> issue.
	// Issuing requires the eTIMS number (ck_invoices_number_shape), unique per
	// org via the seed counter.
	var invoiceID string
	err := pool.QueryRow(ctx,
		`INSERT INTO invoices (org_id, customer_id, status, currency, total_minor, due_date)
         VALUES ($1::uuid, $2::uuid, 'draft', 'KES', $3, $4) RETURNING id::text`,
		orgID, customerID, originalMinor, due).Scan(&invoiceID)
	if err != nil {
		t.Fatalf("seed invoice: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO invoice_items (org_id, invoice_id, line_no, description, amount_minor, currency)
         VALUES ($1::uuid, $2::uuid, 1, 'consulting', $3, 'KES')`,
		orgID, invoiceID, originalMinor); err != nil {
		t.Fatalf("seed invoice item: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE invoices SET status = 'issued', invoice_number = $3, issued_at = now()
          WHERE org_id = $1::uuid AND id = $2::uuid`,
		orgID, invoiceID, fmt.Sprintf("INV%d", nextSeq())); err != nil {
		t.Fatalf("issue invoice: %v", err)
	}
	var receivableID string
	err = pool.QueryRow(ctx,
		`INSERT INTO receivables (org_id, invoice_id, customer_id, currency, original_minor, applied_minor, state, overdue, opened_at, due_date)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'KES', $4, $5, $6, $7, now(), $8) RETURNING id::text`,
		orgID, invoiceID, customerID, originalMinor, appliedMinor, state, overdue, due).Scan(&receivableID)
	if err != nil {
		t.Fatalf("seed receivable: %v", err)
	}
	return receivableID
}

func seedConsent(t *testing.T, pool *pgxpool.Pool, orgID, customerID, channel string, grantedAt time.Time) string {
	t.Helper()
	var id string
	err := pool.QueryRow(context.Background(),
		`INSERT INTO consent_grants (org_id, customer_id, channel, purpose, granted_at)
		 VALUES ($1::uuid, $2::uuid, $3::consent_channel, 'dunning', $4) RETURNING id::text`,
		orgID, customerID, channel, grantedAt).Scan(&id)
	if err != nil {
		t.Fatalf("seed consent grant: %v", err)
	}
	return id
}

type seedInstallment struct {
	No     int
	Due    time.Time // UTC midnight — due_date is a DATE column (0010)
	Amount int64
	State  string // scheduled | due | paid | missed | waived
	Paid   int64  // only legal on paid/missed/waived (ck_installments_paid_shape)
}

// seedPlan inserts an active plan + its schedule (Σ installments == total is
// COMMIT-proven by trg_installments_check_sum — a broken seed fails loudly).
func seedPlan(t *testing.T, pool *pgxpool.Pool, orgID, customerID, receivableID string, graceDays int, startedAt time.Time, installments []seedInstallment) string {
	t.Helper()
	ctx := context.Background()
	var total int64
	for _, inst := range installments {
		total += inst.Amount
	}
	// ONE transaction for the plan and its whole schedule: the H4 constraint
	// trigger proves Σ(installments) == plan total at each COMMIT, so the
	// schedule must land atomically (per-statement commits would trip it).
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("seed plan tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var planID string
	err = tx.QueryRow(ctx,
		`INSERT INTO payment_plans (org_id, customer_id, receivable_id, total_minor, currency, state, frequency, grace_days, started_at, sequence_no)
		 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'KES', 'active', 'monthly', $5, $6, $7) RETURNING id::text`,
		orgID, customerID, receivableID, total, graceDays, startedAt, nextSeq()).Scan(&planID)
	if err != nil {
		t.Fatalf("seed plan: %v", err)
	}
	for _, inst := range installments {
		if _, err := tx.Exec(ctx,
			`INSERT INTO installments (org_id, plan_id, installment_no, due_date, amount_minor, state, paid_minor)
			 VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7)`,
			orgID, planID, inst.No, inst.Due.Format("2006-01-02"), inst.Amount, inst.State, inst.Paid); err != nil {
			t.Fatalf("seed installment %d: %v", inst.No, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("seed plan commit: %v", err)
	}
	return planID
}

// --- row readers (the tables the effects land in) ---------------------------

type outboxRow struct {
	OrgID     string
	EventID   string
	EventType string
	Version   int
	Payload   map[string]any
	CreatedAt time.Time
}

func outboxRows(t *testing.T, pool *pgxpool.Pool) []outboxRow {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT org_id::text, event_id::text, event_type, version, payload::text, created_at
                   FROM outbox_events ORDER BY created_at, event_id`)
	if err != nil {
		t.Fatalf("read outbox: %v", err)
	}
	defer rows.Close()
	var out []outboxRow
	for rows.Next() {
		var r outboxRow
		var raw string
		if err := rows.Scan(&r.OrgID, &r.EventID, &r.EventType, &r.Version, &raw, &r.CreatedAt); err != nil {
			t.Fatalf("scan outbox row: %v", err)
		}
		if err := json.Unmarshal([]byte(raw), &r.Payload); err != nil {
			t.Fatalf("unmarshal payload: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read outbox rows: %v", err)
	}
	return out
}

func outboxCount(t *testing.T, pool *pgxpool.Pool, eventType string) int {
	t.Helper()
	n := 0
	for _, row := range outboxRows(t, pool) {
		if row.EventType == eventType {
			n++
		}
	}
	return n
}

type claimRow struct {
	Scope string
	Key   string
	Ref   string
}

func claimRows(t *testing.T, pool *pgxpool.Pool, orgID string) []claimRow {
	t.Helper()
	rows, err := pool.Query(context.Background(),
		`SELECT scope, key, outcome_ref FROM idempotency_keys WHERE org_id = $1::uuid ORDER BY scope, key`, orgID)
	if err != nil {
		t.Fatalf("read idempotency keys: %v", err)
	}
	defer rows.Close()
	var out []claimRow
	for rows.Next() {
		var r claimRow
		if err := rows.Scan(&r.Scope, &r.Key, &r.Ref); err != nil {
			t.Fatalf("scan claim row: %v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read claim rows: %v", err)
	}
	return out
}

func claimCount(t *testing.T, pool *pgxpool.Pool, orgID, scope string) int {
	t.Helper()
	n := 0
	for _, row := range claimRows(t, pool, orgID) {
		if row.Scope == scope {
			n++
		}
	}
	return n
}

// column reads for state assertions
func scalar(t *testing.T, pool *pgxpool.Pool, query string, args ...any) string {
	t.Helper()
	var s string
	err := pool.QueryRow(context.Background(), query, args...).Scan(&s)
	if err != nil {
		t.Fatalf("scalar %q: %v", query, err)
	}
	return s
}

// --- dunning job, end to end --------------------------------------------------

// The dunning job against the real schema: two email sends (K2-free) + one
// whatsapp refusal (no grant), each claimed first-write-wins in
// idempotency_keys with its outbox event appended in the same transaction; a
// same-tick re-run changes nothing; a late consent grant lets the whatsapp
// step through (its send key was never claimed — only the refusal key).
func TestStoreDunningJobEndToEnd(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-14T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	receivable := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-10T00:00:00.000Z"), 100_000, 0, "open", true)

	stats, err := RunDunning(ctx, store, clock, DefaultDunningLadder, 100)
	if err != nil {
		t.Fatalf("RunDunning: %v", err)
	}
	if stats.Scanned != 1 || stats.Claimed != 3 || stats.Emitted != 3 {
		t.Fatalf("stats = %+v, want 3 claimed+emitted (2 sends + 1 refusal)", stats)
	}
	if got := outboxCount(t, pool, "dunning.stepDue"); got != 2 {
		t.Fatalf("dunning.stepDue rows = %d, want 2", got)
	}
	if got := outboxCount(t, pool, "collections.dunningBlockedNoConsent"); got != 1 {
		t.Fatalf("refusal rows = %d, want 1", got)
	}
	if got := claimCount(t, pool, org, claimScopeDun); got != 3 {
		t.Fatalf("claims = %d, want 3", got)
	}

	// The refusal claim is a DIFFERENT key than the send claim (jobs.go):
	// exactly one blocked key, no whatsapp send key yet.
	var hasWhatsSend, hasWhatsBlocked bool
	for _, row := range claimRows(t, pool, org) {
		switch row.Key {
		case receivable + ":overdue_day_3":
			hasWhatsSend = true
		case receivable + ":blocked:overdue_day_3":
			hasWhatsBlocked = true
		}
	}
	if hasWhatsSend || !hasWhatsBlocked {
		t.Fatalf("claims = send:%v blocked:%v, want send:false blocked:true", hasWhatsSend, hasWhatsBlocked)
	}

	// Same tick re-run: claims hold, nothing new anywhere.
	stats, err = RunDunning(ctx, store, clock, DefaultDunningLadder, 100)
	if err != nil {
		t.Fatalf("same-tick re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Skipped != 1 {
		t.Fatalf("re-run stats = %+v, want the still-due refusal skipped silently", stats)
	}
	if got := len(outboxRows(t, pool)); got != 3 {
		t.Fatalf("re-run grew the outbox to %d rows, want 3", got)
	}

	// Consent granted late → the whatsapp step's send key is unclaimed, so the
	// next run pushes the send through (K2: never implied, always checkable).
	grant := seedConsent(t, pool, org, cust, "whatsapp", clock.At.Add(-24*time.Hour))
	ref, err := store.ConsentRef(ctx, org, cust, "whatsapp", clock.At)
	if err != nil || ref != grant {
		t.Fatalf("ConsentRef = %q, %v; want %q", ref, err, grant)
	}
	stats, err = RunDunning(ctx, store, clock, DefaultDunningLadder, 100)
	if err != nil {
		t.Fatalf("post-consent run: %v", err)
	}
	if stats.Emitted != 1 {
		t.Fatalf("post-consent stats = %+v, want the whatsapp send", stats)
	}
	if got := outboxCount(t, pool, "dunning.stepDue"); got != 3 {
		t.Fatalf("sends = %d, want 3 (the whatsapp step joined)", got)
	}

	// The whatsapp send's payload carries the step evidence, TS-shaped
	// (dunning.stepDue — promises/events.ts).
	for _, row := range outboxRows(t, pool) {
		if row.EventType != "dunning.stepDue" || row.Payload["stepKey"] != "overdue_day_3" {
			continue
		}
		if row.Version != 1 || row.OrgID != org {
			t.Fatalf("envelope = %+v", row)
		}
		if row.Payload["channel"] != "whatsapp" || row.Payload["requiresConsent"] != true ||
			row.Payload["dayOffset"] != float64(3) || row.Payload["dueDate"] != "2026-03-10T00:00:00.000Z" {
			t.Fatalf("payload = %v", row.Payload)
		}
	}
}

// The dunning subject scan horizon: a receivable due beyond the ladder's most
// negative offset (+1 day floor) is not scanned; one due exactly at the
// pre-due boundary gets its reminder.
func TestStoreDunningScanHorizon(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-14T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	far := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-19T00:00:00.000Z"), 100_000, 0, "open", false)  // 5 days out — beyond horizon
	near := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-17T00:00:00.000Z"), 100_000, 0, "open", false) // 3 days out — pre-due boundary

	subjects, err := store.DunningSubjects(ctx, clock.At.Add(dunningHorizon(DefaultDunningLadder)), 100)
	if err != nil {
		t.Fatalf("DunningSubjects: %v", err)
	}
	ids := map[string]bool{}
	for _, s := range subjects {
		ids[s.ReceivableID] = true
	}
	if ids[far] {
		t.Fatalf("receivable due beyond the horizon leaked into the scan")
	}
	if !ids[near] {
		t.Fatalf("pre-due boundary receivable missing from the scan")
	}

	// The pure filter agrees: the near subject is due exactly its pre_due
	// reminder, the far one nothing.
	steps, err := DueSteps(clock.At, DunningFacts{DueDate: mustTimeT("2026-03-17T00:00:00.000Z")}, DefaultDunningLadder)
	if err != nil {
		t.Fatalf("DueSteps: %v", err)
	}
	if len(steps) != 1 || steps[0].Key != "pre_due_reminder" {
		t.Fatalf("boundary steps = %+v, want only pre_due_reminder", steps)
	}
}

// --- late-fee job, end to end --------------------------------------------------

// The H4 guarantee against the real registry: one fee per (receivable,
// period) — the claim row and the receivable.lateFeeAccrued event commit
// together, a same-tick re-run charges nothing, and the next period accrues
// once. Amount pinned to late-fee.spec.ts's 333 bps on 123457 → 4111.
func TestStoreLateFeeJobEndToEnd(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	receivable := seedReceivable(t, pool, org, cust, mustTimeT("2026-02-01T00:00:00.000Z"), 123_457, 0, "open", true)

	policy := LateFeePolicy{Kind: LateFeePercent, PercentBps: intPtr(333), GraceDays: 5}
	stats, err := RunLateFee(ctx, store, clock, policy, 100)
	if err != nil {
		t.Fatalf("RunLateFee: %v", err)
	}
	if stats.Scanned != 1 || stats.Claimed != 1 || stats.Emitted != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	rows := outboxRows(t, pool)
	if len(rows) != 1 || rows[0].EventType != "receivable.lateFeeAccrued" {
		t.Fatalf("outbox = %+v", rows)
	}
	want := map[string]any{
		"receivableId": receivable, "periodKey": "2026-03", "amountMinor": float64(4111),
		"currency": "KES", "policyKind": "percent", "percentBps": float64(333),
		"balanceMinor": float64(123457), "daysLate": float64(40), "graceDays": float64(5),
		"posting": map[string]any{"debit": "ar_control", "credit": "fee_income"},
	}
	for key, wantVal := range want {
		gotVal, ok := rows[0].Payload[key]
		if !ok || fmt.Sprint(gotVal) != fmt.Sprint(wantVal) {
			t.Fatalf("payload[%q] = %v, want %v", key, gotVal, wantVal)
		}
	}

	// The claim row points back at the original event (0013 outcome_ref).
	claims := claimRows(t, pool, org)
	if len(claims) != 1 || claims[0].Scope != claimScopeFee || claims[0].Key != receivable+":2026-03" {
		t.Fatalf("claims = %+v", claims)
	}
	if claims[0].Ref != rows[0].EventID {
		t.Fatalf("outcome_ref = %s, want the event id %s", claims[0].Ref, rows[0].EventID)
	}

	// Same tick: no double charge.
	stats, err = RunLateFee(ctx, store, clock, policy, 100)
	if err != nil {
		t.Fatalf("re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Skipped != 1 {
		t.Fatalf("re-run stats = %+v", stats)
	}
	if len(outboxRows(t, pool)) != 1 {
		t.Fatalf("re-run doubled the fee")
	}

	// Next period (clock steps into April): exactly one new accrual.
	later := infra.FixedClock{At: mustTimeT("2026-04-02T00:00:00.000Z")}
	laterStore := NewStore(pool, later)
	stats, err = RunLateFee(ctx, laterStore, later, policy, 100)
	if err != nil {
		t.Fatalf("next period: %v", err)
	}
	if stats.Emitted != 1 {
		t.Fatalf("next period stats = %+v", stats)
	}
	if got := outboxCount(t, pool, "receivable.lateFeeAccrued"); got != 2 {
		t.Fatalf("period accruals = %d, want one per period", got)
	}

}

// The overdue scan is the honest superset: live debt only (open |
// partially_paid), positive GENERATED balance, overdue by flag OR strictly
// past due — settled and future rows never surface.
func TestStoreOverdueScanEligibility(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	live := seedReceivable(t, pool, org, cust, mustTimeT("2026-02-01T00:00:00.000Z"), 100_000, 0, "open", true)
	partPaid := seedReceivable(t, pool, org, cust, mustTimeT("2026-02-10T00:00:00.000Z"), 100_000, 40_000, "partially_paid", false) // past due, flag not yet stamped
	future := seedReceivable(t, pool, org, cust, mustTimeT("2026-06-01T00:00:00.000Z"), 100_000, 0, "open", false)
	settled := seedReceivable(t, pool, org, cust, mustTimeT("2026-01-01T00:00:00.000Z"), 50_000, 50_000, "settled", false)

	rows, err := store.OverdueReceivables(ctx, clock.At, 100)
	if err != nil {
		t.Fatalf("OverdueReceivables: %v", err)
	}
	ids := map[string]bool{}
	for _, row := range rows {
		ids[row.Like.ID] = true
	}
	if !ids[live] || !ids[partPaid] {
		t.Fatalf("live overdue rows missing: %v", ids)
	}
	if ids[future] || ids[settled] {
		t.Fatalf("ineligible rows surfaced: %v", ids)
	}
	for _, row := range rows {
		balance := row.Like.Original.Amount() - row.Like.Applied.Amount()
		if balance <= 0 {
			t.Fatalf("scanned receivable %s carries balance %d - the GENERATED column lied", row.Like.ID, balance)
		}
	}
}

// --- plan job, end to end ---------------------------------------------------

// The plan job's two transitions against the real schema: scheduled → due
// (FOR UPDATE SKIP LOCKED claim) and active → defaulted (guarded conditional
// UPDATE + event in one transaction). Day-N-counts boundary: an installment 10
// days late under a 10-day grace plan defaults; the re-run does nothing.
func TestStorePlanJobEndToEnd(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	rec := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-01T00:00:00.000Z"), 100_000, 0, "open", true)
	plan := seedPlan(t, pool, org, cust, rec, 10, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-03T00:00:00.000Z"), Amount: 5_000, State: "scheduled"}, // 10 days late — day N counts
		{No: 2, Due: mustTimeT("2026-04-01T00:00:00.000Z"), Amount: 5_000, State: "scheduled"}, // future
	})

	stats, err := RunPlan(ctx, store, clock, 100)
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}
	if stats.Scanned != 2 || stats.Claimed != 1 || stats.Emitted != 1 {
		t.Fatalf("stats = %+v, want 1 due advanced + 1 default", stats)
	}
	if got := scalar(t, pool,
		`SELECT state::text FROM installments WHERE org_id = $1::uuid AND plan_id = $2::uuid AND installment_no = 1`,
		org, plan); got != "due" {
		t.Fatalf("installment 1 state = %s, want due", got)
	}
	if got := scalar(t, pool,
		`SELECT state::text FROM installments WHERE org_id = $1::uuid AND plan_id = $2::uuid AND installment_no = 2`,
		org, plan); got != "scheduled" {
		t.Fatalf("installment 2 state = %s, want untouched scheduled", got)
	}
	if got := scalar(t, pool, `SELECT state::text FROM payment_plans WHERE id = $1::uuid`, plan); got != "defaulted" {
		t.Fatalf("plan state = %s, want defaulted", got)
	}
	defaults := outboxRows(t, pool)
	if len(defaults) != 1 || defaults[0].EventType != "paymentplan.defaulted" {
		t.Fatalf("outbox = %+v", defaults)
	}
	payload := defaults[0].Payload
	if payload["planId"] != plan || payload["installmentNo"] != float64(1) ||
		payload["daysOverdue"] != float64(10) || payload["defaultAfterDays"] != float64(10) {
		t.Fatalf("default payload = %v", payload)
	}

	// Re-run the same tick: the defaulted plan is dead to the job (state
	// guard), the advanced installment has left the scan — nothing happens.
	stats, err = RunPlan(ctx, store, clock, 100)
	if err != nil {
		t.Fatalf("re-run: %v", err)
	}
	if stats.Scanned != 0 || stats.Emitted != 0 {
		t.Fatalf("re-run stats = %+v, want a clean no-op", stats)
	}
	if len(outboxRows(t, pool)) != 1 {
		t.Fatalf("re-run emitted a second default")
	}
}

// The grace boundary through the real prefilter: an installment overdue by
// grace−1 days leaves the plan OUT of DefaultCandidates entirely (the scan's
// due_date <= today − grace_days prefilter agrees with the pure search —
// payment-plan.ts day-N-counts).
func TestStorePlanGraceBoundary(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	rec := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-01T00:00:00.000Z"), 100_000, 0, "open", true)
	earlyPlan := seedPlan(t, pool, org, cust, rec, 10, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-04T00:00:00.000Z"), Amount: 5_000, State: "scheduled"}, // 9 days late
	})
	latePlan := seedPlan(t, pool, org, cust, rec, 9, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-04T00:00:00.000Z"), Amount: 5_000, State: "scheduled"}, // 9 days late vs grace 9 — day N counts
	})

	if _, err := RunPlan(ctx, store, clock, 100); err != nil {
		t.Fatalf("RunPlan: %v", err)
	}
	if got := scalar(t, pool, `SELECT state::text FROM payment_plans WHERE id = $1::uuid`, earlyPlan); got != "active" {
		t.Fatalf("grace−1 plan defaulted (state %s), want active", got)
	}
	if got := scalar(t, pool, `SELECT state::text FROM payment_plans WHERE id = $1::uuid`, latePlan); got != "defaulted" {
		t.Fatalf("day-N plan not defaulted (state %s), want defaulted", got)
	}
	if got := outboxCount(t, pool, "paymentplan.defaulted"); got != 1 {
		t.Fatalf("default events = %d, want exactly the day-N plan's", got)
	}
}

// --- aging job, end to end ---------------------------------------------------

// The aging snapshot against the real schema: per-currency bucket totals with
// evidence refs (projections/aging.ts arAgingByBucket), zero-balance facts
// counted, claimed per (org, run window) — the same window never double-snapshots.
func TestStoreAgingJobEndToEnd(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	r1 := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-10T00:00:00.000Z"), 10_000, 0, "open", true)  // 3 days → 1-30
	r2 := seedReceivable(t, pool, org, cust, mustTimeT("2026-01-25T00:00:00.000Z"), 20_000, 0, "open", true)  // 47 days → 31-60
	r3 := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-13T00:00:00.000Z"), 30_000, 0, "open", false) // due now → current
	seedReceivable(t, pool, org, cust, mustTimeT("2025-01-01T00:00:00.000Z"), 50_000, 50_000, "settled", false)

	stats, err := RunAging(ctx, store, clock, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("RunAging: %v", err)
	}
	if stats.Scanned != 1 || stats.Claimed != 1 || stats.Emitted != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	rows := outboxRows(t, pool)
	if len(rows) != 1 || rows[0].EventType != "projections.agingSnapshotTaken" {
		t.Fatalf("outbox = %+v", rows)
	}
	if rows[0].Payload["orgId"] != org || rows[0].Payload["asOf"] != "2026-03-13T00:00:00.000Z" {
		t.Fatalf("identity = %v", rows[0].Payload)
	}
	if rows[0].Payload["receivablesAged"] != float64(3) || rows[0].Payload["zeroBalanceCount"] != float64(1) {
		t.Fatalf("counts = %v", rows[0].Payload)
	}
	currencies, ok := rows[0].Payload["currencies"].([]any)
	if !ok || len(currencies) != 1 {
		t.Fatalf("currencies = %v", rows[0].Payload["currencies"])
	}
	kES, _ := currencies[0].(map[string]any)
	if kES["currency"] != "KES" || kES["totalMinor"] != float64(60_000) || kES["receivableCount"] != float64(3) {
		t.Fatalf("KES view = %v", kES)
	}
	buckets := kES["bucketMinors"].(map[string]any)
	if buckets["current"] != float64(30_000) || buckets["1-30"] != float64(10_000) ||
		buckets["31-60"] != float64(20_000) || buckets["61-90"] != float64(0) || buckets["90+"] != float64(0) {
		t.Fatalf("buckets = %v", buckets)
	}
	refsAny, _ := rows[0].Payload["evidenceRefs"].([]any)
	var refs []string
	for _, ref := range refsAny {
		refs = append(refs, fmt.Sprint(ref))
	}
	sort.Strings(refs)
	wantRefs := []string{r1, r2, r3}
	sort.Strings(wantRefs)
	if len(refs) != 3 || fmt.Sprint(refs) != fmt.Sprint(wantRefs) {
		t.Fatalf("evidenceRefs = %v, want exactly the three live receivables", refs)
	}

	// Same window: the (org, window) claim holds — no double snapshot.
	stats, err = RunAging(ctx, store, clock, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("same-window re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Skipped != 1 {
		t.Fatalf("same-window stats = %+v", stats)
	}
	if len(outboxRows(t, pool)) != 1 {
		t.Fatalf("same window double-emitted")
	}

	// Next window: fresh claim, fresh snapshot.
	later := infra.FixedClock{At: mustTimeT("2026-03-14T00:00:00.000Z")}
	laterStore := NewStore(pool, later)
	stats, err = RunAging(ctx, laterStore, later, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("next window: %v", err)
	}
	if stats.Emitted != 1 {
		t.Fatalf("next window stats = %+v", stats)
	}
	if got := outboxCount(t, pool, "projections.agingSnapshotTaken"); got != 2 {
		t.Fatalf("windows = %d, want one snapshot per window", got)
	}
}

// --- concurrency: claims under race (AC3) -------------------------------------

// Two concurrent schedulers race AdvanceDueInstallments over the same
// schedule: FOR UPDATE SKIP LOCKED partitions the due installments — the
// union covers every due installment exactly once, and no row is advanced
// twice.
func TestStoreAdvanceDueSkipLockedRace(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	rec := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-01T00:00:00.000Z"), 100_000, 0, "open", true)
	seedPlan(t, pool, org, cust, rec, 30, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-01T00:00:00.000Z"), Amount: 1_000, State: "scheduled"},
		{No: 2, Due: mustTimeT("2026-03-05T00:00:00.000Z"), Amount: 1_000, State: "scheduled"},
		{No: 3, Due: mustTimeT("2026-03-09T00:00:00.000Z"), Amount: 1_000, State: "scheduled"},
		{No: 4, Due: mustTimeT("2026-03-11T00:00:00.000Z"), Amount: 1_000, State: "scheduled"},
		{No: 5, Due: mustTimeT("2026-03-13T00:00:00.000Z"), Amount: 1_000, State: "scheduled"}, // due today counts
	})

	const racers = 4
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	claimed := map[int]bool{}
	errs := make(chan error, racers)
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			rows, err := store.AdvanceDueInstallments(ctx, clock.At, 10)
			if err != nil {
				errs <- err
				return
			}
			mu.Lock()
			defer mu.Unlock()
			for _, d := range rows {
				if claimed[d.InstallmentNo] {
					errs <- fmt.Errorf("installment %d advanced twice", d.InstallmentNo)
					return
				}
				claimed[d.InstallmentNo] = true
			}
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("race: %v", err)
	}
	if len(claimed) != 5 {
		t.Fatalf("advanced %v, want all five installments exactly once", claimed)
	}
	var dueCount int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM installments WHERE org_id = $1::uuid AND state = 'due'`, org).Scan(&dueCount); err != nil {
		t.Fatalf("count due: %v", err)
	}
	if dueCount != 5 {
		t.Fatalf("rows in 'due' = %d, want 5", dueCount)
	}
}

// Two concurrent schedulers race DefaultPlan over the same active plan: the
// guarded UPDATE is the claim — exactly one wins, exactly one
// paymentplan.defaulted event exists, and the loser affects nothing.
func TestStoreDefaultPlanRace(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	rec := seedReceivable(t, pool, org, cust, mustTimeT("2026-03-01T00:00:00.000Z"), 100_000, 0, "open", true)
	plan := seedPlan(t, pool, org, cust, rec, 10, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-01T00:00:00.000Z"), Amount: 5_000, State: "scheduled"},
	})

	const racers = 8
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ev, err := newEvent("paymentplan.defaulted", plan, clock.Now(), PlanDefaultedPayload{
				PlanID: plan, CustomerID: cust, InstallmentNo: 1, DaysOverdue: 12, DefaultAfterDays: 10,
			})
			if err != nil {
				return
			}
			ok, err := store.DefaultPlan(ctx, org, plan, ev)
			if err != nil {
				return
			}
			mu.Lock()
			if ok {
				wins++
			}
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()
	if wins != 1 {
		t.Fatalf("default wins = %d, want exactly 1", wins)
	}
	if got := scalar(t, pool, `SELECT state::text FROM payment_plans WHERE id = $1::uuid`, plan); got != "defaulted" {
		t.Fatalf("plan state = %s", got)
	}
	if got := outboxCount(t, pool, "paymentplan.defaulted"); got != 1 {
		t.Fatalf("default events = %d, want 1", got)
	}
}

// The claim+emit primitive under race: N concurrent ClaimAndEmit calls on one
// (org, scope, key) — exactly one claim row and one outbox row ever exist
// (0013's first-write-wins, proven under -race).
func TestStoreClaimAndEmitRace(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	const racers = 16
	start := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	winners := 0
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			ev, err := newEvent("dunning.stepDue", jobSubjA, clock.Now(), DunningStepDuePayload{
				OrgID: org, SubjectID: jobSubjA, StepKey: "due_date_request", DayOffset: 0,
				Kind: KindPaymentRequest, Channel: ChannelEmail, DueDate: "2026-03-10T00:00:00.000Z",
			})
			if err != nil {
				return
			}
			claimed, err := store.ClaimAndEmit(ctx, org, claimScopeDun, jobSubjA+":due_date_request", ev.ID, ev)
			if err != nil {
				return
			}
			mu.Lock()
			if claimed {
				winners++
			}
			mu.Unlock()
		}()
	}
	close(start)
	wg.Wait()
	if winners != 1 {
		t.Fatalf("claim winners = %d, want exactly 1", winners)
	}
	if got := claimCount(t, pool, org, claimScopeDun); got != 1 {
		t.Fatalf("claim rows = %d, want 1", got)
	}
	if got := outboxCount(t, pool, "dunning.stepDue"); got != 1 {
		t.Fatalf("outbox rows = %d, want 1", got)
	}
}

// --- no-overlap per name: the advisory lock (AC3) ------------------------------

// AdvisoryLocker derives its key exactly like the store documents
// ("scheduler:<name>" through hashtextextended): a lock held through raw SQL
// on a separate connection makes the locker lose; release makes it win.
func TestAdvisoryLockerNoOverlap(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	locker := AdvisoryLocker{Pool: pool}

	release, acquired, err := locker.Lock(ctx, JobNameDunning)
	if err != nil || !acquired {
		t.Fatalf("first Lock: acquired=%v err=%v", acquired, err)
	}

	// The loser (a second scheduler process shape) skips — never queues.
	release2, acquired2, err := locker.Lock(ctx, JobNameDunning)
	if err != nil {
		t.Fatalf("second Lock errored: %v", err)
	}
	if acquired2 {
		t.Fatal("second Lock acquired while the first is held — overlap!")
	}
	if release2 != nil {
		t.Fatal("a lost lock must not return a release func")
	}

	// Distinct jobs hold distinct locks and run concurrently.
	release3, acquired3, err := locker.Lock(ctx, JobNameLateFee)
	if err != nil || !acquired3 {
		t.Fatalf("distinct-name Lock: acquired=%v err=%v", acquired3, err)
	}
	release3()

	// Release frees the name; a crash shape (context cancelled mid-job) still
	// releases — the unlock runs on a detached context.
	release()
	release() // idempotent release is safe
	release4, acquired4, err := locker.Lock(ctx, JobNameDunning)
	if err != nil || !acquired4 {
		t.Fatalf("Lock after release: acquired=%v err=%v", acquired4, err)
	}
	release4()
}

// A lock held through RAW SQL with the same key derivation blocks the locker —
// the cross-process discipline is PostgreSQL's, not Go's.
func TestAdvisoryLockerKeyMatchesRawSQL(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var ok bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, jobLockPrefix+JobNamePlan).Scan(&ok); err != nil {
		t.Fatalf("raw advisory lock: %v", err)
	}
	if !ok {
		t.Fatal("raw lock refused — test premise broken")
	}
	defer func() {
		_, _ = conn.Exec(context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, jobLockPrefix+JobNamePlan)
	}()

	locker := AdvisoryLocker{Pool: pool}
	if _, acquired, err := locker.Lock(ctx, JobNamePlan); err != nil || acquired {
		t.Fatalf("locker beat a raw held lock: acquired=%v err=%v", acquired, err)
	}
}

// --- the full runner loop over real PG ------------------------------------------

// The wired loop (Runner → Scheduler → AdvisoryLocker → Store) against real
// PostgreSQL: one RunOnce pass claims every due effect exactly once, and
// further cycles on the SAME tick (fixed clock, interval well under the
// observation window) change nothing — idempotent per run window (AC2),
// graceful shutdown returns nil (AC + scheduler.go contract).
func TestRunnerLoopOverRealPG(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	clock := infra.FixedClock{At: mustTimeT("2026-03-13T00:00:00.000Z")}
	store := NewStore(pool, clock)

	org := seedOrg(t, pool)
	cust := seedCustomer(t, pool, org)
	seedReceivable(t, pool, org, cust, mustTimeT("2026-03-03T00:00:00.000Z"), 100_000, 0, "open", true)
	// Dunning at day 10: pre_due_reminder + due_date_request + overdue_day_3
	// (blocked — no whatsapp consent) + overdue_day_7 → 4 dunning claims.

	cfg, err := ResolveConfig(Config{
		DunningInterval: 15 * time.Millisecond,
		LateFeeInterval: 15 * time.Millisecond,
		PlanInterval:    15 * time.Millisecond,
		AgingInterval:   15 * time.Millisecond,
		Batch:           100,
	})
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	runner, err := NewRunner(store, cfg, clock, quietLog())
	if err != nil {
		t.Fatalf("NewRunner: %v", err)
	}
	sched, err := New(runner.Jobs(), AdvisoryLocker{Pool: pool}, quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	if err := sched.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}

	// The first pass's exact effects: 3 sends + 1 refusal + 1 fee + 1 default
	// (the plan seeded below) + 1 snapshot = 7. Seed the plan and re-derive
	// deterministically instead: count by type.
	// (The receivable is also the plan's anchor; the plan defaults: installment
	// 1 is 12 days late under grace 5.)
	recID := scalar(t, pool,
		`SELECT id::text FROM receivables WHERE org_id = $1::uuid LIMIT 1`, org)
	seedPlan(t, pool, org, cust, recID, 5, mustTimeT("2026-02-01T00:00:00.000Z"), []seedInstallment{
		{No: 1, Due: mustTimeT("2026-03-01T00:00:00.000Z"), Amount: 5_000, State: "scheduled"},
		{No: 2, Due: mustTimeT("2026-04-01T00:00:00.000Z"), Amount: 5_000, State: "scheduled"},
	})

	// Fresh pass with the plan present: re-count from a clean slate to keep the
	// assertion exact — truncate the effects and re-run once.
	if _, err := pool.Exec(ctx, `TRUNCATE outbox_events, idempotency_keys`); err != nil {
		t.Fatalf("reset effects: %v", err)
	}
	if err := sched.RunOnce(ctx); err != nil {
		t.Fatalf("RunOnce with plan: %v", err)
	}
	wantCounts := map[string]int{
		"dunning.stepDue":                     3, // pre_due_reminder, due_date_request, overdue_day_7
		"collections.dunningBlockedNoConsent": 1, // overdue_day_3 whatsapp, no consent
		"receivable.lateFeeAccrued":           1, // day 10 > grace 5
		"paymentplan.defaulted":               1, // installment 12 days late
		"projections.agingSnapshotTaken":      1, // the org, this window
	}
	for eventType, want := range wantCounts {
		if got := outboxCount(t, pool, eventType); got != want {
			t.Fatalf("%s = %d, want %d", eventType, got, want)
		}
	}
	baseline := len(outboxRows(t, pool))
	if baseline != 7 {
		t.Fatalf("baseline events = %d, want 7", baseline)
	}
	if claims := claimRows(t, pool, org); len(claims) != 6 {
		t.Fatalf("claim rows = %d (%v), want 6 (dunning 4 + fee 1 + aging 1)", len(claims), claims)
	}

	// Re-run the same tick hard: ~10 full cycles per job on the frozen clock —
	// the claims make every cycle a no-op; the advisory lock makes them
	// mutually exclusive per name.
	runCtx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	if err := sched.Run(runCtx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := len(outboxRows(t, pool)); got != baseline {
		t.Fatalf("outbox grew from %d to %d across same-tick cycles — double effect!", baseline, got)
	}
	if got := len(claimRows(t, pool, org)); got != 6 {
		t.Fatalf("claim rows grew to %d across same-tick cycles", got)
	}
}
