package money

import (
	"errors"
	"fmt"
	"math"
	"testing"
)

// mustMoney fails t on an unexpected constructor error, returning the Money.
func mustMoney(t *testing.T, m Money, err error) Money {
	t.Helper()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	return m
}

// mustNew is New with the error path collapsed for happy-path rows.
func mustNew(t *testing.T, amount int64, cur Currency) Money {
	t.Helper()
	m, err := New(amount, cur)
	return mustMoney(t, m, err)
}

// mustZero is Zero with the error path collapsed for happy-path rows.
func mustZero(t *testing.T, cur Currency) Money {
	t.Helper()
	m, err := Zero(cur)
	return mustMoney(t, m, err)
}

// mustKES is the KES money helper used across the unit tests.
func mustKES(t *testing.T, minor int64) Money {
	t.Helper()
	return mustNew(t, minor, KES)
}

// wantCode asserts err is a non-nil *Error with exactly the wanted code.
func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error %s, got nil", code)
	}
	var me *Error
	if !errors.As(err, &me) {
		t.Fatalf("expected *money.Error, got %T: %v", err, err)
	}
	if me.Code != code {
		t.Fatalf("expected code %s, got %s (%v)", code, me.Code, err)
	}
}

func TestNew(t *testing.T) {
	t.Run("accepts non-negative minor units", func(t *testing.T) {
		m := mustNew(t, 1250, KES)
		if m.Amount() != 1250 || m.Currency() != KES {
			t.Fatalf("got %v", m)
		}
		if !mustNew(t, 0, KES).IsZero() {
			t.Fatal("zero amount must be zero")
		}
		max := mustNew(t, math.MaxInt64, UGX)
		if max.Amount() != math.MaxInt64 {
			t.Fatalf("MaxInt64 amount lost: %d", max.Amount())
		}
	})

	t.Run("refuses negative amounts (MONEY_NEGATIVE)", func(t *testing.T) {
		_, err := New(-1, KES)
		wantCode(t, err, CodeNegative)
		if !errors.Is(err, ErrNegative) {
			t.Fatal("errors.Is(ErrNegative) failed")
		}
	})

	t.Run("refuses unknown currencies (MONEY_CURRENCY_INVALID)", func(t *testing.T) {
		for _, cur := range []Currency{"XYZ", "", "kes", "KES1"} {
			_, err := New(1, cur)
			wantCode(t, err, CodeCurrencyInvalid)
			if !errors.Is(err, ErrCurrencyInvalid) {
				t.Fatalf("errors.Is(ErrCurrencyInvalid) failed for %q", cur)
			}
		}
	})

	t.Run("accepts every platform currency", func(t *testing.T) {
		for _, cur := range Currencies {
			if _, err := New(1, cur); err != nil {
				t.Fatalf("currency %s refused: %v", cur, err)
			}
		}
	})
}

func TestZero(t *testing.T) {
	if !mustZero(t, KES).IsZero() {
		t.Fatal("Zero(KES) is not zero")
	}
	_, err := Zero("XYZ")
	wantCode(t, err, CodeCurrencyInvalid)
}

func TestParse(t *testing.T) {
	t.Run("parses decimal strings without float drift", func(t *testing.T) {
		tests := []struct {
			text string
			want int64
		}{
			{"1250.50", 125050},
			{"1250.5", 125050}, // TS pads the fraction: "5" → "50"
			{"0.99", 99},
			{"0.09", 9},
			{"42", 4200},
			{"0", 0},
			{"0.00", 0},
			{"  1250.50  ", 125050}, // trimmed, exactly like TS
		}
		for _, tc := range tests {
			m, err := Parse(tc.text, KES)
			if err != nil {
				t.Fatalf("Parse(%q): %v", tc.text, err)
			}
			if m.Amount() != tc.want {
				t.Fatalf("Parse(%q) = %d, want %d", tc.text, m.Amount(), tc.want)
			}
		}
	})

	t.Run("refuses junk (MONEY_UNPARSEABLE)", func(t *testing.T) {
		for _, text := range []string{"", "abc", "-5", "1.005", "1,250.50", ".50", "01.00", "1250.", "1.5.0", "1e3"} {
			_, err := Parse(text, KES)
			wantCode(t, err, CodeUnparseable)
			if !errors.Is(err, ErrUnparseable) {
				t.Fatalf("errors.Is(ErrUnparseable) failed for %q", text)
			}
		}
	})

	t.Run("refuses values beyond int64 minor units (MONEY_OVERFLOW)", func(t *testing.T) {
		tests := []string{
			"92233720368547758.08",  // one cent past MaxInt64
			"999999999999999999999", // far past
		}
		for _, text := range tests {
			_, err := Parse(text, KES)
			wantCode(t, err, CodeOverflow)
		}
		if _, err := Parse("92233720368547758.07", KES); err != nil {
			t.Fatalf("MaxInt64 minor units must parse exactly: %v", err)
		}
	})

	t.Run("refuses unknown currency (MONEY_CURRENCY_INVALID)", func(t *testing.T) {
		_, err := Parse("1.00", "XYZ")
		wantCode(t, err, CodeCurrencyInvalid)
	})
}

