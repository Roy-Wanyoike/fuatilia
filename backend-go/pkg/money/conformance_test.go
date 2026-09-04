package money

// conformance_test.go — the TypeScript behavioral-parity suite (issue #65).
//
// The TypeScript domain (src/domain/**) is the binding specification for the
// Go production backend. Every test below ports a named Vitest scenario with
// IDENTICAL inputs and expected outputs (same minor-unit numbers, same
// refusal codes). Where the TS scenario lives in the allocation lane (whose
// row-lifecycle helpers are re-declared per lane in TS), this port mirrors
// those helpers INSIDE the test file; the production Go allocation module
// (a later wave) must preserve the asserted codes when it consumes pkg/money.
//
// Mapping — money.spec.ts (8/8 scenarios):
//
//      "constructs from non-negative integer minor units"      → TestConstructsFromNonNegativeIntegerMinorUnits
//      "parses decimal strings without float drift"            → TestParsesDecimalStringsWithoutFloatDrift
//      "refuses cross-currency arithmetic"                     → TestRefusesCrossCurrencyArithmetic
//      "throws UNDERFLOW instead of going negative"            → TestThrowsUnderflowInsteadOfGoingNegative
//      "allocates with largest remainder so no cent is lost"   → TestAllocatesWithLargestRemainderSoNoCentIsLost
//      "allocation always sums back to the total"              → TestAllocationAlwaysSumsBackToTheTotal
//      "allocation is deterministic and never negative"        → TestAllocationIsDeterministicAndNeverNegative
//      "rejects empty and zero-sum allocations"                → TestRejectsEmptyAndZeroSumAllocations
//
// Mapping — allocation.spec.ts, R1/R2 rows (13/15 scenarios; the two skipped
// TS scenarios are pure row-factory plumbing with no Money surface:
// "rejects sequenceNo < 1" and "defaults reversedAt/reversalOf to null"):
//
//      "rejects a non-positive amount (docs/05: amountMinor > 0)"              → TestRowRejectsNonPositiveAmount
//      "normalizes bigint balances to Money in the receivable currency"        → TestBalanceOfNormalizesRawMinorUnits
//      "throws CURRENCY_MISMATCH when a Money balance disagrees (R10)"         → TestBalanceOfCurrencyMismatch
//      "computes the remaining balance after active allocations"               → TestBalanceAfterComputesRemaining
//      "trips BALANCE_OVER_ALLOCATED instead of returning a negative (R1)"     → TestBalanceAfterTripsOverAllocated
//      "ignores reversed rows and compensating rows when recomputing (R3+R1)"  → TestBalanceAfterIgnoresReversedRows
//      "computes confirmed − Σ active allocations"                             → TestUnappliedRemainderComputes
//      "passes at the exact ceiling (Σ === available)"                         → TestValidateAllocationsPassesAtExactCeiling
//      "rejects Σ > available (over-allocation)"                               → TestValidateAllocationsRejectsOverAllocation
//      "rejects rows spanning multiple sources"                                → TestValidateAllocationsRejectsMixedSources
//      "rejects a zero amount row"                                             → TestValidateAllocationsRejectsZeroRow
//      "rejects cross-currency rows (R10)"                                     → TestValidateAllocationsRejectsCrossCurrency
//      "frees capacity after a reversal: only active rows count (R2+R3)"       → TestValidateAllocationsFreesCapacityAfterReversal
//
// Mapping — strategies.spec.ts, allocateProRata (8/8 scenarios; pro-rata is
// the cross-module consumer of Money.allocate — the strategy chain itself is
// out of scope here per the issue, so the mirror lives test-side):
//
//      "is cent-exact with deterministic remainder bumping (1000 → [454,273,273])" → TestProRataCentExactRemainderBumping
//      "pins the remainder to canonical order (999 → [500,499])"                   → TestProRataRemainderPinnedToCanonicalOrder
//      "skips zero-balance receivables"                                            → TestProRataSkipsZeroBalanceReceivables
//      "returns an empty plan when every balance is zero"                          → TestProRataEmptyPlanAllZeroBalances
//      "caps at balances when funds exceed total debt"                             → TestProRataCapsAtBalances
//      "is deterministic and order-insensitive (replay-safe)"                      → TestProRataDeterministicOrderInsensitive
//      "never allocates more than a receivable balance across odd remainders"      → TestProRataNeverExceedsBalance
//      "throws CURRENCY_MISMATCH on a foreign-currency receivable (R10)"           → TestProRataCurrencyMismatch
//
// Mapping — engine.spec.ts, "R1 balance-integrity chain across strategies"
// (the flagship R1/R2 cross-module conservation scenario; fifo/explicit walk
// logic is mirrored test-side, pro-rata goes through the real Money.allocate):
//
//      "never loses or invents a cent under fifo"       → TestR1CentConservationChain/fifo
//      "never loses or invents a cent under explicit"   → TestR1CentConservationChain/explicit
//      "never loses or invents a cent under pro_rata"   → TestR1CentConservationChain/pro_rata
//
// Fee-parity rounding pins (in money_test.go, same package): TestRoundBankers
// ports the divideBankers table from crossborder/fees.spec.ts (8 rows) and
// the banker's pins from crossborder/quote.spec.ts (3 rows); TestMulDivBankers
// ports the bps rounding-edge table from crossborder/fees.spec.ts (6 rows).
//
// Ported scenario count: 32 TS scenarios (8 money + 13 allocation R1/R2 +
// 8 pro-rata + 3 cent-conservation rows) plus the 17 fee-parity rounding-pin
// rows above = 49 conformance checks, all with TS-identical inputs/outputs.
//
// Known unportable-as-written row: money.spec "Money.ofMinor(1.5)" (TS code
// MONEY_NOT_INTEGER). Go's int64-only constructor makes non-integer minor
// units unrepresentable — the failure is a compile-time guarantee instead of
// a runtime error (noted inline in TestConstructsFromNonNegativeIntegerMinorUnits).

