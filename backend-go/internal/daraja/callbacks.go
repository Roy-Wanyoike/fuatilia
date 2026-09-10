// The K1 untrusted-input boundary (issue #96): raw Daraja callback payloads
// parsed into typed evidence. This file ports src/adapters/daraja/wire.ts
// EXACTLY — same patterns, same required fields, same stable DARAJA_* codes —
// so a payload the TS lane dead-letters is dead-lettered here too.
//
// Anything structurally wrong is REFUSED with a stable code (the transport
// dead-letters it, SPEC §14); nothing is guessed, defaulted or coerced.
// Duplicate/tamper decisions (same TransID, different money) are the DOMAIN
// intake's job (R9/K1) — the parser yields evidence, not verdicts.
package daraja

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Wire patterns — identical to src/adapters/daraja/wire.ts.
var (
	transIDPattern   = regexp.MustCompile(`^[A-Z0-9]{10,22}$`)
	checkoutIDPatter = regexp.MustCompile(`^ws_CO_[A-Za-z0-9]{6,24}$`)
	msisdnPattern    = regexp.MustCompile(`^254[17]\d{8}$`)
	shortCodePattern = regexp.MustCompile(`^\d{5,7}$`)
)

// CallbackKind identifies which Daraja endpoint delivered a payload.
type CallbackKind string

const (
	KindC2BValidation CallbackKind = "c2b-validation"
	KindC2BConfirm    CallbackKind = "c2b-confirmation"
	KindSTKResult     CallbackKind = "stk-result"
	KindB2CResult     CallbackKind = "b2c-result"
)

// ParseOptions carries the merchant-side context a callback needs.
type ParseOptions struct {
	// C2BKind selects the delivering endpoint for C2B payloads
	// (validation or confirmation — the wire shapes match, the semantics differ).
	C2BKind CallbackKind
	// STKRequested maps CheckoutRequestID → the requested amount in minor
	// units (the merchant's own initiation record, E11). Failure results
	// carry NO amount on the wire; without this record the intake amount is
	// unknown and the parse refuses (DARAJA_STK_AMOUNT_UNKNOWN).
	STKRequested map[string]int64
}

// ParsedC2bCallback is a validated C2B validation/confirmation notification.
type ParsedC2bCallback struct {
	Kind                 CallbackKind
	JourneyKey           string
	TransID              string
	TransTime            time.Time
	BusinessShortCode    string
	BillRefNumber        string   // '' when absent (Buy Goods tills)
	DeclaredRefs         []string // BillRefNumber split on '/' and ',', plus a DISTINCT InvoiceNumber (TS parity)
	MSISDN               string
	AmountMinor          int64
	OrgAccountBalanceMin int64 // evidence only — never intake money; 0 when HasOrgAccountBalance is false
	HasOrgAccountBalance bool  // OrgAccountBalance is OPTIONAL on the wire: absent ≠ zero (TS parity)
	InvoiceNumber        string
	ThirdPartyTransID    string
}

// ParsedSTKCallback is a validated STK push result.
type ParsedSTKCallback struct {
	Kind              CallbackKind
	JourneyKey        string
	CheckoutRequestID string
	MerchantRequestID string
	ResultCode        int64
	Success           bool
	ReceiptNumber     string // MpesaReceiptNumber (success only)
	PaidMinor         int64  // metadata Amount (success only)
	HasPaid           bool
	TransTime         time.Time // metadata TransactionDate (success only)
	HasTransTime      bool
	MSISDN            string // metadata PhoneNumber (success only)
	FailureCode       string // '' on success; STK_* stable family otherwise
	AmountMinor       int64  // the intake amount that backs the command
}

// ParsedB2CResult is a validated B2C payout result — an OUTFLOW: evidence
// only, never an inflow payment.
type ParsedB2CResult struct {
	Kind                     CallbackKind
	JourneyKey               string
	TransactionID            string
	ConversationID           string
	OriginatorConversationID string
	ResultCode               int64
	Success                  bool
	AmountMinor              int64 // TransactionAmount, evidence only
	HasAmount                bool
}

// IntakeFacts is the projection the R9 intake funnel needs from any parsed
// callback: its kind, its journey key (the dedup key — same vocabulary as
// the TS simulator: 'c2b:<TransID>' / 'stk:<CheckoutRequestID>' /
// 'b2c:<TransactionID>') and its money in minor units.
type IntakeFacts struct {
	Kind        CallbackKind
	JourneyKey  string
	AmountMinor int64
}

