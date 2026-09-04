package transport

import (
	"strconv"
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/money"
)

// Body field guards (routes/*.ts): wire-shape validation ONLY — the
// application layer re-validates values with the lane's stable codes. Every
// guard refuses with 400 HTTP_BODY_INVALID.

// bodyObject asserts the parsed body is a JSON object.
func bodyObject(body any) (map[string]any, *infra.DomainError) {
	obj, ok := body.(map[string]any)
	if !ok {
		return nil, infra.NewDomainError(CodeBodyInvalid, "request body must be a JSON object", nil)
	}
	return obj, nil
}

// stringField reads a required non-empty string field (trimmed).
func stringField(body map[string]any, name string) (string, *infra.DomainError) {
	value, ok := body[name].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty string", nil)
	}
	return strings.TrimSpace(value), nil
}

// optionalStringField reads a string field that may be absent.
func optionalStringField(body map[string]any, name string) (string, bool, *infra.DomainError) {
	raw, present := body[name]
	if !present || raw == nil {
		return "", false, nil
	}
	value, ok := raw.(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", true, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty string", nil)
	}
	return strings.TrimSpace(value), true, nil
}

// uuidField reads a required UUID field (canonical 8-4-4-4-12).
func uuidField(body map[string]any, name string) (string, *infra.DomainError) {
	raw, err := stringField(body, name)
	if err != nil {
		return "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a UUID", nil)
	}
	if !infra.IsUUID(raw) {
		return "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a UUID", nil)
	}
	return raw, nil
}

// optionalUUIDField reads a UUID field that may be absent.
func optionalUUIDField(body map[string]any, name string) (string, bool, *infra.DomainError) {
	raw, present, err := optionalStringField(body, name)
	if err != nil || !present {
		return "", present, err
	}
	if !infra.IsUUID(raw) {
		return "", true, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a UUID", nil)
	}
	return raw, true, nil
}

// safeIntegerMax is Number.MAX_SAFE_INTEGER (2^53−1) — the TS lanes accept
// money minor units only as safe positive integers, and the Go kernel pins
// the identical boundary on the wire (R10: never a float rounding).
const safeIntegerMax = 9_007_199_254_740_991

// moneyMinorField reads `{ minor, currency }` money: minor must be a safe
// positive integer (json.Number — exact, never a float64), currency a member
// of the closed ISO set (pkg/money's CURRENCIES).
func moneyMinorField(body map[string]any, name string) (int64, money.Currency, *infra.DomainError) {
	raw, ok := body[name].(map[string]any)
	if !ok {
		return 0, "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be an object { minor, currency }", nil)
	}
	minorRaw, hasMinor := raw["minor"]
	currencyRaw, hasCurrency := raw["currency"]
	if !hasMinor || !hasCurrency {
		return 0, "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be an object { minor, currency }", nil)
	}
	minor, ok := minorRaw.(jsonNumber)
	if !ok {
		return 0, "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+".minor' must be a positive integer (minor units)", nil)
	}
	value, err := strconv.ParseInt(minor.String(), 10, 64)
	if err != nil || value <= 0 || value > safeIntegerMax {
		return 0, "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+".minor' must be a positive integer (minor units)", nil)
	}
	currency, ok := currencyRaw.(string)
	if !ok || !money.IsValidCurrency(money.Currency(currency)) {
		return 0, "", infra.NewDomainError(CodeBodyInvalid,
			"field '"+name+".currency' must be one of: KES, USD, GBP, EUR, TZS, UGX", nil)
	}
	return value, money.Currency(currency), nil
}

// stringArrayField reads a required non-empty array of strings (each
// trimmed non-empty).
func stringArrayField(body map[string]any, name string) ([]string, *infra.DomainError) {
	raw, ok := body[name].([]any)
	if !ok || len(raw) == 0 {
		return nil, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty array of strings", nil)
	}
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		value, isString := entry.(string)
		if !isString {
			return nil, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty array of strings", nil)
		}
		out = append(out, value)
	}
	return out, nil
}

// optionalStringArrayField reads an array-of-strings field that may be
// absent (declaredRefs).
func optionalStringArrayField(body map[string]any, name string) ([]string, bool, *infra.DomainError) {
	raw, present := body[name]
	if !present || raw == nil {
		return nil, false, nil
	}
	entries, ok := raw.([]any)
	if !ok {
		return nil, true, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be an array of strings", nil)
	}
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		value, isString := entry.(string)
		if !isString {
			return nil, true, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be an array of strings", nil)
		}
		out = append(out, value)
	}
	return out, true, nil
}

// uuidArrayField reads a required array of unique UUIDs (R8 coverage is per
// receivable — duplicates are a shape error).
func uuidArrayField(body map[string]any, name string) ([]string, *infra.DomainError) {
	raw, ok := body[name].([]any)
	if !ok || len(raw) == 0 {
		return nil, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty array of UUIDs", nil)
	}
	ids := make([]string, 0, len(raw))
	for _, entry := range raw {
		value, isString := entry.(string)
		if !isString || !infra.IsUUID(strings.TrimSpace(value)) {
			return nil, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be a non-empty array of UUIDs", nil)
		}
		id := strings.TrimSpace(value)
		for _, existing := range ids {
			if existing == id {
				return nil, infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must not repeat a receivable id", nil)
			}
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// isoTimeField reads a required ISO-8601 timestamp field.
func isoTimeField(body map[string]any, name string) (isoTime string, err *infra.DomainError) {
	raw, derr := stringField(body, name)
	if derr != nil {
		return "", infra.NewDomainError(CodeBodyInvalid, "field '"+name+"' must be an ISO-8601 timestamp", nil)
	}
	return parseISOTime(raw, name)
}

// optionalISOTimeField reads an optional ISO-8601 timestamp field; the
// second return reports presence (absent vs null both read as absent).
func optionalISOTimeField(body map[string]any, name string) (string, bool, *infra.DomainError) {
	raw, present, derr := optionalStringField(body, name)
	if derr != nil || !present {
		return "", present, derr
	}
	parsed, perr := parseISOTime(raw, name)
	return parsed, true, perr
}

// parseISOTime validates and normalizes an ISO-8601 timestamp the way the
// TS guards do (Date.parse acceptability), re-emitting the canonical
// instant the handlers store and project.
func parseISOTime(raw, field string) (string, *infra.DomainError) {
	parsed, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		// Lenient fallback: Date.parse accepts more than RFC3339 (space
		// separators, date-only); accept those too and canonicalize.
		for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
			if candidate, cerr := time.Parse(layout, raw); cerr == nil {
				return repositories.ISO(candidate), nil
			}
		}
		return "", infra.NewDomainError(CodeBodyInvalid, "field '"+field+"' must be an ISO-8601 timestamp", nil)
	}
	return repositories.ISO(parsed), nil
}

// scopeArrayField reads a required non-empty array of concrete permission
// strings (never validated here — the lane's vocabulary check refuses
// wildcards with AUTH_PERMISSION_WILDCARD_FORBIDDEN → 400).
func scopeArrayField(body map[string]any, name string) ([]string, *infra.DomainError) {
	raw, ok := body[name].([]any)
	if !ok || len(raw) == 0 {
		return nil, infra.NewDomainError(CodeBodyInvalid, "field 'scopes' must be a non-empty array of strings", nil)
	}
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		value, isString := entry.(string)
		if !isString {
			return nil, infra.NewDomainError(CodeBodyInvalid, "field 'scopes' must be a non-empty array of strings", nil)
		}
		out = append(out, value)
	}
	return out, nil
}
