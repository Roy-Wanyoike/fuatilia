/**
 * Allocation engine (issue #5) — the single pure funnel that turns a source
 * of funds + a strategy into append-only Allocation rows and `allocation.*`
 * events (docs/04 E24–E25).
 *
 * Guarantees:
 *   - pure & deterministic: no I/O, no RNG, no Date.now(); time comes from the
 *     injected Clock (one timestamp per execution — a batch is atomic);
 *   - idempotent on replay: identical inputs (source, receivables, strategy,
 *     declared, existingAllocations) produce identical rows — ids are derived
 *     deterministically from (source, strategy, sequenceNo, receivable,
 *     amount) and sequenceNos continue monotonically per source (docs/05),
 *     so the same logical command replays to the same rows;
 *   - R1/R2: the engine re-checks the strategy plan (Σ ≤ available, per-
 *     receivable caps already enforced by the strategies) before building rows;
 *   - R3: `reverseAllocation` never mutates history — it appends a
 *     compensating row (`reversalOf`) and stamps `reversedAt` on the original,
 *     emitting `allocation.reversed`.
 */
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  ALLOCATION_ERRORS,
  allocationOf,
  unappliedRemainder,
  type Allocation,
  type AllocationSource,
  type AllocationStrategy,
  type AllocatableReceivable,
} from './allocation';
import { allocationExecutedEvent, allocationReversedEvent } from './events';
import type { AllocationEvent, AllocationExecutedPayload, AllocationReversedPayload } from './events';
import { uuidFromSeed } from './ids';
import { allocateExplicit, allocateOldestFirst, allocateProRata, type StrategyPlan } from './strategies';

export interface ExecuteAllocationArgs {
  readonly source: AllocationSource;
  readonly receivables: readonly AllocatableReceivable[];
  readonly strategy: AllocationStrategy;
  readonly clock: Clock;
  /** Required iff strategy is 'explicit' (the declared split). */
  readonly declared?: ReadonlyMap<Uuid, Money>;
  /**
   * Rows already on this source — sequenceNos continue monotonically after
   * them. Pass the same rows on replay for idempotent results.
   */
  readonly existingAllocations?: readonly Allocation[];
}

export interface AllocationExecution {
  readonly allocations: readonly Allocation[];
  readonly events: readonly AllocationEvent<'allocation.executed', AllocationExecutedPayload>[];
  /** R2 — funds that stay unapplied (parks on the customer, feeds C4). */
  readonly unapplied: Money;
}

/** Single dispatch point for the H3 strategy chain. */
export const planWithStrategy = (
  strategy: AllocationStrategy,
  funds: Money,
  receivables: readonly AllocatableReceivable[],
  declared?: ReadonlyMap<Uuid, Money>,
): StrategyPlan[] => {
  if (strategy === 'fifo') return allocateOldestFirst(funds, receivables);
  if (strategy === 'pro_rata') return allocateProRata(funds, receivables);
  if (declared === undefined) {
    throw new DomainError(
      ALLOCATION_ERRORS.DECLARATION_REQUIRED,
      "strategy 'explicit' requires a declared split",
    );
  }
  return allocateExplicit(funds, receivables, declared);
};

const nextSequenceNo = (rows: readonly Allocation[], sourceId: Uuid, sourceType: Allocation['sourceType']): bigint =>
  rows
    .filter((row) => row.sourceId === sourceId && row.sourceType === sourceType)
    .reduce((max, row) => (row.sequenceNo > max ? row.sequenceNo : max), 0n) + 1n;

/**
 * Execute one allocation: plan with the chosen strategy, re-verify R2, build
 * append-only rows (derived deterministic ids, monotonic sequenceNos, one
 * batch timestamp from the Clock) and one `allocation.executed` event per row.
 * A plan that cannot absorb the funds simply leaves the remainder unapplied.
 */
