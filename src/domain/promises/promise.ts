/**
 * PromiseToPay — the customer's recorded commitment to settle by a promised
 * date (issue #19, SPEC §10 "Payment Promise Engine", docs/03 CollectionsCase
 * PromisePending edges, catalog E27).
 *
 * Lifecycle (SPEC §10 states, table-driven — see PROMISE_TRANSITIONS):
 *
 *   created → pending                          (activatePromise: tracking starts)
 *   pending → partially_fulfilled | fulfilled  (settlement-driven, applySettlement)
 *   pending | partially_fulfilled → broken     (past promisedDate without full
 *                                               coverage → collections.promiseBroken)
 *   created | pending → expired                (promisedDate + grace, never fulfilled)
 *   fulfilled | broken | cancelled | expired   (terminal, nothing re-opens them)
 *
 * SPEC §10: "A broken promise must trigger the appropriate collection
 * workflow." markPromiseBroken therefore emits BOTH the lane lifecycle fact
 * (`promise.broken`) and the cataloged cross-lane trigger (E27
 * `collections.promiseBroken`) so collections/intelligence never import this
 * module — they consume the event.
 *
 * Invariants honored here:
 *   - single-currency promise amount (R10 discipline): the amount travels as
 *     a safe-integer minor-unit number paired with a Currency; settlements
 *     are validated against the promised amount so Σsettlements can never
 *     exceed it and coverage is an exact comparison, never a float one;
 *   - every transition is a recorded decision: cancelled carries reason +
 *     actorId, broken carries a reason, and the transition table lives in
 *     one exported constant so docs/03 and code cannot drift;
 *   - append-only discipline (R3 spirit): every operation returns a fresh
 *     immutable copy — nothing is mutated in place.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock, cross-lane ids (customer, receivables, consent grant,
 * collections case) passed in as opaque Uuids/refs. Illegal transitions throw
 * DomainError with stable SCREAMING_SNAKE codes.
 */
import { CURRENCIES, DomainError, type Clock, type Currency, type Uuid } from '../shared';
import {
  domainEvent,
  minorToNumber,
  type CollectionsPromiseBrokenPayload,
  type DomainEvent,
  type PromiseActivatedPayload,
  type PromiseBrokenPayload,
  type PromiseCancelledPayload,
  type PromiseCreatedPayload,
  type PromiseEvent,
  type PromiseExpiredPayload,
  type PromiseFulfilledPayload,
  type PromisePartiallyFulfilledPayload,
} from './events';

// --- sources (SPEC §10 "Source": the channel the promise arrived on) ---------

export const PROMISE_SOURCES = ['whatsapp', 'sms', 'call', 'portal'] as const;
export type PromiseSource = (typeof PROMISE_SOURCES)[number];

export const assertPromiseSource = (source: string): PromiseSource => {
  if (!(PROMISE_SOURCES as readonly string[]).includes(source)) {
    throw new DomainError('PROMISE_SOURCE_INVALID', `unknown promise source: ${source}`, {
      source,
      allowed: PROMISE_SOURCES,
    });
  }
  return source as PromiseSource;
};

// --- lifecycle states ----------------------------------------------------------

export type PromiseStatus =
  | 'created'
  | 'pending'
  | 'partially_fulfilled'
  | 'fulfilled'
  | 'broken'
  | 'cancelled'
  | 'expired';

const PROMISE_STATUSES: readonly PromiseStatus[] = [
  'created',
  'pending',
  'partially_fulfilled',
  'fulfilled',
  'broken',
  'cancelled',
  'expired',
];

