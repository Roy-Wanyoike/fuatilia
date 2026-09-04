package repositories

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// UserRow is the org-scoped user projection (no hash material).
type UserRow struct {
	ID          string
	OrgID       string
	Email       string
	Username    string
	DisplayName string
	Status      string
	CreatedAt   time.Time
}

// RoleRow is the per-org role definition.
type RoleRow struct {
	ID          string
	OrgID       string
	Name        string
	Permissions []string
}

// GrantRow is one role_assignments fact merged with its revocation (the
// "latest fact wins" projection of the append-only ledger).
type GrantRow struct {
	ID            string
	OrgID         string
	UserID        string
	RoleID        string
	ResourceID    *string
	GrantedBy     string
	GrantedAt     time.Time
	RevokedAt     *time.Time
	RevokedReason *string
}

// KeyRow is the api_keys projection — hash + prefix only, never plaintext.
type KeyRow struct {
	ID            string
	OrgID         string
	Name          string
	CreatedBy     string
	Prefix        string
	SecretHash    string
	Scopes        []string
	ExpiresAt     *time.Time
	Status        string
	CreatedAt     time.Time
	LastUsedAt    *time.Time
	RevokedAt     *time.Time
	RevokedReason *string
}

// SessionRow is the session record (the Bearer token IS the session id).
type SessionRow struct {
	ID                string
	OrgID             string
	UserID            string
	IDLETimeoutMS     int64
	AbsoluteTimeoutMS int64
	Status            string
	CreatedAt         time.Time
	LastSeenAt        time.Time
	EndedAt           *time.Time
	EndedReason       *string
}

// ErrNotFound is the store's "no such row" signal (mapped by the application
// layer to the route's stable HTTP_*_NOT_FOUND code).
var ErrNotFound = errors.New("repositories: row not found")

// AuthStore is the pgx-backed auth surface: credential verification (the
// auth.Verifier port) plus the admin-table persistence the /v1/auth routes
// run through. The clock is INJECTED (deterministic tests freeze it): every
// expiry evaluation and last-used stamp flows through it — the domain never
// reads the wall clock directly (the TS lanes' Clock port).
type AuthStore struct {
	Q     Querier
	Clock infra.Clock
}

// NewAuthStore binds the store to a querier and the injected clock.
func NewAuthStore(q Querier, clock infra.Clock) *AuthStore {
	return &AuthStore{Q: q, Clock: clock}
}

// --- credential verification (auth.Verifier) ---------------------------------

// SessionPrincipal verifies a Bearer token (which IS the session id) and
// projects the user principal with its grant-derived rules. Denials carry
// the lane's stable codes (PRINCIPAL_UNKNOWN, SESSION_*).
func (s *AuthStore) SessionPrincipal(ctx context.Context, token string) auth.Outcome {
	session, err := s.SessionByID(ctx, token)
	if err != nil {
		return authDeny("PRINCIPAL_UNKNOWN", "no session matches the presented token", "", "", "unknown")
	}
	now := s.Clock.Now()
	state := sessionState(session, now)
	if state != "active" {
		code := sessionStateCode(state)
		return authDeny(code, "session "+session.ID+" is "+state+" — unusable credentials", session.OrgID, session.UserID, "user")
	}
	user, err := s.UserByID(ctx, session.OrgID, session.UserID)
	if err != nil {
		return authDeny("PRINCIPAL_UNKNOWN", "no user record matches the session identity", session.OrgID, session.UserID, "user")
	}
	if user.Status != "active" {
		return authDeny(principalStatusReason(user.Status), "user "+user.ID+" is "+user.Status+" — principals must be live", user.OrgID, user.ID, "user")
	}
	rules, err := s.ActiveRulesForUser(ctx, session.OrgID, session.UserID)
	if err != nil {
		return authDeny(infra.CodeInternal, "credential verification failed", session.OrgID, session.UserID, "user")
	}
	return auth.Outcome{
		Authenticated: true,
		Principal: auth.Principal{
			Kind:        "user",
			PrincipalID: user.ID,
			OrgID:       user.OrgID,
			Status:      user.Status,
			Rules:       rules,
		},
	}
}

