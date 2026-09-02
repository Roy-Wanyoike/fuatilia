# 02 — Domain Model (v2)

Entity catalog per context, followed by the delta from the reviewed v1 model.

## Aggregates and entities

### Customer & Consent
- `Customer` — id, billingProfile, channels (msisdn, email), segment, riskTier.
- `ConsentGrant` — id, customerId, channel (whatsapp|sms|email), purpose (dunning|marketing),
  grantedAt, revokedAt. **No dunning message may be sent without an active grant** (K2/K3).

### Invoicing
- `Invoice` — id, customerId, invoiceNumber (eTIMS-reserved), issuedAt, dueDate, currency,
  lineItems, totalMinor, status (draft|issued|sent|voided).

### Receivables
- `Receivable` — id, invoiceId, customerId, originalMinor, balanceMinor (derivable, cached),
  currency, openedAt, dueDate, state, agingBucket (derived), writeOffReason?.
- `AgingSnapshot` — computed projection per receivable for collections.

### Payments & Reconciliation
- `Payment` — id, customerId?, channel (c2b|stk), externalRef, idempotencyKey,
  state, confirmedMinor, unappliedMinor (derivable), currency, initiatedAt, confirmedAt.
- `ReconciliationMatch` — id, **paymentId (the only target — v2 fix C1)**, declaredRefs[]
  (invoice/receipt numbers as typed by the payer), matchedAt, confidence (auto|manual),
  reversedAt?.

### Adjustments
- `Refund` — id, paymentId, requestedBy, reason, state, totalMinor, currency.
- `RefundAllocation` — id, refundId, source (confirmedFunds|creditBalance), amountMinor.
- `CreditNote` — id, customerId, invoiceId?, reason, totalMinor, appliedMinor (derivable),
  state, issuedAt, voidedAt?.
- `CreditNoteApplication` — id, creditNoteId, receivableId, amountMinor, appliedAt.
- `CustomerCreditBalance` — customerId (PK), currency, availableMinor; movement log append-only.

### Allocation
- `Allocation` — id, sourceType (payment|creditBalance), sourceId, receivableId, amountMinor,
  strategy (fifo|explicit|proRata), sequenceNo, allocatedAt, reversedAt?. Append-only (R3).

### Collections
- `CollectionsCase` — id, receivableId, customerId, state, openedAt, closedAt?, owner.
  **Invariant R8: at most one open case per receivable.**
- `DunningStep` — id, caseId, channel, templateId, scheduledFor, sentAt?, requiresConsent=true.
- `PromiseToPay` — id, caseId, promisedAt, amountMinor, kept?.

### Ledger & Accounting
- `LedgerEntry` — id, postingDate, account (ar_control|revenue|mpesa_float|fees_income|
  bad_debt_expense|credit_balance_liability|refund_clearing), direction (debit|credit),
  amountMinor, currency, sourceType, sourceId. Append-only (R3).

### Collections Intelligence
- Projections only: `PriorityScore`, `SegmentStats`, `OutcomeFeedback` (H7 — closes the loop by
  consuming collection outcomes and retraining/adjusting scoring).

## v2 delta from the reviewed model

### New entities (9)
`Refund`, `RefundAllocation`, `CreditNote` (now defined, C3), `CreditNoteApplication`,
`CustomerCreditBalance`, `ConsentGrant`, `DunningStep`, `PromiseToPay`, `LedgerEntry`
(posting matrix made explicit).

### Corrections (8)
1. `ReconciliationMatch` re-pointed from Receivable to **Payment** (C1).
2. `Payment` gained `channel`, `externalRef`, `idempotencyKey` (C5/R9).
3. `Receivable` gained explicit lifecycle states + write-off ownership (H1).
4. `Allocation` gained `strategy` and `sequenceNo`; append-only semantics (H3/R3).
5. `CustomerCreditBalance` added as the home for overpayments (C4).
6. `CreditNote` gained lifecycle + application children instead of being a name-only stub (C3).
7. Refund path modeled at all (C2) — was implicit in "payment reversals".
8. Multi-currency pinned: every monetary aggregate carries `currency`; cross-currency settlement
   requires an explicit FX posting (H2/R10, wave 2).
