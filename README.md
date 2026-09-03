# Fuatilia

> *Kufuatilia* (Swahili) — **to keep track of, to follow up on.**

**Fuatilia** is an Accounts-Receivable & Collections platform for Kenya: track every shilling a
customer owes, reconcile it against M-Pesa money (Daraja) without losing a cent, and follow up
with consented, intelligence-driven collections.

Sister project to [`digital-lending-os`](https://github.com/Roy-Wanyoike/digital-lending-os) —
same Kenyan fintech family, TypeScript end to end.

[![CI](https://github.com/Roy-Wanyoike/fuatilia/actions/workflows/ci.yml/badge.svg)](https://github.com/Roy-Wanyoike/fuatilia/actions/workflows/ci.yml)

## Design principles

1. **Ledger-first fund truth** — payments, allocations, refunds, and credit notes are append-only
   facts; corrections are reversing entries, never edits.
2. **The intelligence layer never owns fund truth** — scoring and recommendations read events;
   they cannot move money.
3. **Channel input is untrusted** — Daraja callbacks are at-least-once; intake is idempotent by
   construction (`unique(channel, externalRef)`).
4. **Kenya-native** — M-Pesa/Daraja, eTIMS invoice numbering, DPA 2019 consent, WhatsApp opt-in.
5. **Agent-ready by design** — Fuatilia exposes financial capabilities through governed APIs and
   events so humans, software integrations, and AI agents can safely reason over and act on
   receivables without bypassing financial controls. The long-term thesis lives in
   [`docs/VISION.md`](docs/VISION.md).

## Repository layout

```
docs/                 design docs (context map, model, state machines, events, dictionary,
                      review findings, invariants, build plan) + BACKLOG status board
src/domain/shared/    shared kernel: Money (minor units, bigint), ids, domain errors
src/domain/receivables/   wave 1 — debt position & lifecycle
src/domain/payments/      wave 1 — intake idempotency + reconciliation
src/domain/adjustments/   wave 1 — refunds, credit notes, credit balance
src/domain/allocation/    wave 2 — the settling funnel
src/domain/events/        wave 2 — typed event catalog + envelope
```

## Quickstart

```bash
npm ci
npm run typecheck
npm test
```

Requires Node ≥ 22. No database, no network — the domain core is pure TypeScript, tested with
Vitest, built with `tsc`.

## How we ship

- Features land as **pull requests** from `feat/*` branches — never direct to `main`.
- A PR merges only when the feature is **done, tested, verified, and working**: local tests
  green, CI green on Node 22/24, diff reviewed.
- Squash-merge only; branches auto-delete; issues auto-close via `Closes #N`.
- The backlog of pending features and their dispatch status lives in
  [`docs/BACKLOG.md`](docs/BACKLOG.md). Reports and binaries are deliberately kept out of the
  repository (see `.gitignore`).

## Documentation

Start at [`docs/README.md`](docs/README.md) — covering the context map, domain model,
state machines, the 27-event catalog, data dictionary, review findings (C1–C5, H1–H7, K1–K6),
testable invariants (R1–R10), and the three-phase build plan. [`docs/VISION.md`](docs/VISION.md)
is the 10–15 year product thesis: the receivables intelligence layer that AI agents, payment
rails, banks and ERPs plug into — agent-ready by design.

## License

[MIT](LICENSE)
