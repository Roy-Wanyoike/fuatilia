package application

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// Stable codes the collections surface produces (the port of
// src/domain/collections/{case,actions}.ts + the wire's 404s).
const (
	CodeCaseNotFound            = "HTTP_CASE_NOT_FOUND"
	CodeReceivableNotFound      = "HTTP_RECEIVABLE_NOT_FOUND"
	CodeCaseAlreadyOpen         = "CASE_ALREADY_OPEN"
	CodeCaseClosed              = "CASE_CLOSED"
	CodeCaseStatusInvalid       = "CASE_STATUS_INVALID"
	CodeCaseTransitionInvalid   = "CASE_TRANSITION_INVALID"
	CodeCasePriorityInvalid     = "CASE_PRIORITY_INVALID"
	CodeCaseEscalationInvalid   = "CASE_ESCALATION_INVALID"
	CodeCaseActionNotFound      = "CASE_ACTION_NOT_FOUND"
	CodeCaseActionAlreadyDone   = "CASE_ACTION_ALREADY_COMPLETED"
	CodeCaseActionTypeInvalid   = "CASE_ACTION_TYPE_INVALID"
	CodeCaseActionSourceInvalid = "CASE_ACTION_SOURCE_INVALID"
	CodeCaseReasonRequired      = "CASE_REASON_REQUIRED"
	CodeCaseActorRequired       = "CASE_ACTOR_REQUIRED"
	CodeCaseOutcomeRequired     = "CASE_OUTCOME_REQUIRED"
	CodeCaseScheduledForInvalid = "CASE_SCHEDULED_FOR_INVALID"
	CodeDunningConsentRequired  = "DUNNING_CONSENT_REQUIRED"
	CodeCaseReceivablesRequired = "CASE_RECEIVABLES_REQUIRED"
	CodeCaseReceivableDuplicate = "CASE_RECEIVABLE_DUPLICATE"
)

// casePriorities with their strict escalation rank (low < normal < high < urgent).
var casePriorities = map[string]int{"low": 0, "normal": 1, "high": 2, "urgent": 3}

// caseTransitions is the lifecycle edge table (terminal statuses take no edges).
var caseTransitions = map[string][]string{
	"open":            {"in_progress"},
	"in_progress":     {"resolved", "closed_inactive"},
	"resolved":        {},
	"closed_inactive": {},
}

// caseActionTypes is the action taxonomy; outboundTypes are the K2 consent
// gate's automated outbound sends.
var (
	caseActionTypes = map[string]bool{
		"call": true, "sms": true, "whatsapp": true,
		"letter": true, "fieldVisit": true, "escalation": true,
	}
	outboundTypes = map[string]bool{"sms": true, "whatsapp": true}
	actionSources = map[string]bool{"automated": true, "manual": true}
)

// caseIsOpen reports whether the status keeps R8 coverage and an unsealed log.
func caseIsOpen(status string) bool {
	return status == "open" || status == "in_progress"
}

// OpenCaseCommand opens a case over one or more receivables.
type OpenCaseCommand struct {
	ReceivableIDs []string
	CollectorID   string
	Priority      string // "" = normal
}

