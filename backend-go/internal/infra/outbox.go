package infra

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// OutboxEvent is the stable envelope-v1 domain fact (the port of
// src/domain/events/envelope.ts): the kernel appends it to the outbox table
// in the SAME transaction as the state change that produced it (transactional
// outbox, ADR-0003). Publishing to the broker is issue #74's relay — the
// kernel never touches NATS.
type OutboxEvent struct {
	// EventID mints the idempotent replay key: uq_outbox_events_event
	// UNIQUE (org_id, event_id) — replaying a command cannot double-append.
	EventID string
	// Name is the catalog event name (e.g. "payment.confirmed" — the TS
	// catalog's <context>.<aggregate><PastTenseVerb> grammar).
	Name string
	// AggregateID is the owning aggregate (payment id, case id, grant id…).
	AggregateID string
	// Payload is narrow and serializable: ids/scalars only, ISO-8601 strings.
	Payload map[string]any
	// OccurredAt comes from the injected Clock.
	OccurredAt time.Time
}

// AppendOutboxEvent INSERTs the envelope into outbox_events exactly per
// db/migrations/0013_audit_outbox.sql (org_id, event_id, event_type, version
// 1, payload jsonb, status 'pending').
//
// Column discipline (bound to the relay's wire contract, internal/outbox —
// issue #74): the payload column carries the BARE event payload; the relay
// composes the published envelope {eventId, name, version, orgId, createdAt,
// payload} from the row's columns and publishes those payload bytes VERBATIM
// (buildEnvelope). Storing envelope metadata inside the payload column would
// publish an envelope inside an envelope, so the event_id / event_type /
// version columns ARE the envelope face and payload is never re-typed.
//
// It runs on the CALLER's transaction (a command fact and its state change
// commit together) — a bare pool is refused, append facts are never
// auto-committed.
func AppendOutboxEvent(ctx context.Context, tx Querier, orgID string, event OutboxEvent) error {
	if event.EventID == "" {
		event.EventID = NewUUID()
	}
	payloadJSON, err := json.Marshal(orEmptyObject(event.Payload))
	if err != nil {
		return NewDomainError(CodeInternal, fmt.Sprintf("outbox payload for %s is not serializable: %v", event.Name, err), nil)
	}
	_, err = tx.Exec(ctx,
		`INSERT INTO outbox_events (org_id, event_id, event_type, version, payload, status)
		 VALUES ($1, $2, $3, 1, $4::jsonb, 'pending')`,
		orgID, event.EventID, event.Name, string(payloadJSON))
	return err
}

func orEmptyObject(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