// ParsedCallback is the union the parser returns (C2B / STK / B2C evidence).
type ParsedCallback interface {
	IntakeFacts() IntakeFacts
}

func (c ParsedC2bCallback) IntakeFacts() IntakeFacts {
	return IntakeFacts{Kind: c.Kind, JourneyKey: c.JourneyKey, AmountMinor: c.AmountMinor}
}

func (s ParsedSTKCallback) IntakeFacts() IntakeFacts {
	return IntakeFacts{Kind: KindSTKResult, JourneyKey: s.JourneyKey, AmountMinor: s.AmountMinor}
}

func (b ParsedB2CResult) IntakeFacts() IntakeFacts {
	return IntakeFacts{Kind: KindB2CResult, JourneyKey: b.JourneyKey, AmountMinor: b.AmountMinor}
}

// ParseCallback classifies and validates a raw callback payload.
func ParseCallback(raw []byte, opts ParseOptions) (ParsedCallback, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, errf(CodePayloadUnrecognized, "callback is not a JSON object: %v", err)
	}
	switch classifyPayload(payload) {
	case "stk":
		v, err := parseSTK(payload, opts)
		return v, err
	case "b2c":
		v, err := parseB2C(payload)
		return v, err
	case "c2b":
		switch opts.C2BKind {
		case KindC2BValidation, KindC2BConfirm:
			v, err := parseC2B(payload, opts.C2BKind)
			return v, err
		default:
			return nil, errf(CodeC2BKindRequired,
				"a C2B payload arrived without the delivering-endpoint hint (ParseOptions.C2BKind)")
		}
	default:
		return nil, errf(CodePayloadUnrecognized, "payload matches no known Daraja callback shape")
	}
}

// classifyPayload mirrors classifyDarajaPayload in wire.ts.
func classifyPayload(p map[string]any) string {
	if body, ok := p["Body"].(map[string]any); ok {
		if _, ok := body["stkCallback"].(map[string]any); ok {
			return "stk"
		}
	}
	if _, hasConv := p["ConversationID"]; hasConv {
		if _, hasType := p["ResultType"]; hasType {
			return "b2c"
		}
	}
	if _, ok := p["TransID"]; ok {
		return "c2b"
	}
	if _, ok := p["TransAmount"]; ok {
		return "c2b"
	}
	if _, ok := p["TransTime"]; ok {
		return "c2b"
	}
	return "unrecognized"
}

// assertTransID mirrors assertTransId: uppercase [A-Z0-9], 10–22 chars.
func assertTransID(raw any, field string) (string, error) {
	s, ok := nonEmptyString(raw)
	if !ok {
		return "", errf(CodeTransIDRequired, "%s is required", field)
	}
	s = strings.TrimSpace(s)
	if !transIDPattern.MatchString(s) {
		return "", errf(CodeTransIDMalformed, "%s %q must be uppercase [A-Z0-9] (10–22 chars)", field, s)
	}
	return s, nil
}

// assertMSISDN mirrors assertMsisdn (which String()-coerces numbers first).
func assertMSISDN(raw any) (string, error) {
	s, ok := msisdnString(raw)
	if !ok || !msisdnPattern.MatchString(strings.TrimSpace(s)) {
		return "", errf(CodeMSISDNMalformed,
			"MSISDN must be a Safaricom number in 2547XXXXXXXX / 2541XXXXXXXX form (masked: %s)", maskMSISDN(fmt.Sprintf("%v", raw)))
	}
	return strings.TrimSpace(s), nil
}

// msisdnString accepts a string or an integer JSON number — the TS lane
// String()-coerces metadata values, and the fixtures carry PhoneNumber as a
// NUMBER ("Value": 254712345678).
func msisdnString(raw any) (string, bool) {
	switch v := raw.(type) {
	case string:
		return v, v != ""
	case float64:
		if v != float64(int64(v)) {
			return "", false
		}
		return strconv.FormatInt(int64(v), 10), true
	default:
		return "", false
	}
}

