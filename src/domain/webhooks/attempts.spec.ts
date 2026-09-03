import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  DEFAULT_RETRY_LADDER_MS,
  MAX_PAYLOAD_BYTES,
  assertRetryLadder,
  beginAttempt,
  canonicalEnvelope,
  enqueueDelivery,
  isDeliveryDue,
  maxAttemptsFor,
  planDelivery,
  recordAttemptOutcome,
  type Delivery,
  type DeliveryPlan,
} from './attempts';
import {
  addSubscription,
  pauseEndpoint,
  registerEndpoint,
  revokeEndpoint,
  type SecretPorts,
  type WebhookEndpoint,
} from './endpoint';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(701);
const EVENT = uid(702);
const DELIVERY = uid(703);
const T0 = '2026-03-01T08:00:00.000Z';
const plus = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const ports: SecretPorts = {
  generateSecret: () => 'sk_whx_0123456789abcdef0123456789abcdef',
  hashSecret: (secret) => `ref_${secret.length}_abcdef`,
};

const makeEndpoint = (overrides: Partial<{ status: WebhookEndpoint['status'] }> = {}): WebhookEndpoint => {
  let endpoint = registerEndpoint(
    { orgId: ORG, url: 'https://hooks.example.co.ke/fuatilia', label: 'sink' },
    { ...ports, clock: at(T0) },
  ).endpoint;
  endpoint = addSubscription(endpoint, 'payment.*', at(T0)).endpoint;
  if (overrides.status === 'paused') {
    endpoint = pauseEndpoint(endpoint, 'maintenance', at(T0)).endpoint;
  }
  return endpoint;
};

const event = (overrides: Partial<{ eventId: Uuid; eventType: string; payload: unknown }> = {}) => ({
  eventId: EVENT,
  eventType: 'payment.confirmed',
  payload: { paymentId: 'pay_1', amountMinor: 1500 },
  ...overrides,
});

// --- planDelivery -----------------------------------------------------------------

