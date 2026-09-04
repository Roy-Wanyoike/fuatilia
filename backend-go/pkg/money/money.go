// Package money is the Go production port of src/domain/shared/money.ts —
// the exact money primitive every financial module builds on.
//
// Rules (docs/07-invariants.md R10, mirrored from the TypeScript domain):
//   - floats are BANNED from ledger math: amounts are int64 minor units
//     (cents); the only float ever accepted is an allocation WEIGHT, which is
//     scaled to an exact rational and never touches an amount;
//   - money is non-negative: postings carry direction (debit/credit) in the
//     ledger module, so a negative Money is always a modelling bug and is
//     refused as a typed error;
//   - cross-currency arithmetic is forbidden (CURRENCY_MISMATCH); allocation
//     splits, it never converts (FX is a separate concern);
//   - allocation (largest remainder) is cent-exact: sum(parts) === original,
//     no cent is ever created or destroyed (R1/R2 depend on this).
//
// Parity contract: every error code, refusal and allocation result matches
// the TypeScript specification; pkg/money/conformance_test.go proves it
// against the TS scenario tables with identical inputs and expected outputs.
package money

import (
	"math"
	"math/big"
	"math/bits"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Currency is an ISO 4217 alphabetic currency code (e.g. KES). The accepted
// set is the same closed list as the TypeScript CURRENCIES tuple; TypeScript
// enforces it at compile time via a string-literal union, Go enforces it at
// construction time (MONEY_CURRENCY_INVALID).
type Currency string

// The currencies the platform accepts, in the canonical TS order.
const (
	KES Currency = "KES"
	USD Currency = "USD"
	GBP Currency = "GBP"
	EUR Currency = "EUR"
	TZS Currency = "TZS"
	UGX Currency = "UGX"
)

// Currencies lists every accepted currency in the canonical order of the TS
// CURRENCIES tuple. Callers must treat it as read-only.
var Currencies = []Currency{KES, USD, GBP, EUR, TZS, UGX}

// IsValidCurrency reports whether c is one of the platform currencies.
func IsValidCurrency(c Currency) bool {
	for _, known := range Currencies {
		if known == c {
			return true
		}
	}
	return false
}

// Money is an immutable amount in integer minor units (cents) of one
// currency. The zero value is NOT valid — always construct through New,
// Zero or Parse so the currency and non-negativity invariants hold. Amounts
// are int64: arithmetic is overflow-checked (math/bits) and every violation
// is a typed *Error, never a panic and never a wrapped int64.
type Money struct {
	amount   int64
	currency Currency
}

// New builds Money from non-negative integer minor units, mirroring
// Money.ofMinor in the TS domain. Refusals: MONEY_NEGATIVE (amount < 0),
// MONEY_CURRENCY_INVALID (currency not in Currencies).
func New(amount int64, currency Currency) (Money, error) {
	if amount < 0 {
		return Money{}, newError(CodeNegative, "money cannot be negative, got %d", amount)
	}
	if err := validateCurrency(currency); err != nil {
		return Money{}, err
	}
	return Money{amount: amount, currency: currency}, nil
}

// Zero builds 0 minor units of currency, mirroring Money.zero. Refusal:
// MONEY_CURRENCY_INVALID.
func Zero(currency Currency) (Money, error) {
	if err := validateCurrency(currency); err != nil {
		return Money{}, err
	}
	return Money{amount: 0, currency: currency}, nil
}

// parseRe mirrors the TS parse grammar exactly: an unsigned integer with no
// leading zeros, optionally followed by 1–2 decimal places.
var parseRe = regexp.MustCompile(`^(0|[1-9]\d*)(?:\.(\d{1,2}))?$`)

// Parse converts a human decimal string like "1250.50" into Money without
// float drift, mirroring Money.parse. Leading/trailing whitespace is trimmed
// (the TS implementation trims too). Refusals: MONEY_UNPARSEABLE,
// MONEY_OVERFLOW (the value does not fit int64 minor units — TS bigints
// accept arbitrarily large values; Go types the bound instead),
// MONEY_CURRENCY_INVALID.
func Parse(text string, currency Currency) (Money, error) {
	m := parseRe.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return Money{}, newError(CodeUnparseable, "cannot parse money: %s", text)
	}
	whole, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil {
		// The regex guarantees digits only, so the only failure is range.
		return Money{}, newError(CodeOverflow, "cannot parse money: %s exceeds int64 minor units", text)
	}
	cents := 0
	if m[2] != "" {
		// TS pads the fraction to 2 places then reads it as an integer:
		// "5" → 50, "50" → 50, "09" → 9.
		cents = int(m[2][0]-'0') * 10
		if len(m[2]) == 2 {
			cents += int(m[2][1] - '0')
		}
	}
	if whole > uint64(math.MaxInt64-cents)/100 {
		return Money{}, newError(CodeOverflow, "cannot parse money: %s exceeds int64 minor units", text)
	}
	if err := validateCurrency(currency); err != nil {
		return Money{}, err
	}
	return Money{amount: int64(whole)*100 + int64(cents), currency: currency}, nil
}