func TestAdd(t *testing.T) {
	t.Run("adds same-currency amounts", func(t *testing.T) {
		got, err := mustKES(t, 100).Add(mustKES(t, 23))
		if err != nil || got.Amount() != 123 {
			t.Fatalf("got %v, %v", got, err)
		}
	})

	t.Run("zero is the additive identity", func(t *testing.T) {
		got, err := mustKES(t, 100).Add(mustZero(t, KES))
		if err != nil || got.Amount() != 100 {
			t.Fatalf("got %v, %v", got, err)
		}
	})

	t.Run("refuses cross-currency arithmetic (CURRENCY_MISMATCH)", func(t *testing.T) {
		kes := mustKES(t, 100)
		usd := mustNew(t, 100, USD)
		_, err := kes.Add(usd)
		wantCode(t, err, CodeCurrencyMismatch)
		if !errors.Is(err, ErrCurrencyMismatch) {
			t.Fatal("errors.Is(ErrCurrencyMismatch) failed")
		}
	})

	t.Run("refuses int64 overflow (MONEY_OVERFLOW)", func(t *testing.T) {
		max := mustKES(t, math.MaxInt64)
		one := mustKES(t, 1)
		_, err := max.Add(one)
		wantCode(t, err, CodeOverflow)
		if !errors.Is(err, ErrOverflow) {
			t.Fatal("errors.Is(ErrOverflow) failed")
		}
		if got, err := max.Add(mustZero(t, KES)); err != nil || got.Amount() != math.MaxInt64 {
			t.Fatalf("MaxInt64 + 0 must stay MaxInt64: %v %v", got, err)
		}
	})
}

func TestSubtract(t *testing.T) {
	t.Run("subtracts same-currency amounts", func(t *testing.T) {
		got, err := mustKES(t, 51).Subtract(mustKES(t, 50))
		if err != nil || got.Amount() != 1 {
			t.Fatalf("got %v, %v", got, err)
		}
		if got, err := mustKES(t, 50).Subtract(mustKES(t, 50)); err != nil || !got.IsZero() {
			t.Fatalf("x − x must be zero: %v %v", got, err)
		}
	})

	t.Run("throws UNDERFLOW instead of going negative", func(t *testing.T) {
		_, err := mustKES(t, 50).Subtract(mustKES(t, 51))
		wantCode(t, err, CodeUnderflow)
		if !errors.Is(err, ErrUnderflow) {
			t.Fatal("errors.Is(ErrUnderflow) failed")
		}
	})

	t.Run("refuses cross-currency arithmetic (CURRENCY_MISMATCH)", func(t *testing.T) {
		_, err := mustKES(t, 50).Subtract(mustNew(t, 50, USD))
		wantCode(t, err, CodeCurrencyMismatch)
	})
}

func TestMulInt(t *testing.T) {
	tests := []struct {
		name   string
		amount int64
		factor int64
		want   int64
	}{
		{"zero times anything is zero", 12345, 0, 0},
		{"identity", 12345, 1, 12345},
		{"scale up", 333, 3, 999},
		{"MaxInt64 by one", math.MaxInt64, 1, math.MaxInt64},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := mustKES(t, tc.amount).MulInt(tc.factor)
			if err != nil || got.Amount() != tc.want {
				t.Fatalf("got %v, %v; want %d", got, err, tc.want)
			}
		})
	}

	t.Run("refuses negative factors (MONEY_NEGATIVE)", func(t *testing.T) {
		_, err := mustKES(t, 10).MulInt(-1)
		wantCode(t, err, CodeNegative)
		if !errors.Is(err, ErrNegative) {
			t.Fatal("errors.Is(ErrNegative) failed")
		}
	})

	t.Run("refuses overflow (MONEY_OVERFLOW)", func(t *testing.T) {
		_, err := mustKES(t, math.MaxInt64/2+1).MulInt(2)
		wantCode(t, err, CodeOverflow)
		if !errors.Is(err, ErrOverflow) {
			t.Fatal("errors.Is(ErrOverflow) failed")
		}
	})
}

