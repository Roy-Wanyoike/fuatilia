# 01 — Context Map

Fuatilia is organized as nine bounded contexts. The architecture follows one golden rule
inherited from the original design and re-affirmed by the v2 review:

> **The intelligence layer never owns fund truth.** Scoring, prioritization, and recommendations
> are read-only projections over events. Only the fund-truth contexts (Receivables, Payments,
> Adjustments, Allocation) can change what the customer owes or what money has moved.

## The nine contexts

| # | Context | Owns | Key aggregates | Notes |
|---|---------|------|----------------|-------|
| 1 | Customer & Consent | Customer master data, consent grants, channel preferences | `Customer`, `ConsentGrant` | DPA 2019 lawful basis lives here (K3) |
| 2 | Invoicing | Invoice issuance, numbering, delivery | `Invoice` | eTIMS-compliant numbering reserved at issuance (K4) |
| 3 | Receivables | The legal debt position and its lifecycle | `Receivable` | Created from an issued invoice; never edited after Open |
| 4 | Payments & Reconciliation | Inbound money and its identification | `Payment`, `ReconciliationMatch` | Daraja channel adapters live here; intake is idempotent (C5) |
| 5 | Adjustments | Money flowing backwards or sideways | `Refund`, `CreditNote`, `CustomerCreditBalance` | C2/C3/C4 fixes; consented balance application |
| 6 | Allocation | The single settling funnel | `Allocation` | Strategy chain; FIFO oldest-invoice-first default (H3) |
| 7 | Collections | Case management, dunning, promises | `CollectionsCase`, `DunningStep` | One open case per receivable (H6) |
| 8 | Ledger & Accounting | Sub-ledger postings, GL reconciliation | `LedgerEntry` | Posting matrix in docs/05 (K5); append-only (R3) |
| 9 | Collections Intelligence | Prioritization, propensity scoring | (projections only) | Read-only over events; feedback loop via outcome events (H7) |

## Relationship highlights

- **Invoicing → Receivables**: issuing an invoice opens a receivable; cancelling or crediting
  an invoice is expressed as a credit note application, never by editing history.
- **Payments → Allocation → Receivables**: payments are confirmed first, then allocated through
  exactly one funnel. Receivables never touch payment channels directly.
- **Adjustments ↔ Payments**: refunds always reference a confirmed payment; credit balances can
  later be allocated like a payment, but only with customer consent.
- **Collections → events only**: Collections reads receivable aging projections and writes only
  its own aggregates. It cannot alter a balance.
- **Intelligence → events only**: as above; recommendations flow back as suggestions that a human
  or policy layer may act on (H7 feedback loop).
- **Daraja (M-Pesa)**: an external gateway behind the Payments context. Callbacks are
  **at-least-once** (K1) — every consumer of channel input must be idempotent (R9).

## Anti-corruption boundaries

Channel payloads (Daraja STK/C2B), WhatsApp templates, and eTIMS schemas are translated at the
boundary into domain commands. No external schema leaks into the core.
