package scheduler

// Orchestration tests for the four production jobs (jobs.go): each job's
// transitions executed against fake repo ports, driven by a steppable clock.
// The parity fixtures live in the pure-port tests (dunning_test.go,
// latefee_test.go, plans_test.go, aging_test.go — each cites its TS source);
// this file pins the EXECUTION contract on top of them:
//
//   - re-running the same tick (or the same accrual period / aging window)
//     performs no double effects — every effect is claimed first-write-wins
//     before its event is recorded (AC2; the real Store proves the same
//     against idempotency_keys + outbox_events in store_test.go);
//   - the steppable clock advances the ladders/windows exactly as the TS
//     sources' day arithmetic says (dunning.ts dueSteps, late-fee.ts
//     accrueLateFee periodKey, payment-plan.ts daysLateOf, projections/
//     aging.ts arAgingByBucket asOf);
//   - per-row refusals are counted as Skipped, never fatal.
//
// SOURCES (the TS modules the jobs execute):
//      src/domain/promises/dunning.ts            (orchestrateDunning + K2 gate)
//      src/domain/receivables/late-fee.ts        (accrueLateFee + H4 idempotency)
//      src/domain/receivables/payment-plan.ts    (markPlanDefaulted trigger search)
//      src/domain/projections/aging.ts           (arAgingByBucket snapshot)

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// --- steppable clock -------------------------------------------------------

// stepClock is the deterministic steppable clock: the jobs read Now() at
// every tick and tests Step() it between runs — no wall clock anywhere.
type stepClock struct {
	mu  sync.Mutex
	now time.Time
}

func newStepClock(iso string) *stepClock { return &stepClock{now: mustTimeT(iso)} }

func (c *stepClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *stepClock) Step(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// --- shared fake claim registry (the idempotency_keys stand-in) ------------

// claimRegistry is the fake of the durable first-write-wins registry: an
// effect is claimed per (org, scope, key) and its event recorded in the same
// "transaction" (the mutex critical section) — exactly the Store's
// ClaimAndEmit shape, in memory.
type claimRegistry struct {
	mu     sync.Mutex
	claims map[string]bool
	events []Event
}

func newClaimRegistry() *claimRegistry {
	return &claimRegistry{claims: make(map[string]bool)}
}

func claimID(orgID, scope, key string) string { return orgID + "|" + scope + "|" + key }

func (r *claimRegistry) claimAndEmit(orgID, scope, key string, ev Event) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := claimID(orgID, scope, key)
	if r.claims[id] {
		return false, nil
	}
	r.claims[id] = true
	r.events = append(r.events, ev)
	return true, nil
}

// claimedKeys returns the subset of keys already claimed for (org, scope) —
// the SentSteps stand-in.
func (r *claimRegistry) claimedKeys(orgID, scope string, keys []string) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var sent []string
	for _, key := range keys {
		if r.claims[claimID(orgID, scope, key)] {
			sent = append(sent, key)
		}
	}
	return sent
}

func (r *claimRegistry) eventTypes() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.events))
	for _, ev := range r.events {
		out = append(out, ev.Type)
	}
	sort.Strings(out)
	return out
}

func (r *claimRegistry) count(typ string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, ev := range r.events {
		if ev.Type == typ {
			n++
		}
	}
	return n
}

// eventTypesInOrder returns the event types in claim order (no sort).
func (r *claimRegistry) eventTypesInOrder() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.events))
	for _, ev := range r.events {
		out = append(out, ev.Type)
	}
	return out
}

// --- fake repos ------------------------------------------------------------

type fakeDunningRepo struct {
	reg      *claimRegistry
	subjects []DunningSubject
	consents map[string]string // org|customer|channel → consent grant ref ("" = none)
}

func (f *fakeDunningRepo) ClaimAndEmit(_ context.Context, orgID, scope, key, _ string, ev Event) (bool, error) {
	return f.reg.claimAndEmit(orgID, scope, key, ev)
}

func (f *fakeDunningRepo) DunningSubjects(_ context.Context, horizon time.Time, limit int) ([]DunningSubject, error) {
	var out []DunningSubject
	for _, s := range f.subjects {
		if !s.DueDate.After(horizon) {
			out = append(out, s)
		}
		if len(out) == limit {
			break
		}
	}
	return out, nil
}