// APIKeyPrincipal verifies `ApiKey <id>.<secret>`: the wire names the key id,
// the hash is verified constant-time, and the denial ladder mirrors the TS
// auth lane (KEY_UNKNOWN → KEY_SECRET_MISMATCH → KEY_REVOKED → KEY_EXPIRED →
// KEY_OWNER_INACTIVE).
func (s *AuthStore) APIKeyPrincipal(ctx context.Context, id, secret string) auth.Outcome {
	key, err := s.KeyByID(ctx, id)
	if err != nil {
		return authDeny("KEY_UNKNOWN", "no api key carries the presented id", "", "", "apiKey")
	}
	var codec auth.SecretCodec = auth.SHA256Codec{}
	if len(secret) < 8 {
		return authDeny("KEY_UNKNOWN", "presented secret is shorter than a key prefix", key.OrgID, key.ID, "apiKey")
	}
	if !codec.Verify(secret, key.SecretHash) {
		return authDeny("KEY_SECRET_MISMATCH", "secret does not match any key with prefix '"+key.Prefix+"'", key.OrgID, key.ID, "apiKey")
	}
	if key.Status == "revoked" {
		at := "unknown"
		if key.RevokedAt != nil {
			at = ISO(*key.RevokedAt)
		}
		return authDeny("KEY_REVOKED", "api key "+key.ID+" was revoked at "+at+" — replay is denied and audited", key.OrgID, key.ID, "apiKey")
	}
	now := s.Clock.Now()
	if key.ExpiresAt != nil && !now.Before(*key.ExpiresAt) {
		return authDeny("KEY_EXPIRED", "api key "+key.ID+" expired at "+ISO(*key.ExpiresAt), key.OrgID, key.ID, "apiKey")
	}
	owner, err := s.UserByID(ctx, key.OrgID, key.CreatedBy)
	if err != nil {
		return authDeny("KEY_OWNER_INACTIVE", "api key "+key.ID+" owner is unknown — suspension cascades to the owner's keys", key.OrgID, key.ID, "apiKey")
	}
	if owner.Status != "active" {
		return authDeny("KEY_OWNER_INACTIVE", "api key "+key.ID+" owner is "+owner.Status+" — suspension cascades to the owner's keys", key.OrgID, key.ID, "apiKey")
	}
	rules := make([]auth.PermissionRule, 0, len(key.Scopes))
	for _, scope := range key.Scopes {
		rules = append(rules, auth.PermissionRule{Rule: scope})
	}
	return auth.Outcome{
		Authenticated: true,
		Principal: auth.Principal{
			Kind:        "apiKey",
			PrincipalID: key.ID,
			OrgID:       key.OrgID,
			Status:      "active",
			Rules:       rules,
		},
	}
}

// sessionState evaluates the session's liveness (idle/absolute horizons
// included) — the port of the TS sessions lane's sessionState.
func sessionState(s SessionRow, now time.Time) string {
	switch s.Status {
	case "ended":
		return "ended"
	case "revoked":
		return "revoked"
	case "expired":
		return "expired"
	}
	if !now.Before(s.CreatedAt.Add(time.Duration(s.AbsoluteTimeoutMS) * time.Millisecond)) {
		return "absoluteExpired"
	}
	if !now.Before(s.LastSeenAt.Add(time.Duration(s.IDLETimeoutMS) * time.Millisecond)) {
		return "idleExpired"
	}
	return "active"
}

func sessionStateCode(state string) string {
	switch state {
	case "idleExpired":
		return "SESSION_IDLE_EXPIRED"
	case "absoluteExpired", "expired":
		return "SESSION_ABSOLUTE_EXPIRED"
	case "revoked":
		return "SESSION_REVOKED"
	case "ended":
		return "SESSION_ENDED"
	}
	return "PRINCIPAL_UNKNOWN"
}

func principalStatusReason(status string) string {
	switch status {
	case "suspended":
		return "PRINCIPAL_SUSPENDED"
	case "deactivated":
		return "PRINCIPAL_DEACTIVATED"
	}
	return "PRINCIPAL_UNKNOWN"
}

func authDeny(code, message, orgID, principalID, kind string) auth.Outcome {
	return auth.Outcome{
		Authenticated: false,
		Code:          code,
		Message:       message,
		Reason:        code,
		OrgID:         orgID,
		PrincipalID:   principalID,
		PrincipalKind: kind,
	}
}

// --- row lookups ---------------------------------------------------------------

