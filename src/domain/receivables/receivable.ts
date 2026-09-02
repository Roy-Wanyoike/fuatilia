/**
 * Receivable — the legal debt position (issue #1; fixes review finding H1:
 * "Receivable lifecycle missing; bad debt had no owner").
 *
 * Lifecycle (docs/03-state-machines.md), with `overdue` as a stored FLAG (not a
 * state — it is derivable from dueDate and cached for query speed):
 *
 *   draft → open → partially_paid → settled
 *   open/partially_paid + overdue flag → written_off | uncollectible | voided
 *   overdue + allocation → settled
 *   written_off + late payment → recovered (terminal; re-opens nothing)
 *
 * H1 fix: write-off is an APPROVED DECISION — reason + approver are mandatory
 * and stored on the aggregate. It changes state, never deletes; the receivable
 * (and its audit trail) continues to exist.
 *
 * Invariants honored here:
 *   R1 — balance = original − applied, never negative; settled ⇔ balance 0.
 *   R10 — single-currency arithmetic (cross-currency throws CURRENCY_MISMATCH).
 *   Exactly one receivable per invoice (docs/05: invoiceId unique) — the slot
 *   is owned by the Invoice aggregate's `receivableId` and guarded at open.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock, ids passed in as opaque Uuids. Illegal transitions throw
 * DomainError with stable SCREAMING_SNAKE codes.
 */
import { DomainError, Money, type Clock, type Currency, type Uuid } from '../shared';
import { agingBucket, daysPastDue } from './aging';
import {
  domainEvent,
  minorToNumber,
  type DomainEvent,
  type ReceivableEvent,
  type ReceivableOpenedPayload,
  type ReceivableOverduePayload,
  type ReceivablePartiallySettledPayload,
  type ReceivableRecoveredPayload,
  type ReceivableSettledPayload,
  type ReceivableWrittenOffPayload,
} from './events';
import type { Invoice } from './invoice';

export type ReceivableState =
  | 'draft'
  | 'open'
  | 'partially_paid'
  | 'settled'
  | 'written_off'
  | 'recovered'
  | 'uncollectible'
  | 'voided';

/** The H1 audit record: who approved the write-off, why, and when. */
export interface ReceivableWriteOff {
  readonly reason: string;
  readonly approvedBy: string;
  readonly writtenOffAt: Date;
}

export interface Receivable {
  readonly id: Uuid;
  readonly invoiceId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  /** Frozen at open (docs/05). */
  readonly original: Money;
  /** Σ allocations applied so far. */
  readonly applied: Money;
  readonly state: ReceivableState;
  /**
   * Stored flag (derivable from dueDate, cached for query speed — docs/03).
   * Only ever true while the debt is live (open / partially_paid).
   */
  readonly overdue: boolean;
  readonly openedAt: Date | null;
  readonly dueDate: Date;
  readonly settledAt: Date | null;
  readonly voidedAt: Date | null;
  readonly writeOff: ReceivableWriteOff | null;
  readonly uncollectibleReason: string | null;
  readonly uncollectibleAt: Date | null;
  readonly recoveredAt: Date | null;
}

/** R1, the receivable side: balance = original − applied (never negative). */
export function balanceOf(receivable: Receivable): Money {
  return receivable.original.subtract(receivable.applied);
}

const buildReceivable = (args: {
  id: Uuid;
  invoice: Invoice;
  state: ReceivableState;
}): Receivable => ({
  id: args.id,
  invoiceId: args.invoice.id,
  customerId: args.invoice.customerId,
  currency: args.invoice.currency,
  original: args.invoice.total,
  applied: Money.zero(args.invoice.currency),
  state: args.state,
  overdue: false,
  openedAt: null,
  dueDate: args.invoice.dueDate,
  settledAt: null,
  voidedAt: null,
  writeOff: null,
  uncollectibleReason: null,
  uncollectibleAt: null,
  recoveredAt: null,
});

/**
 * Pair a draft receivable with a draft invoice (docs/03: `[*] --> Draft:
 * invoice drafted`). Takes the invoice's exactly-one receivable slot; the
 * receivable opens when the invoice is issued (Draft → Open).
 */
