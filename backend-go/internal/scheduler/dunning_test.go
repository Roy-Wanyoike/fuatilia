package scheduler

// Parity tests for the dunning port — every table below is the TypeScript
// spec's own fixture table, cited per test:
//
//      SOURCE: src/domain/promises/dunning.ts            (the ported module)
//      SPEC:   src/domain/promises/dunning.spec.ts       (the fixture tables)
//
// A change to either side that these tests do not pin is a parity break.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

const dunningDueISO = "2026-03-10T00:00:00.000Z" // SPEC DUE

var (
	dunningOrg     = "00000000-0000-4000-8000-000000000651" // SPEC ORG  = uid(651)
	dunningSubject = "00000000-0000-4000-8000-000000000652" // SPEC SUBJECT = uid(652)
)

func mustTime(t *testing.T, iso string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t.Fatalf("parse %s: %v", iso, err)
	}
	return parsed
}

func fixedClock(t *testing.T, iso string) infra.FixedClock {
	t.Helper()
	return infra.FixedClock{At: mustTime(t, iso)}
}

// dunningFacts mirrors the SPEC facts() fixture (consentRef: null, no sent).
func dunningFacts() DunningFacts {
	return DunningFacts{
		DueDate:    mustTimeT(dunningDueISO),
		SentSteps:  nil,
		ConsentRef: "",
		SubjectID:  dunningSubject,
		OrgID:      dunningOrg,
	}
}

func withConsent() DunningFacts {
	f := dunningFacts()
	f.ConsentRef = "consent-grant-77"
	return f
}

func mustTimeT(iso string) time.Time {
	parsed, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		panic(err)
	}
	return parsed
}

func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected DomainError %s, but nothing was returned", code)
	}
	var e *Error
	if !asSchedError(err, &e) || e.Code != code {
		t.Fatalf("expected error code %s, got %v", code, err)
	}
}

func asSchedError(err error, target **Error) bool {
	if e, ok := err.(*Error); ok {
		*target = e
		return true
	}
	return false
}

// payloadMap decodes an event payload for shape assertions.
func payloadMap(t *testing.T, ev Event) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(ev.Payload, &m); err != nil {
		t.Fatalf("payload of %s is not JSON: %v", ev.Type, err)
	}
	return m
}

// SPEC: 'DEFAULT_DUNNING_LADDER — SPEC §18 as pure config' →
// 'encodes the documented cadence exactly (table)'.
func TestDefaultDunningLadderTable(t *testing.T) {
	expected := []DunningStep{
		{"pre_due_reminder", -3, KindReminder, ChannelEmail, false},
		{"due_date_request", 0, KindPaymentRequest, ChannelEmail, false},
		{"overdue_day_3", 3, KindWhatsApp, ChannelWhatsApp, true},
		{"overdue_day_7", 7, KindSMS, ChannelSMS, false},
		{"overdue_day_14", 14, KindCollectorTask, ChannelTask, false},
		{"overdue_day_30", 30, KindManagerEscalation, ChannelTask, false},
		{"overdue_day_45", 45, KindPaymentPlanOffer, ChannelEmail, false},
		{"overdue_day_60", 60, KindRecoveryWorkflow, ChannelTask, false},
	}
	if len(DefaultDunningLadder) != len(expected) {
		t.Fatalf("ladder length %d, want %d", len(DefaultDunningLadder), len(expected))
	}
	for i, want := range expected {
		if DefaultDunningLadder[i] != want {
			t.Fatalf("ladder[%d] = %+v, want %+v", i, DefaultDunningLadder[i], want)
		}
	}
	// SPEC: 'survives its own validation (the shipped ladder is well-formed)'.
	if err := ValidateLadder(DefaultDunningLadder); err != nil {
		t.Fatalf("shipped ladder must validate: %v", err)
	}
}

