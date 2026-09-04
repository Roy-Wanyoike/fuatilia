package application

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/jackc/pgx/v5"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// Stable codes the auth-admin surface produces (the port of
// src/domain/auth/{user,roles,assignments,apikeys,sessions}.ts + the wire
// 404s the routes own).
const (
	CodeUserNotFound            = "HTTP_USER_NOT_FOUND"
	CodeRoleNotFound            = "HTTP_ROLE_NOT_FOUND"
	CodeSessionNotFound         = "HTTP_SESSION_NOT_FOUND"
	CodeKeyNotFound             = "AUTH_KEY_NOT_FOUND"
	CodeEmailMalformed          = "AUTH_EMAIL_MALFORMED"
	CodeUsernameMalformed       = "AUTH_USERNAME_MALFORMED"
	CodeDisplayNameRequired     = "AUTH_DISPLAY_NAME_REQUIRED"
	CodeEmailTaken              = "AUTH_EMAIL_TAKEN"
	CodeUsernameTaken           = "AUTH_USERNAME_TAKEN"
	CodeRoleNotHeld             = "AUTH_ROLE_NOT_HELD"
	CodeKeyIDTaken              = "AUTH_KEY_ID_TAKEN"
	CodeKeyPrefixTaken          = "AUTH_KEY_PREFIX_TAKEN"
	CodeKeyScopesRequired       = "AUTH_KEY_SCOPES_REQUIRED"
	CodeSecretTooShort          = "AUTH_SECRET_TOO_SHORT"
	CodeKeyExpiryInvalid        = "AUTH_KEY_EXPIRY_INVALID"
	CodeReasonRequired          = "AUTH_REASON_REQUIRED"
	CodeSessNotActive           = "SESS_NOT_ACTIVE"
	CodeEscalationBlocked       = "AUTH_ESCALATION_BLOCKED"
	AdminManageUsers            = "admin:manage-users"
	codePermissionWildcard      = "AUTH_PERMISSION_WILDCARD_FORBIDDEN"
	codePermissionMalformed     = "AUTH_PERMISSION_MALFORMED"
	codePermissionUnknown       = "AUTH_PERMISSION_UNKNOWN"
	keySecretMinLength          = 16
	keyPrefixLength             = 8
	unusablePasswordHashComment = "unusable verifier: this kernel mints credentials via sessions and api keys only"
)