func (f *fakeDunningRepo) ConsentRef(_ context.Context, orgID, customerID, channel string, _ time.Time) (string, error) {
	return f.consents[strings.Join([]string{orgID, customerID, channel}, "|")], nil
}

func (f *fakeDunningRepo) SentSteps(_ context.Context, orgID string, sendKeys []string) ([]string, error) {
	return f.reg.claimedKeys(orgID, claimScopeDun, sendKeys), nil
}

type fakeLateFeeRepo struct {
	reg         *claimRegistry
	receivables []LateFeeReceivableRow
}

func (f *fakeLateFeeRepo) ClaimAndEmit(_ context.Context, orgID, scope, key, _ string, ev Event) (bool, error) {
	return f.reg.claimAndEmit(orgID, scope, key, ev)
}

func (f *fakeLateFeeRepo) OverdueReceivables(_ context.Context, _ time.Time, limit int) ([]LateFeeReceivableRow, error) {
	if len(f.receivables) > limit {
		return f.receivables[:limit], nil
	}
	return f.receivables, nil
}

type fakePlanRepo struct {
	reg          *claimRegistry
	dueAdvanced  []DueInstallment
	plans        []PlanRow
	installments map[string][]PlanInstallment // planID → schedule
	defaulted    map[string]bool              // planID → already terminal
}

func (f *fakePlanRepo) ClaimAndEmit(_ context.Context, orgID, scope, key, _ string, ev Event) (bool, error) {
	return f.reg.claimAndEmit(orgID, scope, key, ev)
}

func (f *fakePlanRepo) AdvanceDueInstallments(_ context.Context, _ time.Time, _ int) ([]DueInstallment, error) {
	out := f.dueAdvanced
	f.dueAdvanced = nil // claimed rows leave the scan — the SKIP LOCKED shape
	return out, nil
}

func (f *fakePlanRepo) DefaultCandidates(_ context.Context, _ time.Time, _ int) ([]PlanRow, error) {
	var out []PlanRow
	for _, p := range f.plans {
		if !f.defaulted[p.PlanID] {
			out = append(out, p)
		}
	}
	return out, nil
}

func (f *fakePlanRepo) UnpaidInstallments(_ context.Context, _ string, planID string) ([]PlanInstallment, error) {
	return f.installments[planID], nil
}

func (f *fakePlanRepo) DefaultPlan(_ context.Context, orgID string, planID string, ev Event) (bool, error) {
	if f.defaulted[planID] {
		return false, nil // terminal plans are dead to the job (state guard)
	}
	// The real store appends the event in the SAME transaction as the guarded
	// UPDATE — the fake mirrors that shape.
	if _, err := f.reg.claimAndEmit(orgID, "scheduler.plan.default", planID, ev); err != nil {
		return false, err
	}
	f.defaulted[planID] = true
	return true, nil
}

type fakeAgingRepo struct {
	reg   *claimRegistry
	orgs  []string
	facts map[string][]AgingFact
}

func (f *fakeAgingRepo) ClaimAndEmit(_ context.Context, orgID, scope, key, _ string, ev Event) (bool, error) {
	return f.reg.claimAndEmit(orgID, scope, key, ev)
}

func (f *fakeAgingRepo) SnapshotOrgs(_ context.Context, _ int) ([]string, error) { return f.orgs, nil }

func (f *fakeAgingRepo) OrgAgingFacts(_ context.Context, orgID string) ([]AgingFact, error) {
	return f.facts[orgID], nil
}

// --- ids --------------------------------------------------------------------

var (
	jobOrgA  = "00000000-0000-4000-8000-0000000000a1"
	jobOrgB  = "00000000-0000-4000-8000-0000000000b2"
	jobCustA = "00000000-0000-4000-8000-0000000000c1"
	jobSubjA = "00000000-0000-4000-8000-0000000000d1"
	jobSubjB = "00000000-0000-4000-8000-0000000000d2"
	jobPlanA = "00000000-0000-4000-8000-0000000000e1"
	jobSubjC = "00000000-0000-4000-8000-0000000000d3"
)

// --- dunning job -------------------------------------------------------------