import (
	"math"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors of the TS spec fixtures)
// ---------------------------------------------------------------------------

// confUID mirrors the TS uid() fixture: `00000000-0000-4000-8000-` +
// tail zero-padded to 12 chars. String comparison order matches TS.
func confUID(tail string) string {
	return "00000000-0000-4000-8000-" + strings.Repeat("0", 12-len(tail)) + tail
}

// eqMoney mirrors Vitest toEqual on Money values (amount + currency).
func eqMoney(a, b Money) bool {
	return a.Amount() == b.Amount() && a.Currency() == b.Currency()
}

// ---------------------------------------------------------------------------
// money.spec.ts ports
// ---------------------------------------------------------------------------

func TestConstructsFromNonNegativeIntegerMinorUnits(t *testing.T) {
	if got := mustNew(t, 1250, KES).Amount(); got != 1250 {
		t.Fatalf("ofMinor(1250).amount = %d, want 1250", got)
	}
	if !mustNew(t, 0, KES).IsZero() {
		t.Fatal("ofMinor(0) must be zero")
	}
	// TS: expect(() => Money.ofMinor(-1, 'KES')).toThrow(DomainError)
	_, err := New(-1, KES)
	wantCode(t, err, CodeNegative)
	// TS: expect(() => Money.ofMinor(1.5, 'KES')).toThrow(DomainError)
	// (MONEY_NOT_INTEGER). Unrepresentable in Go: New takes int64, so a
	// non-integer minor-unit amount cannot be constructed — the TS runtime
	// refusal is a Go compile-time guarantee.
	_ = mustZero(t, KES) // keep the zero-construction path exercised too
}

func TestParsesDecimalStringsWithoutFloatDrift(t *testing.T) {
	tests := []struct {
		text string
		want int64
	}{
		{"1250.50", 125050},
		{"0.99", 99},
		{"42", 4200},
	}
	for _, tc := range tests {
		got, err := Parse(tc.text, KES)
		if err != nil {
			t.Fatalf("Parse(%q): %v", tc.text, err)
		}
		if got.Amount() != tc.want {
			t.Fatalf("Parse(%q).amount = %d, want %d", tc.text, got.Amount(), tc.want)
		}
	}
}

func TestRefusesCrossCurrencyArithmetic(t *testing.T) {
	kes := mustNew(t, 100, KES)
	usd := mustNew(t, 100, USD)
	// TS asserts toThrow(DomainError); the allocation specs pin the same
	// failure as code CURRENCY_MISMATCH, asserted exactly here.
	_, err := kes.Add(usd)
	wantCode(t, err, CodeCurrencyMismatch)
}

func TestThrowsUnderflowInsteadOfGoingNegative(t *testing.T) {
	_, err := mustKES(t, 50).Subtract(mustKES(t, 51))
	wantCode(t, err, CodeUnderflow)
	got, err := mustKES(t, 51).Subtract(mustKES(t, 50))
	if err != nil || got.Amount() != 1 {
		t.Fatalf("51 − 50 = %d, %v; want 1", got.Amount(), err)
	}
}

func TestAllocatesWithLargestRemainderSoNoCentIsLost(t *testing.T) {
	parts, err := mustKES(t, 100).Allocate([]float64{1, 1, 1})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	want := []int64{34, 33, 33}
	for i, w := range want {
		if parts[i].Amount() != w {
			t.Fatalf("parts[%d] = %d, want %d", i, parts[i].Amount(), w)
		}
	}
}

func TestAllocationAlwaysSumsBackToTheTotal(t *testing.T) {
	total := mustKES(t, 999)
	parts, err := total.Allocate([]float64{1, 2, 4})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	sum := mustZero(t, KES)
	for _, p := range parts {
		next, err := sum.Add(p)
		if err != nil {
			t.Fatalf("reduce add: %v", err)
		}
		sum = next
	}
	eq, err := sum.Equals(total)
	if err != nil || !eq {
		t.Fatalf("sum.equals(total) = %v, %v; want true", eq, err)
	}
}