// emailShape mirrors user.ts EMAIL_SHAPE; usernameShape mirrors
// USERNAME_SHAPE (3–31 chars of [a-z0-9._-], starting alphanumeric).
var (
	emailShape    = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
	usernameShape = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._-]{2,30})$`)
)

// CreateUserResult carries the created user projection.
type CreateUserResult struct {
	User repositories.UserRow
}

// CreateUser registers a user in the caller's org. Wire shape was validated
// by the transport; the lane re-validates values (AUTH_EMAIL_MALFORMED →
// 400, AUTH_EMAIL_TAKEN / AUTH_USERNAME_TAKEN → 409) and appends the
// auth.userCreated fact in the same transaction as the insert.
func (s *Services) CreateUser(ctx context.Context, orgID, email, username, displayName string) (CreateUserResult, error) {
	emailValue := strings.ToLower(trim(email))
	if !emailShape.MatchString(emailValue) {
		return CreateUserResult{}, infra.NewDomainError(CodeEmailMalformed, "email '"+email+"' is not a valid address", nil)
	}
	usernameValue := strings.ToLower(trim(username))
	if !usernameShape.MatchString(usernameValue) {
		return CreateUserResult{}, infra.NewDomainError(CodeUsernameMalformed,
			"username '"+username+"' must be 3-31 chars of [a-z0-9._-], starting alphanumeric", nil)
	}
	displayValue := trim(displayName)
	if displayValue == "" {
		return CreateUserResult{}, infra.NewDomainError(CodeDisplayNameRequired, "display name is required", nil)
	}
	var result CreateUserResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		if _, err := store.UserByEmail(ctx, orgID, emailValue); err == nil {
			return infra.NewDomainError(CodeEmailTaken, "email "+emailValue+" is already registered in this org", nil)
		} else if !errors.Is(err, repositories.ErrNotFound) {
			return err
		}
		if _, err := store.UserByUsername(ctx, orgID, usernameValue); err == nil {
			return infra.NewDomainError(CodeUsernameTaken, "username '"+usernameValue+"' is already taken in this org", nil)
		} else if !errors.Is(err, repositories.ErrNotFound) {
			return err
		}
		user := repositories.UserRow{
			ID:          infra.NewUUID(),
			OrgID:       orgID,
			Email:       emailValue,
			Username:    usernameValue,
			DisplayName: displayValue,
			Status:      "active",
			CreatedAt:   s.Clock.Now(),
		}
		// SPEC §34: no plaintext password path exists on this kernel — the
		// verifier column is an unusable random digest, never a secret.
		if err := store.InsertUser(ctx, tx, user, unusablePasswordHashComment+":"+infra.RandomHex(32)); err != nil {
			if repositories.UniqueViolation(err) {
				return infra.NewDomainError(CodeEmailTaken, "email "+emailValue+" is already registered in this org", nil)
			}
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "auth.userCreated", user.ID, map[string]any{
			"userId":      user.ID,
			"orgId":       user.OrgID,
			"email":       user.Email,
			"username":    user.Username,
			"displayName": user.DisplayName,
			"createdAt":   repositories.ISO(user.CreatedAt),
		}); err != nil {
			return err
		}
		result = CreateUserResult{User: user}
		return nil
	})
	if err != nil {
		return CreateUserResult{}, err
	}
	return result, nil
}

// GrantResult carries the grant projection + the idempotency verdict.
type GrantResult struct {
	Grant       repositories.GrantRow
	AlreadyHeld bool
}

// GrantOption tunes the grant command.
type GrantOption struct {
	// AuditEscalationRefusal receives the audited escalation refusal (the
	// refusal is a fact BEFORE the 403 is emitted). An audit failure is
	// RETURNED — a refusal that leaves no audit fact fails the command
	// closed (500), never a silent 403.
	AuditEscalationRefusal func(ctx context.Context, orgID, granterID, userID, roleID, reason, detail string, missing []string) error
}

// GrantRole grants a role to a user (escalation-guarded): the granter cannot
// confer authority they do not hold. Idempotent by value — an ACTIVE
// identical grant answers 200 with alreadyHeld:true and no second fact.
// Self-grants refuse as audited escalation blocks: the merged schema's
// ck_role_assignments_no_self_grant (db/migrations/0002, AUTH-1) is stricter
// than the TS lane, and the kernel surfaces the rule at the boundary instead
// of leaking a DDL violation (see the PR notes for the documented
// EscalationReason extension).
func (s *Services) GrantRole(ctx context.Context, orgID, granterID string, userID, roleID string, resourceID string, opt GrantOption) (GrantResult, error) {
	if userID == granterID {
		detail := "grant refused: " + granterID + " cannot grant a role to themselves — no-self-escalation (AUTH-1)"
		if err := s.recordEscalationRefusal(ctx, orgID, granterID, userID, roleID, "NO_SELF_GRANT", detail, nil, opt); err != nil {
			return GrantResult{}, err
		}
		return GrantResult{}, infra.NewDomainError(CodeEscalationBlocked, detail, nil)
	}
	var result GrantResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		role, err := store.RoleByID(ctx, orgID, roleID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeRoleNotFound, "role "+roleID+" does not exist", nil)
			}
			return err
		}
		if _, err := store.UserByID(ctx, orgID, userID); err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeUserNotFound, "user "+userID+" does not exist", nil)
			}
			return err
		}
		granterRules, err := store.ActiveRulesForUser(ctx, orgID, granterID)
		if err != nil {
			return err
		}
		granterPermissions := auth.EffectivePermissions(granterRules)
		// Idempotent by value: an ACTIVE identical grant replays itself.
		existing, err := store.ActiveGrantFor(ctx, orgID, userID, roleID, resourceIDPtr(resourceID))
		if err == nil {
			result = GrantResult{Grant: existing, AlreadyHeld: true}
			return nil
		}
		if !errors.Is(err, repositories.ErrNotFound) {
			return err
		}
		// Escalation guard check 1: the granter must hold role administration.
		if !contains(granterPermissions, AdminManageUsers) {
			detail := "grant refused: " + granterID + " does not hold " + AdminManageUsers + " — only role administrators may grant roles"
			if err := s.recordEscalationRefusal(ctx, orgID, granterID, userID, roleID, "GRANTER_NOT_ADMIN", detail, nil, opt); err != nil {
				return err
			}
			return infra.NewDomainError(CodeEscalationBlocked, detail, nil)
		}
		// Escalation guard check 2: no grant may exceed the granter's own set.
		missing := auth.MissingForRole(role.Permissions, granterPermissions)
		if len(missing) > 0 {
			detail := "grant refused: role '" + role.Name + "' confers " + strings.Join(missing, ", ") +
				" which " + granterID + " does not hold — grants never outlive the granter's authority"
			if err := s.recordEscalationRefusal(ctx, orgID, granterID, userID, roleID, "GRANTER_LACKS_PERMISSION", detail, missing, opt); err != nil {
				return err
			}
			return infra.NewDomainError(CodeEscalationBlocked, detail, nil)
		}
		now := s.Clock.Now()
		grant := repositories.GrantRow{
			ID:         infra.NewUUID(),
			OrgID:      orgID,
			UserID:     userID,
			RoleID:     roleID,
			ResourceID: resourceIDPtr(resourceID),
			GrantedBy:  granterID,
			GrantedAt:  now,
		}
		if err := store.InsertGrant(ctx, tx, grant); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "auth.roleGranted", grant.ID, map[string]any{
			"grantId":    grant.ID,
			"orgId":      orgID,
			"userId":     userID,
			"roleId":     roleID,
			"resourceId": resourceIDPtr(resourceID),
			"grantedBy":  granterID,
			"grantedAt":  repositories.ISO(now),
		}); err != nil {
			return err
		}
		result = GrantResult{Grant: grant, AlreadyHeld: false}
		return nil
	})
	if err != nil {
		return GrantResult{}, err
	}
	return result, nil
}

// recordEscalationRefusal persists the audited refusal through the
// composition's audit sink (the tamper-evident audit_events chain): the
// refusal is a fact BEFORE the 403 is emitted. The sink error is RETURNED —
// the caller fails the command closed (500) rather than emitting an unaudited
// refusal.
func (s *Services) recordEscalationRefusal(ctx context.Context, orgID, granterID, userID, roleID, reason, detail string, missing []string, opt GrantOption) error {
	return opt.AuditEscalationRefusal(ctx, orgID, granterID, userID, roleID, reason, detail, missing)
}

// RevokeRole revokes the user's ACTIVE org-wide grant: a revocation FACT
// appended to the immutable ledger (never an UPDATE). Revoking an unheld
// role refuses with 409 AUTH_ROLE_NOT_HELD.
func (s *Services) RevokeRole(ctx context.Context, orgID, revokedBy string, userID, roleID, reason string) (repositories.GrantRow, error) {
	if trim(reason) == "" {
		return repositories.GrantRow{}, infra.NewDomainError(CodeReasonRequired, "a revocation requires an explicit reason (R3)", nil)
	}
	var result repositories.GrantRow
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		if _, err := store.RoleByID(ctx, orgID, roleID); err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeRoleNotFound, "role "+roleID+" does not exist", nil)
			}
			return err
		}
		grant, err := store.ActiveGrantFor(ctx, orgID, userID, roleID, nil)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeRoleNotHeld,
					"user "+userID+" does not actively hold role "+roleID+" in this scope — revoking an unheld role is refused", nil)
			}
			return err
		}
		now := s.Clock.Now()
		if err := store.InsertRevokeFact(ctx, tx, grant, revokedBy, trim(reason), now); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "auth.roleRevoked", grant.ID, map[string]any{
			"grantId":   grant.ID,
			"orgId":     orgID,
			"userId":    userID,
			"roleId":    roleID,
			"revokedBy": revokedBy,
			"reason":    trim(reason),
			"revokedAt": repositories.ISO(now),
		}); err != nil {
			return err
		}
		revokedAt := now
		revokedReason := trim(reason)
		grant.RevokedAt = &revokedAt
		grant.RevokedReason = &revokedReason
		result = grant
		return nil
	})
	if err != nil {
		return repositories.GrantRow{}, err
	}
	return result, nil
}

// IssueKeyResult carries the issued key (prefix + scopes only).
type IssueKeyResult struct {
	Key repositories.KeyRow
}

// IssueKey issues an API key from the CALLER-supplied secret: the response
// carries the visible 8-char prefix and the concrete scopes — the raw secret
// and its hash never leave the process (SPEC §34).
func (s *Services) IssueKey(ctx context.Context, orgID, issuedBy, name, secret string, scopes []string, expiresAt *time.Time) (IssueKeyResult, error) {
	if trim(name) == "" {
		return IssueKeyResult{}, infra.NewDomainError("AUTH_KEY_NAME_REQUIRED", "an api key requires a non-blank name", nil)
	}
	if len(secret) < keySecretMinLength {
		return IssueKeyResult{}, infra.NewDomainError(CodeSecretTooShort,
			"an api key secret requires at least "+itoa(keySecretMinLength)+" characters (SPEC §34)", nil)
	}
	if len(scopes) == 0 {
		return IssueKeyResult{}, infra.NewDomainError(CodeKeyScopesRequired,
			"an api key requires at least one concrete scope (a key that can do nothing is dead weight)", nil)
	}
	cleaned := make([]string, 0, len(scopes))
	for _, raw := range scopes {
		scope, err := auth.AssertPermission(raw)
		if err != nil {
			return IssueKeyResult{}, permissionError(raw, err)
		}
		if !contains(cleaned, scope) {
			cleaned = append(cleaned, scope)
		}
	}
	sort.Strings(cleaned)
	if expiresAt != nil && !expiresAt.After(s.Clock.Now()) {
		return IssueKeyResult{}, infra.NewDomainError(CodeKeyExpiryInvalid, "an api key expiry must be strictly after issuance", nil)
	}
	var result IssueKeyResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		prefix := secret[:keyPrefixLength]
		taken, err := store.KeyPrefixTaken(ctx, orgID, prefix)
		if err != nil {
			return err
		}
		if taken {
			return infra.NewDomainError(CodeKeyPrefixTaken,
				"api-key prefix '"+prefix+"' is already in use — generate a fresh secret", nil)
		}
		key := repositories.KeyRow{
			ID:         infra.NewUUID(),
			OrgID:      orgID,
			Name:       trim(name),
			CreatedBy:  issuedBy,
			Prefix:     prefix,
			SecretHash: auth.SHA256Codec{}.Hash(secret),
			Scopes:     cleaned,
			ExpiresAt:  expiresAt,
			CreatedAt:  s.Clock.Now(),
		}
		if err := store.InsertKey(ctx, tx, key); err != nil {
			if repositories.UniqueViolation(err) {
				return infra.NewDomainError(CodeKeyIDTaken, "api key "+key.ID+" already exists", nil)
			}
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "auth.apiKeyIssued", key.ID, map[string]any{
			"keyId":     key.ID,
			"orgId":     orgID,
			"name":      key.Name,
			"prefix":    key.Prefix,
			"scopes":    key.Scopes,
			"expiresAt": isoOrNull(key.ExpiresAt),
			"createdBy": issuedBy,
			"issuedAt":  repositories.ISO(key.CreatedAt),
		}); err != nil {
			return err
		}
		result = IssueKeyResult{Key: key}
		return nil
	})
	if err != nil {
		return IssueKeyResult{}, err
	}
	return result, nil
}

// RevokeKeyResult carries the post-revocation key + idempotency verdict.
type RevokeKeyResult struct {
	Key            repositories.KeyRow
	AlreadyRevoked bool
}

// RevokeKey revokes an api key (idempotent: revoking an already-revoked key
// is a no-op answered with alreadyRevoked:true — revocation is a fact).
func (s *Services) RevokeKey(ctx context.Context, orgID, revokedBy, keyID, reason string) (RevokeKeyResult, error) {
	if trim(reason) == "" {
		return RevokeKeyResult{}, infra.NewDomainError(CodeReasonRequired, "a revocation requires an explicit reason (R3)", nil)
	}
	var result RevokeKeyResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		key, err := store.KeyByIDInOrg(ctx, orgID, keyID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeKeyNotFound, "api key "+keyID+" does not exist", nil)
			}
			return err
		}
		if key.Status == "revoked" {
			result = RevokeKeyResult{Key: key, AlreadyRevoked: true}
			return nil
		}
		now := s.Clock.Now()
		if err := store.RevokeKey(ctx, tx, orgID, keyID, revokedBy, trim(reason), now); err != nil {
			return err
		}
		if err := s.appendOutbox(ctx, tx, orgID, "auth.apiKeyRevoked", key.ID, map[string]any{
			"keyId":     key.ID,
			"orgId":     orgID,
			"revokedBy": revokedBy,
			"reason":    trim(reason),
			"revokedAt": repositories.ISO(now),
		}); err != nil {
			return err
		}
		key.Status = "revoked"
		key.RevokedAt = &now
		revokedReason := trim(reason)
		key.RevokedReason = &revokedReason
		result = RevokeKeyResult{Key: key, AlreadyRevoked: false}
		return nil
	})
	if err != nil {
		return RevokeKeyResult{}, err
	}
	return result, nil
}

// RevokeSessionResult carries the post-revocation session.
type RevokeSessionResult struct {
	Session repositories.SessionRow
}

// RevokeSession kills a live Bearer token: status='revoked' + ended fact;
// the token immediately refuses with 401 SESSION_REVOKED.
func (s *Services) RevokeSession(ctx context.Context, orgID, sessionID, reason string) (RevokeSessionResult, error) {
	if trim(reason) == "" {
		return RevokeSessionResult{}, infra.NewDomainError(CodeReasonRequired, "a revocation requires an explicit reason (R3)", nil)
	}
	var result RevokeSessionResult
	err := s.Stores.RunInTx(ctx, func(tx pgx.Tx) error {
		store := &repositories.AuthStore{Q: tx}
		session, err := store.SessionByIDInOrg(ctx, orgID, sessionID)
		if err != nil {
			if errors.Is(err, repositories.ErrNotFound) {
				return infra.NewDomainError(CodeSessionNotFound, "session "+sessionID+" does not exist", nil)
			}
			return err
		}
		if session.Status != "active" {
			return infra.NewDomainError(CodeSessNotActive,
				"session "+sessionID+" is not active — only a live session can be revoked", nil)
		}
		now := s.Clock.Now()
		if err := store.RevokeSession(ctx, tx, orgID, sessionID, trim(reason), now); err != nil {
			return err
		}
		session.Status = "revoked"
		session.EndedAt = &now
		endedReason := trim(reason)
		session.EndedReason = &endedReason
		result = RevokeSessionResult{Session: session}
		return nil
	})
	if err != nil {
		return RevokeSessionResult{}, err
	}
	return result, nil
}

// permissionError maps the guard's AssertPermission refusal onto its stable
// wire code (wildcards where only concrete permissions are legal → 400).
func permissionError(raw string, err error) *infra.DomainError {
	msg := err.Error()
	for _, prefix := range []string{
		codePermissionWildcard, codePermissionMalformed, codePermissionUnknown,
	} {
		if strings.HasPrefix(msg, prefix+":") {
			return infra.NewDomainError(prefix, trim(strings.TrimPrefix(msg, prefix+":")), nil)
		}
	}
	return infra.NewDomainError(codePermissionMalformed, "permission '"+raw+"' is not a '<resource>:<action>' string", nil)
}

func resourceIDPtr(resourceID string) *string {
	if resourceID == "" {
		return nil
	}
	return &resourceID
}

// isoOrNull renders an optional timestamp the way the TS event payloads do
// (ISO-8601 string, or null).
func isoOrNull(t *time.Time) any {
	if t == nil {
		return nil
	}
	return repositories.ISO(*t)
}
