// Fixture corpus tests — the EXACT payload bodies of src/adapters/daraja/
// fixtures/ (c2b.ts, stk.ts, b2c.ts, malformed.ts) kept as raw JSON so the
// Go lane is byte-faithful to the TS conformance fixtures (recovered from a
// partially-delivered draft of this lane; every value is synthetic
// Kenyan-realistic data — invented ids, test MSISDNs, no real PII).
//
// Every malformed row promises the exact stable DARAJA_* code the parser
// must refuse it with (the same promise the TS fixtures make).
package daraja

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// C2B fixtures (c2b.ts).
const (
	fixtureC2BPaybillSingle = `{
		"TransactionType": "Pay Bill",
		"TransID": "SBK41XQ7RT",
		"TransTime": "20250912143015",
		"TransAmount": "2500.00",
		"BusinessShortCode": "412873",
		"BillRefNumber": "INV-1042",
		"OrgAccountBalance": "489230.00",
		"MSISDN": "254712345678"
	}`
	fixtureC2BPaybillMultiRef = `{
		"TransactionType": "Pay Bill",
		"TransID": "SBC52JP4NM",
		"TransTime": "20250918091544",
		"TransAmount": "15000.00",
		"BusinessShortCode": "412873",
		"BillRefNumber": "INV-2077/INV-2078",
		"OrgAccountBalance": "1204510.50",
		"MSISDN": "254722000111"
	}`
	fixtureC2BBuyGoodsTill = `{
		"TransactionType": "Buy Goods",
		"TransID": "SBJ73CD8WT",
		"TransTime": "20251001172030",
		"TransAmount": "980.50",
		"BusinessShortCode": "987654",
		"BillRefNumber": "",
		"OrgAccountBalance": "31500.00",
		"MSISDN": "254113456789",
		"InvoiceNumber": "TILL-88412"
	}`
	fixtureC2BPaybillNoRef = `{
		"TransactionType": "Pay Bill",
		"TransID": "SBA84EF6YL",
		"TransTime": "20251005074510",
		"TransAmount": "4200.00",
		"BusinessShortCode": "412873",
		"BillRefNumber": "",
		"OrgAccountBalance": "523809.00",
		"MSISDN": "254712345678"
	}`
	// Same journey as paybill-single, different money — tampering, not a retry.
	fixtureC2BTamperedAmount = `{
		"TransactionType": "Pay Bill",
		"TransID": "SBK41XQ7RT",
		"TransTime": "20250912143015",
		"TransAmount": "3500.00",
		"BusinessShortCode": "412873",
		"BillRefNumber": "INV-1042",
		"OrgAccountBalance": "491730.00",
		"MSISDN": "254712345678"
	}`
)

// STK fixtures (stk.ts) — success with complete metadata, then the failure
// matrix (1, 2, 1032, 1037, 1001). Failure results carry NO CallbackMetadata.
const (
	fixtureSTKSuccess = `{
		"Body": {
			"stkCallback": {
				"MerchantRequestID": "58234-11940372-1",
				"CheckoutRequestID": "ws_CO_12092025143105741",
				"ResultCode": 0,
				"ResultDesc": "The service request is processed successfully.",
				"CallbackMetadata": {
					"Item": [
						{"Name": "Amount", "Value": 2500},
						{"Name": "MpesaReceiptNumber", "Value": "SBK81KZ9QF"},
						{"Name": "Balance"},
						{"Name": "TransactionDate", "Value": "20250912143105"},
						{"Name": "PhoneNumber", "Value": 254712345678}
					]
				}
			}
		}
	}`
	fixtureSTKCancelled1 = `{
		"Body": {"stkCallback": {
			"MerchantRequestID": "58235-11940999-2",
			"CheckoutRequestID": "ws_CO_12092025144000202",
			"ResultCode": 1,
			"ResultDesc": "Request cancelled by user"
		}}
	}`
	fixtureSTKTimeout2 = `{
		"Body": {"stkCallback": {
			"MerchantRequestID": "58236-11941005-3",
			"CheckoutRequestID": "ws_CO_12092025145530103",
			"ResultCode": 2,
			"ResultDesc": "The initiator request timed out"
		}}
	}`
	fixtureSTKCancelled1032 = `{
		"Body": {"stkCallback": {
			"MerchantRequestID": "58237-11941120-4",
			"CheckoutRequestID": "ws_CO_12092025151022104",
			"ResultCode": 1032,
			"ResultDesc": "Request cancelled by user"
		}}
	}`
	fixtureSTKUnreachable1037 = `{
		"Body": {"stkCallback": {
			"MerchantRequestID": "58238-11941244-5",
			"CheckoutRequestID": "ws_CO_12092025152140505",
			"ResultCode": 1037,
			"ResultDesc": "DS timeout: user cannot be reached"
		}}
	}`
	fixtureSTKSystemError1001 = `{
		"Body": {"stkCallback": {
			"MerchantRequestID": "58239-11941388-6",
			"CheckoutRequestID": "ws_CO_12092025153309906",
			"ResultCode": 1001,
			"ResultDesc": "System error while processing the request"
		}}
	}`
)

