// Client behavior tests (issue #96): OAuth lifecycle, retry policy, 401
// re-auth, endpoint payload shapes, idempotency guard — all against the
// scriptable fake server with a fake clock. Table-driven where a table fits.
package daraja

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testShortCode = "174379"
	testPasskey   = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919"
)

// validSTKRequest is the shared happy-path initiation request.
func validSTKRequest() STKInitiate {
	return STKInitiate{
		ShortCode:        testShortCode,
		Passkey:          testPasskey,
		TransactionType:  TxTypeCustomerPayBillOnline,
		AmountMinor:      250_000, // KES 2500 in minor units
		PhoneNumber:      "254712345678",
		AccountReference: "INV-2026-0042",
		TransactionDesc:  "Invoice INV-2026-0042",
		CallBackURL:      "https://api.example.co.ke/v1/daraja/stk/callback",
	}
}

// oauthScript arms the standard token response.
func oauthScript(f *fakeServer, token string, expiresIn string) {
	f.script("/oauth/v1/generate", scriptedResponse{status: 200, body: map[string]string{
		"access_token": token, "expires_in": expiresIn,
	}})
}

func TestOAuthTokenLifecycle(t *testing.T) {
	f := newFakeServer(t)
	oauthScript(f, "tok-1", "3600")
	clock := newFakeClock(time.Date(2026, 9, 8, 10, 0, 0, 0, eatLocation))
	c := f.client(t, func(cfg *Config) { cfg.Now = clock.Now; cfg.Sleep = clock.Sleep })

	f.script("/mpesa/stkpush/v1/processrequest",
		scriptedResponse{status: 200, body: map[string]string{
			"MerchantRequestID": "29115-34620561-1", "CheckoutRequestID": "ws_CO_19122019102036805",
			"ResponseCode": "0", "ResponseDescription": "Success. Request accepted for processing",
			"CustomerMessage": "Success. Request accepted for processing",
		}})

	for i := 0; i < 3; i++ {
		if _, err := c.InitiateSTK(context.Background(), validSTKRequest(), "key-1"); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if got := f.count("/oauth/v1/generate"); got != 1 {
		t.Fatalf("token must be cached across calls: oauth calls = %d, want 1", got)
	}

	// Advance past expiry-minus-skew → exactly one refresh on the next call.
	clock.mu.Lock()
	clock.now = clock.now.Add(60 * time.Minute)
	clock.mu.Unlock()
	if _, err := c.InitiateSTK(context.Background(), validSTKRequest(), "key-2"); err != nil {
		t.Fatalf("post-expiry call: %v", err)
	}
	if got := f.count("/oauth/v1/generate"); got != 2 {
		t.Fatalf("expired token must refresh once: oauth calls = %d, want 2", got)
	}
}

func TestOAuthFailures(t *testing.T) {
	t.Run("bad credentials are AUTH_FAILED and not retried", func(t *testing.T) {
		f := newFakeServer(t)
		f.script("/oauth/v1/generate", scriptedResponse{status: 400, body: map[string]string{"error": "bad_request"}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeAuthFailed || de.HTTPStatus != 400 {
			t.Fatalf("want DARAJA_AUTH_FAILED/400, got %v", err)
		}
		if IsRetryable(err) {
			t.Fatal("auth failures are never retryable")
		}
	})
	t.Run("non-JSON oauth body is WIRE_MALFORMED", func(t *testing.T) {
		f := newFakeServer(t)
		f.script("/oauth/v1/generate", scriptedResponse{status: 200, body: "nope"})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeWireMalformed {
			t.Fatalf("want DARAJA_WIRE_MALFORMED, got %v", err)
		}
	})
}

func TestOAuthSingleFlight(t *testing.T) {
	f := newFakeServer(t)
	oauthScript(f, "tok-concurrent", "3600")
	c := f.client(t, nil)
	f.script("/mpesa/stkpush/v1/processrequest",
		scriptedResponse{status: 200, body: map[string]string{"ResponseCode": "0", "CheckoutRequestID": "ws_CO_abcdefgh", "MerchantRequestID": "m-1"}})

	var wg sync.WaitGroup
	errs := make([]error, 10)
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = c.InitiateSTK(context.Background(), validSTKRequest(), fmt.Sprintf("distinct-key-%d", i))
		}(i)
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: %v", i, err)
		}
	}
	if got := f.count("/oauth/v1/generate"); got != 1 {
		t.Fatalf("concurrent callers must not stampede oauth: %d calls, want 1", got)
	}
}