// SPEC: 'assertLadder — configuration validation' → 'refuses malformed
// ladders (table)'. The TS non-integer dayOffset row (1.5) is unrepresentable
// in Go's typed int field — the compile-time boundary IS that validation.
func TestValidateLadderRefusals(t *testing.T) {
	good := func(over func(*DunningStep), key string) DunningStep {
		s := DunningStep{Key: key, DayOffset: 0, Kind: KindReminder, Channel: ChannelEmail, RequiresConsent: false}
		if over != nil {
			over(&s)
		}
		return s
	}
	table := []struct {
		name   string
		ladder []DunningStep
	}{
		{"empty", nil},
		{"blank key", []DunningStep{good(func(s *DunningStep) { s.Key = "  " }, "a")}},
		{"duplicate key", []DunningStep{good(nil, "a"), good(nil, "a")}},
		{"unsorted offsets", []DunningStep{good(func(s *DunningStep) { s.DayOffset = 5 }, "late"), good(func(s *DunningStep) { s.DayOffset = 2 }, "early")}},
	}
	for _, tc := range table {
		err := ValidateLadder(tc.ladder)
		if err == nil {
			t.Fatalf("%s: expected DUNNING_LADDER_INVALID, got nil", tc.name)
		}
		expectCode(t, err, CodeDunningLadderInvalid)
	}
	// SPEC: 'accepts a custom ladder' (equal offsets are allowed — the TS
	// check is `dayOffset < previousOffset`).
	custom := []DunningStep{{Key: "a", DayOffset: -1, Kind: KindReminder, Channel: ChannelEmail}, {Key: "b", DayOffset: 5, Kind: KindSMS, Channel: ChannelSMS}}
	if err := ValidateLadder(custom); err != nil {
		t.Fatalf("custom ladder refused: %v", err)
	}
}

// SPEC: 'utcDaysBetween — deterministic UTC day boundaries' → whole-UTC-
// calendar-days table.
func TestUTCDaysBetween(t *testing.T) {
	table := []struct {
		from, to string
		want     int64
	}{
		{"2026-03-10T00:00:00.000Z", "2026-03-10T00:00:00.000Z", 0},
		{"2026-03-10T00:00:00.000Z", "2026-03-10T23:59:59.999Z", 0},
		{"2026-03-10T00:00:00.000Z", "2026-03-11T00:00:00.000Z", 1},
		{"2026-03-10T12:00:00.000Z", "2026-03-11T06:00:00.000Z", 1},
		{"2026-03-10T00:00:00.000Z", "2026-03-07T00:00:00.000Z", -3},
		{"2026-03-10T00:00:00.000Z", "2026-05-09T00:00:00.000Z", 60}, // crosses a month boundary
	}
	for _, tc := range table {
		got := UTCDaysBetween(mustTimeT(tc.from), mustTimeT(tc.to))
		if got != tc.want {
			t.Fatalf("utcDaysBetween(%s → %s) = %d, want %d", tc.from, tc.to, got, tc.want)
		}
	}
}

// SPEC: 'dueSteps — cadence selection against a fake clock' → day-boundary
// table: each cadence rung opens at UTC midnight of its day.
func TestDueStepsDayBoundaryTable(t *testing.T) {
	table := []struct {
		now  string
		want []string
	}{
		{"2026-03-05T23:59:59.999Z", nil},                                              // nothing due before the pre-due window
		{"2026-03-07T00:00:00.000Z", []string{"pre_due_reminder"}},                     // D-3 exactly
		{"2026-03-07T23:59:59.999Z", []string{"pre_due_reminder"}},                     // still only the pre-due step
		{"2026-03-09T00:00:00.000Z", []string{"pre_due_reminder"}},                     // D-1
		{"2026-03-10T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request"}}, // due date
		{"2026-03-12T23:59:59.999Z", []string{"pre_due_reminder", "due_date_request"}}, // D+2
		{"2026-03-13T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request", "overdue_day_3"}},
		{"2026-03-17T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request", "overdue_day_3", "overdue_day_7"}},
		{"2026-03-24T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request", "overdue_day_3", "overdue_day_7", "overdue_day_14"}},
		{"2026-04-09T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request", "overdue_day_3", "overdue_day_7", "overdue_day_14", "overdue_day_30"}},
		{"2026-05-09T00:00:00.000Z", []string{"pre_due_reminder", "due_date_request", "overdue_day_3", "overdue_day_7", "overdue_day_14", "overdue_day_30", "overdue_day_45", "overdue_day_60"}}, // 60+ days → recovery workflow
	}
	for _, tc := range table {
		due, err := DueSteps(mustTimeT(tc.now), dunningFacts(), DefaultDunningLadder)
		if err != nil {
			t.Fatalf("now=%s: %v", tc.now, err)
		}
		got := make([]string, 0, len(due))
		for _, s := range due {
			got = append(got, s.Key)
		}
		if len(got) == 0 && len(tc.want) == 0 {
			continue
		}
		if strings.Join(got, ",") != strings.Join(tc.want, ",") {
			t.Fatalf("now=%s: due steps %v, want %v", tc.now, got, tc.want)
		}
	}
}

