package transport

import (
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/application"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/repositories"
)

// Deps is what the route tables drive: the application services, the
// authenticator and the clock. Composition (server.go) binds them over the
// PostgreSQL pool.
type Deps struct {
	// Limits sizes the kernel's per-identity+IP rate limiter (issue #130);
	// the zero value DISABLES limiting — compositions that leave it unset
	// keep byte-identical wire behavior.
	Limits RateLimitConfig
	// SecurityHeaders carries the deployment's header policy (the HSTS flag
	// — issue #130). The zero value applies the four unconditional headers.
	SecurityHeaders SecurityHeaders
	// Observability carries the metrics/tracing handles the serving chain
	// binds (issue #176). The zero value is the zero-config boot: the
	// middleware still wraps (W3C pass-through + request ids) but no series
	// exist and /metrics is not mounted.
	Observability ObservabilityWiring
	Services      *application.Services
	Auth          *auth.Authenticator
	Clock         infra.Clock
}

// publicRoutes mounts the no-auth rows (routes/public.ts): liveness + the
// versioned capability list. No permission → the kernel never attempts
// authentication on them.
func publicRoutes() []RouteRecord {
	return []RouteRecord{
		{
			Method:  "GET",
			Pattern: "/v1/health",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				return HandlerResult{Status: 200, Data: map[string]any{"status": "ok"}}, nil
			},
		},
	}
}

// metaRoute mounts GET /v1/meta with the derived capability list.
func metaRoute(capabilities []string) RouteRecord {
	return RouteRecord{
		Method:  "GET",
		Pattern: "/v1/meta",
		Handler: func(rc *RequestContext) (HandlerResult, error) {
			return HandlerResult{Status: 200, Data: map[string]any{
				"name":         "fuatilia",
				"apiVersion":   "v1",
				"capabilities": capabilities,
			}}, nil
		},
	}
}

// requirePrincipal fails closed when a permission-gated handler runs
// without one (a kernel bug — never reachable through the pipeline).
func requirePrincipal(rc *RequestContext) (auth.Principal, error) {
	if rc.Principal == nil {
		return auth.Principal{}, &routeRegistrationError{msg: "permission-gated handler reached without a principal"}
	}
	return *rc.Principal, nil
}

// authAdminRoutes mounts the six /v1/auth/* admin rows (routes/auth.ts) —
// every one requires `admin:manage-users`.
func authAdminRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method: "POST", Pattern: "/v1/auth/users", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				email, derr := stringField(body, "email")
				if derr != nil {
					return HandlerResult{}, derr
				}
				username, derr := stringField(body, "username")
				if derr != nil {
					return HandlerResult{}, derr
				}
				displayName, derr := stringField(body, "displayName")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.CreateUser(rc.context(), principal.OrgID, email, username, displayName)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 201, Data: map[string]any{"user": userView(result.User)}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/auth/roles/grants", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				userID, derr := uuidField(body, "userId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				roleID, derr := uuidField(body, "roleId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				resourceID, _, derr := optionalUUIDField(body, "resourceId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.GrantRole(rc.context(), principal.OrgID, principal.PrincipalID, userID, roleID, resourceID,
					application.GrantOption{AuditEscalationRefusal: deps.Auth.AuditEscalationRefusal})
				if err != nil {
					return HandlerResult{}, err
				}
				status := 201
				if result.AlreadyHeld {
					status = 200
				}
				return HandlerResult{Status: status, Data: map[string]any{
					"grant":       grantView(result.Grant),
					"alreadyHeld": result.AlreadyHeld,
				}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/auth/roles/revocations", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				userID, derr := uuidField(body, "userId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				roleID, derr := uuidField(body, "roleId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				grant, err := svc.RevokeRole(rc.context(), principal.OrgID, principal.PrincipalID, userID, roleID, reason)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"grant": grantView(grant)}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/auth/api-keys", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				name, derr := stringField(body, "name")
				if derr != nil {
					return HandlerResult{}, derr
				}
				secret, derr := stringField(body, "secret")
				if derr != nil {
					return HandlerResult{}, derr
				}
				scopes, derr := scopeArrayField(body, "scopes")
				if derr != nil {
					return HandlerResult{}, derr
				}
				expiresAt, present, derr := optionalISOTimeField(body, "expiresAt")
				if derr != nil {
					return HandlerResult{}, derr
				}
				var expires *time.Time
				if present {
					parsed, perr := time.Parse(time.RFC3339, expiresAt)
					if perr != nil {
						return HandlerResult{}, infra.NewDomainError(CodeBodyInvalid, "field 'expiresAt' must be an ISO-8601 timestamp", nil)
					}
					expires = &parsed
				}
				// The issuer identity is the principal's USER id: the DDL's
				// fk_api_keys_issuer references users(org_id, id), and an apiKey
				// principal contributes its owner — the human the key acts for.
				result, err := svc.IssueKey(rc.context(), principal.OrgID, principal.UserID, name, secret, scopes, expires)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 201, Data: map[string]any{"key": keyView(result.Key)}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/auth/api-keys/revocations", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				keyID, derr := uuidField(body, "keyId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.RevokeKey(rc.context(), principal.OrgID, principal.PrincipalID, keyID, reason)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{
					"key":            keyView(result.Key),
					"alreadyRevoked": result.AlreadyRevoked,
				}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/auth/sessions/revocations", Permission: auth.AdminManageUsersPermission,
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sessionID, derr := uuidField(body, "sessionId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.RevokeSession(rc.context(), principal.OrgID, sessionID, reason)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"session": sessionView(result.Session)}}, nil
			},
		},
	}
}

