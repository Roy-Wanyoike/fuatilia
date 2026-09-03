/**
 * Delivery planning + attempt lifecycle (issue #47, SPEC §53).
 *
 * Model (mirrors the communications lane's attempt/retry/dead-letter shape):
 *   - `planDelivery` is the PURE gate between the event fabric and the wire:
 *     it builds the canonical envelope (`name, version, aggregateId, orgId,
 *     occurredAt, payload` — JSON.stringify preserves insertion order, so the
 *     field order is stable) and returns a REFUSAL VALUE paired with the
 *     `webhook.deliveryRefused` audit event when the endpoint is paused or
 *     revoked, not subscribed, or the payload exceeds the cap (K2 precedent:
 *     observable refusals are facts, not exceptions).
 *   - enqueue is IDEMPOTENT (R9/C5 spirit): an ACTIVE (queued | delivering)
 *     delivery for the same (endpointId, eventId) is refused
 *     (WEBHOOK_DELIVERY_DUPLICATE) — the queue must never double-send; a
 *     deliveryId is unique forever (WEBHOOK_DELIVERY_ID_TAKEN). A delivery
 *     whose predecessor is TERMINAL (delivered | deadLettered) may be
 *     re-enqueued under a fresh id (deliberate manual replay), never
 *     silently.
 *   - the attempt ladder is pure configuration: attempt N's failure retries
 *     after ladder[N-1] ms (strictly ascending positive steps); exhausting
 *     the ladder dead-letters the delivery (terminal). Every outcome is
 *     appended to an immutable attempt log — attempts are never edited.
 *
 * Statuses: queued → delivering → delivered | deadLettered; a failed attempt
 * with retries left returns the delivery to `queued` with a deterministic
 * `nextAttemptAt` (failure lives in the attempt log, not a phantom status).
 *
 * Secrets never appear here: this module handles payloads and outcomes only.
 */
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  deliveryDeadLetteredEvent,
  deliveryFailedEvent,
  deliveryQueuedEvent,
  deliveryRefusedEvent,
  deliverySucceededEvent,
  webhookNow,
} from './events';
import type {
  DeliveryQueuedPayload,
  WebhookEvent,
  WebhookRefusalReason,
} from './events';
import { endpointSubscribedTo } from './endpoint';
import type { WebhookEndpoint } from './endpoint';

/** Default payload cap for a canonical delivery (chars ≈ bytes for ASCII JSON). */
export const MAX_PAYLOAD_BYTES = 65_536;

/** Bounded exponential ladder: ~30s, 2m, 10m, 30m, 2h, 6h. */
export const DEFAULT_RETRY_LADDER_MS: readonly number[] = [
  30_000,
  120_000,
  600_000,
  1_800_000,
  7_200_000,
  21_600_000,
];

/**
 * Validate a retry ladder: non-empty, positive safe integers, strictly
 * ascending (deterministic backoff). WEBHOOK_RETRY_LADDER_INVALID otherwise.
 */
export const assertRetryLadder = (ladder: readonly number[]): readonly number[] => {
  if (!Array.isArray(ladder) || ladder.length === 0) {
    throw new DomainError('WEBHOOK_RETRY_LADDER_INVALID', 'a retry ladder requires at least one backoff step');
  }
  for (const step of ladder) {
    if (!Number.isSafeInteger(step) || step <= 0) {
      throw new DomainError(
        'WEBHOOK_RETRY_LADDER_INVALID',
        `retry backoff steps must be positive safe integers of milliseconds, got ${String(step)}`,
      );
    }
  }
  for (let i = 1; i < ladder.length; i += 1) {
    if ((ladder[i] as number) <= (ladder[i - 1] as number)) {
      throw new DomainError(
        'WEBHOOK_RETRY_LADDER_INVALID',
        'retry backoff steps must be strictly ascending (deterministic exponential backoff)',
      );
    }
  }
  return ladder;
};

