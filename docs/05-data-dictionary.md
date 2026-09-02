# 05 — Data Dictionary (core fields)

Types: `uuid`, `str`, `ts` (timestamptz), `i64` (minor units, bigint), `enum`, `bool`.
Every monetary row carries `currency`; every aggregate carries `createdAt`/`updatedAt` (omitted
below). "U" marks unique constraints — the concurrency backbone.

## Receivable
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK |
| invoiceId | uuid | FK invoice, unique (one receivable per invoice) |
| customerId | uuid | FK customer, indexed |
| originalMinor | i64 | ≥ 0, frozen at open |
| balanceMinor | i64 | ≥ 0; = original − applied (cached, recompute on allocation events) |
| state | enum | draft/open/partially_paid/settled/written_off/recovered/uncollectible/voided |
| dueDate | ts | indexed (aging scans) |
| writeOffReason | str? | required when state=written_off (H1) |

## Payment
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK |
| channel | enum | c2b / stk |
| externalRef | str | Daraja transaction id |
| idempotencyKey | str | **U(channel, externalRef)** and **U(idempotencyKey)** — R9/C5 |
| state | enum | initiated/pending_confirmation/confirmed/allocated/partially_allocated/unapplied/failed/reversed/partially_refunded/refunded |
| confirmedMinor | i64 | ≥ 0, set once at confirmation |
| unappliedMinor | i64 | derivable: confirmed − Σ allocations − Σ refunds |
| customerId | uuid? | null until identified; required when unapplied parking |

## ReconciliationMatch (v2 — points at Payment, C1)
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK |
| paymentId | uuid | FK payment — **the only target** (R5) |
| declaredRefs | str[] | payer-entered invoice/receipt references, may be fuzzy |
| confidence | enum | auto / manual |
| reversedAt | ts? | reversal appends a new match state, never edits (R3) |

## Allocation
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK |
| sourceType / sourceId | enum / uuid | payment / credit_balance |
| receivableId | uuid | FK receivable |
| amountMinor | i64 | > 0; Σ per source ≤ source confirmed/available (R2) |
| strategy | enum | fifo / explicit / pro_rata (H3) |
| sequenceNo | i64 | monotonic per source; with sourceId+receivableId defines idempotent replay |
| reversedAt | ts? | append-only correction pattern (R3) |

## Refund / RefundAllocation
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| refund.id | uuid | PK; paymentId FK (source of funds, C2) |
| refund.state | enum | requested/approved/processing/completed/failed/rejected |
| refund.totalMinor | i64 | ≤ payment confirmed − allocated − already refunded (R6) |
| refund_alloc.id | uuid | PK; refundId FK |
| refund_alloc.source | enum | confirmed_funds / credit_balance |
| refund_alloc.amountMinor | i64 | > 0; Σ = refund.totalMinor |

## CreditNote / application
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| credit_note.id | uuid | PK; customerId FK; invoiceId? FK |
| credit_note.state | enum | draft/issued/partially_applied/fully_applied/voided |
| credit_note.totalMinor | i64 | > 0 |
| credit_note_application.id | uuid | PK; creditNoteId + receivableId FKs |
| credit_note_application.amountMinor | i64 | > 0; Σ per note ≤ totalMinor (R7) |

## CustomerCreditBalance
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| customerId + currency | composite PK | one balance per currency (C4) |
| availableMinor | i64 | ≥ 0; = Σ movements (movements table is append-only) |

## CollectionsCase
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK; receivableId FK |
| state | enum | new/in_work/promise_pending/escalated/closed_settled/closed_uncollectible |
| **partial unique index** | — | **unique(receivableId) WHERE state NOT IN closed** — R8/H6 |

## ConsentGrant
| Field | Type | Constraints / notes |
|-------|------|---------------------|
| id | uuid | PK |
| customerId + channel + purpose | composite | indexed; dunning checks active grant (K2/K3) |
| grantedAt / revokedAt | ts | revoke = append revocation, never delete |

## Posting matrix (sub-ledger, K5/R4)
| Operation | Debit | Credit |
|-----------|-------|--------|
| Invoice issued | AR control | Revenue |
| Payment confirmed | M-Pesa float | AR control |
| Allocation executed | — (memo only; movement is within AR) | — |
| Refund completed | Refund clearing / expense | M-Pesa float |
| Credit balance applied | Credit balance liability | AR control |
| Late fee accrued (wave 2) | AR control | Fee income |
| Write-off | Bad debt expense | AR control |