// OpenCase opens a collections case: R8 exclusivity (at most ONE open case
// per receivable — CASE_ALREADY_OPEN names the covering case), the org's
// controlled case-number sequence, the sealed-log `case.opened` marker and
// the outbox fact all commit in ONE transaction under the per-org advisory
// lock.
func (s *Services) OpenCase(ctx context.Context, orgID, openedBy string, cmd OpenCaseCommand) (repositories.CaseRow, error) {
	if trim(openedBy) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseActorRequired, "a collections case requires a non-blank actor id", nil)
	}
	if len(cmd.ReceivableIDs) == 0 {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseReceivablesRequired,
			"a collections case must cover at least one receivable (R8 is defined per receivable)", nil)
	}
	seen := make(map[string]bool, len(cmd.ReceivableIDs))
	for _, id := range cmd.ReceivableIDs {
		if seen[id] {
			return repositories.CaseRow{}, infra.NewDomainError(CodeCaseReceivableDuplicate,
				"receivable "+id+" appears more than once in the same case", nil)
		}
		seen[id] = true
	}
	priority := cmd.Priority
	if priority == "" {
		priority = "normal"
	}
	if _, ok := casePriorities[priority]; !ok {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCasePriorityInvalid, "unknown case priority: "+priority, nil)
	}
	var result repositories.CaseRow
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		if err := s.Stores.LockOrgCases(ctx, tx, orgID); err != nil {
			return err
		}
		ok, err := s.Stores.ReceivablesExist(ctx, tx, orgID, cmd.ReceivableIDs)
		if err != nil {
			return err
		}
		if !ok {
			// Name the FIRST missing receivable deterministically (input order).
			for _, id := range cmd.ReceivableIDs {
				if _, err := s.Stores.ReceivableByID(ctx, tx, orgID, id); errors.Is(err, repositories.ErrNotFound) {
					return infra.NewDomainError(CodeReceivableNotFound, "receivable "+id+" does not exist", nil)
				} else if err != nil {
					return err
				}
			}
			return infra.NewDomainError(CodeReceivableNotFound, "referenced receivable does not exist", nil)
		}
		// R8 exclusivity guard (first conflict in receivableIds order wins).
		coverage, err := s.Stores.ReceivableIDsCoveredByOpenCases(ctx, tx, orgID, cmd.ReceivableIDs)
		if err != nil {
			return err
		}
		for _, id := range cmd.ReceivableIDs {
			if covering, conflict := coverage[id]; conflict {
				return infra.NewDomainError(CodeCaseAlreadyOpen,
					"receivable "+id+" is already covered by open case "+covering+" — close that case first (R8: at most one open case per receivable)",
					map[string]any{"receivableId": id, "caseId": covering})
			}
		}
		seq, err := s.Stores.NextCaseSequence(ctx, tx, orgID)
		if err != nil {
			return err
		}
		now := s.Clock.Now()
		cse := repositories.CaseRow{
			ID:         infra.NewUUID(),
			OrgID:      orgID,
			CaseNumber: formatCaseNumber(seq),
			SequenceNo: seq,
			Priority:   priority,
			Status:     "open",
			OwnerID:    cmd.CollectorID,
			OpenedAt:   now,
		}
		if err := s.Stores.InsertCase(ctx, tx, cse); err != nil {
			return err
		}
		for _, receivableID := range cmd.ReceivableIDs {
			if err := s.Stores.InsertCaseReceivable(ctx, tx, orgID, cse.ID, receivableID); err != nil {
				if repositories.UniqueViolation(err) {
					// The partial UNIQUE index is R8's structural backstop.
					return infra.NewDomainError(CodeCaseAlreadyOpen,
						"receivable "+receivableID+" is already covered by an open case — close that case first (R8: at most one open case per receivable)", nil)
				}
				return err
			}
		}
		if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, openedBy, repositories.LogOpened, map[string]any{
			"actorId":  openedBy,
			"openedAt": repositories.ISO(now),
		}, now, 1); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "case.opened", cse.ID, map[string]any{
			"caseId":        cse.ID,
			"caseNumber":    cse.CaseNumber,
			"orgId":         orgID,
			"receivableIds": cmd.ReceivableIDs,
			"collectorId":   cmd.CollectorID,
			"priority":      priority,
			"openedBy":      openedBy,
			"openedAt":      repositories.ISO(now),
		}); err != nil {
			return err
		}
		result = cse
		return nil
	})
	if err != nil {
		return repositories.CaseRow{}, err
	}
	return result, nil
}

// TransitionCommand moves a case one lifecycle step.
type TransitionCommand struct {
	To     string
	Reason string
}

