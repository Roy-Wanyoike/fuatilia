package webhooks

// The signed canonical delivery envelope — the Go face of attempts.ts
// canonicalEnvelope: keys appear in THIS order and the bytes are assembled
// manually so "the signed shape is stable" is true by construction, not by
// library behaviour (the outbox relay's buildEnvelope precedent).
//
//     {"name":"<eventType>","version":1,"aggregateId":"<eventId>",
//      "orgId":"<orgId>","occurredAt":"<ISO-8601 millis>","payload":<verbatim>}
//
// The payload region is the webhook_deliveries.payload jsonb text appended
// BYTE FOR BYTE — no re-encoding, no key reordering, no number
// reinterpretation: money stays the integer literal the producer wrote, and
// every attempt of a delivery (including crash redeliveries) signs and sends
// byte-identical payloads so receivers can dedupe by aggregateId (= the event
// id, the documented payload contract).

import (
	"encoding/json"
	"strconv"
	"time"
)

// MillisecondISO formats t exactly like JavaScript's toISOString():
// millisecond precision, UTC, trailing Z (e.g. 2026-03-01T08:00:00.000Z).
func MillisecondISO(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// Envelope field values pinned by attempts.ts canonicalEnvelope.
const envelopeVersion = 1

// BuildCanonicalEnvelope renders the wire JSON for one delivery row.
// eventType is the only free-form field and goes through strict JSON
// escaping; eventID/orgID originate from PostgreSQL uuid columns (charset
// [0-9a-f-]) and occurredAt from the fixed ISO format above, so they are
// appended literally.
func BuildCanonicalEnvelope(eventType, eventID, orgID string, occurredAt time.Time, payloadJSON []byte) []byte {
	buf := make([]byte, 0, len(payloadJSON)+160)
	buf = append(buf, `{"name":`...)
	buf = appendJSONString(buf, eventType)
	buf = append(buf, `,"version":`...)
	buf = strconv.AppendInt(buf, envelopeVersion, 10)
	buf = append(buf, `,"aggregateId":"`...)
	buf = append(buf, eventID...)
	buf = append(buf, `","orgId":"`...)
	buf = append(buf, orgID...)
	buf = append(buf, `","occurredAt":"`...)
	buf = append(buf, MillisecondISO(occurredAt)...)
	buf = append(buf, `","payload":`...)
	buf = append(buf, payloadJSON...)
	buf = append(buf, '}')
	return buf
}

// appendJSONString appends s as a strict RFC 8259 JSON string (the outbox
// relay's helper — never fails for string inputs).
func appendJSONString(buf []byte, s string) []byte {
	enc, err := json.Marshal(s)
	if err != nil {
		return append(buf, `""`...)
	}
	return append(buf, enc...)
}