/** Total attempts the ladder buys: the first try + one retry per step. */
export const maxAttemptsFor = (ladder: readonly number[]): number => ladder.length + 1;

/* ------------------------------------------------------------------ *
 * planDelivery — the pure event → wire gate
 * ------------------------------------------------------------------ */

export interface OutboundEvent {
  readonly eventId: Uuid;
  readonly eventType: string;
  /** The narrow event payload (other lanes own its shape — opaque here). */
  readonly payload: unknown;
}

export interface DeliveryPlan {
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly eventId: Uuid;
  readonly eventType: string;
  /** `t=<unixMillis>,v1=...` signs THIS string — stable field order. */
  readonly canonicalPayload: string;
  readonly plannedAt: Date;
}

export type PlanDeliveryResult =
  | { readonly planned: true; readonly plan: DeliveryPlan }
  | {
      readonly planned: false;
      readonly refusal: {
        readonly reason: WebhookRefusalReason;
        readonly detail: string;
      };
      /** webhook.deliveryRefused — the refusal made observable (audit). */
      readonly event: WebhookEvent<'webhook.deliveryRefused', {
        readonly orgId: Uuid;
        readonly endpointId: Uuid;
        readonly eventId: Uuid;
        readonly eventType: string;
        readonly reason: WebhookRefusalReason;
        readonly detail: string;
      }>;
    };

/**
 * The canonical envelope: keys are inserted in THIS order and JSON.stringify
 * preserves string-key insertion order, so every delivery signs the same
 * shape. `payload` embeds as provided — its internal key order is the
 * emitting lane's contract, never rewritten here.
 */
export const canonicalEnvelope = (event: OutboundEvent, orgId: Uuid, occurredAt: string): string =>
  JSON.stringify({
    name: event.eventType,
    version: 1,
    aggregateId: event.eventId,
    orgId,
    occurredAt,
    payload: event.payload,
  });

/**
 * Plan a delivery to an endpoint. Refusal table (checked in order, each a
 * VALUE + webhook.deliveryRefused fact):
 *   1. ENDPOINT_REVOKED   — a revoked endpoint never plans deliveries;
 *   2. ENDPOINT_PAUSED    — paused endpoints plan nothing;
 *   3. NOT_SUBSCRIBED     — no subscription pattern matches the event type;
 *   4. PAYLOAD_TOO_LARGE  — canonical payload over `maxPayloadBytes`.
 * A malformed event (missing ids/type, undefined payload) is a programming
 * error → WEBHOOK_EVENT_MALFORMED (throw) — there is nothing to audit.
 */
export const planDelivery = (
  event: OutboundEvent,
  endpoint: WebhookEndpoint,
  clock: Clock,
  opts: { readonly maxPayloadBytes?: number } = {},
): PlanDeliveryResult => {
  if (
    typeof event.eventId !== 'string' ||
    event.eventId.length === 0 ||
    typeof event.eventType !== 'string' ||
    event.eventType.length === 0 ||
    event.payload === undefined
  ) {
    throw new DomainError(
      'WEBHOOK_EVENT_MALFORMED',
      'planning requires an eventId, an eventType and a defined payload',
    );
  }
  const refuse = (reason: WebhookRefusalReason, detail: string): PlanDeliveryResult => ({
    planned: false,
    refusal: { reason, detail },
    event: deliveryRefusedEvent(
      {
        orgId: endpoint.orgId,
        endpointId: endpoint.endpointId,
        eventId: event.eventId,
        eventType: event.eventType,
        reason,
        detail,
      },
      clock,
    ),
  });

  if (endpoint.status === 'revoked') {
    return refuse('ENDPOINT_REVOKED', `endpoint ${endpoint.endpointId} is revoked — revoked endpoints never plan deliveries`);
  }
  if (endpoint.status === 'paused') {
    return refuse('ENDPOINT_PAUSED', `endpoint ${endpoint.endpointId} is paused — resume it to plan deliveries`);
  }
  if (!endpointSubscribedTo(endpoint, event.eventType)) {
    return refuse(
      'NOT_SUBSCRIBED',
      `endpoint ${endpoint.endpointId} has no subscription matching '${event.eventType}'`,
    );
  }
  const plannedAt = webhookNow(clock);
  const canonicalPayload = canonicalEnvelope(event, endpoint.orgId, plannedAt.toISOString());
  const maxPayloadBytes = opts.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  if (canonicalPayload.length > maxPayloadBytes) {
    return refuse(
      'PAYLOAD_TOO_LARGE',
      `canonical payload is ${canonicalPayload.length} chars, over the ${maxPayloadBytes} cap`,
    );
  }
  return {
    planned: true,
    plan: {
      endpointId: endpoint.endpointId,
      orgId: endpoint.orgId,
      eventId: event.eventId,
      eventType: event.eventType,
      canonicalPayload,
      plannedAt,
    },
  };
};

