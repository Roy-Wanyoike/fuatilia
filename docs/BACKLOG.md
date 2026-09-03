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
| F8 | Collections cases + actions + exclusivity invariant (H6, R8) | 3 | #8 | in-progress (re-dispatch) | Second open case rejected; dunning consent hook; derived case status |
| F9 | Multi-currency + FX realized gain/loss postings (H2, R10) | 3 | #9 | **done** (PR #28) | Cross-currency settlement blocked without FX posting |
| F10 | Consent registry (DPA 2019) + WhatsApp opt-in + eTIMS numbering hooks (K2–K4) | 2 | #10 | **done** (PR #14) | No dunning without grant; number format reserved |
| F11 | Sub-ledger posting implementation + GL reconciliation job (K5, R4) | 3 | #18 | **done** (PR #29) | Posting matrix enforced; daily reconciliation job; reversals append-only |
| F12 | Promise-to-pay tracking + dunning orchestration (K2) | 3 | #19 | in-progress (re-dispatch) | Promise lifecycle; consent-checked sends; escalation ladder |
| F16 | Disputes lifecycle — pause collections while disputed (SPEC §29) | 3 | #20 | **done** (PR #27) | Disputed receivable pauses automated dunning; resolution resumes |
| F17 | Payment links — single/partial-use links with lifecycle (SPEC §28) | 3 | #21 | in-progress (re-dispatch) | Token redemption bounds enforced; single-use rejected twice |
| F18 | Communications domain — conversations, messages, delivery attempts, templates (SPEC §26) | 3 | #22 | in-progress (re-dispatch) | Consent-before-send; versioned templates; retry → dead-letter |
| F13 | Collections priority scoring + recommendation feedback loop (H7) | 4 | #23 | pending | Read-only over events; outcome feedback recorded; explainable |
| F14 | Segment strategies + reporting projections (SPEC §19/§20/§66) | 4 | #24 | pending | Projections only; no fund-truth writes; predictions labeled |
| F15 | Daraja adapter conformance suite (callback fixtures, at-least-once replay) | 4 | #25 | pending | Fixture replay is idempotent end-to-end |
| F19 | Customer behavior profiles + anomaly detection (SPEC §4/§24) | 4 | #26 | pending | Metrics fixture-tested; explainable anomaly events |

**Dispatch rule:** a feature enters *in-progress* only when an agent owns its module lane
(no cross-module imports); wave N+1 starts after its dependencies merged to `main`.

## Wave-1 dispatch — COMPLETE (merged 2026-09-02)
- PR #12 `feat/receivables-core` → #1 closed (102 tests)
- PR #13 `feat/payments-reconciliation` → #2 + #3 closed (91 tests)
- PR #11 `feat/adjustments-core` → #4 closed (82 tests)
- Combined main: 283/283 tests green (Node 22.21.1 + Node 24.19, typecheck clean)

**Wave-2 dispatch — COMPLETE (merged 2026-09-02):** PR #15 allocation (#5), PR #16 events (#6), PR #17 late fees+plans (#7), PR #14 consent/eTIMS (#10). Combined main: 607/607 tests green.

## Wave-3 dispatch — collections ops (2026-09-03)

Audited against docs/SPEC.md (master build requirements) and the design review: the remaining
collections-ops features are F8 + F9 (carried over from wave 2) and F11, F12, F16, F17, F18.
All seven ship in parallel — each owns one fresh module lane, no cross-lane imports:

- `feat/collections-cases` → #8 (F8) — new lane `src/domain/collections/`
- `feat/fx-postings` → #9 (F9) — **merged as PR #28**
- `feat/ledger-postings` → #18 (F11) — **merged as PR #29**
- `feat/promises-dunning` → #19 (F12) — new lane `src/domain/promises/`
- `feat/disputes` → #20 (F16) — **merged as PR #27**
- `feat/payment-links` → #21 (F17) — new lane `src/domain/paymentlinks/`
- `feat/communications` → #22 (F18) — new lane `src/domain/communications/`

## Wave-4 dispatch — intelligence (queued after wave-3 merge)

- `feat/collections-intelligence` → #23 (F13) — new lane `src/domain/intelligence/`
- `feat/reporting-projections` → #24 (F14) — new lane `src/domain/projections/`
- `feat/daraja-conformance` → #25 (F15) — new lane `src/adapters/daraja/`
- `feat/behavior-profiles` → #26 (F19) — new lane `src/domain/behavior/`

Deferred (deliberately not scheduled — see SPEC §2/§33): cross-border payments, embedded
finance, field/offline mobile, USSD APIs, developer platform (§53), auth/RBAC backend (§34/35 —
domain core stays pure; API/auth layer lands after the domain is complete).

**Wave-3 progress note (2026-09-03):** first dispatch delivered F9 (#28), F11 (#29), F16 (#27); five agents hit runtime limits, four re-dispatched (F8, F12, F17, F18). GitHub Actions runners were failing repo-wide (job startup `BlobNotFound`, including pre-existing main pushes) — local `typecheck + full suite` on Node 24 used as the verification gate for merges.
