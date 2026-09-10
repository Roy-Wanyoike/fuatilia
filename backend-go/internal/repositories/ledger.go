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

// ---------------------------------------------------------------------------
// Read models (issue #132) — strictly READ-ONLY queries over the immutable
// fund truth (db/migrations/0008_ledger.sql: R3 append-only, R4 double
// entry). Nothing here writes; the posting flows own every ledger row.
// ---------------------------------------------------------------------------

// LedgerAccountRow is one chart-of-accounts row (org-scoped).
type LedgerAccountRow struct {
	ID        string
	OrgID     string
	Code      string
	Name      string
	Kind      string
	Currency  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

// LedgerAccountSort whitelists the /v1/ledger/accounts sort fields (a client
// string that is not a column is how you scan a database).
var LedgerAccountSort = map[string]string{
	"id":       "id",
	"code":     "code",
	"kind":     "kind",
	"currency": "currency",
}

// LedgerAccountsByOrg lists the org's accounts, paginated. Deterministic
// default order: insertion (created_at, id) — mirroring PaymentsByOrg.
func (s *Stores) LedgerAccountsByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]LedgerAccountRow, int, error) {
	if sortCol == "" {
		sortCol, order = "created_at", "asc"
	}
	rows, err := q.Query(ctx,
		`SELECT id::text, org_id::text, code, name, kind, currency, created_at, updated_at
		   FROM ledger_accounts WHERE org_id = $1
		  ORDER BY `+sortCol+` `+order+`, id LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("ledger accounts list", err)
	}
	defer rows.Close()
	out := []LedgerAccountRow{}
	for rows.Next() {
		var a LedgerAccountRow
		if err := rows.Scan(&a.ID, &a.OrgID, &a.Code, &a.Name, &a.Kind, &a.Currency, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, 0, scanErr("ledger account scan", err)
		}
		out = append(out, a)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("ledger accounts list", err)
	}
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM ledger_accounts WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("ledger accounts count", err)
	}
	return out, total, nil
}

// LedgerEntryLineRow is one journal LINE joined with its account — the
// line-grained read model /v1/ledger/entries serves.
type LedgerEntryLineRow struct {
	EntryID     string
	LineNo      int
	AccountID   string
	AccountCode string
	AccountKind string
	Direction   string
	AmountMinor int64
	Currency    string
	Source      string
	SourceRef   *string
	JournalRef  string
	PostedAt    time.Time
	ReversalOf  *string
}

// LedgerEntrySort whitelists the /v1/ledger/entries sort fields.
var LedgerEntrySort = map[string]string{
	"id":       "entry_id",
	"postedAt": "posted_at",
	"source":   "source",
}

// LedgerEntryLinesByOrg lists the org's journal lines, paginated. The
// deterministic default order is the append-only insertion order (posted_at,
// entry_id, line_no); every sort keeps entry_id + line_no as the tiebreak so
// a page boundary can never shuffle lines within an entry.
func (s *Stores) LedgerEntryLinesByOrg(ctx context.Context, q Querier, orgID, sortCol, order string, limit, offset int) ([]LedgerEntryLineRow, int, error) {
	if sortCol == "" {
		sortCol, order = "posted_at", "asc"
	}
	rows, err := q.Query(ctx,
		`SELECT e.entry_id::text, e.line_no, e.account_id::text, a.code, a.kind, e.direction,
		        e.amount_minor, e.currency, e.source, e.source_ref, e.journal_ref, e.posted_at, e.reversal_of::text
		   FROM ledger_entries e
		   JOIN ledger_accounts a ON a.org_id = e.org_id AND a.id = e.account_id
		  WHERE e.org_id = $1
		  ORDER BY `+sortCol+` `+order+`, e.entry_id, e.line_no LIMIT $2 OFFSET $3`,
		orgID, limit, offset)
	if err != nil {
		return nil, 0, scanErr("ledger entries list", err)
	}
	defer rows.Close()
	out := []LedgerEntryLineRow{}
	for rows.Next() {
		var l LedgerEntryLineRow
		if err := rows.Scan(&l.EntryID, &l.LineNo, &l.AccountID, &l.AccountCode, &l.AccountKind, &l.Direction,
			&l.AmountMinor, &l.Currency, &l.Source, &l.SourceRef, &l.JournalRef, &l.PostedAt, &l.ReversalOf); err != nil {
			return nil, 0, scanErr("ledger entry line scan", err)
		}
		out = append(out, l)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, scanErr("ledger entries list", err)
	}
	var total int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM ledger_entries WHERE org_id = $1`, orgID).Scan(&total); err != nil {
		return nil, 0, scanErr("ledger entries count", err)
	}
	return out, total, nil
}