// receivableSort is the receivable list's whitelist (routes/receivables.ts:
// arbitrary sort strings are how you scan a database).
var receivableSort = map[string]string{
	"id":      "id",
	"state":   "state::text",
	"dueDate": "due_date",
}

// receivablesRoutes mounts the receivable read model (routes/receivables.ts)
// — both rows require `receivables:read`. Read-only: no write route exists;
// rows arrive through the invoicing flow / persistence adapters.
func receivablesRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method: "GET", Pattern: "/v1/receivables", Permission: "receivables:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, receivableSort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListReceivables(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					application.ReceivablesQuery{SortCol: sorting.Column, Order: sorting.Order, Limit: page.Limit, Offset: page.Offset})
				if err != nil {
					return HandlerResult{}, err
				}
				now := deps.Clock.Now()
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, receivableView(row, now))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"receivables": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/receivables/:receivableId", Permission: "receivables:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				receivableID := rc.Params["receivableId"]
				row, err := svc.GetReceivable(rc.context(), deps.Services.Stores.Pool, principal.OrgID, receivableID)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"receivable": receivableView(row, deps.Clock.Now())}}, nil
			},
		},
	}
}

// paymentSort is the payment list's whitelist.
var paymentSort = map[string]string{
	"id":          "id",
	"state":       "state::text",
	"initiatedAt": "initiated_at",
}