// Transition moves a case along its lifecycle: legal edges only
// (open → in_progress → resolved|closed_inactive), every step carries a
// reason + actor and lands in the history log + outbox (resolved/closed).
func (s *Services) Transition(ctx context.Context, orgID, caseID, actorID string, cmd TransitionCommand) (repositories.CaseRow, error) {
	if _, ok := caseTransitions[cmd.To]; !ok {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseStatusInvalid, "unknown case status: "+cmd.To, nil)
	}
	if trim(cmd.Reason) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseReasonRequired,
			"a collections case requires a non-blank reason (every transition is a recorded decision)", nil)
	}
	if trim(actorID) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseActorRequired, "a collections case requires a non-blank actor id", nil)
	}
	var result repositories.CaseRow
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		cse, err := s.Stores.CaseByID(ctx, tx, orgID, caseID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeCaseNotFound, "case "+caseID+" does not exist", nil)
			}
			return err
		}
		if err := s.Stores.LockCase(ctx, tx, orgID, cse.ID); err != nil {
			return err
		}
		legal := false
		for _, target := range caseTransitions[cse.Status] {
			if target == cmd.To {
				legal = true
				break
			}
		}
		if !legal {
			return infra.NewDomainError(CodeCaseTransitionInvalid,
				"cannot move a case from "+cse.Status+" to "+cmd.To, nil)
		}
		now := s.Clock.Now()
		var closedAt *time.Time
		var closedReason *string
		if len(caseTransitions[cmd.To]) == 0 {
			closedAt = &now
			reason := trim(cmd.Reason)
			closedReason = &reason
		}
		if err := s.Stores.UpdateCaseStatus(ctx, tx, orgID, cse.ID, cmd.To, closedAt, closedReason); err != nil {
			return err
		}
		seq, err := s.Stores.NextCaseActionSequence(ctx, tx, orgID, cse.ID)
		if err != nil {
			return err
		}
		if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, actorID, repositories.LogTransition, map[string]any{
			"from":    cse.Status,
			"to":      cmd.To,
			"reason":  trim(cmd.Reason),
			"actorId": actorID,
			"at":      repositories.ISO(now),
		}, now, seq); err != nil {
			return err
		}
		eventName := ""
		switch cmd.To {
		case "resolved":
			eventName = "case.resolved"
		case "closed_inactive":
			eventName = "case.closed"
		}
		if eventName != "" {
			// The lane's resolved/closed payloads carry the affected coverage
			// (case.resolved: receivableIds; case.closed: releasedReceivableIds
			// — the instant those receivables stop being R8-covered).
			receivableIDs, idsErr := s.Stores.ReceivableIDsForCase(ctx, tx, orgID, cse.ID)
			if idsErr != nil {
				return idsErr
			}
			payload := map[string]any{
				"caseId":     cse.ID,
				"caseNumber": cse.CaseNumber,
				"orgId":      orgID,
				"reason":     trim(cmd.Reason),
				"actorId":    actorID,
			}
			if eventName == "case.resolved" {
				payload["receivableIds"] = receivableIDs
				payload["resolvedAt"] = repositories.ISO(now)
			} else {
				payload["releasedReceivableIds"] = receivableIDs
				payload["closedAt"] = repositories.ISO(now)
			}
			if err := s.appendOutbox(ctx, tx, orgID, eventName, cse.ID, payload); err != nil {
				return err
			}
		}
		cse.Status = cmd.To
		cse.ClosedAt = closedAt
		cse.ClosedReason = closedReason
		result = cse
		return nil
	})
	if err != nil {
		return repositories.CaseRow{}, err
	}
	return result, nil
}

// EscalationCommand bumps a case's priority.
type EscalationCommand struct {
	To     string
	Reason string
}

// Escalate raises a case's priority — strictly upward (low < normal < high <
// urgent); sidesteps and downgrades refuse. Closed cases have nothing to
// escalate (CASE_CLOSED).
func (s *Services) Escalate(ctx context.Context, orgID, caseID, actorID string, cmd EscalationCommand) (repositories.CaseRow, error) {
	if trim(cmd.Reason) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseReasonRequired,
			"a collections case requires a non-blank reason (every escalation is a recorded decision)", nil)
	}
	if trim(actorID) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseActorRequired, "a collections case requires a non-blank actor id", nil)
	}
	var result repositories.CaseRow
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		cse, err := s.Stores.CaseByID(ctx, tx, orgID, caseID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeCaseNotFound, "case "+caseID+" does not exist", nil)
			}
			return err
		}
		if err := s.Stores.LockCase(ctx, tx, orgID, cse.ID); err != nil {
			return err
		}
		if !caseIsOpen(cse.Status) {
			return infra.NewDomainError(CodeCaseClosed,
				"case "+cse.CaseNumber+" is "+cse.Status+" — nothing to escalate", nil)
		}
		rank, ok := casePriorities[cmd.To]
		if !ok {
			return infra.NewDomainError(CodeCasePriorityInvalid, "unknown case priority: "+cmd.To, nil)
		}
		if rank <= casePriorities[cse.Priority] {
			return infra.NewDomainError(CodeCaseEscalationInvalid,
				"escalation must strictly raise the priority; "+cse.Priority+" → "+cmd.To+" does not", nil)
		}
		now := s.Clock.Now()
		if err := s.Stores.UpdateCasePriority(ctx, tx, orgID, cse.ID, cmd.To); err != nil {
			return err
		}
		seq, err := s.Stores.NextCaseActionSequence(ctx, tx, orgID, cse.ID)
		if err != nil {
			return err
		}
		if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, actorID, repositories.LogEscalation, map[string]any{
			"from":    cse.Priority,
			"to":      cmd.To,
			"reason":  trim(cmd.Reason),
			"actorId": actorID,
			"at":      repositories.ISO(now),
		}, now, seq); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "case.escalated", cse.ID, map[string]any{
			"caseId":      cse.ID,
			"caseNumber":  cse.CaseNumber,
			"orgId":       orgID,
			"from":        cse.Priority,
			"to":          cmd.To,
			"reason":      trim(cmd.Reason),
			"actorId":     actorID,
			"escalatedAt": repositories.ISO(now),
		}); err != nil {
			return err
		}
		cse.Priority = cmd.To
		result = cse
		return nil
	})
	if err != nil {
		return repositories.CaseRow{}, err
	}
	return result, nil
}