// assertResultCode mirrors assertResultCode: a JSON NUMBER, non-negative
// integer (Number.isSafeInteger parity via the 2^53 bound). String forms —
// even "0" — are refused: a quoted result code is not a result code.
func assertResultCode(raw any) (int64, error) {
	v, ok := raw.(float64)
	if !ok || v != float64(int64(v)) || v < 0 || v >= 1<<53 {
		return 0, errf(CodeResultCodeInvalid, "ResultCode %v must be a JSON number (non-negative integer)", raw)
	}
	return int64(v), nil
}

// nonEmptyString: strings pass trimmed; JSON numbers are NOT strings.
func nonEmptyString(raw any) (string, bool) {
	s, ok := raw.(string)
	if !ok {
		return "", false
	}
	if strings.TrimSpace(s) == "" {
		return "", false
	}
	return s, true
}

// numberOrDecimalString accepts JSON numbers and decimal strings for the
// amount fields (mirroring wire.ts's `typeof amount !== 'number' && typeof
// amount !== 'string'` refusals).
func numberOrDecimalString(raw any) (string, bool) {
	switch v := raw.(type) {
	case string:
		return v, true
	case float64:
		if v != float64(int64(v)) {
			// Non-integer JSON numbers (e.g. 2500.5) keep their exact decimal
			// shape only via strconv formatting 'g' — acceptable: the wire
			// sends decimals as STRINGS, and a float like 2500.5 is exact
			// enough for the 2-dp parse to refuse or accept identically.
			return strconv.FormatFloat(v, 'f', -1, 64), true
		}
		return strconv.FormatInt(int64(v), 10), true
	default:
		return "", false
	}
}

// jsString mirrors JS String() for the value types JSON can deliver, so a
// present-but-junk metadata value is VALIDATED (and refused) exactly where
// the TS lane refuses it instead of being silently skipped.
func jsString(raw any) (string, bool) {
	switch v := raw.(type) {
	case string:
		return v, true
	case float64:
		// 'f' keeps integral wire values (timestamps, receipts) digit-exact.
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case bool:
		if v {
			return "true", true
		}
		return "false", true
	case nil:
		return "null", true
	default:
		return "", false
	}
}

// transTimeToDate mirrors transTimeToDate: "YYYYMMDDHHmmss" in EAT.
func transTimeToDate(raw string) (time.Time, error) {
	if len(raw) != 14 {
		return time.Time{}, errf(CodeTransTimeMalformed, "TransTime %q must be YYYYMMDDHHmmss (EAT)", raw)
	}
	t, err := time.ParseInLocation("20060102150405", raw, eatLocation)
	if err != nil {
		return time.Time{}, errf(CodeTransTimeMalformed, "TransTime %q is not a valid timestamp: %v", raw, err)
	}
	return t, nil
}

