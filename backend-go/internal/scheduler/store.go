package scheduler

// PostgreSQL persistence for the scheduler jobs (db/migrations 0003/0004/0010/
// 0013 — the scheduler is a pure EXECUTOR over the existing schema: it adds no
// tables). The transactional shape restated:
//
//   - CLAIM + EMIT in ONE transaction: an effect is claimed first-write-wins
//     in idempotency_keys (0013's durable R9/C5 registry, UNIQUE (org_id,
//     scope, key)) and its outbox event is appended in the same transaction —
//     a crash between claim and event rolls both back, a re-run sees the claim
//     and skips. Re-running the same tick can never double an effect (AC2).
//   - Claiming with row locks: installment due advancement claims rows with
//     FOR UPDATE SKIP LOCKED (AC3); plan defaulting claims with a guarded
//     conditional UPDATE (state = 'active' — the row lock IS the claim, losers
//     affect 0 rows and skip).
//   - No job overlap per name: AdvisoryLocker holds a session-level
//     pg_try_advisory_lock keyed by the job name on a dedicated pooled
//     connection for the whole job body — a second scheduler loses the try
//     lock and skips its tick instead of blocking (AC3).
//
// Least-privilege footprint: SELECT on receivables/payment_plans/installments/
// consent_grants/orgs; INSERT on idempotency_keys + outbox_events; UPDATE on
// installments (state only) and payment_plans (state only). It never touches
// balances or money columns — financial truth stays with the lanes that own
// it (R1–R10).

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// Store executes scheduler scans, claims and event appends against
// PostgreSQL. All time flows through the injected clock — the store never
// reads the wall clock (deterministic tests step infra.Clock instead).
type Store struct {
	pool  *pgxpool.Pool
	clock infra.Clock
}

// NewStore wires a Store over the kernel's pool.
func NewStore(pool *pgxpool.Pool, clock infra.Clock) *Store {
	return &Store{pool: pool, clock: clock}
}

// DunningSubject is one live receivable the dunning job scans.
type DunningSubject struct {
	ReceivableID string
	OrgID        string
	CustomerID   string
	DueDate      time.Time
}

// LateFeeReceivableRow is one candidate receivable for accrual: the pure
// port's receivable slice plus the org root for claim scoping.
type LateFeeReceivableRow struct {
	OrgID string
	Like  LateFeeReceivableLike
}

// PlanRow is one active payment plan the expiry job scans.
type PlanRow struct {
	PlanID     string
	OrgID      string
	CustomerID string
	GraceDays  int
}

// DueInstallment is one installment the due-advancement claim moved
// scheduled → due.
type DueInstallment struct {
	OrgID         string
	PlanID        string
	InstallmentNo int
}

// Emitter is the shared claim+emit primitive: claim the (org, scope, key)
// first-write-wins and append the event, atomically. claimed=false means the
// key was already taken — the effect happened before, emit nothing.
type Emitter interface {
	ClaimAndEmit(ctx context.Context, orgID, scope, key, outcomeRef string, ev Event) (bool, error)
}

// DunningRepo is the dunning job's persistence port.
type DunningRepo interface {
	Emitter
	// DunningSubjects scans live receivables whose due date could carry due
	// steps (horizon is the generous pre-due window; the pure DueSteps filter
	// decides exactly).
	DunningSubjects(ctx context.Context, horizon time.Time, limit int) ([]DunningSubject, error)
	// ConsentRef resolves the K2 consent reference for one (customer, channel):
	// the id of the customer's active dunning grant on that channel, or "" when
	// none — consent is never implied (db/migrations/0003, the K2 gate lookup).
	ConsentRef(ctx context.Context, orgID, customerID, channel string, now time.Time) (string, error)
	// SentSteps returns which of the candidate send keys are already claimed —
	// the durable sentSteps idempotence set.
	SentSteps(ctx context.Context, orgID string, sendKeys []string) ([]string, error)
}

// LateFeeRepo is the late-fee job's persistence port.
type LateFeeRepo interface {
	Emitter
	// OverdueReceivables scans live, overdue, positive-balance receivables
	// (a superset; the pure AccrueLateFee eligibility ladder decides exactly).
	OverdueReceivables(ctx context.Context, now time.Time, limit int) ([]LateFeeReceivableRow, error)
}