// B2C fixtures (b2c.ts) — the OUTFLOW shape.
const (
	fixtureB2CSuccess = `{
		"ResultType": 0,
		"ResultCode": 0,
		"ResultDesc": "The service request is processed successfully.",
		"OriginatorConversationID": "58234-7714364-1",
		"ConversationID": "AG_12092025143_119403721",
		"TransactionID": "RKT81KZ9QF",
		"ResultParameters": {
			"ResultParameter": [
				{"Name": "TransactionAmount", "Value": 1500},
				{"Name": "TransactionReceipt", "Value": "RKT81KZ9QF"},
				{"Name": "ReceiverPartyPublicName", "Value": "254712345678 - Jane Doe Test"},
				{"Name": "TransactionCompletedDateTime", "Value": "12.09.2025 14:31:05"}
			]
		}
	}`
	fixtureB2CFailed = `{
		"ResultType": 0,
		"ResultCode": 2001,
		"ResultDesc": "Invalid initiator name or password",
		"OriginatorConversationID": "58240-7714999-2",
		"ConversationID": "AG_12092025144_119404992",
		"TransactionID": "RKT95GH2PV"
	}`
)

// malformedFixtures is the K1 untrusted-input corpus (malformed.ts), row for
// row: wire-shaped junk paired with the promised rejection code.
var malformedFixtures = []struct {
	id              string
	payload         string
	expectRejection string
}{
	{
		id:              "malformed.not-an-object",
		payload:         `"payment received, promise"`,
		expectRejection: CodePayloadUnrecognized,
	},
	{
		id:              "malformed.empty-object",
		payload:         `{}`,
		expectRejection: CodePayloadUnrecognized,
	},
	{
		id: "malformed.foreign-gateway-payload",
		payload: `{
			"id": "evt_1NcQzR2eZvKYlo2C",
			"type": "payment_intent.succeeded",
			"data": {"object": {"amount": 2500, "currency": "kes"}}
		}`,
		expectRejection: CodePayloadUnrecognized,
	},
	{
		id: "malformed.c2b-missing-amount",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "SBK41XQ7RT",
			"TransTime": "20250912143015",
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "254712345678"
		}`,
		expectRejection: CodeAmountRequired,
	},
	{
		id: "malformed.c2b-amount-three-decimals",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "SBK41XQ7RT",
			"TransTime": "20250912143015",
			"TransAmount": "2500.005",
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "254712345678"
		}`,
		expectRejection: CodeAmountMalformed,
	},
	{
		id: "malformed.c2b-amount-float-junk",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "SBK41XQ7RT",
			"TransTime": "20250912143015",
			"TransAmount": 0.30000000000000004,
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "254712345678"
		}`,
		expectRejection: CodeAmountMalformed,
	},
	{
		id: "malformed.c2b-transid-lowercase",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "sbk41xq7rt",
			"TransTime": "20250912143015",
			"TransAmount": "2500.00",
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "254712345678"
		}`,
		expectRejection: CodeTransIDMalformed,
	},
	{
		id: "malformed.c2b-msisdn-local-form",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "SBK41XQ7RT",
			"TransTime": "20250912143015",
			"TransAmount": "2500.00",
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "0712345678"
		}`,
		expectRejection: CodeMSISDNMalformed,
	},
	{
		id: "malformed.c2b-transtime-zoned-string",
		payload: `{
			"TransactionType": "Pay Bill",
			"TransID": "SBK41XQ7RT",
			"TransTime": "2025-09-12T14:30:15+03:00",
			"TransAmount": "2500.00",
			"BusinessShortCode": "412873",
			"BillRefNumber": "INV-1042",
			"OrgAccountBalance": "489230.00",
			"MSISDN": "254712345678"
		}`,
		expectRejection: CodeTransTimeMalformed,
	},
	{
		id: "malformed.stk-checkoutid-foreign",
		payload: `{
			"Body": {"stkCallback": {
				"MerchantRequestID": "58234-1",
				"CheckoutRequestID": "pi_3NcQzR2eZvKYlo2C",
				"ResultCode": 0,
				"ResultDesc": "ok"
			}}
		}`,
		expectRejection: CodeCheckoutRequestIDMalform,
	},
	{
		id: "malformed.stk-negative-result-code",
		payload: `{
			"Body": {"stkCallback": {
				"MerchantRequestID": "58234-1",
				"CheckoutRequestID": "ws_CO_12092025143105741",
				"ResultCode": -5,
				"ResultDesc": "impossible"
			}}
		}`,
		expectRejection: CodeResultCodeInvalid,
	},
	{
		id: "malformed.b2c-resulttype-nonzero",
		payload: `{
			"ResultType": 7,
			"ResultCode": 0,
			"ResultDesc": "ok",
			"ConversationID": "c-1",
			"OriginatorConversationID": "o-1",
			"TransactionID": "RKT81KZ9QF"
		}`,
		expectRejection: CodePayloadUnrecognized,
	},
}

// parseFixture parses a fixture string, asserting refusal codes on the
// malformed corpus.
func parseFixture(t *testing.T, payload string, opts ParseOptions) (ParsedCallback, error) {
	t.Helper()
	return ParseCallback([]byte(payload), opts)
}

func TestFixtureCorpusAcceptsValidPayloads(t *testing.T) {
	t.Parallel()
	valid := []struct {
		id      string
		payload string
		opts    ParseOptions
	}{
		{"c2b.paybill-single", fixtureC2BPaybillSingle, ParseOptions{C2BKind: KindC2BConfirm}},
		{"c2b.paybill-multi-ref", fixtureC2BPaybillMultiRef, ParseOptions{C2BKind: KindC2BValidation}},
		{"c2b.buygoods-till", fixtureC2BBuyGoodsTill, ParseOptions{C2BKind: KindC2BConfirm}},
		{"c2b.paybill-no-ref", fixtureC2BPaybillNoRef, ParseOptions{C2BKind: KindC2BConfirm}},
		{"stk.success", fixtureSTKSuccess, ParseOptions{}},
		{"b2c.success", fixtureB2CSuccess, ParseOptions{}},
		{"b2c.failed", fixtureB2CFailed, ParseOptions{}},
	}
	for _, tc := range valid {
		t.Run(tc.id, func(t *testing.T) {
			parsed, err := parseFixture(t, tc.payload, tc.opts)
			if err != nil {
				t.Fatalf("valid fixture %s refused: %v", tc.id, err)
			}
			if parsed.IntakeFacts().JourneyKey == "" {
				t.Fatalf("fixture %s carries no journey key", tc.id)
			}
		})
	}
}

func TestFixtureCorpusRefusesMalformedRows(t *testing.T) {
	t.Parallel()
	for _, row := range malformedFixtures {
		t.Run(row.id, func(t *testing.T) {
			_, err := parseFixture(t, row.payload, ParseOptions{C2BKind: KindC2BConfirm})
			de, ok := err.(*Error)
			if !ok || de.Code != row.expectRejection {
				t.Fatalf("promised %s, got %v", row.expectRejection, err)
			}
		})
	}
}

func TestSTKFailureFixtureFamilies(t *testing.T) {
	t.Parallel()
	requested := map[string]int64{
		"ws_CO_12092025144000202": 250_000,
		"ws_CO_12092025145530103": 250_000,
		"ws_CO_12092025151022104": 250_000,
		"ws_CO_12092025152140505": 250_000,
		"ws_CO_12092025153309906": 250_000,
	}
	cases := []struct {
		fixture   string
		checkout  string
		wantFamly string
	}{
		{fixtureSTKCancelled1, "ws_CO_12092025144000202", "STK_USER_CANCELLED"},
		{fixtureSTKTimeout2, "ws_CO_12092025145530103", "STK_TIMEOUT"},
		{fixtureSTKCancelled1032, "ws_CO_12092025151022104", "STK_CANCELLED_BY_USER"},
		{fixtureSTKUnreachable1037, "ws_CO_12092025152140505", "STK_UNREACHABLE"},
		{fixtureSTKSystemError1001, "ws_CO_12092025153309906", "STK_RESULT_1001"},
	}
	for _, tc := range cases {
		parsed, err := parseFixture(t, tc.fixture, ParseOptions{STKRequested: requested})
		if err != nil {
			t.Fatalf("%v: %v", tc.wantFamly, err)
		}
		stk := parsed.(ParsedSTKCallback)
		if stk.Success || stk.FailureCode != tc.wantFamly {
			t.Fatalf("family = %q success = %v, want %q/failed", stk.FailureCode, stk.Success, tc.wantFamly)
		}
		if stk.AmountMinor != 250_000 {
			t.Fatalf("%s: intake amount = %d, want the initiation record 250000", tc.wantFamly, stk.AmountMinor)
		}
	}
}

func TestFixtureSTKSuccessMetadata(t *testing.T) {
	t.Parallel()
	parsed, err := parseFixture(t, fixtureSTKSuccess, ParseOptions{})
	if err != nil {
		t.Fatalf("success fixture refused: %v", err)
	}
	stk := parsed.(ParsedSTKCallback)
	if !stk.Success || stk.ReceiptNumber != "SBK81KZ9QF" {
		t.Fatalf("receipt = %q success = %v", stk.ReceiptNumber, stk.Success)
	}
	if stk.PaidMinor != 250_000 {
		t.Fatalf("paid = %d, want 250000", stk.PaidMinor)
	}
	if stk.MSISDN != "254712345678" {
		t.Fatalf("msisdn = %q (the fixture carries it as a JSON NUMBER)", stk.MSISDN)
	}
}

func TestIntakeFunnelR9(t *testing.T) {
	t.Parallel()
	confirm := ParseOptions{C2BKind: KindC2BConfirm}

	t.Run("first sight accepted, replay duplicate with one tripwire", func(t *testing.T) {
		ledger := NewMemLedger()
		tripwires := 0
		hooks := IntakeHooks{OnDuplicate: func(ParsedCallback) { tripwires++ }}

		for i := 0; i < 5; i++ { // at-least-once: 5 deliveries of the same callback
			parsed, err := parseFixture(t, fixtureC2BPaybillSingle, confirm)
			if err != nil {
				t.Fatalf("delivery %d refused: %v", i, err)
			}
			outcome, err := IntakeCallback(context.Background(), ledger, parsed, hooks)
			if err != nil {
				t.Fatalf("delivery %d: %v", i, err)
			}
			want := OutcomeAccepted
			if i > 0 {
				want = OutcomeDuplicate
			}
			if outcome.Outcome != want {
				t.Fatalf("delivery %d: outcome = %s, want %s", i, outcome.Outcome, want)
			}
		}
		if tripwires != 4 {
			t.Fatalf("tripwire fired %d times, want 4 (once per duplicate)", tripwires)
		}
	})

	t.Run("same journey different money is TAMPERING (K1)", func(t *testing.T) {
		ledger := NewMemLedger()
		parsed, err := parseFixture(t, fixtureC2BPaybillSingle, confirm)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := IntakeCallback(context.Background(), ledger, parsed, IntakeHooks{}); err != nil {
			t.Fatal(err)
		}
		tampered, err := parseFixture(t, fixtureC2BTamperedAmount, confirm)
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := IntakeCallback(context.Background(), ledger, tampered, IntakeHooks{})
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeDuplicateAmountMismatch {
			t.Fatalf("want DARAJA_DUPLICATE_AMOUNT_MISMATCH, got %v", err)
		}
		if outcome.Outcome != OutcomeRejected {
			t.Fatalf("outcome = %s, want rejected", outcome.Outcome)
		}
	})

	t.Run("validation is a gate, never a money fact", func(t *testing.T) {
		ledger := NewMemLedger()
		parsed, err := parseFixture(t, fixtureC2BPaybillMultiRef, ParseOptions{C2BKind: KindC2BValidation})
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := IntakeCallback(context.Background(), ledger, parsed, IntakeHooks{})
		if err != nil || outcome.Outcome != OutcomeAcknowledged {
			t.Fatalf("outcome = %s err = %v, want acknowledged", outcome.Outcome, err)
		}
		// And the validation never ledgered: the confirmation is still fresh.
		confirmParsed, err := parseFixture(t, fixtureC2BPaybillMultiRef, ParseOptions{C2BKind: KindC2BConfirm})
		if err != nil {
			t.Fatal(err)
		}
		outcome, err = IntakeCallback(context.Background(), ledger, confirmParsed, IntakeHooks{})
		if err != nil || outcome.Outcome != OutcomeAccepted {
			t.Fatalf("confirmation after validation = %s err = %v, want accepted", outcome.Outcome, err)
		}
	})

	t.Run("B2C is observed evidence, never an inflow", func(t *testing.T) {
		ledger := NewMemLedger()
		parsed, err := parseFixture(t, fixtureB2CSuccess, ParseOptions{})
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := IntakeCallback(context.Background(), ledger, parsed, IntakeHooks{})
		if err != nil || outcome.Outcome != OutcomeObserved {
			t.Fatalf("outcome = %s err = %v, want observed", outcome.Outcome, err)
		}
		// Replay an identical B2C — still observed, still never ledgered.
		parsed2, _ := parseFixture(t, fixtureB2CSuccess, ParseOptions{})
		outcome2, err := IntakeCallback(context.Background(), ledger, parsed2, IntakeHooks{})
		if err != nil || outcome2.Outcome != OutcomeObserved {
			t.Fatalf("b2c replay = %s err = %v, want observed", outcome2.Outcome, err)
		}
	})

	t.Run("ledger failure fails closed (rejected)", func(t *testing.T) {
		ledger := failingLedger{}
		parsed, err := parseFixture(t, fixtureC2BPaybillSingle, confirm)
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := IntakeCallback(context.Background(), ledger, parsed, IntakeHooks{})
		var de *Error
		if !errors.As(err, &de) || de.Code != CodeLedgerUnavailable {
			t.Fatalf("want DARAJA_LEDGER_UNAVAILABLE, got %v", err)
		}
		if outcome.Outcome != OutcomeRejected {
			t.Fatalf("outcome = %s, want rejected", outcome.Outcome)
		}
		if !strings.Contains(de.Error(), CodeLedgerUnavailable) {
			t.Errorf("error text should carry the stable code")
		}
	})

	t.Run("STK journey ledgered by checkout id", func(t *testing.T) {
		ledger := NewMemLedger()
		requested := map[string]int64{"ws_CO_12092025151022104": 250_000}
		parsed, err := parseFixture(t, fixtureSTKCancelled1032, ParseOptions{STKRequested: requested})
		if err != nil {
			t.Fatal(err)
		}
		outcome, err := IntakeCallback(context.Background(), ledger, parsed, IntakeHooks{})
		if err != nil || outcome.Outcome != OutcomeAccepted {
			t.Fatalf("outcome = %s err = %v, want accepted", outcome.Outcome, err)
		}
		if outcome.JourneyKey != "stk:ws_CO_12092025151022104" {
			t.Fatalf("journey = %q", outcome.JourneyKey)
		}
	})
}

// failingLedger always errors — the fail-closed path.
type failingLedger struct{}

func (failingLedger) ClaimJourney(context.Context, string, int64) (bool, int64, error) {
	return false, 0, errors.New("connection refused")
}