// parseC2B mirrors parseC2b in wire.ts.
func parseC2B(p map[string]any, kind CallbackKind) (ParsedC2bCallback, error) {
	transID, err := assertTransID(p["TransID"], "TransID")
	if err != nil {
		return ParsedC2bCallback{}, err
	}
	transTimeRaw, ok := nonEmptyString(p["TransTime"])
	if !ok {
		return ParsedC2bCallback{}, errf(CodeTransTimeMalformed, "TransTime is required")
	}
	transTime, err := transTimeToDate(transTimeRaw)
	if err != nil {
		return ParsedC2bCallback{}, err
	}
	amountRaw, present := p["TransAmount"]
	if !present || amountRaw == nil || amountRaw == "" { // '' is the TS lane's AMOUNT_REQUIRED shape
		return ParsedC2bCallback{}, errf(CodeAmountRequired, "TransAmount is required")
	}
	amountStr, ok := numberOrDecimalString(amountRaw)
	if !ok {
		return ParsedC2bCallback{}, errf(CodeAmountMalformed, "TransAmount must be a decimal string or number")
	}
	amountMinor, err := parseWireAmountMinor(amountStr)
	if err != nil {
		return ParsedC2bCallback{}, err
	}
	shortCode, ok := nonEmptyString(p["BusinessShortCode"])
	if !ok || !shortCodePattern.MatchString(strings.TrimSpace(shortCode)) {
		return ParsedC2bCallback{}, errf(CodeShortCodeMalformed, "BusinessShortCode must be 5–7 digits")
	}
	msisdn, err := assertMSISDN(p["MSISDN"])
	if err != nil {
		return ParsedC2bCallback{}, err
	}
	billRef := ""
	switch v := p["BillRefNumber"].(type) {
	case nil:
	case string:
		billRef = strings.TrimSpace(v)
	case float64:
		// JS String() parity via FormatFloat(-1): a numeric ref keeps
		// its exact decimal shape (123.45 stays "123.45") — a truncated
		// reference would point the payment at a DIFFERENT account (K1).
		billRef = strings.TrimSpace(strconv.FormatFloat(v, 'f', -1, 64))
	default:
		return ParsedC2bCallback{}, errf(CodeBillRefMalformed, "BillRefNumber must be a string or number")
	}

	declaredRefs := billRefToDeclaredRefs(billRef)
	if invoiceNumber, ok := nonEmptyString(p["InvoiceNumber"]); ok {
		ref := strings.TrimSpace(invoiceNumber)
		if !containsString(declaredRefs, ref) {
			declaredRefs = append(declaredRefs, ref)
		}
	}

	// OrgAccountBalance is OPTIONAL on the wire (Buy Goods tills often
	// omit it): absent / null / '' parse fine; when PRESENT it must be a
	// decimal the TS lane would accept — evidence only, never intake
	// money. Present-but-junk is refused, never coerced (K1).
	var balanceMinor int64
	hasBalance := false
	if raw, present := p["OrgAccountBalance"]; present && raw != nil && !isEmptyString(raw) {
		balanceStr, ok := numberOrDecimalString(raw)
		if !ok {
			return ParsedC2bCallback{}, errf(CodeAmountMalformed, "OrgAccountBalance must be a decimal")
		}
		minor, perr := parseWireAmountMinor(balanceStr)
		if perr != nil {
			return ParsedC2bCallback{}, errf(CodeAmountMalformed, "OrgAccountBalance must be a decimal")
		}
		balanceMinor, hasBalance = minor, true
	}

	return ParsedC2bCallback{
		Kind:                 kind,
		JourneyKey:           "c2b:" + transID,
		TransID:              transID,
		TransTime:            transTime,
		BusinessShortCode:    strings.TrimSpace(shortCode),
		BillRefNumber:        billRef,
		DeclaredRefs:         declaredRefs,
		MSISDN:               msisdn,
		AmountMinor:          amountMinor,
		OrgAccountBalanceMin: balanceMinor,
		HasOrgAccountBalance: hasBalance,
		InvoiceNumber:        stringField(p, "InvoiceNumber"),
		ThirdPartyTransID:    stringField(p, "ThirdPartyTransID"),
	}, nil
}

// isValidTransID reports whether s matches the production TransID shape
// (uppercase [A-Z0-9], 10–22 chars) — used by the transaction-status query.
func isValidTransID(s string) bool {
	return transIDPattern.MatchString(s)
}

// billRefToDeclaredRefs mirrors billRefToDeclaredRefs: split on '/' and ','.
func billRefToDeclaredRefs(raw string) []string {
	pieces := strings.FieldsFunc(raw, func(r rune) bool { return r == '/' || r == ',' })
	refs := make([]string, 0, len(pieces))
	for _, piece := range pieces {
		if trimmed := strings.TrimSpace(piece); trimmed != "" {
			refs = append(refs, trimmed)
		}
	}
	return refs
}

// isEmptyString reports whether the raw value is a zero-length JSON string —
// the TS lane treats OrgAccountBalance === ” as absent (not junk).
func isEmptyString(raw any) bool {
	s, ok := raw.(string)
	return ok && s == ""
}

// containsString reports whether v is already in list (declared-ref dedup).
func containsString(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}

