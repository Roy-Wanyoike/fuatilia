# 04 — Event Catalog (27 core events)

Envelope contract lives in [`src/domain/events/README.md`](../src/domain/events/README.md).
All payloads reference aggregates by id only. Naming: `<context>.<aggregate><PastTenseVerb>`.

| # | Event | Producer | Key payload | Consumed by |
|---|-------|----------|-------------|-------------|
| E01 | `invoicing.invoiceNumberAllocated` | Invoicing | invoiceId, invoiceNumber, eTIMSRef | Ledger, Reporting |
| E02 | `invoicing.invoiceIssued` | Invoicing | invoiceId, customerId, totalMinor, currency, dueDate | Receivables, Notifications |
| E03 | `invoicing.invoiceSent` | Invoicing | invoiceId, channel, sentAt | Collections (engagement signal) |
| E04 | `invoicing.invoiceVoided` | Invoicing | invoiceId, reason, actorId | Receivables, Ledger |
| E05 | `receivable.opened` | Receivables | receivableId, invoiceId, originalMinor, dueDate | Collections, Intelligence |
| E06 | `receivable.partiallySettled` | Allocation | receivableId, amountMinor, remainingMinor | Collections, Notifications, Intelligence |
| E07 | `receivable.settled` | Allocation | receivableId, settledAt | Collections, Intelligence, Ledger |
| E08 | `receivable.overdue` | Receivables (policy) | receivableId, daysLate, agingBucket | Collections (case trigger) |
| E09 | `receivable.writtenOff` | Receivables | receivableId, reason, approvedBy | Ledger, Intelligence |
| E10 | `receivable.recovered` | Allocation | receivableId, amountMinor | Ledger, Intelligence |
| E11 | `payment.initiated` | Payments | paymentId, channel, requestedMinor | Notifications (STK prompt) |
| E12 | `payment.confirmed` | Payments | paymentId, confirmedMinor, externalRef, confirmedAt | Allocation, Reconciliation |
| E13 | `payment.failed` | Payments | paymentId, failureCode | Notifications, Intelligence |
| E14 | `payment.reversed` | Payments | paymentId, reason, reversalOf | Ledger, Allocation (compensating) |
| E15 | `payments.duplicateCallbackObserved` | Payments | paymentId, externalRef, seenAt | Ops/monitoring (C5 tripwire) |
| E16 | `reconciliation.paymentMatched` | Payments | matchId, paymentId, declaredRefs, confidence | Allocation (hint), Ops |
| E17 | `reconciliation.paymentPartiallyMatched` | Payments | matchId, paymentId, explainedMinor | Ops |
| E18 | `reconciliation.matchReversed` | Payments | matchId, reason | Allocation, Ledger |
| E19 | `adjustment.creditNoteIssued` | Adjustments | creditNoteId, customerId, totalMinor | Receivables (available credit) |
| E20 | `adjustment.creditNoteApplied` | Adjustments | applicationId, creditNoteId, receivableId, amountMinor | Ledger, Notifications |
| E21 | `adjustment.refundRequested` | Adjustments | refundId, paymentId, totalMinor, reason | Approvals, Ops |
| E22 | `adjustment.refundCompleted` | Adjustments | refundId, completedAt | Ledger, Notifications |
| E23 | `adjustment.creditBalanceApplied` | Adjustments | customerId, amountMinor, receivableId | Ledger, Notifications |
| E24 | `allocation.executed` | Allocation | allocationId, sourceId, receivableId, amountMinor, strategy | Receivables, Ledger, Intelligence |
| E25 | `allocation.reversed` | Allocation | allocationId, reason, compensatingId | Ledger |
| E26 | `collections.caseOpened` | Collections | caseId, receivableId, trigger | Intelligence |
| E27 | `collections.promiseBroken` | Collections | promiseId, caseId, expectedAt | Intelligence (priority boost) |

Deferred to wave 3 (not part of the core 27): `collections.promiseToPayMade`,
`collections.caseClosed`, `intelligence.priorityComputed`, `intelligence.feedbackRecorded`,
`notifications.dunningSent`, `consent.granted`, `consent.revoked`. The envelope is stable, so
adding them is purely additive.
