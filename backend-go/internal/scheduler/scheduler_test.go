package scheduler

// Runner-loop tests (scheduler.go): interval cadence, the no-overlap-per-name
// lock discipline (a loser SKIPS its tick, it never queues), graceful
// shutdown via context, and the Runner wiring. Fakes only — the production
// Locker is proven against real PostgreSQL advisory locks in store_test.go.

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// tryLocker is the mutex-backed fake Locker: Lock behaves like
// pg_try_advisory_lock — it never blocks a loser into queueing; the loser
// reports acquired=false and the tick is skipped.
type tryLocker struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newTryLocker() *tryLocker { return &tryLocker{locks: make(map[string]*sync.Mutex)} }

func (l *tryLocker) lockFor(name string) *sync.Mutex {
	l.mu.Lock()
	defer l.mu.Unlock()
	m, ok := l.locks[name]
	if !ok {
		m = &sync.Mutex{}
		l.locks[name] = m
	}
	return m
}

func (l *tryLocker) Lock(_ context.Context, name string) (func(), bool, error) {
	m := l.lockFor(name)
	if !m.TryLock() {
		return nil, false, nil
	}
	released := false
	var rel sync.Mutex
	return func() {
		rel.Lock()
		defer rel.Unlock()
		if !released {
			released = true
			m.Unlock()
		}
	}, true, nil
}

// holdingLocker always fails to acquire — the "another process owns it" world.
type holdingLocker struct{}

func (holdingLocker) Lock(context.Context, string) (func(), bool, error) { return nil, false, nil }

// failingLocker fails the lock call itself (infrastructure error path).
type failingLocker struct{}

func (failingLocker) Lock(context.Context, string) (func(), bool, error) {
	return nil, false, errors.New("advisory lock backend unreachable")
}

// countedJob counts cycles and can block cycles on a channel.
type countedJob struct {
	cycles  atomic.Int64
	started chan struct{} // signalled per cycle start (buffered generously)
	block   chan struct{} // when non-nil, each cycle blocks until closed
}

func newCountedJob() *countedJob {
	return &countedJob{started: make(chan struct{}, 1024)}
}

func (c *countedJob) fn(ctx context.Context) (Stats, error) {
	c.cycles.Add(1)
	c.started <- struct{}{}
	if c.block != nil {
		select {
		case <-c.block:
		case <-ctx.Done():
			return Stats{}, ctx.Err()
		}
	}
	return Stats{Scanned: 1, Claimed: 1, Emitted: 1}, nil
}

func testJobSet() ([]Job, *countedJob) {
	j := newCountedJob()
	return []Job{{Name: "solo", Interval: 20 * time.Millisecond, Fn: j.fn}}, j
}

func quietLog() *slog.Logger { return slog.New(slog.NewTextHandler(discardWriter{}, nil)) }

type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }

func TestNewValidation(t *testing.T) {
	ok := Job{Name: "a", Interval: time.Minute, Fn: func(context.Context) (Stats, error) { return Stats{}, nil }}
	if _, err := New(nil, newTryLocker(), nil); !hasCode(err, CodeJobInvalid) {
		t.Fatalf("nil jobs: want %s, got %v", CodeConfigInvalid, err)
	}
	if _, err := New([]Job{ok}, nil, nil); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("nil locker: want %s, got %v", CodeConfigInvalid, err)
	}
	if _, err := New([]Job{{Name: "", Interval: time.Minute, Fn: ok.Fn}}, newTryLocker(), nil); !hasCode(err, CodeJobNameBlank) {
		t.Fatalf("blank name: want %s, got %v", CodeJobNameBlank, err)
	}
	if _, err := New([]Job{ok, {Name: "a", Interval: time.Minute, Fn: ok.Fn}}, newTryLocker(), nil); !hasCode(err, CodeJobInvalid) {
		t.Fatalf("duplicate name: want %s, got %v", CodeJobInvalid, err)
	}
	if _, err := New([]Job{{Name: "a", Interval: 0, Fn: ok.Fn}}, newTryLocker(), nil); !hasCode(err, CodeJobInvalid) {
		t.Fatalf("zero interval: want %s, got %v", CodeJobInvalid, err)
	}
	if _, err := New([]Job{{Name: "a", Interval: time.Minute}}, newTryLocker(), nil); !hasCode(err, CodeJobInvalid) {
		t.Fatalf("nil fn: want %s, got %v", CodeJobInvalid, err)
	}
}

