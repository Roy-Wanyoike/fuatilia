package transport

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// --- StatusForCode: the exact/prefix/suffix/fail-closed mapping table ---------

func TestStatusForCodeParity(t *testing.T) {
	cases := []struct {
		code   string
		status int
	}{
		// kernel transport codes
		{CodePayloadTooLarge, 413},
		{CodeBodyMalformed, 400},
		{CodeBodyInvalid, 400},
		{CodeQueryInvalid, 400},
		{CodeRouteNotFound, 404},
		{CodeMethodNotAllowed, 405},
		{CodeUnauthenticated, 401},
		// route-level lookups
		{"HTTP_USER_NOT_FOUND", 404},
		{"HTTP_RECEIVABLE_NOT_FOUND", 404},
		// audited authorization denials
		{"AUTH_ACCESS_DENIED", 403},
		{"AUTH_ESCALATION_BLOCKED", 403},
		// key denials: EXACT beats the _MISMATCH suffix rule
		{"KEY_UNKNOWN", 401},
		{"KEY_SECRET_MISMATCH", 401},
		{"KEY_REVOKED", 401},
		{"KEY_EXPIRED", 401},
		{"KEY_OWNER_INACTIVE", 401},
		// prefix families
		{"SESSION_IDLE_EXPIRED", 401},
		{"SESSION_ABSOLUTE_EXPIRED", 401},
		{"SESSION_REVOKED", 401},
		{"SESS_NOT_ACTIVE", 401},
		{"PRINCIPAL_SUSPENDED", 401},
		{"PRINCIPAL_UNKNOWN", 401},
		// state-machine refusals the suffix table cannot catch
		{"PAYMENT_TERMINAL", 409},
		{"PAYMENT_NOT_CONFIRMED", 409},
		{"INVALID_TRANSITION", 409},
		{"REFUND_EXCEEDS_AVAILABLE", 422},
		{"CASE_ALREADY_OPEN", 409},
		{"CASE_CLOSED", 409},
		{"CASE_ACTION_ALREADY_COMPLETED", 409},
		{"DUNNING_CONSENT_REQUIRED", 403},
		{"AUTH_PERMISSION_WILDCARD_FORBIDDEN", 400},
		// suffix families
		{"AUTH_EMAIL_TAKEN", 409},
		{"CURRENCY_MISMATCH", 409},
		{"DUPLICATE_AMOUNT_MISMATCH", 409},
		{"AUTH_KEY_EXPIRY_INVALID", 400},
		{"INTAKE_CHANNEL_INVALID", 400},
		{"AUTH_SECRET_TOO_SHORT", 400},
		{"AUTH_ROLE_NOT_HELD", 409},
		// fail closed
		{"SOMETHING_ENTIRELY_UNMAPPED", 500},
	}
	for _, tc := range cases {
		if got := StatusForCode(tc.code); got != tc.status {
			t.Errorf("StatusForCode(%q) = %d, want %d", tc.code, got, tc.status)
		}
	}
}

// --- router: compile + match semantics ----------------------------------------

func TestCompileRoutesRejectsBrokenTables(t *testing.T) {
	cases := []struct {
		name   string
		routes []RouteRecord
		reason string
	}{
		{"unversioned", []RouteRecord{{Method: "GET", Pattern: "/health", Handler: noopHandler}}, "HTTP_ROUTE_PATTERN_INVALID"},
		{"illegal segment", []RouteRecord{{Method: "GET", Pattern: "/v1/he alth", Handler: noopHandler}}, "HTTP_ROUTE_PATTERN_INVALID"},
		{"illegal param", []RouteRecord{{Method: "GET", Pattern: "/v1/x/:9id", Handler: noopHandler}}, "HTTP_ROUTE_PATTERN_INVALID"},
		{"duplicate param", []RouteRecord{{Method: "GET", Pattern: "/v1/x/:id/y/:id", Handler: noopHandler}}, "HTTP_ROUTE_PATTERN_INVALID"},
		{"duplicate route", []RouteRecord{
			{Method: "GET", Pattern: "/v1/x", Handler: noopHandler},
			{Method: "GET", Pattern: "/v1/x", Handler: noopHandler},
		}, "HTTP_ROUTE_DUPLICATE"},
	}
	for _, tc := range cases {
		_, err := NewKernel(KernelOptions{Routes: tc.routes})
		if err == nil {
			t.Fatalf("%s: expected boot failure", tc.name)
		}
		if !IsRouteRegistrationError(err) || !strings.Contains(err.Error(), tc.reason) {
			t.Fatalf("%s: err = %v, want a %s registration error", tc.name, err, tc.reason)
		}
	}
}

