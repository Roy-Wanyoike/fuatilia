// The Daraja outbound wiring stores (issue #178): the stk_initiations
// merchant record the STK result callback routes on, and the DURABLE
// JourneyLedger behind the R9 intake funnel (daraja.IntakeCallback). Plus
// the payments lane's one missing transition — FailPayment — which the STK
// result callback needs to settle a refused/abandoned push. Every query is
// org-scoped EXCEPT the checkout-id router: the rail-minted
// CheckoutRequestID is globally unique (uq_stk_initiations_checkout) and is
// the ONLY field a callback carries to route by.
package repositories

import (
	"context"
	"time"
)

// StkInitiationRow is the E11 merchant record for one live/settled push.
type StkInitiationRow struct {
	ID                string
	OrgID             string
	ActionID          string
	CheckoutRequestID string
	MerchantRequestID string
	CustomerID        *string
	IdempotencyKey    string
	RequestedMinor    int64
	Currency          string
	State             string
	InitiatedAt       time.Time
	ResolvedAt        *time.Time
	ResolvedLate      *bool
	FailureCode       *string
}

const stkInitiationColumns = `SELECT id::text, org_id::text, action_id, checkout_request_id, merchant_request_id,
       customer_id::text, idempotency_key, requested_minor, currency, state, initiated_at, resolved_at, resolved_late, failure_code
  FROM stk_initiations`

func scanStkInitiation(row scanner) (StkInitiationRow, error) {
	var r StkInitiationRow
	err := row.Scan(&r.ID, &r.OrgID, &r.ActionID, &r.CheckoutRequestID, &r.MerchantRequestID,
		&r.CustomerID, &r.IdempotencyKey, &r.RequestedMinor, &r.Currency, &r.State,
		&r.InitiatedAt, &r.ResolvedAt, &r.ResolvedLate, &r.FailureCode)
	if err != nil {
		return StkInitiationRow{}, scanErr("stk initiation scan", err)
	}
	return r, nil
}

// StkInitiationByCheckout resolves a callback's (org, amount, customer) by
// the rail-minted checkout id. GLOBALLY unique by DDL — the one deliberate
// cross-tenant router (the callback carries nothing else).
func (s *Stores) StkInitiationByCheckout(ctx context.Context, q Querier, checkoutRequestID string) (StkInitiationRow, error) {
	row := q.QueryRow(ctx, stkInitiationColumns+` WHERE checkout_request_id = $1`, checkoutRequestID)
	return scanStkInitiation(row)
}

// StkInitiationByID loads one org-scoped initiation (replay resolution).
func (s *Stores) StkInitiationByID(ctx context.Context, q Querier, orgID, id string) (StkInitiationRow, error) {
	row := q.QueryRow(ctx, stkInitiationColumns+` WHERE org_id = $1 AND id = $2`, orgID, id)
	return scanStkInitiation(row)
}

// StkInitiationByIdempotencyKey resolves the R9 retry path: the claimed
// key replays the ORIGINAL initiation instead of re-prompting.
func (s *Stores) StkInitiationByIdempotencyKey(ctx context.Context, q Querier, orgID, key string) (StkInitiationRow, error) {
	row := q.QueryRow(ctx, stkInitiationColumns+` WHERE org_id = $1 AND idempotency_key = $2`, orgID, key)
	return scanStkInitiation(row)
}

// InsertStkInitiation appends the merchant record for an accepted push.
func (s *Stores) InsertStkInitiation(ctx context.Context, q Querier, r StkInitiationRow) error {
	_, err := q.Exec(ctx,
		`INSERT INTO stk_initiations (id, org_id, action_id, checkout_request_id, merchant_request_id,
                                              customer_id, idempotency_key, requested_minor, currency, state, initiated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		r.ID, r.OrgID, r.ActionID, r.CheckoutRequestID, r.MerchantRequestID,
		r.CustomerID, r.IdempotencyKey, r.RequestedMinor, r.Currency, r.State, r.InitiatedAt)
	return err
}

// ResolveStkInitiation settles the initiation exactly once (the state shape
// CHECK is the schema's guard): reconciled or failed, never re-resolved.
func (s *Stores) ResolveStkInitiation(ctx context.Context, q Querier, orgID, checkoutRequestID, state, failureCode string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE stk_initiations
                    SET state = $3, resolved_at = $4, resolved_late = FALSE, failure_code = $5, updated_at = now()
                  WHERE org_id = $1 AND checkout_request_id = $2 AND state = 'initiated'`,
		orgID, checkoutRequestID, state, at, nullText(failureCode))
	return err
}

// OrgExists reports whether the org row exists — the callback endpoints'
// :orgId router check (the URL segment is operator-configured, but a stale
// or foreign org id must never become a money event: fail closed, dead-letter).
func (s *Stores) OrgExists(ctx context.Context, q Querier, orgID string) (bool, error) {
	var exists bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM orgs WHERE id = $1)`, orgID).Scan(&exists)
	return exists, err
}

// JourneyClaim is the org-bound durable implementation of
// daraja.JourneyLedger: the (journey_key PRIMARY KEY) insert IS the atomic
// claim, and the stored amount is the K1 tamper tripwire. Bind one per
// request with the org the callback is being processed under.
type JourneyClaim struct {
	Stores *Stores
	OrgID  string
	Kind   string // 'stk-result' | 'c2b-confirmation' (the DDL's closed set)
}

// ClaimJourney implements daraja.JourneyLedger. The INSERT ... ON CONFLICT
// DO NOTHING is the winner election: under READ COMMITTED a concurrent
// duplicate blocks on the conflicting unique key until the first claim
// commits, so exactly one caller wins and every loser reads the COMMITTED
// prior amount (fail-closed tamper comparison — never a guessed verdict).
func (c JourneyClaim) ClaimJourney(ctx context.Context, journeyKey string, amountMinor int64) (bool, int64, error) {
	q := c.Stores.Pool
	tag, err := q.Exec(ctx,
		`INSERT INTO daraja_callback_journeys (journey_key, org_id, kind, amount_minor)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (journey_key) DO NOTHING`,
		journeyKey, c.OrgID, c.Kind, amountMinor)
	if err != nil {
		return false, 0, err
	}
	if tag.RowsAffected() == 1 {
		return true, 0, nil
	}
	var prior int64
	if err := q.QueryRow(ctx,
		`SELECT amount_minor FROM daraja_callback_journeys WHERE journey_key = $1`,
		journeyKey).Scan(&prior); err != nil {
		return false, 0, err
	}
	return false, prior, nil
}

// FailPayment advances an initiated/pending payment to failed — the STK
// result callback's abandonment transition (state 'failed' ⇔ failed_at is
// the schema's shape guard). The update is idempotent-in-effect: a payment
// already terminal never re-fails (the WHERE clause no-ops).
func (s *Stores) FailPayment(ctx context.Context, q Querier, orgID, paymentID, failureCode string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE payments
                    SET state = 'failed', failed_at = $4, failure_code = $3, updated_at = now()
                  WHERE org_id = $1 AND id = $2 AND state IN ('initiated', 'pending_confirmation')`,
		orgID, paymentID, failureCode, at)
	return err
}