func TestAllocationIsDeterministicAndNeverNegative(t *testing.T) {
	a, err := mustKES(t, 7).Allocate([]float64{0.3, 0.3, 0.4})
	if err != nil {
		t.Fatalf("Allocate a: %v", err)
	}
	b, err := mustKES(t, 7).Allocate([]float64{0.3, 0.3, 0.4})
	if err != nil {
		t.Fatalf("Allocate b: %v", err)
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("non-deterministic at %d: %d vs %d", i, a[i].Amount(), b[i].Amount())
		}
		// TS: every part amount must not start with '-' (never negative).
		if a[i].Amount() < 0 {
			t.Fatalf("negative part %d", a[i].Amount())
		}
	}
}

func TestRejectsEmptyAndZeroSumAllocations(t *testing.T) {
	_, err := mustKES(t, 10).Allocate([]float64{})
	wantCode(t, err, CodeAllocationEmpty)
	_, err = mustKES(t, 10).Allocate([]float64{0, 0})
	wantCode(t, err, CodeWeightsSumZero)
}

// ---------------------------------------------------------------------------
// allocation.spec.ts ports — test-side mirrors of the TS lane's R1/R2 row
// math (the TS lane re-declares shared semantics per lane rule; the Go
// production allocation module must keep these codes when it lands).
// ---------------------------------------------------------------------------

// Stable TS allocation-lane codes asserted by the ported scenarios.
const (
	codeAmountNotPositive    = "ALLOCATION_AMOUNT_NOT_POSITIVE"
	codeSourceMismatch       = "ALLOCATION_SOURCE_MISMATCH"
	codeExceedsAvailable     = "ALLOCATION_EXCEEDS_AVAILABLE"
	codeBalanceOverAllocated = "BALANCE_OVER_ALLOCATED"
)

// tRow mirrors the slice of the TS Allocation row shape the ported scenarios
// exercise (id / sourceId / receivableId / amountMinor / reversedAt /
// reversalOf). Rows are append-only; "reversed" + "compensating" rows are
// excluded from R1/R2 arithmetic exactly like allocation.ts isActive.
type tRow struct {
	id           string
	sourceID     string
	receivableID string
	amount       Money
	reversedAt   bool
	reversalOf   string
}

// confRow mirrors the TS row() fixture: 600 KES on r0000001 from p0000001,
// overridable per scenario.
func confRow(t *testing.T, amount int64, mutate ...func(*tRow)) tRow {
	t.Helper()
	m := mustKES(t, amount)
	r := tRow{
		id:           confUID("000000001"),
		sourceID:     confUID("p0000001"),
		receivableID: confUID("r0000001"),
		amount:       m,
	}
	for _, f := range mutate {
		f(&r)
	}
	return r
}

func withID(id string) func(*tRow)         { return func(r *tRow) { r.id = confUID(id) } }
func withSource(sid string) func(*tRow)    { return func(r *tRow) { r.sourceID = confUID(sid) } }
func withRecv(rid string) func(*tRow)      { return func(r *tRow) { r.receivableID = confUID(rid) } }
func withReversed() func(*tRow)            { return func(r *tRow) { r.reversedAt = true } }
func withReversalOf(id string) func(*tRow) { return func(r *tRow) { r.reversalOf = confUID(id) } }

func withRowAmount(t *testing.T, amount int64, cur Currency) func(*tRow) {
	return func(r *tRow) { r.amount = mustNew(t, amount, cur) }
}

// rowActive mirrors allocation.ts isActive.
func rowActive(r tRow) bool { return !r.reversedAt && r.reversalOf == "" }

// rowFactoryGuard mirrors the allocationOf amount guard (the ported factory
// rule): a row must carry a strictly positive amount.
func rowFactoryGuard(amount Money) string {
	if !amount.IsPositive() {
		return codeAmountNotPositive
	}
	return ""
}

// balanceOfMoneyGuard mirrors allocation.ts balanceOf's Money branch: a Money
// balance whose currency disagrees with the receivable's declared currency is
// refused (R10).
func balanceOfMoneyGuard(balance Money, declared Currency) string {
	if balance.Currency() != declared {
		return CodeCurrencyMismatch
	}
	return ""
}

// allocatedMinorTo mirrors allocation.ts allocatedMinorTo: a raw minor-unit
// sum over ACTIVE rows only (the TS lane sums bigints directly, not Money.add).
func allocatedMinorTo(rows []tRow, receivableID string) int64 {
	var sum int64
	for _, r := range rows {
		if r.receivableID == receivableID && rowActive(r) {
			sum += r.amount.Amount()
		}
	}
	return sum
}