func TestCompareAndEquals(t *testing.T) {
	t.Run("orders by minor units", func(t *testing.T) {
		cases := []struct {
			a, b int64
			want int
		}{
			{100, 200, -1},
			{200, 100, 1},
			{100, 100, 0},
			{0, 1, -1},
		}
		for _, tc := range cases {
			got, err := mustKES(t, tc.a).Compare(mustKES(t, tc.b))
			if err != nil || got != tc.want {
				t.Fatalf("Compare(%d,%d) = %d, %v; want %d", tc.a, tc.b, got, err, tc.want)
			}
		}
	})

	t.Run("equals mirrors compareTo semantics", func(t *testing.T) {
		eq, err := mustKES(t, 100).Equals(mustKES(t, 100))
		if err != nil || !eq {
			t.Fatalf("equal amounts: %v, %v", eq, err)
		}
		eq, err = mustKES(t, 100).Equals(mustKES(t, 101))
		if err != nil || eq {
			t.Fatalf("unequal amounts: %v, %v", eq, err)
		}
	})

	t.Run("refuses cross-currency comparison (CURRENCY_MISMATCH)", func(t *testing.T) {
		if _, err := mustKES(t, 100).Compare(mustNew(t, 100, USD)); err == nil {
			t.Fatal("cross-currency compare must fail")
		}
		// TS equals() throws on cross-currency too — no silent false.
		_, err := mustKES(t, 100).Equals(mustNew(t, 100, USD))
		wantCode(t, err, CodeCurrencyMismatch)
	})
}

func TestString(t *testing.T) {
	tests := []struct {
		minor int64
		cur   Currency
		want  string
	}{
		{125050, KES, "1250.50 KES"},
		{99, KES, "0.99 KES"},
		{5, KES, "0.05 KES"},
		{0, KES, "0.00 KES"},
		{4200, USD, "42.00 USD"},
	}
	for _, tc := range tests {
		got := mustNew(t, tc.minor, tc.cur).String()
		if got != tc.want {
			t.Fatalf("String(%d %s) = %q, want %q", tc.minor, tc.cur, got, tc.want)
		}
	}
}

func TestAllocateErrors(t *testing.T) {
	tests := []struct {
		name     string
		amount   int64
		weights  []float64
		wantCode string
	}{
		{"empty weights", 10, []float64{}, CodeAllocationEmpty},
		{"nil weights", 10, nil, CodeAllocationEmpty},
		{"negative weight", 10, []float64{1, -0.5}, CodeWeightInvalid},
		{"NaN weight", 10, []float64{1, math.NaN()}, CodeWeightInvalid},
		{"+Inf weight", 10, []float64{math.Inf(1)}, CodeWeightInvalid},
		{"all-zero weights", 10, []float64{0, 0}, CodeWeightsSumZero},
		{"weights scaling to zero (TS would divide bigint by zero)", 10, []float64{1e-11}, CodeWeightsSumZero},
		{"weight scaling beyond range (TS would throw on BigInt(Infinity))", 10, []float64{1e300}, CodeWeightInvalid},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := mustKES(t, tc.amount).Allocate(tc.weights)
			wantCode(t, err, tc.wantCode)
		})
	}
}

func TestAllocateGuarantees(t *testing.T) {
	weightSets := [][]float64{
		{1},
		{1, 1, 1},
		{1, 2, 4},
		{0.3, 0.3, 0.4},
		{500, 300, 300},
		{3, 2},
		{1, 1, 1, 1, 1, 1, 1},
		{0.5, 0.5},
		{7, 0, 3},
	}
	amounts := []int64{0, 1, 2, 7, 100, 999, 12_345, 1_000_000_007, math.MaxInt64 / 3}
	for _, amount := range amounts {
		for _, weights := range weightSets {
			parts, err := mustKES(t, amount).Allocate(weights)
			if err != nil {
				t.Fatalf("Allocate(%d, %v): %v", amount, weights, err)
			}
			if len(parts) != len(weights) {
				t.Fatalf("got %d parts, want %d", len(parts), len(weights))
			}
			sum := mustZero(t, KES)
			for _, p := range parts {
				if p.Amount() < 0 {
					t.Fatalf("negative part %d for %d over %v", p.Amount(), amount, weights)
				}
				next, err := sum.Add(p)
				if err != nil {
					t.Fatalf("part sum overflow: %v", err)
				}
				sum = next
			}
			if sum.Amount() != amount {
				t.Fatalf("R1/R2 violated: sum(parts) = %d, want %d (%v over %v)", sum.Amount(), amount, amount, weights)
			}
			again, err := mustKES(t, amount).Allocate(weights)
			if err != nil {
				t.Fatalf("replay Allocate(%d, %v): %v", amount, weights, err)
			}
			for i := range parts {
				if parts[i] != again[i] {
					t.Fatalf("non-deterministic: %v vs %v", parts, again)
				}
			}
		}
	}
}

