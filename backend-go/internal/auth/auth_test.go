package auth

import (
	"strings"
	"testing"
)

// --- Authorization header parsing (middleware/auth.ts parity) -------------------

func TestParseAuthorization(t *testing.T) {
	cases := []struct {
		name   string
		header string
		kind   string
		token  string
		id     string
		secret string
		detail string
	}{
		{"absent", "", "", "", "", "", ""},
		{"blank", "   ", "", "", "", "", ""},
		{"bearer", "Bearer tok-123", "bearer", "tok-123", "", "", ""},
		{"bearer case-insensitive scheme", "bEaReR tok", "bearer", "tok", "", "", ""},
		{"apikey splits at the FIRST dot", "ApiKey id.a.b.c", "apiKey", "", "id", "a.b.c", ""},
		{"apikey", "ApiKey key123.deadbeef", "apiKey", "", "key123", "deadbeef", ""},
		{"no space", "Bearertok", "malformed", "", "", "", `Authorization header must be "<scheme> <credentials>"`},
		{"no credentials", "Bearer ", "malformed", "", "", "", "Authorization scheme 'bearer' carries no credentials"},
		{"empty apikey id", "ApiKey .secret", "malformed", "", "", "", `ApiKey credentials must be "<id>.<secret>"`},
		{"empty apikey secret", "ApiKey id.", "malformed", "", "", "", `ApiKey credentials must be "<id>.<secret>"`},
		{"no dot", "ApiKey idsecret", "malformed", "", "", "", `ApiKey credentials must be "<id>.<secret>"`},
		{"unsupported scheme", "Basic dXNlcjpwYXNz", "malformed", "", "", "", "unsupported authorization scheme 'basic'"},
	}
	for _, tc := range cases {
		parsed := ParseAuthorization(tc.header)
		if parsed.Kind != tc.kind {
			t.Fatalf("%s: kind = %q, want %q", tc.name, parsed.Kind, tc.kind)
		}
		if parsed.Token != tc.token || parsed.ID != tc.id || parsed.Secret != tc.secret {
			t.Fatalf("%s: parsed = %+v", tc.name, parsed)
		}
		if tc.detail != "" && parsed.Detail != tc.detail {
			t.Fatalf("%s: detail = %q, want %q", tc.name, parsed.Detail, tc.detail)
		}
	}
}

// --- secret codec: constant-time verification -----------------------------------

func TestSHA256Codec(t *testing.T) {
	codec := SHA256Codec{}
	hash := codec.Hash("a-client-secret")
	if len(hash) != 64 || strings.ToLower(hash) != hash {
		t.Fatalf("hash must be a 64-char lowercase hex digest: %q", hash)
	}
	if !codec.Verify("a-client-secret", hash) {
		t.Fatalf("the right secret must verify")
	}
	if codec.Verify("a-client-secreT", hash) {
		t.Fatalf("a wrong secret must never verify")
	}
	if codec.Verify("", hash) {
		t.Fatalf("empty secret must never verify")
	}
}

// --- the permission vocabulary + guards ------------------------------------------

func TestAssertPermissionRefusals(t *testing.T) {
	if _, err := AssertPermission("payments:*"); err == nil || !strings.HasPrefix(err.Error(), "AUTH_PERMISSION_WILDCARD_FORBIDDEN") {
		t.Fatalf("wildcard must refuse WILDCARD_FORBIDDEN, got %v", err)
	}
	if _, err := AssertPermission("payments"); err == nil || !strings.HasPrefix(err.Error(), "AUTH_PERMISSION_MALFORMED") {
		t.Fatalf("unshaped must refuse MALFORMED, got %v", err)
	}
	if _, err := AssertPermission("payments:fly"); err == nil || !strings.HasPrefix(err.Error(), "AUTH_PERMISSION_UNKNOWN") {
		t.Fatalf("out-of-vocabulary must refuse UNKNOWN, got %v", err)
	}
	for _, legal := range []string{"payments:intake", "collections:read", "admin:manage-users"} {
		if _, err := AssertPermission(legal); err != nil {
			t.Fatalf("%s must be legal: %v", legal, err)
		}
	}
}

func TestCanDecisionMatrix(t *testing.T) {
	admin := Principal{
		Kind:        "user",
		PrincipalID: "u-1",
		OrgID:       "org-1",
		Status:      "active",
		Rules: []PermissionRule{
			{Rule: "admin:manage-users", RoleID: "r-admin"},
			{Rule: "payments:*", RoleID: "r-payments"},
		},
	}
	if !Can(admin, "payments:intake").Allowed {
		t.Fatalf("role wildcard must cover the concrete permission")
	}
	if !Can(admin, "admin:manage-users").Allowed {
		t.Fatalf("exact rule must cover")
	}
	decision := Can(admin, "collections:act")
	if decision.Allowed || decision.Reason != "NO_GRANT" {
		t.Fatalf("deny-by-default must answer NO_GRANT: %+v", decision)
	}

	unknown := Can(admin, "payments:fly")
	if unknown.Allowed || unknown.Reason != "PERMISSION_UNKNOWN" {
		t.Fatalf("out-of-vocabulary must refuse: %+v", unknown)
	}

	suspended := admin
	suspended.Status = "suspended"
	decision = Can(suspended, "payments:intake")
	if decision.Allowed || decision.Reason != "PRINCIPAL_SUSPENDED" {
		t.Fatalf("a suspended principal gets no decision: %+v", decision)
	}

	revoked := admin
	revoked.Status = "revoked"
	if Can(revoked, "payments:intake").Reason != "PRINCIPAL_REVOKED" {
		t.Fatalf("revoked principal denial")
	}
}

func TestResourceScopedRuleCoversOrgWide(t *testing.T) {
	scoped := Principal{
		Kind: "apiKey", PrincipalID: "k-1", OrgID: "org-1", Status: "active",
		Rules: []PermissionRule{{Rule: "payments:intake", ResourceID: "resource-9"}},
	}
	if !Can(scoped, "payments:intake").Allowed {
		t.Fatalf("the mounted surface authorizes org-wide; a covering rule allows regardless of its resource scope")
	}
}

// --- escalation guard math ---------------------------------------------------------

func TestEffectivePermissionsAndMissingForRole(t *testing.T) {
	granter := []PermissionRule{
		{Rule: "payments:*"},
		{Rule: "admin:manage-users"},
	}
	effective := EffectivePermissions(granter)
	want := []string{"admin:manage-users", "payments:intake", "payments:read", "payments:refund"}
	if strings.Join(effective, ",") != strings.Join(want, ",") {
		t.Fatalf("effective = %v, want %v", effective, want)
	}

	missing := MissingForRole([]string{"payments:intake", "collections:act", "payments:*"}, effective)
	if strings.Join(missing, ",") != "collections:act" {
		t.Fatalf("missing = %v, want [collections:act] — wildcards are covered when ANY permission under the resource is held", missing)
	}

	if len(MissingForRole([]string{"payments:intake"}, effective)) != 0 {
		t.Fatalf("a fully-covered role has nothing missing")
	}
}