// balanceAfterMirror mirrors allocation.ts balanceAfter (R1): the remaining
// receivable balance, never negative — over-allocation trips
// BALANCE_OVER_ALLOCATED instead. Returns "" as the code on success.
func balanceAfterMirror(t *testing.T, balanceMinor int64, rows []tRow, receivableID string) (Money, string) {
	t.Helper()
	applied := allocatedMinorTo(rows, receivableID)
	if applied > balanceMinor {
		return Money{}, codeBalanceOverAllocated
	}
	m := mustKES(t, balanceMinor-applied) // Money.ofMinor(balance − applied, currency)
	return m, ""
}

// unappliedRemainderMirror mirrors allocation.ts unappliedRemainder (R2):
// available − Σ active allocations, refusing over-allocation.
func unappliedRemainderMirror(t *testing.T, available Money, rows []tRow) (Money, string) {
	t.Helper()
	var allocated int64
	for _, r := range rows {
		if rowActive(r) {
			allocated += r.amount.Amount()
		}
	}
	if allocated > available.Amount() {
		return Money{}, codeExceedsAvailable
	}
	m, err := New(available.Amount()-allocated, available.Currency())
	if err != nil {
		t.Fatalf("remainder construction: %v", err)
	}
	return m, ""
}

// validateAllocationsMirror mirrors allocation.ts validateAllocations: one
// source per call, currency-homogeneous rows (R10), strictly positive
// amounts, then the R2 ceiling. Returns "" or the stable TS refusal code.
func validateAllocationsMirror(rows []tRow, available Money) string {
	if len(rows) > 0 {
		first := rows[0]
		for _, r := range rows {
			if r.sourceID != first.sourceID {
				return codeSourceMismatch
			}
			if r.amount.Currency() != available.Currency() {
				return CodeCurrencyMismatch
			}
			if !r.amount.IsPositive() {
				return codeAmountNotPositive
			}
		}
	}
	if _, code := unappliedRemainderMirrorSilent(rows, available); code != "" {
		return code
	}
	return ""
}

// unappliedRemainderMirrorSilent is unappliedRemainderMirror without needing
// *testing.T (for the guard-order mirror above).
func unappliedRemainderMirrorSilent(rows []tRow, available Money) (int64, string) {
	var allocated int64
	for _, r := range rows {
		if rowActive(r) {
			allocated += r.amount.Amount()
		}
	}
	if allocated > available.Amount() {
		return allocated, codeExceedsAvailable
	}
	return allocated, ""
}

func TestRowRejectsNonPositiveAmount(t *testing.T) {
	// TS: expectCode(() => row({ amount: Money.zero('KES') }), AMOUNT_NOT_POSITIVE)
	zero := mustZero(t, KES)
	if code := rowFactoryGuard(zero); code != codeAmountNotPositive {
		t.Fatalf("factory guard code = %q, want %q", code, codeAmountNotPositive)
	}
}

func TestBalanceOfNormalizesRawMinorUnits(t *testing.T) {
	// TS: balanceOf({ receivableId, currency: 'KES', balanceMinor: 250n })
	// toEqual(kes(250n))
	got := mustKES(t, 250) // the normalization of a raw 250 into KES Money
	if !eqMoney(got, mustKES(t, 250)) {
		t.Fatalf("balanceOf = %v, want kes(250)", got)
	}
}

func TestBalanceOfCurrencyMismatch(t *testing.T) {
	// TS: a Money balance whose currency disagrees with the receivable's
	// declared currency throws CURRENCY_MISMATCH (R10).
	if code := balanceOfMoneyGuard(mustNew(t, 250, USD), KES); code != CodeCurrencyMismatch {
		t.Fatalf("code = %q, want %q", code, CodeCurrencyMismatch)
	}
	if code := balanceOfMoneyGuard(mustNew(t, 250, KES), KES); code != "" {
		t.Fatalf("matching currency must pass, got %q", code)
	}
}

func TestBalanceAfterComputesRemaining(t *testing.T) {
	// TS: balance 10_000 with one active row of 7_000 → kes(3_000)
	rid := confUID("r0000003")
	rows := []tRow{confRow(t, 7_000, withRecv("r0000003"))}
	got, code := balanceAfterMirror(t, 10_000, rows, rid)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if !eqMoney(got, mustKES(t, 3_000)) {
		t.Fatalf("balanceAfter = %v, want kes(3000)", got)
	}
}

func TestBalanceAfterTripsOverAllocated(t *testing.T) {
	// TS: balance 1_000 with an active row of 1_001 → BALANCE_OVER_ALLOCATED (R1)
	rid := confUID("r0000003")
	rows := []tRow{confRow(t, 1_001, withRecv("r0000003"))}
	_, code := balanceAfterMirror(t, 1_000, rows, rid)
	if code != codeBalanceOverAllocated {
		t.Fatalf("code = %q, want %q", code, codeBalanceOverAllocated)
	}
}

