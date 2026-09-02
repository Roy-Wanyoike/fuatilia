/**
 * PaymentPlan (issue #7, review finding H5 — "PaymentPlan had association
 * gaps. Plan belongs to a customer, references specific receivables, drives
 * an installment schedule engine").
 *
 * H5 fixes modeled here:
 *   - ownership: the plan belongs to a customer (customerId);
 *   - association: it references the SPECIFIC receivables it restructures
 *     (receivableIds — opaque Uuids, no cross-aggregate coupling);
 *   - schedule engine: n installments split cent-exactly via the shared
 *     kernel's `Money.allocate` (equal weights, largest-remainder — no cent
 *     is created or destroyed), with calendar-aware due dates: the anchor
 *     day-of-month repeats each month and clamps to the month end
 *     (Jan 31 → Feb 28, → Mar 31, …). Plain UTC date math on the injected
 *     Clock's dates — no date libraries.
 *
 * Plan state machine (issue #7):
 *   active → completed   every installment fully paid (automatic detection)
 *   active → defaulted   an unpaid installment is overdue by policy days
 *   active → cancelled   an explicit decision with a recorded reason
 * Every other transition is illegal and throws
 * INVALID_PAYMENT_PLAN_TRANSITION. Payment rows are appended (R3 spirit):
 * history is never rewritten — a payment is an appended record plus an
 * immutably-derived installment status.
 *
 * Money lives in minor units (bigint). Everything is a pure function: no
 * I/O, no Date.now(), time only via the injected Clock; errors are
 * DomainError with stable SCREAMING_SNAKE codes.
 *
 * Event note: `paymentplan.*` events (see ./plan-events.ts) are ADDITIONS to
 * the 27-event catalog — same envelope, additive by design.
 */
import { DomainError, Money, type Clock, type Currency, type Uuid } from '../shared';
import { minorToNumber, type DomainEvent } from './events';
import {
  planCancelledEvent,
  planCompletedEvent,
  planDefaultedEvent,
  planPaymentRecordedEvent,
  type PlanCancelledPayload,
  type PlanDefaultedPayload,
  type PlanEvent,
} from './plan-events';

export type PaymentPlanState = 'active' | 'completed' | 'defaulted' | 'cancelled';

export interface PlanInstallment {
  /** 1-based installment number. */
  readonly no: number;
  readonly dueDate: Date;
  readonly amountMinor: bigint;
  /** Σ payments recorded against this installment (append-only log, derived here). */
  readonly paidMinor: bigint;
  /** Timestamp of the payment that FULLY settled the installment, else null. */
  readonly paidAt: Date | null;
}

/** One appended payment record (R3: append-only, never edited or deleted). */
export interface PlanPaymentRecord {
  readonly installmentNo: number;
  readonly amountMinor: bigint;
  readonly recordedAt: Date;
}

export interface PaymentPlan {
  readonly id: Uuid;
  /** H5: the plan is OWNED by a customer. */
  readonly customerId: Uuid;
  /** H5: the plan references the specific receivables it restructures. */
  readonly receivableIds: readonly Uuid[];
  readonly currency: Currency;
  readonly totalMinor: bigint;
  readonly installmentCount: number;
  readonly state: PaymentPlanState;
  /** Empty until buildSchedule runs. */
  readonly installments: readonly PlanInstallment[];
  /** Append-only payment log (R3 spirit). */
  readonly paymentLog: readonly PlanPaymentRecord[];
  readonly createdAt: Date | null;
  readonly completedAt: Date | null;
  readonly defaultedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
}

export interface CreatePaymentPlanArgs {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly currency: Currency;
  /** Total to restructure, minor units, integer ≥ installmentCount (each installment ≥ 1 minor). */
  readonly totalMinor: number | bigint;
  readonly installmentCount: number;
}

