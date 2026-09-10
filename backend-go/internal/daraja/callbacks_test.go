// Callback boundary tests (issue #96): every malformed row promises the
// exact DARAJA_* code the parser must refuse it with — mirroring the TS
// fixture corpus (src/adapters/daraja/fixtures/) one-for-one.
package daraja

import (
	"encoding/json"
	"testing"
	"time"
)

// c2bPayload builds a valid Pay Bill confirmation (TS fixture parity:
// synthetic Kenyan-realistic data, amounts as decimal STRINGS).
func c2bPayload() map[string]any {
	return map[string]any{
		"TransactionType":   "Pay Bill",
		"TransID":           "SBK41XQ7RT",
		"TransTime":         "20260908101530",
		"TransAmount":       "2500.00",
		"BusinessShortCode": "174379",
		"BillRefNumber":     "INV-2026-0042",
		"OrgAccountBalance": "150200.00",
		"MSISDN":            "254712345678",
		"InvoiceNumber":     "",
		"ThirdPartyTransID": "",
	}
}

func stkSuccessPayload() map[string]any {
	return map[string]any{
		"Body": map[string]any{
			"stkCallback": map[string]any{
				"MerchantRequestID": "29115-34620561-1",
				"CheckoutRequestID": "ws_CO_19122019102036805",
				"ResultCode":        0,
				"ResultDesc":        "The service request is processed successfully.",
				"CallbackMetadata": map[string]any{
					"Item": []any{
						map[string]any{"Name": "Amount", "Value": 2500.0},
						map[string]any{"Name": "MpesaReceiptNumber", "Value": "SBK41XQ7RT"},
						map[string]any{"Name": "Balance"},
						map[string]any{"Name": "TransactionDate", "Value": "20260908101610"},
						map[string]any{"Name": "PhoneNumber", "Value": "254712345678"},
					},
				},
			},
		},
	}
}

func b2cSuccessPayload() map[string]any {
	return map[string]any{
		"ResultType":               0,
		"ResultCode":               0,
		"ResultDesc":               "The service request is processed successfully.",
		"ConversationID":           "AG_20260908_1234567890abcdef",
		"OriginatorConversationID": "4837-98123456-1",
		"TransactionID":            "SBK77YZQ9X",
		"ResultParameters": map[string]any{
			"ResultParameter": []any{
				map[string]any{"Name": "TransactionAmount", "Value": 1500.0},
				map[string]any{"Name": "TransactionReceipt", "Value": "SBK77YZQ9X"},
				map[string]any{"Name": "B2CRecipientIsRegisteredCustomer", "Value": "Y"},
			},
		},
	}
}

func mustParse(t *testing.T, payload map[string]any, opts ParseOptions) any {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	parsed, err := ParseCallback(raw, opts)
	if err != nil {
		t.Fatalf("ParseCallback refused a VALID payload: %v", err)
	}
	return parsed
}

func wantCode(t *testing.T, payload map[string]any, opts ParseOptions, code string) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, perr := ParseCallback(raw, opts)
	de, ok := perr.(*Error)
	if !ok || de.Code != code {
		t.Fatalf("want %s, got %v", code, perr)
	}
}

func TestParseC2BHappyPaths(t *testing.T) {
	t.Parallel()
	for _, kind := range []CallbackKind{KindC2BValidation, KindC2BConfirm} {
		parsed := mustParse(t, c2bPayload(), ParseOptions{C2BKind: kind})
		c2b, ok := parsed.(ParsedC2bCallback)
		if !ok {
			t.Fatalf("kind %s: wrong shape %T", kind, parsed)
		}
		if c2b.JourneyKey != "c2b:SBK41XQ7RT" {
			t.Errorf("journeyKey = %q", c2b.JourneyKey)
		}
		if c2b.AmountMinor != 250_000 {
			t.Errorf("amount minor = %d, want 250000", c2b.AmountMinor)
		}
		if c2b.TransTime != time.Date(2026, 9, 8, 10, 15, 30, 0, eatLocation) {
			t.Errorf("TransTime = %v (must decode as EAT)", c2b.TransTime)
		}
		if len(c2b.DeclaredRefs) != 1 || c2b.DeclaredRefs[0] != "INV-2026-0042" {
			t.Errorf("DeclaredRefs = %v", c2b.DeclaredRefs)
		}
	}
}

