package repositories

import (
	"context"
	"time"
)

// PaymentRow is the fund-truth row (db/migrations/0005). confirmed_minor is
// set exactly ONCE; unapplied_minor is the maintained derivation the
// deferrable triggers prove at COMMIT.
type PaymentRow struct {
	ID             string
	OrgID          string
	CustomerID     *string
	Channel        string
	ExternalRef    string
	IdempotencyKey string
	State          string
	Currency       string
	RequestedMinor int64
	ConfirmedMinor *int64
	UnappliedMinor *int64
	DeclaredRefs   []string
	InitiatedAt    time.Time
	ConfirmedAt    *time.Time
	FailedAt       *time.Time
	FailureCode    *string
	ReversedAt     *time.Time
	ReversalReason *string
}

// AllocationRow is one append-only allocation posting against a payment.
type AllocationRow struct {
	ID           string
	ReceivableID string
	AmountMinor  int64
	Currency     string
	AllocatedAt  time.Time
}

// RefundRow is one refund reservation (R6's draw ledger).
type RefundRow struct {
	ID        string
	OrgID     string
	PaymentID string
	Amount    int64
	Currency  string
	Reason    string
	State     string
	CreatedAt time.Time
}

// paymentColumns is the SELECT projection shared by every payment lookup
// (call sites append the FROM clause directly, so the SELECT keyword rides
// here).
const paymentColumns = `SELECT id, org_id, customer_id, channel, external_ref, idempotency_key, state,
        currency, requested_minor, confirmed_minor, unapplied_minor, declared_refs,
        initiated_at, confirmed_at, failed_at, failure_code, reversed_at, reversal_reason`

func scanPayment(row scanner) (PaymentRow, error) {
	var p PaymentRow
	err := row.Scan(&p.ID, &p.OrgID, &p.CustomerID, &p.Channel, &p.ExternalRef, &p.IdempotencyKey,
		&p.State, &p.Currency, &p.RequestedMinor, &p.ConfirmedMinor, &p.UnappliedMinor,
		&p.DeclaredRefs, &p.InitiatedAt, &p.ConfirmedAt, &p.FailedAt, &p.FailureCode,
		&p.ReversedAt, &p.ReversalReason)
	if err != nil {
		return PaymentRow{}, scanErr("payment scan", err)
	}
	return p, nil
}

// PaymentSort whitelists the list route's sort fields.
var PaymentSort = map[string]string{
	"id":          "id",
	"state":       "state",
	"initiatedAt": "initiated_at",
}

// PaymentsByOrg lists the org's payments (deterministic order for the offset
// cursor: insertion order created_at, id).
func (s *Stores) PaymentsByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]PaymentRow, int, error) {
	if sortCol == "" {
		sortCol, order = "created_at", "asc"
	}
	rows, err := q.Query(ctx,
		paymentColumns+` FROM payments WHERE org_id = $1 ORDER BY `+sortCol+` `+order+`, id LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("payments list", err)
	}
	defer rows.Close()
	var out []PaymentRow
	for rows.Next() {
		p, scanE := scanPayment(rows)
		if scanE != nil {
			return nil, 0, scanE
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("payments list", err)
	}
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM payments WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("payments count", err)
	}
	return out, total, nil
}

// PaymentByID loads one org-scoped payment.
func (s *Stores) PaymentByID(ctx context.Context, q Querier, orgID, paymentID string) (PaymentRow, error) {
	row := q.QueryRow(ctx, paymentColumns+` FROM payments WHERE org_id = $1 AND id = $2`, orgID, paymentID)
	return scanPayment(row)
}

// PaymentByExternalRef loads one org payment by the Daraja transaction id.
func (s *Stores) PaymentByExternalRef(ctx context.Context, q Querier, orgID, channel, externalRef string) (PaymentRow, error) {
	row := q.QueryRow(ctx, paymentColumns+` FROM payments WHERE org_id = $1 AND channel = $2::payment_channel AND external_ref = $3`,
		orgID, channel, externalRef)
	return scanPayment(row)
}

// PaymentByIdempotencyKey loads one org payment by the R9 dedup key.
func (s *Stores) PaymentByIdempotencyKey(ctx context.Context, q Querier, orgID, key string) (PaymentRow, error) {
	row := q.QueryRow(ctx, paymentColumns+` FROM payments WHERE org_id = $1 AND idempotency_key = $2`, orgID, key)
	return scanPayment(row)
}

// InsertPayment persists a freshly initiated payment.
func (s *Stores) InsertPayment(ctx context.Context, q Querier, p PaymentRow) error {
	_, err := q.Exec(ctx,
		`INSERT INTO payments (id, org_id, customer_id, channel, external_ref, idempotency_key,
                                       state, currency, requested_minor, unapplied_minor, declared_refs, initiated_at)
                 VALUES ($1, $2, $3, $4::payment_channel, $5, $6, $7::payment_state, $8, $9, $10, $11, $12)`,
		p.ID, p.OrgID, p.CustomerID, p.Channel, p.ExternalRef, p.IdempotencyKey,
		p.State, p.Currency, p.RequestedMinor, p.UnappliedMinor, p.DeclaredRefs, p.InitiatedAt)
	return err
}

// ConfirmPayment advances the payment to confirmed — confirmed_minor is set
// exactly ONCE (the state⇔confirmed shape CHECK is the schema's guard).
func (s *Stores) ConfirmPayment(ctx context.Context, q Querier, orgID, paymentID string, confirmedMinor int64, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE payments
                    SET state = 'confirmed', confirmed_minor = $3, unapplied_minor = $3, confirmed_at = $4,
                        updated_at = now()
                  WHERE org_id = $1 AND id = $2`,
		orgID, paymentID, confirmedMinor, at)
	return err
}

