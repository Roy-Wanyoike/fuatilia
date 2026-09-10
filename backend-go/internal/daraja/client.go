// The client core (issue #96): configuration, the retry policy (exponential
// backoff with jitter on network/5xx only; 4xx business errors never retried),
// 401 → re-auth-once, and the request helper every endpoint shares.
package daraja

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is Daraja's sandbox; production overrides via DARAJA_BASE_URL.
const DefaultBaseURL = "https://sandbox.safaricom.co.ke"

// Config is the client's composition surface. Credentials come from the
// environment (ConfigFromEnv) and are never logged.
type Config struct {
	// BaseURL is the Daraja root ("https://sandbox.safaricom.co.ke" or the
	// production host). No trailing slash.
	BaseURL string
	// ConsumerKey / ConsumerSecret are the app credentials (env-only).
	ConsumerKey    string
	ConsumerSecret string
	// Timeout caps a single wire call (0 = no client-side cap; contexts still
	// govern). Default 15s.
	Timeout time.Duration
	// Retry policy knobs (defaults: 3 attempts, 200ms initial, 2s max).
	MaxRetries int
	RetryInit  time.Duration
	RetryMax   time.Duration
	// Now and Sleep are injectable for deterministic tests; nil = real time.
	Now   func() time.Time
	Sleep func(ctx context.Context, d time.Duration) error
}

// ConfigFromEnv builds a Config from the documented environment variables:
// DARAJA_BASE_URL (default sandbox), DARAJA_CONSUMER_KEY, DARAJA_CONSUMER_SECRET.
func ConfigFromEnv(env func(string) string) (Config, error) {
	cfg := Config{
		BaseURL:        strings.TrimSpace(env("DARAJA_BASE_URL")),
		ConsumerKey:    strings.TrimSpace(env("DARAJA_CONSUMER_KEY")),
		ConsumerSecret: strings.TrimSpace(env("DARAJA_CONSUMER_SECRET")),
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = DefaultBaseURL
	}
	if cfg.ConsumerKey == "" || cfg.ConsumerSecret == "" {
		return Config{}, errf(CodeConfigInvalid,
			"DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET are required (env), never hardcoded")
	}
	return cfg, nil
}

// Client is a concurrency-safe Daraja REST client. Zero-value is unusable;
// construct with NewClient. All methods honor the passed context.
type Client struct {
	cfg      Config
	doer     httpDoer
	tokens   *tokenManager
	inflight inFlight
	now      func() time.Time
	sleep    func(ctx context.Context, d time.Duration) error
}

// NewClient wires a client over the injected transport. *http.Client is a
// valid doer; tests inject httptest-backed transports.
func NewClient(doer httpDoer, cfg Config) (*Client, error) {
	if cfg.BaseURL == "" || cfg.ConsumerKey == "" || cfg.ConsumerSecret == "" {
		return nil, errf(CodeConfigInvalid, "BaseURL, ConsumerKey and ConsumerSecret are required")
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	if cfg.Timeout == 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.MaxRetries == 0 {
		cfg.MaxRetries = 3
	}
	if cfg.RetryInit == 0 {
		cfg.RetryInit = 200 * time.Millisecond
	}
	if cfg.RetryMax == 0 {
		cfg.RetryMax = 2 * time.Second
	}
	c := &Client{cfg: cfg, doer: doer, tokens: newTokenManager(doer, cfg.BaseURL, cfg.ConsumerKey, cfg.ConsumerSecret)}
	c.now = cfg.Now
	if c.now == nil {
		c.now = time.Now
	}
	c.sleep = cfg.Sleep
	if c.sleep == nil {
		c.sleep = func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}
	return c, nil
}

// callJSON performs an authenticated JSON request with retry + 401 re-auth,
// decoding the (non-error) response body into out (nil skips decoding).
// Request bodies are re-marshalled per attempt so retries never read a
// consumed reader. A 401 triggers EXACTLY ONE immediate re-auth (the token
// was invalidated mid-flight); re-auth does not consume a retry slot.
func (c *Client) callJSON(ctx context.Context, method, path string, in any, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return errf(CodeConfigInvalid, "marshal request: %v", err)
	}
	reauthed := false
	attempt := 0
	for {
		if attempt > 0 {
			if err := c.sleep(ctx, backoffDelay(c.cfg.RetryInit, c.cfg.RetryMax, attempt-1)); err != nil {
				return &Error{Code: CodeDeadlineExceeded, Kind: KindTimeout, Message: "retry backoff aborted: " + err.Error(), Cause: err}
			}
		}
		lastErr := c.attemptOnce(ctx, method, path, body, out)
		if lastErr == nil {
			return nil
		}
		var de *Error
		if errors.As(lastErr, &de) && de.Code == CodeAuthFailed && !reauthed {
			reauthed = true
			continue // token invalidated: immediate retry with a fresh bearer
		}
		if !IsRetryable(lastErr) {
			return lastErr
		}
		attempt++
		if attempt > c.cfg.MaxRetries {
			return &Error{Code: CodeRetryExhausted, Kind: KindUpstream, Message: fmt.Sprintf(
				"gave up after %d attempts on %s %s: %v", attempt, method, path, lastErr), Cause: lastErr}
		}
	}
}

