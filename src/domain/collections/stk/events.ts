/**
 * STK-push execution-lane events (RICE #2, docs/research/product-gaps.md).
 *
 * "Collect now via STK push" — the facts of one policy-gated M-Pesa Express
 * collection attempt, named per the repo convention
 * `<context>.<aggregate><PastTenseVerb>`:
 *
 *   stk.pushProposed          the action was proposed (from NBA output) —
 *                             carries the cost/benefit economics + the
 *                             explanation reasons (explainability is a hard
 *                             requirement, H7);
 *   stk.pushRefused           a REFUSAL fact — the DPA consent gate or the
 *                             policy engine blocked the attempt BEFORE any
 *                             initiation. Compliance evidence for the Kenya
 *                             DPA 2019 trail (mirrors
 *                             collections.dunningBlockedNoConsent and
 *                             comms.sendBlockedNoConsent: refusal is a
 *                             first-class outcome, never silent);
 *   stk.pushAwaitingApproval  the policy engine answered requires_approval —
 *                             the attempt is runnable but parked for a human;
 *   stk.pushApproved          a human approved the parked attempt;
 *   stk.pushInitiated         the injected wire port accepted the push — the
 *                             attempt is live on the rail, awaiting the
 *                             customer's result;
 *   stk.pushNotInitiated      the wire port rejected the initiation (the
 *                             attempt stays retryable; the rejection is on
 *                             the record);
 *   stk.pushConfirmed         the STK result callback was reconciled through
 *                             the payments intake core and the money is
 *                             confirmed (fund truth lives ONLY there);
 *   stk.pushFailed            the result callback reported failure/cancel —
 *                             the payment went to the terminal failed state
 *                             through the SAME intake funnel;
 *   stk.pushTimedOut          no result arrived within the TTL — the stuck
 *                             push is closed for polling; a late callback can
 *                             still land (money truth is never dropped).
 *
 * Envelope mirrors the collections/policy lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }`, `version` stays 1
 * until a breaking payload change. Payloads are narrow, serializable and
 * id-only: dates travel as ISO-8601 strings, minor units as safe-integer
 * numbers (R10 — never floats), cross-lane ids as opaque Uuids. The customer
 * MSISDN is PII: it lives on the aggregate only and is NEVER mirrored into
 * any event payload (pinned by tests, mirrors the ussd lane's discipline).
 */
import { DomainError, type Clock, type Uuid } from '../../shared';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

const assertClockDate = (clock: Clock): Date => {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('STK_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return now;
};

/** Pure event factory — the only way this lane builds events. */
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
    occurredAt: assertClockDate(clock).toISOString(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------

/** `stk.pushProposed` — the recommendable proposal (cost/benefit + reasons). */
export interface StkPushProposedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId: Uuid | null;
  readonly caseId: Uuid | null;
  readonly actionType: string;
  /** KES minor units (safe integer, R10). */
  readonly amountMinor: number;
  readonly currency: 'KES';
  readonly actorType: string;
  readonly autonomous: boolean;
  readonly riskClass: string;
  readonly expectedRecoveryMinor: number;
  readonly costMinor: number;
  readonly fatiguePenaltyMinor: number;
  readonly channelFitPermill: number;
  readonly scoreMinor: number;
  readonly reasons: readonly string[];
  /** ISO-8601 */
  readonly proposedAt: string;
}

/** `stk.pushRefused` — the consent or policy refusal (nothing was initiated). */
export interface StkPushRefusedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId: Uuid | null;
  readonly caseId: Uuid | null;
  /** 'consent' — the DPA gate; 'policy' — the engine's governed denial. */
  readonly stage: 'consent' | 'policy';
  /** Machine-readable: the consent RefusalReason or the engine's POLICY_* code. */
  readonly reasonCode: string;
  readonly detail: string;
  /** ISO-8601 */
  readonly refusedAt: string;
}

