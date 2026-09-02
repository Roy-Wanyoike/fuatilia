# 06 — Review Findings (accepted, driving the backlog)

The full argumentation lives in the design review; this page records the **decisions** the code
must honor. Severity: **C** = structural (model cannot work without it), **H** = high (must fix
before launch), **K** = Kenya/compliance.

## Critical (C1–C5)

- **C1 — ReconciliationMatch pointed at a single Receivable.** A payer settles three invoices
  with one M-Pesa transfer; the v1 model cannot represent that. **Decision:** a match points at
  the *Payment*; spreading money across invoices is the Allocation module's job (R5).
  → issue #3 (wave 1).
- **C2 — Refund path unmodeled.** Money leaves the building; pretending otherwise fails audits.
  **Decision:** `Refund` + `RefundAllocation` with a hard ceiling from confirmed funds (R6).
  → issue #4 (wave 1).
- **C3 — CreditNote was a name, not an entity.** **Decision:** full aggregate with lifecycle and
  application children; partial application supported (R7). → issue #4 (wave 1).
- **C4 — Overpayments had nowhere to live.** M-Pesa payers overpay routinely. **Decision:**
  `CustomerCreditBalance` per customer per currency; explicit, consented application (R7).
  → issue #4 (wave 1).
- **C5 — Two payment creation funnels (C2B callback vs STK result) can race.** Daraja retries
  callbacks (at-least-once, K1); without idempotency you double-count money. **Decision:** one
  intake funnel, `unique(channel, externalRef)` + idempotency key; duplicates are observed, not
  re-processed (R9). → issue #2 (wave 1).

## High (H1–H7)

- **H1 — Receivable lifecycle missing; bad debt had no owner.** **Decision:** explicit states +
  write-off as an approved decision with reason (never deletion). → issue #1.
- **H2 — Multi-currency undesigned.** **Decision:** Money in minor units everywhere; allocation
  and matching are single-currency; FX needs explicit realized gain/loss postings (R10).
  → issue #9 (wave 2).
- **H3 — Allocation order undefined.** FIFO oldest-invoice-first is the default; explicit and
  pro-rata strategies selectable; all built on `Money.allocate` (largest remainder).
  → issue #5 (wave 2).
- **H4 — Late fees missing** (common in Kenyan B2B terms). → issue #7 (wave 2).
- **H5 — PaymentPlan had association gaps.** Plan belongs to a customer, references specific
  receivables, drives an installment schedule engine. → issue #7 (wave 2).
- **H6 — Collections cases need exclusivity.** Two agents dunning the same customer destroys
  trust. **Decision:** partial unique index — one open case per receivable (R8). → issue #8.
- **H7 — Recommendation system had no feedback loop.** **Decision:** intelligence consumes
  outcome events (`receivable.settled`, `collections.promiseBroken`, …) and records feedback;
  it stays read-only over fund truth. → wave 3.

## Kenya / compliance (K1–K6)

- **K1 — Daraja callbacks are at-least-once.** Every consumer idempotent; duplicates surface as
  `payments.duplicateCallbackObserved` for monitoring. (Ties to C5/R9.)
- **K2 — WhatsApp dunning requires explicit opt-in** (Meta policy). `DunningStep.requiresConsent`
  checked against `ConsentGrant` before send.
- **K3 — Data Protection Act 2019.** Lawful basis per purpose, consent registry, revocation is
  append-only, DSAR export path documented. → issue #10 (wave 2).
- **K4 — eTIMS integration.** Invoice numbers reserved at issuance in the expected format; tax
  fields present on the invoice aggregate. → issue #10 (wave 2).
- **K5 — Sub-ledger ↔ GL reconciliation.** Posting matrix (docs/05) is the contract between
  Fuatilia and the accounting system; daily reconciliation job defined in wave 2.
- **K6 — Immutability & concurrency.** Posted money-movement rows are append-only; corrections
  are reversing entries; optimistic concurrency (version column) on receivables (R3).