// RecordActionCommand appends an action to the case's sealed log.
type RecordActionCommand struct {
	Type         string
	ScheduledFor time.Time
	Outcome      string // optional backfill
	Source       string // "" = K2 default (automated for outbound, manual otherwise)
	ConsentRef   string // required for automated outbound sends
}

// RecordActionResult carries the appended action ("" id = refusal).
type RecordActionResult struct {
	Case   repositories.CaseRow
	Action CaseAction
}

// CaseAction is the action log entry's wire shape.
type CaseAction struct {
	ID           string  `json:"id"`
	Type         string  `json:"type"`
	ScheduledFor string  `json:"scheduledFor"`
	Outcome      *string `json:"outcome"`
	CompletedAt  *string `json:"completedAt"`
	CompletedBy  *string `json:"completedBy"`
	ConsentRef   *string `json:"consentRef"`
	Source       string  `json:"source"`
	ActorID      string  `json:"actorId"`
	RecordedAt   string  `json:"recordedAt"`
}

// RecordAction appends an action to the case's sealed log. The K2
// dunning-consent gate is refusal-as-value: an automated sms/whatsapp send
// without an active consentRef records the compliance fact
// (collections.dunningBlockedNoConsent + the sealed-log hold marker) and
// refuses with 403 DUNNING_CONSENT_REQUIRED — nothing was sent, nothing was
// appended to the actions log.
func (s *Services) RecordAction(ctx context.Context, orgID, caseID, actorID string, cmd RecordActionCommand) (RecordActionResult, error) {
	if trim(actorID) == "" {
		return RecordActionResult{}, infra.NewDomainError(CodeCaseActorRequired, "a case action requires a non-blank actor id", nil)
	}
	if !caseActionTypes[cmd.Type] {
		return RecordActionResult{}, infra.NewDomainError(CodeCaseActionTypeInvalid, "unknown case action type: "+cmd.Type, nil)
	}
	if cmd.ScheduledFor.IsZero() {
		return RecordActionResult{}, infra.NewDomainError(CodeCaseScheduledForInvalid, "scheduledFor must be a valid timestamp", nil)
	}
	source := cmd.Source
	if source == "" {
		if outboundTypes[cmd.Type] {
			source = "automated"
		} else {
			source = "manual"
		}
	}
	if !actionSources[source] {
		return RecordActionResult{}, infra.NewDomainError(CodeCaseActionSourceInvalid, "unknown action source: "+source, nil)
	}
	outcome := ""
	if cmd.Outcome != "" {
		outcome = trim(cmd.Outcome)
		if outcome == "" {
			return RecordActionResult{}, infra.NewDomainError(CodeCaseOutcomeRequired, "a case action requires a non-blank outcome (blank when completing)", nil)
		}
	}
	consentRef := trim(cmd.ConsentRef)
	var result RecordActionResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		cse, err := s.Stores.CaseByID(ctx, tx, orgID, caseID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeCaseNotFound, "case "+caseID+" does not exist", nil)
			}
			return err
		}
		if err := s.Stores.LockCase(ctx, tx, orgID, cse.ID); err != nil {
			return err
		}
		if !caseIsOpen(cse.Status) {
			return infra.NewDomainError(CodeCaseClosed,
				"case "+cse.CaseNumber+" is "+cse.Status+" — its action log is sealed", nil)
		}
		now := s.Clock.Now()
		if outboundTypes[cmd.Type] && source == "automated" && consentRef == "" {
			// K2 refusal-as-value: record the compliance fact, refuse on the
			// wire. Nothing was sent; the actions log is untouched.
			seq, seqErr := s.Stores.NextCaseActionSequence(ctx, tx, orgID, cse.ID)
			if seqErr != nil {
				return seqErr
			}
			if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, actorID, repositories.LogDunningHold, map[string]any{
				"actionType":   cmd.Type,
				"scheduledFor": repositories.ISO(cmd.ScheduledFor),
				"reason": "automated " + cmd.Type + " dunning on case " + cse.CaseNumber +
					" requires an active dunning consent reference (K2) — nothing was sent",
				"blockedAt": repositories.ISO(now),
			}, now, seq); err != nil {
				return err
			}
			blockedReceivableIDs, idsErr := s.Stores.ReceivableIDsForCase(ctx, tx, orgID, cse.ID)
			if idsErr != nil {
				return idsErr
			}
			if err := s.appendOutbox(ctx, tx, orgID, "collections.dunningBlockedNoConsent", cse.ID, map[string]any{
				"caseId":        cse.ID,
				"caseNumber":    cse.CaseNumber,
				"orgId":         orgID,
				"receivableIds": blockedReceivableIDs,
				"actionType":    cmd.Type,
				"scheduledFor":  repositories.ISO(cmd.ScheduledFor),
				"actorId":       actorID,
				"reason":        "automated " + cmd.Type + " dunning requires an active dunning consent reference (K2) — nothing was sent",
				"blockedAt":     repositories.ISO(now),
			}); err != nil {
				return err
			}
			return infra.NewDomainError(CodeDunningConsentRequired,
				"automated "+cmd.Type+" dunning on case "+cse.CaseNumber+" requires an active dunning consent reference (K2) — nothing was sent",
				map[string]any{"caseId": cse.ID, "actionType": cmd.Type, "source": source})
		}
		seq, err := s.Stores.NextCaseActionSequence(ctx, tx, orgID, cse.ID)
		if err != nil {
			return err
		}
		actionID := infra.NewUUID()
		detail := map[string]any{
			"type":         cmd.Type,
			"scheduledFor": repositories.ISO(cmd.ScheduledFor),
			"source":       source,
			"actorId":      actorID,
		}
		if consentRef != "" {
			detail["consentRef"] = consentRef
		}
		if outcome != "" {
			detail["outcome"] = outcome
			detail["completedAt"] = repositories.ISO(now)
			detail["completedBy"] = actorID
		}
		if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, actorID, cmd.Type, detail, now, seq); err != nil {
			return err
		}
		recordedPayload := map[string]any{
			"caseId":       cse.ID,
			"caseNumber":   cse.CaseNumber,
			"orgId":        orgID,
			"actionId":     actionID,
			"actionType":   cmd.Type,
			"scheduledFor": repositories.ISO(cmd.ScheduledFor),
			"outcome":      nullableString(outcome),
			"completedAt":  nullableString(""),
			"consentRef":   nullableString(consentRef),
			"actorId":      actorID,
			"recordedAt":   repositories.ISO(now),
		}
		if outcome != "" {
			recordedPayload["completedAt"] = repositories.ISO(now)
		}
		if err := s.appendOutbox(ctx, tx, orgID, "case.actionRecorded", cse.ID, recordedPayload); err != nil {
			return err
		}
		result = RecordActionResult{
			Case: cse,
			Action: CaseAction{
				ID:           actionID,
				Type:         cmd.Type,
				ScheduledFor: repositories.ISO(cmd.ScheduledFor),
				Source:       source,
				ActorID:      actorID,
				RecordedAt:   repositories.ISO(now),
				ConsentRef:   optString(consentRef),
			},
		}
		if outcome != "" {
			v := outcome
			result.Action.Outcome = &v
			c := repositories.ISO(now)
			result.Action.CompletedAt = &c
			b := actorID
			result.Action.CompletedBy = &b
		}
		return nil
	})
	if err != nil {
		return RecordActionResult{}, err
	}
	return result, nil
}

