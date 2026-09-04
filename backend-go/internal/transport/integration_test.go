package transport_test

// Integration suite for the Go /v1 API kernel (issue #72): HTTP tests
// through the REAL composed mux (httptest.Server) over REAL PostgreSQL 16.4
// with the db/migrations 0001–0014 schema. Honest boot: unreachable
// PostgreSQL fails the run — it never silently skips (the merge gate
// includes booting the cluster).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra/pgtest"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/transport"
)

const fallbackDatabaseURL = "postgres://postgres@127.0.0.1:5435/fuatilia_api_test?sslmode=disable"

// world is one test's seeded tenant state.
type world struct {
	OrgID      string
	RootID     string // the seeder principal grants hang off (no self-grant)
	AdminID    string
	AdminKeyID string
	AdminToken string // "ApiKey <id>.<secret>" or a bearer token
}

// bootKernel composes the REAL kernel over the shared lane cluster's
// migrated database, truncates the lane's tables for a clean run and wires
// cleanup. Every test gets a private world.
func bootKernel(t *testing.T) (*httptest.Server, *pgxpool.Pool, *world) {
	t.Helper()
	ctx := context.Background()

	cluster, err := pgtest.RequireShared(ctx)
	if err != nil {
		t.Fatalf("pgtest: shared cluster bootstrap failed (the merge gate includes REAL PostgreSQL): %v", err)
	}
	databaseURL := os.Getenv("FUATILIA_TEST_DATABASE_URL")
	if databaseURL == "" {
		databaseURL = cluster.DSN(pgtest.SharedDBName)
	}
	if databaseURL == fallbackDatabaseURL && cluster.Port != "5435" {
		databaseURL = cluster.DSN(pgtest.SharedDBName)
	}

	if err := cluster.TruncateAll(ctx, pgtest.SharedDBName); err != nil {
		t.Fatalf("pgtest: truncate lane tables: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = cluster.TruncateAll(cleanupCtx, pgtest.SharedDBName)
	})

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("pgxpool: %v", err)
	}
	t.Cleanup(pool.Close)

	clock := infra.SystemClock{}
	stores := &repositories.Stores{Pool: pool}
	services := &application.Services{
		Stores:  stores,
		Clock:   clock,
		IDs:     infra.NewUUID,
		Replays: infra.NewIDRegistry(),
	}
	verifier := repositories.NewAuthStore(pool, clock)
	authenticator := &auth.Authenticator{
		Verify: verifier,
		Clock:  clock,
		Audit: func(ctx context.Context, event infra.AuditEvent) error {
			return infra.AppendAuditEvent(ctx, pool, event)
		},
	}
	composed, err := transport.Compose(transport.Deps{
		Services: services,
		Auth:     authenticator,
		Clock:    clock,
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)), func(err error, requestID string) {
		t.Logf("kernel internal error (requestId=%s): %v", requestID, err)
	})
	if err != nil {
		t.Fatalf("compose: %v", err)
	}
	server := httptest.NewServer(composed.Kernel)
	t.Cleanup(server.Close)

	w := seedWorld(t, pool)
	return server, pool, w
}