func noopHandler(*RequestContext) (HandlerResult, error) {
	return HandlerResult{Status: 200, Data: map[string]any{}}, nil
}

func testKernel(t *testing.T) *Kernel {
	t.Helper()
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{
			{Method: "GET", Pattern: "/v1/things", Handler: func(rc *RequestContext) (HandlerResult, error) {
				return HandlerResult{Status: 200, Data: map[string]any{"q": rc.Query["limit"]}}, nil
			}},
			{Method: "GET", Pattern: "/v1/things/:thingId", Handler: func(rc *RequestContext) (HandlerResult, error) {
				return HandlerResult{Status: 200, Data: map[string]any{"id": rc.Params["thingId"]}}, nil
			}},
			{Method: "POST", Pattern: "/v1/things", Handler: noopHandler},
			{Method: "GET", Pattern: "/v1/boom", Handler: func(*RequestContext) (HandlerResult, error) {
				panic("handler exploded")
			}},
			{Method: "GET", Pattern: "/v1/badstatus", Handler: func(*RequestContext) (HandlerResult, error) {
				return HandlerResult{Status: 404, Data: map[string]any{}}, nil
			}},
			{Method: "GET", Pattern: "/v1/fail", Handler: func(*RequestContext) (HandlerResult, error) {
				return HandlerResult{}, errors.New("raw plumbing failure")
			}},
		},
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	return k
}

