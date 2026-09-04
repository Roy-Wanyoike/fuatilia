package infra

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Querier is the common SQL surface of *pgxpool.Pool, pgxpool.Conn and
// pgx.Tx — persistence helpers accept it so callers decide the transaction
// boundary and the helpers join the caller's transaction when one is open.
type Querier interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// AuditEvent is one audited fact appended to the tamper-evident audit_events
// chain (db/migrations/0013_audit_outbox.sql) — SPEC §37: every consequential
// operation lands here, hash-chained per org so tampering is detectable. The
// kernel appends every auth denial (401/403) and every escalation refusal as
// an audit fact.
type AuditEvent struct {
	// Action is the lane fact name, e.g. "auth.accessDenied" or
	// "auth.escalationBlocked".
	Action string
	// ActorType is one of the schema's closed set: user|api|system|agent.
	ActorType string
	// ActorID is the principal id when known, else "" (rendered as NULL).
	ActorID string
	// Resource is the audited surface (e.g. "auth").
	Resource string
	// ResourceID is the acted-on aggregate id when known, else "".
	ResourceID string
	// Payload is the structured denial payload (ids/reasons only — never
	// credential material).
	Payload map[string]any
	// Reason is the stable DenyReason (KEY_UNKNOWN, NO_GRANT, ...).
	Reason string
	// OccurredAt comes from the injected Clock.
	OccurredAt time.Time
	// OrgID is the denial's org context; empty for pre-authentication
	// denials (the row aggregates on NULL).
	OrgID string
}

// auditChainZeroHash seeds the per-org chain (SHA-256 hex length ≥ 32, per
// ck_audit_hash_shape).
const auditChainZeroHash = "0000000000000000000000000000000000000000000000000000000000000000"

// AppendAuditEvent appends one row to audit_events with chain continuity:
// seq = last(org)+1, prev_hash = last(org).hash,
// hash = SHA-256 over the canonical row serialization.
//
// The chain read + insert are serialized per org by a transaction-level
// advisory lock, so concurrent denials can never branch the chain (the
// (org_id, seq) unique index is the backstop; NULL orgs are serialized by
// the same lock even though NULLs are distinct to the index). The append
// joins the CALLER's transaction when one is open; when q is a pool/conn
// without a transaction the helper opens and commits its own.
func AppendAuditEvent(ctx context.Context, q Querier, e AuditEvent) error {
	tx, owned, err := ensureTx(ctx, q)
	if err != nil {
		return err
	}
	if owned {
		defer tx.Rollback(ctx) //nolint:errcheck // read-only on the success path too
	}
	if err := appendAuditTx(ctx, tx, e); err != nil {
		return err
	}
	if owned {
		return tx.Commit(ctx)
	}
	return nil
}

func appendAuditTx(ctx context.Context, tx pgx.Tx, e AuditEvent) error {
	// Serialize the per-org chain computation (hash key is stable for NULL).
	lockKey := fmt.Sprintf("audit:%s", e.OrgID)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, lockKey); err != nil {
		return err
	}
	var lastSeq int64
	var lastHash *string
	scanErr := tx.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0),
                (SELECT hash FROM audit_events WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY seq DESC LIMIT 1)
                FROM audit_events WHERE org_id IS NOT DISTINCT FROM $1`, nullableText(e.OrgID)).Scan(&lastSeq, &lastHash)
	if scanErr != nil {
		return scanErr
	}
	prevHash := auditChainZeroHash
	if lastHash != nil && *lastHash != "" {
		prevHash = *lastHash
	}
	seq := lastSeq + 1

	payloadJSON := "{}"
	if len(e.Payload) > 0 {
		raw, err := json.Marshal(e.Payload)
		if err != nil {
			return NewDomainError(CodeInternal, fmt.Sprintf("audit payload for %s is not serializable: %v", e.Action, err), nil)
		}
		payloadJSON = string(raw)
	}
	hash := AuditChainHash(seq, e.OrgID, e.ActorType, e.ActorID, e.Action, e.Resource, e.ResourceID, payloadJSON, prevHash)

	_, err := tx.Exec(ctx,
		`INSERT INTO audit_events
                        (org_id, actor_type, actor_id, action, resource, resource_id, payload, reason, seq, prev_hash, hash, occurred_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)`,
		nullableText(e.OrgID), e.ActorType, nullableText(e.ActorID), e.Action, e.Resource,
		nullableText(e.ResourceID), payloadJSON, nullableText(e.Reason),
		seq, prevHash, hash, e.OccurredAt)
	return err
}

// AuditChainHash computes the tamper-evident chain hash over
// (seq, org, actor_type, actor_id, action, resource, resource_id, payload,
// prev_hash) — the same fields db/validate.sh's continuity assertion chains.
func AuditChainHash(seq int64, orgID, actorType, actorID, action, resource, resourceID, payloadJSON, prevHash string) string {
	canonical := fmt.Sprintf("v1|%d|%s|%s|%s|%s|%s|%s|%s|%s",
		seq, orgID, actorType, actorID, action, resource, resourceID, payloadJSON, prevHash)
	sum := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(sum[:])
}

// ensureTx runs f's statements inside a transaction: an existing pgx.Tx is
// used as-is; a pool/conn gets a fresh transaction the helper owns.
func ensureTx(ctx context.Context, q Querier) (pgx.Tx, bool, error) {
	if tx, ok := q.(pgx.Tx); ok {
		return tx, false, nil
	}
	if beginner, ok := q.(interface {
		Begin(context.Context) (pgx.Tx, error)
	}); ok {
		tx, err := beginner.Begin(ctx)
		if err != nil {
			return nil, false, err
		}
		return tx, true, nil
	}
	return nil, false, fmt.Errorf("infra: unsupported querier %T for transactional append", q)
}

// nullableText maps the empty string to SQL NULL (optional text columns).
func nullableText(s string) any {
	if s == "" {
		return nil
	}
	return s
}