/* ------------------------------------------------------------------ *
 * The delivery aggregate + attempt lifecycle
 * ------------------------------------------------------------------ */

export type DeliveryStatus = 'queued' | 'delivering' | 'delivered' | 'deadLettered';

export interface AttemptRecord {
  readonly attemptNo: number;
  readonly at: Date;
  readonly outcome: 'success' | 'failure';
  readonly failureReason: string | null;
}

export interface Delivery {
  readonly deliveryId: Uuid;
  readonly endpointId: Uuid;
  readonly orgId: Uuid;
  readonly eventId: Uuid;
  readonly eventType: string;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly lastFailureReason: string | null;
  /** Append-only attempt log — never edited, never reordered. */
  readonly attemptLog: readonly AttemptRecord[];
}

const isTerminalDelivery = (delivery: Delivery): boolean =>
  delivery.status === 'delivered' || delivery.status === 'deadLettered';

export interface EnqueueDeliveryArgs {
  readonly deliveryId: Uuid;
}

export interface EnqueueDeliveryResult {
  readonly delivery: Delivery;
  readonly event: WebhookEvent<'webhook.deliveryQueued', DeliveryQueuedPayload>;
}

/**
 * Enqueue a planned delivery. Idempotency (R9/C5 spirit):
 *   - a deliveryId is unique forever → WEBHOOK_DELIVERY_ID_TAKEN;
 *   - an ACTIVE delivery (queued | delivering) for the same
 *     (endpointId, eventId) is refused → WEBHOOK_DELIVERY_DUPLICATE (the
 *     queue never double-sends);
 *   - a TERMINAL predecessor allows a fresh, explicit re-enqueue (manual
 *     replay) under a new id.
 * Emits webhook.deliveryQueued.
 */
export const enqueueDelivery = (
  existingDeliveries: readonly Delivery[],
  plan: DeliveryPlan,
  args: EnqueueDeliveryArgs,
  clock: Clock,
): EnqueueDeliveryResult => {
  if (existingDeliveries.some((d) => d.deliveryId === args.deliveryId)) {
    throw new DomainError('WEBHOOK_DELIVERY_ID_TAKEN', `delivery ${args.deliveryId} already exists`, {
      deliveryId: args.deliveryId,
    });
  }
  const activeDuplicate = existingDeliveries.find(
    (d) =>
      !isTerminalDelivery(d) && d.endpointId === plan.endpointId && d.eventId === plan.eventId,
  );
  if (activeDuplicate) {
    throw new DomainError(
      'WEBHOOK_DELIVERY_DUPLICATE',
      `delivery ${activeDuplicate.deliveryId} is already ${activeDuplicate.status} for event ${plan.eventId} on this endpoint — the queue never double-sends`,
      { endpointId: plan.endpointId, eventId: plan.eventId },
    );
  }
  const queuedAt = webhookNow(clock);
  const delivery: Delivery = {
    deliveryId: args.deliveryId,
    endpointId: plan.endpointId,
    orgId: plan.orgId,
    eventId: plan.eventId,
    eventType: plan.eventType,
    status: 'queued',
    attempts: 0,
    nextAttemptAt: queuedAt,
    deliveredAt: null,
    deadLetteredAt: null,
    lastFailureReason: null,
    attemptLog: [],
  };
  return {
    delivery,
    event: deliveryQueuedEvent(
      {
        deliveryId: delivery.deliveryId,
        endpointId: delivery.endpointId,
        orgId: delivery.orgId,
        eventId: delivery.eventId,
        eventType: delivery.eventType,
      },
      clock,
    ),
  };
};

