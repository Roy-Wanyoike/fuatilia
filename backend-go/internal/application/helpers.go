package application

import "strconv"

// strPtrOf renders an optional string ("" → NULL at the persistence layer).
func strPtrOf(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// itoa is strconv-based decimal rendering for message/payload composition.
func itoa(n int64) string { return strconv.FormatInt(n, 10) }