// The dunning job advances SPEC §18's ladder: at now = due + 4 days an
// untouched subject is due pre_due_reminder (−3), due_date_request (0) and
// overdue_day_3 (+3); whatsapp requires consent (K2), email does not
// (dunning.ts DEFAULT_DUNNING_LADDER + evaluateDunningSend).
func TestRunDunningSendsAndBlocks(t *testing.T) {
	clock := newStepClock("2026-03-14T00:00:00.000Z") // due 2026-03-10 → day 4
	reg := newClaimRegistry()
	repo := &fakeDunningRepo{
		reg: reg,
		subjects: []DunningSubject{
			{ReceivableID: jobSubjA, OrgID: jobOrgA, CustomerID: jobCustA, DueDate: mustTimeT(dunningDueISO)},
		},
		consents: map[string]string{}, // no grants — K2 blocks whatsapp
	}

	stats, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 100)
	if err != nil {
		t.Fatalf("RunDunning: %v", err)
	}
	// Day 4: pre_due_reminder, due_date_request, overdue_day_3 are due. The
	// whatsapp step (+3) is consent-gated → blocked; the two email steps send.
	// (Ladder order: the sends go first, the refusal last.)
	if got := reg.count("dunning.stepDue"); got != 2 {
		t.Fatalf("expected 2 dunning.stepDue sends (pre_due_reminder + due_date_request), got %d (%v)", got, reg.eventTypes())
	}
	if got := reg.count("collections.dunningBlockedNoConsent"); got != 1 {
		t.Fatalf("expected 1 K2 refusal fact, got %d", got)
	}
	if stats.Emitted != 3 || stats.Claimed != 3 || stats.Scanned != 1 {
		t.Fatalf("stats = %+v, want scanned=1 claimed=3 emitted=3", stats)
	}

	// The sends carry the step evidence (dunning.ts orchestrateDunning →
	// dunning.stepDue payload: stepKey/dayOffset/kind/channel).
	var sendStepKeys []string
	for _, ev := range reg.events {
		if ev.Type != "dunning.stepDue" {
			continue
		}
		var payload DunningStepDuePayload
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatalf("unmarshal stepDue payload: %v", err)
		}
		if payload.SubjectID != jobSubjA || payload.OrgID != jobOrgA {
			t.Fatalf("payload identity = %+v", payload)
		}
		if payload.DueDate != dunningDueISO {
			t.Fatalf("dueDate = %s, want %s", payload.DueDate, dunningDueISO)
		}
		sendStepKeys = append(sendStepKeys, payload.StepKey)
	}
	sort.Strings(sendStepKeys)
	if want := []string{"due_date_request", "pre_due_reminder"}; fmt.Sprint(sendStepKeys) != fmt.Sprint(want) {
		t.Fatalf("sent steps = %v, want %v", sendStepKeys, want)
	}
}

// Re-running the same tick is a no-op (AC2): the sentSteps set now covers the
// sent steps, and the blocked refusal was claimed once — a re-run emits
// nothing, even with the clock untouched.
func TestRunDunningSameTickIdempotent(t *testing.T) {
	clock := newStepClock("2026-03-14T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakeDunningRepo{
		reg: reg,
		subjects: []DunningSubject{
			{ReceivableID: jobSubjA, OrgID: jobOrgA, CustomerID: jobCustA, DueDate: mustTimeT(dunningDueISO)},
		},
	}

	for i := 0; i < 3; i++ {
		if _, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 100); err != nil {
			t.Fatalf("run %d: %v", i, err)
		}
	}
	if got := len(reg.events); got != 3 {
		t.Fatalf("three runs of the same tick emitted %d events, want exactly 3 (the first run's)", got)
	}
}

