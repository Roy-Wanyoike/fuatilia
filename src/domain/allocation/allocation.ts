/**
 * Allocation — the append-only row type and the R1/R2 invariant helpers
 * (issue #5; review finding H3).
 *
 * Model (docs/02 §Allocation, docs/05 §Allocation):
 *   One `Allocation` row moves value from ONE source of funds
 *   (payment | credit_balance) to ONE receivable. Rows are append-only (R3):
 *   a correction appends a compensating row (`reversalOf` set) and stamps
 *   `reversedAt` on the original — rows are never mutated or deleted.
 *   The `reversalOf` linkage is what marks a row as compensating, so naive
 *   Σ(amount) bookkeeping must only count "active" rows.
 *
 * Invariants owned here (docs/07-invariants.md):
 *   R1  — balance integrity: receivable balance = original − Σ(active
 *         allocations); never negative (`balanceAfter` trips
 *         BALANCE_OVER_ALLOCATED instead of returning a negative).
 *   R2  — no over-allocation: Σ(active rows of one source) ≤ the source's
 *         available funds; the remainder stays unapplied (parks on the
 *         customer, feeds C4).
 *   R3  — append-only postings: reversal = compensating row + reversedAt.
 *   R10 — single-currency arithmetic (CURRENCY_MISMATCH otherwise).
 *
 * Cross-module rule: this lane imports ONLY from `../shared`. Receivables and
 * payments appear as structural views (opaque ids + minor-unit numbers), never
 * as another module's entity types.
 */
import { DomainError, Money } from '../shared';
import type { Currency, MoneyInput, Uuid } from '../shared';

export type AllocationSourceType = 'payment' | 'credit_balance';

/** docs/05: strategy enum — fifo (default, H3) / explicit / pro_rata. */
export type AllocationStrategy = 'fifo' | 'explicit' | 'pro_rata';

/**
 * The append-only posting row. `amountMinor` is a positive Money in the
 * source's currency; `sequenceNo` is monotonic per source (docs/05) and, with
 * sourceId + receivableId + amount, defines idempotent replay.
 */
export interface Allocation {
  readonly id: Uuid;
  readonly sourceType: AllocationSourceType;
  readonly sourceId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: Money; // > 0 (docs/05)
  readonly strategy: AllocationStrategy;
  readonly sequenceNo: bigint; // monotonic per source, >= 1
  readonly allocatedAt: Date;
  /** R3 — stamped when this row has been reversed. */
  readonly reversedAt: Date | null;
  /** R3 — set on a compensating row; points at the row it undoes. */
  readonly reversalOf: Uuid | null;
}

/**
 * Structural receivable view — the only shape allocation needs. The caller
 * (adapter) maps the receivables aggregate onto this; no cross-module import.
 * `balanceMinor` is the outstanding balance (original − Σ applied) and is the
 * hard per-receivable ceiling for every strategy.
 */
export interface AllocatableReceivable {
  readonly receivableId: Uuid;
  readonly currency: Currency;
  /** Outstanding balance in minor units (raw bigint) or as Money. */
  readonly balanceMinor: MoneyInput | Money;
  /** Oldest-invoice-first ordering key; undated receivables sort last. */
  readonly dueDate?: Date;
}

/**
 * Structural source-of-funds view. `available` is what may be allocated NOW
 * (payment.confirmed − prior allocations for a payment; the consented
 * available figure for a credit balance) in `currency`.
 */
export interface AllocationSource {
  readonly sourceType: AllocationSourceType;
  readonly sourceId: Uuid;
  readonly currency: Currency;
  readonly available: Money;
}

/** Stable failure codes for this lane. */
export const ALLOCATION_ERRORS = {
  AMOUNT_NOT_POSITIVE: 'ALLOCATION_AMOUNT_NOT_POSITIVE',
  SOURCE_MISMATCH: 'ALLOCATION_SOURCE_MISMATCH',
  EXCEEDS_AVAILABLE: 'ALLOCATION_EXCEEDS_AVAILABLE',
  EXCEEDS_BALANCE: 'ALLOCATION_EXCEEDS_BALANCE',
  BALANCE_OVER_ALLOCATED: 'BALANCE_OVER_ALLOCATED',
  BALANCE_NEGATIVE: 'BALANCE_NEGATIVE',
  DUPLICATE_RECEIVABLE: 'ALLOCATION_DUPLICATE_RECEIVABLE',
  UNKNOWN_RECEIVABLE: 'ALLOCATION_UNKNOWN_RECEIVABLE',
  DECLARATION_REQUIRED: 'ALLOCATION_DECLARATION_REQUIRED',
  DECLARATION_NOT_ALLOWED: 'ALLOCATION_DECLARATION_NOT_ALLOWED',
  SEQUENCE_INVALID: 'ALLOCATION_SEQUENCE_INVALID',
  REVERSAL_REASON_REQUIRED: 'REVERSAL_REASON_REQUIRED',
  ALREADY_REVERSED: 'ALLOCATION_ALREADY_REVERSED',
  REVERSAL_NOT_ALLOWED: 'ALLOCATION_REVERSAL_NOT_ALLOWED',
} as const;

/**
 * Build/validate one row (adapter ingestion + engine + test fixtures).
 * Guards: positive amount, sequenceNo >= 1, Money instance — DomainError
 * otherwise, so the append-only log can never hold a junk row.
 */
