package transport

import (
	"bufio"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestServedRoutesMatchOpenAPI is the machine check issue #72's acceptance
// criterion 1 demands: the (method, path) set the Go kernel serves is EXACTLY
// the operation set api/openapi/fuatilia.v1.yaml declares — no drift in
// either direction, no missing op, no invented route. A future lane that
// mounts or removes an op without the contract (or vice versa) fails here.
//
// Deliberate exception (issue #178): the Daraja rail-facing callback rows are
// mounted on the kernel but are NOT console API operations — their consumers
// are Safaricom's M-Pesa pipes, which authenticate by being the rail (the
// threat model's B1 boundary), not by the console's API keys. The rail set is
// PINNED below: a kernel row that is not an OpenAPI op and not in this set
// fails the test, so the exception cannot grow silently.
func TestServedRoutesMatchOpenAPI(t *testing.T) {
	specPath := findOpenAPISpec(t)
	specRoutes := parseOpenAPIOperations(t, specPath)

	composed, err := Compose(Deps{}, nil, nil)
	if err != nil {
		t.Fatalf("compose route table: %v", err)
	}
	railFacing := map[string]bool{
		// The three Daraja callback rows (internal/transport/callbacks.go):
		"POST /v1/callbacks/daraja/{orgId}/c2b/validation":   true,
		"POST /v1/callbacks/daraja/{orgId}/c2b/confirmation": true,
		"POST /v1/callbacks/daraja/stk/result":               true,
	}
	served := map[string]bool{}
	for _, record := range composed.Kernel.Table() {
		route := record.Method + " " + openAPIPathOf(record.Pattern)
		if railFacing[route] {
			continue // the pinned rail exception — asserted separately below
		}
		served[route] = true
	}

	if len(served) != len(specRoutes) {
		t.Fatalf("route count drift: OpenAPI declares %d operations, the kernel serves %d console routes", len(specRoutes), len(served))
	}
	if len(specRoutes) != 27 {
		t.Fatalf("OpenAPI operation count changed: expected the 27 mounted ops, yaml declares %d — update this test with the contract deliberately", len(specRoutes))
	}

	var missing, extra []string
	for route := range specRoutes {
		if !served[route] {
			missing = append(missing, route)
		}
	}
	for route := range served {
		if !specRoutes[route] {
			extra = append(extra, route)
		}
	}
	sort.Strings(missing)
	sort.Strings(extra)
	if len(missing) > 0 || len(extra) > 0 {
		t.Fatalf("OpenAPI parity drift\n  declared but not served: %v\n  served but not declared: %v", missing, extra)
	}

	// The rail rows must be mounted EXACTLY as pinned — a renamed or removed
	// callback row breaks the rail contract just as surely as an invented one.
	servedAll := map[string]bool{}
	for _, record := range composed.Kernel.Table() {
		servedAll[record.Method+" "+openAPIPathOf(record.Pattern)] = true
	}
	var railMissing, railExtra []string
	for route := range railFacing {
		if !servedAll[route] {
			railMissing = append(railMissing, route)
		}
	}
	for route := range servedAll {
		if !specRoutes[route] && !railFacing[route] {
			railExtra = append(railExtra, route)
		}
	}
	sort.Strings(railMissing)
	sort.Strings(railExtra)
	if len(railMissing) > 0 || len(railExtra) > 0 {
		t.Fatalf("rail-facing route drift\n  pinned but not served: %v\n  served but neither declared nor pinned: %v", railMissing, railExtra)
	}
}

// TestMetaCapabilityList pins the /v1/meta capability derivation: the sorted
// unique third path segments of the mounted admin+resource tables (the TS
// composition's derivation, driven here over the wire against the real
// meta route).
func TestMetaCapabilityList(t *testing.T) {
	composed, err := Compose(Deps{}, nil, nil)
	if err != nil {
		t.Fatalf("compose route table: %v", err)
	}
	server := httptest.NewServer(composed.Kernel)
	defer server.Close()

	res, err := http.Get(server.URL + "/v1/meta")
	if err != nil {
		t.Fatalf("GET /v1/meta: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("GET /v1/meta status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Data struct {
			Name         string   `json:"name"`
			APIVersion   string   `json:"apiVersion"`
			Capabilities []string `json:"capabilities"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode meta: %v", err)
	}
	if body.Data.Name != "fuatilia" || body.Data.APIVersion != "v1" {
		t.Fatalf("meta identity drift: %+v", body.Data)
	}
	want := []string{"adjustments", "auth", "collections", "ledger", "payments", "receivables"}
	if strings.Join(body.Data.Capabilities, ",") != strings.Join(want, ",") {
		t.Fatalf("capability list drift: got %v want %v", body.Data.Capabilities, want)
	}
}

// openAPIPathOf converts a kernel pattern (/v1/payments/:paymentId) into the
// OpenAPI path template (/v1/payments/{paymentId}).
func openAPIPathOf(pattern string) string {
	segments := strings.Split(pattern, "/")
	for i, segment := range segments {
		if strings.HasPrefix(segment, ":") {
			segments[i] = "{" + segment[1:] + "}"
		}
	}
	return strings.Join(segments, "/")
}

// findOpenAPISpec locates api/openapi/fuatilia.v1.yaml above the package
// directory (go test runs with the package dir as CWD).
func findOpenAPISpec(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for {
		candidate := filepath.Join(dir, "api", "openapi", "fuatilia.v1.yaml")
		if _, statErr := os.Stat(candidate); statErr == nil {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("api/openapi/fuatilia.v1.yaml not found above %s", dir)
		}
		dir = parent
	}
}

// parseOpenAPIOperations extracts the (METHOD path) operation set from the
// OpenAPI yaml with a minimal indentation-aware scan — the contract file is
// repo-controlled, so the parser only needs the two structural lines:
// `  /v1/...:` (indent-2 path keys) and `    get|post|...:` (indent-4
// operation keys) inside the paths section.
func parseOpenAPIOperations(t *testing.T, path string) map[string]bool {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	methods := map[string]bool{
		"get": true, "post": true, "put": true, "patch": true, "delete": true, "head": true, "options": true,
	}
	operations := map[string]bool{}
	inPaths := false
	currentPath := ""

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimLeft(line, " ")
		indent := len(line) - len(trimmed)
		if indent == 0 && strings.HasSuffix(trimmed, ":") {
			inPaths = strings.HasPrefix(trimmed, "paths:")
			currentPath = ""
			continue
		}
		if !inPaths {
			continue
		}
		switch {
		case indent == 2 && strings.HasPrefix(trimmed, "/") && strings.HasSuffix(trimmed, ":"):
			currentPath = strings.TrimSuffix(trimmed, ":")
		case indent == 4 && currentPath != "":
			key := strings.TrimSuffix(trimmed, ":")
			if methods[key] {
				operations[strings.ToUpper(key)+" "+currentPath] = true
			}
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	if len(operations) == 0 {
		t.Fatalf("parsed zero operations from %s — the scanner and the contract drifted", path)
	}
	return operations
}