// paymentsRoutes mounts the fund-truth surface (routes/payments.ts): the ONE
// intake funnel, lookup/read-model and the refund lifecycle.
func paymentsRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method: "POST", Pattern: "/v1/payments/intake", Permission: "payments:intake",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				channel, derr := stringField(body, "channel")
				if derr != nil {
					return HandlerResult{}, derr
				}
				externalRef, derr := stringField(body, "externalRef")
				if derr != nil {
					return HandlerResult{}, derr
				}
				idempotencyKey, derr := stringField(body, "idempotencyKey")
				if derr != nil {
					return HandlerResult{}, derr
				}
				amountMinor, currency, derr := moneyMinorField(body, "amount")
				if derr != nil {
					return HandlerResult{}, derr
				}
				customerID, _, derr := optionalUUIDField(body, "customerId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				declaredRefs, _, derr := optionalStringArrayField(body, "declaredRefs")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.Intake(rc.context(), principal.OrgID, application.IntakeCommand{
					Channel:        channel,
					ExternalRef:    externalRef,
					IdempotencyKey: idempotencyKey,
					AmountMinor:    amountMinor,
					Currency:       string(currency),
					CustomerID:     customerID,
					DeclaredRefs:   declaredRefs,
				})
				if err != nil {
					return HandlerResult{}, err
				}
				// R9/C5 replay semantics: a duplicate is the SAME logical
				// payment — 200 with the existing row, never a second Payment.
				status := 201
				if result.Duplicate {
					status = 200
				}
				return HandlerResult{Status: status, Data: map[string]any{
					"payment":   paymentView(result.Payment, nil, nil),
					"duplicate": result.Duplicate,
				}}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/payments/:paymentId", Permission: "payments:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				payment, err := svc.GetPayment(rc.context(), deps.Services.Stores.Pool, principal.OrgID, rc.Params["paymentId"])
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{
					"payment": paymentView(payment.Payment, payment.Allocations, payment.Refunds),
				}}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/payments", Permission: "payments:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, paymentSort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListPayments(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					sorting.Column, sorting.Order, page.Limit, page.Offset)
				if err != nil {
					return HandlerResult{}, err
				}
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, paymentView(row, nil, nil))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"payments": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/payments/:paymentId/confirmations", Permission: "payments:intake",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				amountMinor, currency, derr := moneyMinorField(body, "amount")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.Confirm(rc.context(), principal.OrgID, rc.Params["paymentId"], amountMinor, string(currency))
				if err != nil {
					return HandlerResult{}, err
				}
				status := 201
				if result.AlreadyConfirmed {
					status = 200
				}
				return HandlerResult{Status: status, Data: map[string]any{
					"payment":          paymentView(result.Payment, nil, nil),
					"alreadyConfirmed": result.AlreadyConfirmed,
				}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/payments/:paymentId/refund-reservations", Permission: "payments:refund",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				amountMinor, currency, derr := moneyMinorField(body, "amount")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.RefundReservation(rc.context(), principal.OrgID, rc.Params["paymentId"], principal.PrincipalID,
					amountMinor, string(currency), reason)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 201, Data: map[string]any{
					"payment": paymentView(result.Payment, nil, nil),
				}}, nil
			},
		},
	}
}

// caseSort is the case list's whitelist.
var caseSort = map[string]string{
	"id":         "id",
	"caseNumber": "case_number",
	"priority":   "priority::text",
	"status":     "status::text",
}