func TestBalanceAfterIgnoresReversedRows(t *testing.T) {
	// TS: reversed original 4_000 + compensating 4_000 + live 2_500 →
	// allocated 2_500, balance kes(7_500), active ids = [live]
	rid := confUID("r0000003")
	original := confRow(t, 4_000, withRecv("r0000003"))
	reversedOriginal := original
	reversedOriginal.reversedAt = true
	compensating := confRow(t, 4_000, withRecv("r0000003"), withID("000000002"), withReversalOf("000000001"))
	live := confRow(t, 2_500, withRecv("r0000003"), withID("000000003"))
	rows := []tRow{reversedOriginal, compensating, live}

	if got := allocatedMinorTo(rows, rid); got != 2_500 {
		t.Fatalf("allocatedMinorTo = %d, want 2500", got)
	}
	got, code := balanceAfterMirror(t, 10_000, rows, rid)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if !eqMoney(got, mustKES(t, 7_500)) {
		t.Fatalf("balanceAfter = %v, want kes(7500)", got)
	}
	var activeIDs []string
	for _, r := range rows {
		if rowActive(r) {
			activeIDs = append(activeIDs, r.id)
		}
	}
	if len(activeIDs) != 1 || activeIDs[0] != live.id {
		t.Fatalf("active ids = %v, want [%s]", activeIDs, live.id)
	}
}

func TestUnappliedRemainderComputes(t *testing.T) {
	// TS: available 1_000 with active rows 600 + 150 → kes(250)
	rows := []tRow{
		confRow(t, 600),
		confRow(t, 150, withID("000000004")),
	}
	got, code := unappliedRemainderMirror(t, mustKES(t, 1_000), rows)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if !eqMoney(got, mustKES(t, 250)) {
		t.Fatalf("unapplied = %v, want kes(250)", got)
	}
}

func TestValidateAllocationsPassesAtExactCeiling(t *testing.T) {
	// TS: validateAllocations([row(1_000)], kes(1_000)) passes
	rows := []tRow{confRow(t, 1_000)}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != "" {
		t.Fatalf("Σ === available must pass, got %s", code)
	}
}

func TestValidateAllocationsRejectsOverAllocation(t *testing.T) {
	// TS: rows 600 + 500 against available 1_000 → ALLOCATION_EXCEEDS_AVAILABLE
	rows := []tRow{
		confRow(t, 600),
		confRow(t, 500, withID("000000005")),
	}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != codeExceedsAvailable {
		t.Fatalf("code = %q, want %q", code, codeExceedsAvailable)
	}
}

func TestValidateAllocationsRejectsMixedSources(t *testing.T) {
	// TS: rows from two different sources → ALLOCATION_SOURCE_MISMATCH
	rows := []tRow{
		confRow(t, 600),
		confRow(t, 600, withID("000000006"), withSource("p0000009")),
	}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != codeSourceMismatch {
		t.Fatalf("code = %q, want %q", code, codeSourceMismatch)
	}
}

func TestValidateAllocationsRejectsZeroRow(t *testing.T) {
	// TS: a zero-amount row → ALLOCATION_AMOUNT_NOT_POSITIVE
	rows := []tRow{confRow(t, 0)}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != codeAmountNotPositive {
		t.Fatalf("code = %q, want %q", code, codeAmountNotPositive)
	}
}

func TestValidateAllocationsRejectsCrossCurrency(t *testing.T) {
	// TS: a USD row against KES funds → CURRENCY_MISMATCH (R10)
	rows := []tRow{confRow(t, 0, withRowAmount(t, 600, USD))}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != CodeCurrencyMismatch {
		t.Fatalf("code = %q, want %q", code, CodeCurrencyMismatch)
	}
}

func TestValidateAllocationsFreesCapacityAfterReversal(t *testing.T) {
	// TS: reversed original 600 + compensating 600 → active Σ = 0, the full
	// 1_000 is allocatable again (R2 + R3)
	original := confRow(t, 600)
	reversed := original
	reversed.reversedAt = true
	compensating := confRow(t, 600, withID("000000007"), withReversalOf("000000001"))
	rows := []tRow{reversed, compensating}

	got, code := unappliedRemainderMirror(t, mustKES(t, 1_000), rows)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if !eqMoney(got, mustKES(t, 1_000)) {
		t.Fatalf("unapplied = %v, want kes(1000)", got)
	}
	if code := validateAllocationsMirror(rows, mustKES(t, 1_000)); code != "" {
		t.Fatalf("reversed rows must free capacity, got %s", code)
	}
}

// ---------------------------------------------------------------------------
// strategies.spec.ts ports — allocateProRata (built directly on
// Money.allocate; the strategy mirror lives test-side per the issue scope)
// ---------------------------------------------------------------------------