export function draftReceivableFor(
  invoice: Invoice,
  receivableId: Uuid,
): { invoice: Invoice; receivable: Receivable } {
  if (invoice.status !== 'draft') {
    throw new DomainError(
      'INVOICE_NOT_DRAFT',
      `receivables are drafted alongside draft invoices, not ${invoice.status} ones`,
      { status: invoice.status },
    );
  }
  if (invoice.receivableId !== null) {
    throw new DomainError(
      'RECEIVABLE_ALREADY_OPEN',
      `invoice ${invoice.id} already has receivable ${invoice.receivableId} — exactly one per invoice`,
    );
  }
  return {
    invoice: { ...invoice, receivableId },
    receivable: buildReceivable({ id: receivableId, invoice, state: 'draft' }),
  };
}

/**
 * Open the receivable for an ISSUED invoice (totals frozen, eTIMS number
 * reserved — docs/03: `Draft --> Open: invoice issued`).
 *
 * Two modes:
 *  - create (default): builds the receivable from the invoice, in state 'open'.
 *  - transition: pass the previously paired `draft` receivable to move it
 *    Draft → Open; its identity and pairing are re-validated against the
 *    invoice.
 *
 * Guards the exactly-one rule both ways: a second receivable for the same
 * invoice, or re-opening an already-open one, throws RECEIVABLE_ALREADY_OPEN.
 */
export function openReceivable(
  invoice: Invoice,
  receivableId: Uuid,
  clock: Clock,
  draft?: Receivable,
): {
  invoice: Invoice;
  receivable: Receivable;
  event: DomainEvent<'receivable.opened', ReceivableOpenedPayload>;
} {
  if (invoice.status !== 'issued') {
    throw new DomainError(
      'INVOICE_NOT_ISSUED',
      `receivables open from issued invoices only, got ${invoice.status}`,
      { status: invoice.status },
    );
  }
  if (!invoice.total.isPositive()) {
    throw new DomainError(
      'INVOICE_TOTAL_ZERO',
      `invoice ${invoice.id} totals zero — no debt, no receivable`,
    );
  }

  let opened: Receivable;
  if (draft) {
    if (draft.id !== receivableId) {
      throw new DomainError(
        'RECEIVABLE_INVOICE_MISMATCH',
        `receivableId ${receivableId} does not match the paired draft ${draft.id}`,
      );
    }
    if (draft.invoiceId !== invoice.id) {
      throw new DomainError(
        'RECEIVABLE_INVOICE_MISMATCH',
        `receivable ${draft.id} is paired with invoice ${draft.invoiceId}, not ${invoice.id}`,
      );
    }
    if (draft.state !== 'draft') {
      throw new DomainError(
        'RECEIVABLE_ALREADY_OPEN',
        `receivable ${draft.id} is already ${draft.state} — exactly one open per invoice`,
      );
    }
    if (
      draft.currency !== invoice.currency ||
      !draft.original.equals(invoice.total) ||
      draft.customerId !== invoice.customerId ||
      draft.dueDate.getTime() !== invoice.dueDate.getTime()
    ) {
      throw new DomainError(
        'RECEIVABLE_INVOICE_MISMATCH',
        `paired draft ${draft.id} no longer matches invoice ${invoice.id} (currency/original/customer/dueDate)`,
      );
    }
    if (invoice.receivableId !== null && invoice.receivableId !== draft.id) {
      throw new DomainError(
        'RECEIVABLE_ALREADY_OPEN',
        `invoice ${invoice.id} already has receivable ${invoice.receivableId} — exactly one per invoice`,
      );
    }
    opened = { ...draft, state: 'open', openedAt: clock.now() };
  } else {
    if (invoice.receivableId !== null) {
      throw new DomainError(
        'RECEIVABLE_ALREADY_OPEN',
        `invoice ${invoice.id} already has receivable ${invoice.receivableId} — exactly one per invoice`,
      );
    }
    opened = {
      ...buildReceivable({ id: receivableId, invoice, state: 'open' }),
      openedAt: clock.now(),
    };
  }

  const event = domainEvent(
    'receivable.opened',
    opened.id,
    {
      receivableId: opened.id,
      invoiceId: invoice.id,
      originalMinor: minorToNumber(invoice.total),
      dueDate: invoice.dueDate.toISOString(),
    },
    clock,
  );
  return { invoice: invoice.receivableId === opened.id ? invoice : { ...invoice, receivableId: opened.id }, receivable: opened, event };
}

/**
 * Apply an allocation (money or credit note application) to the receivable —
 * the receivable side of R1.
 *
 *  - open|partially_paid: partial → partially_paid (receivable.partiallySettled);
 *    full → settled (receivable.settled), overdue flag cleared.
 *  - written_off: any payment is a recovery → recovered (receivable.recovered);
 *    a terminal state that records the outcome, re-opens nothing.
 *  - everything else: INVALID_RECEIVABLE_TRANSITION.
 *
 * Never over-allocates: amount > balance throws ALLOCATION_EXCEEDS_BALANCE, so
 * balance can never go negative. Same-currency enforced (R10).
 */
