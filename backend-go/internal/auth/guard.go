// Package auth is the Go port of the auth lane's authorization surface
// (src/domain/auth/{guard,roles,assignments}.ts) — the deterministic,
// deny-by-default permission matrix the kernel gates every route with.
package auth

import (
	"fmt"
	"sort"
	"strings"
)

// AUTHAccessDenied is the stable 403 code for authorization refusals.
const AUTHAccessDenied = "AUTH_ACCESS_DENIED"

// AdminManageUsersPermission is the role-administration permission —
// REQUIRED to grant or revoke roles (SPEC §35).
const AdminManageUsersPermission = "admin:manage-users"

// AUTHAttemptPermission is the marker used in audited payloads for
// authentication attempts themselves (not a vocabulary permission — the
// attempt is "be authenticated", authorization happens after).
const AUTHAttemptPermission = "auth:authenticate"

// NilOrg is the nil-org aggregate for denials that precede org
// identification (the TS middleware's NIL_ORG sentinel).
const NilOrg = "00000000-0000-4000-8000-000000000000"

// PERMISSIONS is the closed permission vocabulary (src/domain/auth/roles.ts).
// Adapters cannot invent a permission and have it mean anything.
var PERMISSIONS = []string{
	"receivables:read",
	"receivables:write",
	"payments:read",
	"payments:intake",
	"payments:refund",
	"collections:read",
	"collections:act",
	"adjustments:request",
	"adjustments:approve",
	"ledger:read",
	"ledger:post",
	"intelligence:read",
	"admin:manage-users",
	"policy:manage",
}

// RESOURCES is the resource half of the vocabulary (wildcards are legal only
// inside role definitions, exactly one per known resource).
var RESOURCES = []string{
	"receivables", "payments", "collections", "adjustments",
	"ledger", "intelligence", "admin", "policy",
}

var permissionSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(PERMISSIONS))
	for _, p := range PERMISSIONS {
		set[p] = struct{}{}
	}
	return set
}()

var resourceSet = func() map[string]struct{} {
	set := make(map[string]struct{}, len(RESOURCES))
	for _, r := range RESOURCES {
		set[r] = struct{}{}
	}
	return set
}()

// IsKnownPermission reports whether the permission is in the closed
// vocabulary — deny-by-default starts here.
func IsKnownPermission(permission string) bool {
	_, ok := permissionSet[permission]
	return ok
}

// IsRoleWildcard reports whether raw is exactly `<known-resource>:*` — a
// role-level wildcard (legal ONLY inside role definitions, never per grant
// or key scope).
func IsRoleWildcard(raw string) bool {
	idx := strings.Index(raw, ":")
	if idx <= 0 || !strings.HasSuffix(raw, ":*") {
		return false
	}
	_, ok := resourceSet[raw[:idx]]
	return ok && raw == raw[:idx]+":*"
}

func isPermissionShape(raw string) bool {
	// /^[a-z][a-z0-9]*:[a-z][a-zA-Z0-9-]*$/
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) != 2 {
		return false
	}
	if !lowerIdent(parts[0]) || parts[1] == "" {
		return false
	}
	for i, c := range parts[1] {
		alnum := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if !(alnum || c == '-' && i > 0) {
			return false
		}
	}
	return parts[1][0] >= 'a' && parts[1][0] <= 'z'
}