/**
 * Create an active plan. The schedule is built separately (buildSchedule) so
 * creation stays decoupled from calendar policy. Caller owns verifying that
 * the referenced receivables' combined outstanding balances equal totalMinor —
 * the plan engine sees them as opaque ids (module boundary, H5).
 */
export function createPaymentPlan(args: CreatePaymentPlanArgs, clock: Clock): PaymentPlan {
  if (typeof args.totalMinor === 'number' && !Number.isSafeInteger(args.totalMinor)) {
    throw new DomainError(
      'PAYMENT_PLAN_TOTAL_INVALID',
      `totalMinor must be a safe integer, got ${args.totalMinor}`,
    );
  }
  const totalMinor = BigInt(args.totalMinor);
  if (totalMinor <= 0n) {
    throw new DomainError(
      'PAYMENT_PLAN_TOTAL_INVALID',
      `totalMinor must be positive, got ${totalMinor}`,
    );
  }
  if (!Number.isSafeInteger(args.installmentCount) || args.installmentCount < 1) {
    throw new DomainError(
      'PAYMENT_PLAN_INSTALLMENT_COUNT_INVALID',
      `installmentCount must be a safe integer ≥ 1, got ${args.installmentCount}`,
    );
  }
  if (totalMinor < BigInt(args.installmentCount)) {
    throw new DomainError(
      'PAYMENT_PLAN_TOTAL_TOO_SMALL',
      `totalMinor ${totalMinor} cannot fund ${args.installmentCount} installments of at least 1 minor unit`,
    );
  }
  if (args.receivableIds.length === 0) {
    throw new DomainError(
      'PAYMENT_PLAN_RECEIVABLES_REQUIRED',
      'a payment plan must reference at least one receivable (H5)',
    );
  }
  if (new Set<string>(args.receivableIds).size !== args.receivableIds.length) {
    throw new DomainError(
      'PAYMENT_PLAN_RECEIVABLE_DUPLICATED',
      'a payment plan must not reference the same receivable twice',
    );
  }
  return {
    id: args.id,
    customerId: args.customerId,
    receivableIds: [...args.receivableIds],
    currency: args.currency,
    totalMinor,
    installmentCount: args.installmentCount,
    state: 'active',
    installments: [],
    paymentLog: [],
    createdAt: clock.now(),
    completedAt: null,
    defaultedAt: null,
    cancelledAt: null,
    cancelReason: null,
  };
}

/**
 * Due date for installment `no` (1-based): `no` calendar months after the
 * anchor, on the anchor's day-of-month, clamped to the target month's end
 * (Jan 31 + 1 month → Feb 28; leap years honored). All math in UTC on the
 * injected dates — no date libraries, no local-timezone drift; the anchor's
 * time-of-day is preserved.
 */
const dueDateFor = (anchor: Date, no: number): Date => {
  const first = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth() + no,
      1,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
  const daysInMonth = new Date(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return new Date(first.setUTCDate(Math.min(anchor.getUTCDate(), daysInMonth)));
};

/**
 * Build the installment schedule: `installmentCount` installments split
 * cent-exactly by `Money.allocate` with equal weights (largest-remainder —
 * the first `total % n` installments carry the extra cent), due dates
 * calendar-aware from `startDate` (anchor day-of-month, month-end clamped;
 * installment 1 falls one month after the anchor).
 */
export function buildSchedule(
  plan: PaymentPlan,
  args: { startDate: Date; clock: Clock },
): { plan: PaymentPlan } {
  if (plan.state !== 'active') {
    throw new DomainError(
      'INVALID_PAYMENT_PLAN_TRANSITION',
      `cannot build a schedule on a ${plan.state} plan`,
      { from: plan.state, via: 'buildSchedule' },
    );
  }
  if (plan.installments.length > 0) {
    throw new DomainError(
      'PAYMENT_PLAN_SCHEDULE_EXISTS',
      `plan ${plan.id} already has a ${plan.installments.length}-installment schedule`,
    );
  }
  const parts = Money.ofMinor(plan.totalMinor, plan.currency).allocate(
    Array.from({ length: plan.installmentCount }, () => 1),
  );
  const installments: PlanInstallment[] = parts.map((part, index) => ({
    no: index + 1,
    dueDate: dueDateFor(args.startDate, index + 1),
    amountMinor: part.amount,
    paidMinor: 0n,
    paidAt: null,
  }));
  return { plan: { ...plan, installments } };
}

/** Whole floored days past an installment's due date, clamped at 0. */
const daysLateOf = (installment: PlanInstallment, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - installment.dueDate.getTime()) / 86_400_000));

