# Design Diagrams (review artifacts)

High-resolution figures from the domain model review that shaped docs/01–08. The lifecycles in
[03 — State machines](../../03-state-machines.md) and the model in [02 — Domain model](../../02-domain-model.md)
are the textual source of truth; these PNGs are the original rendered artifacts.

| File | Figure | Related doc |
|------|--------|-------------|
| `d01_context_map.png` | Bounded-context map (9 contexts, golden rule) | [01](../../01-context-map.md) |
| `d02_money_flow.png` | Corrected money-movement path (resolves C1, C5) | [01](../../01-context-map.md), [06](../../06-review-findings.md) |
| `d03_er_billing.png` | ER cluster — commercial core (Invoice, Receivable, CreditNote, WriteOff, LateFee) | [02](../../02-domain-model.md) |
| `d04_er_payments.png` | ER cluster — money side (Payment, Transaction, Refund, CreditBalance) | [02](../../02-domain-model.md) |
| `d05_er_collections.png` | ER cluster — collections (Case, Action, Promise, Plan, Dispute) | [02](../../02-domain-model.md) |
| `d06_er_recon_ledger.png` | ER cluster — reconciliation & ledger (Match→Payment, exceptions, journal) | [02](../../02-domain-model.md) |
| `d07_er_intel_comms.png` | ER cluster — intelligence & communications (read-only projections, consent) | [02](../../02-domain-model.md) |
| `d08_sm_invoice.png` | Invoice lifecycle (derived financial states) | [03](../../03-state-machines.md) |
| `d09_sm_receivable.png` | Receivable lifecycle (OPEN → SETTLED / WRITTEN_OFF) | [03](../../03-state-machines.md) |
| `d10_sm_payment.png` | Payment lifecycle (refund states from COMPLETED) | [03](../../03-state-machines.md) |
| `d11_sm_case.png` | CollectionCase lifecycle (one open case per receivable, R8) | [03](../../03-state-machines.md) |
| `d12_sm_promise.png` | PromiseToPay lifecycle (F12) | [03](../../03-state-machines.md) |
| `d13_sm_installment.png` | Installment lifecycle (PaymentPlan, F7) | [03](../../03-state-machines.md) |
| `d14_sm_dispute.png` | Dispute lifecycle (F16) | [03](../../03-state-machines.md) |