/**
 * The legal-transition table, in one place so SPEC §10 and the code cannot
 * drift. Rows are `from`, entries are the legal `to` states:
 *
 *   created              → pending | cancelled | expired
 *   pending              → partially_fulfilled | fulfilled | broken | cancelled | expired
 *   partially_fulfilled  → fulfilled | broken | cancelled
 *   fulfilled / broken / cancelled / expired → terminal (empty rows).
 *
 * Deliberately NOT legal:
 *   - skipping `created` (a promise must be activated before fulfilment
 *     tracking drives it — settlement on a merely-recorded promise is a
 *     modelling bug: PROMISE_NOT_ACTIVE);
 *   - broken → fulfilled (a broken promise is a collections fact; a late
 *     payment after the break is settled against the receivables lane and
 *     evidenced by a NEW promise, never by rewriting the broken one);
 *   - any transition out of a terminal state (re-opening rewrites history);
 *   - reaching fulfilled/broken/expired through the generic transition —
 *     those are settlement- and time-driven and go through their dedicated
 *     functions, which carry the coverage checks and their events.
 */
export const PROMISE_TRANSITIONS: Readonly<Record<PromiseStatus, readonly PromiseStatus[]>> = {
  created: ['pending', 'cancelled', 'expired'],
  pending: ['partially_fulfilled', 'fulfilled', 'broken', 'cancelled', 'expired'],
  partially_fulfilled: ['fulfilled', 'broken', 'cancelled'],
  fulfilled: [],
  broken: [],
  cancelled: [],
  expired: [],
};

/** Manual (decision-driven) targets of the generic transition; the rest are automatic. */
const MANUAL_TARGETS: readonly PromiseStatus[] = ['pending', 'cancelled'];

/** Grace window after the promised date before a never-fulfilled promise expires. */
export const PROMISE_EXPIRY_GRACE_DAYS = 7;

// --- the aggregate ---------------------------------------------------------------

export interface PromiseToPay {
  readonly promiseId: Uuid;
  readonly orgId: Uuid;
  /** Opaque customer id — owned by the customer lane. */
  readonly customerId: Uuid;
  /** Opaque receivable ids this promise covers — owned by the receivables lane. */
  readonly receivableIds: readonly Uuid[];
  /** Promised amount in integer minor units (safe integer > 0). */
  readonly amountMinor: number;
  readonly currency: Currency;
  /** The date the customer committed to pay by. */
  readonly promisedDate: Date;
  /** The channel the promise arrived on. */
  readonly source: PromiseSource;
  /**
   * Opaque consent-grant reference (consent lane), backing outbound comms on
   * this promise. Null when the promise arrived without one — dunning steps
   * flagged requiresConsent are then refused (K2: consent is never implied).
   */
  readonly consentRef: string | null;
  readonly status: PromiseStatus;
  /** Σ settlements applied so far, minor units (never exceeds amountMinor). */
  readonly settledMinor: number;
  readonly createdAt: Date;
  readonly pendingAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly brokenAt: Date | null;
  readonly brokenReason: string | null;
  readonly cancelledAt: Date | null;
  readonly expiredAt: Date | null;
}

// --- input validation (stable codes) ----------------------------------------------

const assertClockDate = (at: Date, code: string): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'clock returned an invalid Date');
  }
  return at;
};

const assertNonBlank = (raw: string, code: string, label: string): string => {
  const value = raw.trim();
  if (value.length === 0) {
    throw new DomainError(code, `a promise requires a non-blank ${label}`);
  }
  return value;
};

const assertAmountMinor = (amountMinor: number, code: string): number => {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new DomainError(
      code,
      `amountMinor must be a safe positive integer, got ${String(amountMinor)}`,
      { amountMinor },
    );
  }
  return amountMinor;
};

const assertCurrency = (currency: Currency): Currency => {
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new DomainError('PROMISE_CURRENCY_INVALID', `unsupported currency: ${currency}`, {
      currency,
      allowed: CURRENCIES,
    });
  }
  return currency;
};

// --- creation ----------------------------------------------------------------------

export interface CreatePromiseArgs {
  readonly promiseId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly amountMinor: number;
  readonly currency: Currency;
  readonly promisedDate: Date;
  readonly source: string;
  /** Opaque consent-grant reference; optional (null when absent). */
  readonly consentRef?: string | null;
}

/**
 * Record a promise-to-pay (SPEC §10) in state `created`. Emits
 * `promise.created`. Validation failures throw stable PROMISE_* codes:
 *   - PROMISE_AMOUNT_INVALID / PROMISE_CURRENCY_INVALID / PROMISE_SOURCE_INVALID
 *   - PROMISE_RECEIVABLES_REQUIRED / PROMISE_RECEIVABLE_DUPLICATE
 *   - PROMISE_PROMISED_DATE_INVALID / PROMISE_CONSENT_REF_INVALID
 */
