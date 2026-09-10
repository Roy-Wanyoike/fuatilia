package transport

import (
	"net/http"
	"strings"
)

// Security headers (issue #130, PRODUCTION_AUDIT §5.2): every kernel
// response — success, refusal, panic recovery — carries the hardening set.
// This is a JSON API with no browser surface, so the policy denies
// everything by default; only HSTS is behind a deployment flag (enabling it
// on a plain-HTTP deployment would hard-pin HTTP clients, so the operator
// turns it on once TLS termination is real).
const (
	// contentSecurityPolicyValue denies every fetch/frame target: a pure
	// /v1 JSON API loads nothing, inline or otherwise.
	contentSecurityPolicyValue = "default-src 'none'; frame-ancestors 'none'"
	// xContentTypeOptionsValue stops MIME sniffing of the JSON envelopes.
	xContentTypeOptionsValue = "nosniff"
	// referrerPolicyValue never leaks request URLs (which carry org ids and
	// resource ids) to downstream referrer processing.
	referrerPolicyValue = "no-referrer"
	// xFrameOptionsValue refuses legacy frame/embedding clients.
	xFrameOptionsValue = "DENY"

	// securityHSTSHeader is the Strict-Transport-Security header name.
	securityHSTSHeader = "Strict-Transport-Security"
	// DefaultHSTSMaxAgeSeconds is the one-year policy HSTS uses when the
	// deployment enables it without naming a max-age.
	DefaultHSTSMaxAgeSeconds = 31_536_000
)

// SecurityHeaders is the deployment's header policy (issue #130). The zero
// value applies the four unconditional headers; HSTS stays off until the
// flag turns it on (SecurityHeadersFromEnv).
type SecurityHeaders struct {
	// HSTSEnabled turns the Strict-Transport-Security header on.
	HSTSEnabled bool
	// HSTSMaxAgeSeconds is the policy max-age; ≤ 0 defaults to
	// DefaultHSTSMaxAgeSeconds.
	HSTSMaxAgeSeconds int
}

// normalized applies the HSTS max-age default.
func (s SecurityHeaders) normalized() SecurityHeaders {
	if s.HSTSEnabled && s.HSTSMaxAgeSeconds <= 0 {
		s.HSTSMaxAgeSeconds = DefaultHSTSMaxAgeSeconds
	}
	return s
}

// apply writes the hardening set onto the response header map. The kernel
// calls this BEFORE any byte is written, so the headers ride EVERY response
// — 200s, every envelope refusal, 429s and panic recoveries alike.
func (s SecurityHeaders) apply(h http.Header) {
	h.Set("Content-Security-Policy", contentSecurityPolicyValue)
	h.Set("X-Content-Type-Options", xContentTypeOptionsValue)
	h.Set("Referrer-Policy", referrerPolicyValue)
	h.Set("X-Frame-Options", xFrameOptionsValue)
	if s.HSTSEnabled {
		h.Set(securityHSTSHeader, "max-age="+itoa(int64(s.normalized().HSTSMaxAgeSeconds))+"; includeSubDomains")
	}
}

// SecurityHeadersFromEnv reads the deployment contract (issue #130):
//
//	FUATILIA_HSTS_ENABLED — truthy ("1"/"true"/"on"/"yes") enables the HSTS
//	                        header; unset or anything else keeps it off.
//	FUATILIA_HSTS_MAX_AGE — the policy max-age in seconds (positive integer;
//	                        unset → DefaultHSTSMaxAgeSeconds).
//
// A malformed value is a composition error (boot failure), never silently
// ignored — the same fail-fast rule infra.LoadConfig applies.
func SecurityHeadersFromEnv(env func(string) string) (SecurityHeaders, error) {
	out := SecurityHeaders{}
	switch strings.ToLower(strings.TrimSpace(env("FUATILIA_HSTS_ENABLED"))) {
	case "", "0", "false", "off", "no":
		// HSTS stays off (the default — enabling it is an operator decision).
	case "1", "true", "on", "yes":
		out.HSTSEnabled = true
	default:
		return SecurityHeaders{}, errSecurityConfig("FUATILIA_HSTS_ENABLED must be a boolean (1/true/on/yes or 0/false/off/no)")
	}
	if raw := strings.TrimSpace(env("FUATILIA_HSTS_MAX_AGE")); raw != "" {
		seconds, ok := parseEnvSeconds(raw)
		if !ok {
			return SecurityHeaders{}, errSecurityConfig("FUATILIA_HSTS_MAX_AGE must be a positive integer of seconds")
		}
		out.HSTSMaxAgeSeconds = seconds
	}
	return out, nil
}

// parseEnvInt parses a strict non-negative decimal integer (no sign, no
// spaces beyond trim, no overflow past int).
func parseEnvInt(raw string) (int, bool) {
	if raw == "" {
		return 0, false
	}
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
		if n > 1<<31-1 {
			return 0, false
		}
	}
	return n, true
}

// parseEnvSeconds parses a strict positive integer of seconds.
func parseEnvSeconds(raw string) (int, bool) {
	n, ok := parseEnvInt(raw)
	if !ok || n < 1 {
		return 0, false
	}
	return n, true
}

type securityConfigError string

func (e securityConfigError) Error() string { return string(e) }

func errSecurityConfig(msg string) error { return securityConfigError("security headers: " + msg) }