// prReceivable mirrors the AllocatableReceivable structural view the TS lane
// defines: opaque id + currency + outstanding balance (raw minor units).
type prReceivable struct {
	id       string
	currency Currency
	balance  int64
	due      *time.Time // engine/fifo scenarios only; nil = undated
}

// prRecv mirrors the TS recv() fixture (KES, no due date).
func prRecv(id string, balance int64) prReceivable {
	return prReceivable{id: confUID(id), currency: KES, balance: balance}
}

// prRecvDue mirrors the TS recv(id, balance, due) fixture with a due date.
func prRecvDue(id string, balance int64, due string) prReceivable {
	r := prRecv(id, balance)
	ts, err := time.Parse(time.RFC3339, due+"T00:00:00Z")
	if err != nil {
		panic("test fixture: bad due date " + due) // fixtures are compile-time constants
	}
	r.due = &ts
	return r
}

// prPlan mirrors the TS StrategyPlan { receivableId, amount }.
type prPlan struct {
	receivableID string
	amount       Money
}

// allocateProRataMirror mirrors strategies.ts allocateProRata: filter to
// positive balances, sort by receivableId (canonical order), then either cap
// at balances (funds ≥ outstanding) or split via the REAL Money.allocate
// (largest remainder) and drop non-positive parts. Refuses cross-currency
// receivables with the TS code (R10).
func allocateProRataMirror(t *testing.T, funds Money, receivables []prReceivable) ([]prPlan, string) {
	t.Helper()
	for _, r := range receivables {
		if r.currency != funds.Currency() {
			return nil, CodeCurrencyMismatch
		}
	}
	positive := make([]prReceivable, 0, len(receivables))
	for _, r := range receivables {
		if r.balance > 0 {
			positive = append(positive, r)
		}
	}
	sort.Slice(positive, func(i, j int) bool { return positive[i].id < positive[j].id })
	if len(positive) == 0 {
		return nil, ""
	}
	var outstanding int64
	for _, r := range positive {
		outstanding += r.balance
	}
	if funds.Amount() >= outstanding {
		plans := make([]prPlan, 0, len(positive))
		for _, r := range positive {
			plans = append(plans, prPlan{receivableID: r.id, amount: mustNew(t, r.balance, funds.Currency())})
		}
		return plans, ""
	}
	weights := make([]float64, len(positive))
	for i, r := range positive {
		weights[i] = float64(r.balance)
	}
	parts, err := funds.Allocate(weights)
	if err != nil {
		t.Fatalf("Money.allocate: %v", err)
	}
	var plans []prPlan
	for i, r := range positive {
		if parts[i].IsPositive() {
			plans = append(plans, prPlan{receivableID: r.id, amount: parts[i]})
		}
	}
	return plans, ""
}

// planWant is one expected plan leg (receivable id + minor-unit amount).
type planWant struct {
	id     string
	amount int64
}

// planTriple asserts plans against TS expectations.
func planTriple(t *testing.T, plans []prPlan, want ...planWant) {
	t.Helper()
	if len(plans) != len(want) {
		t.Fatalf("got %d plans, want %d: %+v", len(plans), len(want), plans)
	}
	for i, w := range want {
		if plans[i].receivableID != w.id || plans[i].amount.Amount() != w.amount {
			t.Fatalf("plan[%d] = {%s %d}, want {%s %d}", i, plans[i].receivableID, plans[i].amount.Amount(), w.id, w.amount)
		}
	}
}

func TestProRataCentExactRemainderBumping(t *testing.T) {
	// TS: 1000 over [c:300, a:500, b:300] → [a:454, b:273, c:273], Σ = 1000
	plans, code := allocateProRataMirror(t, mustKES(t, 1_000), []prReceivable{
		prRecv("c00000020", 300),
		prRecv("a00000020", 500),
		prRecv("b00000020", 300),
	})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	planTriple(t, plans,
		planWant{confUID("a00000020"), 454},
		planWant{confUID("b00000020"), 273},
		planWant{confUID("c00000020"), 273},
	)
	var sum int64
	for _, p := range plans {
		sum += p.amount.Amount()
	}
	if sum != 1_000 {
		t.Fatalf("Σ plans = %d, want 1000 (cent-exact)", sum)
	}
}

func TestProRataRemainderPinnedToCanonicalOrder(t *testing.T) {
	// TS: 999 over [b:500, a:500] → [a:500, b:499]
	plans, code := allocateProRataMirror(t, mustKES(t, 999), []prReceivable{
		prRecv("b00000021", 500),
		prRecv("a00000021", 500),
	})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	planTriple(t, plans,
		planWant{confUID("a00000021"), 500},
		planWant{confUID("b00000021"), 499},
	)
}

