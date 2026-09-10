package webhooks

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
)

// SignatureHeaderName is the wire header carrying the signing contract's
// `t=<unixMillis>,v1=<lowercase hex>` value (signing.ts formatSignatureHeader).
// The value format is the pinned contract; this name is the transport's.
const SignatureHeaderName = "Webhook-Signature"

// HTTPTransport is the production Transport: net/http POSTs of the signed
// canonical envelope. Redirects are refused (3xx surfaces as a failure
// outcome, never a silent POST→GET conversion), and response bodies are
// drained (bounded) so keep-alive connections return to the pool.
type HTTPTransport struct {
	client *http.Client
}

// NewHTTPTransport wires the production transport over client (nil → a
// client with the no-redirect policy). The delivery context bounds every
// request — no separate client timeout is set.
func NewHTTPTransport(client *http.Client) *HTTPTransport {
	if client == nil {
		client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		}}
	}
	return &HTTPTransport{client: client}
}

// Deliver POSTs payload to endpointURL with the signature header attached,
// returning the HTTP status (meaningful only when err is nil — a transport
// failure returns 0 and the error).
func (t *HTTPTransport) Deliver(ctx context.Context, endpointURL, signatureHeader string, payload []byte) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpointURL, bytes.NewReader(payload))
	if err != nil {
		return 0, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(SignatureHeaderName, signatureHeader)
	req.Header.Set("User-Agent", "fuatilia-webhooks/1.0")
	resp, err := t.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
	return resp.StatusCode, nil
}
