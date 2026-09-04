package infra

import "fmt"

// DomainError is the port of src/domain/shared/errors.ts — the only error
// type the domain and application layers produce. Every failure carries a
// stable SCREAMING_SNAKE machine code (the transport maps it onto the §38
// error envelope via transport.StatusForCode; unmapped codes fail closed to
// 500) plus optional structured details.
type DomainError struct {
	Code    string
	Message string
	Details map[string]any
}

// Error implements error as "<code>: <message>".
func (e *DomainError) Error() string { return e.Code + ": " + e.Message }

// NewDomainError builds a DomainError with optional details.
func NewDomainError(code, message string, details map[string]any) *DomainError {
	return &DomainError{Code: code, Message: message, Details: details}
}

// DomainErrorf builds a DomainError with a formatted message.
func DomainErrorf(code, format string, args ...any) *DomainError {
	return &DomainError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// DomainErrorOf returns err as *DomainError when it is one, else nil.
func DomainErrorOf(err error) (*DomainError, bool) {
	de, ok := err.(*DomainError)
	return de, ok
}

// The stable machine codes the infra layer itself references. Everything
// else flows through as the domain/application codes the transport maps via
// its status table (unmapped codes fail closed to 500).
const (
	// CodeInternal is the fail-closed 500 code — internals never leak.
	CodeInternal = "HTTP_INTERNAL_ERROR"
	// CodeUnauthenticated is the 401 code for missing/invalid credentials.
	CodeUnauthenticated = "HTTP_UNAUTHENTICATED"
)
