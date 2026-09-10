// Resilience and exactly-once discipline tests (issue #84): calendar
// rollover refusal at the K1 boundary, 401 re-auth EXACTLY-once, deadline
// expiry during backoff, and a junk-input corpus that must never panic.
package daraja

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestTransTimeCalendarRolloverRefusal(t *testing.T) {
	t.Parallel()
	// Feb 30, Feb 29 of a non-leap year, Apr 31, second 60, month 13, and a
	// non-digit: none may silently roll into the next real instant — a
	// rewritten timestamp is a rewritten fact about WHEN money moved.
	for _, bad := range []string{
		"20260230101530", // Feb 30 → would roll to Mar 2
		"20260229010101", // 2026 is not a leap year
		"20250431235959", // Apr 31 → would roll to May 1
		"20260101235960", // second 60
		"20261301000000", // month 13
		"2025091214301a", // non-digit tail
	} {
		_, err := transTimeToDate(bad)
		de, ok := err.(*Error)
		if !ok || de.Code != CodeTransTimeMalformed {
			t.Errorf("transTimeToDate(%q) = %v, want DARAJA_TRANS_TIME_MALFORMED", bad, err)
		}
	}
	// End-to-end: a C2B payload carrying Feb 30 is refused, not rolled.
	p := c2bPayload()
	p["TransTime"] = "20260230101530"
	wantCode(t, p, ParseOptions{C2BKind: KindC2BConfirm}, CodeTransTimeMalformed)
	// Control: a real instant still decodes as EAT wall-clock.
	got, err := transTimeToDate("20260908101530")
	if err != nil || !got.Equal(time.Date(2026, 9, 8, 10, 15, 30, 0, eatLocation)) {
		t.Fatalf("valid TransTime = %v, %v", got, err)
	}
}

func TestDoubleUnauthorizedReauthsExactlyOnce(t *testing.T) {
	t.Parallel()
	pushPath := "/mpesa/stkpush/v1/processrequest"
	f := newFakeServer(t)
	oauthScript(f, "tok-1", "3600")
	f.script(pushPath,
		scriptedResponse{status: 401, body: map[string]string{"errorMessage": "token expired"}},
		scriptedResponse{status: 401, body: map[string]string{"errorMessage": "token revoked"}})
	c := f.client(t, nil)

	_, err := c.InitiateSTK(context.Background(), validSTKRequest(), "k")
	de := mustAPIError(t, err)
	if de.Code != CodeAuthFailed || de.Kind != KindAuth {
		t.Fatalf("code/kind = %s/%s, want auth_failed/auth", de.Code, de.Kind)
	}
	if IsRetryable(err) {
		t.Fatal("auth failure after the one re-auth must not be retryable")
	}
	if got := f.count(pushPath); got != 2 {
		t.Fatalf("push attempts = %d, want exactly the two 401s", got)
	}
	if got := f.count("/oauth/v1/generate"); got != 2 {
		t.Fatalf("oauth calls = %d, want 2 (initial + EXACTLY ONE re-auth)", got)
	}
}