/** Is a queued delivery due right now? Inclusive boundary (±1ms meaningful). */
export const isDeliveryDue = (delivery: Delivery, clock: Clock): boolean => {
  if (delivery.status !== 'queued' || delivery.nextAttemptAt === null) return false;
  return clock.now().getTime() >= delivery.nextAttemptAt.getTime();
};

/**
 * Start an attempt: queued → delivering. WEBHOOK_DELIVERY_NOT_QUEUED
 * otherwise (delivering/delivered/deadLettered cannot begin an attempt).
 */
export const beginAttempt = (delivery: Delivery, clock: Clock): { delivery: Delivery } => {
  if (delivery.status !== 'queued') {
    throw new DomainError(
      'WEBHOOK_DELIVERY_NOT_QUEUED',
      `delivery ${delivery.deliveryId} is ${delivery.status} — attempts begin only from queued`,
      { deliveryId: delivery.deliveryId, status: delivery.status },
    );
  }
  webhookNow(clock); // clock guard
  return { delivery: { ...delivery, status: 'delivering' } };
};

export type AttemptOutcome = { readonly outcome: 'success' } | { readonly outcome: 'failure'; readonly reason: string };

export type AttemptResult =
  | {
      readonly delivery: Delivery;
      readonly terminal: false;
      readonly event: WebhookEvent<'webhook.deliverySucceeded', {
        readonly deliveryId: Uuid;
        readonly endpointId: Uuid;
        readonly orgId: Uuid;
        readonly eventId: Uuid;
        readonly eventType: string;
        readonly attemptNo: number;
      }>;
    }
  | {
      readonly delivery: Delivery;
      readonly terminal: false;
      readonly events: readonly [
        WebhookEvent<'webhook.deliveryFailed', {
          readonly deliveryId: Uuid;
          readonly endpointId: Uuid;
          readonly orgId: Uuid;
          readonly eventId: Uuid;
          readonly attemptNo: number;
          readonly failureReason: string;
          readonly willRetry: boolean;
          readonly nextAttemptAt: string | null;
        }>,
      ];
    }
  | {
      readonly delivery: Delivery;
      readonly terminal: true;
      readonly events: readonly [
        WebhookEvent<'webhook.deliveryFailed', {
          readonly deliveryId: Uuid;
          readonly endpointId: Uuid;
          readonly orgId: Uuid;
          readonly eventId: Uuid;
          readonly attemptNo: number;
          readonly failureReason: string;
          readonly willRetry: boolean;
          readonly nextAttemptAt: string | null;
        }>,
        WebhookEvent<'webhook.deliveryDeadLettered', {
          readonly deliveryId: Uuid;
          readonly endpointId: Uuid;
          readonly orgId: Uuid;
          readonly eventId: Uuid;
          readonly attempts: number;
          readonly failureReason: string;
        }>,
      ];
    };

/**
 * Record an attempt's outcome (delivering → …). Only a `delivering` delivery
 * records outcomes (WEBHOOK_DELIVERY_NOT_DELIVERING). A blank failure reason
 * is refused (WEBHOOK_FAILURE_REASON_REQUIRED) — an unexplained failure is
 * not an audit fact.
 *
 *   success          → delivered + webhook.deliverySucceeded;
 *   failure, retries → queued with nextAttemptAt = now + ladder[attempts-1]
 *                      + webhook.deliveryFailed (willRetry: true);
 *   failure, spent   → deadLettered + webhook.deliveryFailed
 *                      (willRetry: false) AND webhook.deliveryDeadLettered
 *                      (two facts, one transition — the promises-lane
 *                      precedent).
 */