func TestParseC2BRefSplitting(t *testing.T) {
	t.Parallel()
	p := c2bPayload()
	p["BillRefNumber"] = "INV-1 / INV-2,INV-3"
	c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
	if len(c2b.DeclaredRefs) != 3 {
		t.Fatalf("DeclaredRefs = %v, want 3 refs (split on / and ,)", c2b.DeclaredRefs)
	}
}

func TestParseC2BMalformedCorpus(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"missing TransID", func(p map[string]any) { delete(p, "TransID") }, CodeTransIDRequired},
		{"lowercase TransID", func(p map[string]any) { p["TransID"] = "sbk41xq7rt" }, CodeTransIDMalformed},
		{"short TransID", func(p map[string]any) { p["TransID"] = "SB123" }, CodeTransIDMalformed},
		{"missing TransTime", func(p map[string]any) { delete(p, "TransTime") }, CodeTransTimeMalformed},
		{"garbage TransTime", func(p map[string]any) { p["TransTime"] = "2026-09-08 10:15" }, CodeTransTimeMalformed},
		{"impossible month", func(p map[string]any) { p["TransTime"] = "20261308101530" }, CodeTransTimeMalformed},
		{"missing amount", func(p map[string]any) { delete(p, "TransAmount") }, CodeAmountRequired},
		{"empty amount string", func(p map[string]any) { p["TransAmount"] = "" }, CodeAmountRequired},
		{"whitespace amount", func(p map[string]any) { p["TransAmount"] = "   " }, CodeAmountMalformed},
		{"non-numeric amount", func(p map[string]any) { p["TransAmount"] = "many" }, CodeAmountMalformed},
		{"negative amount", func(p map[string]any) { p["TransAmount"] = "-2500.00" }, CodeAmountMalformed},
		{"overflow amount", func(p map[string]any) { p["TransAmount"] = "99999999999999999999999.00" }, CodeAmountMalformed},
		{"leading-zero amount", func(p map[string]any) { p["TransAmount"] = "02500" }, CodeAmountMalformed},
		{"dangling-point amount", func(p map[string]any) { p["TransAmount"] = "2500." }, CodeAmountMalformed},
		{"bare-fraction amount", func(p map[string]any) { p["TransAmount"] = ".50" }, CodeAmountMalformed},
		{"bad shortcode", func(p map[string]any) { p["BusinessShortCode"] = "1234" }, CodeShortCodeMalformed},
		{"bad msisdn", func(p map[string]any) { p["MSISDN"] = "0712345678" }, CodeMSISDNMalformed},
		{"bill ref not string|number", func(p map[string]any) { p["BillRefNumber"] = []any{"x"} }, CodeBillRefMalformed},
		{"bad org balance", func(p map[string]any) { p["OrgAccountBalance"] = "abc" }, CodeAmountMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := c2bPayload()
			tc.mutate(p)
			wantCode(t, p, ParseOptions{C2BKind: KindC2BConfirm}, tc.want)
		})
	}
	t.Run("c2b without endpoint hint", func(t *testing.T) {
		wantCode(t, c2bPayload(), ParseOptions{}, CodeC2BKindRequired)
	})
	t.Run("non-JSON payload", func(t *testing.T) {
		if _, err := ParseCallback([]byte("<xml/>"), ParseOptions{}); err == nil {
			t.Fatal("non-JSON must be refused")
		}
	})
	t.Run("unrecognized shape", func(t *testing.T) {
		wantCode(t, map[string]any{"hello": "world"}, ParseOptions{}, CodePayloadUnrecognized)
	})
}