// The steppable clock drives the ladder across days: each new UTC day makes
// the next overdue step due, and the sentSteps idempotence keeps the older
// ones silent (dunning.ts dueSteps — dayOffset table).
func TestRunDunningLadderAdvancesWithClock(t *testing.T) {
	clock := newStepClock("2026-03-14T00:00:00.000Z") // day 4
	reg := newClaimRegistry()
	repo := &fakeDunningRepo{
		reg: reg,
		subjects: []DunningSubject{
			{ReceivableID: jobSubjA, OrgID: jobOrgA, CustomerID: jobCustA, DueDate: mustTimeT(dunningDueISO)},
		},
		consents: map[string]string{}, // no grants yet — K2 blocks whatsapp
	}

	runs := map[int][]string{ // day → event types in emission (ladder) order
		4:  {"dunning.stepDue", "dunning.stepDue", "collections.dunningBlockedNoConsent"},
		7:  {"dunning.stepDue"}, // overdue_day_7 sms (no consent needed)
		14: {"dunning.stepDue"}, // overdue_day_14 collector task
		30: {"dunning.stepDue"}, // overdue_day_30 manager escalation
	}
	day := 4
	for {
		types, ok := runs[day]
		if ok {
			before := len(reg.events)
			if _, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 100); err != nil {
				t.Fatalf("day %d: %v", day, err)
			}
			got := reg.eventTypesInOrder()[before:]
			if fmt.Sprint(got) != fmt.Sprint(types) {
				t.Fatalf("day %d emitted %v, want %v", day, got, types)
			}
		}
		if day >= 30 {
			break
		}
		clock.Step(timeDay(1))
		day++
	}

	// A consent granted late still lets the whatsapp step send on a later run:
	// the step stays due (its SEND key was never claimed — only the refusal key
	// was; jobs.go dunningSendKey vs dunningBlockedKey), so the next run after
	// the grant pushes it through.
	repo.consents[strings.Join([]string{jobOrgA, jobCustA, ChannelWhatsApp}, "|")] = "grant-9"
	clock.Step(timeDay(1)) // day 31 — the overdue_day_3 send is still pending
	before := len(reg.events)
	if _, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 100); err != nil {
		t.Fatalf("post-consent run: %v", err)
	}
	if got := reg.eventTypesInOrder()[before:]; len(got) != 1 || got[0] != "dunning.stepDue" {
		t.Fatalf("late consent must still send the whatsapp step, got %v", got)
	}
}

// Multiple subjects are independent: each subject's sentSteps set is its own
// (the claim keys carry the subject id; the org scopes the registry row).
func TestRunDunningSubjectsIndependent(t *testing.T) {
	clock := newStepClock("2026-03-14T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakeDunningRepo{
		reg: reg,
		subjects: []DunningSubject{
			{ReceivableID: jobSubjA, OrgID: jobOrgA, CustomerID: jobCustA, DueDate: mustTimeT(dunningDueISO)},
			{ReceivableID: jobSubjB, OrgID: jobOrgB, CustomerID: jobCustA, DueDate: mustTimeT(dunningDueISO)},
		},
	}
	if _, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 100); err != nil {
		t.Fatalf("RunDunning: %v", err)
	}
	// Each subject got its own two email sends.
	sendsBySubject := map[string]int{}
	for _, ev := range reg.events {
		if ev.Type != "dunning.stepDue" {
			continue
		}
		var p DunningStepDuePayload
		if err := json.Unmarshal(ev.Payload, &p); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		sendsBySubject[p.SubjectID]++
	}
	if sendsBySubject[jobSubjA] != 2 || sendsBySubject[jobSubjB] != 2 {
		t.Fatalf("sends by subject = %v, want two per subject", sendsBySubject)
	}
	// A subject's steps never leak into the other org's claim registry:
	// probing subject A's key under org B finds nothing.
	leaked, err := repo.SentSteps(context.Background(), jobOrgB,
		[]string{dunningSendKey(jobSubjA, "pre_due_reminder"), dunningSendKey(jobSubjA, "due_date_request")})
	if err != nil {
		t.Fatalf("SentSteps probe: %v", err)
	}
	if len(leaked) != 0 {
		t.Fatalf("subject A's sends leaked into org B: %v", leaked)
	}
}

func TestRunDunningConfigRefusals(t *testing.T) {
	clock := newStepClock("2026-03-14T00:00:00.000Z")
	repo := &fakeDunningRepo{reg: newClaimRegistry()}
	if _, err := RunDunning(context.Background(), repo, clock, nil, 10); !hasCode(err, CodeDunningLadderInvalid) {
		t.Fatalf("empty ladder: want %s, got %v", CodeDunningLadderInvalid, err)
	}
	if _, err := RunDunning(context.Background(), repo, clock, DefaultDunningLadder, 0); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("batch 0: want %s, got %v", CodeConfigInvalid, err)
	}
}

func hasCode(err error, code string) bool {
	if err == nil {
		return false
	}
	var e *Error
	if asSchedError(err, &e) {
		return e.Code == code
	}
	return false
}