export function createPromise(
  args: CreatePromiseArgs,
  clock: Clock,
): { promise: PromiseToPay; event: PromiseEvent & { readonly name: 'promise.created' } } {
  const amountMinor = assertAmountMinor(args.amountMinor, 'PROMISE_AMOUNT_INVALID');
  const currency = assertCurrency(args.currency);
  const source = assertPromiseSource(args.source);
  const promisedDate = assertClockDate(args.promisedDate, 'PROMISE_PROMISED_DATE_INVALID');

  if (args.receivableIds.length === 0) {
    throw new DomainError(
      'PROMISE_RECEIVABLES_REQUIRED',
      'a promise must reference at least one receivable',
    );
  }
  const unique = new Set(args.receivableIds.map(String));
  if (unique.size !== args.receivableIds.length) {
    throw new DomainError(
      'PROMISE_RECEIVABLE_DUPLICATE',
      'a promise references the same receivable twice',
    );
  }

  const consentRef =
    args.consentRef === undefined || args.consentRef === null
      ? null
      : assertNonBlank(args.consentRef, 'PROMISE_CONSENT_REF_INVALID', 'consent reference');

  const createdAt = assertClockDate(clock.now(), 'PROMISE_CLOCK_INVALID');

  const promise: PromiseToPay = {
    promiseId: args.promiseId,
    orgId: args.orgId,
    customerId: args.customerId,
    receivableIds: [...args.receivableIds],
    amountMinor,
    currency,
    promisedDate,
    source,
    consentRef,
    status: 'created',
    settledMinor: 0,
    createdAt,
    pendingAt: null,
    fulfilledAt: null,
    brokenAt: null,
    brokenReason: null,
    cancelledAt: null,
    expiredAt: null,
  };

  const payload: PromiseCreatedPayload = {
    promiseId: promise.promiseId,
    orgId: promise.orgId,
    customerId: promise.customerId,
    receivableIds: promise.receivableIds,
    amountMinor: minorToNumber(amountMinor),
    currency,
    promisedDate: promisedDate.toISOString(),
    source,
    consentRef,
    createdAt: createdAt.toISOString(),
  };
  const event = domainEvent<'promise.created', PromiseCreatedPayload>(
    'promise.created',
    promise.promiseId,
    payload,
    clock,
  );
  return { promise, event };
}

// --- generic table-driven transition -------------------------------------------------

export interface TransitionPromiseArgs {
  readonly reason: string;
  readonly actorId: string;
}

/**
 * Move a promise one step along its lifecycle through the PROMISE_TRANSITIONS
 * table. Every step records reason + actorId (the audit pair). Only the
 * manual targets are allowed here — `pending` (Created → Pending) and
 * `cancelled`; the settlement- and time-driven targets (`fulfilled`,
 * `broken`, `expired`, `partially_fulfilled`) go through their dedicated
 * functions, which carry the coverage/expiry checks and their events.
 *
 * Throws:
 *   - PROMISE_STATUS_INVALID — unknown target status;
 *   - PROMISE_TRANSITION_INVALID — {from, to} not in the table;
 *   - PROMISE_TRANSITION_NOT_AUTOMATIC — a settlement/time-driven target
 *     requested through the generic door;
 *   - PROMISE_REASON_REQUIRED / PROMISE_ACTOR_REQUIRED — missing audit pair;
 *   - PROMISE_CLOCK_INVALID — broken injected clock.
 */