const requireActive = (plan: PaymentPlan, via: string): void => {
  if (plan.state !== 'active') {
    throw new DomainError(
      'INVALID_PAYMENT_PLAN_TRANSITION',
      `cannot ${via} from ${plan.state}`,
      { from: plan.state, via },
    );
  }
};

const requireScheduled = (plan: PaymentPlan): void => {
  if (plan.installments.length !== plan.installmentCount) {
    throw new DomainError(
      'PAYMENT_PLAN_SCHEDULE_MISSING',
      `plan ${plan.id} has no installment schedule — run buildSchedule first`,
    );
  }
};

const isFullyPaid = (installment: PlanInstallment): boolean =>
  installment.paidMinor >= installment.amountMinor;

/**
 * Record a payment against one installment — append-style: a new
 * PlanPaymentRecord is appended to the log and the installment's paid status
 * is immutably derived (never edited in place). When the payment settles the
 * LAST outstanding installment, the plan transitions active → completed.
 */
export function recordPlanPayment(
  plan: PaymentPlan,
  installmentNo: number,
  amountMinor: number | bigint,
  clock: Clock,
): { plan: PaymentPlan; events: readonly PlanEvent[] } {
  requireActive(plan, 'record a payment on');
  requireScheduled(plan);
  const slot = plan.installments[installmentNo - 1];
  if (
    !Number.isSafeInteger(installmentNo) ||
    installmentNo < 1 ||
    installmentNo > plan.installmentCount ||
    slot === undefined
  ) {
    throw new DomainError(
      'PAYMENT_PLAN_INSTALLMENT_UNKNOWN',
      `installment ${installmentNo} does not exist on plan ${plan.id} (1..${plan.installmentCount})`,
    );
  }
  const amount = Money.ofMinor(amountMinor, plan.currency); // integer + non-negative (kernel)
  if (!amount.isPositive()) {
    throw new DomainError(
      'PAYMENT_PLAN_PAYMENT_AMOUNT_INVALID',
      'a plan payment must be a positive amount',
    );
  }
  if (slot.paidMinor + amount.amount > slot.amountMinor) {
    throw new DomainError(
      'PAYMENT_PLAN_INSTALLMENT_OVERPAID',
      `installment ${installmentNo} is owed ${slot.amountMinor - slot.paidMinor}; payment of ${amount.amount} would overpay`,
      {
        installmentNo,
        owedMinor: (slot.amountMinor - slot.paidMinor).toString(),
        requestedMinor: amount.amount.toString(),
      },
    );
  }
  const now = clock.now();
  const paidInstallment: PlanInstallment = {
    ...slot,
    paidMinor: slot.paidMinor + amount.amount,
    paidAt: slot.paidMinor + amount.amount === slot.amountMinor ? now : slot.paidAt,
  };
  const installments = plan.installments.map((inst) => (inst.no === installmentNo ? paidInstallment : inst));
  const completed = installments.every(isFullyPaid);
  const next: PaymentPlan = {
    ...plan,
    installments,
    paymentLog: [
      ...plan.paymentLog,
      { installmentNo, amountMinor: amount.amount, recordedAt: now },
    ],
    state: completed ? 'completed' : plan.state,
    completedAt: completed ? now : plan.completedAt,
  };
  const events: PlanEvent[] = [
    planPaymentRecordedEvent(
      {
        planId: plan.id,
        customerId: plan.customerId,
        installmentNo,
        amountMinor: minorToNumber(amount),
        paidMinor: minorToNumber(Money.ofMinor(paidInstallment.paidMinor, plan.currency)),
        currency: plan.currency,
      },
      clock,
    ),
  ];
  if (completed) {
    events.push(
      planCompletedEvent(
        {
          planId: plan.id,
          customerId: plan.customerId,
          currency: plan.currency,
          completedAt: next.completedAt!.toISOString(),
        },
        clock,
      ),
    );
  }
  return { plan: next, events };
}

