// OAuth token lifecycle (issue #96). Daraja issues short-lived bearer tokens
// from GET /oauth/v1/generate?grant_type=client_credentials with HTTP Basic
// auth. This manager caches the token with an expiry skew (refresh 30s
// early), single-flights concurrent refreshes (no stampede under load), and
// is safe for concurrent use.
package daraja

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// tokenTTLskew refreshes the token this long before its real expiry so an
// in-flight request never ships an expired bearer.
const tokenTTLskew = 30 * time.Second

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresIn   string `json:"expires_in"` // Daraja sends SECONDS as a string
}

// tokenManager owns the bearer token for one credential set.
type tokenManager struct {
	doer           httpDoer
	baseURL        string
	consumerKey    string
	consumerSecret string

	mu      sync.Mutex
	token   string
	expires time.Time
}

func newTokenManager(doer httpDoer, baseURL, key, secret string) *tokenManager {
	return &tokenManager{doer: doer, baseURL: baseURL, consumerKey: key, consumerSecret: secret}
}

// bearer returns a cached token or refreshes it (single-flight: concurrent
// callers block on the same mutex and re-read the refreshed value).
func (m *tokenManager) bearer(ctx context.Context, now time.Time) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.token != "" && now.Before(m.expires) {
		return m.token, nil
	}
	return m.refresh(ctx, now)
}

// refresh forces a new token. Callers hold m.mu.
func (m *tokenManager) refresh(ctx context.Context, now time.Time) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		m.baseURL+"/oauth/v1/generate?grant_type=client_credentials", nil)
	if err != nil {
		return "", networkErr(err, "build oauth request")
	}
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString(
		[]byte(m.consumerKey+":"+m.consumerSecret)))

	resp, err := m.doer.Do(req)
	if err != nil {
		return "", networkErr(err, "oauth token request")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", wireErr(CodeAuthFailed, resp.StatusCode,
			fmt.Sprintf("oauth refused (status %d)", resp.StatusCode))
	}
	var tr tokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&tr); err != nil {
		return "", errf(CodeWireMalformed, "oauth response is not valid JSON: %v", err)
	}
	if tr.AccessToken == "" || tr.ExpiresIn == "" {
		return "", errf(CodeWireMalformed, "oauth response missing access_token or expires_in")
	}
	secs, ok := parseUint(tr.ExpiresIn)
	if !ok || secs <= 0 {
		return "", errf(CodeWireMalformed, "oauth expires_in %q is not a positive integer", tr.ExpiresIn)
	}
	m.token = tr.AccessToken
	m.expires = now.Add(time.Duration(secs)*time.Second - tokenTTLskew)
	if !now.Before(m.expires) {
		// Pathological: TTL shorter than the skew. Use it anyway but mark it
		// stale on the next call rather than failing the caller.
		m.expires = now
	}
	return m.token, nil
}

// invalidate clears the cached token after a 401 so the next call re-auths.
func (m *tokenManager) invalidate() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.token = ""
	m.expires = time.Time{}
}

// parseUint parses a decimal string without allocations or sign handling.
func parseUint(s string) (int64, bool) {
	if s == "" {
		return 0, false
	}
	var v int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + int64(c-'0')
		if v < 0 {
			return 0, false
		}
	}
	return v, true
}