// collectionsRoutes mounts the collections-case surface (routes/collections.ts):
// open / act / read with R8 exclusivity and the K2 consent gate.
func collectionsRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	// findCase is the shared org-scoped lookup (a foreign-org case answers
	// 404 — existence is never leaked across orgs).
	findCase := func(rc *RequestContext, principal auth.Principal) (repositories.CaseRow, []string, []repositories.CaseActionLogRow, bool, error) {
		cse, log, err := svc.GetCase(rc.context(), deps.Services.Stores.Pool, principal.OrgID, rc.Params["caseId"])
		if err != nil {
			return repositories.CaseRow{}, nil, nil, false, err
		}
		receivableIDs, err := svc.Stores.ReceivableIDsForCase(rc.context(), deps.Services.Stores.Pool, principal.OrgID, cse.ID)
		if err != nil {
			return repositories.CaseRow{}, nil, nil, false, err
		}
		pending, err := svc.Stores.CaseHasPendingPromise(rc.context(), deps.Services.Stores.Pool, principal.OrgID, receivableIDs)
		if err != nil {
			return repositories.CaseRow{}, nil, nil, false, err
		}
		return cse, receivableIDs, log, pending, nil
	}
	return []RouteRecord{
		{
			Method: "POST", Pattern: "/v1/collections/cases", Permission: "collections:act",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				receivableIDs, derr := uuidArrayField(body, "receivableIds")
				if derr != nil {
					return HandlerResult{}, derr
				}
				collectorID, derr := uuidField(body, "collectorId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				priority, _, derr := optionalStringField(body, "priority")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.OpenCase(rc.context(), principal.OrgID, principal.PrincipalID,
					application.OpenCaseCommand{ReceivableIDs: receivableIDs, CollectorID: collectorID, Priority: priority})
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 201, Data: map[string]any{"case": caseView(result, []string{}, nil, false)}}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/collections/cases/:caseId", Permission: "collections:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				cse, receivableIDs, log, pending, err := findCase(rc, principal)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"case": caseView(cse, receivableIDs, log, pending)}}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/collections/cases", Permission: "collections:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, caseSort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListCases(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					sorting.Column, sorting.Order, page.Limit, page.Offset)
				if err != nil {
					return HandlerResult{}, err
				}
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, caseView(row, []string{}, nil, false))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"cases": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/collections/cases/:caseId/transitions", Permission: "collections:act",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				to, derr := stringField(body, "to")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.Transition(rc.context(), principal.OrgID, rc.Params["caseId"], principal.PrincipalID,
					application.TransitionCommand{To: to, Reason: reason})
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"case": caseView(result, []string{}, nil, false)}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/collections/cases/:caseId/escalations", Permission: "collections:act",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				to, derr := stringField(body, "to")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := stringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.Escalate(rc.context(), principal.OrgID, rc.Params["caseId"], principal.PrincipalID,
					application.EscalationCommand{To: to, Reason: reason})
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"case": caseView(result, []string{}, nil, false)}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/collections/cases/:caseId/actions", Permission: "collections:act",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				actionType, derr := stringField(body, "type")
				if derr != nil {
					return HandlerResult{}, derr
				}
				scheduledFor, derr := isoTimeField(body, "scheduledFor")
				if derr != nil {
					return HandlerResult{}, derr
				}
				outcome, _, derr := optionalStringField(body, "outcome")
				if derr != nil {
					return HandlerResult{}, derr
				}
				source, _, derr := optionalStringField(body, "source")
				if derr != nil {
					return HandlerResult{}, derr
				}
				consentRef, _, derr := optionalStringField(body, "consentRef")
				if derr != nil {
					return HandlerResult{}, derr
				}
				scheduled, perr := time.Parse(time.RFC3339, scheduledFor)
				if perr != nil {
					return HandlerResult{}, infra.NewDomainError(CodeBodyInvalid, "field 'scheduledFor' must be an ISO-8601 timestamp", nil)
				}
				result, err := svc.RecordAction(rc.context(), principal.OrgID, rc.Params["caseId"], principal.PrincipalID,
					application.RecordActionCommand{
						Type:         actionType,
						ScheduledFor: scheduled,
						Outcome:      outcome,
						Source:       source,
						ConsentRef:   consentRef,
					})
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 201, Data: map[string]any{
					"case":   caseView(result.Case, []string{}, nil, false),
					"action": actionWireView(result.Action),
				}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/collections/cases/:caseId/actions/:actionId/completions", Permission: "collections:act",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				outcome, derr := stringField(body, "outcome")
				if derr != nil {
					return HandlerResult{}, derr
				}
				actorID, _, derr := optionalUUIDField(body, "actorId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.CompleteAction(rc.context(), principal.OrgID, rc.Params["caseId"], rc.Params["actionId"],
					actorID, outcome)
				if err != nil {
					return HandlerResult{}, err
				}
				return HandlerResult{Status: 200, Data: map[string]any{"case": caseView(result, []string{}, nil, false)}}, nil
			},
		},
	}
}

// actionWireView renders the recorded action's wire shape.
func actionWireView(a application.CaseAction) map[string]any {
	return map[string]any{
		"id":           a.ID,
		"type":         a.Type,
		"scheduledFor": a.ScheduledFor,
		"outcome":      a.Outcome,
		"completedAt":  a.CompletedAt,
		"completedBy":  a.CompletedBy,
		"consentRef":   a.ConsentRef,
		"source":       a.Source,
		"actorId":      a.ActorID,
		"recordedAt":   a.RecordedAt,
	}
}

