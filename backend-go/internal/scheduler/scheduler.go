// Package scheduler is the interval background scheduler (issue #126): it
// EXECUTES on a clock the pure receivables/collections semantics that
// src/domain defines but nothing advanced — dunning ladder advancement,
// late-fee accrual, payment-plan installment due/expiry and AR aging
// snapshot materialization.
//
// Parity contract: every transition the jobs perform is the Go port of the
// TypeScript source it advances, formula for formula and refusal for
// refusal — dunning (src/domain/promises/dunning.ts), late fees
// (src/domain/receivables/late-fee.ts), payment plans
// (src/domain/receivables/payment-plan.ts) and aging
// (src/domain/receivables/aging.ts + src/domain/projections/aging.ts).
// The pure ports live in dunning.go / latefee.go / plans.go / aging.go and
// their tests cite the TS spec fixtures they mirror.
//
// Guarantees (each with its proof test):
//
//   - Idempotent per run window: every effect is claimed first-write-wins in
//     the durable idempotency_keys registry (db/migrations/0013, the R9/C5
//     store twin) inside the SAME transaction that appends its outbox event —
//     re-running the same tick, or the same accrual period, can never double
//     an effect (jobs_test.go).
//   - No job overlap per name: a job body runs under a session-level
//     pg_try_advisory_lock keyed by the job name; a second scheduler that
//     loses the race skips the tick instead of blocking (scheduler_test.go).
//   - Concurrency-safe claiming: row-level claiming uses
//     FOR UPDATE SKIP LOCKED (installment due advancement) or guarded
//     conditional UPDATEs (plan defaulting) so concurrent schedulers never
//     double-claim a row (jobs_test.go races them).
//   - Graceful shutdown: Run observes the context — cancellation stops
//     claiming, in-flight effects complete atomically (claim+emit are one
//     transaction), and Run returns nil.
//   - Injected clock and repos: the jobs read time ONLY through infra.Clock
//     and persistence ONLY through the repo ports, so tests drive every
//     boundary with a steppable clock and fakes (deterministic, no sleeps).
//
// Events: effects travel as outbox_events rows (db/migrations/0013) in the
// wave-1 envelope shape — name/version/payload with the payload byte-for-byte
// the TS payload interfaces define (dunning.stepDue,
// collections.dunningBlockedNoConsent, receivable.lateFeeAccrued,
// paymentplan.defaulted, projections.agingSnapshotTaken). The relay lane
// publishes them; this package never touches the broker.
//
// stdlib only: scheduling is time.Ticker-based, locking is PostgreSQL
// advisory locking, identity is crypto/rand via internal/infra — no new
// module dependencies (go.mod untouched).
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Error is the only error type this package produces: a stable machine Code
// plus a human Message. Errors are values — match with errors.As and compare
// Code, exactly like pkg/money and the outbox lane. Domain-parity refusals
// carry the TS codes verbatim (DUNNING_LADDER_INVALID, LATE_FEE_*, …); the
// scheduler's own refusals are prefixed SCHED_.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Is matches any *Error carrying the same Code, so errors.Is works across
// contextual message differences.
func (e *Error) Is(target error) bool {
	if t, ok := target.(*Error); ok {
		return t.Code == e.Code
	}
	return false
}

func schedErr(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Stable machine codes this package adds (domain-parity codes live beside
// the pure ports they guard).
const (
	CodeConfigInvalid = "SCHED_CONFIG_INVALID"
	CodeJobNameBlank  = "SCHED_JOB_NAME_REQUIRED"
	CodeJobInvalid    = "SCHED_JOB_INVALID"
)

// Job names — the four production jobs. Names are the no-overlap lock keys,
// so they are stable identifiers, not display text.
const (
	JobNameDunning  = "dunning"
	JobNameLateFee  = "late_fee"
	JobNamePlan     = "payment_plans"
	JobNameAging    = "aging_snapshots"
	jobLockPrefix   = "scheduler:"
	claimScopeDun   = "scheduler.dunning"
	claimScopeFee   = "scheduler.late_fee"
	claimScopeAging = "scheduler.aging"
)

// Job is one named scheduled unit of work. Interval is the tick cadence; Fn
// performs one bounded cycle (a batch) and must honour ctx cancellation.
type Job struct {
	Name     string
	Interval time.Duration
	Fn       JobFunc
}

// JobFunc runs one cycle of a job. The returned Stats feed the cycle log and
// tests; an error is logged and retried on the next tick (infrastructure
// failures never kill the scheduler), except when the context is cancelled.
type JobFunc func(ctx context.Context) (Stats, error)

// Stats aggregates one job cycle.
type Stats struct {
	Scanned int // subjects/plans/orgs pulled from the scan
	Emitted int // outbox events appended
	Claimed int // first-write-wins claims won (≈ effects performed)
	Skipped int // rows refused/already-claimed (expected, observable)
}

// Locker is the no-overlap port: Lock(name) either wins the named job's
// critical section (returning the release func) or reports acquired=false —
// it must never block a loser into queueing behind the winner (a tick skip
// is cheaper and safer than a queued second run). The production
// implementation is a session-level PostgreSQL advisory lock (AdvisoryLocker);
// tests inject a mutex-backed fake.
type Locker interface {
	Lock(ctx context.Context, name string) (release func(), acquired bool, err error)
}

// Scheduler runs jobs on their intervals. Construct with New; drive with Run
// (long-lived) or RunOnce (one deterministic pass — tests and smoke runs).
type Scheduler struct {
	jobs   []Job
	locker Locker
	log    *slog.Logger
}

// New validates the job set (unique non-blank names, positive intervals,
// non-nil functions, non-nil locker) and returns a Scheduler.
func New(jobs []Job, locker Locker, log *slog.Logger) (*Scheduler, error) {
	if locker == nil {
		return nil, schedErr(CodeConfigInvalid, "locker is required")
	}
	if log == nil {
		log = slog.Default()
	}
	seen := make(map[string]bool, len(jobs))
	for i, j := range jobs {
		if j.Name == "" {
			return nil, schedErr(CodeJobNameBlank, "job[%d] needs a name", i)
		}
		if seen[j.Name] {
			return nil, schedErr(CodeJobInvalid, "duplicate job name %q", j.Name)
		}
		seen[j.Name] = true
		if j.Interval <= 0 {
			return nil, schedErr(CodeJobInvalid, "job %q interval must be > 0, got %s", j.Name, j.Interval)
		}
		if j.Fn == nil {
			return nil, schedErr(CodeJobInvalid, "job %q needs a run function", j.Name)
		}
	}
	return &Scheduler{jobs: append([]Job(nil), jobs...), locker: locker, log: log}, nil
}

// Run drives every job on its interval until ctx is cancelled (SIGTERM in the
// worker binary). Each job gets its own goroutine: intervals are independent
// and the per-name lock makes overlapping processes safe. The first tick of
// every job runs immediately. Graceful shutdown: cancellation stops the
// tickers; the in-flight cycle completes (its claim+emit transactions are
// atomic) and Run returns nil.
func (s *Scheduler) Run(ctx context.Context) error {
	var wg sync.WaitGroup
	for _, j := range s.jobs {
		job := j
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.loop(ctx, job)
		}()
	}
	wg.Wait()
	return nil
}

// loop is one job's ticker loop: run immediately, then every Interval, until
// ctx is cancelled. A failed cycle is logged and retried on the next tick —
// the scheduler stays up through database unavailability.
func (s *Scheduler) loop(ctx context.Context, j Job) {
	ticker := time.NewTicker(j.Interval)
	defer ticker.Stop()
	s.tick(ctx, j)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.tick(ctx, j)
		}
	}
}

