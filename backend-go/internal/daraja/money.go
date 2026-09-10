// Money boundary helpers (issue #96). The TS lane's `minorFromWireAmount`
// (src/adapters/daraja/wire.ts) parses decimal wire strings into bigint minor
// units without floats; this file ports exactly that discipline to Go's
// int64, plus the whole-shilling rule for initiation payloads.
package daraja

import (
	"regexp"
	"strings"
)

// wireDecimalPattern is the TS lane's DECIMAL_PATTERN one-for-one
// (`^(0|[1-9]\d*)(?:\.(\d{1,2}))?$`): at most 2 minor places, and the
// integer part is "0" or starts with a non-zero digit — so ".50", "2500."
// and "02500" are REFUSED, never coerced into money.
var wireDecimalPattern = regexp.MustCompile(`^(0|[1-9]\d*)(?:\.(\d{1,2}))?$`)

// parseWireAmountMinor parses a Daraja decimal amount string ("2500.00",
// "2500", "2500.5") into integer minor units (KES cents) WITHOUT any float
// arithmetic. Refusals carry DARAJA_AMOUNT_* codes; a negative, malformed or
// over-precise value is refused, never coerced.
func parseWireAmountMinor(raw string) (int64, error) {
	// Mirror the TS lane exactly: trim, then match DECIMAL_PATTERN — an empty
	// (or whitespace-only) input simply fails the pattern. The AMOUNT_REQUIRED
	// distinction belongs to the caller (a MISSING TransAmount), never here.
	s := strings.TrimSpace(raw)
	if strings.HasPrefix(s, "-") {
		return 0, errf(CodeAmountMalformed, "amount %q is negative — wire amounts are credits", raw)
	}
	m := wireDecimalPattern.FindStringSubmatch(s)
	if m == nil {
		return 0, errf(CodeAmountMalformed,
			"amount %q is not a decimal with at most 2 minor places (leading zeros and dangling points are refused)", raw)
	}
	// Whole shillings first, then shift into minor units with an overflow
	// check BEFORE the shift (the wire is KES; minor units are cents).
	var whole int64
	for _, c := range m[1] {
		d := int64(c - '0')
		if whole > ((1<<62)-d)/10 {
			return 0, errf(CodeAmountMalformed, "amount %q overflows minor units", raw)
		}
		whole = whole*10 + d
	}
	if whole > (1<<62)/100 {
		return 0, errf(CodeAmountMalformed, "amount %q overflows minor units", raw)
	}
	minor := whole * 100
	if frac := m[2]; frac != "" {
		if len(frac) == 1 {
			frac += "0"
		}
		minor += int64(frac[0]-'0')*10 + int64(frac[1]-'0')
	}
	return minor, nil
}

// wholeShillings converts minor units into the whole-shilling integer the
// STK/B2C initiation wire format requires. Daraja refuses decimal amounts on
// initiation; this client refuses a remainder instead of rounding — a
// silently rounded payment amount would be a financial lie.
func wholeShillings(amountMinor int64) (int64, error) {
	if amountMinor < 0 {
		return 0, errf(CodeAmountMalformed, "amount %d minor is negative", amountMinor)
	}
	if amountMinor%100 != 0 {
		return 0, errf(CodeAmountNotWholeShilling,
			"amount %d minor is not a whole shilling — Daraja initiation carries integer KES; refuse, never round", amountMinor)
	}
	return amountMinor / 100, nil
}

// minorToDecimalString renders minor units as the decimal string shape the
// callbacks use (e.g. 250000 -> "2500.00"), for logging and fixtures only.
func minorToDecimalString(minor int64) string {
	if minor < 0 {
		return "-" + minorToDecimalString(-minor)
	}
	return itoa(minor/100) + "." + pad2(minor%100)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

func pad2(v int64) string {
	s := itoa(v)
	if len(s) == 1 {
		return "0" + s
	}
	return s
}