// mountRoutes assembles the FULL 27-op table in TS composition order
// (server.ts): public rows + the auth admin table + the resource tables.
// The capability list is derived over the admin+resource rows ONLY (the TS
// composition derives before mounting health/meta — public rows are not
// capabilities).
func mountRoutes(deps Deps) ([]RouteRecord, error) {
	mounted := []RouteRecord{}
	mounted = append(mounted, authAdminRoutes(deps)...)
	mounted = append(mounted, receivablesRoutes(deps)...)
	mounted = append(mounted, paymentsRoutes(deps)...)
	mounted = append(mounted, collectionsRoutes(deps)...)
	mounted = append(mounted, ledgerRoutes(deps)...)
	mounted = append(mounted, adjustmentsRoutes(deps)...)
	capabilities := capabilitiesOf(mounted)

	table := []RouteRecord{}
	table = append(table, publicRoutes()...)
	table = append(table, mounted...)
	table = append(table, metaRoute(capabilities))
	return table, nil
}

// capabilitiesOf derives the sorted unique third segments of the non-public
// mounted rows (the same derivation server.ts runs over admin+resource).
func capabilitiesOf(table []RouteRecord) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, record := range table {
		segments := splitPattern(record.Pattern)
		if len(segments) < 3 || segments[2] == "" {
			continue
		}
		if !seen[segments[2]] {
			seen[segments[2]] = true
			out = append(out, segments[2])
		}
	}
	sortStrings(out)
	return out
}

func splitPattern(pattern string) []string {
	out := []string{}
	current := ""
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '/' {
			out = append(out, current)
			current = ""
			continue
		}
		current += string(pattern[i])
	}
	out = append(out, current)
	return out
}

func sortStrings(values []string) {
	for i := 0; i < len(values); i++ {
		for j := i + 1; j < len(values); j++ {
			if values[j] < values[i] {
				values[i], values[j] = values[j], values[i]
			}
		}
	}
}

// ledgerAccountSort / ledgerEntrySort are the ledger lists' whitelists
// (repositories.LedgerAccountSort / LedgerEntrySort carry the columns).
var ledgerAccountSort = repositories.LedgerAccountSort
var ledgerEntrySort = repositories.LedgerEntrySort

// adjustmentSort is the adjustments feed's whitelist.
var adjustmentSort = repositories.AdjustmentSort

// ledgerRoutes mounts the append-only GL read surface (routes/ledger.ts,
// issue #132) — both rows require `ledger:read`. READ-ONLY by contract:
// no /v1 operation mutates ledger truth (R3); rows arrive only through the
// posting flows (a confirmed payment posts its balanced entry in the same
// transaction — repositories.PostConfirmationEntry, R4/R5).
func ledgerRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method: "GET", Pattern: "/v1/ledger/accounts", Permission: "ledger:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, ledgerAccountSort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListLedgerAccounts(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					sorting.Column, sorting.Order, page.Limit, page.Offset)
				if err != nil {
					return HandlerResult{}, err
				}
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, ledgerAccountView(row))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"accounts": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
		{
			Method: "GET", Pattern: "/v1/ledger/entries", Permission: "ledger:read",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, ledgerEntrySort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListLedgerEntries(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					sorting.Column, sorting.Order, page.Limit, page.Offset)
				if err != nil {
					return HandlerResult{}, err
				}
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, ledgerEntryLineView(row))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"entries": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
	}
}

