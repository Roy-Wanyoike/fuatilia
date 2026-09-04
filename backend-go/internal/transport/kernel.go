package transport

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/auth"
	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// asDomainError unwraps an *infra.DomainError through the error chain
// (services wrap lower-layer failures with %w).
func asDomainError(err error, target **infra.DomainError) bool {
	return errors.As(err, target)
}

// RequestContext is everything a handler may touch (kernel/types.ts): the
// extracted :params, the parsed query/headers, the accepted-or-generated
// request id, the resolved principal (nil on public routes) and the parsed
// JSON body (nil when the request carried none).
type RequestContext struct {
	Params     map[string]string
	Query      map[string]string
	Headers    map[string]string
	RequestID  string
	Principal  *auth.Principal
	Body       any
	RawRequest *http.Request
}

// HandlerResult is a handler outcome. The kernel wraps Data/Meta into the
// §38 success envelope {data, meta?}; failures are *infra.DomainError values
// mapped by the kernel's error table — handlers never build error envelopes.
type HandlerResult struct {
	// Status must be 2xx — anything else is a handler bug and surfaces as a
	// fail-closed 500.
	Status int
	Data   any
	Meta   map[string]any
}

// Handler is one route's wire→application adapter.
type Handler func(rc *RequestContext) (HandlerResult, error)

// KernelOptions compose the kernel.
type KernelOptions struct {
	// Routes is the registration TABLE (public + auth admin + resources).
	Routes []RouteRecord
	// Auth gates every permission-carrying route (authenticate → can() →
	// audited denial, 401/403, BEFORE the handler runs).
	Auth *auth.Authenticator
	// Clock feeds every audited denial timestamp.
	Clock infra.Clock
	// IDs generates request ids (and handler-side aggregate ids).
	IDs func() string
	// MaxBodyBytes caps request JSON bodies (default 1 MiB).
	MaxBodyBytes int64
	// Log receives the structured per-request line (requestId, method, path,
	// status, duration, org — never credentials).
	Log *slog.Logger
	// OnError is the observability sink for unmapped/internal errors — the
	// response body never carries them.
	OnError func(err error, requestID string)
}

// Kernel is the HTTP kernel: the mounted route table plus handle.
type Kernel struct {
	routes       []compiledRoute
	table        []RouteRecord
	auth         *auth.Authenticator
	clock        infra.Clock
	ids          func() string
	maxBodyBytes int64
	log          *slog.Logger
	onError      func(err error, requestID string)
}

// NewKernel compiles + validates the route table (a broken row is a boot
// failure, never a runtime 500) and returns the kernel.
func NewKernel(options KernelOptions) (*Kernel, error) {
	if options.Clock == nil {
		options.Clock = infra.SystemClock{}
	}
	if options.IDs == nil {
		options.IDs = infra.NewUUID
	}
	if options.MaxBodyBytes <= 0 {
		options.MaxBodyBytes = DefaultMaxBodyBytes
	}
	if options.Log == nil {
		options.Log = slog.Default()
	}
	compiled, err := compileRoutes(options.Routes)
	if err != nil {
		return nil, err
	}
	return &Kernel{
		routes:       compiled,
		table:        options.Routes,
		auth:         options.Auth,
		clock:        options.Clock,
		ids:          options.IDs,
		maxBodyBytes: options.MaxBodyBytes,
		log:          options.Log,
		onError:      options.OnError,
	}, nil
}

// DefaultMaxBodyBytes is the kernel's JSON body cap (kernel/body.ts: 1 MiB).
const DefaultMaxBodyBytes = 1_048_576

// Table exposes the registered rows (the OpenAPI parity test mounts it).
func (k *Kernel) Table() []RouteRecord { return k.table }

// ServeHTTP adapts net/http INTO the kernel pipeline (server.ts is the only
// socket-aware piece in the TS lane; ServeHTTP is its Go twin).
func (k *Kernel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	requestID, org, status := k.handle(w, r)
	k.log.Info("http.request",
		slog.String("requestId", requestID),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
		slog.Int("status", status),
		slog.Int64("durationMs", time.Since(start).Milliseconds()),
		slog.String("org", org),
	)
}