// PlanRepo is the payment-plan job's persistence port.
type PlanRepo interface {
	Emitter
	// AdvanceDueInstallments claims scheduled installments whose due date has
	// arrived (FOR UPDATE SKIP LOCKED) and moves them to 'due'.
	AdvanceDueInstallments(ctx context.Context, now time.Time, limit int) ([]DueInstallment, error)
	// DefaultCandidates scans active plans with an unpaid installment whose
	// due date has crossed the grace window (a superset; the pure trigger
	// search decides exactly).
	DefaultCandidates(ctx context.Context, now time.Time, limit int) ([]PlanRow, error)
	// UnpaidInstallments lists a plan's unpaid installments in schedule order.
	UnpaidInstallments(ctx context.Context, orgID, planID string) ([]PlanInstallment, error)
	// DefaultPlan transitions active → defaulted under the state guard and
	// appends the paymentplan.defaulted event in the same transaction. false
	// means the plan was no longer active (raced) — nothing happened.
	DefaultPlan(ctx context.Context, orgID, planID string, ev Event) (bool, error)
}

// AgingRepo is the aging job's persistence port.
type AgingRepo interface {
	Emitter
	// SnapshotOrgs lists the orgs to snapshot (orgs with receivables).
	SnapshotOrgs(ctx context.Context, limit int) ([]string, error)
	// OrgAgingFacts reads one org's receivable facts in deterministic order
	// (the evidence order of the snapshot).
	OrgAgingFacts(ctx context.Context, orgID string) ([]AgingFact, error)
}

// dunningSubjectsSQL scans live receivables whose due date sits inside the
// pre-due window (a superset of DueSteps' exact selection — the pure filter
// is the gate, the scan is just bounded input).
const dunningSubjectsSQL = `
SELECT r.id::text, r.org_id::text, r.customer_id::text, r.due_date
  FROM receivables r
 WHERE r.state IN ('open', 'partially_paid')
   AND r.due_date <= $1
 ORDER BY r.due_date, r.id
 LIMIT $2`

// DunningSubjects implements DunningRepo.
func (s *Store) DunningSubjects(ctx context.Context, horizon time.Time, limit int) ([]DunningSubject, error) {
	rows, err := s.pool.Query(ctx, dunningSubjectsSQL, horizon, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: scan dunning subjects: %w", err)
	}
	defer rows.Close()
	var subjects []DunningSubject
	for rows.Next() {
		var sub DunningSubject
		if err := rows.Scan(&sub.ReceivableID, &sub.OrgID, &sub.CustomerID, &sub.DueDate); err != nil {
			return nil, fmt.Errorf("scheduler: scan dunning subject row: %w", err)
		}
		subjects = append(subjects, sub)
	}
	return subjects, rows.Err()
}

// consentRefSQL is the K2 dunning gate lookup documented on consent_grants
// (0003): a dunning message may only be sent under an ACTIVE grant on the
// step's channel — granted_at <= now < (revoked_at | expires_at | infinity).
const consentRefSQL = `
SELECT g.id::text
  FROM consent_grants g
 WHERE g.org_id = $1::uuid AND g.customer_id = $2::uuid
   AND g.channel = $3 AND g.purpose = 'dunning'
   AND g.revoked_at IS NULL
   AND g.granted_at <= $4
   AND (g.expires_at IS NULL OR g.expires_at > $4)
 ORDER BY g.granted_at DESC, g.id
 LIMIT 1`

// ConsentRef implements DunningRepo. Empty string = no live grant = the K2
// refusal DUNNING_CONSENT_REQUIRED (the pure gate treats blank as absent).
func (s *Store) ConsentRef(ctx context.Context, orgID, customerID, channel string, now time.Time) (string, error) {
	var ref string
	err := s.pool.QueryRow(ctx, consentRefSQL, orgID, customerID, channel, now).Scan(&ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("scheduler: consent lookup %s/%s/%s: %w", orgID, customerID, channel, err)
	}
	return ref, nil
}

