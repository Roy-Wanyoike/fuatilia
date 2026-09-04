package transport

import (
	"encoding/json"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// jsonNumber is the exact-number decode shape the kernel's body parser
// produces (json.Decoder.UseNumber) — money fields validate against it so a
// wire amount can never round through a float64 (R10).
type jsonNumber = interface{ String() string }

// isoOf renders an instant the way the TS views do (ISO-8601, millis).
func isoOf(t time.Time) string { return repositories.ISO(t) }

// isoPtr renders an optional instant (nil → null).
func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return repositories.ISO(*t)
}

// strOrNull renders an optional string ("" → null).
func strOrNull(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// --- serializable views (never a raw aggregate: no hashes, no secrets) ----

func userView(u repositories.UserRow) map[string]any {
	return map[string]any{
		"id":          u.ID,
		"orgId":       u.OrgID,
		"email":       u.Email,
		"username":    u.Username,
		"displayName": u.DisplayName,
		"status":      u.Status,
		"createdAt":   isoOf(u.CreatedAt),
	}
}

func roleView(r repositories.RoleRow) map[string]any {
	return map[string]any{
		"id":          r.ID,
		"orgId":       r.OrgID,
		"name":        r.Name,
		"permissions": r.Permissions,
	}
}

func grantView(g repositories.GrantRow) map[string]any {
	return map[string]any{
		"id":            g.ID,
		"orgId":         g.OrgID,
		"userId":        g.UserID,
		"roleId":        g.RoleID,
		"resourceId":    g.ResourceID,
		"grantedBy":     g.GrantedBy,
		"grantedAt":     isoOf(g.GrantedAt),
		"revokedAt":     isoPtr(g.RevokedAt),
		"revokedReason": g.RevokedReason,
	}
}

func keyView(k repositories.KeyRow) map[string]any {
	// NOTE: `secret` and `secretHash` are deliberately absent — they never
	// leave the process (SPEC §34).
	var expiresAt, lastUsedAt any
	if k.ExpiresAt != nil {
		expiresAt = isoOf(*k.ExpiresAt)
	}
	if k.LastUsedAt != nil {
		lastUsedAt = isoOf(*k.LastUsedAt)
	}
	scopes := k.Scopes
	if scopes == nil {
		scopes = []string{}
	}
	return map[string]any{
		"id":         k.ID,
		"orgId":      k.OrgID,
		"name":       k.Name,
		"prefix":     k.Prefix,
		"scopes":     scopes,
		"expiresAt":  expiresAt,
		"status":     k.Status,
		"createdAt":  isoOf(k.CreatedAt),
		"lastUsedAt": lastUsedAt,
	}
}

func sessionView(s repositories.SessionRow) map[string]any {
	return map[string]any{
		"id":          s.ID,
		"userId":      s.UserID,
		"orgId":       s.OrgID,
		"status":      s.Status,
		"createdAt":   isoOf(s.CreatedAt),
		"lastSeenAt":  isoOf(s.LastSeenAt),
		"endedAt":     isoPtr(s.EndedAt),
		"endedReason": s.EndedReason,
	}
}

// jsonMoney is the wire money shape: { minor, currency } with minor as a
// JSON number (the int64 encodes exactly — money never touches floats).
type jsonMoney struct {
	Minor    int64  `json:"minor"`
	Currency string `json:"currency"`
}

func receivableView(r repositories.ReceivableRow, now time.Time) map[string]any {
	var aging any
	if days, bucket, ok := application.AgingOf(r, now); ok {
		aging = map[string]any{"daysPastDue": days, "bucket": bucket}
	}
	var writeOff any
	if r.WriteOffAt != nil {
		writeOff = map[string]any{
			"reason":       r.WriteOffReason,
			"approvedBy":   r.WriteOffApprovedBy,
			"writtenOffAt": isoPtr(r.WriteOffAt),
		}
	}
	return map[string]any{
		"id":                  r.ID,
		"invoiceId":           r.InvoiceID,
		"customerId":          r.CustomerID,
		"currency":            r.Currency,
		"original":            jsonMoney{Minor: r.OriginalMinor, Currency: r.Currency},
		"applied":             jsonMoney{Minor: r.AppliedMinor, Currency: r.Currency},
		"balance":             jsonMoney{Minor: r.BalanceMinor, Currency: r.Currency}, // R1: the DB's generated column
		"state":               r.State,
		"overdue":             r.Overdue,
		"openedAt":            isoPtr(r.OpenedAt),
		"dueDate":             isoOf(r.DueDate),
		"settledAt":           isoPtr(r.SettledAt),
		"voidedAt":            isoPtr(r.VoidedAt),
		"writeOff":            writeOff,
		"uncollectibleReason": r.UncollectibleReason,
		"uncollectibleAt":     isoPtr(r.UncollectibleAt),
		"recoveredAt":         isoPtr(r.RecoveredAt),
		"aging":               aging,
	}
}

func allocationView(a repositories.AllocationRow) map[string]any {
	return map[string]any{
		"id":           a.ID,
		"receivableId": a.ReceivableID,
		"amount":       jsonMoney{Minor: a.AmountMinor, Currency: a.Currency},
		"recordedAt":   isoOf(a.AllocatedAt),
	}
}

func refundView(r repositories.RefundRow) map[string]any {
	return map[string]any{
		"id":         r.ID,
		"amount":     jsonMoney{Minor: r.Amount, Currency: r.Currency},
		"reason":     r.Reason,
		"recordedAt": isoOf(r.CreatedAt),
	}
}

// paymentView projects the fund truth with its posting rows. unapplied is
// the maintained derivation the DDL proves at COMMIT (the projection reads
// the column, it never re-derives money).
func paymentView(p repositories.PaymentRow, allocations []repositories.AllocationRow, refunds []repositories.RefundRow) map[string]any {
	unapplied := int64(0)
	if p.UnappliedMinor != nil {
		unapplied = *p.UnappliedMinor
	}
	var confirmed, customerID, failureCode, reversalReason any
	if p.ConfirmedMinor != nil {
		confirmed = jsonMoney{Minor: *p.ConfirmedMinor, Currency: p.Currency}
	}
	if p.CustomerID != nil {
		customerID = *p.CustomerID
	}
	if p.FailureCode != nil {
		failureCode = *p.FailureCode
	}
	if p.ReversalReason != nil {
		reversalReason = *p.ReversalReason
	}
	declaredRefs := p.DeclaredRefs
	if declaredRefs == nil {
		declaredRefs = []string{}
	}
	allocViews := []map[string]any{}
	for _, a := range allocations {
		allocViews = append(allocViews, allocationView(a))
	}
	refundViews := []map[string]any{}
	for _, r := range refunds {
		refundViews = append(refundViews, refundView(r))
	}
	return map[string]any{
		"id":             p.ID,
		"channel":        p.Channel,
		"externalRef":    p.ExternalRef,
		"idempotencyKey": p.IdempotencyKey,
		"customerId":     customerID,
		"state":          p.State,
		"currency":       p.Currency,
		"requested":      jsonMoney{Minor: p.RequestedMinor, Currency: p.Currency},
		"confirmed":      confirmed,
		"unapplied":      jsonMoney{Minor: unapplied, Currency: p.Currency},
		"declaredRefs":   declaredRefs,
		"allocations":    allocViews,
		"refunds":        refundViews,
		"initiatedAt":    isoOf(p.InitiatedAt),
		"confirmedAt":    isoPtr(p.ConfirmedAt),
		"failedAt":       isoPtr(p.FailedAt),
		"failureCode":    failureCode,
		"reversedAt":     isoPtr(p.ReversedAt),
		"reversalReason": reversalReason,
	}
}

// caseView projects the collections case read model: the stored lifecycle,
// the R8 coverage ids, the sealed action log projected from case_actions,
// the history/priority audit trails and the derived status overlay.
func caseView(c repositories.CaseRow, receivableIDs []string, log []repositories.CaseActionLogRow, pendingPromises bool) map[string]any {
	actions := []map[string]any{}
	history := []map[string]any{}
	priorityChanges := []map[string]any{}
	openedBy := ""
	var closedBy any
	for _, entry := range log {
		var detail map[string]any
		_ = json.Unmarshal(entry.Detail, &detail)
		switch entry.Action {
		case repositories.LogOpened:
			openedBy = entry.ActorID
		case repositories.LogTransition:
			to := detailString(detail, "to")
			history = append(history, map[string]any{
				"from":    detailString(detail, "from"),
				"to":      to,
				"reason":  detailString(detail, "reason"),
				"actorId": entry.ActorID,
				"at":      isoOf(entry.PerformedAt),
			})
			if to == "resolved" || to == "closed_inactive" {
				closedBy = entry.ActorID
			}
		case repositories.LogEscalation:
			priorityChanges = append(priorityChanges, map[string]any{
				"from":    detailString(detail, "from"),
				"to":      detailString(detail, "to"),
				"reason":  detailString(detail, "reason"),
				"actorId": entry.ActorID,
				"at":      isoOf(entry.PerformedAt),
			})
		case "call", "sms", "whatsapp", "letter", "fieldVisit", "escalation":
			actions = append(actions, actionView(entry, detail))
		}
	}
	if receivableIDs == nil {
		receivableIDs = []string{}
	}
	return map[string]any{
		"id":              c.ID,
		"caseNumber":      c.CaseNumber,
		"sequence":        c.SequenceNo,
		"orgId":           c.OrgID,
		"receivableIds":   receivableIDs,
		"collectorId":     c.OwnerID,
		"priority":        c.Priority,
		"status":          c.Status,
		"derivedStatus":   derivedStatusOf(c, pendingPromises),
		"openedAt":        isoOf(c.OpenedAt),
		"openedBy":        openedBy,
		"closedAt":        isoPtr(c.ClosedAt),
		"closedBy":        closedBy,
		"actions":         actions,
		"history":         history,
		"priorityChanges": priorityChanges,
	}
}

// actionView projects one sealed-log entry into the wire action shape.
func actionView(entry repositories.CaseActionLogRow, detail map[string]any) map[string]any {
	var outcome, completedAt, completedBy, consentRef any
	if v, ok := detail["outcome"]; ok {
		outcome = v
	}
	if v, ok := detail["completedAt"]; ok {
		completedAt = v
	}
	if v, ok := detail["completedBy"]; ok {
		completedBy = v
	}
	if v, ok := detail["consentRef"]; ok {
		consentRef = v
	}
	source := detailString(detail, "source")
	if source == "" {
		source = "manual"
	}
	return map[string]any{
		"id":           entry.ID,
		"type":         entry.Action,
		"scheduledFor": detailString(detail, "scheduledFor"),
		"outcome":      outcome,
		"completedAt":  completedAt,
		"completedBy":  completedBy,
		"consentRef":   consentRef,
		"source":       source,
		"actorId":      entry.ActorID,
		"recordedAt":   isoOf(entry.PerformedAt),
	}
}

// derivedStatusOf computes the WAITING/PROMISED overlay from the child
// facts the case read model consults (a pending promise holds the case at
// 'promised'; otherwise live cases are 'waiting'; terminal stays stored —
// the lane's deriveCaseStatus matrix, rules 1/3/4; disputes have no merged
// lane yet so rule 2 cannot fire).
func derivedStatusOf(c repositories.CaseRow, pendingPromises bool) string {
	if c.Status == "resolved" || c.Status == "closed_inactive" {
		return c.Status
	}
	if pendingPromises {
		return "promised"
	}
	return "waiting"
}

func detailString(detail map[string]any, key string) string {
	if detail == nil {
		return ""
	}
	v, _ := detail[key].(string)
	return v
}
