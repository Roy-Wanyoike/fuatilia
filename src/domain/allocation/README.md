# Allocation module — wave 2 (issue #5)

Owns the single funnel that settles receivables from a confirmed payment (or credit balance).
Depends on wave-1 outputs; intentionally empty in wave 1.

## Scope
- `Allocation` entity: Payment (or CreditBalance) → N receivables, ordered, append-only (R3).
- Strategy chain (review H3), default `oldest-invoice-first (FIFO)`, then `explicit`,
  then `pro-rata` — implemented on top of `Money.allocate` (largest remainder).
- Cross-module invariant suite R1/R2 lives here (balance integrity, no over-allocation).

## Rules
- Allocation only within one currency (R10). No cross-module imports — opaque ids only.
