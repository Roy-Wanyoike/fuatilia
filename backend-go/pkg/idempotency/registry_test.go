package idempotency

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

// mustExecute runs Execute and fails t on an unexpected error.
func mustExecute[T any](t *testing.T, r *Registry[T], scope, key string, fn func() (T, error)) Result[T] {
	t.Helper()
	res, err := r.Execute(scope, key, fn)
	if err != nil {
		t.Fatalf("Execute(%s, %s): %v", scope, key, err)
	}
	return res
}

// wantCode asserts err is a non-nil *Error with exactly the wanted code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %s, got nil", code)
	}
	var ie *Error
	if !errors.As(err, &ie) {
		t.Fatalf("expected *idempotency.Error, got %T: %v", err, err)
	}
	if ie.Code != code {
		t.Fatalf("expected code %s, got %s (%v)", code, ie.Code, err)
	}
}

func TestExecuteRunsFnOnceAndCommits(t *testing.T) {
	r := NewRegistry[string]()
	calls := 0
	res := mustExecute(t, r, "payments", "idem-1", func() (string, error) {
		calls++
		return "outcome-1", nil
	})
	if res.Replayed {
		t.Fatal("first execution must not be a replay")
	}
	if res.Value != "outcome-1" || calls != 1 {
		t.Fatalf("got %q after %d calls", res.Value, calls)
	}
	if r.Len() != 1 {
		t.Fatalf("registry holds %d entries, want 1", r.Len())
	}
}

func TestReplayReturnsTheOriginalOutcomeWithoutRerunning(t *testing.T) {
	// R9/C5: a duplicate returns the ORIGINAL outcome — never a second
	// execution. For reference-typed outcomes the handle is the same value.
	r := NewRegistry[*stub]()
	first := mustExecute(t, r, "payments", "idem-1", func() (*stub, error) {
		return &stub{id: "original"}, nil
	})
	second := mustExecute(t, r, "payments", "idem-1", func() (*stub, error) {
		t.Fatal("replayed Execute must not run fn again")
		return nil, nil
	})
	if !second.Replayed {
		t.Fatal("second Execute must be flagged Replayed")
	}
	if second.Value != first.Value {
		t.Fatalf("replay returned a different handle: %v vs %v", second.Value, first.Value)
	}
	if second.Value.id != "original" {
		t.Fatalf("replay value corrupted: %+v", second.Value)
	}
}

func TestDifferentKeyOrScopeRunsSeparately(t *testing.T) {
	// The registry partitions by (scope, key): the same key under another
	// scope is a DIFFERENT logical command, and so is another key.
	r := NewRegistry[int]()
	res := mustExecute(t, r, "payments", "k-1", staticFn(1))
	if res.Replayed {
		t.Fatal("fresh key must not be a replay")
	}
	res = mustExecute(t, r, "refunds", "k-1", staticFn(2))
	if res.Replayed || res.Value != 2 {
		t.Fatalf("same key in another scope must run fresh: %+v", res)
	}
	res = mustExecute(t, r, "payments", "k-2", staticFn(3))
	if res.Replayed || res.Value != 3 {
		t.Fatalf("fresh key must run fresh: %+v", res)
	}
	if r.Len() != 3 {
		t.Fatalf("registry holds %d entries, want 3", r.Len())
	}
}

func TestFailureDoesNotClaimTheKey(t *testing.T) {
	// A failed run leaves nothing to replay — the key stays free so a
	// legitimate retry can execute (intake.ts records only created payments).
	r := NewRegistry[string]()
	attempts := 0
	_, err := r.Execute("payments", "retry-me", func() (string, error) {
		attempts++
		return "", fmt.Errorf("daraja timeout")
	})
	if err == nil {
		t.Fatal("fn error must surface")
	}
	if attempts != 1 {
		t.Fatalf("fn ran %d times, want 1", attempts)
	}
	retry := mustExecute(t, r, "payments", "retry-me", func() (string, error) {
		attempts++
		return "second-try", nil
	})
	if retry.Replayed {
		t.Fatal("retry after a failed run must be a fresh execution")
	}
	if retry.Value != "second-try" || attempts != 2 {
		t.Fatalf("retry got %q after %d attempts", retry.Value, attempts)
	}
}

func TestPutIsFirstWriteWins(t *testing.T) {
	// Outbox-twin semantics: put-if-absent refuses the second write with
	// IDEMPOTENCY_KEY_TAKEN and leaves the ORIGINAL outcome untouched.
	r := NewRegistry[string]()
	if err := r.Put("outbox", "evt-1", "first"); err != nil {
		t.Fatalf("first Put: %v", err)
	}
	err := r.Put("outbox", "evt-1", "second")
	wantCode(t, err, CodeKeyTaken)
	if !errors.Is(err, ErrKeyTaken) {
		t.Fatal("errors.Is(ErrKeyTaken) failed")
	}
	value, ok := r.Lookup("outbox", "evt-1")
	if !ok || value != "first" {
		t.Fatalf("original outcome overwritten: %q", value)
	}
}

func TestExecuteReplaysAPutOutcome(t *testing.T) {
	// Put seeds the registry; Execute must treat it as the original outcome.
	r := NewRegistry[int]()
	if err := r.Put("claims", "k-1", 42); err != nil {
		t.Fatalf("Put: %v", err)
	}
	res := mustExecute(t, r, "claims", "k-1", func() (int, error) {
		t.Fatal("Execute over a Put outcome must not run fn")
		return 0, nil
	})
	if !res.Replayed || res.Value != 42 {
		t.Fatalf("got %+v, want replay of 42", res)
	}
}

