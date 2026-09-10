// Package daraja is the production Safaricom Daraja REST client for the Go
// backend (issue #96, PRODUCT_ROADMAP P1.3): OAuth token lifecycle, STK Push
// (initiate + query), B2C payouts, transaction status, C2B URL registration,
// and strict callback parsing that ports the K1 untrusted-input boundary from
// src/adapters/daraja/wire.ts with the SAME stable DARAJA_* error codes.
//
// Design invariants (mirror the TS conformance lane, F15 / issue #25):
//   - Money is integer minor units (KES cents) inside this process. The wire
//     carries decimal STRINGS for callbacks (parsed without floats) and whole
//     shillings for STK/B2C initiation (a remainder is refused, never rounded).
//   - Anything structurally wrong with a callback is REFUSED with a stable
//     DARAJA_* code so the transport can dead-letter it (SPEC §14) — a
//     malformed payload is never processed, never guessed at.
//   - R9 idempotency of INTAKE is the domain's job (src/domain/payments): the
//     client only collapses concurrent same-key initiations onto one wire
//     call (double-click guard), and says so in its documentation.
//   - No secrets in code: credentials come from the environment (see
//     ConfigFromEnv), are never logged, and never appear in error messages.
package daraja

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// Stable, machine-readable error codes. Callback codes mirror
// src/adapters/daraja/codes.ts one-for-one; client-side codes extend the
// same prefix so transports can dead-letter without string matching.
const (
	CodePayloadUnrecognized       = "DARAJA_PAYLOAD_UNRECOGNIZED"
	CodeC2BKindRequired           = "DARAJA_C2B_KIND_REQUIRED"
	CodeTransIDRequired           = "DARAJA_TRANS_ID_REQUIRED"
	CodeTransIDMalformed          = "DARAJA_TRANS_ID_MALFORMED"
	CodeTransTimeMalformed        = "DARAJA_TRANS_TIME_MALFORMED"
	CodeAmountRequired            = "DARAJA_AMOUNT_REQUIRED"
	CodeAmountMalformed           = "DARAJA_AMOUNT_MALFORMED"
	CodeAmountNotWholeShilling    = "DARAJA_AMOUNT_NOT_WHOLE_SHILLING"
	CodeShortCodeMalformed        = "DARAJA_SHORT_CODE_MALFORMED"
	CodeMSISDNMalformed           = "DARAJA_MSISDN_MALFORMED"
	CodeBillRefMalformed          = "DARAJA_BILL_REF_MALFORMED"
	CodeCheckoutRequestIDRequired = "DARAJA_CHECKOUT_REQUEST_ID_REQUIRED"
	CodeCheckoutRequestIDMalform  = "DARAJA_CHECKOUT_REQUEST_ID_MALFORMED"
	CodeResultCodeInvalid         = "DARAJA_RESULT_CODE_INVALID"
	CodeSTKMetadataMalformed      = "DARAJA_STK_METADATA_MALFORMED"
	CodeSTKAmountUnknown          = "DARAJA_STK_AMOUNT_UNKNOWN"
	CodeB2CResultMalformed        = "DARAJA_B2C_RESULT_MALFORMED"

	// Client-side families (no TS equivalent: the TS lane is conformance-only).
	CodeConfigInvalid     = "DARAJA_CONFIG_INVALID"
	CodeAuthFailed        = "DARAJA_AUTH_FAILED"
	CodeNetworkFailed     = "DARAJA_NETWORK_FAILED"
	CodeWireMalformed     = "DARAJA_WIRE_MALFORMED"
	CodeAPIError          = "DARAJA_API_ERROR"
	CodeRetryExhausted    = "DARAJA_RETRY_EXHAUSTED"
	CodeDeadlineExceeded  = "DARAJA_DEADLINE_EXCEEDED"
	CodeDuplicateInFlight = "DARAJA_DUPLICATE_IN_FLIGHT"
)

// ErrorKind is the coarse machine-readable taxonomy (issue #84, AC7). The
// stable Code answers "what exactly happened?"; the Kind answers "who acts
// and how?" — alerting (auth/money), retry-with-backoff (network/upstream),
// retry-with-fresh-deadline (timeout), dedup-aware retry (busy),
// dead-letter (validation), or fix-the-caller (config).
type ErrorKind string

