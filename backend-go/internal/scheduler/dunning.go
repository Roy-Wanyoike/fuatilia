package scheduler

import (
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Pure Go port of src/domain/promises/dunning.ts (issue #19, SPEC §18) — the
// dunning cadence engine the dunning job executes. Parity contract: the
// ladder table, day arithmetic, consent gate and refusal codes are the TS
// module's, formula for formula; dunning_test.go pins them against the TS
// spec fixtures (dunning.spec.ts) and cites the source lines.
//
// The ladder is CONFIGURATION, not code: a list of steps, each with a day
// offset relative to the due date (negative = pre-due), a message kind, a
// channel and a requiresConsent flag. SPEC §18's example ladder ships as
// DefaultDunningLadder; callers (jobs included) may pass their own.
//
// Consent (K2 — Kenya DPA 2019 / Meta policy): a step flagged
// requiresConsent may only be sent when the subject carries a consentRef.
// The orchestrator refuses such sends and emits the typed refusal fact
// collections.dunningBlockedNoConsent — the refusal is an observable value
// (stable code DUNNING_CONSENT_REQUIRED), never a silent drop and never an
// exception. Consent is never implied: a missing or blank consentRef blocks,
// every time.
//
// Everything is pure and deterministic: day arithmetic is UTC-day-index
// based, so day boundaries land at midnight UTC regardless of wall-clock
// time; now is passed in (from the caller's injected Clock) — no time.Now(),
// no I/O, no RNG.

// DunningChannel is one of the ladder's delivery channels (TS
// DUNNING_CHANNELS tuple).
const (
	ChannelEmail    = "email"
	ChannelSMS      = "sms"
	ChannelWhatsApp = "whatsapp"
	ChannelTask     = "task"
)

// DunningStepKind is one of the ladder's step kinds (TS DUNNING_STEP_KINDS
// tuple).
const (
	KindReminder          = "reminder"
	KindPaymentRequest    = "payment_request"
	KindWhatsApp          = "whatsapp"
	KindSMS               = "sms"
	KindCollectorTask     = "collector_task"
	KindManagerEscalation = "manager_escalation"
	KindPaymentPlanOffer  = "payment_plan_offer"
	KindRecoveryWorkflow  = "recovery_workflow"
)

// DunningStep is one ladder rung. Key is the stable idempotence handle for
// sentSteps (e.g. "overdue_day_3").
type DunningStep struct {
	Key             string
	DayOffset       int // days relative to the due date (negative = pre-due, 0 = on the due date)
	Kind            string
	Channel         string
	RequiresConsent bool // K2 gate: send refused without a consentRef
}

func dunningStep(key string, dayOffset int, kind, channel string, requiresConsent bool) DunningStep {
	return DunningStep{Key: key, DayOffset: dayOffset, Kind: kind, Channel: channel, RequiresConsent: requiresConsent}
}

// DefaultDunningLadder is SPEC §18's example cadence, as configuration
// (dunning.ts DEFAULT_DUNNING_LADDER, table-pinned by dunning.spec.ts).
// WhatsApp touches are consent-gated (K2/Meta policy); email reminders and
// SMS notices about an existing debt are transactional and are not; internal
// task steps never contact the customer.
var DefaultDunningLadder = []DunningStep{
	dunningStep("pre_due_reminder", -3, KindReminder, ChannelEmail, false),
	dunningStep("due_date_request", 0, KindPaymentRequest, ChannelEmail, false),
	dunningStep("overdue_day_3", 3, KindWhatsApp, ChannelWhatsApp, true),
	dunningStep("overdue_day_7", 7, KindSMS, ChannelSMS, false),
	dunningStep("overdue_day_14", 14, KindCollectorTask, ChannelTask, false),
	dunningStep("overdue_day_30", 30, KindManagerEscalation, ChannelTask, false),
	dunningStep("overdue_day_45", 45, KindPaymentPlanOffer, ChannelEmail, false),
	dunningStep("overdue_day_60", 60, KindRecoveryWorkflow, ChannelTask, false),
}

// Codes the dunning port refuses with (TS DomainError families, verbatim).
const (
	CodeDunningLadderInvalid     = "DUNNING_LADDER_INVALID"
	CodeDunningClockInvalid      = "DUNNING_CLOCK_INVALID"
	CodeDunningFactsInvalid      = "DUNNING_FACTS_INVALID"
	CodeDunningConsentRequired   = "DUNNING_CONSENT_REQUIRED"
	CodeDunningEscalationInvalid = "DUNNING_ESCALATION_INVALID"
	CodeDunningEscalationNotDue  = "DUNNING_ESCALATION_NOT_DUE"
)

// ValidateLadder validates a ladder: non-empty, unique keys, non-blank keys,
// sorted by dayOffset (deterministic due-order; equal offsets allowed — the
// TS check is `dayOffset < previousOffset`). Refusal: DUNNING_LADDER_INVALID.
// (The TS "safe integer" row of its refusal table is unrepresentable here:
// Go int fields cannot hold non-integer offsets — the typed boundary IS the
// validation.)
func ValidateLadder(ladder []DunningStep) error {
	if len(ladder) == 0 {
		return &Error{Code: CodeDunningLadderInvalid, Message: "a dunning ladder needs at least one step"}
	}
	keys := make(map[string]bool, len(ladder))
	previousOffset := 0
	for i, s := range ladder {
		if strings.TrimSpace(s.Key) == "" {
			return &Error{Code: CodeDunningLadderInvalid, Message: "every step needs a non-blank key"}
		}
		if keys[s.Key] {
			return &Error{Code: CodeDunningLadderInvalid, Message: "duplicate step key: " + s.Key}
		}
		keys[s.Key] = true
		if i > 0 && s.DayOffset < previousOffset {
			return &Error{Code: CodeDunningLadderInvalid,
				Message: sprintf("ladder must be sorted by dayOffset (%s at %d after %d)", s.Key, s.DayOffset, previousOffset)}
		}
		previousOffset = s.DayOffset
	}
	return nil
}

// DunningFacts is the slice of subject state one dunning tick needs (TS
// DunningFacts). DueDate is the ladder anchor — the receivable's due date (or
// promised date). SentSteps are the step keys already sent (idempotence: a
// step never fires twice). ConsentRef is an opaque consent-grant reference;
// blank blocks consent-gated steps.
type DunningFacts struct {
	DueDate    time.Time
	SentSteps  []string
	ConsentRef string
	SubjectID  string
	OrgID      string
}

// utcDayIndex floors an instant to its UTC calendar-day index — the exact TS
// dayIndex(d) = Math.floor(Date.UTC(y, m, d) / 86_400_000). Midnight instants
// are exact multiples of 86 400 s, so the integer division is exact for every
// representable date.
func utcDayIndex(t time.Time) int64 {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC).Unix() / 86400
}

// UTCDaysBetween returns whole UTC calendar days between two instants — the
// floor of the calendar-day distance (dunning.ts utcDaysBetween). Negative
// when `to` is calendar-earlier than `from`.
func UTCDaysBetween(from, to time.Time) int64 {
	return utcDayIndex(to) - utcDayIndex(from)
}

func assertDunningDate(value time.Time, code, label string) error {
	if value.IsZero() {
		return &Error{Code: code, Message: label + " is not a valid Date"}
	}
	return nil
}

// DueSteps returns which ladder steps are due as of `now`: a step is due when
// the subject is at least dayOffset UTC days past (or before, for negative
// offsets) the due date AND the step has not been sent yet (sentSteps is the
// idempotence set). Steps come back in ladder order, so callers work through
// a backlog oldest-first. Selection is deliberately consent-blind — the
// orchestrator splits due steps into sends and refusals (K2) so blocked steps
// stay observable.
func DueSteps(now time.Time, facts DunningFacts, ladder []DunningStep) ([]DunningStep, error) {
	if err := assertDunningDate(now, CodeDunningClockInvalid, "now"); err != nil {
		return nil, err
	}
	if err := assertDunningDate(facts.DueDate, CodeDunningFactsInvalid, "dueDate"); err != nil {
		return nil, err
	}
	if err := ValidateLadder(ladder); err != nil {
		return nil, err
	}
	daysPast := UTCDaysBetween(facts.DueDate, now)
	sent := make(map[string]bool, len(facts.SentSteps))
	for _, key := range facts.SentSteps {
		sent[key] = true
	}
	var due []DunningStep
	for _, s := range ladder {
		if !sent[s.Key] && daysPast >= int64(s.DayOffset) {
			due = append(due, s)
		}
	}
	return due, nil
}

// SendDecision is the K2 consent gate's outcome (TS DunningSendDecision): a
// refusal is a VALUE (typed reason DUNNING_CONSENT_REQUIRED), never an
// exception — invalid *input* is what errors.
type SendDecision struct {
	Allowed bool
	Reason  string
	Detail  string
}

// EvaluateDunningSend reports whether a step may be sent for a subject
// carrying consentRef. A blank/whitespace consentRef counts as absent:
// consent is never implied (K2).
func EvaluateDunningSend(step DunningStep, consentRef string) SendDecision {
	if !step.RequiresConsent {
		return SendDecision{Allowed: true}
	}
	if strings.TrimSpace(consentRef) != "" {
		return SendDecision{Allowed: true}
	}
	return SendDecision{
		Allowed: false,
		Reason:  CodeDunningConsentRequired,
		Detail:  sprintf("dunning step %s (%s) requires consent but the subject carries no consentRef", step.Key, step.Channel),
	}
}

// AssertDunningSendable is the exception-style K2 gate: it errors with the
// stable code DUNNING_CONSENT_REQUIRED when a consent-gated step has no
// consentRef (dunning.ts assertDunningSendable).
func AssertDunningSendable(step DunningStep, consentRef string) error {
	if d := EvaluateDunningSend(step, consentRef); !d.Allowed {
		return &Error{Code: d.Reason, Message: d.Detail}
	}
	return nil
}

// DunningSend is one allowed send: the step plus its dunning.stepDue event.
type DunningSend struct {
	Step  DunningStep
	Event Event
}

// DunningBlocked is one consent-refused step: the step, the stable refusal
// code and the collections.dunningBlockedNoConsent event.
type DunningBlocked struct {
	Step   DunningStep
	Reason string
	Event  Event
}

// DunningPlan partitions every due step into exactly one of sends | blocked
// (the invariant the TS tests pin): the same tick never both blocks and
// proceeds silently.
type DunningPlan struct {
	Sends   []DunningSend
	Blocked []DunningBlocked
}

// OrchestrateDunning orchestrates one dunning tick for a subject (pure): it
// selects the due steps (DueSteps: ladder + sentSteps idempotence) and splits
// them through the K2 consent gate — allowed steps become sends carrying
// dunning.stepDue; refused steps become blocked entries carrying the stable
// code DUNNING_CONSENT_REQUIRED and the collections.dunningBlockedNoConsent
// event. A scheduled job calls this with now from its injected clock, then
// persists/dispatches the returned events.
func OrchestrateDunning(now time.Time, facts DunningFacts, clock infra.Clock, ladder []DunningStep) (DunningPlan, error) {
	due, err := DueSteps(now, facts, ladder)
	if err != nil {
		return DunningPlan{}, err
	}
	plan := DunningPlan{}
	for _, s := range due {
		decision := EvaluateDunningSend(s, facts.ConsentRef)
		payload := DunningStepDuePayload{
			OrgID:           facts.OrgID,
			SubjectID:       facts.SubjectID,
			StepKey:         s.Key,
			DayOffset:       s.DayOffset,
			Kind:            s.Kind,
			Channel:         s.Channel,
			RequiresConsent: s.RequiresConsent,
			DueDate:         iso(facts.DueDate),
		}
		if decision.Allowed {
			event, err := newEvent("dunning.stepDue", facts.SubjectID, clock.Now(), payload)
			if err != nil {
				return DunningPlan{}, err
			}
			plan.Sends = append(plan.Sends, DunningSend{Step: s, Event: event})
			continue
		}
		blocked := DunningBlockedNoConsentPayload{
			OrgID:     facts.OrgID,
			SubjectID: facts.SubjectID,
			StepKey:   s.Key,
			Channel:   s.Channel,
			BlockedAt: iso(clock.Now()),
		}
		event, err := newEvent("collections.dunningBlockedNoConsent", facts.SubjectID, clock.Now(), blocked)
		if err != nil {
			return DunningPlan{}, err
		}
		plan.Blocked = append(plan.Blocked, DunningBlocked{Step: s, Reason: decision.Reason, Event: event})
	}
	return plan, nil
}

// --- escalation (facts-driven, deterministic) ----------------------------------

// DefaultEscalationAfterDays is the default no-response window before a sent
// step escalates (dunning.ts DEFAULT_ESCALATION_AFTER_DAYS).
const DefaultEscalationAfterDays = 3

// DunningEscalationFacts are the facts one escalation check needs (TS
// DunningEscalationFacts). LastResponseAt earlier than LastSendAt counts as
// no response; EscalationAfterDays nil falls back to
// DefaultEscalationAfterDays.
type DunningEscalationFacts struct {
	LastSendAt          *time.Time
	LastResponseAt      *time.Time
	StepKey             string
	Channel             string
	SubjectID           string
	OrgID               string
	EscalationAfterDays *int
}

// EscalationDue reports whether the no-response escalation horizon has
// passed: true iff a step was sent, the customer has not responded since that
// send, and at least escalationAfterDays whole UTC days have elapsed.
// Deterministic for a given (now, facts) pair. Refusal:
// DUNNING_ESCALATION_INVALID for a negative window.
func EscalationDue(now time.Time, facts DunningEscalationFacts) (bool, error) {
	if err := assertDunningDate(now, CodeDunningClockInvalid, "now"); err != nil {
		return false, err
	}
	afterDays := DefaultEscalationAfterDays
	if facts.EscalationAfterDays != nil {
		afterDays = *facts.EscalationAfterDays
	}
	if afterDays < 0 {
		return false, &Error{Code: CodeDunningEscalationInvalid,
			Message: sprintf("escalationAfterDays must be a safe integer ≥ 0, got %d", afterDays)}
	}
	if facts.LastSendAt == nil {
		return false, nil // nothing sent — nothing to escalate
	}
	if err := assertDunningDate(*facts.LastSendAt, CodeDunningFactsInvalid, "lastSendAt"); err != nil {
		return false, err
	}
	if facts.LastResponseAt != nil {
		if err := assertDunningDate(*facts.LastResponseAt, CodeDunningFactsInvalid, "lastResponseAt"); err != nil {
			return false, err
		}
		if !facts.LastResponseAt.Before(*facts.LastSendAt) {
			return false, nil // responded since the send — no escalation
		}
	}
	return UTCDaysBetween(*facts.LastSendAt, now) >= int64(afterDays), nil
}

// DunningEscalatedEvent builds the dunning.escalated event: it carries the
// wait evidence (which step, which channel, how many whole days) so
// collections/intelligence can act without importing this lane. Refusal:
// DUNNING_ESCALATION_NOT_DUE when EscalationDue does not hold — callers
// check first, this double-checks.
func DunningEscalatedEvent(now time.Time, facts DunningEscalationFacts, clock infra.Clock) (Event, error) {
	due, err := EscalationDue(now, facts)
	if err != nil {
		return Event{}, err
	}
	if !due {
		return Event{}, &Error{Code: CodeDunningEscalationNotDue,
			Message: sprintf("no-response escalation for %s is not due yet", facts.StepKey)}
	}
	waitedDays := UTCDaysBetween(*facts.LastSendAt, now)
	payload := DunningEscalatedPayload{
		OrgID:       facts.OrgID,
		SubjectID:   facts.SubjectID,
		StepKey:     facts.StepKey,
		Channel:     facts.Channel,
		LastSendAt:  iso(*facts.LastSendAt),
		WaitedDays:  int(waitedDays),
		EscalatedAt: iso(clock.Now()),
	}
	return newEvent("dunning.escalated", facts.SubjectID, clock.Now(), payload)
}