export function transitionPromise(
  promise: PromiseToPay,
  to: PromiseStatus,
  args: TransitionPromiseArgs,
  clock: Clock,
): { promise: PromiseToPay; event: PromiseEvent } {
  if (!PROMISE_STATUSES.includes(to)) {
    throw new DomainError('PROMISE_STATUS_INVALID', `unknown promise status: ${String(to)}`, {
      to: String(to),
      allowed: PROMISE_STATUSES,
    });
  }
  const from = promise.status;
  if (!PROMISE_TRANSITIONS[from].includes(to)) {
    throw new DomainError(
      'PROMISE_TRANSITION_INVALID',
      `cannot move a promise from ${from} to ${to}`,
      { from, to },
    );
  }
  if (!MANUAL_TARGETS.includes(to)) {
    throw new DomainError(
      'PROMISE_TRANSITION_NOT_AUTOMATIC',
      `${to} is settlement/time-driven — use applySettlement / markPromiseBroken / expirePromise`,
      { from, to },
    );
  }
  const reason = assertNonBlank(args.reason, 'PROMISE_REASON_REQUIRED', 'transition reason');
  const actorId = assertNonBlank(args.actorId, 'PROMISE_ACTOR_REQUIRED', 'actor id');
  const at = assertClockDate(clock.now(), 'PROMISE_CLOCK_INVALID');

  if (to === 'pending') {
    const next: PromiseToPay = { ...promise, status: 'pending', pendingAt: at };
    const payload: PromiseActivatedPayload = {
      promiseId: promise.promiseId,
      orgId: promise.orgId,
      customerId: promise.customerId,
      activatedAt: at.toISOString(),
    };
    return {
      promise: next,
      event: domainEvent<'promise.activated', PromiseActivatedPayload>(
        'promise.activated',
        promise.promiseId,
        payload,
        clock,
      ),
    };
  }

  const next: PromiseToPay = { ...promise, status: 'cancelled', cancelledAt: at };
  const payload: PromiseCancelledPayload = {
    promiseId: promise.promiseId,
    customerId: promise.customerId,
    reason,
    actorId,
    cancelledAt: at.toISOString(),
  };
  return {
    promise: next,
    event: domainEvent<'promise.cancelled', PromiseCancelledPayload>(
      'promise.cancelled',
      promise.promiseId,
      payload,
      clock,
    ),
  };
}

// --- settlement-driven transitions ---------------------------------------------------

/**
 * Coverage remaining on the promise, minor units (never negative).
 */
export const remainingMinor = (promise: PromiseToPay): number =>
  Math.max(0, promise.amountMinor - promise.settledMinor);

/**
 * Apply a settlement against the promise (data-in/data-out: the caller says
 * how much was actually collected — the money itself lives in the payments /
 * allocation lanes and is referenced only by opaque ids elsewhere).
 *
 *   - full coverage (Σsettlements ≥ promised amount) → fulfilled
 *     (`promise.fulfilled`) — over-coverage is refused, never silently
 *     truncated (PROMISE_SETTLEMENT_EXCEEDS_PROMISED);
 *   - partial coverage → partially_fulfilled (`promise.partiallyFulfilled`);
 *   - legal only from `pending` | `partially_fulfilled` — a merely-recorded
 *     (`created`) promise must be activated first (PROMISE_NOT_ACTIVE), and
 *     terminal states accept nothing (PROMISE_TRANSITION_INVALID).
 *
 * The promised date does NOT block settlement: a customer who pays late
 * (before the break is recorded) still fulfils the promise.
 */
