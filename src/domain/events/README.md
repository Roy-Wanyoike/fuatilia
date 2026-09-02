# Event conventions — wave 2 (issue #6) owns the typed catalog

All domain events follow `<context>.<Aggregate><PastTenseVerb>` in `camelCase` strings,
e.g. `receivable.opened`, `payment.confirmed`, `reconciliation.matchReversed`.

## Envelope (stable contract)
```ts
interface DomainEvent<TName extends string, TPayload> {
  eventId: Uuid;          // unique, assigned at creation
  name: TName;            // e.g. 'payment.confirmed'
  version: 1;             // schema version — breaking payload changes bump this
  occurredAt: ISO8601;    // from the injected Clock
  aggregateId: Uuid;      // owning aggregate
  correlationId?: Uuid;   // ties a payment journey together
  payload: TPayload;      // narrow, serializable, no entity references — ids only
}
```

## Rules
- Events are immutable facts. Consumers (collections intelligence, notifications, ledger)
  subscribe; the smart layer NEVER writes to fund-truth aggregates (golden rule, docs/01).
- Outbox pattern: events are appended in the same transaction as the state change
  (implementation lands with persistence adapters, wave 2/3).

## Full catalog
See `docs/04-event-catalog.md` (27 core events).
