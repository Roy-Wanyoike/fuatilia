/**
 * Promises-lane domain events (wave 3, issue #19, SPEC §10 + §18).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   promise.created              a promise-to-pay was recorded (any source)
 *   promise.activated            Created → Pending: fulfilment tracking starts
 *   promise.partiallyFulfilled   a settlement covered part of the promised amount
 *   promise.fulfilled            a settlement covered the promised amount in full
 *   promise.broken               past the promised date without full coverage
 *   promise.cancelled            withdrawn by the business or customer
 *   promise.expired              promised date + grace elapsed, never fulfilled
 *
 * Plus the two catalog cross-lane facts (E27 and the consent gate):
 *
 *   collections.promiseBroken            E27 — the typed trigger for the
 *                                        collections workflow / intelligence
 *                                        priority boost when a promise breaks;
 *   collections.dunningBlockedNoConsent  a dunning step that required consent
 *                                        was refused because the promise has
 *                                        no consentRef (K2: no implied consent).
 *
 * Dunning orchestration events (pure, facts-driven — SPEC §18):
 *
 *   dunning.stepDue      a ladder step's day-window has been reached
 *   dunning.escalated    no customer response N days after the last send
 *
 * Envelope mirrors the receivables/disputes lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings, monetary values as plain minor-unit numbers guarded
 * against unsafe-integer precision loss, and cross-lane ids (customer,
 * receivables, consent grant, collections case) as opaque Uuids/refs so
 * consumers (collections, notifications, intelligence) never import producers.
 */
import { DomainError, type Clock, type Currency, type Uuid } from '../shared';
import type { PromiseSource } from './promise';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Pure event factory — the only way this module builds events. */
export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): DomainEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: clock.now().toISOString(),
    payload,
  };
}

/** Minor units → JSON-safe number. Refuses silent precision loss. */
export function minorToNumber(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new DomainError(
      'EVENT_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amountMinor} exceeds the safe-integer range for event payloads`,
    );
  }
  return amountMinor;
}

// ---------------------------------------------------------------------------
// promise.* payloads
// ---------------------------------------------------------------------------

export interface PromiseCreatedPayload {
  readonly promiseId: Uuid;
  readonly orgId: Uuid;
  /** Opaque customer id — owned by the customer lane. */
  readonly customerId: Uuid;
  /** Opaque receivable ids — owned by the receivables lane. */
  readonly receivableIds: readonly Uuid[];
  readonly amountMinor: number;
  readonly currency: Currency;
  /** ISO-8601 — the date the customer committed to pay by. */
  readonly promisedDate: string;
  readonly source: PromiseSource;
  /** Opaque consent-grant reference; null when the promise arrived without one. */
  readonly consentRef: string | null;
  /** ISO-8601 */
  readonly createdAt: string;
}

export interface PromiseActivatedPayload {
  readonly promiseId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** ISO-8601 */
  readonly activatedAt: string;
}

export interface PromisePartiallyFulfilledPayload {
  readonly promiseId: Uuid;
  readonly customerId: Uuid;
  /** The settlement applied by THIS event. */
  readonly settledMinor: number;
  /** Σ settlements so far. */
  readonly totalSettledMinor: number;
  readonly remainingMinor: number;
  /** ISO-8601 */
  readonly settledAt: string;
}

export interface PromiseFulfilledPayload {
  readonly promiseId: Uuid;
  readonly customerId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly amountMinor: number;
  readonly totalSettledMinor: number;
  /** ISO-8601 */
  readonly fulfilledAt: string;
}

export interface PromiseBrokenPayload {
  readonly promiseId: Uuid;
  readonly customerId: Uuid;
  readonly receivableIds: readonly Uuid[];
  readonly reason: string;
  /** ISO-8601 — the promised date that was missed. */
  readonly expectedAt: string;
  /** Σ settlements at break time (how much of the promise was kept). */
  readonly settledMinor: number;
  /** ISO-8601 */
  readonly brokenAt: string;
}

