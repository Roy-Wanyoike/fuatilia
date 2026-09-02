/**
 * Refund + RefundAllocation — review finding C2, invariant R6 (docs/07).
 *
 * "Money leaves the building; pretending otherwise fails audits." Every refund
 * references its source Payment (opaque Uuid) so outflow is traceable to
 * confirmed funds. The ceiling (R6) is `confirmed − allocated − refunded-so-far`
 * — the caller computes it from a payment snapshot; this module hard-enforces
 * `amount ≤ ceiling` and throws REFUND_EXCEEDS_CEILING.
 *
 * State machine (docs/03):
 *   [*] → Requested → Approved → Processing → Completed
 *                ↘ Rejected            ↘ Failed → Processing (retry, NEW external ref)
 *
 * Pure functions only: aggregates are returned as new objects (append-only
 * spirit, R3 — never mutated in place). All money is Money (bigint minor units).
 */
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import type {
  AdjustmentEvent,
  RefundCompletedPayload,
  RefundRequestedPayload,
} from './events';
import { refundCompletedEvent, refundRequestedEvent } from './events';

export type RefundState =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'processing'
  | 'completed'
  | 'failed';

export type RefundAllocationSource = 'confirmed_funds' | 'credit_balance';

export interface Refund {
  readonly id: Uuid;
  /** Source Payment (C2): money flowing out must be traceable to confirmed funds. */
  readonly paymentId: Uuid;
  readonly requestedBy: string;
  readonly reason: string;
  readonly state: RefundState;
  /** Refund total ≤ payment confirmed − allocated − refunded-so-far (R6). */
  readonly total: Money;
  /** Current Daraja B2C external ref; every retry must use a NEW one (docs/03). */
  readonly externalRef?: string;
  readonly rejectedReason?: string;
  readonly failedReason?: string;
}

export interface RefundAllocation {
  readonly id: Uuid;
  readonly refundId: Uuid;
  readonly source: RefundAllocationSource;
  /** Σ(allocations) must equal refund.total exactly (docs/05). */
  readonly amount: Money;
}

export interface RequestRefundInput {
  readonly id: Uuid;
  readonly paymentId: Uuid;
  readonly amount: Money;
  readonly reason: string;
  readonly requestedBy: string;
}

export interface RefundRequested {
  readonly refund: Refund;
  readonly event: AdjustmentEvent<'adjustment.refundRequested', RefundRequestedPayload>;
}

export interface RefundCompleted {
  readonly refund: Refund;
  readonly event: AdjustmentEvent<'adjustment.refundCompleted', RefundCompletedPayload>;
}

const assertState = (refund: Refund, expected: RefundState, action: string): void => {
  if (refund.state !== expected) {
    throw new DomainError(
      'REFUND_INVALID_TRANSITION',
      `cannot ${action} refund in state '${refund.state}' (expected '${expected}')`,
      { refundId: refund.id, state: refund.state, expected },
    );
  }
};

/**
 * Create a Requested refund under the R6 ceiling. The caller computes the
 * ceiling from the payment snapshot: confirmed − allocated − refunded-so-far.
 */
export const requestRefund = (
  input: RequestRefundInput,
  ceiling: Money,
  clock: Clock,
): RefundRequested => {
  if (!input.reason.trim()) {
    throw new DomainError('REFUND_REASON_REQUIRED', 'a refund requires a reason (audit trail)');
  }
  if (!input.requestedBy.trim()) {
    throw new DomainError('REFUND_REQUESTER_REQUIRED', 'a refund requires a requester');
  }
  if (!input.amount.isPositive()) {
    throw new DomainError('REFUND_AMOUNT_INVALID', 'refund amount must be positive');
  }
  // R6 — hard ceiling. Money.compareTo also guards cross-currency attempts
  // (CURRENCY_MISMATCH) before the ceiling comparison can succeed.
  if (input.amount.compareTo(ceiling) > 0) {
    throw new DomainError(
      'REFUND_EXCEEDS_CEILING',
      `refund ${input.amount.toString()} exceeds ceiling ${ceiling.toString()}`,
      { requestedMinor: input.amount.amount, ceilingMinor: ceiling.amount, paymentId: input.paymentId },
    );
  }
  const refund: Refund = {
    id: input.id,
    paymentId: input.paymentId,
    requestedBy: input.requestedBy,
    reason: input.reason,
    state: 'requested',
    total: input.amount,
  };
  return {
    refund,
    event: refundRequestedEvent(
      {
        refundId: refund.id,
        paymentId: refund.paymentId,
        totalMinor: refund.total.amount,
        reason: refund.reason,
      },
      clock,
    ),
  };
};

