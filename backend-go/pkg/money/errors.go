package money

import "fmt"

// Stable machine codes for every failure pkg/money can produce. The codes are
// SCREAMING_SNAKE_CASE and mirror the TypeScript DomainError families in
// src/domain/shared/money.ts (the behavioral specification) one-for-one, so
// adapters can map Go and TS failures identically:
//
//	MONEY_NOT_INTEGER        — TS MONEY_NOT_INTEGER (unreachable in Go: the
//	                           int64 constructor signature makes non-integer
//	                           minor units unrepresentable; kept for code-table
//	                           parity and future string/float adapters)
//	MONEY_NEGATIVE           — TS MONEY_NEGATIVE
//	MONEY_UNPARSEABLE        — TS MONEY_UNPARSEABLE
//	CURRENCY_MISMATCH        — TS CURRENCY_MISMATCH
//	UNDERFLOW                — TS UNDERFLOW
//	ALLOCATION_EMPTY         — TS ALLOCATION_EMPTY
//	ALLOCATION_WEIGHT_INVALID      — TS ALLOCATION_WEIGHT_INVALID
//	ALLOCATION_WEIGHTS_SUM_ZERO    — TS ALLOCATION_WEIGHTS_SUM_ZERO
//	MONEY_OVERFLOW           — Go-only: int64 minor-unit overflow. TypeScript
//	                           amounts are bigints and cannot overflow; Go
//	                           int64 can, so the failure is typed instead of
//	                           silently wrapping.
//	MONEY_CURRENCY_INVALID   — Go-only: the TS currency union is enforced at
//	                           compile time; Go enforces the same ISO 4217 set
//	                           at construction time.
//	MONEY_DIVISION_INVALID   — Go-only guard for RoundBankers/MulDivBankers
//	                           (denominator must be > 0).
const (
	CodeNotInteger       = "MONEY_NOT_INTEGER"
	CodeNegative         = "MONEY_NEGATIVE"
	CodeUnparseable      = "MONEY_UNPARSEABLE"
	CodeCurrencyMismatch = "CURRENCY_MISMATCH"
	CodeUnderflow        = "UNDERFLOW"
	CodeAllocationEmpty  = "ALLOCATION_EMPTY"
	CodeWeightInvalid    = "ALLOCATION_WEIGHT_INVALID"
	CodeWeightsSumZero   = "ALLOCATION_WEIGHTS_SUM_ZERO"
	CodeOverflow         = "MONEY_OVERFLOW"
	CodeCurrencyInvalid  = "MONEY_CURRENCY_INVALID"
	CodeDivisionInvalid  = "MONEY_DIVISION_INVALID"
)

// Sentinel errors — one per stable code. Callers match failures with
// errors.Is(err, money.ErrUnderflow) or by comparing Error.Code; every
// *Error returned by this package reports the same Code as its sentinel, so
// both styles are always equivalent.
var (
	// ErrNotInteger mirrors TS MONEY_NOT_INTEGER. Unreachable through the
	// int64-only Go API; exported so the code table (and adapters that accept
	// untyped input) can match it.
	ErrNotInteger = &Error{Code: CodeNotInteger, Message: "minor units must be an integer"}
	// ErrNegative mirrors TS MONEY_NEGATIVE: money cannot be negative.
	ErrNegative = &Error{Code: CodeNegative, Message: "money cannot be negative"}
	// ErrUnparseable mirrors TS MONEY_UNPARSEABLE.
	ErrUnparseable = &Error{Code: CodeUnparseable, Message: "cannot parse money"}
	// ErrCurrencyMismatch mirrors TS CURRENCY_MISMATCH (R10: single-currency
	// arithmetic).
	ErrCurrencyMismatch = &Error{Code: CodeCurrencyMismatch, Message: "currencies differ"}
	// ErrUnderflow mirrors TS UNDERFLOW: subtracting more than available.
	ErrUnderflow = &Error{Code: CodeUnderflow, Message: "amount exceeds available"}
	// ErrAllocationEmpty mirrors TS ALLOCATION_EMPTY.
	ErrAllocationEmpty = &Error{Code: CodeAllocationEmpty, Message: "at least one weight is required"}
	// ErrWeightInvalid mirrors TS ALLOCATION_WEIGHT_INVALID.
	ErrWeightInvalid = &Error{Code: CodeWeightInvalid, Message: "weights must be finite and >= 0"}
	// ErrWeightsSumZero mirrors TS ALLOCATION_WEIGHTS_SUM_ZERO.
	ErrWeightsSumZero = &Error{Code: CodeWeightsSumZero, Message: "sum of weights must be > 0"}
	// ErrOverflow is Go-only: an int64 minor-unit result would overflow.
	ErrOverflow = &Error{Code: CodeOverflow, Message: "int64 minor-unit overflow"}
	// ErrCurrencyInvalid is Go-only: currency not in the ISO 4217 set the
	// platform accepts.
	ErrCurrencyInvalid = &Error{Code: CodeCurrencyInvalid, Message: "unsupported currency"}
	// ErrDivisionInvalid is Go-only: a rounding denominator must be > 0.
	ErrDivisionInvalid = &Error{Code: CodeDivisionInvalid, Message: "denominator must be > 0"}
)

// Error is the only error type pkg/money produces. It carries a stable
// machine Code (see the Code* constants) plus a human Message, mirroring the
// TypeScript DomainError so adapters can map failures to API responses
// without string matching. Errors are values: match them with errors.Is
// against the sentinel vars, or compare Code directly.
type Error struct {
	// Code is the stable SCREAMING_SNAKE_CASE machine code.
	Code string
	// Message is the human-readable context (amounts, currencies involved).
	Message string
}

// Error implements the error interface as "<code>: <message>" so codes are
// always visible in logs and test output.
func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

// Is makes every *Error with the same Code match its sentinel, so
// errors.Is(err, money.ErrUnderflow) is true for any UNDERFLOW failure
// regardless of the contextual message. Non-*Error targets never match.
func (e *Error) Is(target error) bool {
	if t, ok := target.(*Error); ok {
		return t.Code == e.Code
	}
	return false
}

// newError builds a contextual *Error for the given stable code. The message
// is formatted eagerly (fmt.Sprintf semantics).
func newError(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