// tick performs one guarded cycle: the per-name lock is acquired or the tick
// is skipped (another process owns this job right now — no overlap, ever).
func (s *Scheduler) tick(ctx context.Context, j Job) {
	if ctx.Err() != nil {
		return
	}
	release, acquired, err := s.locker.Lock(ctx, j.Name)
	if err != nil {
		if ctx.Err() != nil {
			return
		}
		s.log.Error("scheduler.lock_failed", "job", j.Name, "error", err.Error())
		return
	}
	if !acquired {
		s.log.Info("scheduler.job_skipped_overlap", "job", j.Name)
		return
	}
	defer release()

	stats, err := j.Fn(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return // graceful stop — the cycle observed cancellation
		}
		s.log.Error("scheduler.job_failed", "job", j.Name, "error", err.Error())
		return
	}
	s.log.Info("scheduler.job_cycle",
		"job", j.Name,
		"scanned", stats.Scanned,
		"claimed", stats.Claimed,
		"emitted", stats.Emitted,
		"skipped", stats.Skipped,
	)
}

// RunOnce performs exactly one guarded cycle of every job, sequentially and
// in job order — the deterministic entry point tests and smoke runs use.
func (s *Scheduler) RunOnce(ctx context.Context) error {
	for _, j := range s.jobs {
		s.tick(ctx, j)
	}
	return nil
}

// Runner wires the four production jobs to a Store, the injected clock and
// the resolved Config. Build it in the worker binary; Jobs() is the job set
// for New.
type Runner struct {
	store *Store
	clock infra.Clock
	cfg   Config
	log   *slog.Logger
}

// NewRunner wires a Runner over the store.
func NewRunner(store *Store, cfg Config, clock infra.Clock, log *slog.Logger) (*Runner, error) {
	if store == nil {
		return nil, schedErr(CodeConfigInvalid, "store is required")
	}
	cfg, err := ResolveConfig(cfg)
	if err != nil {
		return nil, err
	}
	if clock == nil {
		clock = infra.SystemClock{}
	}
	if log == nil {
		log = slog.Default()
	}
	return &Runner{store: store, clock: clock, cfg: cfg, log: log}, nil
}

// Jobs returns the four production jobs with their configured intervals —
// hand the result to New.
func (r *Runner) Jobs() []Job {
	return []Job{
		{Name: JobNameDunning, Interval: r.cfg.DunningInterval, Fn: r.DunningJob},
		{Name: JobNameLateFee, Interval: r.cfg.LateFeeInterval, Fn: r.LateFeeJob},
		{Name: JobNamePlan, Interval: r.cfg.PlanInterval, Fn: r.PlanJob},
		{Name: JobNameAging, Interval: r.cfg.AgingInterval, Fn: r.AgingJob},
	}
}

// ClockForTesting exposes the runner's injected clock (used by the worker
// binary's smoke path; tests construct their own).
func (r *Runner) ClockForTesting() infra.Clock { return r.clock }

// isSkippable reports whether err is an expected per-row refusal (a stable
// domain code the job counts as Skipped instead of failing the cycle):
// business-as-usual eligibility outcomes, never infrastructure errors.
func isSkippable(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	switch e.Code {
	case "DUNNING_CONSENT_REQUIRED",
		"LATE_FEE_NOT_OVERDUE", "LATE_FEE_WITHIN_GRACE", "LATE_FEE_ZERO_BALANCE",
		"LATE_FEE_RECEIVABLE_NOT_LIVE",
		"PAYMENT_PLAN_NOT_DEFAULTABLE":
		return true
	default:
		return false
	}
}