// handle drives one request through the pipeline and returns
// (requestId, org-for-logging, status).
func (k *Kernel) handle(w http.ResponseWriter, r *http.Request) (string, string, int) {
	headers := normalizeHeaders(r.Header)
	requestID := resolveRequestID(headers, k.ids)
	org := ""

	respond := func(status int, body any, extra map[string]string) int {
		writeJSON(w, status, requestID, body, extra)
		return status
	}
	fail := func(status int, code, message string, extra map[string]string) int {
		return respond(status, errorShape{
			Error:     errorBodyShape{Code: code, Message: message},
			RequestID: requestID,
		}, extra)
	}

	defer func() {
		if rec := recover(); rec != nil {
			err := fmt.Errorf("panic: %v", rec)
			if k.onError != nil {
				k.onError(err, requestID)
			}
			// Best-effort: the response may already be committed; a panic
			// after write is a transport bug the sink records.
			writeError(w, 500, CodeInternalError, "internal server error", requestID)
		}
	}()

	parsed := parseBody(r.Body, k.maxBodyBytes)
	if !parsed.OK {
		return requestID, org, fail(StatusForCode(parsed.Code), parsed.Code, parsed.Message, nil)
	}

	method := strings.ToUpper(strings.TrimSpace(r.Method))
	// EscapedPath mirrors the TS composition: `new URL(req.url).pathname`
	// keeps percent-escapes ENCODED, so a %2F can never split a segment
	// (params are matched raw, exactly like the TS kernel).
	match := matchRoute(k.routes, method, r.URL.EscapedPath())
	if match.notFound {
		return requestID, org, fail(404, CodeRouteNotFound, routeNotFoundMessage(method, r.URL.Path), nil)
	}
	if match.notAllowed {
		return requestID, org, fail(405, CodeMethodNotAllowed,
			methodNotAllowedMessage(method, r.URL.Path, match.allow), map[string]string{"Allow": strings.Join(match.allow, ", ")})
	}

	var principal *auth.Principal
	if permission := match.route.record.Permission; permission != "" {
		authn := k.auth.Authenticate(r.Context(), headers["authorization"])
		if authn.Err != nil {
			if authn.InternalErr != nil {
				// The denial could not be AUDITED — fail closed (a refusal
				// that leaves no audit fact must never surface as a 4xx).
				if k.onError != nil {
					k.onError(authn.InternalErr, requestID)
				}
				return requestID, org, fail(500, CodeInternalError, "internal server error", nil)
			}
			return requestID, org, fail(StatusForCode(authn.Err.Code), authn.Err.Code, authn.Err.Message, nil)
		}
		if err := k.auth.Authorize(r.Context(), authn.Principal, permission); err != nil {
			if err.InternalErr != nil {
				if k.onError != nil {
					k.onError(err.InternalErr, requestID)
				}
				return requestID, org, fail(500, CodeInternalError, "internal server error", nil)
			}
			return requestID, org, fail(403, err.Code, err.Message, nil)
		}
		principal = &authn.Principal
		org = principal.OrgID
	}

	rc := &RequestContext{
		Params:     match.params,
		Query:      queryMap(r),
		Headers:    headers,
		RequestID:  requestID,
		Principal:  principal,
		Body:       parsed.Value,
		RawRequest: r,
	}

	result, err := k.invoke(rc, match.route.record.Handler)
	if err != nil {
		var domain *infra.DomainError
		if asDomainError(err, &domain) {
			status, code, message, internal := mapDomainError(domain)
			if internal {
				if k.onError != nil {
					k.onError(err, requestID)
				}
				return requestID, org, fail(500, CodeInternalError, "internal server error", nil)
			}
			return requestID, org, fail(status, code, message, nil)
		}
		if k.onError != nil {
			k.onError(err, requestID)
		}
		return requestID, org, fail(500, CodeInternalError, "internal server error", nil)
	}
	if result.Status < 200 || result.Status > 299 {
		// Handler contract violation — never surfaced; generic 500 + sink.
		if k.onError != nil {
			k.onError(fmt.Errorf("handler for %s %s returned non-2xx status %d", method, r.URL.Path, result.Status), requestID)
		}
		return requestID, org, fail(500, CodeInternalError, "internal server error", nil)
	}
	return requestID, org, respond(result.Status, successShape{Data: result.Data, Meta: result.Meta}, nil)
}

// invoke runs one handler with panic recovery so a handler bug becomes the
// fail-closed 500 (never a connection reset with no envelope).
func (k *Kernel) invoke(rc *RequestContext, handler Handler) (result HandlerResult, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("handler panic: %v", rec)
		}
	}()
	return handler(rc)
}

// context exposes the live request context so handlers join the server's
// cancellation/deadline propagation (a synthetic RequestContext without a
// raw request falls back to Background).
func (rc *RequestContext) context() context.Context {
	if rc.RawRequest != nil {
		if ctx := rc.RawRequest.Context(); ctx != nil {
			return ctx
		}
	}
	return context.Background()
}

// normalizeHeaders lowercases all header names (the TS kernel's view of the
// request; net/http canonicalizes on read, we canonicalize on use).
func normalizeHeaders(headers http.Header) map[string]string {
	out := make(map[string]string, len(headers))
	for name, values := range headers {
		if len(values) == 0 {
			continue
		}
		// Last value wins on case-collisions, exactly like the TS adapter.
		out[strings.ToLower(name)] = values[len(values)-1]
	}
	return out
}

// resolveRequestID accepts-or-generates: x-request-id wins over
// x-correlation-id; an ill-formed or blank header value is ignored and
// regenerated.
func resolveRequestID(headers map[string]string, ids func() string) string {
	candidate := headers[strings.ToLower(RequestIDHeader)]
	if candidate == "" {
		candidate = headers[strings.ToLower(CorrelationIDHeader)]
	}
	if validRequestID(candidate) {
		return candidate
	}
	return ids()
}

// queryMap flattens the query string — the LAST value wins, exactly like the
// TS adapter's URLSearchParams.forEach overwrite.
func queryMap(r *http.Request) map[string]string {
	out := map[string]string{}
	for key, values := range r.URL.Query() {
		if len(values) > 0 {
			out[key] = values[len(values)-1]
		}
	}
	return out
}