export interface PromiseCancelledPayload {
  readonly promiseId: Uuid;
  readonly customerId: Uuid;
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly cancelledAt: string;
}

export interface PromiseExpiredPayload {
  readonly promiseId: Uuid;
  readonly customerId: Uuid;
  /** ISO-8601 — the promised date that elapsed unanswered. */
  readonly expectedAt: string;
  readonly graceDays: number;
  /** ISO-8601 */
  readonly expiredAt: string;
}

export type PromiseEvent =
  | DomainEvent<'promise.created', PromiseCreatedPayload>
  | DomainEvent<'promise.activated', PromiseActivatedPayload>
  | DomainEvent<'promise.partiallyFulfilled', PromisePartiallyFulfilledPayload>
  | DomainEvent<'promise.fulfilled', PromiseFulfilledPayload>
  | DomainEvent<'promise.broken', PromiseBrokenPayload>
  | DomainEvent<'promise.cancelled', PromiseCancelledPayload>
  | DomainEvent<'promise.expired', PromiseExpiredPayload>;

// ---------------------------------------------------------------------------
// collections.* cross-lane facts (docs/04 catalog)
// ---------------------------------------------------------------------------

/** `collections.promiseBroken` (E27) — the collections-workflow trigger. */
export interface CollectionsPromiseBrokenPayload {
  readonly promiseId: Uuid;
  /** Open collections case this feeds; null until a case is opened on it. */
  readonly caseId: Uuid | null;
  /** ISO-8601 — the promised date that was missed (intelligence priority boost). */
  readonly expectedAt: string;
  readonly customerId: Uuid;
  readonly settledMinor: number;
  /** ISO-8601 */
  readonly brokenAt: string;
}

/** `collections.dunningBlockedNoConsent` — the K2 refusal made observable. */
export interface CollectionsDunningBlockedNoConsentPayload {
  readonly orgId: Uuid;
  /** Opaque dunning subject (receivable or case) — never dereferenced here. */
  readonly subjectId: Uuid;
  readonly stepKey: string;
  readonly channel: string;
  /** ISO-8601 */
  readonly blockedAt: string;
}

// ---------------------------------------------------------------------------
// dunning.* events (SPEC §18 cadence)
// ---------------------------------------------------------------------------

export interface DunningStepDuePayload {
  readonly orgId: Uuid;
  /** Opaque dunning subject (receivable or case). */
  readonly subjectId: Uuid;
  /** Stable step key from the ladder config (e.g. `overdue_day_3`). */
  readonly stepKey: string;
  /** Days relative to the due date this step fires at (negative = pre-due). */
  readonly dayOffset: number;
  readonly kind: string;
  readonly channel: string;
  readonly requiresConsent: boolean;
  /** ISO-8601 — the ladder anchor (due date) the offsets are relative to. */
  readonly dueDate: string;
}

export interface DunningEscalatedPayload {
  readonly orgId: Uuid;
  readonly subjectId: Uuid;
  /** The step that went unanswered. */
  readonly stepKey: string;
  readonly channel: string;
  /** ISO-8601 — when the unanswered step was sent. */
  readonly lastSendAt: string;
  /** Whole days elapsed since the last send with no response. */
  readonly waitedDays: number;
  /** ISO-8601 */
  readonly escalatedAt: string;
}

export type DunningEvent =
  | DomainEvent<'dunning.stepDue', DunningStepDuePayload>
  | DomainEvent<'dunning.escalated', DunningEscalatedPayload>
  | DomainEvent<'collections.promiseBroken', CollectionsPromiseBrokenPayload>
  | DomainEvent<'collections.dunningBlockedNoConsent', CollectionsDunningBlockedNoConsentPayload>;

/** Everything this lane emits. */
export type PromisesLaneEvent = PromiseEvent | DunningEvent;