func TestLookupAndLen(t *testing.T) {
	r := NewRegistry[int]()
	if _, ok := r.Lookup("payments", "missing"); ok {
		t.Fatal("empty registry must not report hits")
	}
	if r.Len() != 0 {
		t.Fatalf("empty registry Len = %d", r.Len())
	}
	mustExecute(t, r, "payments", "k-1", staticFn(7))
	if value, ok := r.Lookup("payments", " k-1 "); !ok || value != 7 {
		// keys are stored trimmed — lookup with padded input still hits
		t.Fatalf("trimmed lookup = %v, %v", value, ok)
	}
	if r.Len() != 1 {
		t.Fatalf("Len = %d, want 1", r.Len())
	}
}

func TestRefusals(t *testing.T) {
	// Every refusal path, table-driven: blank scope/key (trimmed, exactly
	// like intake.ts) and a nil operation.
	r := NewRegistry[string]()
	tests := []struct {
		name     string
		scope    string
		key      string
		fn       func() (string, error)
		wantCode string
		skipPut  bool // Put takes no fn, so fn-only refusals don't apply
	}{
		{"blank key", "payments", "   ", staticFn("x"), CodeKeyRequired, false},
		{"empty key", "payments", "", staticFn("x"), CodeKeyRequired, false},
		{"blank scope", "   ", "k-1", staticFn("x"), CodeScopeRequired, false},
		{"empty scope", "", "k-1", staticFn("x"), CodeScopeRequired, false},
		{"nil function", "payments", "k-1", nil, CodeFnRequired, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := r.Execute(tc.scope, tc.key, tc.fn)
			wantCode(t, err, tc.wantCode)
		})
		if tc.skipPut {
			continue
		}
		if err := r.Put(tc.scope, tc.key, "v"); err == nil {
			t.Fatalf("%s: Put must refuse too", tc.name)
		}
	}
	if r.Len() != 0 {
		t.Fatalf("refused calls must not mutate the registry: Len = %d", r.Len())
	}
}

func TestErrorsAreValues(t *testing.T) {
	r := NewRegistry[string]()
	if err := r.Put("s", "k", "v"); err != nil {
		t.Fatalf("Put: %v", err)
	}
	wrapped := fmt.Errorf("double submit: %w", r.Put("s", "k", "v2"))
	if !errors.Is(wrapped, ErrKeyTaken) {
		t.Fatal("wrapped KEY_TAKEN not matched via errors.Is")
	}
	if errors.Is(wrapped, ErrKeyRequired) {
		t.Fatal("KEY_TAKEN must not match other families")
	}
	var ie *Error
	if !errors.As(wrapped, &ie) || ie.Code != CodeKeyTaken {
		t.Fatal("errors.As must surface the typed Error with its code")
	}
}

// TestConcurrentDoubleSubmitIsDeterministic pins the concurrency model:
// N concurrent double-submits of the SAME (scope, key) resolve to exactly
// ONE execution — the lock-acquiring winner — and every loser receives the
// winner's ORIGINAL outcome as a replay. Run under -race.
func TestConcurrentDoubleSubmitIsDeterministic(t *testing.T) {
	r := NewRegistry[int]()
	const n = 64
	var calls int32
	var wg sync.WaitGroup
	results := make([]Result[int], n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			res, err := r.Execute("payments", "double-submit", func() (int, error) {
				atomic.AddInt32(&calls, 1)
				return 42, nil
			})
			if err != nil {
				t.Errorf("Execute: %v", err)
				return
			}
			results[slot] = res
		}(i)
	}
	wg.Wait()

	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("fn ran %d times, want exactly 1 (first-write-wins)", got)
	}
	fresh := 0
	for _, res := range results {
		if res.Value != 42 {
			t.Fatalf("all submitters must see the winner's outcome, got %d", res.Value)
		}
		if !res.Replayed {
			fresh++
		}
	}
	if fresh != 1 {
		t.Fatalf("exactly one submitter must own the fresh result, got %d", fresh)
	}
}

// TestConcurrentPutIsFirstWriteWins pins that N concurrent Puts of one key
// admit exactly one winner; the stored value is whichever write won the lock.
func TestConcurrentPutIsFirstWriteWins(t *testing.T) {
	r := NewRegistry[int]()
	const n = 64
	var wg sync.WaitGroup
	var taken int32
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(slot int) {
			defer wg.Done()
			if err := r.Put("claims", "one-key", slot); err != nil {
				if !errors.Is(err, ErrKeyTaken) {
					t.Errorf("loser error must be KEY_TAKEN, got %v", err)
				}
				atomic.AddInt32(&taken, 1)
			}
		}(i)
	}
	wg.Wait()
	if got := atomic.LoadInt32(&taken); got != n-1 {
		t.Fatalf("%d Puts refused, want %d", got, n-1)
	}
	value, ok := r.Lookup("claims", "one-key")
	if !ok {
		t.Fatal("winner's outcome must be stored")
	}
	if value < 0 || value >= n {
		t.Fatalf("stored value %d out of the submitted range", value)
	}
}

// stub is a reference-typed outcome used to prove replays return the
// ORIGINAL handle, not a copy.
type stub struct{ id string }

func staticFn[T any](v T) func() (T, error) {
	return func() (T, error) { return v, nil }
}