export function applySettlement(
  promise: PromiseToPay,
  settledMinor: number,
  clock: Clock,
): { promise: PromiseToPay; event: PromiseEvent } {
  if (promise.status !== 'pending' && promise.status !== 'partially_fulfilled') {
    throw new DomainError(
      promise.status === 'created' ? 'PROMISE_NOT_ACTIVE' : 'PROMISE_TRANSITION_INVALID',
      promise.status === 'created'
        ? 'activate the promise before applying settlements'
        : `cannot apply a settlement to a ${promise.status} promise`,
      { from: promise.status, via: 'applySettlement' },
    );
  }
  const amount = assertAmountMinor(settledMinor, 'PROMISE_SETTLEMENT_INVALID');
  const totalSettled = promise.settledMinor + amount;
  if (totalSettled > promise.amountMinor) {
    throw new DomainError(
      'PROMISE_SETTLEMENT_EXCEEDS_PROMISED',
      `settlement ${amount} would take Σsettled ${totalSettled} past the promised ${promise.amountMinor} — settle against the receivable instead`,
      {
        promisedMinor: promise.amountMinor,
        settledMinor: promise.settledMinor,
        requestedMinor: amount,
      },
    );
  }
  const settledAt = assertClockDate(clock.now(), 'PROMISE_CLOCK_INVALID');
  const fulfilledNow = totalSettled === promise.amountMinor;

  if (fulfilledNow) {
    const next: PromiseToPay = {
      ...promise,
      status: 'fulfilled',
      settledMinor: totalSettled,
      fulfilledAt: settledAt,
    };
    const payload: PromiseFulfilledPayload = {
      promiseId: promise.promiseId,
      customerId: promise.customerId,
      receivableIds: promise.receivableIds,
      amountMinor: promise.amountMinor,
      totalSettledMinor: minorToNumber(totalSettled),
      fulfilledAt: settledAt.toISOString(),
    };
    return {
      promise: next,
      event: domainEvent<'promise.fulfilled', PromiseFulfilledPayload>(
        'promise.fulfilled',
        promise.promiseId,
        payload,
        clock,
      ),
    };
  }

  const next: PromiseToPay = { ...promise, status: 'partially_fulfilled', settledMinor: totalSettled };
  const payload: PromisePartiallyFulfilledPayload = {
    promiseId: promise.promiseId,
    customerId: promise.customerId,
    settledMinor: minorToNumber(amount),
    totalSettledMinor: minorToNumber(totalSettled),
    remainingMinor: minorToNumber(remainingMinor(next)),
    settledAt: settledAt.toISOString(),
  };
  return {
    promise: next,
    event: domainEvent<'promise.partiallyFulfilled', PromisePartiallyFulfilledPayload>(
      'promise.partiallyFulfilled',
      promise.promiseId,
      payload,
      clock,
    ),
  };
}

// --- time-driven transitions ----------------------------------------------------------

/**
 * Break the promise: the promised date has passed without full coverage
 * (SPEC §10 → the collections workflow). Emits BOTH `promise.broken` (lane
 * lifecycle fact) and `collections.promiseBroken` (catalog E27 — the typed
 * trigger consumed by collections/intelligence for the priority boost).
 *
 * Guards:
 *   - legal only from `pending` | `partially_fulfilled` (PROMISE_TRANSITION_INVALID
 *     elsewhere — `created` must be activated first: PROMISE_NOT_ACTIVE);
 *   - only strictly AFTER the promised date (PROMISE_NOT_DUE yet);
 *   - only while coverage is short — a fully settled promise is fulfilled,
 *     never broken (PROMISE_ALREADY_FULFILLED);
 *   - a non-blank reason is mandatory (PROMISE_REASON_REQUIRED).
 */