// Amount returns the minor units (always >= 0).
func (m Money) Amount() int64 { return m.amount }

// Currency returns the ISO 4217 currency of this Money.
func (m Money) Currency() Currency { return m.currency }

// IsZero reports whether the amount is exactly 0.
func (m Money) IsZero() bool { return m.amount == 0 }

// IsPositive reports whether the amount is > 0.
func (m Money) IsPositive() bool { return m.amount > 0 }

// Add returns m + other in m's currency, mirroring Money.add. Both operands
// must be non-negative (invariant of construction), so the only arithmetic
// failure is int64 overflow, detected via math/bits carry. Refusals:
// CURRENCY_MISMATCH (R10), MONEY_OVERFLOW.
func (m Money) Add(other Money) (Money, error) {
	if m.currency != other.currency {
		return Money{}, newError(CodeCurrencyMismatch, "cannot add %s with %s", m.currency, other.currency)
	}
	lo, carry := bits.Add64(uint64(m.amount), uint64(other.amount), 0)
	// Operands are non-negative, so the sum overflows int64 exactly when it
	// reaches 2^63 — visible as the top bit of the uint64 sum (carry-out of
	// the 64-bit add can never fire for two values below 2^63, the explicit
	// bounds check is the real gate).
	if carry != 0 || lo > uint64(math.MaxInt64) {
		return Money{}, newError(CodeOverflow, "addition overflows int64 minor units: %d + %d", m.amount, other.amount)
	}
	return Money{amount: int64(lo), currency: m.currency}, nil
}

// Subtract returns m − other, mirroring Money.subtract: UNDERFLOW instead of
// a negative Money. Both operands are non-negative and other ≤ m on success,
// so the subtraction itself cannot overflow. Refusals: CURRENCY_MISMATCH
// (R10), UNDERFLOW.
func (m Money) Subtract(other Money) (Money, error) {
	if m.currency != other.currency {
		return Money{}, newError(CodeCurrencyMismatch, "cannot subtract %s with %s", m.currency, other.currency)
	}
	if other.amount > m.amount {
		return Money{}, newError(CodeUnderflow, "%d exceeds available %d", other.amount, m.amount)
	}
	return Money{amount: m.amount - other.amount, currency: m.currency}, nil
}

// MulInt scales m by a non-negative integer factor (exact integer
// multiplication, overflow-checked via math/bits — the TS domain has no
// multiply because bigints never overflow; Go types the failure instead).
// A negative factor is refused with MONEY_NEGATIVE (a negative result is
// always a modelling bug); factor 0 yields Zero. Refusals: MONEY_NEGATIVE,
// MONEY_OVERFLOW.
func (m Money) MulInt(factor int64) (Money, error) {
	if factor < 0 {
		return Money{}, newError(CodeNegative, "money cannot be negative: %d × %d would be negative", m.amount, factor)
	}
	hi, lo := bits.Mul64(uint64(m.amount), uint64(factor))
	// Non-negative operands: the int64 product overflows iff the full 128-bit
	// product leaves the top (63rd) bit zero — hi != 0 means ≥ 2^64, the lo
	// bounds check catches 2^63 … 2^64−1.
	if hi != 0 || lo > uint64(math.MaxInt64) {
		return Money{}, newError(CodeOverflow, "multiplication overflows int64 minor units: %d × %d", m.amount, factor)
	}
	return Money{amount: int64(lo), currency: m.currency}, nil
}

// Compare returns −1, 0 or 1 comparing m against other in minor units,
// mirroring Money.compareTo. Refusal: CURRENCY_MISMATCH (R10).
func (m Money) Compare(other Money) (int, error) {
	if m.currency != other.currency {
		return 0, newError(CodeCurrencyMismatch, "cannot compare %s with %s", m.currency, other.currency)
	}
	switch {
	case m.amount < other.amount:
		return -1, nil
	case m.amount > other.amount:
		return 1, nil
	default:
		return 0, nil
	}
}

// Equals reports whether m and other carry the same amount, mirroring
// Money.equals — which THROWS on cross-currency input, so the refusal is
// surfaced as an error here too rather than silently returning false
// (a false "not equal" across currencies would corrupt reconciliation).
// Refusal: CURRENCY_MISMATCH (R10).
func (m Money) Equals(other Money) (bool, error) {
	cmp, err := m.Compare(other)
	if err != nil {
		return false, err
	}
	return cmp == 0, nil
}

// String renders the canonical TS format "whole.cents CUR" (e.g.
// "1250.50 KES"); cents are always two digits. The amount is non-negative by
// invariant, so no sign handling is needed.
func (m Money) String() string {
	return strconv.FormatInt(m.amount/100, 10) + "." + fmtCents(m.amount%100) + " " + string(m.currency)
}

func fmtCents(c int64) string {
	out := strconv.FormatInt(c, 10)
	if len(out) == 1 {
		out = "0" + out
	}
	return out
}

