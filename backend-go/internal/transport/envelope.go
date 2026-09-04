// Package transport is the HTTP face of the Go /v1 kernel (issue #72): the
// stdlib net/http server, the §38 envelope ({data, meta?} successes /
// {error:{code,message}, requestId} failures), the auth middleware and the
// 22 mounted operations. Wire rules mirror src/adapters/http/kernel exactly:
// every response carries x-request-id, unmapped codes fail closed to 500
// HTTP_INTERNAL_ERROR and internals never leak.
package transport

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/infra"
)

// Request/response header names (kernel/body.ts): the request id rides
// x-request-id on EVERY response, echoed from the request's x-request-id /
// x-correlation-id (else generated).
const (
	RequestIDHeader     = "X-Request-Id"
	CorrelationIDHeader = "X-Correlation-ID"
	contentTypeHeader   = "Content-Type"
	contentTypeJSON     = "application/json; charset=utf-8"
)

// errorShape is the §38 error envelope: { error: { code, message }, requestId }.
type errorShape struct {
	Error     errorBodyShape `json:"error"`
	RequestID string         `json:"requestId"`
}

type errorBodyShape struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// successShape is the §38 success envelope: { data, meta? } — meta is
// omitted when the handler carries none (exactly the TS composition).
type successShape struct {
	Data any            `json:"data"`
	Meta map[string]any `json:"meta,omitempty"`
}

// writeJSON renders one kernel response: status, the envelope body and the
// echoing headers. The request id rides both the top-level error field and
// the x-request-id header so every response is correlatable.
func writeJSON(w http.ResponseWriter, status int, requestID string, body any, extra map[string]string) {
	for name, value := range extra {
		w.Header().Set(name, value)
	}
	w.Header().Set(contentTypeHeader, contentTypeJSON)
	w.Header().Set(RequestIDHeader, requestID)
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(body)
}

// writeError renders the §38 error envelope.
func writeError(w http.ResponseWriter, status int, code, message, requestID string) {
	writeJSON(w, status, requestID, errorShape{
		Error:     errorBodyShape{Code: code, Message: message},
		RequestID: requestID,
	}, nil)
}

// requestBody is the parsed-JSON-or-refusal result of the body stage
// (kernel/body.ts parseRequestBody): a payload over the byte limit is
// refused 413 (inclusive-at-refusal: exactly maxBytes passes, one byte more
// refuses); unparseable JSON is 400 HTTP_BODY_MALFORMED.
type requestBody struct {
	OK      bool
	Code    string
	Message string
	Size    int
	Value   any
}

// parseBody reads r's body up to maxBytes and decodes the JSON. Numbers are
// decoded as json.Number so money fields validate as exact integers
// (Number.isSafeInteger parity — never a float64 rounding).
func parseBody(r io.Reader, maxBytes int64) requestBody {
	buf := make([]byte, 0, 4096)
	chunk := make([]byte, 32*1024)
	var size int64
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			size += int64(n)
			if size > maxBytes {
				return requestBody{
					Code:    CodePayloadTooLarge,
					Message: "request body is " + itoa(size) + " bytes — the limit is " + itoa(maxBytes),
					Size:    int(size),
				}
			}
			buf = append(buf, chunk[:n]...)
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return requestBody{Code: CodeBodyMalformed, Message: "request body could not be read", Size: int(size)}
		}
	}
	if len(bytes.TrimSpace(buf)) == 0 {
		return requestBody{OK: true, Size: len(buf)}
	}
	dec := json.NewDecoder(bytes.NewReader(buf))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return requestBody{Code: CodeBodyMalformed, Message: "request body is not valid JSON", Size: len(buf)}
	}
	return requestBody{OK: true, Value: value, Size: len(buf)}
}

// RequestIDShape is the sane opaque-token rule the kernel accepts for client
// supplied request ids ([A-Za-z0-9._-], ≤128 — anything else could smuggle
// header/log injection); ill-formed values are IGNORED (not echoed) and
// regenerated.
func validRequestID(candidate string) bool {
	if candidate == "" || len(candidate) > 128 {
		return false
	}
	for _, c := range candidate {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

// mapDomainError maps a stable domain/transport code onto the wire
// (kernel/errors.ts): statuses < 500 surface the code + message; anything
// unmapped or ≥ 500 fails closed to the generic 500 — internals never leak,
// the real error goes to the observability sink instead.
func mapDomainError(err *infra.DomainError) (status int, code, message string, internal bool) {
	status = StatusForCode(err.Code)
	if status >= 500 {
		return 500, CodeInternalError, "internal server error", true
	}
	return status, err.Code, err.Message, false
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