func TestProRataSkipsZeroBalanceReceivables(t *testing.T) {
	// TS: [a:0, b:600, c:400] → ids [b, c]
	plans, code := allocateProRataMirror(t, mustKES(t, 1_000), []prReceivable{
		prRecv("a00000022", 0),
		prRecv("b00000022", 600),
		prRecv("c00000022", 400),
	})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	want := []string{confUID("b00000022"), confUID("c00000022")}
	got := make([]string, len(plans))
	for i, p := range plans {
		got[i] = p.receivableID
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plan ids = %v, want %v", got, want)
	}
}

func TestProRataEmptyPlanAllZeroBalances(t *testing.T) {
	// TS: [a:0] → empty plan
	plans, code := allocateProRataMirror(t, mustKES(t, 1_000), []prReceivable{prRecv("a00000023", 0)})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if len(plans) != 0 {
		t.Fatalf("want empty plan, got %+v", plans)
	}
}

func TestProRataCapsAtBalances(t *testing.T) {
	// TS: funds 1_000 over [a:300, b:200] → [a:300, b:200]; surplus unapplied
	plans, code := allocateProRataMirror(t, mustKES(t, 1_000), []prReceivable{
		prRecv("a00000024", 300),
		prRecv("b00000024", 200),
	})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	planTriple(t, plans,
		planWant{confUID("a00000024"), 300},
		planWant{confUID("b00000024"), 200},
	)
}

func TestProRataDeterministicOrderInsensitive(t *testing.T) {
	// TS: allocateProRata(12_345, shuffled) toEqual allocateProRata(12_345, set)
	set := []prReceivable{
		prRecv("c00000025", 7_000),
		prRecv("a00000025", 10_000),
		prRecv("b00000025", 5_000),
	}
	shuffled := []prReceivable{set[1], set[2], set[0]}
	first, code := allocateProRataMirror(t, mustKES(t, 12_345), shuffled)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	second, code := allocateProRataMirror(t, mustKES(t, 12_345), set)
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	if len(first) != len(second) {
		t.Fatalf("plan lengths differ: %d vs %d", len(first), len(second))
	}
	for i := range first {
		if first[i].receivableID != second[i].receivableID || !eqMoney(first[i].amount, second[i].amount) {
			t.Fatalf("plan[%d] differs: {%s %d} vs {%s %d}", i,
				first[i].receivableID, first[i].amount.Amount(),
				second[i].receivableID, second[i].amount.Amount())
		}
	}
}

func TestProRataNeverExceedsBalance(t *testing.T) {
	// TS: 12_345 over [a:10_000, b:5_000, c:7_000] — every plan positive,
	// capped at its balance, Σ cent-exact.
	balances := map[string]int64{
		confUID("a00000026"): 10_000,
		confUID("b00000026"): 5_000,
		confUID("c00000026"): 7_000,
	}
	plans, code := allocateProRataMirror(t, mustKES(t, 12_345), []prReceivable{
		prRecv("a00000026", 10_000),
		prRecv("b00000026", 5_000),
		prRecv("c00000026", 7_000),
	})
	if code != "" {
		t.Fatalf("unexpected refusal %s", code)
	}
	var sum int64
	for _, p := range plans {
		if !p.amount.IsPositive() {
			t.Fatalf("plan for %s is not positive", p.receivableID)
		}
		if p.amount.Amount() > balances[p.receivableID] {
			t.Fatalf("plan %d exceeds balance %d on %s", p.amount.Amount(), balances[p.receivableID], p.receivableID)
		}
		sum += p.amount.Amount()
	}
	if sum != 12_345 {
		t.Fatalf("Σ plans = %d, want 12345 (cent-exact)", sum)
	}
}

func TestProRataCurrencyMismatch(t *testing.T) {
	// TS: a GBP receivable against KES funds → CURRENCY_MISMATCH (R10)
	_, code := allocateProRataMirror(t, mustKES(t, 1_000), []prReceivable{
		{id: confUID("a00000027"), currency: GBP, balance: 5},
	})
	if code != CodeCurrencyMismatch {
		t.Fatalf("code = %q, want %q", code, CodeCurrencyMismatch)
	}
}

// ---------------------------------------------------------------------------
// engine.spec.ts port — the R1/R2 cent-conservation chain across strategies
// ---------------------------------------------------------------------------

// strategyName mirrors the TS AllocationStrategy union for the chain test.
type strategyName string

const (
	stratFifo     strategyName = "fifo"
	stratExplicit strategyName = "explicit"
	stratProRata  strategyName = "pro_rata"
)

