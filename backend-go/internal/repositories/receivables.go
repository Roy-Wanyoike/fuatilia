package repositories

import (
	"context"
	"time"
)

// ReceivableRow is the receivable read-model row (balance is GENERATED in
// the schema — original − applied, R1's structural face).
type ReceivableRow struct {
	ID                  string
	OrgID               string
	InvoiceID           string
	CustomerID          string
	Currency            string
	OriginalMinor       int64
	AppliedMinor        int64
	BalanceMinor        int64
	State               string
	Overdue             bool
	OpenedAt            *time.Time
	DueDate             time.Time
	SettledAt           *time.Time
	VoidedAt            *time.Time
	WriteOffReason      *string
	WriteOffApprovedBy  *string
	WriteOffAt          *time.Time
	UncollectibleReason *string
	UncollectibleAt     *time.Time
	RecoveredAt         *time.Time
	CreatedAt           time.Time
}

// scanner is the common Scan surface of pgx.Row and pgx.Rows.
type scanner interface {
	Scan(dest ...any) error
}

// scanReceivable reads one receivable row.
func scanReceivable(row scanner) (ReceivableRow, error) {
	var r ReceivableRow
	err := row.Scan(&r.ID, &r.OrgID, &r.InvoiceID, &r.CustomerID, &r.Currency,
		&r.OriginalMinor, &r.AppliedMinor, &r.BalanceMinor, &r.State, &r.Overdue,
		&r.OpenedAt, &r.DueDate, &r.SettledAt, &r.VoidedAt,
		&r.WriteOffReason, &r.WriteOffApprovedBy, &r.WriteOffAt,
		&r.UncollectibleReason, &r.UncollectibleAt, &r.RecoveredAt, &r.CreatedAt)
	if err != nil {
		return ReceivableRow{}, scanErr("receivable scan", err)
	}
	return r, nil
}

// receivableColumns is the SELECT projection shared by list and get (call
// sites append the FROM clause directly, so the SELECT keyword rides here).
const receivableColumns = `SELECT id, org_id, invoice_id, customer_id, currency, original_minor, applied_minor,
        balance_minor, state, overdue, opened_at, due_date, settled_at, voided_at,
        write_off_reason, write_off_approved_by, write_off_at, uncollectible_reason,
        uncollectible_at, recovered_at, created_at`

// ReceivableSort whitelists the list route's sort fields (anything else is a
// 400 HTTP_QUERY_INVALID — sorting by arbitrary client strings is how you
// scan a database).
var ReceivableSort = map[string]string{
	"id":      "id",
	"state":   "state",
	"dueDate": "due_date",
}

// ReceivablesByOrg lists the org's receivables in the deterministic order the
// offset cursor paginates (default: insertion order created_at, id).
func (s *Stores) ReceivablesByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]ReceivableRow, int, error) {
	if sortCol == "" {
		sortCol, order = "created_at", "asc"
	}
	rows, err := q.Query(ctx,
		receivableColumns+` FROM receivables WHERE org_id = $1 ORDER BY `+sortCol+` `+order+`, id LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("receivables list", err)
	}
	defer rows.Close()
	var out []ReceivableRow
	for rows.Next() {
		r, scanE := scanReceivable(rows)
		if scanE != nil {
			return nil, 0, scanE
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("receivables list", err)
	}
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM receivables WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("receivables count", err)
	}
	return out, total, nil
}

// ReceivableByID loads one org-scoped receivable (foreign-org ids answer
// not-found — existence never leaks across orgs).
func (s *Stores) ReceivableByID(ctx context.Context, q Querier, orgID, receivableID string) (ReceivableRow, error) {
	row := q.QueryRow(ctx, receivableColumns+` FROM receivables WHERE org_id = $1 AND id = $2`, orgID, receivableID)
	r, err := scanReceivable(row)
	return r, err
}

// ReceivablesExist verifies every id references an existing receivable in
// the org (the open-case boundary's referential check).
func (s *Stores) ReceivablesExist(ctx context.Context, q Querier, orgID string, ids []string) (bool, error) {
	var count int
	err := q.QueryRow(ctx,
		`SELECT count(*) FROM receivables WHERE org_id = $1 AND id = ANY($2::uuid[])`,
		orgID, ids).Scan(&count)
	if err != nil {
		return false, scanErr("receivables exist", err)
	}
	return count == len(ids), nil
}

// ReceivableIDsCoveredByOpenCases returns the open cases covering any of the
// given receivables — the R8 exclusivity guard's plain-data input.
func (s *Stores) ReceivableIDsCoveredByOpenCases(ctx context.Context, q Querier, orgID string, ids []string) (map[string]string, error) {
	rows, err := q.Query(ctx,
		`SELECT open_receivable_id::text, case_id::text
                   FROM collections_case_receivables
                  WHERE org_id = $1 AND open_receivable_id = ANY($2::uuid[])`,
		orgID, ids)
	if err != nil {
		return nil, scanErr("r8 coverage", err)
	}
	defer rows.Close()
	coverage := make(map[string]string)
	for rows.Next() {
		var receivableID, caseID string
		if err := rows.Scan(&receivableID, &caseID); err != nil {
			return nil, scanErr("r8 coverage scan", err)
		}
		coverage[receivableID] = caseID
	}
	return coverage, rows.Err()
}