export function markPromiseBroken(
  promise: PromiseToPay,
  args: { reason: string; caseId?: Uuid | null },
  clock: Clock,
): {
  promise: PromiseToPay;
  events: [
    DomainEvent<'promise.broken', PromiseBrokenPayload>,
    DomainEvent<'collections.promiseBroken', CollectionsPromiseBrokenPayload>,
  ];
} {
  if (promise.status !== 'pending' && promise.status !== 'partially_fulfilled') {
    throw new DomainError(
      promise.status === 'created' ? 'PROMISE_NOT_ACTIVE' : 'PROMISE_TRANSITION_INVALID',
      promise.status === 'created'
        ? 'activate the promise before it can break'
        : `cannot break a ${promise.status} promise`,
      { from: promise.status, via: 'markPromiseBroken' },
    );
  }
  const reason = assertNonBlank(args.reason, 'PROMISE_REASON_REQUIRED', 'break reason');
  const now = assertClockDate(clock.now(), 'PROMISE_CLOCK_INVALID');
  if (now.getTime() <= promise.promisedDate.getTime()) {
    throw new DomainError(
      'PROMISE_NOT_DUE',
      `promise ${promise.promiseId} is not past its promised date yet`,
    );
  }
  if (promise.settledMinor >= promise.amountMinor) {
    throw new DomainError(
      'PROMISE_ALREADY_FULFILLED',
      `promise ${promise.promiseId} is fully covered (${promise.settledMinor}/${promise.amountMinor}) — it is fulfilled, not broken`,
    );
  }
  const caseId = args.caseId === undefined ? null : args.caseId;

  const broken: PromiseToPay = {
    ...promise,
    status: 'broken',
    brokenAt: now,
    brokenReason: reason,
  };

  const brokenPayload: PromiseBrokenPayload = {
    promiseId: promise.promiseId,
    customerId: promise.customerId,
    receivableIds: promise.receivableIds,
    reason,
    expectedAt: promise.promisedDate.toISOString(),
    settledMinor: minorToNumber(promise.settledMinor),
    brokenAt: now.toISOString(),
  };
  const triggerPayload: CollectionsPromiseBrokenPayload = {
    promiseId: promise.promiseId,
    caseId,
    expectedAt: promise.promisedDate.toISOString(),
    customerId: promise.customerId,
    settledMinor: minorToNumber(promise.settledMinor),
    brokenAt: now.toISOString(),
  };

  return {
    promise: broken,
    events: [
      domainEvent<'promise.broken', PromiseBrokenPayload>(
        'promise.broken',
        promise.promiseId,
        brokenPayload,
        clock,
      ),
      domainEvent<'collections.promiseBroken', CollectionsPromiseBrokenPayload>(
        'collections.promiseBroken',
        promise.promiseId,
        triggerPayload,
        clock,
      ),
    ],
  };
}

/**
 * Expire a promise that was never fulfilled: promisedDate + graceDays have
 * elapsed with zero coverage. Distinct from broken in that the promise never
 * got a single settlement nor a collector verdict — it simply lapsed (grace
 * default: PROMISE_EXPIRY_GRACE_DAYS). Legal only from `created` | `pending`
 * (PROMISE_TRANSITION_INVALID elsewhere), only at/after the grace horizon
 * (PROMISE_NOT_DUE), and only with zero coverage (PROMISE_ALREADY_FULFILLED —
 * partially covered promises BREAK, they do not quietly expire).
 */
export function expirePromise(
  promise: PromiseToPay,
  clock: Clock,
  graceDays: number = PROMISE_EXPIRY_GRACE_DAYS,
): { promise: PromiseToPay; event: PromiseEvent & { readonly name: 'promise.expired' } } {
  if (promise.status !== 'created' && promise.status !== 'pending') {
    throw new DomainError(
      'PROMISE_TRANSITION_INVALID',
      `cannot expire a ${promise.status} promise — partially covered promises break instead`,
      { from: promise.status, via: 'expirePromise' },
    );
  }
  if (!Number.isSafeInteger(graceDays) || graceDays < 0) {
    throw new DomainError(
      'PROMISE_GRACE_INVALID',
      `graceDays must be a safe integer ≥ 0, got ${String(graceDays)}`,
      { graceDays },
    );
  }
  const now = assertClockDate(clock.now(), 'PROMISE_CLOCK_INVALID');
  const horizon = promise.promisedDate.getTime() + graceDays * 86_400_000;
  if (now.getTime() < horizon) {
    throw new DomainError(
      'PROMISE_NOT_DUE',
      `promise ${promise.promiseId} has not passed its ${graceDays}-day grace horizon yet`,
    );
  }
  if (promise.settledMinor > 0) {
    throw new DomainError(
      'PROMISE_ALREADY_FULFILLED',
      `promise ${promise.promiseId} has partial coverage (${promise.settledMinor}) — it breaks, it does not expire`,
    );
  }

  const expired: PromiseToPay = { ...promise, status: 'expired', expiredAt: now };
  const payload: PromiseExpiredPayload = {
    promiseId: promise.promiseId,
    customerId: promise.customerId,
    expectedAt: promise.promisedDate.toISOString(),
    graceDays,
    expiredAt: now.toISOString(),
  };
  return {
    promise: expired,
    event: domainEvent<'promise.expired', PromiseExpiredPayload>(
      'promise.expired',
      promise.promiseId,
      payload,
      clock,
    ),
  };
}