// seedWorld inserts one tenant with a live admin principal (an API key with
// the whole mounted vocabulary) — the seeder user owns the grant rows so the
// no-self-grant CHECK never trips.
func seedWorld(t *testing.T, pool *pgxpool.Pool) *world {
	t.Helper()

	w := &world{
		OrgID: mustExec(t, pool, `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`,
			"Test Org "+t.Name(), "org-"+strings.ToLower(randToken(t))[:12]),
		RootID: infra.NewUUID(),
	}
	mustExecNoReturn(t, pool, `INSERT INTO users (id, org_id, email, username, display_name, status, password_hash)
                VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
		w.RootID, w.OrgID, "root@"+slug(t)+".test", "root-"+slug(t), "Seeder Root", unusableHash(t))

	w.AdminID = infra.NewUUID()
	mustExecNoReturn(t, pool, `INSERT INTO users (id, org_id, email, username, display_name, status, password_hash)
                VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
		w.AdminID, w.OrgID, "admin@"+slug(t)+".test", "admin-"+slug(t), "Test Admin", unusableHash(t))

	adminRole := mustExec(t, pool, `INSERT INTO roles (org_id, name, permissions)
                VALUES ($1, $2, $3) RETURNING id::text`,
		w.OrgID, "admin-"+slug(t), []string{
			"admin:manage-users", "receivables:read", "payments:read", "payments:intake",
			"payments:refund", "collections:read", "collections:act",
		})
	mustExecNoReturn(t, pool, `INSERT INTO role_assignments (org_id, kind, user_id, role_id, granted_by)
                VALUES ($1, 'grant', $2, $3, $4)`, w.OrgID, w.AdminID, adminRole, w.RootID)

	secret := "integration-secret-" + randToken(t)
	w.AdminKeyID = mustExec(t, pool, `INSERT INTO api_keys (org_id, name, created_by, prefix, secret_hash, scopes)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING key_id::text`,
		w.OrgID, "admin-key", w.AdminID, secret[:8], sha256Hex(secret),
		[]string{"admin:manage-users", "receivables:read", "payments:read", "payments:intake",
			"payments:refund", "collections:read", "collections:act"})
	w.AdminToken = "ApiKey " + w.AdminKeyID + "." + secret
	return w
}

// seedSession mints a live bearer session (the token IS the session id).
func seedSession(t *testing.T, pool *pgxpool.Pool, orgID, userID string, idleMS, absoluteMS int64) string {
	t.Helper()
	return mustExec(t, pool, `INSERT INTO sessions (org_id, user_id, idle_timeout_ms, absolute_timeout_ms, status, last_seen_at)
                VALUES ($1, $2, $3, $4, 'active', now()) RETURNING session_id::text`,
		orgID, userID, idleMS, absoluteMS)
}

// seedAPIKey issues a key directly through the store-facing SQL.
func seedAPIKey(t *testing.T, pool *pgxpool.Pool, orgID, createdBy, secret string, scopes []string) string {
	t.Helper()
	return mustExec(t, pool, `INSERT INTO api_keys (org_id, name, created_by, prefix, secret_hash, scopes)
                VALUES ($1, $2, $3, $4, $5, $6) RETURNING key_id::text`,
		orgID, "seeded-key", createdBy, secret[:8], sha256Hex(secret), scopes)
}

// seedReceivable inserts customer → invoice → receivable with the given due
// date (the aging view's driver).
func seedReceivable(t *testing.T, pool *pgxpool.Pool, orgID, currency string, originalMinor int64, dueDate time.Time, overdue bool) string {
	t.Helper()
	customer := mustExec(t, pool, `INSERT INTO customers (org_id, display_name, msisdn) VALUES ($1, $2, $3) RETURNING id::text`,
		orgID, "Customer "+randToken(t), "+2547"+randToken(t)[:9])
	invoice := mustExec(t, pool, `INSERT INTO invoices (org_id, customer_id, status, currency, total_minor, due_date, issued_at, invoice_number)
                VALUES ($1, $2, 'issued', $3, $4, $5, now(), $6) RETURNING id::text`,
		orgID, customer, currency, originalMinor, dueDate, "INV-"+randToken(t))
	return mustExec(t, pool, `INSERT INTO receivables (org_id, invoice_id, customer_id, currency, original_minor, state, overdue, due_date, opened_at)
                VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, now()) RETURNING id::text`,
		orgID, invoice, customer, currency, originalMinor, overdue, dueDate)
}

// --- HTTP helpers -----------------------------------------------------------------

// call drives one request through the real server. principal "" sends no
// Authorization header; body may be nil.
func call(t *testing.T, server *httptest.Server, method, path, principal string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, server.URL+path, reader)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if principal != "" {
		req.Header.Set("Authorization", principal)
	}
	res, err := server.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	parsed := map[string]any{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &parsed); err != nil {
			t.Fatalf("response is not JSON: %v (%s)", err, string(raw))
		}
	}
	return res.StatusCode, parsed
}

