# Receivables module — wave 1 (issue #1)

Owns the legal debt position: what the customer owes, in what state, and why.

## Scope
- `Invoice` → `Receivable` split (an issued invoice creates exactly one receivable; corrections are credit notes, never invoice edits).
- `Receivable` lifecycle states (docs/03-state-machines.md): Draft → Open → PartiallyPaid → Settled, plus Overdue (flag, not state), WrittenOff, Uncollectible, Voided.
- Aging buckets (0-30/31-60/61-90/90+ days) computed from `dueDate`.
- Bad-debt ownership: write-off decision changes `state`, never deletes.

## Rules
- Import ONLY from `../shared` (Money, Uuid, Clock, DomainError). Communicate with other modules via opaque `Uuid`s.
- eTIMS numbering: reserve `invoiceNumber` at issuance (format hook, wave-2 completes integration, issue #10).
- Emits domain events named `receivable.*` — see `../events/README.md` for naming conventions.

## Definition of done
- Entities + state transitions as pure functions (no I/O).
- Table-driven tests for every legal and illegal transition.
- `npm run typecheck && npm test` green.
