# BACKLOG — Dispatchable Feature List

Live status board for agents and maintainers. One row = one PR-sized feature.
Phase mapping: waves 1–2 = fund truth, wave 3 = collections ops, wave 4 = intelligence.
Update `Status` as work lands; PRs must reference the issue so it auto-closes.

| ID | Feature | Wave | Issue | Status | Acceptance criteria (short) |
|----|---------|------|-------|--------|------------------------------|
| F1 | Receivables core — Invoice→Receivable split, lifecycle states, aging, write-off ownership (H1) | 1 | #1 | **done** (PR #12) | Pure transition fns; all legal/illegal transitions tested |
| F2 | Payments core — dual-path intake (C2B + STK), idempotency unique keys (C5, R9, K1) | 1 | #2 | **done** (PR #13) | Duplicate callback returns same payment; tripwire event |
| F3 | Reconciliation — Match re-pointed to Payment; multi-invoice representable (C1, R5) | 1 | #3 | **done** (PR #13) | 3-invoices-1-payment scenario test passes |
| F4 | Adjustments — Refund + RefundAllocation (C2, R6), CreditNote + applications (C3, R7), CustomerCreditBalance (C4) | 1 | #4 | **done** (PR #11) | Ceiling rejections tested; overpayment→balance flow |
| F5 | Allocation engine — strategy chain FIFO/explicit/pro-rata on Money.allocate (H3, R1, R2) | 2 | #5 | **done** (PR #15) | Cross-module R1/R2 suite; reversal flow |
| F6 | Event catalog as typed code + outbox contract (envelope, versioning) | 2 | #6 | **done** (PR #16) | All 27 events typed; replay deterministic |
| F7 | Late fee accrual + PaymentPlan schedule engine (H4, H5) | 2 | #7 | **done** (PR #17) | Accrual caps tested; installment generator |
| F8 | Collections cases + exclusivity invariant (H6, R8) | 2 | #8 | pending | Second open case rejected; dunning consent hook |
| F9 | Multi-currency + FX realized gain/loss postings (H2, R10) | 2 | #9 | pending | Cross-currency settlement blocked without FX posting |
| F10 | Consent registry (DPA 2019) + WhatsApp opt-in + eTIMS numbering hooks (K2–K4) | 2 | #10 | **done** (PR #14) | No dunning without grant; number format reserved |
| F11 | Sub-ledger posting implementation + GL reconciliation job (K5, R4) | 3 | — | pending | Posting matrix enforced; daily reconciliation job |
| F12 | Promise-to-pay tracking + dunning orchestration | 3 | — | pending | Promise lifecycle; consent-checked sends |
| F13 | Collections priority scoring + feedback loop (H7) | 4 | — | pending | Read-only over events; outcome feedback recorded |
| F14 | Segment strategies + reporting projections | 4 | — | pending | Projections only; no fund-truth writes |
| F15 | Daraja adapter conformance suite (callback fixtures, at-least-once replay) | 4 | — | pending | Fixture replay is idempotent end-to-end |

**Dispatch rule:** a feature enters *in-progress* only when an agent owns its module lane
(no cross-module imports); wave N+1 starts after its dependencies merged to `main`.

## Wave-1 dispatch — COMPLETE (merged 2026-09-02)
- PR #12 `feat/receivables-core` → #1 closed (102 tests)
- PR #13 `feat/payments-reconciliation` → #2 + #3 closed (91 tests)
- PR #11 `feat/adjustments-core` → #4 closed (82 tests)
- Combined main: 283/283 tests green (Node 22.21.1 + Node 24.19, typecheck clean)

**Wave-2 dispatch — COMPLETE (merged 2026-09-02):** PR #15 allocation (#5), PR #16 events (#6), PR #17 late fees+plans (#7), PR #14 consent/eTIMS (#10). Combined main: 607/607 tests green.

**Next dispatch (wave 3):** #8 collections cases (#8, new collections/ dir), #9 FX postings (#9, shared+allocation), then #11–#15 (posting matrix, promise-to-pay, intelligence, projections, Daraja conformance).
