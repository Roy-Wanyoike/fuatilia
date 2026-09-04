package repositories

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// CaseRow is the collections-case row (db/migrations/0009). Identity fields
// are frozen after creation; status/priority/owner evolve through recorded
// decisions only.
type CaseRow struct {
	ID           string
	OrgID        string
	CaseNumber   string
	SequenceNo   int64
	Priority     string
	Status       string
	OwnerID      string
	OpenedAt     time.Time
	ClosedAt     *time.Time
	ClosedReason *string
}

// CaseActionLogRow is one append-only case_actions entry. The schema stores
// the audit honestly (who/what/when); the read model projects the wire view
// from the action marker + its jsonb detail.
type CaseActionLogRow struct {
	ID          string
	CaseID      string
	ActorID     string
	Action      string
	Detail      []byte
	PerformedAt time.Time
	SequenceNo  int64
}

// The append-only log's internal markers (never legal user-supplied action
// types — the taxonomy check refuses them at the wire). Exported because the
// application services append them and the transport view projects them.
const (
	LogOpened      = "case.opened"
	LogTransition  = "case.transition"
	LogEscalation  = "case.escalation"
	LogCompletion  = "case.completion"
	LogDunningHold = "collections.dunningBlockedNoConsent"
)

// CaseSort whitelists the case list route's sort fields.
var CaseSort = map[string]string{
	"id":         "id",
	"caseNumber": "case_number",
	"priority":   "priority",
	"status":     "status",
}

// caseColumns is the SELECT projection shared by list and get (call sites
// append the FROM clause directly, so the SELECT keyword rides here).
const caseColumns = `SELECT id, org_id, case_number, sequence_no, priority, status, owner_id, opened_at, closed_at, closed_reason`

func scanCase(row scanner) (CaseRow, error) {
	var c CaseRow
	err := row.Scan(&c.ID, &c.OrgID, &c.CaseNumber, &c.SequenceNo, &c.Priority, &c.Status,
		&c.OwnerID, &c.OpenedAt, &c.ClosedAt, &c.ClosedReason)
	if err != nil {
		return CaseRow{}, scanErr("case scan", err)
	}
	return c, nil
}

// CasesByOrg lists the org's cases ONLY (the list route's org scoping —
// foreign rows never leak) in deterministic cursor order.
func (s *Stores) CasesByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]CaseRow, int, error) {
	if sortCol == "" {
		sortCol, order = "created_at", "asc"
	}
	rows, err := q.Query(ctx,
		caseColumns+` FROM collections_cases WHERE org_id = $1 ORDER BY `+sortCol+` `+order+`, id LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("cases list", err)
	}
	defer rows.Close()
	var out []CaseRow
	for rows.Next() {
		c, scanE := scanCase(rows)
		if scanE != nil {
			return nil, 0, scanE
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("cases list", err)
	}
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM collections_cases WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("cases count", err)
	}
	return out, total, nil
}

// CaseByID loads one case scoped to the org (foreign-org ids answer
// not-found — existence is never leaked across orgs).
func (s *Stores) CaseByID(ctx context.Context, q Querier, orgID, caseID string) (CaseRow, error) {
	row := q.QueryRow(ctx, caseColumns+` FROM collections_cases WHERE org_id = $1 AND id = $2`, orgID, caseID)
	return scanCase(row)
}

// NextCaseSequence derives the org's controlled case sequence (advisory lock
// serializes concurrent opens so numbers are gapless and unique).
func (s *Stores) NextCaseSequence(ctx context.Context, q Querier, orgID string) (int64, error) {
	var next int64
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM collections_cases WHERE org_id = $1`, orgID).Scan(&next)
	if err != nil {
		return 0, scanErr("case sequence", err)
	}
	return next, nil
}

// LockOrgCases takes the per-org case-sequence advisory lock (transaction
// scoped) so concurrent opens cannot race the sequence or R8 coverage check.
func (s *Stores) LockOrgCases(ctx context.Context, q Querier, orgID string) error {
	_, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "cases:"+orgID)
	return err
}

// LockCase takes the per-case advisory lock (transaction scoped) so case
// commands serialize: log sequence numbers stay gapless and the
// exactly-once completion check is race-free.
func (s *Stores) LockCase(ctx context.Context, q Querier, orgID, caseID string) error {
	_, err := q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "case:"+orgID+":"+caseID)
	return err
}

// InsertCase persists the case row; the caller inserts the R8 links.
func (s *Stores) InsertCase(ctx context.Context, q Querier, c CaseRow) error {
	_, err := q.Exec(ctx,
		`INSERT INTO collections_cases (id, org_id, case_number, sequence_no, priority, status, owner_id, opened_at)
                 VALUES ($1, $2, $3, $4, $5::case_priority, $6::case_status, $7, $8)`,
		c.ID, c.OrgID, c.CaseNumber, c.SequenceNo, c.Priority, c.Status, c.OwnerID, c.OpenedAt)
	return err
}

// InsertCaseReceivable links one receivable into the case. The trg_case_rec_r8_marker
// trigger denormalizes openness into open_receivable_id; the partial UNIQUE
// index uq_r8_one_open_case_per_receivable is R8's structural backstop.
func (s *Stores) InsertCaseReceivable(ctx context.Context, q Querier, orgID, caseID, receivableID string) error {
	_, err := q.Exec(ctx,
		`INSERT INTO collections_case_receivables (org_id, case_id, receivable_id) VALUES ($1, $2, $3)`,
		orgID, caseID, receivableID)
	return err
}