export const recordAttemptOutcome = (
  delivery: Delivery,
  result: AttemptOutcome,
  ladder: readonly number[],
  clock: Clock,
): AttemptResult => {
  const steps = assertRetryLadder(ladder);
  if (delivery.status !== 'delivering') {
    throw new DomainError(
      'WEBHOOK_DELIVERY_NOT_DELIVERING',
      `delivery ${delivery.deliveryId} is ${delivery.status} — outcomes record only against a delivering attempt`,
      { deliveryId: delivery.deliveryId, status: delivery.status },
    );
  }
  const at = webhookNow(clock);
  const attemptNo = delivery.attempts + 1;

  if (result.outcome === 'success') {
    const logged: AttemptRecord = { attemptNo, at, outcome: 'success', failureReason: null };
    const delivered: Delivery = {
      ...delivery,
      status: 'delivered',
      attempts: attemptNo,
      nextAttemptAt: null,
      deliveredAt: at,
      attemptLog: [...delivery.attemptLog, logged],
    };
    return {
      delivery: delivered,
      terminal: false,
      event: deliverySucceededEvent(
        {
          deliveryId: delivered.deliveryId,
          endpointId: delivered.endpointId,
          orgId: delivered.orgId,
          eventId: delivered.eventId,
          eventType: delivered.eventType,
          attemptNo,
        },
        clock,
      ),
    };
  }

  const reason = typeof result.reason === 'string' ? result.reason.trim() : '';
  if (!reason) {
    throw new DomainError(
      'WEBHOOK_FAILURE_REASON_REQUIRED',
      'a failed attempt requires a non-blank failure reason (audit)',
    );
  }
  const logged: AttemptRecord = { attemptNo, at, outcome: 'failure', failureReason: reason };
  const base: Delivery = {
    ...delivery,
    attempts: attemptNo,
    lastFailureReason: reason,
    attemptLog: [...delivery.attemptLog, logged],
  };

  const willRetry = attemptNo <= steps.length;
  if (willRetry) {
    const backoffMs = steps[attemptNo - 1] as number;
    const nextAttemptAt = new Date(at.getTime() + backoffMs);
    const retried: Delivery = { ...base, status: 'queued', nextAttemptAt };
    return {
      delivery: retried,
      terminal: false,
      events: [
        deliveryFailedEvent(
          {
            deliveryId: retried.deliveryId,
            endpointId: retried.endpointId,
            orgId: retried.orgId,
            eventId: retried.eventId,
            attemptNo,
            failureReason: reason,
            willRetry: true,
            nextAttemptAt: nextAttemptAt.toISOString(),
          },
          clock,
        ),
      ],
    };
  }

  const deadLettered: Delivery = {
    ...base,
    status: 'deadLettered',
    nextAttemptAt: null,
    deadLetteredAt: at,
  };
  return {
    delivery: deadLettered,
    terminal: true,
    events: [
      deliveryFailedEvent(
        {
          deliveryId: deadLettered.deliveryId,
          endpointId: deadLettered.endpointId,
          orgId: deadLettered.orgId,
          eventId: deadLettered.eventId,
          attemptNo,
          failureReason: reason,
          willRetry: false,
          nextAttemptAt: null,
        },
        clock,
      ),
      deliveryDeadLetteredEvent(
        {
          deliveryId: deadLettered.deliveryId,
          endpointId: deadLettered.endpointId,
          orgId: deadLettered.orgId,
          eventId: deadLettered.eventId,
          attempts: deadLettered.attempts,
          failureReason: reason,
        },
        clock,
      ),
    ],
  };
};
