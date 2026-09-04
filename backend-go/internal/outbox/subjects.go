package outbox

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Subject grammar (issue #74, ADR-0003):
//
//	fuatilia.<domain>.<event>.v<version>
//
// derived from the outbox row's (event_type, version) — the persisted face of
// the envelope contract (src/domain/events/envelope.ts). `invoicing.invoiceIssued`
// at version 1 publishes on `fuatilia.invoicing.invoiceIssued.v1`; a future
// breaking payload change (version 2) publishes on `.v2`, so consumers can pin
// a version and never observe an unannounced shape change.
//
// event_type MUST match the catalog naming convention enforced by
// src/domain/events/envelope.ts (EVENT_NAME_PATTERN):
//
//	'<context>.<aggregate><PastTenseVerb>' — lowerCamelCase, exactly one dot
//
// The relay is the last enforcement point before the wire: a row whose
// event_type violates the grammar, or whose version is < 1, is POISONED and
// never published (poison.go). subjects_test.go pins all 27 catalog names of
// src/domain/events/catalog.ts, so a catalog naming drift fails this lane's
// gate before it can reach the broker.
const (
	// SubjectPrefix is the root token of every Fuatilia event subject.
	SubjectPrefix = "fuatilia"
	// SubjectFilter is the JetStream subject coverage of stream FUATILIA_EVENTS.
	SubjectFilter = SubjectPrefix + ".>"
	// StreamName is the single JetStream stream carrying the event fabric
	// (ADR-0003). The single-stream-vs-WorkQueue decision and its rationale
	// are recorded in README.md ("Stream design").
	StreamName = "FUATILIA_EVENTS"
)

// eventTypeNamePattern mirrors envelope.ts EVENT_NAME_PATTERN byte for byte:
//
//	^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$
//
// Only ASCII alphanumerics survive it, which makes every derived NATS token
// wildcard-safe by construction.
var eventTypeNamePattern = regexp.MustCompile(`^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]+$`)

// SubjectFor derives the JetStream subject for an outbox row from its
// (event_type, version).
//
// The returned subject is a literal NATS subject — no wildcards, no empty
// tokens — safe to publish and safe to bind filtered durable consumers
// against. Errors carry the mirrored envelope.ts codes:
//
//   - EVENT_NAME_MALFORMED: event_type does not match the catalog naming
//     convention (the caller MUST poison the row, never publish it);
//   - EVENT_VERSION_UNSUPPORTED: version < 1 (the catalog ships version 1;
//     the DDL face is ck_outbox_version, so this only guards future writers).
func SubjectFor(eventType string, version int) (string, error) {
	if version < 1 {
		return "", &Error{
			Code:    CodeEventVersionUnsupported,
			Message: fmt.Sprintf("event version must be >= 1 (the catalog ships version 1), got %d", version),
		}
	}
	if !eventTypeNamePattern.MatchString(eventType) {
		return "", &Error{
			Code: CodeEventNameMalformed,
			Message: fmt.Sprintf(
				"event name must be '<context>.<aggregate><PastTenseVerb>' in camelCase, got %q — subject unbuildable; poisoning",
				eventType),
		}
	}
	domain, event, _ := strings.Cut(eventType, ".")
	// Defensive fail-closed guard: the pattern above already admits only
	// ASCII alphanumerics, so NATS wildcard characters, dots and whitespace
	// can never appear inside a token. If the pattern is ever loosened this
	// guard keeps the subject grammar honest instead of publishing a subject
	// consumers cannot bind.
	if domain == "" || event == "" ||
		strings.ContainsAny(domain, "*> .") || strings.ContainsAny(event, "*> .") {
		return "", &Error{
			Code: CodeEventNameMalformed,
			Message: fmt.Sprintf(
				"event name %q yields an invalid NATS subject token — subject unbuildable; poisoning",
				eventType),
		}
	}
	return SubjectPrefix + "." + domain + "." + event + ".v" + strconv.Itoa(version), nil
}