func errorCode(t *testing.T, status int, body map[string]any) (int, string, string) {
	t.Helper()
	errObj, _ := body["error"].(map[string]any)
	code, _ := errObj["code"].(string)
	message, _ := errObj["message"].(string)
	return status, code, message
}

func wantError(t *testing.T, status int, body map[string]any, wantStatus int, wantCode string) {
	t.Helper()
	gotStatus, code, _ := errorCode(t, status, body)
	if gotStatus != wantStatus || code != wantCode {
		t.Fatalf("got %d %s, want %d %s (body: %v)", gotStatus, code, wantStatus, wantCode, body)
	}
}

func dataOf(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	data, _ := body["data"].(map[string]any)
	if data == nil {
		t.Fatalf("success envelope carries no data object: %v", body)
	}
	return data
}

// --- shared test constants ----------------------------------------------------------

const (
	idleHourMS = int64(3_600_000)
	dayMS      = int64(86_400_000)
)

// --- the mounted surface gates every non-public route (acceptance 5) -----------------

func TestPublicRoutesAreTheOnlyUnauthenticatedOnes(t *testing.T) {
	server, pool, w := bootKernel(t)

	// the served table drives the probe: every mounted op refuses anonymous
	// access with the 401 envelope — only health/meta answer 200.
	rows := servedRows(t, server, w, pool)
	for _, row := range rows {
		status, body := call(t, server, row.method, row.path, "", row.body)
		if row.public {
			if status != 200 {
				t.Fatalf("%s %s is public and must answer 200, got %d", row.method, row.path, status)
			}
			continue
		}
		wantError(t, status, body, 401, "HTTP_UNAUTHENTICATED")
	}
}

// servedRow is one mounted op instantiated against the seeded world.
type servedRow struct {
	method string
	path   string
	body   any
	public bool
}

