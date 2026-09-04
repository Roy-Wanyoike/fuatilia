package transport

import (
	"sort"
	"strings"
)

// The route table matcher (kernel/router.ts). Patterns are `/v1/...` with
// literal segments and `:name` params. Matching is deterministic: the full
// path must match one compiled pattern, else 404 HTTP_ROUTE_NOT_FOUND; when
// the path exists under OTHER methods the kernel answers 405
// HTTP_METHOD_NOT_ALLOWED with an `allow` header listing them (never a bare
// 404 — that hides routing tables from clients).
//
// This is a faithful port of the TS kernel's own matcher rather than a
// net/http ServeMux: ServeMux redirects/cleans paths (e.g. `/v1/health/` →
// 301 `/v1/health`), while the TS contract tolerates one trailing slash
// IN PLACE (`/v1/health/` ≡ `/v1/health`, 200) — the stdlib http.Server
// still serves everything; only the mux semantics are ported.

// RouteRecord is one row of the route registration TABLE: later waves mount
// more resources by appending rows. An empty Permission marks a public route
// (no authentication is attempted at all).
type RouteRecord struct {
	Method     string
	Pattern    string
	Permission string
	Handler    Handler
}

// compiledRoute is a route with its pattern pre-split into segments
// (composition-time validation, exactly compileRoute's checks).
type compiledRoute struct {
	record   RouteRecord
	segments []string
}

// compileRoute validates one route row: versioned under /v1/, legal segment
// alphabet, no duplicate param names. A broken table fails at composition,
// not on the wire.
func compileRoute(record RouteRecord) (compiledRoute, bool, string) {
	if !strings.HasPrefix(record.Pattern, "/v1/") {
		return compiledRoute{}, false, "route pattern '" + record.Pattern + "' must be versioned under /v1/"
	}
	segments := strings.Split(strings.TrimPrefix(record.Pattern, "/"), "/")
	seen := map[string]bool{}
	for _, segment := range segments {
		if strings.HasPrefix(segment, ":") {
			name := segment[1:]
			if !validParamName(name) {
				return compiledRoute{}, false, "route pattern '" + record.Pattern + "' has an illegal segment '" + segment + "'"
			}
			if seen[name] {
				return compiledRoute{}, false, "route pattern '" + record.Pattern + "' declares ':" + name + "' twice"
			}
			seen[name] = true
			continue
		}
		if !validSegment(segment) {
			return compiledRoute{}, false, "route pattern '" + record.Pattern + "' has an illegal segment '" + segment + "'"
		}
	}
	return compiledRoute{record: record, segments: segments}, true, ""
}

// validSegment mirrors SEGMENT_SHAPE ^[A-Za-z0-9._~-]+$ (the literal
// segment alphabet is safe in paths and logs).
func validSegment(segment string) bool {
	if segment == "" {
		return false
	}
	for _, c := range segment {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_', c == '~', c == '-':
		default:
			return false
		}
	}
	return true
}

// validParamName mirrors PARAM_SHAPE ^[A-Za-z_][A-Za-z0-9_]*$.
func validParamName(name string) bool {
	if name == "" {
		return false
	}
	first := name[0]
	if !(first >= 'A' && first <= 'Z' || first >= 'a' && first <= 'z' || first == '_') {
		return false
	}
	for _, c := range name[1:] {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

// compileRoutes validates a whole table; duplicate method+pattern rows
// refuse (HTTP_ROUTE_DUPLICATE — a registration-time 500-class failure).
func compileRoutes(routes []RouteRecord) ([]compiledRoute, error) {
	compiled := make([]compiledRoute, 0, len(routes))
	seen := map[string]bool{}
	for _, record := range routes {
		c, ok, reason := compileRoute(record)
		if !ok {
			return nil, infraRoutePatternInvalid(reason)
		}
		key := record.Method + " " + record.Pattern
		if seen[key] {
			return nil, infraRouteDuplicate("duplicate route '" + key + "'")
		}
		seen[key] = true
		compiled = append(compiled, c)
	}
	return compiled, nil
}

// routeMatch is the matcher's outcome: a matched route with its extracted
// params, or a 404/405 refusal (405 carries the sorted allow set).
type routeMatch struct {
	matched    bool
	route      *compiledRoute
	params     map[string]string
	notFound   bool
	notAllowed bool
	allow      []string
}

// matchRoute matches method+path against the compiled table. Path matching
// is case-sensitive; one trailing slash is tolerated (`/v1/health/` ≡
// `/v1/health`); anything else no pattern covers is a 404.
func matchRoute(compiled []compiledRoute, method, path string) routeMatch {
	normalized := path
	if len(normalized) > 1 && strings.HasSuffix(normalized, "/") {
		normalized = normalized[:len(normalized)-1]
	}
	parts := strings.Split(strings.TrimPrefix(normalized, "/"), "/")

	var pathMatches []*compiledRoute
	var allParams []map[string]string
	for i := range compiled {
		candidate := &compiled[i]
		if len(candidate.segments) != len(parts) {
			continue
		}
		params := map[string]string{}
		ok := true
		for j, patternSegment := range candidate.segments {
			pathSegment := parts[j]
			if strings.HasPrefix(patternSegment, ":") {
				params[patternSegment[1:]] = pathSegment
				continue
			}
			if patternSegment != pathSegment {
				ok = false
				break
			}
		}
		if ok {
			pathMatches = append(pathMatches, candidate)
			allParams = append(allParams, params)
		}
	}
	if len(pathMatches) == 0 {
		return routeMatch{notFound: true}
	}
	for i, candidate := range pathMatches {
		if candidate.record.Method == method {
			return routeMatch{matched: true, route: candidate, params: allParams[i]}
		}
	}
	allowSet := map[string]bool{}
	for _, candidate := range pathMatches {
		allowSet[candidate.record.Method] = true
	}
	allow := make([]string, 0, len(allowSet))
	for m := range allowSet {
		allow = append(allow, m)
	}
	sort.Strings(allow)
	return routeMatch{notAllowed: true, allow: allow}
}

// routeNotFoundMessage is the 404 detail the kernel puts in the envelope.
func routeNotFoundMessage(method, path string) string {
	return "no route for " + method + " " + path
}

// methodNotAllowedMessage is the 405 detail the kernel puts in the envelope.
func methodNotAllowedMessage(method, path string, allow []string) string {
	return method + " is not allowed for " + path + " — allowed: " + strings.Join(allow, ", ")
}