export function applyAllocation(
  receivable: Receivable,
  amount: Money,
  clock: Clock,
): { receivable: Receivable; event: ReceivableEvent } {
  if (amount.currency !== receivable.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `allocation is ${amount.currency} but receivable is ${receivable.currency}`,
    );
  }
  if (!amount.isPositive()) {
    throw new DomainError(
      'ALLOCATION_AMOUNT_INVALID',
      'an allocation must be a positive amount',
      { amount: amount.amount.toString() },
    );
  }

  const balance = balanceOf(receivable);

  if (receivable.state === 'written_off') {
    if (amount.compareTo(balance) > 0) {
      throw new DomainError(
        'ALLOCATION_EXCEEDS_BALANCE',
        `allocation ${amount.amount} exceeds balance ${balance.amount}`,
        { balanceMinor: balance.amount.toString(), requestedMinor: amount.amount.toString() },
      );
    }
    const recovered: Receivable = {
      ...receivable,
      applied: receivable.applied.add(amount),
      state: 'recovered',
      recoveredAt: clock.now(),
    };
    const event = domainEvent(
      'receivable.recovered',
      receivable.id,
      { receivableId: receivable.id, amountMinor: minorToNumber(amount) },
      clock,
    );
    return { receivable: recovered, event };
  }

  if (receivable.state !== 'open' && receivable.state !== 'partially_paid') {
    throw new DomainError(
      'INVALID_RECEIVABLE_TRANSITION',
      `cannot apply an allocation to a ${receivable.state} receivable`,
      { from: receivable.state, via: 'applyAllocation' },
    );
  }

  if (amount.compareTo(balance) > 0) {
    throw new DomainError(
      'ALLOCATION_EXCEEDS_BALANCE',
      `allocation ${amount.amount} exceeds balance ${balance.amount}`,
      { balanceMinor: balance.amount.toString(), requestedMinor: amount.amount.toString() },
    );
  }

  const applied = receivable.applied.add(amount);
  const settledNow = applied.equals(receivable.original);
  const next: Receivable = settledNow
    ? { ...receivable, applied, state: 'settled', overdue: false, settledAt: clock.now() }
    : { ...receivable, applied, state: 'partially_paid' };

  const event = settledNow
    ? domainEvent(
        'receivable.settled',
        receivable.id,
        { receivableId: receivable.id, settledAt: next.settledAt!.toISOString() },
        clock,
      )
    : domainEvent(
        'receivable.partiallySettled',
        receivable.id,
        {
          receivableId: receivable.id,
          amountMinor: minorToNumber(amount),
          remainingMinor: minorToNumber(next.original.subtract(next.applied)),
        },
        clock,
      );
  return { receivable: next, event };
}

/**
 * Flag the receivable overdue (docs/03: due date passed). Allowed only while
 * the debt is live (open | partially_paid) and only strictly after the due
 * date. Idempotence is refused (OVERDUE_ALREADY_MARKED) so schedulers surface
 * bugs instead of silently re-emitting receivable.overdue.
 */
export function markOverdue(
  receivable: Receivable,
  clock: Clock,
): { receivable: Receivable; event: DomainEvent<'receivable.overdue', ReceivableOverduePayload> } {
  if (receivable.state !== 'open' && receivable.state !== 'partially_paid') {
    throw new DomainError(
      'INVALID_RECEIVABLE_TRANSITION',
      `a ${receivable.state} receivable cannot become overdue`,
      { from: receivable.state, via: 'markOverdue' },
    );
  }
  if (receivable.overdue) {
    throw new DomainError(
      'OVERDUE_ALREADY_MARKED',
      `receivable ${receivable.id} is already flagged overdue`,
    );
  }
  if (clock.now().getTime() <= receivable.dueDate.getTime()) {
    throw new DomainError(
      'RECEIVABLE_NOT_DUE',
      `receivable ${receivable.id} is not past its due date yet`,
    );
  }
  const flagged: Receivable = { ...receivable, overdue: true };
  const event = domainEvent(
    'receivable.overdue',
    receivable.id,
    {
      receivableId: receivable.id,
      daysLate: daysPastDue(receivable, clock),
      agingBucket: agingBucket(receivable, clock),
    },
    clock,
  );
  return { receivable: flagged, event };
}

