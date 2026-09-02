# Payments module — wave 1 (issues #2 and #3)

Owns money that has actually moved or is moving through channels. This module is the
system's fund truth for inflows.

## Scope
- `Payment` entity with dual intake paths that MUST converge on one creation funnel:
  - Daraja C2B confirmation/callback (at-least-once — duplicates are normal, K1);
  - STK push initiated + result callback.
- Idempotency (review finding C5, invariant R9): `unique(channel, externalRef)`. A duplicate
  callback returns the existing Payment — it never creates a second one.
- `ReconciliationMatch` **points at the Payment, never a single Receivable** (review finding C1,
  invariant R5): one Payment → N receivables happens through allocations (allocation module,
  wave 2 — here a match is just "this payment is explained by these declared invoice refs").
- Payment states (docs/03-state-machines.md): Initiated → PendingConfirmation → Confirmed →
  (Allocated | PartiallyAllocated | Unapplied) / Failed / Reversed / PartiallyRefunded / Refunded.
- Unidentified payments park as `Unapplied` on the customer — they never vanish.

## Rules
- Import ONLY from `../shared`. Reference receivables by opaque `Uuid` only.
- Daraja callbacks are untrusted input: validate, then transition; never mutate after `Confirmed`
  except via explicit reversal/refund flows (append-only, invariant R3).
- Emits events named `payment.*` / `reconciliation.*` (see `../events/README.md`).

## Definition of done
- Idempotency table + Payment state machine as pure functions.
- Tests: duplicate callback → same Payment returned; illegal transitions rejected;
  match re-point tests proving a 3-invoices-one-payment scenario is representable.
- `npm run typecheck && npm test` green.