func TestDeadlineExpiryDuringBackoff(t *testing.T) {
	t.Parallel()
	pushPath := "/mpesa/stkpush/v1/processrequest"
	f := newFakeServer(t)
	oauthScript(f, "tok", "3600")
	f.script(pushPath, scriptedResponse{status: 500, body: map[string]string{"errorMessage": "down"}})
	c := f.client(t, func(cfg *Config) {
		// Park in backoff until the caller's deadline dies — deterministic,
		// no real sleeping.
		cfg.Sleep = func(ctx context.Context, _ time.Duration) error {
			<-ctx.Done()
			return ctx.Err()
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()

	_, err := c.InitiateSTK(ctx, validSTKRequest(), "k")
	de := mustAPIError(t, err)
	if de.Code != CodeDeadlineExceeded || de.Kind != KindTimeout {
		t.Fatalf("code/kind = %s/%s, want deadline_exceeded/timeout", de.Code, de.Kind)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cause must be the context deadline, got %v", err)
	}
	if got := f.count(pushPath); got != 1 {
		t.Fatalf("push attempts = %d, want 1 (the deadline died in backoff)", got)
	}
}

// parseNoPanic runs ParseCallback with panic capture: a panic IS the bug the
// corpus exists to catch, surfaced as a normal error for the assertions.
func parseNoPanic(raw []byte, opts ParseOptions) (parsed ParsedCallback, err error) {
	defer func() {
		if r := recover(); r != nil {
			parsed, err = nil, fmt.Errorf("PANIC in ParseCallback: %v", r)
		}
	}()
	return ParseCallback(raw, opts)
}

// intakeNoPanic runs the R9 funnel with panic capture (same deal).
func intakeNoPanic(cb ParsedCallback) (out IntakeOutcome, err error) {
	defer func() {
		if r := recover(); r != nil {
			out, err = IntakeOutcome{}, fmt.Errorf("PANIC in IntakeCallback: %v", r)
		}
	}()
	return IntakeCallback(context.Background(), NewMemLedger(), cb, IntakeHooks{})
}

// junkCorpus is wire-shaped garbage + edge shapes, drawn from every family:
// non-JSON, wrong JSON types at every field, numbers out of range, calendar
// junk, unicode, deep nesting. Valid edge rows (trailing) prove the corpus
// harness exercises the full parse → intake path too.
func junkCorpus() []struct {
	name    string
	payload string
} {
	deep := `{` + strings.Repeat(`"a":{`, 300) + `"x":1` + strings.Repeat(`}`, 300) + `}`
	rows := []struct {
		name    string
		payload string
	}{
		{"empty body", ``},
		{"whitespace body", `   `},
		{"JSON null", `null`},
		{"JSON number", `42`},
		{"JSON string", `"payment received, promise"`},
		{"JSON array", `[]`},
		{"truncated object", `{"Body":`},
		{"broken syntax", `{"Body":}`},
		{"Body null", `{"Body":null}`},
		{"Body empty object", `{"Body":{}}`},
		{"stkCallback null", `{"Body":{"stkCallback":null}}`},
		{"stk empty callback", `{"Body":{"stkCallback":{}}}`},
		{"stk result code out of float range", `{"Body":{"stkCallback":{"MerchantRequestID":"m-1","CheckoutRequestID":"ws_CO_123456","ResultCode":1e999,"ResultDesc":"x"}}}`},
		{"stk metadata Amount object", `{"Body":{"stkCallback":{"MerchantRequestID":"m-1","CheckoutRequestID":"ws_CO_123456","ResultCode":0,"ResultDesc":"x","CallbackMetadata":{"Item":[{"Name":"Amount","Value":{"deep":true}}]}}}}`},
		{"stk metadata item null", `{"Body":{"stkCallback":{"MerchantRequestID":"m-1","CheckoutRequestID":"ws_CO_123456","ResultCode":0,"ResultDesc":"x","CallbackMetadata":{"Item":[{"Name":"Amount","Value":"1"},null]}}}}`},
		{"stk metadata Item not array", `{"Body":{"stkCallback":{"MerchantRequestID":"m-1","CheckoutRequestID":"ws_CO_123456","ResultCode":0,"ResultDesc":"x","CallbackMetadata":{"Item":{"Name":"Amount"}}}}}`},
		{"c2b TransID object", `{"TransID":{"a":1},"TransTime":"20260908101530","TransAmount":"1","BusinessShortCode":"174379","MSISDN":"254712345678"}`},
		{"c2b TransTime number", `{"TransID":"SBK41XQ7RT","TransTime":20260908101530,"TransAmount":"1","BusinessShortCode":"174379","MSISDN":"254712345678"}`},
		{"c2b TransAmount array", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":[2500],"BusinessShortCode":"174379","MSISDN":"254712345678"}`},
		{"c2b short code number", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":"2500","BusinessShortCode":174379,"MSISDN":"254712345678"}`},
		{"c2b MSISDN bool", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":"2500","BusinessShortCode":"174379","MSISDN":true}`},
		{"c2b BillRefNumber object", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":"2500","BusinessShortCode":"174379","MSISDN":"254712345678","BillRefNumber":{"a":1}}`},
		{"c2b OrgAccountBalance array", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":"2500","BusinessShortCode":"174379","MSISDN":"254712345678","OrgAccountBalance":[1]}`},
		{"c2b amount overflow", `{"TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":"999999999999999999999999999999999999999999999999999999.99","BusinessShortCode":"174379","MSISDN":"254712345678"}`},
		{"c2b unicode TransID", `{"TransID":"🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀","TransTime":"20260908101530","TransAmount":"2500","BusinessShortCode":"174379","MSISDN":"254712345678"}`},
		{"b2c ResultType string", `{"ResultType":"0","ResultCode":0,"ResultDesc":"x","ConversationID":"c-1","OriginatorConversationID":"o-1","TransactionID":"RKT81KZ9QF"}`},
		{"b2c ConversationID number", `{"ResultType":0,"ResultCode":0,"ResultDesc":"x","ConversationID":1,"OriginatorConversationID":"o-1","TransactionID":"RKT81KZ9QF"}`},
		{"b2c TransactionID number", `{"ResultType":0,"ResultCode":0,"ResultDesc":"x","ConversationID":"c-1","OriginatorConversationID":"o-1","TransactionID":1234567890}`},
		{"b2c ResultParameter null", `{"ResultType":0,"ResultCode":0,"ResultDesc":"x","ConversationID":"c-1","OriginatorConversationID":"o-1","TransactionID":"RKT81KZ9QF","ResultParameters":{"ResultParameter":null}}`},
		{"b2c TransactionAmount object", `{"ResultType":0,"ResultCode":0,"ResultDesc":"x","ConversationID":"c-1","OriginatorConversationID":"o-1","TransactionID":"RKT81KZ9QF","ResultParameters":{"ResultParameter":[{"Name":"TransactionAmount","Value":{"a":1}}]}}`},
		{"deep nesting", deep},
		// Valid edge rows: the corpus also feeds the intake funnel with
		// anything that parses (trimmed amounts, numeric receipt/phone,
		// deduped invoice refs) — the whole path must stay panic-free.
		{"valid c2b trimmed + dup invoice", `{"TransactionType":"Pay Bill","TransID":"SBK41XQ7RT","TransTime":"20260908101530","TransAmount":" 2500.00 ","BusinessShortCode":"174379","BillRefNumber":"INV-1,INV-1","InvoiceNumber":"INV-1","MSISDN":"254712345678"}`},
		{"valid stk numeric receipt/phone", `{"Body":{"stkCallback":{"MerchantRequestID":"29115-1","CheckoutRequestID":"ws_CO_123456","ResultCode":0,"ResultDesc":"ok","CallbackMetadata":{"Item":[{"Name":"Amount","Value":"2500"},{"Name":"MpesaReceiptNumber","Value":1234567890},{"Name":"TransactionDate","Value":"20260908101610"},{"Name":"PhoneNumber","Value":254712345678}]}}}}`},
		{"valid b2c", `{"ResultType":0,"ResultCode":0,"ResultDesc":"ok","ConversationID":"c-1","OriginatorConversationID":"o-1","TransactionID":"RKT81KZ9QF","ResultParameters":{"ResultParameter":[{"Name":"TransactionAmount","Value":1500}]}}`},
	}
	return rows
}

func TestJunkInputCorpusNeverPanics(t *testing.T) {
	t.Parallel()
	optionSets := []ParseOptions{
		{},
		{C2BKind: KindC2BValidation},
		{C2BKind: KindC2BConfirm},
		{C2BKind: KindC2BConfirm, STKRequested: map[string]int64{"ws_CO_123456": 100}},
	}
	for _, row := range junkCorpus() {
		for i, opts := range optionSets {
			parsed, err := parseNoPanic([]byte(row.payload), opts)
			if err != nil {
				if strings.Contains(err.Error(), "PANIC") {
					t.Errorf("%s [opts %d]: %v", row.name, i, err)
					continue
				}
				de, ok := err.(*Error)
				if !ok {
					t.Errorf("%s [opts %d]: refused WITHOUT a coded error: %v", row.name, i, err)
					continue
				}
				if !strings.HasPrefix(de.Code, "DARAJA_") || de.Kind == "" {
					t.Errorf("%s [opts %d]: refusal %s/%s is outside the taxonomy", row.name, i, de.Code, de.Kind)
				}
				continue
			}
			// Parsed: the R9 funnel must take it without panic and land a verdict.
			outcome, ierr := intakeNoPanic(parsed)
			if ierr != nil {
				if strings.Contains(ierr.Error(), "PANIC") {
					t.Errorf("%s [opts %d]: %v", row.name, i, ierr)
					continue
				}
				t.Errorf("%s [opts %d]: valid parse then funnel error: %v", row.name, i, ierr)
				continue
			}
			switch outcome.Outcome {
			case OutcomeAccepted, OutcomeDuplicate, OutcomeAcknowledged, OutcomeObserved, OutcomeRejected:
			default:
				t.Errorf("%s [opts %d]: verdict %q is outside the ledger vocabulary", row.name, i, outcome.Outcome)
			}
		}
	}
}
