/**
 * USSD — domain event constructors for the `ussd.*` facts owned by this lane
 * (SPEC §31 low-tech support, issue #54).
 *
 * Envelope: { name, version, aggregateId, payload, occurredAt } per
 * src/domain/events/README.md — the same stable lane shape communications,
 * webhooks and promises emit until the typed catalog (issue #6) absorbs
 * these names.
 *
 * Payloads are narrow and serializable: opaque ids only (no entity
 * references) and ISO-8601 strings. occurredAt comes from the single
 * injected instant of the step that emitted the fact — never Date.now().
 *
 * PII BOUNDARY: the customer's MSISDN and every financial answer (amounts,
 * invoice numbers, statement refs) stay on the returned RESULT, never in an
 * event payload. Events carry opaque ids, node keys, flow names, stable
 * reason codes and the evidenceRef that proves which capability answered.
 * Pinned by a dedicated test.
 *
 * Aggregate convention: every `ussd.*` fact is session-scoped → the session
 * id. (There is no USSD aggregate older than a session.)
 *
 * `ussd.inputRejected` is ADDITIVE beyond the issue's event list (same
 * precedent as `webhook.deliveryRefused`): the "every step emits an event"
 * invariant needs a fact for the re-prompt step — a wrong keypress is a
 * customer event, not a silent nothing.
 */
import type { Uuid } from '../shared';

export type UssdEventName =
  | 'ussd.sessionStarted'
  | 'ussd.navigated'
  | 'ussd.inputRejected'
  | 'ussd.flowCompleted'
  | 'ussd.flowFailed'
  | 'ussd.sessionEnded'
  | 'ussd.sessionExpired'
  | 'ussd.sessionAborted';

/** All names in one place — the lane's observable surface. */
export const USSD_EVENT_NAMES: readonly UssdEventName[] = [
  'ussd.sessionStarted',
  'ussd.navigated',
  'ussd.inputRejected',
  'ussd.flowCompleted',
  'ussd.flowFailed',
  'ussd.sessionEnded',
  'ussd.sessionExpired',
  'ussd.sessionAborted',
];

/** Stable envelope (issue #4); unifies with the typed catalog in issue #6. */
export interface UssdEvent<TName extends UssdEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  readonly payload: TPayload;
  readonly occurredAt: string; // ISO-8601, from the step's single injected instant
}

/** ussd.sessionStarted — a dial-in created a session at the menu root. */
export interface SessionStartedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly rootKey: string;
  readonly startedAt: string;
}

/** ussd.navigated — a keypress moved the session between menu nodes. */
export interface NavigatedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly fromNode: string;
  readonly toNode: string;
  /** The keypress that caused the move (a menu key, not customer text). */
  readonly via: string;
  readonly navigatedAt: string;
}

/** ussd.inputRejected — a wrong keypress; the customer is re-prompted. */
export interface InputRejectedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly nodeKey: string;
  /** The rejected keypress, truncated to the lane's input cap. */
  readonly input: string;
  readonly rejectedAt: string;
}

/**
 * ussd.flowCompleted — a §31 flow answered. The answer itself (amounts,
 * lists) stays on the step result; only its evidenceRef is audited here.
 */
export interface FlowCompletedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly flow: string;
  readonly evidenceRef: string;
  readonly completedAt: string;
}

/** ussd.flowFailed — a §31 flow could not answer; reason is a stable USSD_* code. */
export interface FlowFailedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly flow: string;
  readonly reason: string;
  readonly detail: string;
  readonly failedAt: string;
}

/** ussd.sessionEnded — the session closed (menu exit, flow disposition, explicit end). */
export interface SessionEndedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly reason: string;
  readonly endedAt: string;
}

/** ussd.sessionExpired — the idle horizon passed without activity. */
export interface SessionExpiredPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly idleTtlMs: number;
  readonly expiredAt: string;
}

/** ussd.sessionAborted — the customer hung up with `#`. */
export interface SessionAbortedPayload {
  readonly sessionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly nodeKey: string;
  readonly abortedAt: string;
}

/** Every payload this lane emits, in one union. */
export type UssdEventPayload =
  | SessionStartedPayload
  | NavigatedPayload
  | InputRejectedPayload
  | FlowCompletedPayload
  | FlowFailedPayload
  | SessionEndedPayload
  | SessionExpiredPayload
  | SessionAbortedPayload;

/** Any event this lane emits, envelope pinned. */
export type UssdAnyEvent = UssdEvent<UssdEventName, UssdEventPayload>;

/**
 * The one event factory. `at` is the step's single injected instant (the
 * respond/sweep/end call reads the Clock exactly once and every event of
 * that step shares it — determinism, bit-for-bit replays).
 */
export const ussdEvent = <TName extends UssdEventName, TPayload>(
  name: TName,
  sessionId: Uuid,
  payload: TPayload,
  at: Date,
): UssdEvent<TName, TPayload> => ({
  name,
  version: 1,
  aggregateId: sessionId,
  payload: { ...payload },
  occurredAt: at.toISOString(),
});