// CompleteAction stamps the outcome on a recorded action — exactly once.
func (s *Services) CompleteAction(ctx context.Context, orgID, caseID, actionID, actorID, outcome string) (repositories.CaseRow, error) {
	if trim(outcome) == "" {
		return repositories.CaseRow{}, infra.NewDomainError(CodeCaseOutcomeRequired,
			"a case action requires a non-blank outcome (blank when completing)", nil)
	}
	var result repositories.CaseRow
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		cse, err := s.Stores.CaseByID(ctx, tx, orgID, caseID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeCaseNotFound, "case "+caseID+" does not exist", nil)
			}
			return err
		}
		if err := s.Stores.LockCase(ctx, tx, orgID, cse.ID); err != nil {
			return err
		}
		if !caseIsOpen(cse.Status) {
			return infra.NewDomainError(CodeCaseClosed,
				"case "+cse.CaseNumber+" is "+cse.Status+" — its action log is sealed", nil)
		}
		target, err := s.Stores.FindCaseAction(ctx, tx, orgID, cse.ID, actionID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeCaseActionNotFound,
					"case "+cse.CaseNumber+" has no action "+actionID, nil)
			}
			return err
		}
		if target.Action != "call" && target.Action != "sms" && target.Action != "whatsapp" &&
			target.Action != "letter" && target.Action != "fieldVisit" && target.Action != "escalation" {
			return infra.NewDomainError(CodeCaseActionNotFound,
				"case "+cse.CaseNumber+" has no action "+actionID, nil)
		}
		done, err := s.Stores.CaseActionCompleted(ctx, tx, orgID, cse.ID, actionID)
		if err != nil {
			return err
		}
		if done {
			var detail map[string]any
			_ = unmarshalJSON(target.Detail, &detail)
			completedAt := ""
			if v, ok := detail["completedAt"].(string); ok {
				completedAt = v
			}
			return infra.NewDomainError(CodeCaseActionAlreadyDone,
				"action "+actionID+" was already completed at "+completedAt, nil)
		}
		now := s.Clock.Now()
		seq, err := s.Stores.NextCaseActionSequence(ctx, tx, orgID, cse.ID)
		if err != nil {
			return err
		}
		completedBy := target.ActorID
		if trim(actorID) != "" {
			completedBy = trim(actorID)
		}
		if err := s.Stores.AppendCaseAction(ctx, tx, orgID, cse.ID, completedBy, repositories.LogCompletion, map[string]any{
			"actionId":    actionID,
			"outcome":     trim(outcome),
			"completedAt": repositories.ISO(now),
		}, now, seq); err != nil {
			return err
		}
		result = cse
		return nil
	})
	if err != nil {
		return repositories.CaseRow{}, err
	}
	return result, nil
}

