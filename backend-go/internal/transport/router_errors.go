package transport

import "errors"

// routeRegistrationError is the registration-time refusal type
// (kernel/errors.ts HTTP_ROUTE_PATTERN_INVALID / HTTP_ROUTE_DUPLICATE — both
// 500-class: a broken route table must fail composition, never the wire).
type routeRegistrationError struct{ msg string }

func (e *routeRegistrationError) Error() string { return e.msg }

func infraRoutePatternInvalid(reason string) error {
	return &routeRegistrationError{msg: "HTTP_ROUTE_PATTERN_INVALID: " + reason}
}

func infraRouteDuplicate(reason string) error {
	return &routeRegistrationError{msg: "HTTP_ROUTE_DUPLICATE: " + reason}
}

// IsRouteRegistrationError reports whether err came from compiling the
// route table (the composition root turns it into a hard boot failure).
func IsRouteRegistrationError(err error) bool {
	var e *routeRegistrationError
	return errors.As(err, &e)
}