// valueOf dereferences an optional string pointer.
func valueOf(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// UserByID loads one org-scoped user projection.
func (s *AuthStore) UserByID(ctx context.Context, orgID, userID string) (UserRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT id, org_id, email, username, display_name, status, created_at
                   FROM users WHERE org_id = $1 AND id = $2`, orgID, userID)
	var u UserRow
	err := row.Scan(&u.ID, &u.OrgID, &u.Email, &u.Username, &u.DisplayName, &u.Status, &u.CreatedAt)
	if err != nil {
		return UserRow{}, scanErr("user lookup", err)
	}
	return u, nil
}

// UserByEmail loads a user by org+email (uniqueness pre-checks).
func (s *AuthStore) UserByEmail(ctx context.Context, orgID, email string) (UserRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT id, org_id, email, username, display_name, status, created_at
                   FROM users WHERE org_id = $1 AND email = $2`, orgID, email)
	var u UserRow
	err := row.Scan(&u.ID, &u.OrgID, &u.Email, &u.Username, &u.DisplayName, &u.Status, &u.CreatedAt)
	if err != nil {
		return UserRow{}, scanErr("user by email", err)
	}
	return u, nil
}

// UserByUsername loads a user by org+username (uniqueness pre-checks).
func (s *AuthStore) UserByUsername(ctx context.Context, orgID, username string) (UserRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT id, org_id, email, username, display_name, status, created_at
                   FROM users WHERE org_id = $1 AND username = $2`, orgID, username)
	var u UserRow
	err := row.Scan(&u.ID, &u.OrgID, &u.Email, &u.Username, &u.DisplayName, &u.Status, &u.CreatedAt)
	if err != nil {
		return UserRow{}, scanErr("user by username", err)
	}
	return u, nil
}

// InsertUser persists a new user (password_hash is an unusable random
// verifier — this kernel mints credentials via sessions/keys, not passwords).
func (s *AuthStore) InsertUser(ctx context.Context, q Querier, u UserRow, passwordHash string) error {
	_, err := q.Exec(ctx,
		`INSERT INTO users (id, org_id, email, username, display_name, status, password_hash, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6::user_status, $7, $8)`,
		u.ID, u.OrgID, u.Email, u.Username, u.DisplayName, u.Status, passwordHash, u.CreatedAt)
	return err
}

// RoleByID loads one org-scoped role definition.
func (s *AuthStore) RoleByID(ctx context.Context, orgID, roleID string) (RoleRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT id, org_id, name, permissions FROM roles WHERE org_id = $1 AND id = $2`, orgID, roleID)
	var r RoleRow
	err := row.Scan(&r.ID, &r.OrgID, &r.Name, &r.Permissions)
	if err != nil {
		return RoleRow{}, scanErr("role lookup", err)
	}
	return r, nil
}

// ActiveRulesForUser projects a user's active grant ledger into the
// permission rules the guard consumes (grant facts with no revocation fact).
func (s *AuthStore) ActiveRulesForUser(ctx context.Context, orgID, userID string) ([]auth.PermissionRule, error) {
	rows, err := s.Q.Query(ctx,
		`SELECT r.permissions, ra.resource_id
                   FROM role_assignments ra
                   JOIN roles r ON r.org_id = ra.org_id AND r.id = ra.role_id
                  WHERE ra.org_id = $1 AND ra.user_id = $2 AND ra.kind = 'grant'
                    AND NOT EXISTS (SELECT 1 FROM role_assignments rv WHERE rv.revoked_grant_id = ra.id)`,
		orgID, userID)
	if err != nil {
		return nil, scanErr("active grants", err)
	}
	defer rows.Close()
	var rules []auth.PermissionRule
	for rows.Next() {
		var perms []string
		var resource *string
		if err := rows.Scan(&perms, &resource); err != nil {
			return nil, scanErr("active grants scan", err)
		}
		for _, p := range perms {
			rules = append(rules, auth.PermissionRule{Rule: p, ResourceID: valueOf(resource)})
		}
	}
	return rules, rows.Err()
}