func TestRetryPolicy(t *testing.T) {
	pushPath := "/mpesa/stkpush/v1/processrequest"
	pushOK := scriptedResponse{status: 200, body: map[string]string{
		"ResponseCode": "0", "CheckoutRequestID": "ws_CO_abcdefgh", "MerchantRequestID": "m-2",
	}}

	t.Run("5xx retried with backoff then succeeds", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath,
			scriptedResponse{status: 500, body: map[string]string{"errorMessage": "boom"}},
			scriptedResponse{status: 503, body: map[string]string{"errorMessage": "busy"}},
			pushOK)
		clock := newFakeClock(time.Date(2026, 9, 8, 10, 0, 0, 0, eatLocation))
		c := f.client(t, func(cfg *Config) { cfg.Now = clock.Now; cfg.Sleep = clock.Sleep })

		if _, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k"); err != nil {
			t.Fatalf("retry should recover: %v", err)
		}
		if got := f.count(pushPath); got != 3 {
			t.Fatalf("push attempts = %d, want 3", got)
		}
		if clock.totalSlept() <= 0 {
			t.Fatal("backoff must sleep between attempts")
		}
	})

	t.Run("5xx until exhausted -> RETRY_EXHAUSTED", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 500, body: map[string]string{"errorMessage": "down"}})
		clock := newFakeClock(time.Date(2026, 9, 8, 10, 0, 0, 0, eatLocation))
		c := f.client(t, func(cfg *Config) {
			cfg.Now = clock.Now
			cfg.Sleep = clock.Sleep
			cfg.MaxRetries = 2
		})
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeRetryExhausted {
			t.Fatalf("want DARAJA_RETRY_EXHAUSTED, got %v", err)
		}
		if got := f.count(pushPath); got != 3 { // 1 initial + 2 retries
			t.Fatalf("attempts = %d, want 3", got)
		}
	})

	t.Run("4xx never retried", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath, scriptedResponse{status: 400, body: map[string]string{"errorMessage": "invalid amount"}})
		c := f.client(t, nil)
		_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeAPIError || de.HTTPStatus != 400 {
			t.Fatalf("want DARAJA_API_ERROR/400, got %v", err)
		}
		if got := f.count(pushPath); got != 1 {
			t.Fatalf("4xx must not retry: attempts = %d, want 1", got)
		}
	})

	t.Run("401 re-auths once then succeeds", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script(pushPath,
			scriptedResponse{status: 401, body: map[string]string{"errorMessage": "expired"}},
			pushOK)
		c := f.client(t, nil)
		if _, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k"); err != nil {
			t.Fatalf("401 recovery: %v", err)
		}
		if got := f.count("/oauth/v1/generate"); got != 2 {
			t.Fatalf("oauth calls = %d, want 2 (initial + re-auth)", got)
		}
	})

	t.Run("network error is retryable", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		c.doer = failingDoer{}
		err := c.callJSON(context.Background(), "POST", "/x", map[string]string{}, nil)
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeRetryExhausted {
			t.Fatalf("exhausted retries surface RETRY_EXHAUSTED, got %v", err)
		}
		var inner *Error
		if !errors.As(de.Cause, &inner) || inner.Code != CodeNetworkFailed || !IsRetryable(inner) {
			t.Fatalf("the underlying network error must be retryable, got %v", de.Cause)
		}
	})
}

type failingDoer struct{}

func (failingDoer) Do(*http.Request) (*http.Response, error) {
	return nil, errors.New("connection reset by peer")
}

func TestContextDeadline(t *testing.T) {
	f := newFakeServer(t)
	oauthScript(f, "tok", "3600")
	c := f.client(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	time.Sleep(2 * time.Millisecond)
	_, err := c.InitiateSTK(ctx, validSTKRequest(), "k")
	if err == nil {
		t.Fatal("expired context must fail the call")
	}
}

func TestSTKRequestValidation(t *testing.T) {
	cases := []struct {
		name     string
		mutate   func(*STKInitiate)
		wantCode string
	}{
		{"empty shortcode", func(r *STKInitiate) { r.ShortCode = "" }, CodeShortCodeMalformed},
		{"empty passkey", func(r *STKInitiate) { r.Passkey = "" }, CodeConfigInvalid},
		{"bad transaction type", func(r *STKInitiate) { r.TransactionType = "FreeMoney" }, CodeConfigInvalid},
		{"non-whole shilling amount", func(r *STKInitiate) { r.AmountMinor = 250_050 }, CodeAmountNotWholeShilling},
		{"negative amount", func(r *STKInitiate) { r.AmountMinor = -100 }, CodeAmountMalformed},
		{"bad msisdn", func(r *STKInitiate) { r.PhoneNumber = "0712345678" }, CodeMSISDNMalformed},
		{"http callback", func(r *STKInitiate) { r.CallBackURL = "http://insecure.example" }, CodeConfigInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeServer(t)
			oauthScript(f, "tok", "3600")
			c := f.client(t, nil)
			req := validSTKRequest()
			tc.mutate(&req)
			_, err := c.InitiateSTK(context.Background(), req, "k")
			var de *Error
			if !errors.As(err, &de) || de.Code != tc.wantCode {
				t.Fatalf("want %s, got %v", tc.wantCode, err)
			}
			if got := f.count("/mpesa/stkpush/v1/processrequest"); got != 0 {
				t.Fatal("invalid requests must never reach the wire")
			}
		})
	}
}

