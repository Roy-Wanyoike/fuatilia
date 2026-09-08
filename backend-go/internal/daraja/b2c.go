// B2C payouts, transaction status queries and C2B URL registration
// (issue #96). B2C is an OUTFLOW shape: the result callback carries no intake
// command (no money enters the platform through it) — mirrored from the TS
// lane's `DarajaB2cPayload` semantics.
package daraja

import "context"

const (
	b2cPath         = "/mpesa/b2c/v3/paymentrequest"
	txStatusPath    = "/mpesa/transactionstatus/v1/query"
	c2bRegisterPath = "/mpesa/c2b/v1/registerurl"
)

// B2CInitiate requests a payout from the org's B2C credential set.
// AmountMinor MUST be whole shillings. Occasion/Remarks are the free-text
// fields Daraja requires on B2C.
type B2CInitiate struct {
	InitiatorName      string // API operator with B2C rights (env-injected credential context)
	SecurityCredential string // encrypted credential — NEVER logged (env-injected)
	CommandID          string // "BusinessPayment" | "SalaryPayment" | "PromotionPayment"
	AmountMinor        int64
	PartyB             string // recipient MSISDN 2547XXXXXXXX / 2541XXXXXXXX
	Remarks            string
	QueueTimeOutURL    string
	ResultURL          string
	Occasion           string
}

// B2CReceipt echoes the accepted payout request.
type B2CReceipt struct {
	OriginatorConversationID string
	ConversationID           string
	ResponseCode             string
	ResponseDescription      string
}

// TransactionStatusResult is the response of a status query.
type TransactionStatusResult struct {
	OriginatorConversationID string
	ConversationID           string
	ResponseCode             string
	ResponseDescription      string
}

// C2BRegistration points Daraja's C2B validation/confirmation at the org's
// endpoints. ValidationURL may be empty when validation is disabled.
type C2BRegistration struct {
	ShortCode       string
	ResponseType    string // "Completed" | "Cancelled"
	ConfirmationURL string
	ValidationURL   string
}

// receipts wire shapes.
type conversationWire struct {
	OriginatorConversationID string `json:"OriginatorConversationID"`
	ConversationID           string `json:"ConversationID"`
	ResponseCode             string `json:"ResponseCode"`
	ResponseDescription      string `json:"ResponseDescription"`
}

// InitiateB2C requests a payout. Double-click guard: concurrent identical
// requests collapse onto one wire call via the same in-flight map as STK.
func (c *Client) InitiateB2C(ctx context.Context, req B2CInitiate, idempotencyKey string) (B2CReceipt, error) {
	if req.InitiatorName == "" || req.SecurityCredential == "" {
		return B2CReceipt{}, errf(CodeConfigInvalid,
			"InitiatorName and SecurityCredential are required (env-injected, never logged)")
	}
	switch req.CommandID {
	case "BusinessPayment", "SalaryPayment", "PromotionPayment":
	default:
		return B2CReceipt{}, errf(CodeConfigInvalid,
			"CommandID %q must be BusinessPayment, SalaryPayment or PromotionPayment", req.CommandID)
	}
	amount, err := wholeShillings(req.AmountMinor)
	if err != nil {
		return B2CReceipt{}, err
	}
	if !isValidMSISDN(req.PartyB) {
		return B2CReceipt{}, errf(CodeMSISDNMalformed, "PartyB %q must be 2547XXXXXXXX or 2541XXXXXXXX", maskMSISDN(req.PartyB))
	}
	finish, lead := c.inflight.join("b2c:" + idempotencyKey)
	if !lead {
		finish()
		return B2CReceipt{}, errf(CodeDuplicateInFlight,
			"a B2C initiation with key %q is already in flight", safeKey(idempotencyKey))
	}
	defer finish()

	wire := map[string]any{
		"OriginatorConversationID": idempotencyKey, // merchant-chosen, traceable end-to-end
		"InitiatorName":            req.InitiatorName,
		"SecurityCredential":       req.SecurityCredential,
		"CommandID":                req.CommandID,
		"Amount":                   amount,
		"PartyA":                   req.InitiatorName, // org short code is bound to the credential
		"PartyB":                   req.PartyB,
		"Remarks":                  req.Remarks,
		"QueueTimeOutURL":          req.QueueTimeOutURL,
		"ResultURL":                req.ResultURL,
		"Occasion":                 req.Occasion,
	}
	var out conversationWire
	if err := c.callJSON(ctx, "POST", b2cPath, wire, &out); err != nil {
		return B2CReceipt{}, err
	}
	return B2CReceipt(out), nil
}

// QueryTransactionStatus asks Daraja about a transaction by its ID.
func (c *Client) QueryTransactionStatus(ctx context.Context, transactionID, initiator, securityCredential, resultURL string) (TransactionStatusResult, error) {
	if transactionID == "" {
		return TransactionStatusResult{}, errf(CodeTransIDRequired, "transaction id is required")
	}
	if !isValidTransID(transactionID) {
		return TransactionStatusResult{}, errf(CodeTransIDMalformed,
			"transaction id must be uppercase [A-Z0-9] (got %d chars)", len(transactionID))
	}
	if initiator == "" || securityCredential == "" {
		return TransactionStatusResult{}, errf(CodeConfigInvalid,
			"initiator and security credential are required (env-injected)")
	}
	wire := map[string]any{
		"Initiator":          initiator,
		"SecurityCredential": securityCredential,
		"CommandID":          "TransactionStatusQuery",
		"TransactionID":      transactionID,
		"PartyA":             initiator,
		"IdentifierType":     "4", // org short code
		"ResultURL":          resultURL,
		"QueueTimeOutURL":    resultURL,
		"Remarks":            "TransactionStatusQuery",
		"Occasion":           "TransactionStatusQuery",
	}
	var out conversationWire
	if err := c.callJSON(ctx, "POST", txStatusPath, wire, &out); err != nil {
		return TransactionStatusResult{}, err
	}
	return TransactionStatusResult(out), nil
}

// RegisterC2BURL points Daraja's C2B notifications at the org's endpoints.
func (c *Client) RegisterC2BURL(ctx context.Context, req C2BRegistration) error {
	if req.ShortCode == "" {
		return errf(CodeShortCodeMalformed, "short code is required")
	}
	if req.ResponseType != "Completed" && req.ResponseType != "Cancelled" {
		return errf(CodeConfigInvalid, "ResponseType %q must be Completed or Cancelled", req.ResponseType)
	}
	if req.ConfirmationURL == "" {
		return errf(CodeConfigInvalid, "ConfirmationURL is required")
	}
	wire := map[string]string{
		"ShortCode":       req.ShortCode,
		"ResponseType":    req.ResponseType,
		"ConfirmationURL": req.ConfirmationURL,
		"ValidationURL":   req.ValidationURL,
	}
	return c.callJSON(ctx, "POST", c2bRegisterPath, wire, nil)
}
