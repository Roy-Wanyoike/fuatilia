package transport

import (
	"strconv"
	"strings"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// §38 pagination/sorting consistency (pagination.ts): strict boundaries,
// no clamping, whitelist sorting. Sorting by arbitrary client strings is
// exactly how you scan a database — every list resolves its sort column
// through the resource's whitelist map or refuses with HTTP_QUERY_INVALID.
const (
	defaultPageLimit = 20
	minPageLimit     = 1
	maxPageLimit     = 100
	maxCursorLength  = 512
)

// Pagination is the parsed `?limit=&cursor=` pair.
type Pagination struct {
	Limit  int
	Offset int // decoded from the opaque cursor (the reference cursor is the offset)
}

// parsePagination parses `?limit=&cursor=` — limit is an integer 1–100
// (default 20; `limit=1` and `limit=100` are legal, `0`/`101`/non-integers
// refuse), the cursor is an opaque ≤512-char token decoded as the offset
// into the deterministic order (invalid cursors refuse).
func parsePagination(query map[string]string) (Pagination, *infra.DomainError) {
	p := Pagination{Limit: defaultPageLimit}
	if raw, ok := query["limit"]; ok && strings.TrimSpace(raw) != "" {
		trimmed := strings.TrimSpace(raw)
		limit, err := strconv.Atoi(trimmed)
		if err != nil || trimmed != strconv.Itoa(limit) {
			return p, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'limit' must be an integer between 1 and 100", map[string]any{"limit": raw})
		}
		if limit < minPageLimit || limit > maxPageLimit {
			return p, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'limit' must be between 1 and 100, got "+itoa(int64(limit)), map[string]any{"limit": raw})
		}
		p.Limit = limit
	}
	if raw, ok := query["cursor"]; ok && strings.TrimSpace(raw) != "" {
		cursor := strings.TrimSpace(raw)
		if len(cursor) > maxCursorLength {
			head := cursor
			if len(head) > 12 {
				head = head[:12]
			}
			return p, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'cursor' exceeds 512 characters", map[string]any{"cursor": head + "…"})
		}
		offset, err := strconv.Atoi(cursor)
		if err != nil || cursor != strconv.Itoa(offset) || offset < 0 {
			return p, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'cursor' is not a valid page cursor", nil)
		}
		p.Offset = offset
	}
	return p, nil
}

// Sorting is the parsed `?sort=&order=` pair.
type Sorting struct {
	Column string // the whitelisted SQL column ("" = insertion order)
	Order  string // asc | desc
}

// parseSorting resolves `?sort=&order=` against the resource's
// field→column whitelist (order defaults asc; anything outside refuses).
func parseSorting(query map[string]string, whitelist map[string]string) (Sorting, *infra.DomainError) {
	s := Sorting{Order: "asc"}
	if raw, ok := query["sort"]; ok && strings.TrimSpace(raw) != "" {
		field := strings.TrimSpace(raw)
		column, known := whitelist[field]
		if !known {
			return s, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'sort' must be one of: "+whitelistNames(whitelist), map[string]any{"sort": raw})
		}
		s.Column = column
	}
	if raw, ok := query["order"]; ok && strings.TrimSpace(raw) != "" {
		candidate := strings.ToLower(strings.TrimSpace(raw))
		if candidate != "asc" && candidate != "desc" {
			return s, infra.NewDomainError(CodeQueryInvalid,
				"query parameter 'order' must be 'asc' or 'desc'", map[string]any{"order": raw})
		}
		s.Order = candidate
	}
	return s, nil
}

// whitelistNames renders the whitelist fields sorted (the refusal names the
// legal set deterministically).
func whitelistNames(whitelist map[string]string) string {
	names := make([]string, 0, len(whitelist))
	for field := range whitelist {
		names = append(names, field)
	}
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	out := ""
	for i, name := range names {
		if i > 0 {
			out += ", "
		}
		out += name
	}
	return out
}

// paginatedMeta is the consistent list-envelope meta:
// { pagination: { nextCursor, total } } — nextCursor is null when the page
// exhausted the ordered set.
func paginatedMeta(offset, limit, total int) map[string]any {
	var next any
	if offset+limit < total {
		next = strconv.Itoa(offset + limit)
	}
	return map[string]any{
		"pagination": map[string]any{
			"nextCursor": next,
			"total":      total,
		},
	}
}