// GetCase loads one org-scoped case with its R8 coverage + sealed log.
func (s *Services) GetCase(ctx context.Context, q repositories.Querier, orgID, caseID string) (repositories.CaseRow, []repositories.CaseActionLogRow, error) {
	cse, err := s.Stores.CaseByID(ctx, q, orgID, caseID)
	if err != nil {
		if errors.Is(err, repositories.ErrNotFound) {
			return repositories.CaseRow{}, nil, infra.NewDomainError(CodeCaseNotFound, "case "+caseID+" does not exist", nil)
		}
		return repositories.CaseRow{}, nil, err
	}
	log, err := s.Stores.CaseActionLog(ctx, q, orgID, cse.ID)
	if err != nil {
		return repositories.CaseRow{}, nil, err
	}
	return cse, log, nil
}

// ListCases is the org-scoped paginated read model.
func (s *Services) ListCases(ctx context.Context, q repositories.Querier, orgID, sortCol, order string, limit, offset int) ([]repositories.CaseRow, int, error) {
	return s.Stores.CasesByOrg(ctx, q, orgID, sortCol, order, limit, offset)
}

// formatCaseNumber is the org-agnostic `CASE-` + 6-digit zero-padded number.
func formatCaseNumber(seq int64) string {
	digits := itoa(seq)
	for len(digits) < 6 {
		digits = "0" + digits
	}
	return "CASE-" + digits
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func unmarshalJSON(raw []byte, v any) error {
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, v)
}

// nullableString renders an optional string for a jsonb payload: "" → null
// (the TS payloads express absent optional values as null, not "").
func nullableString(s string) any {
	if s == "" {
		return nil
	}
	return s
}