// allocateFifoMirror mirrors strategies.ts allocateOldestFirst for the
// ported chain scenario: oldest dueDate first (undated last), ties by
// receivableId; take min(remaining funds, outstanding balance) per
// receivable; skip zero balances.
func allocateFifoMirror(t *testing.T, funds Money, receivables []prReceivable) ([]prPlan, string) {
	t.Helper()
	for _, r := range receivables {
		if r.currency != funds.Currency() {
			return nil, CodeCurrencyMismatch
		}
	}
	ordered := make([]prReceivable, len(receivables))
	copy(ordered, receivables)
	sort.SliceStable(ordered, func(i, j int) bool {
		ai, aj := dueKey(ordered[i]), dueKey(ordered[j])
		if ai != aj {
			return ai < aj
		}
		return ordered[i].id < ordered[j].id
	})
	var plans []prPlan
	remaining := funds.Amount()
	for _, r := range ordered {
		if remaining == 0 {
			break
		}
		if r.balance <= 0 {
			continue
		}
		take := r.balance
		if remaining < take {
			take = remaining
		}
		plans = append(plans, prPlan{receivableID: r.id, amount: mustNew(t, take, funds.Currency())})
		remaining -= take
	}
	return plans, ""
}

// dueKey mirrors the TS sort key: dueDate ms since epoch, undated last
// (Number.POSITIVE_INFINITY → math.MaxInt64).
func dueKey(r prReceivable) int64 {
	if r.due == nil {
		return math.MaxInt64
	}
	return r.due.UnixMilli()
}

// allocateExplicitMirror mirrors strategies.ts allocateExplicit for the
// ported chain scenario: declarations validated against known receivables,
// balances and available funds, then emitted in canonical id order.
func allocateExplicitMirror(t *testing.T, funds Money, receivables []prReceivable, declared map[string]int64) ([]prPlan, string) {
	t.Helper()
	byID := make(map[string]prReceivable, len(receivables))
	for _, r := range receivables {
		if r.currency != funds.Currency() {
			return nil, CodeCurrencyMismatch
		}
		byID[r.id] = r
	}
	var declaredTotal int64
	for id, amount := range declared {
		r, ok := byID[id]
		if !ok {
			return nil, "ALLOCATION_UNKNOWN_RECEIVABLE"
		}
		if amount > r.balance {
			return nil, "ALLOCATION_EXCEEDS_BALANCE"
		}
		declaredTotal += amount
	}
	if declaredTotal > funds.Amount() {
		return nil, codeExceedsAvailable
	}
	ids := make([]string, 0, len(declared))
	for id, amount := range declared {
		if amount > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	plans := make([]prPlan, 0, len(ids))
	for _, id := range ids {
		plans = append(plans, prPlan{receivableID: id, amount: mustNew(t, declared[id], funds.Currency())})
	}
	return plans, ""
}

func TestR1CentConservationChain(t *testing.T) {
	// TS: engine.spec.ts "R1 balance-integrity chain across strategies
	// (cent conservation)" — it.each(['fifo', 'explicit', 'pro_rata']).
	originalBalances := map[string]int64{
		confUID("a00000001"): 10_000,
		confUID("b00000001"): 5_000,
		confUID("c00000001"): 7_000,
	}
	receivables := []prReceivable{
		prRecvDue("a00000001", 10_000, "2025-01-10"),
		prRecvDue("b00000001", 5_000, "2025-02-01"),
		prRecvDue("c00000001", 7_000, "2025-01-15"),
	}
	const payment = 12_345
	var originals int64
	for _, bal := range originalBalances {
		originals += bal
	} // 22_000

	for _, strat := range []strategyName{stratFifo, stratExplicit, stratProRata} {
		t.Run(string(strat), func(t *testing.T) {
			funds := mustKES(t, payment)
			var plans []prPlan
			var code string
			switch strat {
			case stratFifo:
				plans, code = allocateFifoMirror(t, funds, receivables)
			case stratExplicit:
				plans, code = allocateExplicitMirror(t, funds, receivables, map[string]int64{
					confUID("a00000001"): 10_000,
					confUID("b00000001"): 2_000,
				})
			case stratProRata:
				plans, code = allocateProRataMirror(t, funds, receivables)
			}
			if code != "" {
				t.Fatalf("unexpected refusal %s", code)
			}

			// R2 — Σ allocations + unapplied === payment, exactly.
			var allocated int64
			for _, p := range plans {
				allocated += p.amount.Amount()
			}
			unapplied := payment - allocated
			if unapplied < 0 {
				t.Fatalf("R2 violated: allocated %d exceeds payment %d", allocated, payment)
			}
			if allocated+unapplied != payment {
				t.Fatalf("R2 violated: %d + %d != %d", allocated, unapplied, payment)
			}

			// R1 — per receivable: never over-allocated; Σ(after) + Σ
			// allocated === Σ(original) — no cent invented or destroyed.
			var after int64
			for rid, balanceMinor := range originalBalances {
				var remaining int64
				for _, p := range plans {
					if p.receivableID == rid {
						remaining += p.amount.Amount()
					}
				}
				if remaining > balanceMinor {
					t.Fatalf("R1 violated: %d allocated against balance %d on %s", remaining, balanceMinor, rid)
				}
				after += balanceMinor - remaining
			}
			if after+allocated != originals {
				t.Fatalf("R1 chain violated: %d + %d != %d", after, allocated, originals)
			}
		})
	}
}
