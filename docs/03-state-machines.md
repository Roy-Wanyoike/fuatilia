# 03 — State Machines

Every lifecycle in the platform. The code implements these as pure transition functions; illegal
transitions throw `DomainError`. Mermaid renders natively on GitHub.

## Receivable

```mermaid
stateDiagram-v2
    [*] --> Draft: invoice drafted
    Draft --> Open: invoice issued (eTIMS number reserved)
    Open --> PartiallyPaid: allocation applied
    PartiallyPaid --> Settled: balance reaches zero
    Open --> Settled: allocation covers full balance
    Open --> Overdue: due date passed (flag)
    PartiallyPaid --> Overdue: due date passed
    Overdue --> Settled: allocation applied
    Open --> Voided: invoice voided before payment
    Overdue --> WrittenOff: approved write-off
    WrittenOff --> Recovered: late payment received
    Overdue --> Uncollectible: collections verdict
    Settled --> [*]
    Recovered --> [*]
    Uncollectible --> [*]
    Voided --> [*]
```

Notes: `Overdue` is derivable from `dueDate` but stored as a flag for query speed; write-off is a
decision with an owner and reason (H1), never a deletion. Recovery re-opens nothing — it is a
terminal state that records the outcome.

## Payment

```mermaid
stateDiagram-v2
    [*] --> Initiated: STK push OR C2B callback first sight
    Initiated --> PendingConfirmation: awaiting Daraja result
    Initiated --> Failed: user cancelled / timeout
    PendingConfirmation --> Confirmed: Daraja success callback (idempotent)
    PendingConfirmation --> Failed: Daraja failure callback
    Confirmed --> PartiallyAllocated: some amount allocated
    Confirmed --> Allocated: fully allocated
    Confirmed --> Unapplied: unidentified (parked on customer)
    PartiallyAllocated --> Allocated: remainder allocated
    PartiallyAllocated --> PartiallyRefunded: refund completed
    Allocated --> PartiallyRefunded: refund of allocated funds
    Confirmed --> Reversed: duplicate/reversal entry
    Unapplied --> Allocated: identified later
    Unapplied --> Refunded: consented refund of overpayment
    Refunded --> [*]
    Failed --> [*]
    Reversed --> [*]
```

Notes: duplicate Daraja callbacks are **expected** (at-least-once, K1). The intake funnel is
idempotent on `(channel, externalRef)` — a duplicate returns the existing Payment (R9, C5).
Unapplied money is never silently dropped: it parks on the customer and feeds the credit
balance decision (C4).

## CreditNote

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Issued: approved
    Issued --> PartiallyApplied: application(s) posted
    PartiallyApplied --> FullyApplied: nothing left to apply
    Issued --> Voided: never applied
    PartiallyApplied --> FullyApplied: remaining applied to credit balance
    FullyApplied --> [*]
    Voided --> [*]
```

## Refund

```mermaid
stateDiagram-v2
    [*] --> Requested
    Requested --> Approved: within ceiling (R6)
    Requested --> Rejected: over ceiling / policy
    Approved --> Processing: Daraja B2C initiated
    Processing --> Completed: success callback
    Processing --> Failed: failure callback
    Failed --> Processing: retry with new external ref
    Completed --> [*]
    Rejected --> [*]
```

## CollectionsCase

```mermaid
stateDiagram-v2
    [*] --> New: aging threshold crossed
    New --> InWork: agent/scheduled step engaged
    InWork --> PromisePending: promise to pay recorded
    PromisePending --> InWork: promise kept
    PromisePending --> InWork: promise broken (escalate priority)
    InWork --> Escalated: policy trigger
    InWork --> ClosedSettled: receivable settled
    Escalated --> ClosedSettled: receivable settled
    InWork --> ClosedUncollectible: verdict recorded
    Escalated --> ClosedUncollectible: verdict recorded
    ClosedSettled --> [*]
    ClosedUncollectible --> [*]
```

Note (R8 / H6): at most one case may be open per receivable at any instant — enforced in the
case-opening function.

## Invoice

```mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Issued: number reserved + totals frozen
    Issued --> Sent: delivery via channel
    Sent --> Voided: mistake (credit note preferred after payment exists)
    Issued --> Voided: never sent
    Voided --> [*]
```