export const executeAllocation = (args: ExecuteAllocationArgs): AllocationExecution => {
  const { source, receivables, strategy, clock, declared, existingAllocations = [] } = args;

  if (strategy !== 'explicit' && declared !== undefined) {
    throw new DomainError(
      ALLOCATION_ERRORS.DECLARATION_NOT_ALLOWED,
      `strategy '${strategy}' takes no declared split`,
    );
  }
  if (source.available.currency !== source.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `source funds are ${source.available.currency}, source declares ${source.currency}`,
    );
  }

  const plans = planWithStrategy(strategy, source.available, receivables, declared);

  // R2 — defense in depth: strategies guarantee this; the engine re-verifies.
  const allocated = plans.reduce((sum, plan) => sum + plan.amount.amount, 0n);
  if (allocated > source.available.amount) {
    throw new DomainError(
      ALLOCATION_ERRORS.EXCEEDS_AVAILABLE,
      `plan of ${allocated} exceeds available ${source.available.amount}`,
    );
  }

  const allocatedAt = clock.now();
  const base = nextSequenceNo(existingAllocations, source.sourceId, source.sourceType);
  const allocations = plans.map((plan, index) => {
    const sequenceNo = base + BigInt(index);
    return allocationOf({
      id: uuidFromSeed(
        `allocation:${source.sourceType}:${source.sourceId}:${strategy}:${sequenceNo}:${plan.receivableId}:${plan.amount.amount}`,
      ),
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      receivableId: plan.receivableId,
      amount: plan.amount,
      strategy,
      sequenceNo,
      allocatedAt,
    });
  });

  const events = allocations.map((row) =>
    allocationExecutedEvent(
      {
        allocationId: row.id,
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        receivableId: row.receivableId,
        amountMinor: row.amountMinor.amount,
        strategy: row.strategy,
      },
      clock,
    ),
  );

  return { allocations, events, unapplied: unappliedRemainder(source.available, allocations) };
};

export interface AllocationReversal {
  /** The original row with `reversedAt` stamped (R3 — never deleted). */
  readonly original: Allocation;
  /** The appended compensating row (`reversalOf` → original.id). */
  readonly compensating: Allocation;
  readonly events: readonly AllocationEvent<'allocation.reversed', AllocationReversedPayload>[];
}

/**
 * Reverse one allocation (R3): append a compensating row for the same
 * source/receivable/amount and stamp `reversedAt` on the original. The freed
 * funds return to the source's unapplied pool (validateAllocations counts
 * active rows only).
 *
 * Guards: a reason is mandatory (REVERSAL_REASON_REQUIRED); an already
 * reversed row cannot be reversed again (ALLOCATION_ALREADY_REVERSED); a
 * compensating row cannot itself be reversed (ALLOCATION_REVERSAL_NOT_ALLOWED
 * — un-doing a correction is a new business decision, not this function).
 * The compensating row inherits the original's sequenceNo slot by default;
 * pass options.sequenceNo to place it at the tip of the source's ledger.
 */
export const reverseAllocation = (
  original: Allocation,
  reason: string,
  clock: Clock,
  options?: { readonly sequenceNo?: bigint },
): AllocationReversal => {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new DomainError(ALLOCATION_ERRORS.REVERSAL_REASON_REQUIRED, 'a reversal reason is required (R3)');
  }
  if (original.reversedAt !== null) {
    throw new DomainError(
      ALLOCATION_ERRORS.ALREADY_REVERSED,
      `allocation ${original.id} was already reversed at ${original.reversedAt.toISOString()}`,
    );
  }
  if (original.reversalOf !== null) {
    throw new DomainError(
      ALLOCATION_ERRORS.REVERSAL_NOT_ALLOWED,
      `allocation ${original.id} is itself a compensating row and cannot be reversed`,
    );
  }

  const reversedAt = clock.now();
  const compensating = allocationOf({
    id: uuidFromSeed(`allocation-reversal:${original.id}`),
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    receivableId: original.receivableId,
    amount: original.amountMinor,
    strategy: original.strategy,
    sequenceNo: options?.sequenceNo ?? original.sequenceNo,
    allocatedAt: reversedAt,
    reversalOf: original.id,
  });

  const reversed: Allocation = { ...original, reversedAt };

  return {
    original: reversed,
    compensating,
    events: [
      allocationReversedEvent(
        { allocationId: original.id, reason: trimmed, compensatingId: compensating.id },
        clock,
      ),
    ],
  };
};
