# Adjustments module — wave 1 (issue #4)

Owns money flowing backwards (refunds) and sideways (credit notes, credit balances).
Review findings C2, C3, C4 all land here.

## Scope
- `Refund` + `RefundAllocation` (C2): refunds reference the source `Payment` (opaque id) and
  the reason; ceiling per invariant R6 — cannot refund more than confirmed-and-not-yet-refunded.
- `CreditNote` (C3): first-class entity with its own lifecycle Draft → Issued →
  PartiallyApplied → FullyApplied → Voided; applications target receivables by opaque id.
- `CustomerCreditBalance` (C4): overpayments and consented credit-note excess land here per
  customer; applying from balance is explicit and consented (R7).
- Refund states: Requested → Approved → Processing → Completed / Failed / Rejected.

## Rules
- Import ONLY from `../shared`. Reference payments/receivables by opaque `Uuid`.
- Money ceilings are enforced in the domain functions (throw `DomainError`), not left to adapters.
- Emits events named `adjustment.*` — `credit_note.*`, `refund.*`, `credit_balance.*`
  (see `../events/README.md`).

## Definition of done
- Entities + lifecycles as pure functions.
- Tests: refund over-ceiling rejected; credit note partial→full application; overpayment routed
  to credit balance; balance application reduces customer balance.
- `npm run typecheck && npm test` green.