// SentSteps implements DunningRepo: which of the candidate send keys are
// already claimed (the durable sentSteps set — 0013's first-write-wins
// registry is the scheduler's sent-steps ledger).
func (s *Store) SentSteps(ctx context.Context, orgID string, sendKeys []string) ([]string, error) {
	if len(sendKeys) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx,
		`SELECT key FROM idempotency_keys WHERE org_id = $1::uuid AND scope = $2 AND key = ANY($3)`,
		orgID, claimScopeDun, sendKeys)
	if err != nil {
		return nil, fmt.Errorf("scheduler: read sent steps org %s: %w", orgID, err)
	}
	defer rows.Close()
	var sent []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, fmt.Errorf("scheduler: scan sent step key: %w", err)
		}
		sent = append(sent, key)
	}
	return sent, rows.Err()
}

// overdueSQL scans the late-fee candidates: live debts (open |
// partially_paid — the schema's overdue flag only lives on live debt),
// positive balance (the GENERATED R1 column), and overdue by flag OR strictly
// past due. Grace-window and day-count eligibility are the pure port's
// refusal ladder, exactly as late-fee.ts decides them.
const overdueSQL = `
SELECT r.id::text, r.org_id::text, r.currency, r.due_date, r.overdue,
       r.original_minor, r.applied_minor, r.state
  FROM receivables r
 WHERE r.state IN ('open', 'partially_paid')
   AND r.balance_minor > 0
   AND (r.overdue OR r.due_date < $1)
 ORDER BY r.due_date, r.id
 LIMIT $2`

// OverdueReceivables implements LateFeeRepo.
func (s *Store) OverdueReceivables(ctx context.Context, now time.Time, limit int) ([]LateFeeReceivableRow, error) {
	rows, err := s.pool.Query(ctx, overdueSQL, now, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: scan overdue receivables: %w", err)
	}
	defer rows.Close()
	var out []LateFeeReceivableRow
	for rows.Next() {
		var row LateFeeReceivableRow
		var currency string
		var originalMinor, appliedMinor int64
		if err := rows.Scan(&row.Like.ID, &row.OrgID, &currency, &row.Like.DueDate, &row.Like.Overdue,
			&originalMinor, &appliedMinor, &row.Like.State); err != nil {
			return nil, fmt.Errorf("scheduler: scan overdue receivable row: %w", err)
		}
		row.Like.Currency = money.Currency(currency)
		original, err := money.New(originalMinor, row.Like.Currency)
		if err != nil {
			return nil, fmt.Errorf("scheduler: receivable %s original: %w", row.Like.ID, err)
		}
		applied, err := money.New(appliedMinor, row.Like.Currency)
		if err != nil {
			return nil, fmt.Errorf("scheduler: receivable %s applied: %w", row.Like.ID, err)
		}
		row.Like.Original = original
		row.Like.Applied = applied
		out = append(out, row)
	}
	return out, rows.Err()
}

// advanceDueSQL claims scheduled installments whose due date has arrived and
// moves them to 'due' in one statement: the CTE wins the rows with
// FOR UPDATE SKIP LOCKED (two schedulers never claim the same installment —
// the loser skips it), the UPDATE then advances exactly the claimed set.
// Active plans only: completed/defaulted/cancelled plans are dead to this job
// by construction. due_date is a DATE; the comparison uses the injected
// clock's UTC date as a literal so the session timezone cannot drift a
// boundary.
const advanceDueSQL = `
WITH due AS (
    SELECT i.id
      FROM installments i
      JOIN payment_plans p ON p.org_id = i.org_id AND p.id = i.plan_id
     WHERE p.state = 'active'
       AND i.state = 'scheduled'
       AND i.due_date <= $1::date
     ORDER BY i.due_date, i.id
     LIMIT $2
     FOR UPDATE OF i SKIP LOCKED
)
UPDATE installments i
   SET state = 'due'
  FROM due
 WHERE i.id = due.id
RETURNING i.org_id::text, i.plan_id::text, i.installment_no`