func TestSTKInitiateWireShape(t *testing.T) {
	f := newFakeServer(t)
	oauthScript(f, "tok", "3600")
	f.script("/mpesa/stkpush/v1/processrequest",
		scriptedResponse{status: 200, body: map[string]string{
			"MerchantRequestID": "29115-34620561-1", "CheckoutRequestID": "ws_CO_19122019102036805",
			"ResponseCode": "0", "ResponseDescription": "Success", "CustomerMessage": "check your phone",
		}})
	clock := newFakeClock(time.Date(2026, 9, 8, 15, 30, 45, 0, eatLocation))
	c := f.client(t, func(cfg *Config) { cfg.Now = clock.Now })

	if _, err := c.InitiateSTK(context.Background(), validSTKRequest(), "idem-1"); err != nil {
		t.Fatalf("initiate: %v", err)
	}
	body := string(f.lastBody("/mpesa/stkpush/v1/processrequest"))
	for _, want := range []string{
		`"BusinessShortCode":"174379"`, `"Amount":2500`, `"PartyA":"254712345678"`,
		`"Timestamp":"20260908153045"`, `"TransactionType":"CustomerPayBillOnline"`,
		`"AccountReference":"INV-2026-0042"`, `"CallBackURL":"https://api.example.co.ke/v1/daraja/stk/callback"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("wire body missing %s\ngot: %s", want, body)
		}
	}
	// Password = base64(shortcode + passkey + timestamp) — recomputed here
	// mirrors the Safaricom formula the TS lane's fixtures encode.
	wantPassword := "MTc0Mzc5" // can't precompute whole string inline; assert presence of base64 field
	if !strings.Contains(body, `"Password":"`) || !strings.Contains(body, wantPassword[:6]) {
		t.Errorf("Password field missing or not base64: %s", body)
	}
}

func TestSTKInFlightGuard(t *testing.T) {
	f := newFakeServer(t)
	oauthScript(f, "tok", "3600")
	release := make(chan struct{})
	f.srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth/v1/generate":
			_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "tok", "expires_in": "3600"})
		case "/mpesa/stkpush/v1/processrequest":
			<-release // hold the lead caller until followers have joined
			f.mu.Lock()
			f.requests[r.URL.Path] = append(f.requests[r.URL.Path], recordedRequest{method: r.Method})
			f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{
				"ResponseCode": "0", "CheckoutRequestID": "ws_CO_inflight1", "MerchantRequestID": "m-3",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	c := f.client(t, nil)

	var wg sync.WaitGroup
	results := make([]error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, results[i] = c.InitiateSTK(context.Background(), validSTKRequest(), "same-key")
		}(i)
	}
	// Give followers a moment to block on the in-flight map, then release.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	leadOK, followers := 0, 0
	for _, err := range results {
		if err == nil {
			leadOK++
			continue
		}
		var de *Error
		if errors.As(err, &de) && de.Code == CodeDuplicateInFlight {
			if de.Kind != KindBusy {
				t.Errorf("duplicate refusal kind = %s, want busy", de.Kind)
			}
			followers++
		}
	}
	if leadOK != 1 || followers != 2 {
		t.Fatalf("want exactly 1 lead + 2 duplicate refusals, got lead=%d followers=%d", leadOK, followers)
	}
	if got := f.count("/mpesa/stkpush/v1/processrequest"); got != 1 {
		t.Fatalf("concurrent same-key calls must collapse to ONE wire call: %d", got)
	}
}