/** Requested → Approved (docs/03). */
export const approveRefund = (refund: Refund): Refund => {
  assertState(refund, 'requested', 'approve');
  return { ...refund, state: 'approved' };
};

/** Requested → Rejected (over ceiling caught at request time; policy rejections land here). */
export const rejectRefund = (refund: Refund, rejectedReason?: string): Refund => {
  assertState(refund, 'requested', 'reject');
  return { ...refund, state: 'rejected', rejectedReason };
};

/**
 * Approved → Processing, or Failed → Processing (retry with a NEW external
 * ref — reusing the previous Daraja B2C ref throws REFUND_EXTERNAL_REF_REUSED).
 */
export const startRefundProcessing = (refund: Refund, b2cRef: string): Refund => {
  if (!b2cRef.trim()) {
    throw new DomainError('REFUND_EXTERNAL_REF_REQUIRED', 'a Daraja B2C external ref is required');
  }
  if (refund.state === 'approved') {
    return { ...refund, state: 'processing', externalRef: b2cRef };
  }
  if (refund.state === 'failed') {
    if (refund.externalRef === b2cRef) {
      throw new DomainError(
        'REFUND_EXTERNAL_REF_REUSED',
        'a retry must use a NEW external ref (docs/03 Refund machine)',
        { refundId: refund.id, previousRef: refund.externalRef },
      );
    }
    return { ...refund, state: 'processing', externalRef: b2cRef };
  }
  throw new DomainError(
    'REFUND_INVALID_TRANSITION',
    `cannot start processing from state '${refund.state}' (entry states: approved, failed)`,
    { refundId: refund.id, state: refund.state },
  );
};

/** Processing → Completed — emits E22 adjustment.refundCompleted. */
export const completeRefund = (refund: Refund, clock: Clock): RefundCompleted => {
  assertState(refund, 'processing', 'complete');
  return {
    refund: { ...refund, state: 'completed' },
    event: refundCompletedEvent(refund.id, clock),
  };
};

/** Processing → Failed — retriable via startRefundProcessing with a NEW ref. */
export const failRefund = (refund: Refund, failedReason?: string): Refund => {
  assertState(refund, 'processing', 'fail');
  return { ...refund, state: 'failed', failedReason };
};

export interface RefundAllocationInput {
  readonly id: Uuid;
  readonly source: RefundAllocationSource;
  readonly amount: Money;
}

/**
 * Validate funding rows for a refund and return the persisted RefundAllocation
 * shape. Guards (docs/05): every amount > 0, unique ids, single currency, and
 * Σ(rows) === refund.total EXACTLY. A `credit_balance` source requires explicit
 * consent === true (R6 / DPA 2019) — otherwise CONSENT_REQUIRED.
 */
export const allocateRefundFunds = (
  refund: Refund,
  rows: readonly RefundAllocationInput[],
  consent?: boolean,
): RefundAllocation[] => {
  if (rows.length === 0) {
    throw new DomainError('REFUND_ALLOCATION_EMPTY', 'at least one allocation row is required');
  }
  const seen = new Set<string>();
  let sum = 0n;
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new DomainError('REFUND_ALLOCATION_ID_DUPLICATE', `duplicate allocation row id ${row.id}`);
    }
    seen.add(row.id);
    if (!row.amount.isPositive()) {
      throw new DomainError('REFUND_ALLOCATION_AMOUNT_INVALID', 'allocation row amount must be positive');
    }
    if (row.amount.currency !== refund.total.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `allocation row ${row.amount.currency} does not match refund currency ${refund.total.currency}`,
      );
    }
    sum += row.amount.amount;
  }
  if (sum !== refund.total.amount) {
    throw new DomainError(
      'REFUND_ALLOCATION_SUM_MISMATCH',
      `allocation rows sum to ${sum} but refund total is ${refund.total.amount} — rows must sum EXACTLY to the refund total`,
      { sumMinor: sum, refundTotalMinor: refund.total.amount, refundId: refund.id },
    );
  }
  if (rows.some((row) => row.source === 'credit_balance') && consent !== true) {
    throw new DomainError(
      'CONSENT_REQUIRED',
      'refund sourced from credit balance requires explicit consent (R6 / DPA 2019)',
      { refundId: refund.id },
    );
  }
  return rows.map((row) => ({ id: row.id, refundId: refund.id, source: row.source, amount: row.amount }));
};