// StagePaymentForConfirmation advances an initiated payment to
// pending_confirmation (the success callback may race the platform's
// awaiting-confirmation step — the lane's own awaitConfirmation transition).
func (s *Stores) StagePaymentForConfirmation(ctx context.Context, q Querier, orgID, paymentID string) error {
	_, err := q.Exec(ctx,
		`UPDATE payments SET state = 'pending_confirmation', updated_at = now()
                  WHERE org_id = $1 AND id = $2 AND state = 'initiated'`,
		orgID, paymentID)
	return err
}

// AllocationsForPayment lists the payment's live allocation rows.
func (s *Stores) AllocationsForPayment(ctx context.Context, q Querier, orgID, paymentID string) ([]AllocationRow, error) {
	rows, err := q.Query(ctx,
		`SELECT id::text, receivable_id::text, amount_minor, currency, allocated_at
                   FROM allocations
                  WHERE org_id = $1 AND source_type = 'payment' AND source_id = $2
                    AND reversed_at IS NULL
                  ORDER BY allocated_at, id`,
		orgID, paymentID)
	if err != nil {
		return nil, scanErr("allocations list", err)
	}
	defer rows.Close()
	var out []AllocationRow
	for rows.Next() {
		var a AllocationRow
		if err := rows.Scan(&a.ID, &a.ReceivableID, &a.AmountMinor, &a.Currency, &a.AllocatedAt); err != nil {
			return nil, scanErr("allocations scan", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RefundsForPayment lists the payment's refund reservations (R6 draws).
func (s *Stores) RefundsForPayment(ctx context.Context, q Querier, orgID, paymentID string) ([]RefundRow, error) {
	rows, err := q.Query(ctx,
		`SELECT id::text, payment_id::text, total_minor, currency, reason, state, created_at
                   FROM refunds WHERE org_id = $1 AND payment_id = $2
                  ORDER BY created_at, id`,
		orgID, paymentID)
	if err != nil {
		return nil, scanErr("refunds list", err)
	}
	defer rows.Close()
	var out []RefundRow
	for rows.Next() {
		var r RefundRow
		if err := rows.Scan(&r.ID, &r.PaymentID, &r.Amount, &r.Currency, &r.Reason, &r.State, &r.CreatedAt); err != nil {
			return nil, scanErr("refunds scan", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CommittedAgainstPayment sums Σ(active allocations) + Σ(live refunds) — the
// R6 ceiling's committed figure (rejected/failed refunds release their draw).
func (s *Stores) CommittedAgainstPayment(ctx context.Context, q Querier, orgID, paymentID string) (allocations int64, refunds int64, err error) {
	err = q.QueryRow(ctx,
		`SELECT
                   (SELECT COALESCE(SUM(amount_minor), 0) FROM allocations
                     WHERE org_id = $1 AND source_type = 'payment' AND source_id = $2
                       AND reversed_at IS NULL AND reversal_of IS NULL),
                   (SELECT COALESCE(SUM(total_minor), 0) FROM refunds
                     WHERE org_id = $1 AND payment_id = $2 AND state NOT IN ('rejected', 'failed'))`,
		orgID, paymentID).Scan(&allocations, &refunds)
	if err != nil {
		return 0, 0, scanErr("committed sum", err)
	}
	return allocations, refunds, nil
}

// InsertRefundReservation appends a refund reservation row (R6: the
// deferrable trg_refunds_check_r6 re-proves the ceiling at COMMIT).
func (s *Stores) InsertRefundReservation(ctx context.Context, q Querier, r RefundRow, requestedBy string) error {
	_, err := q.Exec(ctx,
		`INSERT INTO refunds (id, org_id, payment_id, requested_by, reason, state, total_minor, currency, created_at)
                 VALUES ($1, $2, $3, $4, $5, 'requested', $6, $7, $8)`,
		r.ID, r.OrgID, r.PaymentID, requestedBy, r.Reason, r.Amount, r.Currency, r.CreatedAt)
	return err
}