/** `stk.pushAwaitingApproval` — requires_approval; runnable once a human approves. */
export interface StkPushAwaitingApprovalPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly reasonCode: string;
  readonly matchedRuleIds: readonly string[];
  readonly ruleSetVersion: number;
  /** ISO-8601 */
  readonly awaitingAt: string;
}

/** `stk.pushApproved` — the human approval that unlocks initiation. */
export interface StkPushApprovedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly approvalRef: string;
  readonly approverId: string;
  /** ISO-8601 */
  readonly approvedAt: string;
}

/** `stk.pushInitiated` — the wire accepted; the push is live on the rail. */
export interface StkPushInitiatedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly merchantRequestId: string;
  readonly checkoutRequestId: string;
  /** R9 initiation idempotency key (`stkpush:<actionId>`). */
  readonly idempotencyKey: string;
  /** KES minor units (safe integer, R10). */
  readonly amountMinor: number;
  readonly currency: 'KES';
  readonly ttlMs: number;
  /** ISO-8601 — initiation + TTL: the stuck-push deadline. */
  readonly expiresAt: string;
  /** ISO-8601 */
  readonly initiatedAt: string;
}

/** `stk.pushNotInitiated` — the wire port rejected the initiation. */
export interface StkPushNotInitiatedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly reason: string;
  /** ISO-8601 */
  readonly attemptedAt: string;
}

/** `stk.pushConfirmed` — the callback reconciled through intake; money confirmed. */
export interface StkPushConfirmedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly paymentId: Uuid;
  readonly checkoutRequestId: string;
  readonly receiptNumber: string;
  /** KES minor units (safe integer, R10) — === the initiated amount. */
  readonly amountMinor: number;
  readonly currency: 'KES';
  /** TRUE when the callback landed after the push had already timed out. */
  readonly late: boolean;
  /** ISO-8601 */
  readonly reconciledAt: string;
}

/** `stk.pushFailed` — the result callback reported failure/cancel. */
export interface StkPushFailedPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly paymentId: Uuid;
  readonly checkoutRequestId: string;
  readonly resultCode: number;
  /** The payments-lane failure code derived from the result code. */
  readonly failureCode: string;
  readonly resultDesc: string;
  /** TRUE when the callback landed after the push had already timed out. */
  readonly late: boolean;
  /** ISO-8601 */
  readonly failedAt: string;
}

/** `stk.pushTimedOut` — no result within the TTL; the stuck push is closed out. */
export interface StkPushTimedOutPayload {
  readonly actionId: Uuid;
  readonly orgId: Uuid;
  readonly checkoutRequestId: string;
  /** ISO-8601 — the deadline that passed. */
  readonly expiresAt: string;
  /** ISO-8601 */
  readonly timedOutAt: string;
}

export type StkPushEvent =
  | DomainEvent<'stk.pushProposed', StkPushProposedPayload>
  | DomainEvent<'stk.pushRefused', StkPushRefusedPayload>
  | DomainEvent<'stk.pushAwaitingApproval', StkPushAwaitingApprovalPayload>
  | DomainEvent<'stk.pushApproved', StkPushApprovedPayload>
  | DomainEvent<'stk.pushInitiated', StkPushInitiatedPayload>
  | DomainEvent<'stk.pushNotInitiated', StkPushNotInitiatedPayload>
  | DomainEvent<'stk.pushConfirmed', StkPushConfirmedPayload>
  | DomainEvent<'stk.pushFailed', StkPushFailedPayload>
  | DomainEvent<'stk.pushTimedOut', StkPushTimedOutPayload>;

/** Event names of this lane, for registry/outbox wiring without importing payloads. */
export const STK_PUSH_EVENT_NAMES = [
  'stk.pushProposed',
  'stk.pushRefused',
  'stk.pushAwaitingApproval',
  'stk.pushApproved',
  'stk.pushInitiated',
  'stk.pushNotInitiated',
  'stk.pushConfirmed',
  'stk.pushFailed',
  'stk.pushTimedOut',
] as const;

export type StkPushEventName = (typeof STK_PUSH_EVENT_NAMES)[number];
