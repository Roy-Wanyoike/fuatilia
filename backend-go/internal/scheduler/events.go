package scheduler

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Event is one domain event in the wave-1 envelope the TS lanes emit
// ({name, version, aggregateId, occurredAt, payload} — receivables/events.ts
// domainEvent): the name/version travel as the outbox row's event_type and
// version, the payload JSON is the row's payload column, and the relay lane
// wraps them with eventId/orgId/createdAt at publish time. The scheduler
// never talks to the broker — it appends to outbox_events (0013).
type Event struct {
	ID          string // outbox event_id (RFC 4122 v4, infra.NewUUID)
	Type        string // envelope name, e.g. "dunning.stepDue"
	Version     int    // envelope version — 1 until a breaking payload change
	AggregateID string // the aggregate the event is about (TS aggregateId)
	OccurredAt  time.Time
	Payload     []byte // canonical JSON of the payload struct — the TS payload shape
}

// newEvent builds an event with a fresh id, version 1 and the payload
// marshaled at the given occurrence instant (one clock read — the TS
// factories freeze occurredAt once per event).
func newEvent(name, aggregateID string, occurredAt time.Time, payload any) (Event, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return Event{}, schedErr(CodeJobInvalid, "marshal %s payload: %v", name, err)
	}
	return Event{
		ID:          infra.NewUUID(),
		Type:        name,
		Version:     1,
		AggregateID: aggregateID,
		OccurredAt:  occurredAt,
		Payload:     raw,
	}, nil
}

// iso renders an instant exactly like Date.toISOString(): UTC, millisecond
// precision, Z suffix ("2026-03-13T00:00:00.000Z"). Every ISO string in the
// event payloads goes through this so wire payloads match the TS lanes
// byte-for-byte at the same instant.
func iso(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

func sprintf(format string, args ...any) string { return fmt.Sprintf(format, args...) }

// maxSafeInteger is 2^53−1 — the largest integer a JSON number can carry
// without precision loss (Number.MAX_SAFE_INTEGER).
const maxSafeInteger = 9007199254740991

// safeInt converts minor units to a JSON-safe number, refusing silent
// precision loss with the TS guard's code (receivables/events.ts
// minorToNumber → EVENT_AMOUNT_NOT_SAFE_INTEGER; projections/events.ts
// minorToNumber → PROJ_AMOUNT_NOT_SAFE_INTEGER — same rule, the receivables
// lane's code is the one this package's payloads hit).
func safeInt(amountMinor int64) (int64, error) {
	if amountMinor > maxSafeInteger || amountMinor < -maxSafeInteger {
		return 0, &Error{Code: "EVENT_AMOUNT_NOT_SAFE_INTEGER",
			Message: sprintf("amount %d exceeds the safe-integer range for event payloads", amountMinor)}
	}
	return amountMinor, nil
}

// --- dunning payloads (src/domain/promises/events.ts) ---------------------------

// DunningStepDuePayload is the dunning.stepDue payload (TS
// DunningStepDuePayload; promises/events.ts + dunning.ts orchestrateDunning).
type DunningStepDuePayload struct {
	OrgID           string `json:"orgId"`
	SubjectID       string `json:"subjectId"`
	StepKey         string `json:"stepKey"`
	DayOffset       int    `json:"dayOffset"`
	Kind            string `json:"kind"`
	Channel         string `json:"channel"`
	RequiresConsent bool   `json:"requiresConsent"`
	DueDate         string `json:"dueDate"` // ISO-8601
}

// DunningBlockedNoConsentPayload is the collections.dunningBlockedNoConsent
// payload (TS CollectionsDunningBlockedNoConsentPayload) — the K2 refusal as
// an observable fact.
type DunningBlockedNoConsentPayload struct {
	OrgID     string `json:"orgId"`
	SubjectID string `json:"subjectId"`
	StepKey   string `json:"stepKey"`
	Channel   string `json:"channel"`
	BlockedAt string `json:"blockedAt"` // ISO-8601
}

// DunningEscalatedPayload is the dunning.escalated payload (TS
// DunningEscalatedPayload) — the wait evidence.
type DunningEscalatedPayload struct {
	OrgID       string `json:"orgId"`
	SubjectID   string `json:"subjectId"`
	StepKey     string `json:"stepKey"`
	Channel     string `json:"channel"`
	LastSendAt  string `json:"lastSendAt"` // ISO-8601
	WaitedDays  int    `json:"waitedDays"`
	EscalatedAt string `json:"escalatedAt"` // ISO-8601
}

// --- late fee payload (src/domain/receivables/late-fee.ts) ----------------------

// LateFeePosting is the docs/05 posting-matrix row: Late fee accrued → AR
// control (Dr) / Fee income (Cr). It travels on the fee row AND the event
// payload so the ledger module can post without re-deriving it.
type LateFeePosting struct {
	Debit  string `json:"debit"`
	Credit string `json:"credit"`
}

// feePosting is the only posting the late-fee lane emits (late-fee.ts
// feePosting).
var feePosting = LateFeePosting{Debit: "ar_control", Credit: "fee_income"}

// LateFeeAccruedPayload is the receivable.lateFeeAccrued payload (TS
// LateFeeAccruedPayload) — an additive member of the event catalog.
type LateFeeAccruedPayload struct {
	ReceivableID string         `json:"receivableId"`
	PeriodKey    string         `json:"periodKey"`
	AmountMinor  int64          `json:"amountMinor"`
	Currency     string         `json:"currency"`
	PolicyKind   string         `json:"policyKind"`
	PercentBps   *int           `json:"percentBps"`
	FlatMinor    *int64         `json:"flatMinor"`
	BalanceMinor int64          `json:"balanceMinor"`
	DaysLate     int            `json:"daysLate"`
	GraceDays    int            `json:"graceDays"`
	Posting      LateFeePosting `json:"posting"`
}

// --- payment plan payload (src/domain/receivables/plan-events.ts) ---------------

// PlanDefaultedPayload is the paymentplan.defaulted payload (TS
// PlanDefaultedPayload) — the earliest unpaid installment that crossed the
// default threshold.
type PlanDefaultedPayload struct {
	PlanID           string `json:"planId"`
	CustomerID       string `json:"customerId"`
	InstallmentNo    int    `json:"installmentNo"`
	DaysOverdue      int    `json:"daysOverdue"`
	DefaultAfterDays int    `json:"defaultAfterDays"`
}

// --- aging snapshot payload (src/domain/projections/events.ts) ------------------

// AgingCurrencyTotals is one currency's slice of the agingSnapshotTaken
// payload (TS AgingCurrencyTotalsPayload).
type AgingCurrencyTotals struct {
	Currency        string           `json:"currency"`
	TotalMinor      int64            `json:"totalMinor"`
	ReceivableCount int              `json:"receivableCount"`
	BucketMinors    map[string]int64 `json:"bucketMinors"` // all five bucket keys, always present
}

// AgingSnapshotTakenPayload is the projections.agingSnapshotTaken payload
// (TS AgingSnapshotTakenPayload) — an ACTUALS fact about the portfolio.
type AgingSnapshotTakenPayload struct {
	OrgID            string                `json:"orgId"`
	AsOf             string                `json:"asOf"` // ISO-8601
	ReceivablesAged  int                   `json:"receivablesAged"`
	ZeroBalanceCount int                   `json:"zeroBalanceCount"`
	EvidenceRefs     []string              `json:"evidenceRefs"`
	Currencies       []AgingCurrencyTotals `json:"currencies"`
}