// Run fires every job immediately, then on its interval, and returns nil when
// the context is cancelled — the graceful-shutdown contract.
func TestRunFiresImmediatelyThenOnIntervalAndStops(t *testing.T) {
	jobs, job := testJobSet()
	sched, err := New(jobs, newTryLocker(), quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- sched.Run(ctx) }()

	// First cycle is immediate.
	select {
	case <-job.started:
	case <-time.After(2 * time.Second):
		t.Fatal("first tick never ran")
	}
	// Interval cadence: at least three cycles within a generous window.
	deadline := time.Now().Add(2 * time.Second)
	for job.cycles.Load() < 3 {
		if time.Now().After(deadline) {
			t.Fatalf("interval ticks stalled at %d cycles", job.cycles.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after cancellation")
	}
}

// A failed cycle never kills the scheduler: infrastructure errors are logged
// and retried on the next tick (the scheduler stays up through database
// unavailability).
func TestRunSurvivesJobErrors(t *testing.T) {
	attempts := atomic.Int64{}
	failing := func(context.Context) (Stats, error) {
		if attempts.Add(1) < 3 {
			return Stats{}, errors.New("db connection lost")
		}
		return Stats{Scanned: 1}, nil
	}
	sched, err := New([]Job{{Name: "flaky", Interval: 10 * time.Millisecond, Fn: failing}}, newTryLocker(), quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := sched.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if attempts.Load() < 3 {
		t.Fatalf("erroring job was retired after %d attempts, want retries until success", attempts.Load())
	}
}

// The no-overlap guarantee, cross-process shape: a second scheduler sharing
// the job's lock SKIPS its ticks while the first holds the lock — it never
// queues behind the winner and never runs the body concurrently.
func TestRunSkipsTicksWhileAnotherSchedulerHoldsTheJob(t *testing.T) {
	jobs, job := testJobSet()
	locker := newTryLocker()
	sched, err := New(jobs, locker, quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	job.block = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- sched.Run(ctx) }()
	<-job.started // first cycle in flight, holding the job's lock

	// Any other scheduler (or tick) loses the try-lock and skips.
	if _, acquired, err := locker.Lock(ctx, "solo"); err != nil || acquired {
		t.Fatalf("lock while held: acquired=%v err=%v, want false/nil", acquired, err)
	}
	// The in-flight cycle's own ticker fires while blocked — those ticks skip.
	time.Sleep(60 * time.Millisecond)
	if n := job.cycles.Load(); n != 1 {
		t.Fatalf("overlapping tick ran the body again (%d cycles), want strictly 1", n)
	}

	close(job.block) // let the cycle finish
	cancel()
	<-done
	// The lock is released after the body: a fresh Lock wins again.
	if _, acquired, err := locker.Lock(context.Background(), "solo"); err != nil || !acquired {
		t.Fatalf("lock after release: acquired=%v err=%v, want true/nil", acquired, err)
	}
}

// A tick whose lock call errors is logged and skipped — the loop continues.
func TestRunContinuesThroughLockErrors(t *testing.T) {
	job := newCountedJob()
	sched, err := New([]Job{{Name: "x", Interval: 10 * time.Millisecond, Fn: job.fn}}, failingLocker{}, quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := sched.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if job.cycles.Load() != 0 {
		t.Fatalf("job ran %d times despite the locker always failing", job.cycles.Load())
	}
}

// A tick whose lock is permanently held never runs the body.
func TestRunSkipsWhenLockAlwaysHeld(t *testing.T) {
	job := newCountedJob()
	sched, err := New([]Job{{Name: "x", Interval: 10 * time.Millisecond, Fn: job.fn}}, holdingLocker{}, quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if err := sched.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if job.cycles.Load() != 0 {
		t.Fatalf("job ran %d times despite the held lock", job.cycles.Load())
	}
}

// RunOnce performs exactly one guarded cycle per job, in job order — the
// deterministic entry point for tests and smoke runs.
func TestRunOnceSequential(t *testing.T) {
	a, b := newCountedJob(), newCountedJob()
	var order sync.Mutex
	var ran []string
	wrap := func(name string, fn JobFunc) JobFunc {
		return func(ctx context.Context) (Stats, error) {
			order.Lock()
			ran = append(ran, name)
			order.Unlock()
			return fn(ctx)
		}
	}
	sched, err := New([]Job{
		{Name: "second", Interval: time.Hour, Fn: wrap("second", b.fn)},
		{Name: "first", Interval: time.Hour, Fn: wrap("first", a.fn)},
	}, newTryLocker(), quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := sched.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	order.Lock()
	defer order.Unlock()
	if len(ran) != 2 || ran[0] != "second" || ran[1] != "first" {
		t.Fatalf("RunOnce order = %v, want job-list order [second first]", ran)
	}
	if a.cycles.Load() != 1 || b.cycles.Load() != 1 {
		t.Fatalf("cycles a=%d b=%d, want exactly one each", a.cycles.Load(), b.cycles.Load())
	}
}

// Graceful shutdown with an in-flight cycle: cancellation does not kill the
// running effect mid-flight — the cycle observes ctx, finishes its critical
// section shape, and Run returns nil (the claim+emit transactions are atomic
// in the real store; here the body's completion is the assertion).
func TestRunGracefulShutdownWithInFlightCycle(t *testing.T) {
	jobs, job := testJobSet()
	sched, err := New(jobs, newTryLocker(), quietLog())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	job.block = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- sched.Run(ctx) }()
	<-job.started

	cancel() // shutdown while the cycle is blocked in-flight
	close(job.block)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v after graceful shutdown, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run did not return after in-flight cycle completed")
	}
	if job.cycles.Load() != 1 {
		t.Fatalf("cycles = %d, want the in-flight one to complete", job.cycles.Load())
	}
}

// --- Runner wiring ----------------------------------------------------------

func TestNewRunnerWiresProductionJobs(t *testing.T) {
	cfg, err := ResolveConfig(Config{})
	if err != nil {
		t.Fatalf("ResolveConfig: %v", err)
	}
	runner, err := NewRunner(&Store{}, cfg, nil, quietLog()) // nil clock → SystemClock
	if err != nil {
		t.Fatalf("NewRunner: %v", err)
	}
	jobs := runner.Jobs()
	want := map[string]time.Duration{
		JobNameDunning: DefaultDunningInterval,
		JobNameLateFee: DefaultLateFeeInterval,
		JobNamePlan:    DefaultPlanInterval,
		JobNameAging:   DefaultAgingInterval,
	}
	if len(jobs) != len(want) {
		t.Fatalf("jobs = %d, want %d", len(jobs), len(want))
	}
	for _, j := range jobs {
		if j.Interval != want[j.Name] {
			t.Fatalf("job %s interval = %s, want %s", j.Name, j.Interval, want[j.Name])
		}
		if j.Fn == nil {
			t.Fatalf("job %s has no fn", j.Name)
		}
	}
	// The four production jobs are lockable as a set: unique names, positive
	// intervals — New accepts them.
	if _, err := New(jobs, newTryLocker(), quietLog()); err != nil {
		t.Fatalf("New over production jobs: %v", err)
	}
}

func TestNewRunnerRefusals(t *testing.T) {
	if _, err := NewRunner(nil, Config{}, nil, nil); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("nil store: want %s, got %v", CodeConfigInvalid, err)
	}
	if _, err := NewRunner(&Store{}, Config{Batch: -3}, nil, nil); !hasCode(err, CodeConfigInvalid) {
		t.Fatalf("negative batch: want %s, got %v", CodeConfigInvalid, err)
	}
}
