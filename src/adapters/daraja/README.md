# Daraja adapter conformance suite (`src/adapters/daraja/`)

**F15 / issue #25** — proves that the domain satisfies M-Pesa Daraja semantics END-TO-END under
transport hostility, using ONLY public domain functions (the domain is never modified and this
lane imports domain lanes as the one integration seam; it stays pure: no network, no DB, no RNG,
injected `Clock`).

## What's here

| File | Role |
|---|---|
| `wire.ts` | The K1 untrusted-input boundary: parses raw callback payloads (C2B validation/confirmation, STK result, B2C result) into typed shapes + intake commands. Anything structurally wrong is refused with a stable `DARAJA_*` code — dead-letter, never processed. |
| `fixtures/` | Typed, deep-frozen callback fixtures with Kenyan-realistic synthetic data (Pay Bill / Buy Goods / STK / B2C + a malformed corpus). Each `malformed` row promises the exact stable code the parser must reject it with; the tampered row promises the DOMAIN code. |
| `simulator.ts` | `simulate(schedule, world, options)` — replays deliveries through the domain. Models at-least-once (`replayEach`), out-of-order (`shuffledSchedule`, seeded), delayed retries, and gaps. Emits a full `SimulationRun`: payments, matches, allocations, events, per-delivery outcome ledger (`accepted \| duplicate \| acknowledged \| observed \| rejected`), duplicate tripwire count. |
| `conformance.ts` | Plain-data scenario harness: `runConformance()` → report. Each scenario pins SPEC/review requirements (K1, C1, C4, C5, R1, R2, R5, R9) with named checks. Adding a fixture or scenario is an additive row. |
| `codes.ts` | The `DARAJA_*` stable error-code surface. |

## What the suite proves

- **R9/C5** — every at-least-once replay (5×, shuffled, delayed) resolves to exactly one payment;
  duplicates fire `payments.duplicateCallbackObserved` once per duplicate; nothing downstream re-runs.
- **K1** — malformed/foreign payloads are dead-lettered at the boundary with their promised code;
  same-TransID-different-money is tampering (`DUPLICATE_AMOUNT_MISMATCH`), not a retry.
- **C1/R5** — the reconciliation match points at the Payment and keeps the payer-typed reference;
  one transfer explaining two invoices splits FIFO across both.
- **R1/R2** — no cent created or destroyed (applied == confirmed); per-invoice ceilings respected.
- **C4** — money with no account reference parks on the customer, unapplied, never force-matched.
- **Result codes** — 0 completes; observed non-zero codes (1, 2, 1032, 1037) abandon with stable
  failure codes; unmapped codes fail safe (`STK_RESULT_<code>`).
- **Determinism** — identical worlds + schedules + clocks produce byte-identical runs.

## Extending

Add fixtures to `fixtures/` (register in `fixtures/index.ts`), then add scenarios to
`CONFORMANCE_SCENARIOS` — both are additive rows; the harness report grows automatically.