// parseSTK mirrors parseStk in wire.ts.
func parseSTK(p map[string]any, opts ParseOptions) (ParsedSTKCallback, error) {
	body := p["Body"].(map[string]any)
	callback := body["stkCallback"].(map[string]any)

	merchantRequestID, ok := nonEmptyString(callback["MerchantRequestID"])
	if !ok {
		return ParsedSTKCallback{}, errf(CodePayloadUnrecognized, "MerchantRequestID is required")
	}
	checkoutRaw, ok := nonEmptyString(callback["CheckoutRequestID"])
	if !ok {
		return ParsedSTKCallback{}, errf(CodeCheckoutRequestIDRequired, "CheckoutRequestID is required")
	}
	checkoutRequestID := strings.TrimSpace(checkoutRaw)
	if !checkoutIDPatter.MatchString(checkoutRequestID) {
		return ParsedSTKCallback{}, errf(CodeCheckoutRequestIDMalform,
			"CheckoutRequestID %q must match ws_CO_<alphanumerics>", checkoutRequestID)
	}
	resultCode, err := assertResultCode(callback["ResultCode"])
	if err != nil {
		return ParsedSTKCallback{}, err
	}
	if _, ok := nonEmptyString(callback["ResultDesc"]); !ok {
		return ParsedSTKCallback{}, errf(CodePayloadUnrecognized, "ResultDesc is required")
	}
	success := resultCode == 0

	var paidMinor int64
	var hasPaid bool
	var receiptNumber, msisdn string
	var transTime time.Time
	var hasTransTime bool

	if metaRaw, present := callback["CallbackMetadata"]; present {
		meta, ok := metaRaw.(map[string]any)
		if !ok {
			return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed, "CallbackMetadata must be an object")
		}
		items, ok := meta["Item"].([]any)
		if !ok {
			return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed, "CallbackMetadata.Item must be an array")
		}
		itemsMap, err := metadataItemsToMap(items, CodeSTKMetadataMalformed)
		if err != nil {
			return ParsedSTKCallback{}, err
		}
		if success {
			amountRaw, present := itemsMap["Amount"]
			if !present {
				return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed, "a successful STK result carries an Amount item")
			}
			amountStr, ok := numberOrDecimalString(amountRaw)
			if !ok {
				return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed, "metadata Amount must be a number or string")
			}
			paidMinor, err = parseWireAmountMinor(amountStr)
			if err != nil {
				return ParsedSTKCallback{}, err
			}
			hasPaid = true
			receiptRaw, hasReceipt := itemsMap["MpesaReceiptNumber"]
			if !hasReceipt {
				return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed,
					"a successful STK result carries an MpesaReceiptNumber (uppercase [A-Z0-9], 10–22 chars)")
			}
			// String() parity: Daraja has been observed sending the receipt
			// as a JSON NUMBER — coerce before the pattern test.
			receiptStr, ok := jsString(receiptRaw)
			if !ok || !transIDPattern.MatchString(receiptStr) {
				return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed,
					"a successful STK result carries an MpesaReceiptNumber (uppercase [A-Z0-9], 10–22 chars)")
			}
			receiptNumber = receiptStr
			if whenRaw, hasWhen := itemsMap["TransactionDate"]; hasWhen {
				// String() parity, then validate: a PRESENT-but-junk
				// TransactionDate is refused, never silently skipped —
				// a fabricated timestamp must not enter evidence.
				whenStr, ok := jsString(whenRaw)
				if !ok {
					return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed,
						"metadata TransactionDate must be a string")
				}
				transTime, err = transTimeToDate(whenStr)
				if err != nil {
					return ParsedSTKCallback{}, err
				}
				hasTransTime = true
			}
			if phoneRaw, hasPhone := itemsMap["PhoneNumber"]; hasPhone {
				msisdn, err = assertMSISDN(phoneRaw)
				if err != nil {
					return ParsedSTKCallback{}, err
				}
			}
		}
	} else if success {
		return ParsedSTKCallback{}, errf(CodeSTKMetadataMalformed, "a successful STK result must carry CallbackMetadata")
	}

	// Intake amount: the merchant's own initiation record (E11) when known —
	// failure results carry NO amount on the wire — else the paid amount.
	intakeMinor := int64(0)
	if initiation, known := opts.STKRequested[checkoutRequestID]; known {
		intakeMinor = initiation
	} else if hasPaid {
		intakeMinor = paidMinor
	} else {
		return ParsedSTKCallback{}, errf(CodeSTKAmountUnknown,
			"no initiation record and no callback amount for %s — the merchant must know what it asked for (E11)", checkoutRequestID)
	}

	return ParsedSTKCallback{
		Kind:              KindSTKResult,
		JourneyKey:        "stk:" + checkoutRequestID,
		CheckoutRequestID: checkoutRequestID,
		MerchantRequestID: merchantRequestID,
		ResultCode:        resultCode,
		Success:           success,
		ReceiptNumber:     receiptNumber,
		PaidMinor:         paidMinor,
		HasPaid:           hasPaid,
		TransTime:         transTime,
		HasTransTime:      hasTransTime,
		MSISDN:            msisdn,
		FailureCode:       stkFailureCode(resultCode),
		AmountMinor:       intakeMinor,
	}, nil
}