// ActiveGrantFor finds the ACTIVE grant fact covering (user, role, resource).
func (s *AuthStore) ActiveGrantFor(ctx context.Context, orgID, userID, roleID string, resourceID *string) (GrantRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT ra.id, ra.org_id, ra.user_id, ra.role_id, ra.resource_id, ra.granted_by, ra.granted_at,
                        ra.revoked_at, ra.revoked_reason
                   FROM role_assignments ra
                  WHERE ra.org_id = $1 AND ra.user_id = $2 AND ra.role_id = $3 AND ra.kind = 'grant'
                    AND ra.resource_id IS NOT DISTINCT FROM $4
                    AND NOT EXISTS (SELECT 1 FROM role_assignments rv WHERE rv.revoked_grant_id = ra.id)
                  ORDER BY ra.granted_at LIMIT 1`,
		orgID, userID, roleID, resourceID)
	return scanGrant(row)
}

// GrantByID loads one grant fact (revocation projection included).
func (s *AuthStore) GrantByID(ctx context.Context, orgID, grantID string) (GrantRow, error) {
	row := s.Q.QueryRow(ctx,
		`SELECT id, org_id, user_id, role_id, resource_id, granted_by, granted_at,
                        revoked_at, revoked_reason
                   FROM role_assignments WHERE org_id = $1 AND id = $2`, orgID, grantID)
	return scanGrant(row)
}

func scanGrant(row pgx.Row) (GrantRow, error) {
	var g GrantRow
	err := row.Scan(&g.ID, &g.OrgID, &g.UserID, &g.RoleID, &g.ResourceID, &g.GrantedBy, &g.GrantedAt,
		&g.RevokedAt, &g.RevokedReason)
	if err != nil {
		return GrantRow{}, scanErr("grant lookup", err)
	}
	return g, nil
}

// InsertGrant appends a grant fact to the append-only ledger.
func (s *AuthStore) InsertGrant(ctx context.Context, q Querier, g GrantRow) error {
	_, err := q.Exec(ctx,
		`INSERT INTO role_assignments (id, org_id, kind, user_id, role_id, resource_id, granted_by, granted_at)
                 VALUES ($1, $2, 'grant', $3, $4, $5, $6, $7)`,
		g.ID, g.OrgID, g.UserID, g.RoleID, g.ResourceID, g.GrantedBy, g.GrantedAt)
	return err
}

// InsertRevokeFact appends a revocation FACT referencing the grant it revokes
// (role_assignments is append-only: revocation is never an UPDATE).
func (s *AuthStore) InsertRevokeFact(ctx context.Context, q Querier, grant GrantRow, revokedBy, reason string, at time.Time) error {
	_, err := q.Exec(ctx,
		`INSERT INTO role_assignments (id, org_id, kind, user_id, role_id, granted_by, granted_at,
                                               revoked_grant_id, revoked_at, revoked_by, revoked_reason)
                 VALUES ($1, $2, 'revoke', $3, $4, $5, $6, $7, $8, $9, $10)`,
		infra.NewUUID(), grant.OrgID, grant.UserID, grant.RoleID, grant.GrantedBy, grant.GrantedAt,
		grant.ID, at, revokedBy, reason)
	return err
}

// KeyByID loads one api key row by its global key id.
func (s *AuthStore) KeyByID(ctx context.Context, keyID string) (KeyRow, error) {
	row := s.Q.QueryRow(ctx, keySelect+` WHERE key_id = $1`, keyID)
	return scanKey(row)
}

// KeyByIDInOrg loads one api key scoped to the caller's org (admin surface).
func (s *AuthStore) KeyByIDInOrg(ctx context.Context, orgID, keyID string) (KeyRow, error) {
	row := s.Q.QueryRow(ctx, keySelect+` WHERE org_id = $1 AND key_id = $2`, orgID, keyID)
	return scanKey(row)
}

const keySelect = `SELECT key_id, org_id, name, created_by, prefix, secret_hash, scopes, expires_at,
                              status, created_at, last_used_at, revoked_at, revoked_reason FROM api_keys`

func scanKey(row pgx.Row) (KeyRow, error) {
	var k KeyRow
	err := row.Scan(&k.ID, &k.OrgID, &k.Name, &k.CreatedBy, &k.Prefix, &k.SecretHash, &k.Scopes,
		&k.ExpiresAt, &k.Status, &k.CreatedAt, &k.LastUsedAt, &k.RevokedAt, &k.RevokedReason)
	if err != nil {
		return KeyRow{}, scanErr("api key lookup", err)
	}
	return k, nil
}

// KeyPrefixTaken reports whether another key in the org already shows this
// visible prefix (the AUTH_KEY_PREFIX_TAKEN refusal's lookup — the TS lane
// checks the prefix across ALL issuance records, not only live ones, so a
// revoked key's prefix stays reserved).
func (s *AuthStore) KeyPrefixTaken(ctx context.Context, orgID, prefix string) (bool, error) {
	var taken bool
	err := s.Q.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM api_keys WHERE org_id = $1 AND prefix = $2)`,
		orgID, prefix).Scan(&taken)
	return taken, err
}

