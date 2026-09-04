package auth

import (
        "context"
        "strings"
        "time"

        "github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Header names (kernel/body.ts): the request id rides x-request-id, else
// x-correlation-id; credentials ride the Authorization header.
const (
        HeaderAuthorization = "Authorization"
        HeaderRequestID     = "X-Request-Id"
        HeaderCorrelationID = "X-Correlation-ID"
)

// ParsedAuthorization is the Authorization header parse result
// (middleware/auth.ts): `Bearer <sessionToken>` and `ApiKey <id>.<secret>`
// (split at the FIRST dot) are understood; anything else is malformed.
type ParsedAuthorization struct {
        Kind   string // "" | "malformed" | "bearer" | "apiKey"
        Detail string // malformed detail
        Token  string // bearer
        ID     string // apiKey
        Secret string // apiKey
}

// ParseAuthorization parses the raw Authorization header value.
func ParseAuthorization(header string) ParsedAuthorization {
        if strings.TrimSpace(header) == "" {
                return ParsedAuthorization{}
        }
        // The TS middleware trims only for the empty check, then splits the RAW
        // header at the first space — "Bearer " (no credentials) answers the
        // carries-no-credentials detail, not the no-space one.
        spaceAt := strings.Index(header, " ")
        if spaceAt < 1 {
                return ParsedAuthorization{Kind: "malformed", Detail: `Authorization header must be "<scheme> <credentials>"`}
        }
        scheme := strings.ToLower(strings.TrimSpace(header[:spaceAt]))
        credentials := strings.TrimSpace(header[spaceAt+1:])
        if credentials == "" {
                return ParsedAuthorization{Kind: "malformed", Detail: "Authorization scheme '" + scheme + "' carries no credentials"}
        }
        switch scheme {
        case "bearer":
                return ParsedAuthorization{Kind: "bearer", Token: credentials}
        case "apikey":
                dotAt := strings.Index(credentials, ".")
                if dotAt < 1 || dotAt == len(credentials)-1 {
                        return ParsedAuthorization{Kind: "malformed", Detail: `ApiKey credentials must be "<id>.<secret>"`}
                }
                return ParsedAuthorization{Kind: "apiKey", ID: credentials[:dotAt], Secret: credentials[dotAt+1:]}
        default:
                return ParsedAuthorization{Kind: "malformed", Detail: "unsupported authorization scheme '" + scheme + "'"}
        }
}

// Verifier is the persistence-backed credential port (the composition binds
// it over PostgreSQL — cmd/api wires it over the auth store).
type Verifier interface {
        SessionPrincipal(ctx context.Context, token string) Outcome
        APIKeyPrincipal(ctx context.Context, id, secret string) Outcome
}

// AuditSink receives every audited denial (append-only upstream — the
// kernel binds it to the tamper-evident audit_events chain).
type AuditSink func(ctx context.Context, event infra.AuditEvent) error

// Outcome is the credential verification result (the port of
// middleware/auth.ts AuthOutcome): either an authenticated principal or a
// stable denial that carries its own audit context.
type Outcome struct {
        Authenticated bool
        Principal     Principal

        // Denial fields (stable codes pass through to the envelope).
        Code          string
        Message       string
        Reason        string
        OrgID         string // "" = no org context (payload uses the nil-org sentinel)
        PrincipalID   string
        PrincipalKind string // "user" | "apiKey" | "unknown"
}

// Authenticator is the composition-bound authentication + authorization
// gate: verify credentials over the Verifier, audit EVERY denial (401 and
// 403 alike — SPEC §37 deny-by-default is a fact) through the sink.
type Authenticator struct {
        Verify Verifier
        Clock  infra.Clock
        Audit  AuditSink
}

// AuthnResult is the authenticate step's result.
type AuthnResult struct {
        OK        bool
        Principal Principal
        // Err is the 401 refusal (stable code passes through to the envelope).
        Err *infra.DomainError
        // InternalErr is set when the denial could not be AUDITED — the caller
        // fails closed to 500 (a refusal that leaves no audit fact must never
        // surface as a 4xx).
        InternalErr error
}

// Authenticate resolves the Authorization header into a principal or a 401
// refusal. Every refusal — including "no header at all" — is audited.
func (a *Authenticator) Authenticate(ctx context.Context, header string) AuthnResult {
        parsed := ParseAuthorization(header)
        switch parsed.Kind {
        case "":
                return a.refuse(ctx,
                        `authentication required — supply "Authorization: Bearer <sessionToken>" or "Authorization: ApiKey <id>.<secret>"`,
                        "no Authorization header was presented")
        case "malformed":
                return a.refuse(ctx, parsed.Detail, parsed.Detail)
        }
        var outcome Outcome
        if parsed.Kind == "bearer" {
                outcome = a.Verify.SessionPrincipal(ctx, parsed.Token)
        } else {
                outcome = a.Verify.APIKeyPrincipal(ctx, parsed.ID, parsed.Secret)
        }
        if outcome.Authenticated {
                return AuthnResult{OK: true, Principal: outcome.Principal}
        }
        if err := a.auditDenial(ctx, denialEvent{
                OrgID:         outcome.OrgID,
                PrincipalID:   outcome.PrincipalID,
                PrincipalKind: outcome.PrincipalKind,
                Permission:    AUTHAttemptPermission,
                Reason:        outcome.Reason,
                Detail:        outcome.Message,
        }); err != nil {
                return AuthnResult{InternalErr: err}
        }
        return AuthnResult{Err: infra.NewDomainError(outcome.Code, outcome.Message, nil)}
}

func (a *Authenticator) refuse(ctx context.Context, message, detail string) AuthnResult {
        if err := a.auditDenial(ctx, denialEvent{
                OrgID:         "",
                PrincipalID:   "",
                PrincipalKind: "unknown",
                Permission:    AUTHAttemptPermission,
                Reason:        "PRINCIPAL_UNKNOWN",
                Detail:        detail,
        }); err != nil {
                return AuthnResult{InternalErr: err}
        }
        return AuthnResult{Err: infra.NewDomainError(infra.CodeUnauthenticated, message, nil)}
}

// AuthzError is the authorization refusal: the 403 code + the CanDecision
// detail (which carries the lane's DenyReason), or the fail-closed audit
// failure under InternalErr.
type AuthzError struct {
        Code    string
        Message string
        // InternalErr is the audit-sink failure (the caller fails closed to 500).
        InternalErr error
}

func (e *AuthzError) Error() string { return e.Code + ": " + e.Message }

// Authorize is the per-route permission gate: can(principal, permission)
// with the denial audited and the CanDecision reason carried to the client.
func (a *Authenticator) Authorize(ctx context.Context, principal Principal, permission string) *AuthzError {
        decision := Can(principal, permission)
        if decision.Allowed {
                return nil
        }
        if err := a.auditDenial(ctx, denialEvent{
                OrgID:         principal.OrgID,
                PrincipalID:   principal.PrincipalID,
                PrincipalKind: principal.Kind,
                Permission:    permission,
                Reason:        decision.Reason,
                Detail:        decision.Detail,
        }); err != nil {
                return &AuthzError{Code: infra.CodeInternal, InternalErr: err}
        }
        return &AuthzError{Code: AUTHAccessDenied, Message: decision.Detail}
}

// AuditEscalationRefusal audits an escalation refusal decision value
// (assignments.ts grantRole): the refusal is a fact BEFORE the 403 is
// emitted. The command service pairs it with the auth.escalationBlocked
// audit payload the TS lane's event carries.
func (a *Authenticator) AuditEscalationRefusal(ctx context.Context, orgID, granterID, userID, roleID, reason, detail string, missing []string) error {
        return a.auditDenial(ctx, denialEvent{
                OrgID:         orgID,
                PrincipalID:   granterID,
                PrincipalKind: "user",
                Permission:    AdminManageUsersPermission,
                Reason:        reason,
                Detail:        detail,
                Missing:       missing,
                UserID:        userID,
                RoleID:        roleID,
                Action:        "auth.escalationBlocked",
        })
}

type denialEvent struct {
        OrgID         string
        PrincipalID   string
        PrincipalKind string
        Permission    string
        Reason        string
        Detail        string
        Missing       []string
        UserID        string
        RoleID        string
        Action        string
}

// auditDenial appends the audited denial to the sink. The payload shape is
// the auth lane's AccessDeniedPayload (ids/reasons only — never credential
// material); the sink failure is RETURNED, never swallowed: a denial that
// leaves no audit fact fails the request closed.
func (a *Authenticator) auditDenial(ctx context.Context, e denialEvent) error {
        if a.Audit == nil {
                return nil
        }
        now := a.Clock.Now()
        orgID := e.OrgID
        if orgID == "" {
                orgID = NilOrg
        }
        actorType := "system"
        switch e.PrincipalKind {
        case "user":
                actorType = "user"
        case "apiKey":
                actorType = "api"
        }
        payload := map[string]any{
                "orgId":         orgID,
                "principalId":   nullableString(e.PrincipalID),
                "principalKind": e.PrincipalKind,
                "permission":    e.Permission,
                "resource":      nil,
                "reason":        e.Reason,
                "detail":        e.Detail,
                "at":            isoMillis(now),
        }
        action := e.Action
        if action == "" {
                action = "auth.accessDenied"
        } else {
                // The escalation payload is the TS EscalationBlockedPayload.
                payload["granterId"] = nullableString(e.PrincipalID)
                payload["userId"] = nullableString(e.UserID)
                payload["roleId"] = nullableString(e.RoleID)
                payload["missing"] = e.Missing
                payload["reason"] = e.Reason
        }
        return a.Audit(ctx, infra.AuditEvent{
                Action:     action,
                ActorType:  actorType,
                ActorID:    e.PrincipalID,
                Resource:   "auth",
                Payload:    payload,
                Reason:     e.Reason,
                OccurredAt: now,
                OrgID:      e.OrgID,
        })
}

func nullableString(s string) any {
        if s == "" {
                return nil
        }
        return s
}

func isoMillis(t time.Time) string {
        return t.UTC().Format("2006-01-02T15:04:05.000Z07:00")
}