func lowerIdent(s string) bool {
	if s == "" || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

// AssertPermission validates a CONCRETE permission (the only kind allowed in
// grants and API-key scopes). Refusals (stable codes):
//   - AUTH_PERMISSION_WILDCARD_FORBIDDEN — a wildcard where only concrete
//     permissions are allowed;
//   - AUTH_PERMISSION_MALFORMED — not `<resource>:<action>` shaped;
//   - AUTH_PERMISSION_UNKNOWN — well-formed but outside the vocabulary.
func AssertPermission(raw string) (string, error) {
	if IsRoleWildcard(raw) {
		return "", fmt.Errorf("AUTH_PERMISSION_WILDCARD_FORBIDDEN: wildcard '%s' is only allowed inside role definitions, never per grant or key scope", raw)
	}
	if !isPermissionShape(raw) {
		return "", fmt.Errorf("AUTH_PERMISSION_MALFORMED: permission '%s' is not a '<resource>:<action>' string", raw)
	}
	if !IsKnownPermission(raw) {
		return "", fmt.Errorf("AUTH_PERMISSION_UNKNOWN: permission '%s' is outside the closed vocabulary", raw)
	}
	return raw, nil
}

// PermissionRule is one authority rule a principal holds (grant-derived or
// key scope).
type PermissionRule struct {
	// Rule is a concrete permission or a `<resource>:*` role wildcard
	// (expanded on match).
	Rule string
	// RoleID / GrantID are the evidence trail (empty for key scopes).
	RoleID  string
	GrantID string
	// ResourceID is empty for org-wide rules; scoped otherwise.
	ResourceID string
}

// Principal is the resolved actor a decision runs against.
type Principal struct {
	Kind        string // "user" | "apiKey"
	PrincipalID string
	OrgID       string
	Status      string // active | suspended | deactivated | revoked
	Rules       []PermissionRule
}

// CanDecision is the deterministic decision value: either allowed with
// matched-rule evidence, or refused with a stable reason + detail.
type CanDecision struct {
	Allowed bool
	// Via is the matched rule (evidence for audit lines) when allowed.
	Via PermissionRule
	// Reason + Detail carry the refusal (DenyReason + human detail).
	Reason string
	Detail string
}

var statusReasons = map[string]string{
	"suspended":   "PRINCIPAL_SUSPENDED",
	"deactivated": "PRINCIPAL_DEACTIVATED",
	"revoked":     "PRINCIPAL_REVOKED",
}

func wildcardCovers(rule, permission string) bool {
	return strings.HasSuffix(rule, ":*") && strings.HasPrefix(permission, rule[:len(rule)-1])
}

// Can is the deterministic permission matrix (the port of guard.ts `can`):
//
//  1. PERMISSION_UNKNOWN — the requested permission is outside the vocabulary;
//  2. PRINCIPAL_SUSPENDED / _DEACTIVATED / _REVOKED — the principal record
//     itself is not live;
//  3. NO_GRANT — no active rule covers the permission (deny-by-default).
//
// The mounted /v1 surface authorizes org-wide (no resource parameter), so a
// covering rule — org-wide or resource-scoped — allows; scope-refusal edges
// (NOT_IN_RESOURCE_SCOPE) only exist behind the guard's resource argument,
// which this kernel never passes. Pure: no clock, no I/O.
func Can(p Principal, permission string) CanDecision {
	if !IsKnownPermission(permission) {
		return CanDecision{
			Allowed: false,
			Reason:  "PERMISSION_UNKNOWN",
			Detail:  fmt.Sprintf("permission '%s' is outside the closed vocabulary — nothing can be granted it", permission),
		}
	}
	if p.Status != "active" {
		reason := statusReasons[p.Status]
		if reason == "" {
			reason = "PRINCIPAL_DEACTIVATED"
		}
		return CanDecision{
			Allowed: false,
			Reason:  reason,
			Detail:  fmt.Sprintf("principal %s is %s — no decision runs against an inactive principal", p.PrincipalID, p.Status),
		}
	}
	for _, rule := range p.Rules {
		if rule.Rule == permission || wildcardCovers(rule.Rule, permission) {
			return CanDecision{Allowed: true, Via: rule}
		}
	}
	return CanDecision{
		Allowed: false,
		Reason:  "NO_GRANT",
		Detail:  fmt.Sprintf("no active grant or scope covers '%s' — deny by default", permission),
	}
}

// EffectivePermissions expands a principal's rule set into the concrete
// permission set used by the escalation guard (role wildcards expand to
// every vocabulary permission on their resource). Sorted, deduped.
func EffectivePermissions(rules []PermissionRule) []string {
	set := make(map[string]struct{})
	for _, rule := range rules {
		if strings.HasSuffix(rule.Rule, ":*") {
			prefix := rule.Rule[:len(rule.Rule)-1]
			for _, p := range PERMISSIONS {
				if strings.HasPrefix(p, prefix) {
					set[p] = struct{}{}
				}
			}
			continue
		}
		set[rule.Rule] = struct{}{}
	}
	out := make([]string, 0, len(set))
	for p := range set {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// MissingForRole returns the sorted concrete permissions (or wildcard rules)
// of a role definition that the granter's effective set does NOT cover — the
// escalation guard's "a granter cannot confer authority they do not hold".
func MissingForRole(roleRules, granterPermissions []string) []string {
	var missing []string
	for _, rule := range roleRules {
		if strings.HasSuffix(rule, ":*") {
			prefix := rule[:len(rule)-1]
			covers := false
			for _, p := range granterPermissions {
				if strings.HasPrefix(p, prefix) {
					covers = true
					break
				}
			}
			if !covers {
				missing = append(missing, rule)
			}
			continue
		}
		held := false
		for _, p := range granterPermissions {
			if p == rule {
				held = true
				break
			}
		}
		if !held {
			missing = append(missing, rule)
		}
	}
	sort.Strings(missing)
	return missing
}