func TestParseSTKSuccess(t *testing.T) {
	t.Parallel()
	parsed := mustParse(t, stkSuccessPayload(), ParseOptions{}).(ParsedSTKCallback)
	if !parsed.Success || parsed.ResultCode != 0 {
		t.Fatalf("success state wrong: %+v", parsed)
	}
	if parsed.JourneyKey != "stk:ws_CO_19122019102036805" {
		t.Errorf("journeyKey = %q", parsed.JourneyKey)
	}
	if parsed.PaidMinor != 250_000 || !parsed.HasPaid {
		t.Errorf("PaidMinor = %d/%v, want 250000 (KES 2500)", parsed.PaidMinor, parsed.HasPaid)
	}
	if parsed.ReceiptNumber != "SBK41XQ7RT" {
		t.Errorf("receipt = %q", parsed.ReceiptNumber)
	}
	if !parsed.HasTransTime || !parsed.TransTime.Equal(time.Date(2026, 9, 8, 10, 16, 10, 0, eatLocation)) {
		t.Errorf("TransTime = %v", parsed.TransTime)
	}
	if parsed.MSISDN != "254712345678" {
		t.Errorf("msisdn = %q", parsed.MSISDN)
	}
	if parsed.AmountMinor != 250_000 {
		t.Errorf("intake amount = %d, want the paid amount", parsed.AmountMinor)
	}
}

func TestParseSTKFailureFamilies(t *testing.T) {
	t.Parallel()
	requested := map[string]int64{"ws_CO_12092025151022104": 250_000, "ws_CO_12092025152140505": 250_000}
	cases := []struct {
		code       float64
		checkout   string
		wantFamily string
	}{
		{1, "ws_CO_12092025151022104", "STK_USER_CANCELLED"},
		{2, "ws_CO_12092025151022104", "STK_TIMEOUT"},
		{1032, "ws_CO_12092025151022104", "STK_CANCELLED_BY_USER"},
		{1037, "ws_CO_12092025152140505", "STK_UNREACHABLE"},
		{1001, "ws_CO_12092025151022104", "STK_RESULT_1001"}, // unknown fails closed
		{2001, "ws_CO_12092025151022104", "STK_RESULT_2001"},
	}
	for _, tc := range cases {
		p := stkSuccessPayload()
		cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
		cb["CheckoutRequestID"] = tc.checkout // the map keys by the payload's own id
		cb["ResultCode"] = tc.code
		cb["ResultDesc"] = "failure"
		delete(cb, "CallbackMetadata")
		parsed := mustParse(t, p, ParseOptions{STKRequested: requested}).(ParsedSTKCallback)
		if parsed.Success {
			t.Fatalf("code %v parsed as success", tc.code)
		}
		if parsed.FailureCode != tc.wantFamily {
			t.Errorf("code %v → %q, want %q", tc.code, parsed.FailureCode, tc.wantFamily)
		}
		if parsed.AmountMinor != 250_000 {
			t.Errorf("code %v: intake amount = %d, want the initiation record", tc.code, parsed.AmountMinor)
		}
	}
}

func TestParseSTKMalformedCorpus(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"missing merchant request id", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			delete(cb, "MerchantRequestID")
		}, CodePayloadUnrecognized},
		{"missing checkout id", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			delete(cb, "CheckoutRequestID")
		}, CodeCheckoutRequestIDRequired},
		{"malformed checkout id", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["CheckoutRequestID"] = "ws_CO_short"
		}, CodeCheckoutRequestIDMalform},
		{"negative result code", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["ResultCode"] = -1
		}, CodeResultCodeInvalid},
		{"missing result desc", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			delete(cb, "ResultDesc")
		}, CodePayloadUnrecognized},
		{"success without metadata", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			delete(cb, "CallbackMetadata")
		}, CodeSTKMetadataMalformed},
		{"metadata item without name", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["CallbackMetadata"] = map[string]any{"Item": []any{map[string]any{"Value": 2500.0}}}
		}, CodeSTKMetadataMalformed},
		{"success without Amount item", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["CallbackMetadata"] = map[string]any{"Item": []any{
				map[string]any{"Name": "MpesaReceiptNumber", "Value": "SBK41XQ7RT"},
			}}
		}, CodeSTKMetadataMalformed},
		{"bad receipt number", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["CallbackMetadata"] = map[string]any{"Item": []any{
				map[string]any{"Name": "Amount", "Value": "2500"},
				map[string]any{"Name": "MpesaReceiptNumber", "Value": "not valid!"},
			}}
		}, CodeSTKMetadataMalformed},
		{"bad metadata phone", func(p map[string]any) {
			cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
			cb["CallbackMetadata"] = map[string]any{"Item": []any{
				map[string]any{"Name": "Amount", "Value": "2500"},
				map[string]any{"Name": "MpesaReceiptNumber", "Value": "SBK41XQ7RT"},
				map[string]any{"Name": "PhoneNumber", "Value": "12345"},
			}}
		}, CodeMSISDNMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := stkSuccessPayload() // fresh per case: mutations must not leak
			tc.mutate(p)
			wantCode(t, p, ParseOptions{}, tc.want)
		})
	}
	t.Run("failure without initiation record", func(t *testing.T) {
		p := stkSuccessPayload()
		cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
		cb["ResultCode"] = 1032
		delete(cb, "CallbackMetadata")
		wantCode(t, p, ParseOptions{}, CodeSTKAmountUnknown)
	})
}

