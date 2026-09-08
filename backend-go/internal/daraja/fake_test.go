// Test fakes: a scriptable fake Daraja server over httptest + a fake
// clock/sleeper pair for deterministic retry tests. No test in this package
// touches real network.
package daraja

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeServer scripts per-path response sequences and records every request.
type fakeServer struct {
	t *testing.T

	mu        sync.Mutex
	scripts   map[string][]scriptedResponse // path → responses (popped front; last repeats)
	requests  map[string][]recordedRequest  // path → recorded requests
	basicAuth string                        // expected Authorization on OAuth calls

	srv *httptest.Server
}

type scriptedResponse struct {
	status int
	body   any
}

type recordedRequest struct {
	method string
	body   []byte
	header http.Header
}

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{t: t, scripts: map[string][]scriptedResponse{}, requests: map[string][]recordedRequest{}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		rec := recordedRequest{method: r.Method, header: r.Header.Clone()}
		if r.Body != nil {
			buf := make([]byte, 1<<16)
			n, _ := r.Body.Read(buf)
			rec.body = buf[:n]
		}
		f.requests[r.URL.Path] = append(f.requests[r.URL.Path], rec)
		script := f.scripts[r.URL.Path]
		f.mu.Unlock()

		if len(script) == 0 {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"no script for path"}`))
			return
		}
		resp := script[0]
		if len(script) > 1 {
			f.mu.Lock()
			f.scripts[r.URL.Path] = script[1:]
			f.mu.Unlock()
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(resp.status)
		if resp.body != nil {
			_ = json.NewEncoder(w).Encode(resp.body)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeServer) script(path string, responses ...scriptedResponse) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.scripts[path] = responses
}

func (f *fakeServer) count(path string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.requests[path])
}

func (f *fakeServer) lastBody(path string) []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	reqs := f.requests[path]
	if len(reqs) == 0 {
		return nil
	}
	return reqs[len(reqs)-1].body
}

func (f *fakeServer) client(t *testing.T, mutate func(*Config)) *Client {
	cfg := Config{
		BaseURL:        f.srv.URL,
		ConsumerKey:    "test-key",
		ConsumerSecret: "test-secret",
		RetryInit:      time.Millisecond,
		RetryMax:       2 * time.Millisecond,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	c, err := NewClient(f.srv.Client(), cfg)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	return c
}

// fakeClock drives Now/Sleep deterministically.
type fakeClock struct {
	mu    sync.Mutex
	now   time.Time
	slept []time.Duration
}

func newFakeClock(start time.Time) *fakeClock { return &fakeClock{now: start} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Sleep(_ context.Context, d time.Duration) error {
	c.mu.Lock()
	c.slept = append(c.slept, d)
	c.now = c.now.Add(d)
	c.mu.Unlock()
	return nil
}

func (c *fakeClock) totalSlept() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	var total time.Duration
	for _, d := range c.slept {
		total += d
	}
	return total
}
