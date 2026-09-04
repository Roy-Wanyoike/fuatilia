// Package transport is the HTTP face of the Go /v1 kernel (issue #72): the
// stdlib net/http server, the §38 envelope ({data, meta?} successes /
// {error:{code,message}, requestId} failures), the auth middleware and the
// 22 mounted operations. Wire rules mirror src/adapters/http/kernel exactly:
// every response carries x-request-id, unmapped codes fail closed to 500
// HTTP_INTERNAL_ERROR and internals never leak.
package transport

// HTTP transport codes (kernel/errors.ts).
const (
	CodePayloadTooLarge  = "HTTP_PAYLOAD_TOO_LARGE"
	CodeBodyMalformed    = "HTTP_BODY_MALFORMED"
	CodeBodyInvalid      = "HTTP_BODY_INVALID"
	CodeQueryInvalid     = "HTTP_QUERY_INVALID"
	CodeRouteNotFound    = "HTTP_ROUTE_NOT_FOUND"
	CodeMethodNotAllowed = "HTTP_METHOD_NOT_ALLOWED"
	CodeUnauthenticated  = "HTTP_UNAUTHENTICATED"
	CodeInternalError    = "HTTP_INTERNAL_ERROR"
)

// exactStatus is the EXACT override table (evaluated first — e.g.
// KEY_SECRET_MISMATCH maps to 401 even though the suffix rule says 409).
var exactStatus = map[string]int{
	CodePayloadTooLarge:         413,
	CodeBodyMalformed:           400,
	CodeBodyInvalid:             400,
	CodeQueryInvalid:            400,
	CodeRouteNotFound:           404,
	CodeMethodNotAllowed:        405,
	CodeUnauthenticated:         401,
	"HTTP_USER_NOT_FOUND":       404,
	"HTTP_ROLE_NOT_FOUND":       404,
	"HTTP_SESSION_NOT_FOUND":    404,
	"HTTP_RECEIVABLE_NOT_FOUND": 404,
	"HTTP_PAYMENT_NOT_FOUND":    404,
	"HTTP_CASE_NOT_FOUND":       404,
	CodeInternalError:           500,
	// Authorization: authenticated but forbidden — the audited denials.
	"AUTH_ACCESS_DENIED":      403,
	"AUTH_ESCALATION_BLOCKED": 403,
	// Authentication pass-throughs: the auth lane's key/session denials.
	"KEY_UNKNOWN":         401,
	"KEY_SECRET_MISMATCH": 401,
	"KEY_REVOKED":         401,
	"KEY_EXPIRED":         401,
	"KEY_OWNER_INACTIVE":  401,
	// Validation special case: a wildcard where only concrete permissions are legal.
	"AUTH_PERMISSION_WILDCARD_FORBIDDEN": 400,
	// Resource-route refusals — state-machine decisions whose codes carry no
	// suffix the suffix table would catch (unmapped they would fail to 500):
	"PAYMENT_TERMINAL":              409,
	"PAYMENT_NOT_CONFIRMED":         409,
	"INVALID_TRANSITION":            409,
	"REFUND_EXCEEDS_AVAILABLE":      422,
	"CASE_ALREADY_OPEN":             409,
	"CASE_CLOSED":                   409,
	"CASE_ACTION_ALREADY_COMPLETED": 409,
	"DUNNING_CONSENT_REQUIRED":      403,
}

// prefixStatus families: whole code families with one meaning.
var prefixStatus = []struct {
	prefix string
	status int
}{
	{"SESSION_", 401},
	{"SESS_", 401},
	{"KEY_", 401},
	{"PRINCIPAL_", 401},
}

// suffixStatus rules over the stable domain vocabulary.
var suffixStatus = []struct {
	suffix string
	status int
}{
	{"_TAKEN", 409},
	{"_EXISTS", 409},
	{"_DUPLICATE", 409},
	{"_MISMATCH", 409},
	{"_EXPIRED", 422},
	{"_EXCEEDED", 422},
	{"_REFUSED", 422},
	{"_BLOCKED", 403},
	{"_NO_CONSENT", 403},
	{"_INVALID", 400},
	{"_REQUIRED", 400},
	{"_MALFORMED", 400},
	{"_MISSING", 400},
	{"_UNKNOWN", 400},
	{"_TOO_SHORT", 400},
	{"_TOO_LONG", 400},
	{"_EMPTY", 400},
	{"_BLANK", 400},
	{"_ZERO", 400},
	{"_UNPARSEABLE", 400},
	{"_INSECURE", 400},
}

// StatusForCode maps a stable domain/transport code to its HTTP status.
// Deterministic; unmapped codes → 500 (fail closed, never leak).
func StatusForCode(code string) int {
	if status, ok := exactStatus[code]; ok {
		return status
	}
	for _, rule := range prefixStatus {
		if len(code) >= len(rule.prefix) && code[:len(rule.prefix)] == rule.prefix {
			return rule.status
		}
	}
	if len(code) > len("_NOT_FOUND") && code[len(code)-len("_NOT_FOUND"):] == "_NOT_FOUND" {
		return 404
	}
	if contains(code, "_NOT_") {
		return 409 // *_NOT_ACTIVE / _NOT_HELD / _NOT_DUE … state conflicts
	}
	for _, rule := range suffixStatus {
		if len(code) >= len(rule.suffix) && code[len(code)-len(rule.suffix):] == rule.suffix {
			return rule.status
		}
	}
	return 500
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