// AdvanceDueInstallments implements PlanRepo.
func (s *Store) AdvanceDueInstallments(ctx context.Context, now time.Time, limit int) ([]DueInstallment, error) {
	today := now.UTC().Format("2006-01-02")
	rows, err := s.pool.Query(ctx, advanceDueSQL, today, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: advance due installments: %w", err)
	}
	defer rows.Close()
	var out []DueInstallment
	for rows.Next() {
		var d DueInstallment
		if err := rows.Scan(&d.OrgID, &d.PlanID, &d.InstallmentNo); err != nil {
			return nil, fmt.Errorf("scheduler: scan due installment: %w", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// defaultCandidatesSQL scans active plans that MAY be defaultable: some
// unpaid installment's due date has crossed the plan's grace window
// (due_date <= today − grace_days). The day arithmetic is exact for midnight
// anchors (plans.go): daysLate >= N ⇔ due_date <= now.date − N — the scan
// prefilter and the pure trigger search agree on the boundary.
const defaultCandidatesSQL = `
SELECT p.id::text, p.org_id::text, p.customer_id::text, p.grace_days
  FROM payment_plans p
 WHERE p.state = 'active'
   AND EXISTS (
        SELECT 1 FROM installments i
         WHERE i.org_id = p.org_id AND i.plan_id = p.id
           AND i.state IN ('scheduled', 'due')
           AND i.paid_minor < i.amount_minor
           AND i.due_date <= ($1::date - p.grace_days))
 ORDER BY p.started_at, p.id
 LIMIT $2`

// DefaultCandidates implements PlanRepo.
func (s *Store) DefaultCandidates(ctx context.Context, now time.Time, limit int) ([]PlanRow, error) {
	today := now.UTC().Format("2006-01-02")
	rows, err := s.pool.Query(ctx, defaultCandidatesSQL, today, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: scan defaultable plans: %w", err)
	}
	defer rows.Close()
	var out []PlanRow
	for rows.Next() {
		var row PlanRow
		if err := rows.Scan(&row.PlanID, &row.OrgID, &row.CustomerID, &row.GraceDays); err != nil {
			return nil, fmt.Errorf("scheduler: scan plan row: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// UnpaidInstallments implements PlanRepo (schedule order — the trigger search
// needs the earliest unpaid installment).
func (s *Store) UnpaidInstallments(ctx context.Context, orgID, planID string) ([]PlanInstallment, error) {
	rows, err := s.pool.Query(ctx, `
SELECT i.installment_no, i.due_date, i.amount_minor, i.paid_minor
  FROM installments i
 WHERE i.org_id = $1::uuid AND i.plan_id = $2::uuid
   AND i.state IN ('scheduled', 'due')
   AND i.paid_minor < i.amount_minor
 ORDER BY i.installment_no`, orgID, planID)
	if err != nil {
		return nil, fmt.Errorf("scheduler: read installments of plan %s: %w", planID, err)
	}
	defer rows.Close()
	var out []PlanInstallment
	for rows.Next() {
		var inst PlanInstallment
		if err := rows.Scan(&inst.No, &inst.DueDate, &inst.AmountMinor, &inst.PaidMinor); err != nil {
			return nil, fmt.Errorf("scheduler: scan installment: %w", err)
		}
		out = append(out, inst)
	}
	return out, rows.Err()
}

// DefaultPlan implements PlanRepo: the guarded conditional UPDATE is the
// claim — active → defaulted atomically, then the event appends in the SAME
// transaction. A crash rolls both back; a racer's UPDATE affects 0 rows and
// nothing is emitted.
func (s *Store) DefaultPlan(ctx context.Context, orgID, planID string, ev Event) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("scheduler: begin default plan %s: %w", planID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE payment_plans SET state = 'defaulted'
          WHERE org_id = $1::uuid AND id = $2::uuid AND state = 'active'`,
		orgID, planID)
	if err != nil {
		return false, fmt.Errorf("scheduler: default plan %s: %w", planID, err)
	}
	if tag.RowsAffected() != 1 {
		return false, nil // lost the race (or already terminal) — nothing happened
	}
	if err := appendEventTx(ctx, tx, orgID, ev); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("scheduler: commit default plan %s: %w", planID, err)
	}
	return true, nil
}

// SnapshotOrgs implements AgingRepo: orgs with receivables, deterministic
// order.
func (s *Store) SnapshotOrgs(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT r.org_id::text FROM receivables r ORDER BY 1 LIMIT $1`, limit)
	if err != nil {
		return nil, fmt.Errorf("scheduler: scan snapshot orgs: %w", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, fmt.Errorf("scheduler: scan snapshot org: %w", err)
		}
		out = append(out, org)
	}
	return out, rows.Err()
}

// OrgAgingFacts implements AgingRepo: one org's receivable facts in
// deterministic (id) order — the snapshot's evidence order.
func (s *Store) OrgAgingFacts(ctx context.Context, orgID string) ([]AgingFact, error) {
	rows, err := s.pool.Query(ctx, `
SELECT r.id::text, r.currency, r.due_date, r.balance_minor
  FROM receivables r
 WHERE r.org_id = $1::uuid
 ORDER BY r.id`, orgID)
	if err != nil {
		return nil, fmt.Errorf("scheduler: read aging facts org %s: %w", orgID, err)
	}
	defer rows.Close()
	var out []AgingFact
	for rows.Next() {
		var fact AgingFact
		var currency string
		var balanceMinor int64
		if err := rows.Scan(&fact.ReceivableID, &currency, &fact.DueDate, &balanceMinor); err != nil {
			return nil, fmt.Errorf("scheduler: scan aging fact: %w", err)
		}
		fact.Currency = money.Currency(currency)
		balance, err := money.New(balanceMinor, fact.Currency)
		if err != nil {
			return nil, fmt.Errorf("scheduler: receivable %s balance: %w", fact.ReceivableID, err)
		}
		fact.Balance = balance
		out = append(out, fact)
	}
	return out, rows.Err()
}

// ClaimAndEmit implements Emitter for every job: INSERT the claim
// (ON CONFLICT DO NOTHING — first-write-wins per (org, scope, key)) and, only
// when this run won it, append the outbox event — ONE transaction, so the
// claim and its effect commit or roll back together (idempotency per run
// window, AC2). outcomeRef points back at the original outcome (the event id).
func (s *Store) ClaimAndEmit(ctx context.Context, orgID, scope, key, outcomeRef string, ev Event) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, fmt.Errorf("scheduler: begin claim %s/%s: %w", scope, key, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var claimed string
	err = tx.QueryRow(ctx,
		`INSERT INTO idempotency_keys (org_id, scope, key, outcome_ref)
         VALUES ($1::uuid, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING key`,
		orgID, scope, key, outcomeRef).Scan(&claimed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // already claimed — the effect exists, emit nothing
	}
	if err != nil {
		return false, fmt.Errorf("scheduler: claim %s/%s: %w", scope, key, err)
	}
	if err := appendEventTx(ctx, tx, orgID, ev); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, fmt.Errorf("scheduler: commit claim %s/%s: %w", scope, key, err)
	}
	return true, nil
}

// appendEventTx appends one domain event to outbox_events (0013) inside the
// open transaction: event_id/event_type/version/payload/created_at — the
// payload bytes are the TS payload shape VERBATIM, and created_at is the
// event's injected occurrence instant (never the DB wall clock, keeping runs
// deterministic).
func appendEventTx(ctx context.Context, tx pgx.Tx, orgID string, ev Event) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO outbox_events (org_id, event_id, event_type, version, payload, created_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)`,
		orgID, ev.ID, ev.Type, ev.Version, string(ev.Payload), ev.OccurredAt)
	if err != nil {
		return fmt.Errorf("scheduler: append event %s: %w", ev.Type, err)
	}
	return nil
}

// AdvisoryLocker is the production Locker: a session-level
// pg_try_advisory_lock keyed by "scheduler:<name>" held on a dedicated pooled
// connection for the whole job body. A second scheduler that loses the try
// lock skips its tick (never queues); a crashed holder's connection dies and
// PostgreSQL releases the lock. Distinct jobs hold distinct locks and run
// concurrently.
type AdvisoryLocker struct {
	Pool *pgxpool.Pool
}

// Lock implements Locker.
func (l AdvisoryLocker) Lock(ctx context.Context, name string) (func(), bool, error) {
	conn, err := l.Pool.Acquire(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("scheduler: acquire lock connection for %s: %w", name, err)
	}
	var ok bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, jobLockPrefix+name).Scan(&ok); err != nil {
		conn.Release()
		return nil, false, fmt.Errorf("scheduler: advisory lock %s: %w", name, err)
	}
	if !ok {
		conn.Release()
		return nil, false, nil
	}
	released := false
	return func() {
		if released {
			return
		}
		released = true
		// The unlock runs on a detached context: shutdown must never skip the
		// release (a held session lock would outlive the job).
		_, _ = conn.Exec(context.Background(),
			`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, jobLockPrefix+name)
		conn.Release()
	}, true, nil
}
