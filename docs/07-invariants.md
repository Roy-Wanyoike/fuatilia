# 07 — Testable Invariants (R1–R10)

These are the rules the code must *guarantee*, not merely intend. Each invariant maps to tests;
wave-1 modules test their local slice, the cross-module suite lands with Allocation (issue #5)
and the event core (issue #6).

| # | Invariant | Enforced in | Wave-1 status |
|---|-----------|-------------|---------------|
| R1 | **Balance integrity.** `receivable.balanceMinor = originalMinor − Σ(allocation.amountMinor) − Σ(creditNoteApplication) − Σ(creditBalanceApplication)`; never negative; `settled ⇔ balance = 0`. | Allocation + Receivables | receivable-side tested; full chain wave 2 |
| R2 | **No over-allocation.** Σ(allocations of a payment) ≤ confirmedMinor; remainder stays `unapplied` (parks on customer, feeds C4). | Payments + Allocation | payment-side tested |
| R3 | **Append-only postings.** Allocations, matches, refunds, ledger entries are never UPDATEd/DELETEd; corrections are reversing entries with a reason. | All fund-truth modules | design rule; tested per module |
| R4 | **Ledger completeness.** Every money-moving state change posts a sub-ledger entry per the posting matrix (docs/05); the intelligence layer consumes projections only. | Ledger | wave 2+ |
| R5 | **Match points at Payment.** `ReconciliationMatch.paymentId` is the only target; N receivables per payment is expressed through allocations. | Payments | tested in wave 1 (issue #3) |
| R6 | **Refund ceiling.** refund.total ≤ confirmed − allocated − refunded-so-far; refunds draw only on confirmed funds unless explicitly sourced from consented credit balance. | Adjustments | tested in wave 1 (issue #4) |
| R7 | **Credit ceilings.** Σ credit-note applications ≤ note total; excess requires consent and lands in CustomerCreditBalance. | Adjustments | tested in wave 1 (issue #4) |
| R8 | **Case exclusivity.** At most one open CollectionsCase per receivable. | Collections | wave 2 (issue #8) |
| R9 | **Idempotent intake.** unique(channel, externalRef) / unique(idempotencyKey); a duplicate callback returns the existing payment and raises `payments.duplicateCallbackObserved`. | Payments | tested in wave 1 (issue #2) |
| R10 | **Currency discipline.** All arithmetic single-currency; cross-currency settlement requires an explicit FX posting with realized gain/loss. | Shared kernel + Allocation | kernel tested (CURRENCY_MISMATCH); FX wave 2 (issue #9) |

## How invariants are tested

- **Pure-function level:** transition functions and entity factories throw `DomainError` with
  stable codes; tests are table-driven (legal + illegal transitions).
- **Property level (kernel):** `Money.allocate` properties — sum preservation, determinism,
  non-negativity — are pinned by unit tests now and can graduate to property-based tests.
- **Cross-module level (wave 2):** scenario tests replay event streams (payment → match →
  allocations → refund) and assert invariants hold at every step, including after reversals.