// stkFailureCode mirrors resultCodeOutcome in simulator.ts: 0 completes;
// 1/2/1032/1037 abandon with stable families; ANY other non-zero code fails
// closed via the default — an unknown code never maps to money (K1).
func stkFailureCode(code int64) string {
	switch code {
	case 0:
		return ""
	case 1:
		return "STK_USER_CANCELLED"
	case 2:
		return "STK_TIMEOUT"
	case 1032:
		return "STK_CANCELLED_BY_USER"
	case 1037:
		return "STK_UNREACHABLE"
	default:
		return fmt.Sprintf("STK_RESULT_%d", code)
	}
}

// parseB2C mirrors parseB2c in wire.ts.
func parseB2C(p map[string]any) (ParsedB2CResult, error) {
	resultType, ok := p["ResultType"].(float64)
	if !ok || resultType != 0 {
		return ParsedB2CResult{}, errf(CodePayloadUnrecognized, "B2C results carry ResultType 0")
	}
	if _, ok := nonEmptyString(p["ResultDesc"]); !ok {
		return ParsedB2CResult{}, errf(CodePayloadUnrecognized, "ResultDesc is required")
	}
	conversationID, hasConv := nonEmptyString(p["ConversationID"])
	originatorID, hasOrig := nonEmptyString(p["OriginatorConversationID"])
	if !hasConv || !hasOrig {
		return ParsedB2CResult{}, errf(CodePayloadUnrecognized, "B2C results carry both conversation ids")
	}
	transactionID, err := assertTransID(p["TransactionID"], "TransactionID")
	if err != nil {
		return ParsedB2CResult{}, err
	}
	resultCode, err := assertResultCode(p["ResultCode"])
	if err != nil {
		return ParsedB2CResult{}, err
	}

	var amountMinor int64
	var hasAmount bool
	if paramsRaw, present := p["ResultParameters"]; present {
		params, ok := paramsRaw.(map[string]any)
		if !ok {
			return ParsedB2CResult{}, errf(CodeB2CResultMalformed, "ResultParameters must be an object")
		}
		items, ok := params["ResultParameter"].([]any)
		if !ok {
			return ParsedB2CResult{}, errf(CodeB2CResultMalformed, "ResultParameters.ResultParameter must be an array")
		}
		itemsMap, err := metadataItemsToMap(items, CodeB2CResultMalformed)
		if err != nil {
			return ParsedB2CResult{}, err
		}
		if amountRaw, has := itemsMap["TransactionAmount"]; has {
			amountStr, ok := numberOrDecimalString(amountRaw)
			if !ok {
				return ParsedB2CResult{}, errf(CodeB2CResultMalformed, "TransactionAmount must be a number or string")
			}
			amountMinor, err = parseWireAmountMinor(amountStr)
			if err != nil {
				return ParsedB2CResult{}, errf(CodeB2CResultMalformed, "TransactionAmount: %v", err)
			}
			hasAmount = true
		}
	}

	return ParsedB2CResult{
		Kind:                     KindB2CResult,
		JourneyKey:               "b2c:" + transactionID,
		TransactionID:            transactionID,
		ConversationID:           conversationID,
		OriginatorConversationID: originatorID,
		ResultCode:               resultCode,
		Success:                  resultCode == 0,
		AmountMinor:              amountMinor,
		HasAmount:                hasAmount,
	}, nil
}

// metadataItemsToMap flattens Item entries (Name/Value) into a map, refusing
// malformed items with the caller's code (mirrors metadataItemsToMap).
func metadataItemsToMap(items []any, code string) (map[string]any, error) {
	m := make(map[string]any, len(items))
	for i, itemRaw := range items {
		item, ok := itemRaw.(map[string]any)
		if !ok {
			return nil, errf(code, "metadata item %d must be an object", i)
		}
		name, ok := item["Name"].(string)
		if !ok || strings.TrimSpace(name) == "" {
			return nil, errf(code, "every metadata item needs a Name")
		}
		if value, hasValue := item["Value"]; hasValue {
			m[name] = value
		}
	}
	return m, nil
}

// stringField extracts an optional string field (” when absent/other).
func stringField(p map[string]any, key string) string {
	s, _ := p[key].(string)
	return s
}