func TestParseB2C(t *testing.T) {
	t.Parallel()
	t.Run("success with evidence amount", func(t *testing.T) {
		parsed := mustParse(t, b2cSuccessPayload(), ParseOptions{}).(ParsedB2CResult)
		if !parsed.Success || parsed.ResultCode != 0 {
			t.Fatalf("state wrong: %+v", parsed)
		}
		if parsed.JourneyKey != "b2c:SBK77YZQ9X" {
			t.Errorf("journeyKey = %q", parsed.JourneyKey)
		}
		if parsed.AmountMinor != 150_000 || !parsed.HasAmount {
			t.Errorf("amount = %d/%v, want 150000", parsed.AmountMinor, parsed.HasAmount)
		}
	})
	t.Run("failure without parameters is valid", func(t *testing.T) {
		p := b2cSuccessPayload()
		p["ResultCode"] = 2001
		p["ResultDesc"] = "insufficient funds"
		delete(p, "ResultParameters")
		parsed := mustParse(t, p, ParseOptions{}).(ParsedB2CResult)
		if parsed.Success || parsed.HasAmount {
			t.Fatalf("failure state wrong: %+v", parsed)
		}
	})
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"result type not 0", func(p map[string]any) { p["ResultType"] = 1 }, CodePayloadUnrecognized},
		{"missing result desc", func(p map[string]any) { delete(p, "ResultDesc") }, CodePayloadUnrecognized},
		{"missing conversation ids", func(p map[string]any) { delete(p, "ConversationID") }, CodePayloadUnrecognized},
		{"bad transaction id", func(p map[string]any) { p["TransactionID"] = "sbk77yzq9x" }, CodeTransIDMalformed},
		{"bad result code", func(p map[string]any) { p["ResultCode"] = "zero" }, CodeResultCodeInvalid},
		{"malformed parameters", func(p map[string]any) {
			p["ResultParameters"] = map[string]any{"ResultParameter": "not-an-array"}
		}, CodeB2CResultMalformed},
		{"bad amount type", func(p map[string]any) {
			p["ResultParameters"] = map[string]any{"ResultParameter": []any{
				map[string]any{"Name": "TransactionAmount", "Value": true},
			}}
		}, CodeB2CResultMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := b2cSuccessPayload()
			tc.mutate(p)
			wantCode(t, p, ParseOptions{}, tc.want)
		})
	}
}

func TestMoneyBoundary(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw     string
		want    int64
		wantErr bool
	}{
		{"2500.00", 250_000, false},
		{"2500", 250_000, false},
		{"2500.5", 250_050, false},
		{"0.01", 1, false},
		{"0", 0, false},
		{" 2500.00 ", 250_000, false}, // trimmed first, exactly like the TS lane
		{"150200.00", 15_020_000, false},
		{"", 0, true},
		{"-1.00", 0, true},
		{"1.234", 0, true}, // more than 2 fraction digits: refused, never truncated
		{".50", 0, true},   // no integer part — never coerced into 50 cents
		{"2500.", 0, true}, // dangling point — never coerced into whole shillings
		{"02500", 0, true}, // leading zero — not a wire decimal, refused
		{"00", 0, true},
		{"+2500", 0, true},
		{"abc", 0, true},
		{"1,000.00", 0, true}, // thousands separators are NOT wire format
	}
	for _, tc := range cases {
		got, err := parseWireAmountMinor(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("parseWireAmountMinor(%q) = %d, want refusal", tc.raw, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("parseWireAmountMinor(%q) = %d, %v; want %d", tc.raw, got, err, tc.want)
		}
	}
	if s := minorToDecimalString(250_000); s != "2500.00" {
		t.Errorf("minorToDecimalString = %q", s)
	}
	if _, err := wholeShillings(250_050); err == nil {
		t.Error("non-whole shillings must be refused (never rounded)")
	}
	if v, err := wholeShillings(250_000); err != nil || v != 2500 {
		t.Errorf("wholeShillings(250000) = %d, %v", v, err)
	}
}