// The TS-derived banker's-rounding parity pins (crossborder/fees.spec.ts and
// crossborder/quote.spec.ts) live in conformance_test.go with the full TS
// mapping header. This test covers the Go-only guard rows.
func TestRoundBankers(t *testing.T) {
	tests := []struct {
		name         string
		numer, denom int64
		want         int64
		wantErr      string
	}{
		{"zero denominator", 1, 0, 0, CodeDivisionInvalid},
		{"negative denominator", 1, -2, 0, CodeDivisionInvalid},
		{"negative numerator", -1, 2, 0, CodeNegative},
		{"MaxInt64 exact", math.MaxInt64, 1, math.MaxInt64, ""},
		{"half up at the top still fits", math.MaxInt64, 2, 4_611_686_018_427_387_904, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := RoundBankers(tc.numer, tc.denom)
			if tc.wantErr != "" {
				wantCode(t, err, tc.wantErr)
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("RoundBankers(%d,%d) = %d, want %d", tc.numer, tc.denom, got, tc.want)
			}
		})
	}
}

func TestMulDivBankers(t *testing.T) {
	// Ported from src/domain/crossborder/fees.spec.ts "computes bps-only fees
	// with ONE banker's rounding (rounding-edge table)": bps component =
	// amount × 1 bps / 10 000, one banker's rounding.
	tests := []struct {
		amount   int64
		expected int64
	}{
		{25_000, 2},       // 2.5 → 2 (even)
		{75_000, 8},       // 7.5 → 8 (even up)
		{5_000, 0},        // 0.5 → 0 (even)
		{15_000, 2},       // 1.5 → 2
		{1, 0},            // 0.0001 → 0
		{9_999_999, 1000}, // 999.9999 → 1000
	}
	for _, tc := range tests {
		got, err := MulDivBankers(tc.amount, 1, 10_000)
		if err != nil {
			t.Fatalf("MulDivBankers(%d,1,10000): %v", tc.amount, err)
		}
		if got != tc.expected {
			t.Fatalf("MulDivBankers(%d,1,10000) = %d, want %d", tc.amount, got, tc.expected)
		}
	}

	t.Run("full product is exact even beyond int64 (big intermediate)", func(t *testing.T) {
		got, err := MulDivBankers(math.MaxInt64, 10_000, 10_000)
		if err != nil || got != math.MaxInt64 {
			t.Fatalf("got %d, %v; want MaxInt64", got, err)
		}
		// Product 1e15 × 10001 = 1.0001e19 exceeds MaxInt64 — only the
		// math/big intermediate path can hold it; the rounded result fits.
		got, err = MulDivBankers(1_000_000_000_000_000, 10_001, 10_000)
		if err != nil || got != 1_000_100_000_000_000 {
			t.Fatalf("got %d, %v; want 1000100000000000", got, err)
		}
	})

	t.Run("refuses a result beyond int64 (MONEY_OVERFLOW)", func(t *testing.T) {
		_, err := MulDivBankers(math.MaxInt64, 2, 1)
		wantCode(t, err, CodeOverflow)
		// MaxInt64 × 10001 / 10000 rounds to 9224294374058461285 > MaxInt64.
		_, err = MulDivBankers(math.MaxInt64, 10_001, 10_000)
		wantCode(t, err, CodeOverflow)
	})

	t.Run("refusals", func(t *testing.T) {
		if _, err := MulDivBankers(1, 1, 0); !errors.Is(err, ErrDivisionInvalid) {
			t.Fatalf("zero divisor: %v", err)
		}
		if _, err := MulDivBankers(-1, 1, 10); !errors.Is(err, ErrNegative) {
			t.Fatalf("negative amount: %v", err)
		}
		if _, err := MulDivBankers(1, -1, 10); !errors.Is(err, ErrNegative) {
			t.Fatalf("negative factor: %v", err)
		}
	})
}

func TestErrorsAreValues(t *testing.T) {
	// A refusal is a value: codes survive wrapping and are matchable with
	// errors.Is, and distinct families never cross-match.
	_, err := mustKES(t, 50).Subtract(mustKES(t, 51))
	wrapped := fmt.Errorf("settlement failed: %w", err)
	if !errors.Is(wrapped, ErrUnderflow) {
		t.Fatal("wrapped UNDERFLOW not matched via errors.Is")
	}
	if errors.Is(err, ErrOverflow) || errors.Is(err, ErrNegative) {
		t.Fatal("UNDERFLOW must not match other families")
	}
	var me *Error
	if !errors.As(wrapped, &me) || me.Code != CodeUnderflow {
		t.Fatal("errors.As must surface the typed Error with its code")
	}
}

func TestIsValidCurrency(t *testing.T) {
	for _, cur := range Currencies {
		if !IsValidCurrency(cur) {
			t.Fatalf("%s must be valid", cur)
		}
	}
	if IsValidCurrency("XYZ") || IsValidCurrency("") {
		t.Fatal("unknown currencies must be invalid")
	}
}