func servedRows(t *testing.T, server *httptest.Server, w *world, pool *pgxpool.Pool) []servedRow {
	t.Helper()
	receivableID := seedReceivable(t, pool, w.OrgID, "KES", 5_000_00, time.Now().Add(-2*time.Duration(dayMS)*time.Millisecond), true)
	paymentID := mustExec(t, pool, `INSERT INTO payments (org_id, channel, external_ref, idempotency_key, state, currency, requested_minor, unapplied_minor)
                VALUES ($1, 'c2b', $2, $3, 'initiated', 'KES', 1000, 0) RETURNING id::text`,
		w.OrgID, "ref-"+randToken(t), "idem-"+randToken(t))
	caseID := mustExec(t, pool, `INSERT INTO collections_cases (org_id, case_number, sequence_no, priority, status, owner_id, opened_at)
                VALUES ($1, $2, 1, 'normal', 'open', $3, now()) RETURNING id::text`,
		w.OrgID, "CASE-9"+randToken(t)[:4], w.AdminID)

	keyID := mustExec(t, pool, `INSERT INTO api_keys (org_id, name, created_by, prefix, secret_hash, scopes)
                VALUES ($1, $2, $3, 'deadbeef', $4, $5) RETURNING key_id::text`,
		w.OrgID, "to-revoke", w.AdminID, sha256Hex("revocation-target-secret"), []string{"payments:read"})
	userID := mustExec(t, pool, `INSERT INTO users (id, org_id, email, username, display_name, status, password_hash)
                VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id::text`,
		infra.NewUUID(), w.OrgID, "subject@"+slug(t)+".test", "subject-"+slug(t), "Subject", unusableHash(t))
	roleID := mustExec(t, pool, `INSERT INTO roles (org_id, name, permissions) VALUES ($1, $2, $3) RETURNING id::text`,
		w.OrgID, "subject-role", []string{"payments:read"})
	sessionID := seedSession(t, pool, w.OrgID, w.AdminID, idleHourMS, 24*idleHourMS)

	return []servedRow{
		{method: "GET", path: "/v1/health", public: true},
		{method: "GET", path: "/v1/meta", public: true},
		{method: "POST", path: "/v1/auth/users", body: map[string]any{"email": "n@" + slug(t) + ".test", "username": "newuser", "displayName": "New"}},
		{method: "POST", path: "/v1/auth/roles/grants", body: map[string]any{"userId": userID, "roleId": roleID}},
		{method: "POST", path: "/v1/auth/roles/revocations", body: map[string]any{"userId": userID, "roleId": roleID, "reason": "rotation"}},
		{method: "POST", path: "/v1/auth/api-keys", body: map[string]any{"name": "k", "secret": "a-long-enough-secret", "scopes": []string{"payments:read"}}},
		{method: "POST", path: "/v1/auth/api-keys/revocations", body: map[string]any{"keyId": keyID, "reason": "rotation"}},
		{method: "POST", path: "/v1/auth/sessions/revocations", body: map[string]any{"sessionId": sessionID, "reason": "logout"}},
		{method: "GET", path: "/v1/receivables"},
		{method: "GET", path: "/v1/receivables/" + receivableID},
		{method: "POST", path: "/v1/payments/intake", body: intakeBody("c2b", "ext-"+randToken(t), "idem-"+randToken(t), 500)},
		{method: "GET", path: "/v1/payments"},
		{method: "GET", path: "/v1/payments/" + paymentID},
		{method: "POST", path: "/v1/payments/" + paymentID + "/confirmations", body: moneyBody(500)},
		{method: "POST", path: "/v1/payments/" + paymentID + "/refund-reservations", body: refundBody(100, "goodwill")},
		{method: "POST", path: "/v1/collections/cases", body: map[string]any{"receivableIds": []string{receivableID}, "collectorId": w.AdminID}},
		{method: "GET", path: "/v1/collections/cases"},
		{method: "GET", path: "/v1/collections/cases/" + caseID},
		{method: "POST", path: "/v1/collections/cases/" + caseID + "/transitions", body: map[string]any{"to": "in_progress", "reason": "work started"}},
		{method: "POST", path: "/v1/collections/cases/" + caseID + "/escalations", body: map[string]any{"to": "high", "reason": "aging"}},
		{method: "POST", path: "/v1/collections/cases/" + caseID + "/actions", body: map[string]any{"type": "call", "scheduledFor": time.Now().Add(time.Hour).UTC().Format(time.RFC3339)}},
		{method: "POST", path: "/v1/collections/cases/" + caseID + "/actions/" + infra.NewUUID() + "/completions", body: map[string]any{"outcome": "reached"}},
	}
}

// --- credential denial matrix (acceptance 2) -----------------------------------------