// SPEC: 'sentSteps idempotence: a step never fires twice' + 'a fully-sent
// subject draws nothing, even 60+ days out' + ladder-order guarantee.
func TestDueStepsSentStepsIdempotence(t *testing.T) {
	sent, err := DueSteps(mustTimeT("2026-03-10T00:00:00.000Z"), dunningFacts(), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	sentKeys := []string{"pre_due_reminder", "due_date_request"}
	if len(sent) != 2 || sent[0].Key != sentKeys[0] || sent[1].Key != sentKeys[1] {
		t.Fatalf("first selection = %v, want %v", sentKeys, sent)
	}
	// D+7: day_3 was already handled, day_7 is the only new rung.
	facts := withConsent()
	facts.SentSteps = append(sentKeys, "overdue_day_3")
	next, err := DueSteps(mustTimeT("2026-03-17T00:00:00.000Z"), facts, DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 1 || next[0].Key != "overdue_day_7" {
		t.Fatalf("D+7 selection = %d steps, want [overdue_day_7]", len(next))
	}
	// Fully-sent subject draws nothing.
	all := make([]string, 0, len(DefaultDunningLadder))
	for _, s := range DefaultDunningLadder {
		all = append(all, s.Key)
	}
	facts.SentSteps = all
	empty, err := DueSteps(mustTimeT("2026-05-20T00:00:00.000Z"), facts, DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("fully-sent subject drew %d steps", len(empty))
	}
	// Backlog comes back in ladder order (oldest-first).
	backlog, err := DueSteps(mustTimeT("2026-03-24T00:00:00.000Z"), dunningFacts(), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(backlog); i++ {
		if backlog[i].DayOffset < backlog[i-1].DayOffset {
			t.Fatalf("backlog not in ladder order at %d: %v", i, backlog)
		}
	}
	// Custom ladder works (SPEC 'works on a custom ladder').
	custom := []DunningStep{{Key: "only_call", DayOffset: 2, Kind: KindWhatsApp, Channel: ChannelWhatsApp, RequiresConsent: true}}
	due, err := DueSteps(mustTimeT("2026-03-12T00:00:00.000Z"), dunningFacts(), custom)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 || due[0].Key != "only_call" {
		t.Fatalf("custom ladder due = %v", due)
	}
	due, err = DueSteps(mustTimeT("2026-03-11T23:59:59.999Z"), dunningFacts(), custom)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 0 {
		t.Fatalf("custom ladder fired a day early: %v", due)
	}
	// SPEC: 'refuses invalid inputs (table)'.
	_, err = DueSteps(time.Time{}, dunningFacts(), DefaultDunningLadder)
	expectCode(t, err, CodeDunningClockInvalid)
	brokenFacts := dunningFacts()
	brokenFacts.DueDate = time.Time{}
	_, err = DueSteps(mustTimeT("2026-03-13T00:00:00.000Z"), brokenFacts, DefaultDunningLadder)
	expectCode(t, err, CodeDunningFactsInvalid)
}

// SPEC: 'evaluateDunningSend — the K2 decision table'.
func TestEvaluateDunningSendK2Table(t *testing.T) {
	gated := DunningStep{Key: "overdue_day_3", DayOffset: 3, Kind: KindWhatsApp, Channel: ChannelWhatsApp, RequiresConsent: true}
	open := DunningStep{Key: "overdue_day_7", DayOffset: 7, Kind: KindSMS, Channel: ChannelSMS, RequiresConsent: false}
	for _, ref := range []string{"", "   "} {
		// (TS null/undefined collapse to the Go empty string; "   " is blank.)
		if d := EvaluateDunningSend(gated, ref); d.Allowed || d.Reason != CodeDunningConsentRequired {
			t.Fatalf("gated step with ref %q must refuse DUNNING_CONSENT_REQUIRED, got %+v", ref, d)
		}
	}
	if d := EvaluateDunningSend(gated, "consent-grant-77"); !d.Allowed {
		t.Fatalf("gated step with real consent must be allowed, got %+v", d)
	}
	for _, ref := range []string{"", "consent-grant-77"} {
		if d := EvaluateDunningSend(open, ref); !d.Allowed {
			t.Fatalf("non-gated step always passes, got %+v", d)
		}
	}
	// assertDunningSendable throws the stable code only for gated-without-consent.
	expectCode(t, AssertDunningSendable(gated, ""), CodeDunningConsentRequired)
	expectCode(t, AssertDunningSendable(gated, "   "), CodeDunningConsentRequired)
	if err := AssertDunningSendable(gated, "consent-grant-77"); err != nil {
		t.Fatalf("sendable step refused: %v", err)
	}
	if err := AssertDunningSendable(open, ""); err != nil {
		t.Fatalf("open step refused: %v", err)
	}
}

// SPEC: 'orchestrateDunning — sends, refusals and the observability
// invariant'.
func TestOrchestrateDunning(t *testing.T) {
	// Emits dunning.stepDue sends with full payloads when consent exists.
	now := "2026-03-13T00:00:00.000Z"
	plan, err := OrchestrateDunning(mustTimeT(now), withConsent(), fixedClock(t, now), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Blocked) != 0 {
		t.Fatalf("consented plan blocked %d steps", len(plan.Blocked))
	}
	wantKeys := []string{"pre_due_reminder", "due_date_request", "overdue_day_3"}
	if len(plan.Sends) != len(wantKeys) {
		t.Fatalf("sends = %d, want %d", len(plan.Sends), len(wantKeys))
	}
	var whatsapp *DunningSend
	for i := range plan.Sends {
		if plan.Sends[i].Step.Key != wantKeys[i] {
			t.Fatalf("send[%d] = %s, want %s", i, plan.Sends[i].Step.Key, wantKeys[i])
		}
		if plan.Sends[i].Step.Key == "overdue_day_3" {
			whatsapp = &plan.Sends[i]
		}
	}
	if whatsapp == nil {
		t.Fatal("whatsapp send missing")
	}
	ev := whatsapp.Event
	if ev.Type != "dunning.stepDue" || ev.Version != 1 || ev.AggregateID != dunningSubject {
		t.Fatalf("envelope mismatch: %+v", ev)
	}
	if iso(ev.OccurredAt) != now {
		t.Fatalf("occurredAt = %s, want %s", iso(ev.OccurredAt), now)
	}
	payload := payloadMap(t, ev)
	for k, want := range map[string]any{
		"orgId":           dunningOrg,
		"subjectId":       dunningSubject,
		"stepKey":         "overdue_day_3",
		"dayOffset":       float64(3),
		"kind":            "whatsapp",
		"channel":         "whatsapp",
		"requiresConsent": true,
		"dueDate":         dunningDueISO,
	} {
		got, ok := payload[k]
		if !ok || got != want {
			t.Fatalf("payload[%s] = %v (%T), want %v", k, got, got, want)
		}
	}

	// Refuses consent-gated sends without consentRef — stable code +
	// observable event.
	plan, err = OrchestrateDunning(mustTimeT(now), dunningFacts(), fixedClock(t, now), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Sends) != 2 || plan.Sends[0].Step.Key != "pre_due_reminder" || plan.Sends[1].Step.Key != "due_date_request" {
		t.Fatalf("unconsented sends = %d", len(plan.Sends))
	}
	if len(plan.Blocked) != 1 || plan.Blocked[0].Step.Key != "overdue_day_3" {
		t.Fatalf("blocked = %v", plan.Blocked)
	}
	if plan.Blocked[0].Reason != CodeDunningConsentRequired {
		t.Fatalf("refusal reason = %s", plan.Blocked[0].Reason)
	}
	blocked := plan.Blocked[0].Event
	if blocked.Type != "collections.dunningBlockedNoConsent" || blocked.Version != 1 || blocked.AggregateID != dunningSubject {
		t.Fatalf("blocked envelope mismatch: %+v", blocked)
	}
	bpayload := payloadMap(t, blocked)
	for k, want := range map[string]any{
		"orgId":     dunningOrg,
		"subjectId": dunningSubject,
		"stepKey":   "overdue_day_3",
		"channel":   "whatsapp",
		"blockedAt": now,
	} {
		if got := bpayload[k]; got != want {
			t.Fatalf("blocked payload[%s] = %v, want %v", k, got, want)
		}
	}

	// Partitions every due step into exactly one of sends | blocked (60-day
	// backlog): 7 sends + exactly the whatsapp step blocked.
	plan, err = OrchestrateDunning(mustTimeT("2026-05-09T00:00:00.000Z"), dunningFacts(), fixedClock(t, "2026-05-09T00:00:00.000Z"), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Sends) != 7 {
		t.Fatalf("60-day backlog sends = %d, want 7", len(plan.Sends))
	}
	if len(plan.Blocked) != 1 || plan.Blocked[0].Step.Key != "overdue_day_3" {
		t.Fatalf("60-day backlog blocked = %v", plan.Blocked)
	}
	// The same tick with consent sends everything (no residual blocks).
	plan, err = OrchestrateDunning(mustTimeT("2026-05-09T00:00:00.000Z"), withConsent(), fixedClock(t, "2026-05-09T00:00:00.000Z"), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Blocked) != 0 || len(plan.Sends) != 8 {
		t.Fatalf("consented 60-day plan: sends=%d blocked=%d, want 8/0", len(plan.Sends), len(plan.Blocked))
	}

	// Honours sentSteps so the scheduler cannot double-send.
	first, err := OrchestrateDunning(mustTimeT("2026-03-10T00:00:00.000Z"), withConsent(), fixedClock(t, "2026-03-10T00:00:00.000Z"), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	sentKeys := make([]string, 0, len(first.Sends))
	for _, s := range first.Sends {
		sentKeys = append(sentKeys, s.Step.Key)
	}
	secondFacts := withConsent()
	secondFacts.SentSteps = sentKeys
	next, err := OrchestrateDunning(mustTimeT("2026-03-10T12:00:00.000Z"), secondFacts, fixedClock(t, "2026-03-10T12:00:00.000Z"), DefaultDunningLadder)
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Sends) != 0 || len(next.Blocked) != 0 {
		t.Fatalf("sentSteps not honoured: sends=%d blocked=%d", len(next.Sends), len(next.Blocked))
	}

	// Supports custom ladders end to end.
	custom := []DunningStep{
		{Key: "call_day_1", DayOffset: 1, Kind: KindWhatsApp, Channel: ChannelWhatsApp, RequiresConsent: true},
		{Key: "sms_day_2", DayOffset: 2, Kind: KindSMS, Channel: ChannelSMS, RequiresConsent: false},
	}
	plan, err = OrchestrateDunning(mustTimeT("2026-03-12T00:00:00.000Z"), dunningFacts(), fixedClock(t, "2026-03-12T00:00:00.000Z"), custom)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Sends) != 1 || plan.Sends[0].Step.Key != "sms_day_2" {
		t.Fatalf("custom sends = %v", plan.Sends)
	}
	if len(plan.Blocked) != 1 || plan.Blocked[0].Step.Key != "call_day_1" {
		t.Fatalf("custom blocked = %v", plan.Blocked)
	}
}

// SPEC: 'escalationDue — no-response windows' (all tables) and
// 'dunningEscalatedEvent carries the wait evidence and refuses premature
// escalation'.
func TestEscalationDue(t *testing.T) {
	escalationFacts := func(over func(*DunningEscalationFacts)) DunningEscalationFacts {
		f := DunningEscalationFacts{
			StepKey:   "overdue_day_3",
			Channel:   ChannelWhatsApp,
			SubjectID: dunningSubject,
			OrgID:     dunningOrg,
		}
		if over != nil {
			over(&f)
		}
		return f
	}
	send := mustTimeT("2026-03-13T00:00:00.000Z")

	// Nothing sent — nothing to escalate.
	due, err := EscalationDue(mustTimeT("2026-04-30T00:00:00.000Z"), escalationFacts(nil))
	if err != nil || due {
		t.Fatalf("no-send escalation = %v, %v", due, err)
	}
	// Fires only after N whole days without a response (default 3).
	if DefaultEscalationAfterDays != 3 {
		t.Fatalf("DEFAULT_ESCALATION_AFTER_DAYS = %d, want 3", DefaultEscalationAfterDays)
	}
	table := []struct {
		now  string
		want bool
	}{
		{"2026-03-13T00:00:00.000Z", false}, // +0 days
		{"2026-03-14T00:00:00.000Z", false}, // +1
		{"2026-03-15T00:00:00.000Z", false}, // +2
		{"2026-03-16T00:00:00.000Z", true},  // +3 — the boundary
		{"2026-03-20T00:00:00.000Z", true},  // +7
	}
	for _, tc := range table {
		facts := escalationFacts(func(f *DunningEscalationFacts) { f.LastSendAt = &send })
		due, err := EscalationDue(mustTimeT(tc.now), facts)
		if err != nil {
			t.Fatalf("now=%s: %v", tc.now, err)
		}
		if due != tc.want {
			t.Fatalf("now=%s: escalationDue = %v, want %v", tc.now, due, tc.want)
		}
	}
	// A response AFTER the last send cancels escalation; one BEFORE does not.
	responseAfter := mustTimeT("2026-03-14T00:00:00.000Z")
	responseBefore := mustTimeT("2026-03-10T00:00:00.000Z")
	due, err = EscalationDue(mustTimeT("2026-03-20T00:00:00.000Z"), escalationFacts(func(f *DunningEscalationFacts) {
		f.LastSendAt, f.LastResponseAt = &send, &responseAfter
	}))
	if err != nil || due {
		t.Fatalf("response-after-send escalated: %v %v", due, err)
	}
	due, err = EscalationDue(mustTimeT("2026-03-20T00:00:00.000Z"), escalationFacts(func(f *DunningEscalationFacts) {
		f.LastSendAt, f.LastResponseAt = &send, &responseBefore
	}))
	if err != nil || !due {
		t.Fatalf("response-before-send did not escalate: %v %v", due, err)
	}
	// Honours a configurable window (facts-driven).
	windowTable := []struct {
		days int
		now  string
		want bool
	}{
		{7, "2026-03-19T23:59:59.999Z", false},
		{7, "2026-03-20T00:00:00.000Z", true},
		{0, "2026-03-13T00:00:00.000Z", true},
		{30, "2026-04-12T00:00:00.000Z", true},
	}
	for _, tc := range windowTable {
		days := tc.days
		facts := escalationFacts(func(f *DunningEscalationFacts) { f.LastSendAt = &send; f.EscalationAfterDays = &days })
		due, err := EscalationDue(mustTimeT(tc.now), facts)
		if err != nil {
			t.Fatalf("days=%d now=%s: %v", tc.days, tc.now, err)
		}
		if due != tc.want {
			t.Fatalf("days=%d now=%s: escalationDue = %v, want %v", tc.days, tc.now, due, tc.want)
		}
	}
	// Refuses invalid windows.
	expectCode(t, funcErr(func() error {
		_, err := EscalationDue(mustTimeT("2026-03-20T00:00:00.000Z"), escalationFacts(func(f *DunningEscalationFacts) {
			f.LastSendAt = &send
			days := -1
			f.EscalationAfterDays = &days
		}))
		return err
	}), CodeDunningEscalationInvalid)

	// dunningEscalatedEvent refuses premature escalation, carries evidence.
	premature := escalationFacts(func(f *DunningEscalationFacts) { f.LastSendAt = &send })
	expectCode(t, funcErr(func() error {
		_, err := DunningEscalatedEvent(mustTimeT("2026-03-15T00:00:00.000Z"), premature, fixedClock(t, "2026-03-15T00:00:00.000Z"))
		return err
	}), CodeDunningEscalationNotDue)
	ev, err := DunningEscalatedEvent(mustTimeT("2026-03-16T00:00:00.000Z"), escalationFacts(func(f *DunningEscalationFacts) { f.LastSendAt = &send }), fixedClock(t, "2026-03-16T00:00:00.000Z"))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != "dunning.escalated" || ev.AggregateID != dunningSubject {
		t.Fatalf("escalation envelope mismatch: %+v", ev)
	}
	for k, want := range map[string]any{
		"orgId":       dunningOrg,
		"subjectId":   dunningSubject,
		"stepKey":     "overdue_day_3",
		"channel":     "whatsapp",
		"lastSendAt":  "2026-03-13T00:00:00.000Z",
		"waitedDays":  float64(3),
		"escalatedAt": "2026-03-16T00:00:00.000Z",
	} {
		if got := payloadMap(t, ev)[k]; got != want {
			t.Fatalf("escalation payload[%s] = %v, want %v", k, got, want)
		}
	}
}

func funcErr(fn func() error) error { return fn() }

// --- shared test helpers -------------------------------------------------------

func timeDay(n int) time.Duration { return time.Duration(n) * 24 * time.Hour }

func msDuration(ms int64) time.Duration { return time.Duration(ms) * time.Millisecond }

func timeZero() time.Time { return time.Time{} }