// adjustmentsRoutes mounts the adjustments surface (routes/adjustments.ts,
// issue #132): the org-scoped feed plus the two INTENT evaluators. The
// evaluators are DRY-RUN ports of the adjustments lane's refusal tables
// (src/domain/adjustments/{credit-note,refund}.ts): a refused proposal
// answers 200 with the refusals AS VALUES and NOTHING is written — no
// refunds row, no credit note, no ledger entry (R3/R6/R7). Both rows
// require `adjustments:request`.
func adjustmentsRoutes(deps Deps) []RouteRecord {
	svc := deps.Services
	return []RouteRecord{
		{
			Method: "GET", Pattern: "/v1/adjustments", Permission: "adjustments:request",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				page, derr := parsePagination(rc.Query)
				if derr != nil {
					return HandlerResult{}, derr
				}
				sorting, derr := parseSorting(rc.Query, adjustmentSort)
				if derr != nil {
					return HandlerResult{}, derr
				}
				rows, total, err := svc.ListAdjustments(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					application.AdjustmentQuery{SortCol: sorting.Column, Order: sorting.Order, Limit: page.Limit, Offset: page.Offset})
				if err != nil {
					return HandlerResult{}, err
				}
				views := []map[string]any{}
				for _, row := range rows {
					views = append(views, adjustmentView(row))
				}
				return HandlerResult{Status: 200, Data: map[string]any{"adjustments": views},
					Meta: paginatedMeta(page.Offset, page.Limit, total)}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/adjustments/credit-notes", Permission: "adjustments:request",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				// The evaluation is pure (nothing persists, nothing to scope),
				// but the fail-closed principal assertion still runs: a
				// permission-gated handler without a principal is a kernel bug.
				if _, err := requirePrincipal(rc); err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				customerID, derr := uuidField(body, "customerId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				invoiceID, _, derr := optionalUUIDField(body, "invoiceId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := rawStringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				totalMinor, currency, derr := rawMoneyMinorField(body, "total")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result := svc.EvaluateCreditNoteIntent(application.CreditNoteIntentCommand{
					CustomerID: customerID,
					InvoiceID:  invoiceID,
					Reason:     reason,
					TotalMinor: totalMinor,
					Currency:   string(currency),
				})
				refusals := []map[string]any{}
				for _, refusal := range result.Refusals {
					refusals = append(refusals, refusalView(refusal))
				}
				return HandlerResult{Status: 200, Data: map[string]any{
					"intent":   creditNoteIntentView(result.Intent),
					"accepted": result.Accepted,
					"refusals": refusals,
				}}, nil
			},
		},
		{
			Method: "POST", Pattern: "/v1/adjustments/refund-reservations", Permission: "adjustments:request",
			Handler: func(rc *RequestContext) (HandlerResult, error) {
				principal, err := requirePrincipal(rc)
				if err != nil {
					return HandlerResult{}, err
				}
				body, derr := bodyObject(rc.Body)
				if derr != nil {
					return HandlerResult{}, derr
				}
				paymentID, derr := uuidField(body, "paymentId")
				if derr != nil {
					return HandlerResult{}, derr
				}
				amountMinor, currency, derr := rawMoneyMinorField(body, "amount")
				if derr != nil {
					return HandlerResult{}, derr
				}
				reason, derr := rawStringField(body, "reason")
				if derr != nil {
					return HandlerResult{}, derr
				}
				requestedBy, _, derr := rawOptionalStringField(body, "requestedBy")
				if derr != nil {
					return HandlerResult{}, derr
				}
				result, err := svc.EvaluateRefundReservationIntent(rc.context(), deps.Services.Stores.Pool, principal.OrgID,
					principal.PrincipalID, application.RefundIntentCommand{
						PaymentID:   paymentID,
						AmountMinor: amountMinor,
						Currency:    string(currency),
						Reason:      reason,
						RequestedBy: requestedBy,
					})
				if err != nil {
					return HandlerResult{}, err
				}
				refusals := []map[string]any{}
				for _, refusal := range result.Refusals {
					refusals = append(refusals, refusalView(refusal))
				}
				return HandlerResult{Status: 200, Data: map[string]any{
					"intent":   refundIntentView(result.Intent),
					"accepted": result.Accepted,
					"refusals": refusals,
				}}, nil
			},
		},
	}
}
