package repositories

import (
	"context"
	"time"
)

// Adjustments read model (issue #132) — strictly READ-ONLY over the
// adjustments tables (db/migrations/0007_adjustments.sql). The feed is the
// org's refund + credit-note truth as a discriminated union; nothing here
// writes. The aggregate lifecycles (R6 refund ceiling, R7 credit ceilings)
// are proven by the schema's deferrable triggers — this file only reads.

// AdjustmentRow is one feed row: a refund or a credit note of the org.
// Kind discriminates the union; the columns a kind does not carry are NULL.
type AdjustmentRow struct {
	Kind           string // 'credit_note' | 'refund'
	ID             string
	CreatedAt      time.Time
	State          string
	CustomerID     *string
	InvoiceID      *string
	PaymentID      *string
	RequestedBy    *string
	Reason         string
	TotalMinor     int64
	Currency       string
	ExternalRef    *string
	RejectedReason *string
	FailedReason   *string
	IssuedAt       *time.Time
	VoidedAt       *time.Time
}

// AdjustmentSort whitelists the /v1/adjustments sort fields.
var AdjustmentSort = map[string]string{
	"id":        "id",
	"kind":      "kind",
	"state":     "state",
	"createdAt": "created_at",
}

// AdjustmentsByOrg lists the org's adjustments feed, paginated: the org's
// credit notes and refunds as one deterministically ordered set (default
// order created_at, id — every sort keeps the unique id as the tiebreak).
// `requested_by` is the refunds table's requester (the credit-note side
// carries none — its draft has no requester concept, docs/05).
func (s *Stores) AdjustmentsByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]AdjustmentRow, int, error) {
	if sortCol == "" {
		sortCol, order = "created_at", "asc"
	}
	rows, err := q.Query(ctx,
		`SELECT * FROM (
		   SELECT 'credit_note' AS kind, id::text AS id, created_at AS created_at, state::text AS state,
		          customer_id::text AS customer_id, invoice_id::text AS invoice_id,
		          NULL::text AS payment_id, NULL::text AS requested_by,
		          reason AS reason, total_minor AS total_minor, currency AS currency,
		          NULL::text AS external_ref, NULL::text AS rejected_reason, NULL::text AS failed_reason,
		          issued_at AS issued_at, voided_at AS voided_at
		     FROM credit_notes WHERE org_id = $1
		   UNION ALL
		   SELECT 'refund' AS kind, id::text AS id, created_at AS created_at, state::text AS state,
		          NULL::text AS customer_id, NULL::text AS invoice_id,
		          payment_id::text AS payment_id, requested_by AS requested_by,
		          reason AS reason, total_minor AS total_minor, currency AS currency,
		          external_ref AS external_ref, rejected_reason AS rejected_reason, failed_reason AS failed_reason,
		          NULL::timestamptz AS issued_at, NULL::timestamptz AS voided_at
		     FROM refunds WHERE org_id = $1
		 ) feed
		  ORDER BY `+sortCol+` `+order+`, id LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("adjustments list", err)
	}
	defer rows.Close()
	out := []AdjustmentRow{}
	for rows.Next() {
		var a AdjustmentRow
		if err := rows.Scan(&a.Kind, &a.ID, &a.CreatedAt, &a.State, &a.CustomerID, &a.InvoiceID,
			&a.PaymentID, &a.RequestedBy, &a.Reason, &a.TotalMinor, &a.Currency,
			&a.ExternalRef, &a.RejectedReason, &a.FailedReason, &a.IssuedAt, &a.VoidedAt); err != nil {
			return nil, 0, scanErr("adjustment scan", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("adjustments list", err)
	}
	var total int
	if err := q.QueryRow(ctx,
		`SELECT (SELECT count(*) FROM credit_notes WHERE org_id = $1)
		      + (SELECT count(*) FROM refunds      WHERE org_id = $1)`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("adjustments count", err)
	}
	return out, total, nil
}

// NOTE on shape: the credit-note side also carries its lifecycle stamps
// (issued_at/voided_at) so the feed row is the WHOLE aggregate state.