// UpdateCaseStatus moves the case along its lifecycle (the stored status and
// the closing evidence move together).
func (s *Stores) UpdateCaseStatus(ctx context.Context, q Querier, orgID, caseID, status string, closedAt *time.Time, closedReason *string) error {
	tag, err := q.Exec(ctx,
		`UPDATE collections_cases
                    SET status = $3::case_status, closed_at = $4, closed_reason = $5, updated_at = now()
                  WHERE org_id = $1 AND id = $2`,
		orgID, caseID, status, nullTime(closedAt), closedReason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// UpdateCasePriority stamps an escalation's target priority.
func (s *Stores) UpdateCasePriority(ctx context.Context, q Querier, orgID, caseID, priority string) error {
	tag, err := q.Exec(ctx,
		`UPDATE collections_cases SET priority = $3::case_priority, updated_at = now()
                  WHERE org_id = $1 AND id = $2`,
		orgID, caseID, priority)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrNotFound
	}
	return nil
}

// NextCaseActionSequence derives the next log position for the case (the
// per-case advisory lock serializes concurrent appends).
func (s *Stores) NextCaseActionSequence(ctx context.Context, q Querier, orgID, caseID string) (int64, error) {
	var next int64
	err := q.QueryRow(ctx,
		`SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM case_actions WHERE org_id = $1 AND case_id = $2`,
		orgID, caseID).Scan(&next)
	if err != nil {
		return 0, scanErr("case action sequence", err)
	}
	return next, nil
}

// AppendCaseAction appends one sealed-log row (actor required, append-only —
// UPDATE/DELETE are rejected by trg_case_actions_guard). actionID is minted
// by the CALLER (the injected id source) so the wire action id, the outbox
// fact and the persisted row all name the SAME log entry — the completion
// route resolves its target by that id.
func (s *Stores) AppendCaseAction(ctx context.Context, q Querier, orgID, caseID, actionID, actorID, action string, detail map[string]any, performedAt time.Time, seq int64) error {
	payload, err := json.Marshal(orEmpty(detail))
	if err != nil {
		return infra.NewDomainError(infra.CodeInternal, "case action detail is not serializable", nil)
	}
	_, err = q.Exec(ctx,
		`INSERT INTO case_actions (id, org_id, case_id, actor_id, action, detail, performed_at, sequence_no)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
		actionID, orgID, caseID, actorID, action, string(payload), performedAt, seq)
	return err
}

// CaseActionLog lists the case's append-only log in recorded order.
func (s *Stores) CaseActionLog(ctx context.Context, q Querier, orgID, caseID string) ([]CaseActionLogRow, error) {
	rows, err := q.Query(ctx,
		`SELECT id::text, case_id::text, actor_id, action, detail, performed_at, sequence_no
                   FROM case_actions WHERE org_id = $1 AND case_id = $2
                  ORDER BY sequence_no`,
		orgID, caseID)
	if err != nil {
		return nil, scanErr("case action log", err)
	}
	defer rows.Close()
	var out []CaseActionLogRow
	for rows.Next() {
		var a CaseActionLogRow
		if err := rows.Scan(&a.ID, &a.CaseID, &a.ActorID, &a.Action, &a.Detail, &a.PerformedAt, &a.SequenceNo); err != nil {
			return nil, scanErr("case action log scan", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// FindCaseAction loads one log row by id (the completion route's target).
func (s *Stores) FindCaseAction(ctx context.Context, q Querier, orgID, caseID, actionID string) (CaseActionLogRow, error) {
	row := q.QueryRow(ctx,
		`SELECT id::text, case_id::text, actor_id, action, detail, performed_at, sequence_no
                   FROM case_actions WHERE org_id = $1 AND case_id = $2 AND id = $3`,
		orgID, caseID, actionID)
	var a CaseActionLogRow
	err := row.Scan(&a.ID, &a.CaseID, &a.ActorID, &a.Action, &a.Detail, &a.PerformedAt, &a.SequenceNo)
	if err != nil {
		return CaseActionLogRow{}, scanErr("case action lookup", err)
	}
	return a, nil
}

// CaseActionCompleted reports whether a completion row already stamps the
// action (the exactly-once completion rule's check).
func (s *Stores) CaseActionCompleted(ctx context.Context, q Querier, orgID, caseID, actionID string) (bool, error) {
	var done bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM case_actions
                  WHERE org_id = $1 AND case_id = $2 AND action = $3 AND detail->>'actionId' = $4)`,
		orgID, caseID, LogCompletion, actionID).Scan(&done)
	return done, err
}

func orEmpty(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}

// CaseHasPendingPromise reports whether any covered receivable carries a
// pending promise fact (the derive overlay's rule 3 — a pending promise
// holds the case at 'promised').
func (s *Stores) CaseHasPendingPromise(ctx context.Context, q Querier, orgID string, receivableIDs []string) (bool, error) {
	if len(receivableIDs) == 0 {
		return false, nil
	}
	var pending bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM promises
                  WHERE org_id = $1 AND receivable_id = ANY($2::uuid[])
                    AND state IN ('created', 'pending', 'partially_fulfilled'))`,
		orgID, receivableIDs).Scan(&pending)
	return pending, err
}

// ReceivableIDsForCase lists the case's linked receivables (the
// case.resolved / case.closed payload carries them — the lane's released /
// resolved coverage facts).
func (s *Stores) ReceivableIDsForCase(ctx context.Context, q Querier, orgID, caseID string) ([]string, error) {
	rows, err := q.Query(ctx,
		`SELECT receivable_id::text FROM collections_case_receivables
                  WHERE org_id = $1 AND case_id = $2
                  ORDER BY created_at, id`,
		orgID, caseID)
	if err != nil {
		return nil, scanErr("case receivables", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, scanErr("case receivables scan", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