/**
 * H1 — the write-off decision. Requires a reason AND an approver (a decision
 * with an owner), and per docs/03 it is reached from Overdue only. It flips
 * state to written_off; it never deletes — original, applied and the full
 * audit record stay on the aggregate.
 */
export function writeOff(
  receivable: Receivable,
  args: { reason: string; approvedBy: string },
  clock: Clock,
): { receivable: Receivable; event: DomainEvent<'receivable.writtenOff', ReceivableWrittenOffPayload> } {
  const reason = args.reason.trim();
  const approvedBy = args.approvedBy.trim();
  if (reason.length === 0) {
    throw new DomainError('WRITE_OFF_REASON_REQUIRED', 'a write-off decision requires a reason');
  }
  if (approvedBy.length === 0) {
    throw new DomainError(
      'WRITE_OFF_APPROVER_REQUIRED',
      'a write-off decision requires an approver (H1: bad debt must have an owner)',
    );
  }
  if (receivable.state !== 'open' && receivable.state !== 'partially_paid') {
    throw new DomainError(
      'INVALID_RECEIVABLE_TRANSITION',
      `cannot write off from ${receivable.state}`,
      { from: receivable.state, via: 'writeOff' },
    );
  }
  if (!receivable.overdue) {
    throw new DomainError(
      'WRITE_OFF_REQUIRES_OVERDUE',
      `receivable ${receivable.id} is not overdue — write-off is reached from Overdue only (docs/03)`,
    );
  }
  const writtenOff: Receivable = {
    ...receivable,
    state: 'written_off',
    writeOff: { reason, approvedBy, writtenOffAt: clock.now() },
  };
  const event = domainEvent(
    'receivable.writtenOff',
    receivable.id,
    { receivableId: receivable.id, reason, approvedBy },
    clock,
  );
  return { receivable: writtenOff, event };
}

/**
 * Collections verdict (docs/03: Overdue → Uncollectible). A recorded decision
 * with a reason; terminal. No catalog event exists for it (docs/04), so the
 * result carries the aggregate only.
 */
export function markUncollectible(
  receivable: Receivable,
  args: { reason: string },
  clock: Clock,
): { receivable: Receivable } {
  const reason = args.reason.trim();
  if (reason.length === 0) {
    throw new DomainError(
      'UNCOLLECTIBLE_REASON_REQUIRED',
      'an uncollectible verdict requires a recorded reason',
    );
  }
  if (receivable.state !== 'open' && receivable.state !== 'partially_paid') {
    throw new DomainError(
      'INVALID_RECEIVABLE_TRANSITION',
      `cannot mark uncollectible from ${receivable.state}`,
      { from: receivable.state, via: 'markUncollectible' },
    );
  }
  if (!receivable.overdue) {
    throw new DomainError(
      'UNCOLLECTIBLE_REQUIRES_OVERDUE',
      `receivable ${receivable.id} is not overdue — the verdict is reached from Overdue only (docs/03)`,
    );
  }
  return {
    receivable: {
      ...receivable,
      state: 'uncollectible',
      uncollectibleReason: reason,
      uncollectibleAt: clock.now(),
    },
  };
}

/**
 * Void an untouched receivable (docs/03: Open → Voided, invoice voided before
 * payment). Only legal while appliedMinor === 0 — the moment any allocation
 * exists, corrections go through adjustments (credit notes / refunds), never
 * through voiding.
 */
export function voidReceivable(receivable: Receivable, clock: Clock): { receivable: Receivable } {
  if (receivable.state === 'partially_paid') {
    throw new DomainError(
      'RECEIVABLE_VOID_REQUIRES_ZERO_APPLIED',
      `receivable ${receivable.id} has applied funds (${receivable.applied.amount}) — void only when appliedMinor === 0`,
    );
  }
  if (receivable.state !== 'open') {
    throw new DomainError(
      'INVALID_RECEIVABLE_TRANSITION',
      `cannot void from ${receivable.state}`,
      { from: receivable.state, via: 'voidReceivable' },
    );
  }
  // Defensive re-check of the documented rule: an open receivable always has
  // applied === 0 by construction, so this only fires if that invariant breaks.
  if (!receivable.applied.isZero()) {
    throw new DomainError(
      'RECEIVABLE_VOID_REQUIRES_ZERO_APPLIED',
      `receivable ${receivable.id} has applied funds (${receivable.applied.amount}) — void only when appliedMinor === 0`,
    );
  }
  return {
    receivable: { ...receivable, state: 'voided', overdue: false, voidedAt: clock.now() },
  };
}
