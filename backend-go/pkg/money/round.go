package money

import "math/big"

// Banker's rounding — the exact port of divideBankers (src/domain/shared/fx.ts,
// re-declared in src/domain/crossborder/fees.ts): the ONLY rounding rule of
// the FX and fee pipelines. Exact halves go to the EVEN neighbour, so
// rounding is drift-free and deterministic (15.5 → 16, 14.5 → 14, 15.4 → 15).
// Fee computation uses it at exactly ONE point: bpsMinor =
// RoundBankers(amount × bps, 10 000) — see MulDivBankers.

// RoundBankers rounds the exact non-negative rational numer/denom to the
// nearest integer with banker's rounding (exact halves to the even
// neighbour). It is the Go twin of divideBankers and, like it, must be the
// single rounding point of any pipeline that uses it. Refusals:
// MONEY_DIVISION_INVALID (denom <= 0), MONEY_NEGATIVE (numer < 0),
// MONEY_OVERFLOW (result does not fit int64).
func RoundBankers(numer, denom int64) (int64, error) {
	if denom <= 0 {
		return 0, newError(CodeDivisionInvalid, "denominator must be > 0, got %d", denom)
	}
	if numer < 0 {
		return 0, newError(CodeNegative, "numerator cannot be negative, got %d", numer)
	}
	result := bankersRoundBig(new(big.Int).SetInt64(numer), new(big.Int).SetInt64(denom))
	if !result.IsInt64() {
		return 0, newError(CodeOverflow, "rounded result overflows int64: %s / %d", result, denom)
	}
	return result.Int64(), nil
}

// MulDivBankers computes amount × factor / divisor exactly (math/big holds
// the full product, so intermediate overflow is impossible even though
// amount × factor alone would exceed int64) and rounds the rational ONCE
// with banker's rounding. This is the fee-parity primitive: the TS fee lane
// computes bpsMinor as divideBankers(amountMinor × bps, 10 000) — ONE
// rounding point, never re-rounded. Refusals: MONEY_DIVISION_INVALID
// (divisor <= 0), MONEY_NEGATIVE (negative amount or factor), MONEY_OVERFLOW
// (rounded result does not fit int64).
func MulDivBankers(amount, factor, divisor int64) (int64, error) {
	if divisor <= 0 {
		return 0, newError(CodeDivisionInvalid, "divisor must be > 0, got %d", divisor)
	}
	if amount < 0 || factor < 0 {
		return 0, newError(CodeNegative, "amount and factor must be >= 0, got %d and %d", amount, factor)
	}
	product := new(big.Int).Mul(new(big.Int).SetInt64(amount), new(big.Int).SetInt64(factor))
	result := bankersRoundBig(product, new(big.Int).SetInt64(divisor))
	if !result.IsInt64() {
		return 0, newError(CodeOverflow, "rounded result overflows int64: %d × %d / %d", amount, factor, divisor)
	}
	return result.Int64(), nil
}

// bankersRoundBig rounds the exact non-negative rational p/q (caller
// guarantees p >= 0, q > 0) to the nearest integer, halves to even — the
// direct big.Int translation of divideBankers' "twice" comparison:
//
//	2·rem > q  ⟺  rem > q − rem  → up
//	2·rem < q  ⟺  rem < q − rem  → down
//	2·rem == q ⟺  rem == q − rem → half → even neighbour
//
// (comparing rem with q−rem instead of doubling rem keeps every intermediate
// inside the operand domain — no overflow windows).
func bankersRoundBig(p, q *big.Int) *big.Int {
	whole, rem := new(big.Int).QuoRem(p, q, new(big.Int))
	other := new(big.Int).Sub(q, rem)
	cmp := rem.Cmp(other)
	switch {
	case rem.Sign() == 0 || cmp < 0:
		return whole
	case cmp > 0:
		return new(big.Int).Add(whole, big.NewInt(1))
	default: // exact half — go to the even neighbour
		if whole.Bit(0) == 0 {
			return whole
		}
		return new(big.Int).Add(whole, big.NewInt(1))
	}
}
