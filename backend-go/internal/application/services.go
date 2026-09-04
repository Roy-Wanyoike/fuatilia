// Package application is the Go port of the mounted lanes' application
// surface (issue #72): the /v1 commands and queries the transport routes
// drive, behavior-ported from the TS behavioral specs. Services own the
// transaction boundaries — state change, outbox facts and ledger rows commit
// together — and return typed refusals (*infra.DomainError with stable
// codes), never wrapped panics, for every expected domain outcome.
package application

import (
	"context"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/pkg/idempotency"
)

// The R9 durable scope the payments intake funnel claims its idempotency
// keys under (idempotency_keys.scope — UNIQUE (org_id, scope, key)).
const idempotencyScopeIntake = "payments.intake"

// Services is the composition root of the application layer.
type Services struct {
	Stores *repositories.Stores
	Clock  infra.Clock
	// IDs mints aggregate/event ids (the TS lanes' injected idGen port).
	IDs func() string
	// Replays is the process-local R9 hot cache over the durable
	// idempotency_keys registry: only COMMITTED outcomes are recorded (Put
	// runs after the transaction commits), so a crashed attempt never
	// poisons a legitimate retry — the exact discipline pkg/idempotency
	// documents for durable bindings.
	Replays *idempotency.Registry[string]
}

// Now returns the injected clock's instant.
func (s *Services) Now() time.Time { return s.Clock.Now() }

// appendOutbox appends one envelope-v1 fact to the outbox inside the
// caller's transaction (the transactional outbox — publishing is the relay's
// concern, issue #74; this kernel never touches the broker).
func (s *Services) appendOutbox(ctx context.Context, tx repositories.Querier, orgID, name, aggregateID string, payload map[string]any) error {
	return infra.AppendOutboxEvent(ctx, tx, orgID, infra.OutboxEvent{
		EventID:     s.IDs(),
		Name:        name,
		AggregateID: aggregateID,
		Payload:     payload,
		OccurredAt:  s.Clock.Now(),
	})
}

// claimIdempotencyKey records the (org, scope, key) → outcome_ref row in the
// durable idempotency_keys table (first-write-wins by uq_idempotency_keys).
// When the key is already claimed, the ORIGINAL outcome reference is loaded
// and ok=false is returned so the caller replays it instead of re-executing
// (R9/C5: a duplicate is the SAME logical command).
func (s *Services) claimIdempotencyKey(ctx context.Context, tx repositories.Querier, orgID, key, outcomeRef string) (originalRef string, replayed bool, err error) {
	if _, err := tx.Exec(ctx,
		`INSERT INTO idempotency_keys (org_id, scope, key, outcome_ref)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (org_id, scope, key) DO NOTHING`,
		orgID, idempotencyScopeIntake, key, outcomeRef); err != nil {
		return "", false, err
	}
	var ref string
	err = tx.QueryRow(ctx,
		`SELECT outcome_ref FROM idempotency_keys WHERE org_id = $1 AND scope = $2 AND key = $3`,
		orgID, idempotencyScopeIntake, key).Scan(&ref)
	if err != nil {
		return "", false, err
	}
	return ref, ref != outcomeRef, nil
}

// lookupIdempotencyKey resolves a claimed key to its original outcome id
// ("" when the key is unclaimed).
func (s *Services) lookupIdempotencyKey(ctx context.Context, q repositories.Querier, orgID, key string) string {
	if s.Replays != nil {
		if ref, ok := s.Replays.Lookup(idempotencyScopeIntake+":"+orgID, key); ok {
			return ref
		}
	}
	var ref string
	_ = q.QueryRow(ctx,
		`SELECT outcome_ref FROM idempotency_keys WHERE org_id = $1 AND scope = $2 AND key = $3`,
		orgID, idempotencyScopeIntake, key).Scan(&ref)
	return ref
}

// rememberReplay records a COMMITTED outcome in the process-local hot cache
// (never inside a transaction — only outcomes that survived COMMIT may
// replay from memory).
func (s *Services) rememberReplay(orgID, key, outcomeRef string) {
	if s.Replays == nil {
		return
	}
	_ = s.Replays.Put(idempotencyScopeIntake+":"+orgID, key, outcomeRef)
}