func TestCredentialDenialMatrix(t *testing.T) {
	server, pool, w := bootKernel(t)
	ctx := context.Background()

	secret := "another-very-long-secret"
	keyID := seedAPIKey(t, pool, w.OrgID, w.AdminID, secret, []string{"payments:read"})
	apiKey := "ApiKey " + keyID + "." + secret

	// 401 KEY_UNKNOWN — no such key id
	status, body := call(t, server, "GET", "/v1/payments", "ApiKey unknown-id.deadbeef", nil)
	wantError(t, status, body, 401, "KEY_UNKNOWN")

	// 401 KEY_SECRET_MISMATCH
	status, body = call(t, server, "GET", "/v1/payments", "ApiKey "+keyID+".wrong-secret", nil)
	wantError(t, status, body, 401, "KEY_SECRET_MISMATCH")

	// 401 KEY_EXPIRED
	expiredKey := seedAPIKey(t, pool, w.OrgID, w.AdminID, "expired-secret-long-enough", []string{"payments:read"})
	mustExecNoReturn(t, pool, `UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE org_id = $1 AND key_id = $2`, w.OrgID, expiredKey)
	status, body = call(t, server, "GET", "/v1/payments", "ApiKey "+expiredKey+".expired-secret-long-enough", nil)
	wantError(t, status, body, 401, "KEY_EXPIRED")

	// 401 KEY_OWNER_INACTIVE — the owner's status cascades
	suspendedOwner := mustExec(t, pool, `INSERT INTO users (id, org_id, email, username, display_name, status, password_hash)
                VALUES ($1, $2, $3, $4, $5, 'suspended', $6) RETURNING id::text`,
		infra.NewUUID(), w.OrgID, "susp@"+slug(t)+".test", "susp-"+slug(t), "Suspended", unusableHash(t))
	suspendedKey := seedAPIKey(t, pool, w.OrgID, suspendedOwner, "suspended-owner-secret", []string{"payments:read"})
	status, body = call(t, server, "GET", "/v1/payments", "ApiKey "+suspendedKey+".suspended-owner-secret", nil)
	wantError(t, status, body, 401, "KEY_OWNER_INACTIVE")

	// 401 KEY_REVOKED — revocation via the admin surface, then replay denied
	revokeStatus, revokeBody := call(t, server, "POST", "/v1/auth/api-keys/revocations", w.AdminToken,
		map[string]any{"keyId": keyID, "reason": "rotated out"})
	if revokeStatus != 200 {
		t.Fatalf("revoke: %d %v", revokeStatus, revokeBody)
	}
	status, body = call(t, server, "GET", "/v1/payments", apiKey, nil)
	wantError(t, status, body, 401, "KEY_REVOKED")

	// 401 SESSION_REVOKED — the bearer token IS the session id; kill it and replay
	sessionID := seedSession(t, pool, w.OrgID, w.AdminID, idleHourMS, 24*idleHourMS)
	bearer := "Bearer " + sessionID
	status, body = call(t, server, "POST", "/v1/auth/sessions/revocations", w.AdminToken,
		map[string]any{"sessionId": sessionID, "reason": "logout all"})
	if status != 200 {
		t.Fatalf("session revocation: %d %v", status, body)
	}
	status, body = call(t, server, "GET", "/v1/payments", bearer, nil)
	wantError(t, status, body, 401, "SESSION_REVOKED")

	// 401 SESSION_IDLE_EXPIRED — a stale last_seen trips the idle horizon
	stale := seedSession(t, pool, w.OrgID, w.AdminID, 1000, 24*idleHourMS)
	mustExecNoReturn(t, pool, `UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE org_id = $1 AND session_id = $2`, w.OrgID, stale)
	status, body = call(t, server, "GET", "/v1/payments", "Bearer "+stale, nil)
	wantError(t, status, body, 401, "SESSION_IDLE_EXPIRED")

	// 401 malformed header + absent header
	status, body = call(t, server, "GET", "/v1/payments", "Token nothing", nil)
	wantError(t, status, body, 401, "HTTP_UNAUTHENTICATED")
	status, body = call(t, server, "GET", "/v1/payments", "", nil)
	wantError(t, status, body, 401, "HTTP_UNAUTHENTICATED")

	// 401 PRINCIPAL_SUSPENDED — a suspended user's live session is unusable
	suspendedUserSession := seedSession(t, pool, w.OrgID, suspendedOwner, idleHourMS, 24*idleHourMS)
	status, body = call(t, server, "GET", "/v1/payments", "Bearer "+suspendedUserSession, nil)
	wantError(t, status, body, 401, "PRINCIPAL_SUSPENDED")

	// every 401 above left an audited denial row (org-scoped or the nil-org sentinel)
	var denialRows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE action = 'auth.accessDenied' AND (org_id = $1 OR org_id IS NULL)`, w.OrgID).Scan(&denialRows); err != nil {
		t.Fatalf("audit count: %v", err)
	}
	if denialRows < 8 {
		t.Fatalf("expected at least one audited denial per 401 refusal, found %d", denialRows)
	}
}

// TestCrossPermissionDenialIsAudited — authenticated but unauthorized → 403
// AUTH_ACCESS_DENIED with the decision audited (acceptance 2).
func TestCrossPermissionDenialIsAudited(t *testing.T) {
	server, pool, w := bootKernel(t)
	ctx := context.Background()

	limited := seedAPIKey(t, pool, w.OrgID, w.AdminID, "readonly-claims-secret", []string{"payments:read"})
	status, body := call(t, server, "POST", "/v1/collections/cases", "ApiKey "+limited+".readonly-claims-secret",
		map[string]any{"receivableIds": []string{infra.NewUUID()}, "collectorId": w.AdminID})
	wantError(t, status, body, 403, "AUTH_ACCESS_DENIED")

	var reason string
	if err := pool.QueryRow(ctx, `SELECT reason FROM audit_events WHERE org_id = $1 AND action = 'auth.accessDenied' ORDER BY seq DESC LIMIT 1`,
		w.OrgID).Scan(&reason); err != nil {
		t.Fatalf("audited denial row missing: %v", err)
	}
	if reason != "NO_GRANT" {
		t.Fatalf("audited denial reason = %q, want NO_GRANT", reason)
	}

	// cross-org access NEVER answers 403 (which would leak existence) — it 404s
	other := &world{OrgID: mustExec(t, pool, `INSERT INTO orgs (name, slug) VALUES ($1, $2) RETURNING id::text`, "Other", "other-"+slug(t))}
	otherReceivable := seedReceivable(t, pool, other.OrgID, "KES", 1_000_00, time.Now().Add(-time.Duration(dayMS)*time.Millisecond), false)
	status, body = call(t, server, "GET", "/v1/receivables/"+otherReceivable, w.AdminToken, nil)
	wantError(t, status, body, 404, "HTTP_RECEIVABLE_NOT_FOUND")
}

// TestEscalationGuardBlocksPrivilegeEscalation — a granter cannot confer
// authority they do not hold; the refusal is audited BEFORE the 403 (acceptance 2).
//
// The granter authenticates as a USER session: the escalation guard derives
// the granter's authority from grant FACTS keyed by the principal id
// (routes/auth.ts), and an apiKey principal holds no grant facts — its
// granter set is empty, so an api-key granter always refuses
// GRANTER_NOT_ADMIN. The missing-permission refusal below is therefore only
// reachable through a bearer session, exactly like the TS lane.
func TestEscalationGuardBlocksPrivilegeEscalation(t *testing.T) {
	server, pool, w := bootKernel(t)
	ctx := context.Background()

	bearer := "Bearer " + seedSession(t, pool, w.OrgID, w.AdminID, idleHourMS, 24*idleHourMS)

	// the admin principal holds admin:manage-users but NOT ledger:post
	collectorRole := mustExec(t, pool, `INSERT INTO roles (org_id, name, permissions)
                VALUES ($1, $2, $3) RETURNING id::text`, w.OrgID, "ledger-role", []string{"ledger:post"})
	subject := mustExec(t, pool, `INSERT INTO users (id, org_id, email, username, display_name, status, password_hash)
                VALUES ($1, $2, $3, $4, $5, 'active', $6) RETURNING id::text`,
		infra.NewUUID(), w.OrgID, "esc@"+slug(t)+".test", "esc-"+slug(t), "Escalation Subject", unusableHash(t))

	status, body := call(t, server, "POST", "/v1/auth/roles/grants", bearer,
		map[string]any{"userId": subject, "roleId": collectorRole})
	wantError(t, status, body, 403, "AUTH_ESCALATION_BLOCKED")

	var reason string
	if err := pool.QueryRow(ctx, `SELECT reason FROM audit_events WHERE org_id = $1 AND action = 'auth.escalationBlocked' ORDER BY seq DESC LIMIT 1`,
		w.OrgID).Scan(&reason); err != nil {
		t.Fatalf("audited escalation refusal missing: %v", err)
	}
	if reason != "GRANTER_LACKS_PERMISSION" {
		t.Fatalf("escalation reason = %q, want GRANTER_LACKS_PERMISSION", reason)
	}

	// an API-key principal holds NO grant facts: even with admin:manage-users
	// in its scopes it cannot confer a role (GRANTER_NOT_ADMIN on the wire).
	status, body = call(t, server, "POST", "/v1/auth/roles/grants", w.AdminToken,
		map[string]any{"userId": subject, "roleId": collectorRole})
	wantError(t, status, body, 403, "AUTH_ESCALATION_BLOCKED")
	var keyReason string
	if err := pool.QueryRow(ctx, `SELECT reason FROM audit_events WHERE org_id = $1 AND action = 'auth.escalationBlocked' ORDER BY seq DESC LIMIT 1`,
		w.OrgID).Scan(&keyReason); err != nil {
		t.Fatalf("audited key-granter refusal missing: %v", err)
	}
	if keyReason != "GRANTER_NOT_ADMIN" {
		t.Fatalf("api-key granter reason = %q, want GRANTER_NOT_ADMIN", keyReason)
	}

	// self-grant is refused as an escalation block (AUTH-1, the merged schema's CHECK)
	selfRole := mustExec(t, pool, `INSERT INTO roles (org_id, name, permissions)
                VALUES ($1, $2, $3) RETURNING id::text`, w.OrgID, "admin-clone", []string{"admin:manage-users"})
	status, body = call(t, server, "POST", "/v1/auth/roles/grants", bearer,
		map[string]any{"userId": w.AdminID, "roleId": selfRole})
	wantError(t, status, body, 403, "AUTH_ESCALATION_BLOCKED")
}

// --- auth admin surface (the 6 mounted ops) ------------------------------------------

func TestAuthAdminSurface(t *testing.T) {
	server, pool, w := bootKernel(t)

	// users create → 201 with NO hash material
	status, body := call(t, server, "POST", "/v1/auth/users", w.AdminToken,
		map[string]any{"email": "fresh@" + slug(t) + ".test", "username": "fresh-" + slug(t), "displayName": "Fresh User"})
	if status != 201 {
		t.Fatalf("create user: %d %v", status, body)
	}
	user := dataOf(t, body)["user"].(map[string]any)
	if strings.Contains(fmt.Sprint(body), "password_hash") || strings.Contains(fmt.Sprint(body), "passwordHash") {
		t.Fatalf("hash material leaked onto the wire: %v", body)
	}
	if user["status"] != "active" || user["orgId"] != w.OrgID {
		t.Fatalf("user view: %v", user)
	}

	// duplicate email → 409
	status, body = call(t, server, "POST", "/v1/auth/users", w.AdminToken,
		map[string]any{"email": "fresh@" + slug(t) + ".test", "username": "other-" + slug(t), "displayName": "Dup"})
	wantError(t, status, body, 409, "AUTH_EMAIL_TAKEN")

	// malformed email → 400
	status, body = call(t, server, "POST", "/v1/auth/users", w.AdminToken,
		map[string]any{"email": "not-an-email", "username": "bad-" + slug(t), "displayName": "Bad"})
	wantError(t, status, body, 400, "AUTH_EMAIL_MALFORMED")

	// grants: 201 → idempotent replay 200 alreadyHeld → revocation 200 → re-grant 201.
	// The granter authenticates as a USER session: grant authority derives from
	// grant FACTS (routes/auth.ts), and an api-key principal holds none — the
	// escalation guard would refuse it with GRANTER_NOT_ADMIN even though the
	// key's scopes carry admin:manage-users.
	bearer := "Bearer " + seedSession(t, pool, w.OrgID, w.AdminID, idleHourMS, 24*idleHourMS)
	role := mustExec(t, pool, `INSERT INTO roles (org_id, name, permissions) VALUES ($1, $2, $3) RETURNING id::text`,
		w.OrgID, "grant-role", []string{"payments:read"})
	status, body = call(t, server, "POST", "/v1/auth/roles/grants", bearer, map[string]any{"userId": user["id"], "roleId": role})
	if status != 201 {
		t.Fatalf("grant: %d %v", status, body)
	}
	grantID := dataOf(t, body)["grant"].(map[string]any)["id"].(string)
	status, body = call(t, server, "POST", "/v1/auth/roles/grants", bearer, map[string]any{"userId": user["id"], "roleId": role})
	if status != 200 || dataOf(t, body)["alreadyHeld"] != true {
		t.Fatalf("idempotent grant: %d %v", status, body)
	}
	status, body = call(t, server, "POST", "/v1/auth/roles/revocations", bearer,
		map[string]any{"userId": user["id"], "roleId": role, "reason": "offboarding"})
	if status != 200 {
		t.Fatalf("revocation: %d %v", status, body)
	}
	// revoking an unheld role → 409
	status, body = call(t, server, "POST", "/v1/auth/roles/revocations", bearer,
		map[string]any{"userId": user["id"], "roleId": role, "reason": "again"})
	wantError(t, status, body, 409, "AUTH_ROLE_NOT_HELD")
	// after revocation the same (user, role) grants FRESH again (201, new fact)
	status, body = call(t, server, "POST", "/v1/auth/roles/grants", bearer, map[string]any{"userId": user["id"], "roleId": role})
	if status != 201 || dataOf(t, body)["grant"].(map[string]any)["id"].(string) == grantID {
		t.Fatalf("re-grant after revocation must append a NEW fact: %d %v", status, body)
	}

	// api-keys issue: prefix visible, secret+hash never return
	secret := "issued-via-api-secret"
	status, body = call(t, server, "POST", "/v1/auth/api-keys", w.AdminToken,
		map[string]any{"name": "issued", "secret": secret, "scopes": []string{"payments:read", "payments:intake"}})
	if status != 201 {
		t.Fatalf("issue key: %d %v", status, body)
	}
	key := dataOf(t, body)["key"].(map[string]any)
	if key["prefix"] != secret[:8] {
		t.Fatalf("visible prefix = %v, want %q", key["prefix"], secret[:8])
	}
	wire := fmt.Sprint(body)
	if strings.Contains(wire, secret) || strings.Contains(wire, sha256Hex(secret)) || strings.Contains(wire, "secretHash") {
		t.Fatalf("secret material leaked onto the wire: %s", wire)
	}
	// wildcard scope → 400
	status, body = call(t, server, "POST", "/v1/auth/api-keys", w.AdminToken,
		map[string]any{"name": "wild", "secret": secret, "scopes": []string{"payments:*"}})
	wantError(t, status, body, 400, "AUTH_PERMISSION_WILDCARD_FORBIDDEN")
	// short secret → 400
	status, body = call(t, server, "POST", "/v1/auth/api-keys", w.AdminToken,
		map[string]any{"name": "short", "secret": "short", "scopes": []string{"payments:read"}})
	wantError(t, status, body, 400, "AUTH_SECRET_TOO_SHORT")

	// the issued key authenticates immediately
	issued := mustExec(t, pool, `SELECT key_id::text FROM api_keys WHERE org_id = $1 AND prefix = $2`, w.OrgID, secret[:8])
	status, body = call(t, server, "GET", "/v1/payments", "ApiKey "+issued+"."+secret, nil)
	if status != 200 {
		t.Fatalf("issued key must authenticate: %d %v", status, body)
	}
}

func intakeBody(channel, externalRef, idempotencyKey string, minor int64) map[string]any {
	return map[string]any{
		"channel": channel, "externalRef": externalRef, "idempotencyKey": idempotencyKey,
		"amount": map[string]any{"minor": minor, "currency": "KES"},
	}
}

func moneyBody(minor int64) map[string]any {
	return map[string]any{"amount": map[string]any{"minor": minor, "currency": "KES"}}
}

func refundBody(minor int64, reason string) map[string]any {
	return map[string]any{"amount": map[string]any{"minor": minor, "currency": "KES"}, "reason": reason}
}