describe('planDelivery — the pure event→wire gate with audited refusals', () => {
  it('plans the canonical envelope with stable field order', () => {
    const result = planDelivery(event(), makeEndpoint(), at(T0));
    if (!result.planned) throw new Error('fixture plan must succeed');
    const { plan } = result;
    {
      expect(plan.canonicalPayload).toBe(
        JSON.stringify({
          name: 'payment.confirmed',
          version: 1,
          aggregateId: EVENT,
          orgId: ORG,
          occurredAt: T0,
          payload: { paymentId: 'pay_1', amountMinor: 1500 },
        }),
      );
      expect(plan.endpointId).toBe(makeEndpoint().endpointId);
    }
  });

  it('canonicalEnvelope keeps insertion order stable (the signed shape)', () => {
    const text = canonicalEnvelope(event(), ORG, T0);
    expect(text.indexOf('"name"')).toBeLessThan(text.indexOf('"version"'));
    expect(text.indexOf('"version"')).toBeLessThan(text.indexOf('"aggregateId"'));
    expect(text.indexOf('"aggregateId"')).toBeLessThan(text.indexOf('"orgId"'));
    expect(text.indexOf('"orgId"')).toBeLessThan(text.indexOf('"occurredAt"'));
    expect(text.indexOf('"occurredAt"')).toBeLessThan(text.indexOf('"payload"'));
  });

  it('refusal table — every refusal is a VALUE paired with webhook.deliveryRefused', () => {
    const cases: Array<{ label: string; endpoint: WebhookEndpoint; reason: string }> = [
      {
        label: 'revoked endpoint never plans',
        endpoint: revokeEndpoint(makeEndpoint(), 'offboarded', at(T0)).endpoint,
        reason: 'ENDPOINT_REVOKED',
      },
      { label: 'paused endpoint plans nothing', endpoint: makeEndpoint({ status: 'paused' }), reason: 'ENDPOINT_PAUSED' },
      {
        label: 'not subscribed',
        endpoint: makeEndpoint(),
        reason: 'NOT_SUBSCRIBED',
      },
    ];
    for (const c of cases) {
      const eventType = c.reason === 'NOT_SUBSCRIBED' ? 'promise.broken' : 'payment.confirmed';
      const result = planDelivery(event({ eventType }), c.endpoint, at(T0));
      expect(result.planned, c.label).toBe(false);
      if (!result.planned) {
        expect(result.refusal.reason, c.label).toBe(c.reason);
        expect(result.event.name, c.label).toBe('webhook.deliveryRefused');
        expect(result.event.payload.reason, c.label).toBe(c.reason);
        expect(result.event.payload.endpointId, c.label).toBe(c.endpoint.endpointId);
      }
    }
  });

  it('PAYLOAD_TOO_LARGE at the cap boundary (inclusive)', () => {
    const endpoint = makeEndpoint();
    // payload sized so the canonical envelope is exactly at the cap → ok
    const small = planDelivery(event({ payload: { x: 'a'.repeat(100) } }), endpoint, at(T0), {
      maxPayloadBytes: MAX_PAYLOAD_BYTES,
    });
    expect(small.planned).toBe(true);
    const huge = planDelivery(event({ payload: { x: 'a'.repeat(MAX_PAYLOAD_BYTES) } }), endpoint, at(T0), {
      maxPayloadBytes: 1024,
    });
    expect(huge.planned).toBe(false);
    if (!huge.planned) {
      expect(huge.refusal.reason).toBe('PAYLOAD_TOO_LARGE');
      expect(huge.event.payload.reason).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('a malformed outbound event is a programming error (nothing to audit)', () => {
    const endpoint = makeEndpoint();
    expectCode(() => planDelivery(event({ eventId: '' as unknown as Uuid }), endpoint, at(T0)), 'WEBHOOK_EVENT_MALFORMED');
    expectCode(() => planDelivery(event({ eventType: '' }), endpoint, at(T0)), 'WEBHOOK_EVENT_MALFORMED');
    expectCode(() => planDelivery(event({ payload: undefined }), endpoint, at(T0)), 'WEBHOOK_EVENT_MALFORMED');
  });
});

// --- the retry ladder --------------------------------------------------------------

describe('assertRetryLadder — bounded, ascending, positive', () => {
  it('accepts the default ladder and reports the attempt budget', () => {
    expect(assertRetryLadder(DEFAULT_RETRY_LADDER_MS)).toBe(DEFAULT_RETRY_LADDER_MS);
    expect(maxAttemptsFor(DEFAULT_RETRY_LADDER_MS)).toBe(DEFAULT_RETRY_LADDER_MS.length + 1);
  });

  it('refusal table', () => {
    expectCode(() => assertRetryLadder([]), 'WEBHOOK_RETRY_LADDER_INVALID');
    expectCode(() => assertRetryLadder([0]), 'WEBHOOK_RETRY_LADDER_INVALID');
    expectCode(() => assertRetryLadder([-1]), 'WEBHOOK_RETRY_LADDER_INVALID');
    expectCode(() => assertRetryLadder([1.5]), 'WEBHOOK_RETRY_LADDER_INVALID');
    expectCode(() => assertRetryLadder([1000, 1000]), 'WEBHOOK_RETRY_LADDER_INVALID');
    expectCode(() => assertRetryLadder([2000, 1000]), 'WEBHOOK_RETRY_LADDER_INVALID');
  });
});

// --- enqueue + lifecycle -------------------------------------------------------------

const planOf = (endpoint: WebhookEndpoint, eventId = EVENT): DeliveryPlan => {
  const result = planDelivery(event({ eventId }), endpoint, at(T0));
  if (!result.planned) throw new Error('fixture plan must succeed');
  return result.plan;
};

const enqueue = (endpoint = makeEndpoint(), deliveries: readonly Delivery[] = []): { delivery: Delivery; plan: DeliveryPlan } => {
  const plan = planOf(endpoint);
  const { delivery } = enqueueDelivery(deliveries, plan, { deliveryId: DELIVERY }, at(T0));
  return { delivery, plan };
};

describe('enqueueDelivery — idempotency (R9/C5 spirit)', () => {
  it('enqueues with deliveryQueued and nextAttemptAt = now', () => {
    const { delivery } = enqueue();
    expect(delivery.status).toBe('queued');
    expect(delivery.attempts).toBe(0);
    expect(delivery.nextAttemptAt?.toISOString()).toBe(T0);
    expect(delivery.attemptLog).toEqual([]);
  });

  it('a deliveryId is unique forever', () => {
    const endpoint = makeEndpoint();
    const first = enqueue(endpoint);
    expectCode(
      () =>
        enqueueDelivery(
          [first.delivery],
          planOf(endpoint, uid(710)),
          { deliveryId: DELIVERY },
          at(plus(T0, 1000)),
        ),
      'WEBHOOK_DELIVERY_ID_TAKEN',
    );
  });

  it('an ACTIVE duplicate (endpointId, eventId) is refused — the queue never double-sends', () => {
    const endpoint = makeEndpoint();
    const { delivery } = enqueue(endpoint);
    expectCode(
      () =>
        enqueueDelivery([delivery], planOf(endpoint), { deliveryId: uid(711) }, at(plus(T0, 1000))),
      'WEBHOOK_DELIVERY_DUPLICATE',
    );
  });

  it('a TERMINAL predecessor allows a fresh explicit re-enqueue (manual replay)', () => {
    const endpoint = makeEndpoint();
    const { delivery } = enqueue(endpoint);
    const done: Delivery = { ...delivery, status: 'delivered', deliveredAt: new Date(plus(T0, 500)) };
    const re = enqueueDelivery([done], planOf(endpoint), { deliveryId: uid(712) }, at(plus(T0, 1000)));
    expect(re.delivery.status).toBe('queued');
  });
});

describe('attempt lifecycle — queued → delivering → delivered | deadLettered', () => {
  it('beginAttempt moves queued → delivering; anything else refuses', () => {
    const { delivery } = enqueue();
    const started = beginAttempt(delivery, at(plus(T0, 1000))).delivery;
    expect(started.status).toBe('delivering');
    expectCode(() => beginAttempt(started, at(plus(T0, 1001))), 'WEBHOOK_DELIVERY_NOT_QUEUED');
  });

  it('success stamps deliveredAt, appends the attempt log, emits deliverySucceeded', () => {
    const { delivery } = enqueue();
    const started = beginAttempt(delivery, at(plus(T0, 1000))).delivery;
    const result = recordAttemptOutcome(started, { outcome: 'success' }, DEFAULT_RETRY_LADDER_MS, at(plus(T0, 1100)));
    expect(result.terminal).toBe(false);
    expect(result.delivery.status).toBe('delivered');
    expect(result.delivery.deliveredAt?.toISOString()).toBe(plus(T0, 1100));
    expect(result.delivery.attempts).toBe(1);
    expect(result.delivery.attemptLog).toEqual([
      { attemptNo: 1, at: new Date(plus(T0, 1100)), outcome: 'success', failureReason: null },
    ]);
    if (!result.terminal && 'event' in result) {
      expect(result.event.name).toBe('webhook.deliverySucceeded');
      expect(result.event.payload.attemptNo).toBe(1);
    }
  });

  it('failure with retries left: back to queued with deterministic nextAttemptAt (ladder boundary)', () => {
    const { delivery } = enqueue();
    const LADDER = [30_000, 60_000];
    let d = beginAttempt(delivery, at(T0)).delivery;
    const first = recordAttemptOutcome(d, { outcome: 'failure', reason: 'ECONNRESET' }, LADDER, at(plus(T0, 100)));
    expect(first.delivery.status).toBe('queued');
    expect(first.delivery.nextAttemptAt?.toISOString()).toBe(plus(T0, 100 + 30_000));
    if (!first.terminal && 'events' in first) {
      expect(first.events[0]!.name).toBe('webhook.deliveryFailed');
      expect(first.events[0]!.payload.willRetry).toBe(true);
      expect(first.events[0]!.payload.nextAttemptAt).toBe(plus(T0, 100 + 30_000));
    }

    d = beginAttempt(first.delivery, at(plus(T0, 100 + 30_000))).delivery;
    const second = recordAttemptOutcome(d, { outcome: 'failure', reason: 'timeout' }, LADDER, at(plus(T0, 100 + 30_100)));
    expect(second.delivery.nextAttemptAt?.toISOString()).toBe(plus(T0, 100 + 30_100 + 60_000));
  });

  it('ladder exhaustion dead-letters with TWO facts (deliveryFailed willRetry:false + deliveryDeadLettered)', () => {
    const { delivery } = enqueue();
    const LADDER = [1000];
    let d = beginAttempt(delivery, at(T0)).delivery;
    d = beginAttempt(recordAttemptOutcome(d, { outcome: 'failure', reason: 'boom' }, LADDER, at(plus(T0, 10))).delivery, at(plus(T0, 1000))).delivery;
    const final = recordAttemptOutcome(d, { outcome: 'failure', reason: 'boom again' }, LADDER, at(plus(T0, 1010)));
    expect(final.terminal).toBe(true);
    expect(final.delivery.status).toBe('deadLettered');
    expect(final.delivery.deadLetteredAt?.toISOString()).toBe(plus(T0, 1010));
    expect(final.delivery.nextAttemptAt).toBeNull();
    if (final.terminal) {
      const [failed, dead] = final.events;
      expect(failed?.name).toBe('webhook.deliveryFailed');
      expect(failed?.payload.willRetry).toBe(false);
      expect(failed?.payload.nextAttemptAt).toBeNull();
      expect(dead?.name).toBe('webhook.deliveryDeadLettered');
      expect(dead?.payload.attempts).toBe(2);
      expect(dead?.payload.failureReason).toBe('boom again');
    }
  });

  it('outcomes record only against a delivering attempt; reasons are mandatory', () => {
    const { delivery } = enqueue();
    expectCode(
      () => recordAttemptOutcome(delivery, { outcome: 'success' }, DEFAULT_RETRY_LADDER_MS, at(T0)),
      'WEBHOOK_DELIVERY_NOT_DELIVERING',
    );
    const started = beginAttempt(delivery, at(T0)).delivery;
    expectCode(
      () => recordAttemptOutcome(started, { outcome: 'failure', reason: '  ' }, DEFAULT_RETRY_LADDER_MS, at(T0)),
      'WEBHOOK_FAILURE_REASON_REQUIRED',
    );
  });

  it('dueDeliveries — inclusive boundary (±1ms) and status discipline', () => {
    const { delivery } = enqueue();
    expect(isDeliveryDue(delivery, at(T0))).toBe(true); // nextAttemptAt == now → due
    expect(isDeliveryDue(delivery, at(plus(T0, -1)))).toBe(false);
    const started = beginAttempt(delivery, at(T0)).delivery;
    expect(isDeliveryDue(started, at(plus(T0, 1000)))).toBe(false); // delivering, not queued
  });

  it('the input aggregate is never mutated (no-mutation pin)', () => {
    const { delivery } = enqueue();
    const started = beginAttempt(delivery, at(T0)).delivery;
    recordAttemptOutcome(started, { outcome: 'success' }, DEFAULT_RETRY_LADDER_MS, at(T0));
    expect(delivery.status).toBe('queued');
    expect(delivery.attempts).toBe(0);
  });
});