// K1 parity rows for the divergences the gap audit found: the TS lane accepts
// payloads the Go parser used to dead-letter (optional OrgAccountBalance,
// numeric MpesaReceiptNumber) and refuses shapes Go used to coerce silently
// (".50", "02500", numeric BillRefNumber truncation).

func TestParseC2BOrgAccountBalanceOptional(t *testing.T) {
	t.Parallel()
	t.Run("absent is fine — Buy Goods tills often omit it", func(t *testing.T) {
		p := c2bPayload()
		delete(p, "OrgAccountBalance")
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if c2b.HasOrgAccountBalance || c2b.OrgAccountBalanceMin != 0 {
			t.Fatalf("absent balance must not be invented: %+v", c2b)
		}
	})
	t.Run("empty string is treated as absent (TS parity)", func(t *testing.T) {
		p := c2bPayload()
		p["OrgAccountBalance"] = ""
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if c2b.HasOrgAccountBalance {
			t.Fatalf("'' must parse as absent, got %+v", c2b)
		}
	})
	t.Run("null is treated as absent", func(t *testing.T) {
		p := c2bPayload()
		p["OrgAccountBalance"] = nil
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if c2b.HasOrgAccountBalance {
			t.Fatalf("null must parse as absent, got %+v", c2b)
		}
	})
	t.Run("present numeric balance is accepted as evidence", func(t *testing.T) {
		p := c2bPayload()
		p["OrgAccountBalance"] = 150200.0
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if !c2b.HasOrgAccountBalance || c2b.OrgAccountBalanceMin != 15_020_000 {
			t.Fatalf("balance = %d/%v, want 15020000/true", c2b.OrgAccountBalanceMin, c2b.HasOrgAccountBalance)
		}
	})
	t.Run("present junk type is refused", func(t *testing.T) {
		p := c2bPayload()
		p["OrgAccountBalance"] = map[string]any{"amount": 1}
		wantCode(t, p, ParseOptions{C2BKind: KindC2BConfirm}, CodeAmountMalformed)
	})
	t.Run("present over-precise balance is refused", func(t *testing.T) {
		p := c2bPayload()
		p["OrgAccountBalance"] = 0.30000000000000004
		wantCode(t, p, ParseOptions{C2BKind: KindC2BConfirm}, CodeAmountMalformed)
	})
}

func TestParseC2BInvoiceNumberJoinsDeclaredRefs(t *testing.T) {
	t.Parallel()
	t.Run("distinct invoice is appended", func(t *testing.T) {
		p := c2bPayload()
		p["InvoiceNumber"] = "TILL-88412"
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		want := []string{"INV-2026-0042", "TILL-88412"}
		if len(c2b.DeclaredRefs) != len(want) || c2b.DeclaredRefs[0] != want[0] || c2b.DeclaredRefs[1] != want[1] {
			t.Fatalf("DeclaredRefs = %v, want %v", c2b.DeclaredRefs, want)
		}
	})
	t.Run("duplicate invoice is deduped (trimmed first)", func(t *testing.T) {
		p := c2bPayload()
		p["BillRefNumber"] = "INV-2026-0042/INV-77"
		p["InvoiceNumber"] = " INV-77 "
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		want := []string{"INV-2026-0042", "INV-77"}
		if len(c2b.DeclaredRefs) != len(want) || c2b.DeclaredRefs[1] != want[1] {
			t.Fatalf("DeclaredRefs = %v, want %v", c2b.DeclaredRefs, want)
		}
	})
	t.Run("whitespace-only invoice is skipped", func(t *testing.T) {
		p := c2bPayload()
		p["InvoiceNumber"] = "   "
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if len(c2b.DeclaredRefs) != 1 || c2b.DeclaredRefs[0] != "INV-2026-0042" {
			t.Fatalf("DeclaredRefs = %v, want just the bill ref", c2b.DeclaredRefs)
		}
	})
}

