package application

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// ReceivablesQuery is the list route's parsed query.
type ReceivablesQuery struct {
	SortCol string // resolved, whitelisted column ("" = insertion order)
	Order   string // asc | desc
	Limit   int
	Offset  int
}

// ListReceivables is the org-scoped paginated receivable read model.
func (s *Services) ListReceivables(ctx context.Context, q repositories.Querier, orgID string, query ReceivablesQuery) ([]repositories.ReceivableRow, int, error) {
	return s.Stores.ReceivablesByOrg(ctx, q, orgID, query.SortCol, query.Order, query.Limit, query.Offset)
}

// GetReceivable loads one org-scoped receivable (foreign-org existence is
// never leaked).
func (s *Services) GetReceivable(ctx context.Context, q repositories.Querier, orgID, receivableID string) (repositories.ReceivableRow, error) {
	row, err := s.Stores.ReceivableByID(ctx, q, orgID, receivableID)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return repositories.ReceivableRow{}, infra.NewDomainError(CodeReceivableNotFound, "receivable "+receivableID+" does not exist", nil)
		}
		return repositories.ReceivableRow{}, err
	}
	return row, nil
}

// daysPastDue is the aging lane's whole-days-past-due math, floored and
// clamped at 0 (a partial late day is not yet a full day late).
func daysPastDue(dueDate, now time.Time) int {
	elapsed := now.UnixMilli() - dueDate.UnixMilli()
	if elapsed <= 0 {
		return 0
	}
	return int(math.Floor(float64(elapsed) / 86_400_000))
}

// agingBucket is the docs/02 bucket math: day 30 → '0-30', day 31 → '31-60',
// day 61 → '61-90', day 91 → '90+'.
func agingBucket(days int) string {
	switch {
	case days <= 30:
		return "0-30"
	case days <= 60:
		return "31-60"
	case days <= 90:
		return "61-90"
	default:
		return "90+"
	}
}

// AgingOf projects the aging view: a SETTLED receivable answers nil (the
// lane refuses to age settled money — nothing left to age).
func AgingOf(row repositories.ReceivableRow, now time.Time) (days int, bucket string, ok bool) {
	if row.State == "settled" {
		return 0, "", false
	}
	days = daysPastDue(row.DueDate, now)
	return days, agingBucket(days), true
}