// Allocate splits m across weights using the largest-remainder method,
// mirroring Money.allocate. Guarantees (R1/R2 depend on all three):
//
//  1. sum(parts) === m — no cent is created or destroyed;
//  2. every part >= 0;
//  3. deterministic given identical inputs (remainder ties broken by the
//     smaller weight index).
//
// The weights are the ONE allowed float input: each is scaled to an exact
// rational at 1e9 precision (exactly the TS BigInt(Math.round(w * 1e9))
// scaling — same IEEE-754 product, same rounding), and all split arithmetic
// runs on math/big rationals, the Go twin of the TS bigint math. Refusals:
// ALLOCATION_EMPTY, ALLOCATION_WEIGHT_INVALID (negative / non-finite /
// out-of-range weights), ALLOCATION_WEIGHTS_SUM_ZERO (float sum <= 0, or the
// scaled sum rounds to zero — where the TS implementation would crash on a
// bigint division by zero, Go refuses as a typed error).
func (m Money) Allocate(weights []float64) ([]Money, error) {
	if len(weights) == 0 {
		return nil, newError(CodeAllocationEmpty, "at least one weight is required")
	}
	for _, w := range weights {
		if math.IsNaN(w) || math.IsInf(w, 0) || w < 0 {
			return nil, newError(CodeWeightInvalid, "weights must be finite and >= 0")
		}
	}
	var total float64
	for _, w := range weights {
		total += w
	}
	if total <= 0 {
		return nil, newError(CodeWeightsSumZero, "sum of weights must be > 0")
	}
	sumW, err := scaledWeight(total)
	if err != nil {
		return nil, err
	}
	if sumW.Sign() == 0 {
		// Hardening: total > 0 but so small that ×1e9 rounds to 0. TS would
		// panic on the bigint division by zero; Go refuses as a typed error.
		return nil, newError(CodeWeightsSumZero, "sum of weights must be > 0")
	}

	amount := new(big.Int).SetInt64(m.amount)
	type slot struct {
		index int
		base  *big.Int
		rem   *big.Int
	}
	raw := make([]slot, len(weights))
	distributed := new(big.Int)
	for i, w := range weights {
		scaled, err := scaledWeight(w)
		if err != nil {
			return nil, err
		}
		num := new(big.Int).Mul(amount, scaled)
		base, rem := new(big.Int).QuoRem(num, sumW, new(big.Int))
		raw[i] = slot{index: i, base: base, rem: rem}
		distributed.Add(distributed, base)
	}
	leftover := new(big.Int).Sub(amount, distributed)
	if !leftover.IsInt64() {
		return nil, newError(CodeOverflow, "allocation leftover overflows int64 minor units")
	}

	// Deterministic bump order: larger remainder first, ties by the smaller
	// index — the exact TS comparator.
	order := make([]slot, len(raw))
	copy(order, raw)
	sort.SliceStable(order, func(i, j int) bool {
		if c := order[i].rem.Cmp(order[j].rem); c != 0 {
			return c > 0
		}
		return order[i].index < order[j].index
	})
	bumped := make(map[int]bool, leftover.Int64())
	for i := int64(0); i < leftover.Int64() && int(i) < len(order); i++ {
		bumped[order[i].index] = true
	}

	parts := make([]Money, len(raw))
	distributed.SetInt64(0)
	for i, r := range raw {
		amt := r.base
		if bumped[i] {
			amt = new(big.Int).Add(amt, big.NewInt(1))
		}
		if !amt.IsInt64() {
			return nil, newError(CodeOverflow, "allocation part overflows int64 minor units")
		}
		parts[i] = Money{amount: amt.Int64(), currency: m.currency}
	}
	return parts, nil
}

// scaledWeight mirrors the TS scaling BigInt(Math.round(w * 1e9)): the
// float64 product and the round-half-away-from-zero are bit-identical to the
// JS semantics for every non-negative finite weight, and the resulting
// integer-valued float64 is converted to a big.Int exactly (any float64 is
// representable with a 53-bit mantissa). Refusal: ALLOCATION_WEIGHT_INVALID
// when the scaled value leaves the finite range (TS would crash converting
// Infinity to bigint).
func scaledWeight(f float64) (*big.Int, error) {
	r := math.Round(f * 1e9)
	if math.IsNaN(r) || math.IsInf(r, 0) {
		return nil, newError(CodeWeightInvalid, "weight %v scales out of representable range", f)
	}
	out, acc := new(big.Float).SetFloat64(r).Int(nil)
	if out == nil || acc != big.Exact {
		return nil, newError(CodeWeightInvalid, "weight %v scales out of representable range", f)
	}
	return out, nil
}

// validateCurrency enforces the closed ISO 4217 set (Go replacement for the
// TS compile-time currency union). Refusal: MONEY_CURRENCY_INVALID.
func validateCurrency(c Currency) error {
	if !IsValidCurrency(c) {
		return newError(CodeCurrencyInvalid,
			"unsupported currency %q (supported: KES, USD, GBP, EUR, TZS, UGX)", string(c))
	}
	return nil
}
