package analytics

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Envelope is the relay's wire envelope (backend-go/internal/outbox/README.md
// "Consumer idempotency contract"), parsed once at the lane boundary:
//
//	{"eventId":"…","name":"…","version":1,"orgId":"…",
//	 "createdAt":"<RFC3339Nano>","payload":<verbatim jsonb>}
//
// The relay publishes payload bytes verbatim; this package keeps that
// fidelity: Payload is the raw JSON exactly as delivered, re-emitted
// byte-for-byte into event_fact. Money is never re-encoded (the relay's
// "no number reinterpretation" rule, continued downstream).
type Envelope struct {
	EventID   string
	Name      string
	Version   int
	OrgID     string
	CreatedAt time.Time // parsed from the wire RFC3339Nano string (UTC-normalized)
	Payload   []byte    // verbatim payload bytes
}

// eventNamePattern mirrors src/domain/events/envelope.ts EVENT_NAME_PATTERN:
// '<context>.<aggregate><PastTenseVerb>' — lowerCamelCase, exactly one dot.
// The relay poisons grammar-invalid rows before they reach the wire; this
// lane re-enforces the same grammar at its own boundary (defense in depth,
// same as the relay re-enforced envelope.ts).
var eventNamePattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$`)

// uuidShape mirrors facts.ts UUID_SHAPE (canonical 8-4-4-4-12 hex).
var uuidShape = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// wireEnvelope is the JSON shadow of the relay envelope.
type wireEnvelope struct {
	EventID   string          `json:"eventId"`
	Name      string          `json:"name"`
	Version   int             `json:"version"`
	OrgID     string          `json:"orgId"`
	CreatedAt string          `json:"createdAt"`
	Payload   json.RawMessage `json:"payload"`
}

// ParseEnvelope parses and validates one raw relay envelope. Invalid
// envelopes are hard errors (fail loud): the batch is refused and the
// consumer redelivers — a malformed envelope is an infrastructure fault,
// not a per-row business outcome.
func ParseEnvelope(data []byte) (Envelope, error) {
	var w wireEnvelope
	if err := json.Unmarshal(data, &w); err != nil {
		return Envelope{}, errf(CodeEnvelopeInvalid, "envelope is not valid JSON: %v", err)
	}
	if !uuidShape.MatchString(w.EventID) {
		return Envelope{}, errf(CodeEnvelopeInvalid, "eventId must be a canonical UUID, got %q", w.EventID)
	}
	if !uuidShape.MatchString(w.OrgID) {
		return Envelope{}, errf(CodeEnvelopeInvalid, "orgId must be a canonical UUID, got %q", w.OrgID)
	}
	if !eventNamePattern.MatchString(w.Name) {
		return Envelope{}, errf(CodeEnvelopeInvalid,
			"name %q must match the catalog grammar '<context>.<aggregate><PastTenseVerb>' (envelope.ts EVENT_NAME_PATTERN)", w.Name)
	}
	if w.Version < 1 {
		return Envelope{}, errf(CodeVersionUnsupported, "version must be >= 1, got %d", w.Version)
	}
	createdAt, err := parseRFC3339(w.CreatedAt)
	if err != nil {
		return Envelope{}, errf(CodeEnvelopeInvalid, "createdAt %q must be an RFC 3339 timestamp: %v", w.CreatedAt, err)
	}
	if len(w.Payload) == 0 || !json.Valid(w.Payload) {
		return Envelope{}, errf(CodeEnvelopeInvalid, "payload must be present, valid JSON (the producer's jsonb, parsed never reconstructed)")
	}
	return Envelope{
		EventID:   w.EventID,
		Name:      w.Name,
		Version:   w.Version,
		OrgID:     w.OrgID,
		CreatedAt: createdAt,
		Payload:   w.Payload,
	}, nil
}

// parseRFC3339 accepts RFC 3339 timestamps with or without fractional
// seconds (RFC3339Nano output and plain RFC3339 both parse).
func parseRFC3339(s string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, err
	}
	return t.UTC(), nil
}

// canonicalLess is the per-org canonical order: (created_at, eventId),
// mirroring the relay's per-org drain order (drainOrg: ORDER BY created_at,
// id) — the order Outbox.drain() defines. Deterministic total order: eventId
// breaks every created_at tie.
func canonicalLess(a, b Envelope) bool {
	if !a.CreatedAt.Equal(b.CreatedAt) {
		return a.CreatedAt.Before(b.CreatedAt)
	}
	return a.EventID < b.EventID
}

// ---------------------------------------------------------------------------
// Payload decoding — narrow, per-event, validated through the TS gates.
// ---------------------------------------------------------------------------

// decoder decodes one payload with json.Number semantics: minor units are
// safe-integer numbers on the wire (catalog.ts) and are parsed into int64
// without ever passing through float64.
func decoder(data []byte) *json.Decoder {
	d := json.NewDecoder(strings.NewReader(string(data)))
	d.UseNumber()
	return d
}

// payloadAmount parses a minor-units amount through the money gate: an
// integer ≥ 0, exactly the TS parseMinorAmount contract (facts.ts) —
// negatives and fractions are refused with the verbatim TS code
// PROJ_AMOUNT_INVALID.
func payloadAmount(n json.Number, field string) (int64, error) {
	v, err := n.Int64()
	if err != nil {
		return 0, errf(CodeAmountInvalid, "%s must be a non-negative integer amount in minor units, got %s", field, n.String())
	}
	if v < 0 {
		return 0, errf(CodeAmountInvalid, "%s must be a non-negative amount in minor units, got %d", field, v)
	}
	return v, nil
}

// payloadInstant parses an ISO-8601 date (YYYY-MM-DD, UTC midnight) or a full
// zoned timestamp — exactly the TS parseInstant contract (facts.ts):
// zone-less local timestamps are refused, never guessed (PROJ_DUE_DATE_INVALID /
// PROJ_FACT_DATE_INVALID depending on the caller's code).
func payloadInstant(s, code, field string) (time.Time, error) {
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UTC(), nil
	}
	if t, err := parseRFC3339(s); err == nil {
		return t, nil
	}
	return time.Time{}, errf(code, "%s must be an ISO-8601 date (YYYY-MM-DD) or zoned timestamp, got %q", field, s)
}

// payloadCurrency validates through the CURRENCIES gate (money.ts:
// KES|USD|GBP|EUR|TZS|UGX) with the verbatim TS code PROJ_CURRENCY_INVALID.
func payloadCurrency(s string) (string, error) {
	switch s {
	case "KES", "USD", "GBP", "EUR", "TZS", "UGX":
		return s, nil
	default:
		return "", errf(CodeCurrencyInvalid,
			"currency must be one of KES|USD|GBP|EUR|TZS|UGX, got %q", s)
	}
}

// payloadUUID validates an id through the 8-4-4-4-12 hex shape.
func payloadUUID(s, code, field string) (string, error) {
	if !uuidShape.MatchString(s) {
		return "", errf(code, "%s must be a UUID-shaped id, got %q", field, s)
	}
	return s, nil
}

// payloadString guards a required non-empty string field.
func payloadString(s, field string) (string, error) {
	if strings.TrimSpace(s) == "" {
		return "", errf(CodePayloadInvalid, "%s must be a non-empty string", field)
	}
	return s, nil
}

// fmtJSONNumber renders a json.Number back to its exact wire text (for error
// messages) without float conversion.
func fmtJSONNumber(n json.Number) string { return n.String() }

// jsonNumber is a tiny helper for error messages that include a raw field.
func rawField(data []byte, field string) string {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return "?"
	}
	if v, ok := probe[field]; ok {
		return string(v)
	}
	return "(missing)"
}

// intFromWire is used by tests and fold diagnostics to render numbers.
func intFromWire(n json.Number) string {
	v, err := n.Int64()
	if err != nil {
		return fmt.Sprintf("%s", n.String())
	}
	return strconv.FormatInt(v, 10)
}
