/**
 * Allocation — domain event constructors for the two `allocation.*` facts
 * owned by this lane (docs/04-event-catalog.md E24–E25).
 *
 * Envelope: { name, version, aggregateId, payload, occurredAt } — the wave-1
 * interim shape (see src/domain/events/README.md); the full typed catalog
 * with eventId/correlationId lands with issue #6. Payload key sets below are
 * the stable contract.
 *
 * Payloads are narrow and serializable: ids only and integer minor units
 * (bigint). occurredAt is an ISO-8601 string derived from the injected Clock —
 * never Date.now().
 */
import type { Clock, Uuid } from '../shared';
import type { AllocationSourceType, AllocationStrategy } from './allocation';

export type AllocationEventName = 'allocation.executed' | 'allocation.reversed';

/** Stable envelope (issue #5); unifies with the typed catalog in issue #6. */
export interface AllocationEvent<TName extends AllocationEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the injected Clock
}

/**
 * E24 — allocation.executed (Receivables, Ledger, Intelligence). Emitted per
 * posting row. `sourceType` is additive to the catalog payload (the ledger
 * posting matrix needs to know which fund pool moved).
 */
export interface AllocationExecutedPayload {
  readonly allocationId: Uuid;
  readonly sourceType: AllocationSourceType;
  readonly sourceId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: bigint;
  readonly strategy: AllocationStrategy;
}

/** E25 — allocation.reversed (Ledger). Emitted per reversal. */
export interface AllocationReversedPayload {
  readonly allocationId: Uuid; // the original row being undone
  readonly reason: string;
  readonly compensatingId: Uuid;
}

const emit = <TName extends AllocationEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): AllocationEvent<TName, TPayload> => ({
  name,
  version: 1,
  aggregateId,
  payload,
  occurredAt: clock.now().toISOString(),
});

/** E24 — aggregate is the allocation row itself. */
export const allocationExecutedEvent = (
  args: {
    allocationId: Uuid;
    sourceType: AllocationSourceType;
    sourceId: Uuid;
    receivableId: Uuid;
    amountMinor: bigint;
    strategy: AllocationStrategy;
  },
  clock: Clock,
): AllocationEvent<'allocation.executed', AllocationExecutedPayload> =>
  emit('allocation.executed', args.allocationId, { ...args }, clock);

/** E25 — aggregate is the ORIGINAL allocation row. */
export const allocationReversedEvent = (
  args: { allocationId: Uuid; reason: string; compensatingId: Uuid },
  clock: Clock,
): AllocationEvent<'allocation.reversed', AllocationReversedPayload> =>
  emit('allocation.reversed', args.allocationId, { ...args }, clock);
