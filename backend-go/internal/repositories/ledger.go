package repositories

import (
	"context"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// ledgerAccountCodes are the confirmation-entry chart lines the kernel
// ensures per org+currency before its first posting (deployer-seeded chart
// of accounts, idempotently materialized in the same transaction).
const (
	cashAccountPrefix = "cash-"
	arAccountPrefix   = "ar-"
	// ledgerSourcePayments is the posting_matrix source the confirmation
	// entry posts under.
	ledgerSourcePayments = "payments"
)

// EnsureConfirmationLedgerSeed makes sure the org's confirmation chart
// (asset cash + asset accounts-receivable accounts and the mapped
// (payments, asset → asset) matrix row) exists — idempotent, in-transaction,
// org-scoped. No posting ever lands on an unmapped pair (R5/K5).
func (s *Stores) EnsureConfirmationLedgerSeed(ctx context.Context, q Querier, orgID, currency string) error {
	if _, err := q.Exec(ctx,
		`INSERT INTO ledger_accounts (org_id, code, name, kind, currency)
		 VALUES ($1, $2, $3, 'asset', $4) ON CONFLICT (org_id, code) DO NOTHING`,
		orgID, cashAccountPrefix+currency, "Mobile Money Cash ("+currency+")", currency); err != nil {
		return err
	}
	if _, err := q.Exec(ctx,
		`INSERT INTO ledger_accounts (org_id, code, name, kind, currency)
		 VALUES ($1, $2, $3, 'asset', $4) ON CONFLICT (org_id, code) DO NOTHING`,
		orgID, arAccountPrefix+currency, "Accounts Receivable ("+currency+")", currency); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO posting_matrix (org_id, source, debit_kind, credit_kind)
		 VALUES ($1, $2, 'asset', 'asset') ON CONFLICT (org_id, source, debit_kind, credit_kind) DO NOTHING`,
		orgID, ledgerSourcePayments)
	return err
}

// PostConfirmationEntry posts the balanced double-entry for a confirmed
// payment: debit cash, credit accounts receivable — Σdebits == Σcredits in
// one currency (R4), proven at COMMIT by trg_ledger_entries_check_r4. The
// journal ref is the idempotent replay key (UNIQUE (org_id, journal_ref,
// line_no)): a re-confirmation can never double-post.
func (s *Stores) PostConfirmationEntry(ctx context.Context, q Querier, orgID, paymentID, externalRef, currency string, amountMinor int64, at time.Time) error {
	var cashID, arID string
	if err := q.QueryRow(ctx,
		`SELECT id::text FROM ledger_accounts WHERE org_id = $1 AND code = $2`,
		orgID, cashAccountPrefix+currency).Scan(&cashID); err != nil {
		return scanErr("cash account", err)
	}
	if err := q.QueryRow(ctx,
		`SELECT id::text FROM ledger_accounts WHERE org_id = $1 AND code = $2`,
		orgID, arAccountPrefix+currency).Scan(&arID); err != nil {
		return scanErr("ar account", err)
	}
	entryID := infra.NewUUID()
	journalRef := "payment_confirmed:" + paymentID
	if _, err := q.Exec(ctx,
		`INSERT INTO ledger_entries (org_id, entry_id, line_no, account_id, direction, amount_minor, currency, source, source_ref, journal_ref, posted_at)
		 VALUES ($1, $2, 1, $3, 'debit', $4, $5, $6, $7, $8, $9)`,
		orgID, entryID, cashID, amountMinor, currency, ledgerSourcePayments, externalRef, journalRef, at); err != nil {
		return err
	}
	_, err := q.Exec(ctx,
		`INSERT INTO ledger_entries (org_id, entry_id, line_no, account_id, direction, amount_minor, currency, source, source_ref, journal_ref, posted_at)
		 VALUES ($1, $2, 2, $3, 'credit', $4, $5, $6, $7, $8, $9)`,
		orgID, entryID, arID, amountMinor, currency, ledgerSourcePayments, externalRef, journalRef, at)
	return err
}

// LedgerEntryTotals sums the debits and credits of one journal entry — the
// R4 assertion the tests run after every confirmation.
func (s *Stores) LedgerEntryTotals(ctx context.Context, q Querier, orgID, journalRef string) (debits int64, credits int64, err error) {
	err = q.QueryRow(ctx,
		`SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'debit'), 0),
		        COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'credit'), 0)
		   FROM ledger_entries WHERE org_id = $1 AND journal_ref = $2`,
		orgID, journalRef).Scan(&debits, &credits)
	if err != nil {
		return 0, 0, scanErr("ledger totals", err)
	}
	return debits, credits, nil
}