/** Unpaid installments (any paid portion outstanding), in schedule order. */
export const unpaidInstallmentsOf = (plan: PaymentPlan): readonly PlanInstallment[] =>
  plan.installments.filter((inst) => !isFullyPaid(inst));

/**
 * active → defaulted: legal only while some UNPAID installment is overdue by
 * at least `defaultAfterDays` whole days ("overdue by N days" — day N counts,
 * fully-paid late installments never trigger a default). The plan is dead
 * afterwards: payments, cancellation and re-defaulting throw.
 */
export function markPlanDefaulted(
  plan: PaymentPlan,
  args: { defaultAfterDays: number },
  clock: Clock,
): { plan: PaymentPlan; event: DomainEvent<'paymentplan.defaulted', PlanDefaultedPayload> } {
  requireActive(plan, 'default');
  requireScheduled(plan);
  if (!Number.isSafeInteger(args.defaultAfterDays) || args.defaultAfterDays < 0) {
    throw new DomainError(
      'PAYMENT_PLAN_DEFAULT_POLICY_INVALID',
      `defaultAfterDays must be a safe integer ≥ 0, got ${args.defaultAfterDays}`,
    );
  }
  const now = clock.now();
  const trigger = unpaidInstallmentsOf(plan).find(
    (inst) => daysLateOf(inst, now) >= args.defaultAfterDays,
  );
  if (trigger === undefined) {
    throw new DomainError(
      'PAYMENT_PLAN_NOT_DEFAULTABLE',
      `no unpaid installment of plan ${plan.id} is overdue by ${args.defaultAfterDays} day(s)`,
      { defaultAfterDays: args.defaultAfterDays },
    );
  }
  const defaulted: PaymentPlan = {
    ...plan,
    state: 'defaulted',
    defaultedAt: now,
  };
  return {
    plan: defaulted,
    event: planDefaultedEvent(
      {
        planId: plan.id,
        customerId: plan.customerId,
        installmentNo: trigger.no,
        daysOverdue: daysLateOf(trigger, now),
        defaultAfterDays: args.defaultAfterDays,
      },
      clock,
    ),
  };
}

/**
 * active → cancelled: an explicit decision with a recorded reason. Only an
 * ACTIVE plan can be cancelled (issue #7: `active → cancelled`) — completed,
 * defaulted and already-cancelled plans throw INVALID_PAYMENT_PLAN_TRANSITION.
 */
export function cancelPaymentPlan(
  plan: PaymentPlan,
  args: { reason: string },
  clock: Clock,
): { plan: PaymentPlan; event: DomainEvent<'paymentplan.cancelled', PlanCancelledPayload> } {
  const reason = args.reason.trim();
  if (reason.length === 0) {
    throw new DomainError(
      'PAYMENT_PLAN_CANCEL_REASON_REQUIRED',
      'cancelling a payment plan requires a reason',
    );
  }
  requireActive(plan, 'cancel');
  const cancelled: PaymentPlan = {
    ...plan,
    state: 'cancelled',
    cancelledAt: clock.now(),
    cancelReason: reason,
  };
  return {
    plan: cancelled,
    event: planCancelledEvent(
      { planId: plan.id, customerId: plan.customerId, reason },
      clock,
    ),
  };
}