export const allocationOf = (args: {
  id: Uuid;
  sourceType: AllocationSourceType;
  sourceId: Uuid;
  receivableId: Uuid;
  amount: Money;
  strategy: AllocationStrategy;
  sequenceNo: bigint;
  allocatedAt: Date;
  reversalOf?: Uuid;
}): Allocation => {
  if (!(args.amount instanceof Money)) {
    throw new DomainError(ALLOCATION_ERRORS.AMOUNT_NOT_POSITIVE, 'amount must be Money');
  }
  if (!args.amount.isPositive()) {
    throw new DomainError(
      ALLOCATION_ERRORS.AMOUNT_NOT_POSITIVE,
      `allocation amount must be > 0, got ${args.amount.amount}`,
    );
  }
  if (args.sequenceNo < 1n) {
    throw new DomainError(
      ALLOCATION_ERRORS.SEQUENCE_INVALID,
      `sequenceNo must be >= 1, got ${args.sequenceNo}`,
    );
  }
  return {
    id: args.id,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    receivableId: args.receivableId,
    amountMinor: args.amount,
    strategy: args.strategy,
    sequenceNo: args.sequenceNo,
    allocatedAt: args.allocatedAt,
    reversedAt: null,
    reversalOf: args.reversalOf ?? null,
  };
};

/**
 * Normalize a receivable's outstanding balance to Money in its own currency.
 * A Money input whose currency disagrees with the receivable's declared
 * currency is a modelling bug → CURRENCY_MISMATCH (R10).
 */
export const balanceOf = (receivable: AllocatableReceivable): Money => {
  const { balanceMinor, currency } = receivable;
  if (balanceMinor instanceof Money) {
    if (balanceMinor.currency !== currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `receivable ${receivable.receivableId} declares ${currency} but its balance is ${balanceMinor.currency}`,
      );
    }
    return balanceMinor;
  }
  return Money.ofMinor(balanceMinor, currency);
};

/** A row contributes to balances only while it is unreversed and non-compensating. */
export const isActive = (row: Allocation): boolean =>
  row.reversedAt === null && row.reversalOf === null;

/** Active rows only (R1/R2 arithmetic ignores reversed + compensating rows). */
export const activeAllocations = (rows: readonly Allocation[]): Allocation[] =>
  rows.filter(isActive);

/** Σ active allocation minor units applied to one receivable (R1 input). */
export const allocatedMinorTo = (rows: readonly Allocation[], receivableId: Uuid): bigint =>
  activeAllocations(rows)
    .filter((row) => row.receivableId === receivableId)
    .reduce((sum, row) => sum + row.amountMinor.amount, 0n);

/**
 * R1 — the receivable balance after applying the given rows. Never negative:
 * rows that would push it past the outstanding balance trip
 * BALANCE_OVER_ALLOCATED (over-allocation attempt, R2 on the receivable side).
 */
export const balanceAfter = (
  receivable: AllocatableReceivable,
  rows: readonly Allocation[],
): Money => {
  const applied = allocatedMinorTo(rows, receivable.receivableId);
  const balance = balanceOf(receivable);
  if (applied > balance.amount) {
    throw new DomainError(
      ALLOCATION_ERRORS.BALANCE_OVER_ALLOCATED,
      `allocations of ${applied} exceed outstanding ${balance.amount} on ${receivable.receivableId}`,
    );
  }
  return Money.ofMinor(balance.amount - applied, receivable.currency);
};

/**
 * R2 — funds of a source that remain unapplied after the given rows
 * (confirmed − Σ allocations, docs/05 `unappliedMinor`).
 */
export const unappliedRemainder = (sourceAvailable: Money, rows: readonly Allocation[]): Money => {
  const allocated = activeAllocations(rows).reduce((sum, row) => sum + row.amountMinor.amount, 0n);
  if (allocated > sourceAvailable.amount) {
    throw new DomainError(
      ALLOCATION_ERRORS.EXCEEDS_AVAILABLE,
      `allocations of ${allocated} exceed available ${sourceAvailable.amount}`,
    );
  }
  return Money.ofMinor(sourceAvailable.amount - allocated, sourceAvailable.currency);
};

/**
 * R2 ceiling check for a single source's rows (call once per source).
 * - every row must belong to the same (sourceType, sourceId) as the funds;
 * - currency must match the available funds (R10);
 * - every amount strictly positive (no negatives — Money is non-negative by
 *   construction, zero rows are junk);
 * - Σ ACTIVE rows ≤ available — reversed rows and their compensating entries
 *   cancel out, so a reversal correctly frees capacity for re-allocation.
 */
export const validateAllocations = (rows: readonly Allocation[], sourceAvailable: Money): void => {
  const first = rows[0];
  for (const row of rows) {
    if (
      first !== undefined &&
      (row.sourceType !== first.sourceType || row.sourceId !== first.sourceId)
    ) {
      throw new DomainError(
        ALLOCATION_ERRORS.SOURCE_MISMATCH,
        'rows span multiple sources; validate one source at a time',
      );
    }
    if (row.amountMinor.currency !== sourceAvailable.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `allocation row ${row.id} is ${row.amountMinor.currency}, source funds are ${sourceAvailable.currency}`,
      );
    }
    if (!row.amountMinor.isPositive()) {
      throw new DomainError(
        ALLOCATION_ERRORS.AMOUNT_NOT_POSITIVE,
        `allocation row ${row.id} amount must be > 0`,
      );
    }
  }
  unappliedRemainder(sourceAvailable, rows);
};