// The eight taxonomy kinds. Exhaustive by design: every *Error carries one.
const (
	KindAuth       ErrorKind = "auth"       // credentials/permission problem — alert, re-provision secrets
	KindConfig     ErrorKind = "config"     // caller misuse/misconfiguration — fix the code, never retry
	KindValidation ErrorKind = "validation" // untrusted input refused or request rejected — dead-letter, never retry
	KindMoney      ErrorKind = "money"      // money-boundary refusal — alert finance, dead-letter
	KindNetwork    ErrorKind = "network"    // transport/dependency failure — retry with backoff
	KindTimeout    ErrorKind = "timeout"    // context deadline expired — retry with a fresh deadline
	KindUpstream   ErrorKind = "upstream"   // Daraja unhealthy or contract-violating — retry with backoff, then alert
	KindBusy       ErrorKind = "busy"       // this client's own concurrency guard — retry after the in-flight call lands
)

// kindForCode maps every stable DARAJA_* code onto the taxonomy. Total by
// design: the default is validation because the payload-refusal families
// dominate the code surface.
func kindForCode(code string) ErrorKind {
	switch code {
	case CodeAuthFailed:
		return KindAuth
	case CodeConfigInvalid, CodeC2BKindRequired:
		return KindConfig
	case CodeAmountRequired, CodeAmountMalformed, CodeAmountNotWholeShilling,
		CodeSTKAmountUnknown, CodeDuplicateAmountMismatch:
		return KindMoney
	case CodeNetworkFailed, CodeLedgerUnavailable:
		return KindNetwork
	case CodeDeadlineExceeded:
		return KindTimeout
	case CodeAPIError, CodeRetryExhausted, CodeWireMalformed:
		return KindUpstream
	case CodeDuplicateInFlight:
		return KindBusy
	default:
		return KindValidation
	}
}

// kindForUpstream maps a rejected Daraja response onto the taxonomy from its
// OWN errorCode ("400.*" → validation, "401.*"/"403.*" → auth, "5*" →
// upstream); the HTTP status decides when the body carried no errorCode.
func kindForUpstream(status int, errorCode string) ErrorKind {
	switch {
	case strings.HasPrefix(errorCode, "400."):
		return KindValidation
	case strings.HasPrefix(errorCode, "401."), strings.HasPrefix(errorCode, "403."):
		return KindAuth
	case strings.HasPrefix(errorCode, "5"):
		return KindUpstream
	}
	switch {
	case status >= 500:
		return KindUpstream
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return KindAuth
	default:
		return KindValidation
	}
}

// Error is the only error type this package returns. Code is stable and
// machine-readable; Kind is the coarse taxonomy above; Message is safe for
// logs (credentials are never interpolated); HTTPStatus carries the wire
// status for API-error codes; UpstreamCode carries Daraja's own errorCode
// (e.g. "400.008.01") when its error body parsed.
type Error struct {
	Code         string
	Kind         ErrorKind
	Message      string
	HTTPStatus   int    // 0 when not a wire-level error
	Retryable    bool   // true only for network/5xx families the retry policy covers
	UpstreamCode string // Daraja's own errorCode, '' when the body carried none
	Cause        error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return e.Code + ": " + e.Message + ": " + e.Cause.Error()
	}
	return e.Code + ": " + e.Message
}

func (e *Error) Unwrap() error { return e.Cause }

// errf builds a non-retryable *Error (payload/config/business failures).
func errf(code, format string, args ...any) *Error {
	return &Error{Code: code, Kind: kindForCode(code), Message: fmt.Sprintf(format, args...)}
}

// wireErr builds an *Error from an unexpected HTTP response.
func wireErr(code string, status int, message string) *Error {
	return &Error{Code: code, Kind: kindForCode(code), Message: message, HTTPStatus: status, Retryable: status >= 500}
}

// networkErr wraps a transport-layer failure; always retryable by policy.
func networkErr(cause error, format string, args ...any) *Error {
	return &Error{Code: CodeNetworkFailed, Kind: KindNetwork, Message: fmt.Sprintf(format, args...), Retryable: true, Cause: cause}
}

// IsRetryable reports whether the retry policy may re-attempt the error.
func IsRetryable(err error) bool {
	var de *Error
	if errors.As(err, &de) {
		return de.Retryable
	}
	return false
}

// httpClient is the injected transport port. *http.Client satisfies it; tests
// substitute an httptest-backed round tripper. No real network happens in
// this package's tests.
type httpDoer interface {
	Do(req *http.Request) (*http.Response, error)
}
