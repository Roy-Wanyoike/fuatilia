// Error-taxonomy tests (issue #84, AC7): every *Error carries a coarse
// machine-readable Kind next to its stable DARAJA_* code, and rejected wire
// responses map Daraja's own errorCode/errorMessage onto that taxonomy.
package daraja

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func mustAPIError(t *testing.T, err error) *Error {
	t.Helper()
	de, ok := err.(*Error)
	if !ok {
		t.Fatalf("want *daraja.Error, got %v", err)
	}
	return de
}

func TestKindForCodeIsTotal(t *testing.T) {
	t.Parallel()
	want := map[string]ErrorKind{
		CodePayloadUnrecognized:     KindValidation,
		CodeTransIDMalformed:        KindValidation,
		CodeTransTimeMalformed:      KindValidation,
		CodeResultCodeInvalid:       KindValidation,
		CodeSTKMetadataMalformed:    KindValidation,
		CodeB2CResultMalformed:      KindValidation,
		CodeAmountRequired:          KindMoney,
		CodeAmountMalformed:         KindMoney,
		CodeAmountNotWholeShilling:  KindMoney,
		CodeSTKAmountUnknown:        KindMoney,
		CodeDuplicateAmountMismatch: KindMoney,
		CodeConfigInvalid:           KindConfig,
		CodeC2BKindRequired:         KindConfig,
		CodeAuthFailed:              KindAuth,
		CodeNetworkFailed:           KindNetwork,
		CodeLedgerUnavailable:       KindNetwork,
		CodeDeadlineExceeded:        KindTimeout,
		CodeAPIError:                KindUpstream,
		CodeRetryExhausted:          KindUpstream,
		CodeWireMalformed:           KindUpstream,
		CodeDuplicateInFlight:       KindBusy,
	}
	for code, kind := range want {
		if got := kindForCode(code); got != kind {
			t.Errorf("kindForCode(%s) = %s, want %s", code, got, kind)
		}
	}
	// A code this package grows later still lands IN the taxonomy: the
	// default is the dead-letter kind, never an empty string.
	if got := kindForCode("DARAJA_SOMETHING_NEW"); got != KindValidation {
		t.Errorf("unknown code must default to validation, got %q", got)
	}
}

func TestUpstreamErrorTaxonomy(t *testing.T) {
	t.Parallel()
	pushPath := "/mpesa/stkpush/v1/processrequest"

	t.Run("400.* errorCode is validation, upstream code preserved", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 400, body: map[string]string{
			"errorCode": "400.008.01", "errorMessage": "invalid amount",
		}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		de := mustAPIError(t, err)
		if de.Code != CodeAPIError || de.HTTPStatus != 400 {
			t.Fatalf("code/status = %s/%d", de.Code, de.HTTPStatus)
		}
		if de.Kind != KindValidation {
			t.Fatalf("kind = %s, want validation", de.Kind)
		}
		if de.UpstreamCode != "400.008.01" {
			t.Fatalf("upstream code = %q", de.UpstreamCode)
		}
		if !strings.Contains(de.Message, "invalid amount") {
			t.Fatalf("errorMessage must surface for logs: %q", de.Message)
		}
	})

	t.Run("401.* errorCode is auth even on a 400 status", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 400, body: map[string]string{
			"errorCode": "401.001.03", "errorMessage": "bad initiator",
		}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		if de := mustAPIError(t, err); de.Kind != KindAuth {
			t.Fatalf("kind = %s, want auth", de.Kind)
		}
	})

	t.Run("5* errorCode is upstream, through the whole retry ladder", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 500, body: map[string]string{
			"errorCode": "500.001.1001", "errorMessage": "internal error",
		}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		de := mustAPIError(t, err)
		if de.Code != CodeRetryExhausted || de.Kind != KindUpstream {
			t.Fatalf("code/kind = %s/%s, want retry_exhausted/upstream", de.Code, de.Kind)
		}
		// The terminal wire error keeps the taxonomy: upstream + retryable.
		var inner *Error
		if !errors.As(de.Cause, &inner) || inner.Kind != KindUpstream || !inner.Retryable {
			t.Fatalf("cause = %v, want upstream/retryable", de.Cause)
		}
		if inner.UpstreamCode != "500.001.1001" {
			t.Fatalf("upstream code = %q", inner.UpstreamCode)
		}
	})

	t.Run("5xx without errorCode falls back to status", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 503, body: "service unavailable"})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		if de := mustAPIError(t, err); de.Kind != KindUpstream {
			t.Fatalf("kind = %s, want upstream", de.Kind)
		}
	})

	t.Run("4xx without errorCode falls back to validation", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 422, body: map[string]string{"unparsed": "junk"}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		if de := mustAPIError(t, err); de.Kind != KindValidation {
			t.Fatalf("kind = %s, want validation", de.Kind)
		}
	})

	t.Run("oauth refusal is auth", func(t *testing.T) {
		f := newFakeServer(t)
		f.script("/oauth/v1/generate", scriptedResponse{status: 400, body: map[string]string{"error": "bad_request"}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		if de := mustAPIError(t, err); de.Code != CodeAuthFailed || de.Kind != KindAuth {
			t.Fatalf("code/kind = %s/%s, want auth_failed/auth", de.Code, de.Kind)
		}
	})
}

func TestParsedErrorKinds(t *testing.T) {
	t.Parallel()
	t.Run("client misconfiguration is config", func(t *testing.T) {
		_, err := NewClient(nil, Config{})
		if de := mustAPIError(t, err); de.Kind != KindConfig {
			t.Fatalf("kind = %s, want config", de.Kind)
		}
	})
	t.Run("junk callback payload is validation", func(t *testing.T) {
		_, err := ParseCallback([]byte(`{}`), ParseOptions{})
		if de := mustAPIError(t, err); de.Kind != KindValidation {
			t.Fatalf("kind = %s, want validation", de.Kind)
		}
	})
	t.Run("money-boundary refusal is money", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		req := validSTKRequest()
		req.AmountMinor = 250_050 // not whole shillings — refused before any wire call
		_, err := c.InitiateSTK(context.Background(), req, "k")
		if de := mustAPIError(t, err); de.Kind != KindMoney || de.Code != CodeAmountNotWholeShilling {
			t.Fatalf("code/kind = %s/%s, want money", de.Code, de.Kind)
		}
	})
}