// attemptOnce performs one wire attempt (auth + request + decode).
func (c *Client) attemptOnce(ctx context.Context, method, path string, body []byte, out any) error {
	tok, err := c.tokens.bearer(ctx, c.now())
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.BaseURL+path, strings.NewReader(string(body)))
	if err != nil {
		return networkErr(err, "build request %s %s", method, path)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := c.doer.Do(req)
	if err != nil {
		return networkErr(err, "%s %s", method, path)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		// Token expired/revoked mid-flight: clear and let the retry loop
		// re-auth EXACTLY once more (the next attempt rebuilds the bearer).
		c.tokens.invalidate()
		return wireErr(CodeAuthFailed, resp.StatusCode, "unauthorized — token refreshed for next attempt")
	case resp.StatusCode >= 400:
		return c.upstreamError(resp, method, path)
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return errf(CodeWireMalformed, "%s %s response is not valid JSON: %v", method, path, err)
	}
	return nil
}

// darajaErrorBody is the error envelope Daraja returns on rejected requests
// ({"errorCode":"400.008.01","errorMessage":"..."}); both fields optional.
type darajaErrorBody struct {
	ErrorCode    string `json:"errorCode"`
	ErrorMessage string `json:"errorMessage"`
}

// upstreamError turns a rejected response into a typed DARAJA_API_ERROR:
// Daraja's own errorCode/errorMessage are parsed (bounded read) and mapped
// onto the taxonomy — "400.*" → validation, "401.*"/"403.*" → auth, "5*" →
// upstream; the HTTP status decides when the body carries no errorCode.
func (c *Client) upstreamError(resp *http.Response, method, path string) *Error {
	snippet := safeBodySnippet(resp.Body)
	var info darajaErrorBody
	_ = json.Unmarshal([]byte(snippet), &info) // best-effort: junk bodies fall back to status-based kinds

	msg := fmt.Sprintf("%s %s -> %d", method, path, resp.StatusCode)
	switch {
	case info.ErrorMessage != "":
		msg += ": " + info.ErrorMessage
	case snippet != "(empty body)":
		msg += ": " + snippet
	}
	e := wireErr(CodeAPIError, resp.StatusCode, msg)
	e.Kind = kindForUpstream(resp.StatusCode, info.ErrorCode)
	e.UpstreamCode = info.ErrorCode
	return e
}

// safeBodySnippet reads up to 4 KiB of an error body for diagnostics and
// errorCode parsing — never more (the body is untrusted input).
func safeBodySnippet(r io.Reader) string {
	body, err := io.ReadAll(io.LimitReader(r, 4<<10))
	if err != nil || len(body) == 0 {
		return "(empty body)"
	}
	return string(body)
}

// backoffDelay computes exp backoff with full jitter, capped at max.
func backoffDelay(init, max time.Duration, attempt int) time.Duration {
	d := init << attempt // 200ms, 400ms, 800ms, ...
	if d <= 0 || d > max {
		d = max
	}
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return d / 2 // crypto/rand unavailable is absurd in production; degrade deterministically
	}
	jitter := time.Duration(binary.BigEndian.Uint64(b[:]) % uint64(d+1))
	return jitter
}