func TestRouterMatchSemantics(t *testing.T) {
	k := testKernel(t)

	// params extract — a %2F can NEVER split a segment (the TS URL.pathname
	// matcher keeps escapes encoded; the param arrives raw, one segment).
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/things/abc%2Fdef?limit=1", nil))
	if rec.Code != 200 {
		t.Fatalf("param route status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var body struct {
		Data map[string]string `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Data["id"] != "abc%2Fdef" {
		t.Fatalf("param must arrive raw in ONE segment (TS pathname parity): %v", body.Data)
	}

	// unknown path → 404 envelope
	rec = httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/nope", nil))
	assertErrorEnvelope(t, rec, 404, CodeRouteNotFound)

	// known path, wrong method → 405 + Allow header
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("DELETE", "/v1/things", nil)
	k.ServeHTTP(rec, req)
	assertErrorEnvelope(t, rec, 405, CodeMethodNotAllowed)
	if allow := rec.Header().Get("Allow"); allow != "GET, POST" {
		t.Fatalf("Allow header = %q, want \"GET, POST\"", allow)
	}

	// one trailing slash is tolerated in place
	rec = httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/things/", nil))
	if rec.Code != 200 {
		t.Fatalf("trailing-slash request status = %d (the TS kernel answers it in place)", rec.Code)
	}
}

func TestQueryLastValueWins(t *testing.T) {
	k := testKernel(t)
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/things?limit=5&limit=9", nil))
	var body struct {
		Data map[string]string `json:"data"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Data["q"] != "9" {
		t.Fatalf("query overwrite semantics drift: %+v (TS URLSearchParams.forEach keeps the LAST value)", body.Data)
	}
}

// --- envelope + request id + panic recovery ------------------------------------

func TestEnvelopeAndRequestID(t *testing.T) {
	k := testKernel(t)

	// success envelope {data} with echoed request id
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/things", nil)
	req.Header.Set("X-Request-Id", "abc_DEF-123")
	k.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("X-Request-Id"); got != "abc_DEF-123" {
		t.Fatalf("x-request-id not echoed: %q", got)
	}
	var success struct {
		Data map[string]any `json:"data"`
		Meta map[string]any `json:"meta"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &success)
	if success.Data == nil {
		t.Fatalf("success envelope must carry data: %s", rec.Body.String())
	}
	if success.Meta != nil {
		t.Fatalf("meta must be OMITTED when the handler carries none: %s", rec.Body.String())
	}

	// ill-formed client request ids are ignored, regenerated, never echoed
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/v1/things", nil)
	req.Header.Set("X-Request-Id", "bad id\nwith injection")
	k.ServeHTTP(rec, req)
	got := rec.Header().Get("X-Request-Id")
	if got == "" || got == "bad id\nwith injection" || strings.ContainsAny(got, " \n") {
		t.Fatalf("ill-formed request id must be regenerated: %q", got)
	}

	// correlation id accepted when request id absent
	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/v1/things", nil)
	req.Header.Set("X-Correlation-ID", "corr-42")
	k.ServeHTTP(rec, req)
	if rec.Header().Get("X-Request-Id") != "corr-42" {
		t.Fatalf("correlation id must ride x-request-id on the response")
	}
}

func TestPanicBecomesFailClosed500(t *testing.T) {
	sunk := make(chan string, 4)
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{{Method: "GET", Pattern: "/v1/boom", Handler: func(*RequestContext) (HandlerResult, error) {
			panic("handler exploded")
		}}},
		OnError: func(err error, requestID string) { sunk <- err.Error() },
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/boom", nil))
	assertErrorEnvelope(t, rec, 500, CodeInternalError)
	var body struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body.Error.Message != "internal server error" {
		t.Fatalf("500 must be generic: %q", body.Error.Message)
	}
	if len(sunk) == 0 {
		t.Fatalf("the panic must reach the observability sink")
	}
}

func TestNonDomainErrorIsFailClosed500(t *testing.T) {
	k := testKernel(t)
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/fail", nil))
	assertErrorEnvelope(t, rec, 500, CodeInternalError)

	// a handler returning a non-2xx status is a contract violation → generic 500
	rec = httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/badstatus", nil))
	assertErrorEnvelope(t, rec, 500, CodeInternalError)
}

func TestDomainErrorMappedOntoWire(t *testing.T) {
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{{Method: "GET", Pattern: "/v1/refused", Handler: func(*RequestContext) (HandlerResult, error) {
			return HandlerResult{}, infra.NewDomainError("DUPLICATE_AMOUNT_MISMATCH", "duplicate callback carries KES 5.00 but the payment was initiated for KES 4.00", nil)
		}}},
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/refused", nil))
	assertErrorEnvelope(t, rec, 409, "DUPLICATE_AMOUNT_MISMATCH")
	if !strings.Contains(rec.Body.String(), "KES 5.00") {
		t.Fatalf("the domain message must surface verbatim: %s", rec.Body.String())
	}

	// an INTERNAL-status code never leaks its message
	k, err = NewKernel(KernelOptions{
		Routes: []RouteRecord{{Method: "GET", Pattern: "/v1/leak", Handler: func(*RequestContext) (HandlerResult, error) {
			return HandlerResult{}, infra.NewDomainError("UNMAPPED_CODE", "secret internals", nil)
		}}},
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	rec = httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/leak", nil))
	assertErrorEnvelope(t, rec, 500, CodeInternalError)
	if strings.Contains(rec.Body.String(), "secret internals") {
		t.Fatalf("internals leaked onto the wire: %s", rec.Body.String())
	}
}

// --- body parsing: 413 boundary, malformed JSON, exact money --------------------

func TestParseBodyBoundary(t *testing.T) {
	// exactly maxBytes passes, one byte more refuses (INCLUSIVE-at-refusal).
	payload := `{"a":123}` // 9 valid-JSON bytes
	if !parseBody(strings.NewReader(payload), 9).OK {
		t.Fatalf("exactly maxBytes must pass")
	}
	parsed := parseBody(strings.NewReader(payload), 8)
	if parsed.OK || parsed.Code != CodePayloadTooLarge {
		t.Fatalf("one byte over must refuse 413, got %+v", parsed)
	}

	// empty body → no value
	empty := parseBody(strings.NewReader(""), 100)
	if !empty.OK || empty.Value != nil {
		t.Fatalf("empty body must parse with no value: %+v", empty)
	}

	// malformed JSON
	bad := parseBody(strings.NewReader("{nope"), 100)
	if bad.OK || bad.Code != CodeBodyMalformed {
		t.Fatalf("malformed JSON must refuse HTTP_BODY_MALFORMED: %+v", bad)
	}

	// numbers survive as exact tokens (json.Number), never float64
	nums := parseBody(strings.NewReader(`{"minor": 9007199254740993}`), 1000)
	if !nums.OK {
		t.Fatalf("safe-range big int must parse: %+v", nums)
	}
	obj := nums.Value.(map[string]any)
	if _, isFloat := obj["minor"].(float64); isFloat {
		t.Fatalf("money decoded through float64 — R10 violation")
	}
	if obj["minor"].(interface{ String() string }).String() != "9007199254740993" {
		t.Fatalf("exact integer token lost: %v", obj["minor"])
	}
}

// --- pagination: strict 1–100, opaque cursor, whitelist sorting -----------------

func TestParsePaginationBoundaries(t *testing.T) {
	cases := []struct {
		name    string
		query   map[string]string
		wantErr bool
		limit   int
		offset  int
	}{
		{"defaults", map[string]string{}, false, 20, 0},
		{"limit=1 legal", map[string]string{"limit": "1"}, false, 1, 0},
		{"limit=100 legal", map[string]string{"limit": "100"}, false, 100, 0},
		{"limit=0 refuses", map[string]string{"limit": "0"}, true, 0, 0},
		{"limit=101 refuses", map[string]string{"limit": "101"}, true, 0, 0},
		{"limit=abc refuses", map[string]string{"limit": "abc"}, true, 0, 0},
		{"limit=+5 refuses", map[string]string{"limit": "+5"}, true, 0, 0},
		{"limit=5.0 refuses", map[string]string{"limit": "5.0"}, true, 0, 0},
		{"cursor legal", map[string]string{"cursor": "40"}, false, 20, 40},
		{"cursor negative refuses", map[string]string{"cursor": "-1"}, true, 0, 0},
		{"cursor garbage refuses", map[string]string{"cursor": "next-page"}, true, 0, 0},
	}
	for _, tc := range cases {
		page, derr := parsePagination(tc.query)
		if tc.wantErr {
			if derr == nil || derr.Code != CodeQueryInvalid {
				t.Fatalf("%s: want HTTP_QUERY_INVALID, got %+v", tc.name, derr)
			}
			continue
		}
		if derr != nil {
			t.Fatalf("%s: unexpected refusal %v", tc.name, derr)
		}
		if page.Limit != tc.limit || page.Offset != tc.offset {
			t.Fatalf("%s: got %+v want limit=%d offset=%d", tc.name, page, tc.limit, tc.offset)
		}
	}
}

func TestParseSortingWhitelist(t *testing.T) {
	whitelist := map[string]string{"dueDate": "due_date", "id": "id"}
	if s, derr := parseSorting(map[string]string{}, whitelist); derr != nil || s.Order != "asc" {
		t.Fatalf("defaults: %+v %v", s, derr)
	}
	if s, derr := parseSorting(map[string]string{"sort": "dueDate", "order": "DESC"}, whitelist); derr != nil || s.Column != "due_date" || s.Order != "desc" {
		t.Fatalf("whitelisted sort: %+v %v", s, derr)
	}
	if derr := mustDerr(parseSorting(map[string]string{"sort": "due_date"}, whitelist)); derr == nil || derr.Code != CodeQueryInvalid {
		t.Fatalf("a RAW column name (not a whitelisted field) must refuse")
	}
	if derr := mustDerr(parseSorting(map[string]string{"order": "sideways"}, whitelist)); derr == nil {
		t.Fatalf("illegal order must refuse")
	}
}

func mustDerr(_ any, derr *infra.DomainError) *infra.DomainError { return derr }

func TestPaginatedMetaCursor(t *testing.T) {
	meta := paginatedMeta(0, 20, 100)
	pagination := meta["pagination"].(map[string]any)
	if pagination["nextCursor"] != "20" || pagination["total"] != 100 {
		t.Fatalf("meta: %+v", pagination)
	}
	last := paginatedMeta(80, 20, 100)["pagination"].(map[string]any)
	if last["nextCursor"] != nil {
		t.Fatalf("an exhausted page must answer nextCursor null: %+v", last)
	}
}

// --- body field guards -----------------------------------------------------------

func TestBodyFieldGuards(t *testing.T) {
	if _, derr := bodyObject("not-an-object"); derr == nil || derr.Code != CodeBodyInvalid {
		t.Fatalf("non-object body must refuse")
	}
	if _, derr := stringField(map[string]any{"e": "   "}, "e"); derr == nil {
		t.Fatalf("blank string must refuse")
	}
	if v, derr := stringField(map[string]any{"e": " x "}, "e"); derr != nil || v != "x" {
		t.Fatalf("strings trim: %q %v", v, derr)
	}
	if _, derr := uuidField(map[string]any{"u": "not-a-uuid"}, "u"); derr == nil {
		t.Fatalf("malformed uuid must refuse")
	}
	if _, derr := uuidField(map[string]any{"u": "6f9619ff-8b86-d011-b42d-00c04fc964ff"}, "u"); derr != nil {
		t.Fatalf("any version nibble is a legal wire uuid: %v", derr)
	}

	// money: exact minor units + closed currency set
	good := map[string]any{"amount": map[string]any{"minor": jsonNumberOf("1250"), "currency": "KES"}}
	minor, currency, derr := moneyMinorField(good, "amount")
	if derr != nil || minor != 1250 || currency != "KES" {
		t.Fatalf("money field: %d %q %v", minor, currency, derr)
	}
	zero := map[string]any{"amount": map[string]any{"minor": jsonNumberOf("0"), "currency": "KES"}}
	if _, _, derr := moneyMinorField(zero, "amount"); derr == nil {
		t.Fatalf("zero minor must refuse")
	}
	big := map[string]any{"amount": map[string]any{"minor": jsonNumberOf("9007199254740992"), "currency": "KES"}}
	if _, _, derr := moneyMinorField(big, "amount"); derr == nil {
		t.Fatalf("beyond Number.MAX_SAFE_INTEGER must refuse (TS parity)")
	}
	badCurrency := map[string]any{"amount": map[string]any{"minor": jsonNumberOf("10"), "currency": "BTC"}}
	if _, _, derr := moneyMinorField(badCurrency, "amount"); derr == nil {
		t.Fatalf("currency outside the closed set must refuse")
	}

	// uuid arrays dedupe-check (R8 coverage shape)
	if _, derr := uuidArrayField(map[string]any{"ids": []any{uuidA(), uuidA()}}, "ids"); derr == nil {
		t.Fatalf("repeated receivable id must refuse")
	}
	if ids, derr := uuidArrayField(map[string]any{"ids": []any{uuidA(), uuidB()}}, "ids"); derr != nil || len(ids) != 2 {
		t.Fatalf("distinct uuid array legal: %v %v", ids, derr)
	}
}

func jsonNumberOf(s string) json.Number { return json.Number(s) }

func uuidA() string { return "6f9619ff-8b86-d011-b42d-00c04fc964ff" }
func uuidB() string { return "7f9619ff-8b86-d011-b42d-00c04fc964ff" }

// --- context propagation ---------------------------------------------------------

func TestRequestContextCarriesRawRequest(t *testing.T) {
	k, err := NewKernel(KernelOptions{
		Routes: []RouteRecord{{Method: "GET", Pattern: "/v1/ctx", Handler: func(rc *RequestContext) (HandlerResult, error) {
			if rc.RawRequest == nil {
				t.Errorf("RawRequest must ride the context")
			}
			if rc.context() == nil {
				t.Errorf("handler context must resolve to a live context")
			}
			return HandlerResult{Status: 200, Data: map[string]any{}}, nil
		}}},
	})
	if err != nil {
		t.Fatalf("kernel: %v", err)
	}
	rec := httptest.NewRecorder()
	k.ServeHTTP(rec, httptest.NewRequest("GET", "/v1/ctx", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

// --- helpers ----------------------------------------------------------------------

func assertErrorEnvelope(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, wantStatus, rec.Body.String())
	}
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error envelope is not JSON: %v (%s)", err, rec.Body.String())
	}
	if body.Error.Code != wantCode {
		t.Fatalf("error code = %q, want %q (body: %s)", body.Error.Code, wantCode, rec.Body.String())
	}
	if body.RequestID == "" {
		t.Fatalf("every error envelope carries the requestId")
	}
	if rec.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", rec.Header().Get("Content-Type"))
	}
}