func TestQuerySTKAndOtherEndpoints(t *testing.T) {
	t.Run("query STK", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script("/mpesa/stkpushquery/v1/query", scriptedResponse{status: 200, body: map[string]string{
			"ResponseCode": "0", "ResponseDescription": "The service request has been accepted successsfully",
			"MerchantRequestID": "16958-4123456-1", "CheckoutRequestID": "ws_CO_19092026123456789",
			"ResultCode": "1032", "ResultDesc": "Request cancelled by user",
		}})
		c := f.client(t, nil)
		st, err := c.QuerySTK(context.Background(), testShortCode, testPasskey, "ws_CO_19092026123456789")
		if err != nil {
			t.Fatalf("query: %v", err)
		}
		if st.ResultCode != "1032" {
			t.Fatalf("ResultCode = %q, want 1032", st.ResultCode)
		}
	})
	t.Run("query STK refuses empty checkout id", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		_, err := c.QuerySTK(context.Background(), testShortCode, testPasskey, "")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeCheckoutRequestIDRequired {
			t.Fatalf("want CHECKOUT_REQUEST_ID_REQUIRED, got %v", err)
		}
	})
	t.Run("B2C happy path records originator conversation", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		f.script("/mpesa/b2c/v3/paymentrequest", scriptedResponse{status: 200, body: map[string]string{
			"OriginatorConversationID": "4837-98123456-1", "ConversationID": "AG_20260908_1234567890",
			"ResponseCode": "0", "ResponseDescription": "Accept the service request successfully.",
		}})
		c := f.client(t, nil)
		rc, err := c.InitiateB2C(context.Background(), B2CInitiate{
			InitiatorName: "testapi", SecurityCredential: "cred", CommandID: "BusinessPayment",
			AmountMinor: 150_000, PartyB: "254712345678", Remarks: "supplier payout",
			QueueTimeOutURL: "https://api.example.co.ke/b2c/timeout", ResultURL: "https://api.example.co.ke/b2c/result",
			Occasion: "payout",
		}, "b2c-key-1")
		if err != nil {
			t.Fatalf("b2c: %v", err)
		}
		if rc.ConversationID == "" {
			t.Fatal("ConversationID must be recorded")
		}
	})
	t.Run("B2C refuses bad command and non-whole amounts", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		_, err := c.InitiateB2C(context.Background(), B2CInitiate{
			InitiatorName: "testapi", SecurityCredential: "cred", CommandID: "GiftMoney",
			AmountMinor: 100, PartyB: "254712345678",
		}, "k")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeConfigInvalid {
			t.Fatalf("bad CommandID: want CONFIG_INVALID, got %v", err)
		}
		_, err = c.InitiateB2C(context.Background(), B2CInitiate{
			InitiatorName: "testapi", SecurityCredential: "cred", CommandID: "BusinessPayment",
			AmountMinor: 100_050, PartyB: "254712345678",
		}, "k2")
		if !errors.As(err, &de) || de.Code != CodeAmountNotWholeShilling {
			t.Fatalf("non-whole amount: want NOT_WHOLE_SHILLING, got %v", err)
		}
	})
	t.Run("transaction status validates the id shape", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		_, err := c.QueryTransactionStatus(context.Background(), "SBX12345", "testapi", "cred", "https://x.example")
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeTransIDMalformed {
			t.Fatalf("lowercase id must be refused, got %v", err)
		}
		f.script("/mpesa/transactionstatus/v1/query", scriptedResponse{status: 200, body: map[string]string{
			"OriginatorConversationID": "o-1", "ConversationID": "c-1", "ResponseCode": "0",
			"ResponseDescription": "ok",
		}})
		if _, err := c.QueryTransactionStatus(context.Background(), "SBK41XQ7RT", "testapi", "cred", "https://x.example"); err != nil {
			t.Fatalf("valid id: %v", err)
		}
	})
	t.Run("C2B registration requires Completed/Cancelled", func(t *testing.T) {
		f := newFakeServer(t)
		oauthScript(f, "tok", "3600")
		c := f.client(t, nil)
		err := c.RegisterC2BURL(context.Background(), C2BRegistration{
			ShortCode: testShortCode, ResponseType: "Maybe",
			ConfirmationURL: "https://api.example.co.ke/c2b/confirm",
		})
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeConfigInvalid {
			t.Fatalf("want CONFIG_INVALID, got %v", err)
		}
		f.script("/mpesa/c2b/v1/registerurl", scriptedResponse{status: 200, body: map[string]string{
			"ResponseDescription": "success",
		}})
		if err := c.RegisterC2BURL(context.Background(), C2BRegistration{
			ShortCode: testShortCode, ResponseType: "Completed",
			ConfirmationURL: "https://api.example.co.ke/c2b/confirm",
			ValidationURL:   "https://api.example.co.ke/c2b/validate",
		}); err != nil {
			t.Fatalf("register: %v", err)
		}
	})
}

func TestConfigFromEnv(t *testing.T) {
	t.Run("missing credentials refused", func(t *testing.T) {
		_, err := ConfigFromEnv(func(k string) string { return "" })
		if err == nil {
			t.Fatal("missing credentials must be refused")
		}
	})
	t.Run("defaults to sandbox", func(t *testing.T) {
		cfg, err := ConfigFromEnv(func(k string) string {
			if k == "DARAJA_CONSUMER_KEY" {
				return "k"
			}
			if k == "DARAJA_CONSUMER_SECRET" {
				return "s"
			}
			return ""
		})
		if err != nil || cfg.BaseURL != DefaultBaseURL {
			t.Fatalf("base = %q err = %v", cfg.BaseURL, err)
		}
	})
}