// --- late-fee job -------------------------------------------------------------

// The late-fee job charges the accrual period once: percent 333 bps on a
// 123457 balance floors to 4111 (late-fee.spec.ts's own fixture — see
// latefee_test.go TestAccrueLateFeeAmounts), the event carries the H4
// idempotency scope (receivableId, periodKey) and the posting matrix row.
func TestRunLateFeeAccruesOncePerPeriod(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakeLateFeeRepo{reg: reg, receivables: []LateFeeReceivableRow{
		{OrgID: jobOrgA, Like: owing(nil)},
	}}
	// owing() defaults: id receivable-1? Pin the id the claim key uses.
	repo.receivables[0].Like.ID = jobSubjA
	repo.receivables[0].Like.Original = mustMoney(123457, money.KES)
	repo.receivables[0].Like.Applied = mustMoney(0, money.KES)
	repo.receivables[0].Like.DueDate = mustTimeT("2026-02-01T00:00:00.000Z") // 40 days late
	repo.receivables[0].Like.Overdue = true
	repo.receivables[0].Like.State = "open"

	policy := LateFeePolicy{Kind: LateFeePercent, PercentBps: intPtr(333), GraceDays: 5}
	stats, err := RunLateFee(context.Background(), repo, clock, policy, 100)
	if err != nil {
		t.Fatalf("RunLateFee: %v", err)
	}
	if stats.Emitted != 1 || stats.Claimed != 1 || stats.Scanned != 1 {
		t.Fatalf("stats = %+v, want one claimed+emitted effect", stats)
	}
	if len(reg.events) != 1 || reg.events[0].Type != "receivable.lateFeeAccrued" {
		t.Fatalf("events = %v", reg.eventTypes())
	}
	var payload LateFeeAccruedPayload
	if err := json.Unmarshal(reg.events[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if payload.AmountMinor != 4111 { // 123457 × 333 / 10000 floored — late-fee.spec.ts
		t.Fatalf("amountMinor = %d, want 4111", payload.AmountMinor)
	}
	if payload.PeriodKey != "2026-03" {
		t.Fatalf("periodKey = %s, want 2026-03 (the accrual month)", payload.PeriodKey)
	}
	if payload.DaysLate != 40 || payload.GraceDays != 5 {
		t.Fatalf("daysLate/grace = %d/%d", payload.DaysLate, payload.GraceDays)
	}
	if payload.Posting.Debit != "ar_control" || payload.Posting.Credit != "fee_income" {
		t.Fatalf("posting = %+v", payload.Posting)
	}
	if payload.BalanceMinor != 123457 || payload.Currency != "KES" || payload.PolicyKind != "percent" {
		t.Fatalf("payload = %+v", payload)
	}

	// Same tick again: the claim registry already holds (receivable, period) —
	// no double charge (H4, executed).
	stats, err = RunLateFee(context.Background(), repo, clock, policy, 100)
	if err != nil {
		t.Fatalf("re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Skipped != 1 {
		t.Fatalf("re-run stats = %+v, want skipped=1 emitted=0", stats)
	}
	if len(reg.events) != 1 {
		t.Fatalf("re-run doubled the fee: %d events", len(reg.events))
	}

	// Next period: the clock steps into April — a new accrual, claimed once.
	clock.Step(timeDay(20)) // 2026-04-02
	stats, err = RunLateFee(context.Background(), repo, clock, policy, 100)
	if err != nil {
		t.Fatalf("next period: %v", err)
	}
	if stats.Emitted != 1 {
		t.Fatalf("next period stats = %+v, want one new accrual", stats)
	}
	if reg.count("receivable.lateFeeAccrued") != 2 {
		t.Fatalf("period accruals = %d, want 2 (one per period)", reg.count("receivable.lateFeeAccrued"))
	}
}

// Business-as-usual refusals are counted, never fatal: within grace, zero
// balance, not live (late-fee.ts accrueLateFee refusal ladder).
func TestRunLateFeeSkipsBusinessAsUsual(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()

	inGrace := owing(func(r *LateFeeReceivableLike) {
		r.ID = jobSubjA
		r.Original = mustMoney(100000, money.KES)
		r.Applied = mustMoney(0, money.KES)
		r.DueDate = mustTimeT("2026-03-10T00:00:00.000Z") // 3 days late < grace 5
		r.Overdue = false
		r.State = "open"
	})
	settled := owing(func(r *LateFeeReceivableLike) {
		r.ID = jobSubjB
		r.Original = mustMoney(50000, money.KES)
		r.Applied = mustMoney(50000, money.KES)
		r.DueDate = mustTimeT("2026-01-01T00:00:00.000Z")
		r.Overdue = true
		r.State = "partially_paid" // state live, but balance zero → refusal
	})

	repo := &fakeLateFeeRepo{reg: reg, receivables: []LateFeeReceivableRow{
		{OrgID: jobOrgA, Like: inGrace},
		{OrgID: jobOrgA, Like: settled},
	}}
	policy := LateFeePolicy{Kind: LateFeePercent, PercentBps: intPtr(150), GraceDays: 5}
	stats, err := RunLateFee(context.Background(), repo, clock, policy, 100)
	if err != nil {
		t.Fatalf("RunLateFee: %v", err)
	}
	if stats.Skipped != 2 || stats.Emitted != 0 {
		t.Fatalf("stats = %+v, want both skipped", stats)
	}
	if len(reg.events) != 0 {
		t.Fatalf("refusals must not emit: %v", reg.eventTypes())
	}
}

func TestRunLateFeeConfigRefusals(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	repo := &fakeLateFeeRepo{reg: newClaimRegistry()}
	if _, err := RunLateFee(context.Background(), repo, clock, LateFeePolicy{Kind: "bogus"}, 10); !hasCode(err, CodeLateFeePolicyKindInvalid) {
		t.Fatalf("bogus kind: want %s, got %v", CodeLateFeePolicyKindInvalid, err)
	}
	if _, err := RunLateFee(context.Background(), repo, clock, LateFeePolicy{Kind: LateFeeFlat}, 10); !hasCode(err, CodeLateFeePolicyFlatRequired) {
		t.Fatalf("flat without amount: want %s, got %v", CodeLateFeePolicyFlatRequired, err)
	}
}

// --- plan job -------------------------------------------------------------

// The plan job executes payment-plan.ts's two scheduler transitions: scheduled
// → due advancement (the store claims rows; the fake returns the claimed set)
// and active → defaulted when an unpaid installment crossed the grace window
// ("defaults at exactly N and refuses at N−1" — plans_test.go pins the pure
// search; here the job wires it to the guarded DefaultPlan claim).
func TestRunPlanDueAdvancementAndDefault(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakePlanRepo{
		reg: reg,
		dueAdvanced: []DueInstallment{
			{OrgID: jobOrgA, PlanID: jobPlanA, InstallmentNo: 2},
		},
		plans: []PlanRow{{
			PlanID: jobPlanA, OrgID: jobOrgA, CustomerID: jobCustA, GraceDays: 10,
		}},
		installments: map[string][]PlanInstallment{
			jobPlanA: {
				{No: 1, DueDate: mustTimeT("2026-03-03T00:00:00.000Z"), AmountMinor: 5000, PaidMinor: 0}, // 10 days late — day N counts
				{No: 2, DueDate: mustTimeT("2026-04-01T00:00:00.000Z"), AmountMinor: 5000, PaidMinor: 0},
			},
		},
		defaulted: make(map[string]bool),
	}

	stats, err := RunPlan(context.Background(), repo, clock, 100)
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}
	if stats.Scanned != 2 || stats.Emitted != 1 || stats.Claimed != 1 {
		t.Fatalf("stats = %+v, want 1 due advanced + 1 default", stats)
	}
	if len(reg.events) != 1 || reg.events[0].Type != "paymentplan.defaulted" {
		t.Fatalf("events = %v", reg.eventTypes())
	}
	var payload PlanDefaultedPayload
	if err := json.Unmarshal(reg.events[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if payload.PlanID != jobPlanA || payload.CustomerID != jobCustA {
		t.Fatalf("identity = %+v", payload)
	}
	if payload.InstallmentNo != 1 || payload.DaysOverdue != 10 || payload.DefaultAfterDays != 10 {
		t.Fatalf("trigger = %+v, want installment 1 at day 10 of 10", payload)
	}

	// Re-run: the plan is defaulted now (the state guard) and the due
	// installment has left the scan — a same-tick re-run does nothing.
	stats, err = RunPlan(context.Background(), repo, clock, 100)
	if err != nil {
		t.Fatalf("re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Scanned != 0 {
		t.Fatalf("re-run stats = %+v, want a clean no-op", stats)
	}
	if len(reg.events) != 1 {
		t.Fatalf("re-run emitted a second default: %v", reg.eventTypes())
	}
}

// A plan whose unpaid installment is overdue by grace−1 days must NOT default
// (payment-plan.ts markPlanDefaulted: day N−1 refuses). The scan prefilter in
// the store mirrors the boundary; the fake's DefaultCandidates mirrors the
// same superset, so the pure search refuses with PAYMENT_PLAN_NOT_DEFAULTABLE
// and the job counts it as Skipped.
func TestRunPlanRefusesBelowGraceBoundary(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakePlanRepo{
		reg:   reg,
		plans: []PlanRow{{PlanID: jobPlanA, OrgID: jobOrgA, CustomerID: jobCustA, GraceDays: 10}},
		installments: map[string][]PlanInstallment{
			jobPlanA: {
				{No: 1, DueDate: mustTimeT("2026-03-04T00:00:00.000Z"), AmountMinor: 5000, PaidMinor: 0}, // 9 days late
			},
		},
		defaulted: make(map[string]bool),
	}
	stats, err := RunPlan(context.Background(), repo, clock, 100)
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}
	if stats.Skipped != 1 || stats.Emitted != 0 {
		t.Fatalf("stats = %+v, want the boundary refusal skipped", stats)
	}
	if len(reg.events) != 0 {
		t.Fatalf("no default below the window: %v", reg.eventTypes())
	}
}

// Fully-paid installments never trigger a default, even deeply late
// (payment-plan.ts unpaidInstallmentsOf → markPlanDefaulted).
func TestRunPlanFullyPaidNeverDefaults(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakePlanRepo{
		reg:   reg,
		plans: []PlanRow{{PlanID: jobPlanA, OrgID: jobOrgA, CustomerID: jobCustA, GraceDays: 10}},
		installments: map[string][]PlanInstallment{
			jobPlanA: {
				{No: 1, DueDate: mustTimeT("2026-01-01T00:00:00.000Z"), AmountMinor: 5000, PaidMinor: 5000},
			},
		},
		defaulted: make(map[string]bool),
	}
	// The fake's DefaultCandidates is the honest superset: a plan with only
	// fully-paid installments never surfaces (the store's EXISTS prefilter
	// requires paid_minor < amount_minor). Simulate the scan agreeing.
	repo.plans = nil
	stats, err := RunPlan(context.Background(), repo, clock, 100)
	if err != nil {
		t.Fatalf("RunPlan: %v", err)
	}
	if stats.Scanned != 0 || stats.Emitted != 0 {
		t.Fatalf("stats = %+v, want nothing to do", stats)
	}
	if len(reg.events) != 0 {
		t.Fatalf("fully-paid plan must never default: %v", reg.eventTypes())
	}
}

func TestRunPlanConfigRefusal(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	repo := &fakePlanRepo{reg: newClaimRegistry(), defaulted: make(map[string]bool)}
	if _, err := RunPlan(context.Background(), repo, clock, 0); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("batch 0: want %s, got %v", CodeConfigInvalid, err)
	}
}

// --- aging job -------------------------------------------------------------

// The aging job materializes per-org snapshots: bucket totals with evidence,
// zero-balance facts skipped (projections/aging.ts arAgingByBucket), claimed
// per (org, run window).
func TestRunAgingSnapshotsPerOrg(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakeAgingRepo{
		reg:  reg,
		orgs: []string{jobOrgA, jobOrgB},
		facts: map[string][]AgingFact{
			jobOrgA: {
				agingFact(jobSubjA, money.KES, mustTimeT("2026-03-10T00:00:00.000Z"), 10000), // 3 days → 1-30
				agingFact(jobSubjB, money.KES, mustTimeT("2026-01-25T00:00:00.000Z"), 20000), // 47 days → 31-60
				agingFact(jobSubjC, money.KES, mustTimeT("2026-03-13T00:00:00.000Z"), 30000), // due now → current
			},
			jobOrgB: {
				agingFact(jobSubjA, money.USD, mustTimeT("2025-11-01T00:00:00.000Z"), 500), // 132 days → 90+
			},
		},
	}

	stats, err := RunAging(context.Background(), repo, clock, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("RunAging: %v", err)
	}
	if stats.Scanned != 2 || stats.Emitted != 2 || stats.Claimed != 2 {
		t.Fatalf("stats = %+v, want both orgs snapshotted", stats)
	}
	if reg.count("projections.agingSnapshotTaken") != 2 {
		t.Fatalf("events = %v", reg.eventTypes())
	}
	for _, ev := range reg.events {
		var payload AgingSnapshotTakenPayload
		if err := json.Unmarshal(ev.Payload, &payload); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if payload.AsOf != "2026-03-13T00:00:00.000Z" {
			t.Fatalf("asOf = %s", payload.AsOf)
		}
		if payload.OrgID == jobOrgA {
			if payload.ReceivablesAged != 3 || payload.ZeroBalanceCount != 0 {
				t.Fatalf("org A snapshot = %+v", payload)
			}
			if len(payload.Currencies) != 1 || payload.Currencies[0].Currency != "KES" {
				t.Fatalf("org A currencies = %+v", payload.Currencies)
			}
			buckets := payload.Currencies[0].BucketMinors
			if buckets["1-30"] != 10000 || buckets["31-60"] != 20000 || buckets["current"] != 30000 {
				t.Fatalf("org A buckets = %v", buckets)
			}
			if len(payload.EvidenceRefs) != 3 {
				t.Fatalf("evidenceRefs = %v", payload.EvidenceRefs)
			}
		}
	}

	// Same window re-run: the (org, window) claim holds — no double snapshots.
	stats, err = RunAging(context.Background(), repo, clock, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("same-window re-run: %v", err)
	}
	if stats.Emitted != 0 || stats.Skipped != 2 {
		t.Fatalf("same-window stats = %+v, want both skipped", stats)
	}
	if len(reg.events) != 2 {
		t.Fatalf("same window double-emitted: %d events", len(reg.events))
	}

	// Next window: fresh claims, fresh snapshots.
	clock.Step(24 * time.Hour)
	stats, err = RunAging(context.Background(), repo, clock, 24*time.Hour, 100)
	if err != nil {
		t.Fatalf("next window: %v", err)
	}
	if stats.Emitted != 2 {
		t.Fatalf("next window stats = %+v, want both orgs again", stats)
	}
	if reg.count("projections.agingSnapshotTaken") != 4 {
		t.Fatalf("windows must snapshot independently, got %d", reg.count("projections.agingSnapshotTaken"))
	}
}

// Zero-balance receivables are counted, never aged (projections/aging.ts:
// settled debt has nothing left to age).
func TestRunAgingZeroBalanceCounted(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	reg := newClaimRegistry()
	repo := &fakeAgingRepo{
		reg:  reg,
		orgs: []string{jobOrgA},
		facts: map[string][]AgingFact{
			jobOrgA: {
				agingFact(jobSubjA, money.KES, mustTimeT("2025-01-01T00:00:00.000Z"), 0), // settled — zero balance
				agingFact(jobSubjB, money.KES, mustTimeT("2026-03-10T00:00:00.000Z"), 7000),
			},
		},
	}
	if _, err := RunAging(context.Background(), repo, clock, time.Hour, 100); err != nil {
		t.Fatalf("RunAging: %v", err)
	}
	var payload AgingSnapshotTakenPayload
	if err := json.Unmarshal(reg.events[0].Payload, &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if payload.ZeroBalanceCount != 1 || payload.ReceivablesAged != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.Currencies[0].TotalMinor != 7000 {
		t.Fatalf("total = %d, want only the live balance", payload.Currencies[0].TotalMinor)
	}
}

func TestRunAgingConfigRefusals(t *testing.T) {
	clock := newStepClock("2026-03-13T00:00:00.000Z")
	repo := &fakeAgingRepo{reg: newClaimRegistry()}
	if _, err := RunAging(context.Background(), repo, clock, 0, 10); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("interval 0: want %s, got %v", CodeConfigInvalid, err)
	}
	if _, err := RunAging(context.Background(), repo, clock, time.Hour, 0); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("batch 0: want %s, got %v", CodeConfigInvalid, err)
	}
}

// --- helpers shared with the pure-port fixtures -----------------------------

func intPtr(v int) *int { return &v }
