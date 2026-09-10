package scheduler

// The four production jobs: pure domain ports (dunning.go / latefee.go /
// plans.go / aging.go) executed against injected repo ports (store.go
// implements them over PostgreSQL; tests inject fakes). Each job is a bounded
// batch pass — deterministic given the injected clock, idempotent per claim,
// and cancelled cleanly through ctx.

import (
	"context"
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// dunningClaimKeys — the durable claim key shapes:
//
//	send:   <subjectID>:<stepKey>         (the sentSteps idempotence set)
//	block:  <subjectID>:blocked:<stepKey> (a refusal fact is emitted once; a
//	        later consent grant can still send — a different key)
func dunningSendKey(subjectID, stepKey string) string {
	return subjectID + ":" + stepKey
}

func dunningBlockedKey(subjectID, stepKey string) string {
	return subjectID + ":blocked:" + stepKey
}

// dunningHorizon is the generous scan window the subject query needs: a
// subject qualifies for a step with offset m once its due date is within
// −m UTC calendar days of now, so the horizon is −(most negative offset)+1
// days (the +1 covers the day-index floor). The pure DueSteps filter is the
// exact gate; the horizon only bounds the scan.
func dunningHorizon(ladder []DunningStep) time.Duration {
	mostNegative := 0
	for _, s := range ladder {
		if s.DayOffset < mostNegative {
			mostNegative = s.DayOffset
		}
	}
	return time.Duration(-mostNegative+1) * 24 * time.Hour
}

// DunningRepo-facing orchestration for one subject, split out so the
// channel-scoped K2 resolution (the DB consent model is per channel+purpose,
// db/migrations/0003) reuses the exact pure event builders.
func dunningSendEvent(step DunningStep, facts DunningFacts, clock infra.Clock) (Event, error) {
	return newEvent("dunning.stepDue", facts.SubjectID, clock.Now(), DunningStepDuePayload{
		OrgID:           facts.OrgID,
		SubjectID:       facts.SubjectID,
		StepKey:         step.Key,
		DayOffset:       step.DayOffset,
		Kind:            step.Kind,
		Channel:         step.Channel,
		RequiresConsent: step.RequiresConsent,
		DueDate:         iso(facts.DueDate),
	})
}

func dunningBlockedEvent(step DunningStep, facts DunningFacts, clock infra.Clock) (Event, error) {
	return newEvent("collections.dunningBlockedNoConsent", facts.SubjectID, clock.Now(), DunningBlockedNoConsentPayload{
		OrgID:     facts.OrgID,
		SubjectID: facts.SubjectID,
		StepKey:   step.Key,
		Channel:   step.Channel,
		BlockedAt: iso(clock.Now()),
	})
}

// RunDunning advances the dunning ladder for every live subject the scan
// surfaces (dunning.ts orchestrateDunning, executed): select due steps
// (ladder + sentSteps idempotence from the claim registry), split them
// through the K2 consent gate — resolved per channel from the consent_grants
// ledger (0003) — and emit dunning.stepDue sends and
// collections.dunningBlockedNoConsent refusal facts, each claimed
// first-write-wins so a re-run never double-sends.
func RunDunning(ctx context.Context, repo DunningRepo, clock infra.Clock, ladder []DunningStep, batch int) (Stats, error) {
	if err := ValidateLadder(ladder); err != nil {
		return Stats{}, err
	}
	if batch < 1 {
		return Stats{}, schedErr(CodeConfigInvalid, "batch must be >= 1, got %d", batch)
	}
	now := clock.Now()
	subjects, err := repo.DunningSubjects(ctx, now.Add(dunningHorizon(ladder)), batch)
	if err != nil {
		return Stats{}, err
	}
	var stats Stats
	stats.Scanned = len(subjects)

	for _, subject := range subjects {
		sendKeys := make([]string, 0, len(ladder))
		for _, step := range ladder {
			sendKeys = append(sendKeys, dunningSendKey(subject.ReceivableID, step.Key))
		}
		sentKeys, err := repo.SentSteps(ctx, subject.OrgID, sendKeys)
		if err != nil {
			return stats, err
		}
		sent := make([]string, 0, len(sentKeys))
		for _, key := range sentKeys {
			sent = append(sent, strings.TrimPrefix(key, subject.ReceivableID+":"))
		}
		facts := DunningFacts{
			DueDate:   subject.DueDate,
			SentSteps: sent,
			SubjectID: subject.ReceivableID,
			OrgID:     subject.OrgID,
		}
		due, err := DueSteps(now, facts, ladder)
		if err != nil {
			return stats, err
		}

		// K2 consent resolution, cached per channel within the subject: the
		// gate itself is the pure EvaluateDunningSend (dunning.ts), the ref is
		// the customer's active dunning grant on the step's channel.
		consent := make(map[string]string)
		consentFor := func(channel string) (string, error) {
			if ref, ok := consent[channel]; ok {
				return ref, nil
			}
			ref, err := repo.ConsentRef(ctx, subject.OrgID, subject.CustomerID, channel, now)
			if err != nil {
				return "", err
			}
			consent[channel] = ref
			return ref, nil
		}

		for _, step := range due {
			ref, err := consentFor(step.Channel)
			if err != nil {
				return stats, err
			}
			if decision := EvaluateDunningSend(step, ref); decision.Allowed {
				ev, err := dunningSendEvent(step, facts, clock)
				if err != nil {
					return stats, err
				}
				claimed, err := repo.ClaimAndEmit(ctx, subject.OrgID, claimScopeDun, dunningSendKey(subject.ReceivableID, step.Key), ev.ID, ev)
				if err != nil {
					return stats, err
				}
				if claimed {
					stats.Claimed++
					stats.Emitted++
				}
				continue
			}
			// The refusal is an observable fact — emitted exactly once per
			// (subject, step) via its own claim key, never a silent drop and
			// never per-tick spam (K2; a later grant still allows the send).
			ev, err := dunningBlockedEvent(step, facts, clock)
			if err != nil {
				return stats, err
			}
			claimed, err := repo.ClaimAndEmit(ctx, subject.OrgID, claimScopeDun, dunningBlockedKey(subject.ReceivableID, step.Key), ev.ID, ev)
			if err != nil {
				return stats, err
			}
			if claimed {
				stats.Claimed++
				stats.Emitted++
			} else {
				stats.Skipped++
			}
		}
	}
	return stats, nil
}

// periodKeyFor is the caller-defined accrual period the late-fee job charges:
// the calendar month of the injected instant (late-fee.ts docstring's
// "e.g. '2025-08'" shape). The (receivableID, periodKey) pair is the H4
// idempotency scope.
func periodKeyFor(now time.Time) string {
	return now.UTC().Format("2006-01")
}

// RunLateFee accrues late fees for every eligible overdue receivable
// (late-fee.ts accrueLateFee, executed): the policy comes from Config
// (validated by the same pure validator), the period key is the accrual
// month, and each fee is claimed per (receivable, period) in the same
// transaction as its receivable.lateFeeAccrued event — the H4 guarantee that
// accrual jobs re-running daily never double-charge. Per-receivable
// eligibility refusals (not overdue / within grace / zero balance / not
// live) are counted, never fatal — they are business-as-usual states.
func RunLateFee(ctx context.Context, repo LateFeeRepo, clock infra.Clock, policy LateFeePolicy, batch int) (Stats, error) {
	if _, err := ValidateLateFeePolicy(policy); err != nil {
		return Stats{}, err
	}
	if batch < 1 {
		return Stats{}, schedErr(CodeConfigInvalid, "batch must be >= 1, got %d", batch)
	}
	now := clock.Now()
	periodKey := periodKeyFor(now)
	rows, err := repo.OverdueReceivables(ctx, now, batch)
	if err != nil {
		return Stats{}, err
	}
	var stats Stats
	stats.Scanned = len(rows)

	for _, row := range rows {
		accrual, err := AccrueLateFee(row.Like, policy, LateFeeAccrualOptions{PeriodKey: periodKey, Now: now})
		if err != nil {
			if isSkippable(err) {
				stats.Skipped++
				continue
			}
			return stats, err
		}
		if accrual.Outcome != OutcomeAccrued || len(accrual.Events) != 1 {
			stats.Skipped++
			continue
		}
		claimed, err := repo.ClaimAndEmit(ctx, row.OrgID, claimScopeFee, row.Like.ID+":"+periodKey, accrual.Events[0].ID, accrual.Events[0])
		if err != nil {
			return stats, err
		}
		if claimed {
			stats.Claimed++
			stats.Emitted++
		} else {
			stats.Skipped++
		}
	}
	return stats, nil
}

// RunPlan advances payment-plan installment due/expiry (payment-plan.ts,
// executed): installments whose due date has arrived move scheduled → due
// (FOR UPDATE SKIP LOCKED claim), and active plans with an unpaid installment
// overdue by the plan's grace days transition active → defaulted with the
// paymentplan.defaulted event carrying the trigger evidence. Completed,
// defaulted and cancelled plans are dead to this job by construction.
func RunPlan(ctx context.Context, repo PlanRepo, clock infra.Clock, batch int) (Stats, error) {
	if batch < 1 {
		return Stats{}, schedErr(CodeConfigInvalid, "batch must be >= 1, got %d", batch)
	}
	now := clock.Now()
	var stats Stats

	due, err := repo.AdvanceDueInstallments(ctx, now, batch)
	if err != nil {
		return stats, err
	}
	stats.Scanned += len(due)

	candidates, err := repo.DefaultCandidates(ctx, now, batch)
	if err != nil {
		return stats, err
	}
	stats.Scanned += len(candidates)

	for _, plan := range candidates {
		installments, err := repo.UnpaidInstallments(ctx, plan.OrgID, plan.PlanID)
		if err != nil {
			return stats, err
		}
		trigger, err := FindDefaultTrigger(installments, plan.GraceDays, now)
		if err != nil {
			if isSkippable(err) {
				// The scan prefilter raced ahead of a payment/state change —
				// the pure search says no default. Expected, observable.
				stats.Skipped++
				continue
			}
			return stats, err
		}
		ev, err := newEvent("paymentplan.defaulted", plan.PlanID, clock.Now(), PlanDefaultedPayload{
			PlanID:           plan.PlanID,
			CustomerID:       plan.CustomerID,
			InstallmentNo:    trigger.InstallmentNo,
			DaysOverdue:      trigger.DaysOverdue,
			DefaultAfterDays: plan.GraceDays,
		})
		if err != nil {
			return stats, err
		}
		defaulted, err := repo.DefaultPlan(ctx, plan.OrgID, plan.PlanID, ev)
		if err != nil {
			return stats, err
		}
		if defaulted {
			stats.Claimed++
			stats.Emitted++
		} else {
			stats.Skipped++
		}
	}
	return stats, nil
}

// agingWindowID is the aging job's run window: the injected instant truncated
// to the job's interval (UTC). Re-running inside the same window claims the
// same key — no duplicate snapshot events (AC2); the next window snapshots
// again.
func agingWindowID(now time.Time, interval time.Duration) string {
	return now.UTC().Truncate(interval).Format(time.RFC3339)
}

// RunAging materializes the AR aging snapshot per org (projections/aging.ts
// arAgingByBucket, executed): per-currency bucket totals with evidence refs,
// zero-balance facts skipped, emitted as projections.agingSnapshotTaken and
// claimed per (org, run window) so the same tick never double-emits.
func RunAging(ctx context.Context, repo AgingRepo, clock infra.Clock, interval time.Duration, batch int) (Stats, error) {
	if interval <= 0 {
		return Stats{}, schedErr(CodeConfigInvalid, "aging interval must be > 0, got %s", interval)
	}
	if batch < 1 {
		return Stats{}, schedErr(CodeConfigInvalid, "batch must be >= 1, got %d", batch)
	}
	now := clock.Now()
	windowID := agingWindowID(now, interval)
	orgs, err := repo.SnapshotOrgs(ctx, batch)
	if err != nil {
		return Stats{}, err
	}
	var stats Stats
	stats.Scanned = len(orgs)

	for _, org := range orgs {
		facts, err := repo.OrgAgingFacts(ctx, org)
		if err != nil {
			return stats, err
		}
		snapshot, err := ArAgingByBucket(facts, now)
		if err != nil {
			return stats, err
		}
		ev, err := AgingSnapshotEvent(org, snapshot, clock.Now())
		if err != nil {
			return stats, err
		}
		claimed, err := repo.ClaimAndEmit(ctx, org, claimScopeAging, org+":"+windowID, ev.ID, ev)
		if err != nil {
			return stats, err
		}
		if claimed {
			stats.Claimed++
			stats.Emitted++
		} else {
			stats.Skipped++
		}
	}
	return stats, nil
}

// DunningJob / LateFeeJob / PlanJob / AgingJob bind the runner's store,
// clock and config into the runnable JobFuncs.
func (r *Runner) DunningJob(ctx context.Context) (Stats, error) {
	return RunDunning(ctx, r.store, r.clock, DefaultDunningLadder, r.cfg.Batch)
}

func (r *Runner) LateFeeJob(ctx context.Context) (Stats, error) {
	return RunLateFee(ctx, r.store, r.clock, r.cfg.LateFee, r.cfg.Batch)
}

func (r *Runner) PlanJob(ctx context.Context) (Stats, error) {
	return RunPlan(ctx, r.store, r.clock, r.cfg.Batch)
}

func (r *Runner) AgingJob(ctx context.Context) (Stats, error) {
	return RunAging(ctx, r.store, r.clock, r.cfg.AgingInterval, r.cfg.Batch)
}