func TestParseC2BBillRefNumberNumericKeepsDecimalShape(t *testing.T) {
	t.Parallel()
	t.Run("float ref keeps its decimal shape (no truncation)", func(t *testing.T) {
		p := c2bPayload()
		p["BillRefNumber"] = 1042.45
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if c2b.BillRefNumber != "1042.45" {
			t.Fatalf("BillRefNumber = %q, want 1042.45 (String() parity)", c2b.BillRefNumber)
		}
	})
	t.Run("integral ref is the plain digits", func(t *testing.T) {
		p := c2bPayload()
		p["BillRefNumber"] = 1042.0
		c2b := mustParse(t, p, ParseOptions{C2BKind: KindC2BConfirm}).(ParsedC2bCallback)
		if c2b.BillRefNumber != "1042" {
			t.Fatalf("BillRefNumber = %q, want 1042", c2b.BillRefNumber)
		}
	})
}

// STK parse strictness (gap-audit parity): present-but-junk TransactionDate
// metadata must be REFUSED (not silently skipped), a numeric
// MpesaReceiptNumber must string-coerce like the TS String() call, and
// ResultCode is number-only — a quoted "0" is not a result code.

func TestParseSTKJunkTransactionDateRefused(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		value    any
		wantCode string
	}{
		{"garbage string", "2026-09-08 10:16", CodeTransTimeMalformed},
		{"calendar rollover", "20260230101530", CodeTransTimeMalformed},
		{"empty string was never a skip", "", CodeTransTimeMalformed},
		{"numeric junk", 2500.0, CodeTransTimeMalformed},
		{"bool junk", true, CodeTransTimeMalformed},
		{"object junk", map[string]any{"deep": 1}, CodeSTKMetadataMalformed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := stkSuccessPayload()
			items := p["Body"].(map[string]any)["stkCallback"].(map[string]any)["CallbackMetadata"].(map[string]any)["Item"].([]any)
			for _, item := range items {
				if m, ok := item.(map[string]any); ok && m["Name"] == "TransactionDate" {
					m["Value"] = tc.value
				}
			}
			wantCode(t, p, ParseOptions{}, tc.wantCode)
		})
	}
	t.Run("failure results still tolerate metadata shapes (success-only validation, TS parity)", func(t *testing.T) {
		p := stkSuccessPayload()
		cb := p["Body"].(map[string]any)["stkCallback"].(map[string]any)
		cb["ResultCode"] = 1032
		cb["ResultDesc"] = "cancelled"
		requested := map[string]int64{"ws_CO_19122019102036805": 250_000}
		parsed := mustParse(t, p, ParseOptions{STKRequested: requested}).(ParsedSTKCallback)
		if parsed.Success || parsed.HasTransTime {
			t.Fatalf("failed result must carry no transaction time: %+v", parsed)
		}
	})
}

func TestParseSTKNumericReceiptCoerced(t *testing.T) {
	t.Parallel()
	p := stkSuccessPayload()
	items := p["Body"].(map[string]any)["stkCallback"].(map[string]any)["CallbackMetadata"].(map[string]any)["Item"].([]any)
	for _, item := range items {
		if m, ok := item.(map[string]any); ok && m["Name"] == "MpesaReceiptNumber" {
			m["Value"] = 1234567890.0 // JSON number receipt (observed Daraja quirk)
		}
	}
	parsed := mustParse(t, p, ParseOptions{}).(ParsedSTKCallback)
	if parsed.ReceiptNumber != "1234567890" {
		t.Fatalf("receipt = %q, want the String()-coerced 1234567890", parsed.ReceiptNumber)
	}
}

func TestParseSTKResultCodeIsNumberOnly(t *testing.T) {
	t.Parallel()
	t.Run("string zero refused", func(t *testing.T) {
		p := stkSuccessPayload()
		p["Body"].(map[string]any)["stkCallback"].(map[string]any)["ResultCode"] = "0"
		wantCode(t, p, ParseOptions{}, CodeResultCodeInvalid)
	})
	t.Run("string numeric refused on B2C too", func(t *testing.T) {
		p := b2cSuccessPayload()
		p["ResultCode"] = "0"
		wantCode(t, p, ParseOptions{}, CodeResultCodeInvalid)
	})
}