// InsertKey persists a newly issued api key (hash + prefix only).
func (s *AuthStore) InsertKey(ctx context.Context, q Querier, k KeyRow) error {
	_, err := q.Exec(ctx,
		`INSERT INTO api_keys (key_id, org_id, name, created_by, prefix, secret_hash, scopes,
                                       expires_at, status, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)`,
		k.ID, k.OrgID, k.Name, k.CreatedBy, k.Prefix, k.SecretHash, k.Scopes, nullTime(k.ExpiresAt), k.CreatedAt)
	return err
}

// RevokeKey stamps the revocation fact on a live key (api_keys is mutable —
// the revocation is a column stamp, immutably once-only).
func (s *AuthStore) RevokeKey(ctx context.Context, q Querier, orgID, keyID, revokedBy, reason string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE api_keys SET status = 'revoked', revoked_at = $3, revoked_by = $4, revoked_reason = $5
                  WHERE org_id = $1 AND key_id = $2`,
		orgID, keyID, at, revokedBy, reason)
	return err
}

// SessionByID loads one session row by its id (the Bearer token).
func (s *AuthStore) SessionByID(ctx context.Context, sessionID string) (SessionRow, error) {
	row := s.Q.QueryRow(ctx, sessionSelect+` WHERE session_id = $1`, sessionID)
	return scanSession(row)
}

// SessionByIDInOrg loads one session scoped to the caller's org.
func (s *AuthStore) SessionByIDInOrg(ctx context.Context, orgID, sessionID string) (SessionRow, error) {
	row := s.Q.QueryRow(ctx, sessionSelect+` WHERE org_id = $1 AND session_id = $2`, orgID, sessionID)
	return scanSession(row)
}

const sessionSelect = `SELECT session_id, org_id, user_id, idle_timeout_ms, absolute_timeout_ms,
                                  status, created_at, last_seen_at, ended_at, ended_reason FROM sessions`

func scanSession(row pgx.Row) (SessionRow, error) {
	var s SessionRow
	err := row.Scan(&s.ID, &s.OrgID, &s.UserID, &s.IDLETimeoutMS, &s.AbsoluteTimeoutMS,
		&s.Status, &s.CreatedAt, &s.LastSeenAt, &s.EndedAt, &s.EndedReason)
	if err != nil {
		return SessionRow{}, scanErr("session lookup", err)
	}
	return s, nil
}

// TouchSession refreshes last_seen_at (idle horizon) on a live session.
func (s *AuthStore) TouchSession(ctx context.Context, q Querier, orgID, sessionID string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE sessions SET last_seen_at = $3 WHERE org_id = $1 AND session_id = $2 AND status = 'active'`,
		orgID, sessionID, at)
	return err
}

// RevokeSession stamps status='revoked' + ended fact on an ACTIVE session.
func (s *AuthStore) RevokeSession(ctx context.Context, q Querier, orgID, sessionID, reason string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE sessions SET status = 'revoked', ended_at = $3, ended_reason = $4
                  WHERE org_id = $1 AND session_id = $2 AND status = 'active'`,
		orgID, sessionID, at, reason)
	return err
}

// TouchKeyLastUsed stamps last_used_at on a key that just authenticated —
// the auth lane tracks usage through the injected clock (apikeys.ts: "usage
// tracking is the audit") and the wire KeyView projects it.
func (s *AuthStore) TouchKeyLastUsed(ctx context.Context, q Querier, orgID, keyID string, at time.Time) error {
	_, err := q.Exec(ctx,
		`UPDATE api_keys SET last_used_at = $3, updated_at = now()
		  WHERE org_id = $1 AND key_id = $2 AND status = 'active'`,
		orgID, keyID, at)
	return err
}
