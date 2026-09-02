/**
 * PaymentPlan-lane domain events (issue #7, H5).
 *
 * ADDITIONS to the 27-event catalog (docs/04) — the plan lifecycle has no
 * catalog rows yet; these follow the same `<context>.<aggregate><PastTenseVerb>`
 * naming and the wave-1 envelope `{name, version, aggregateId, occurredAt,
 * payload}` so the typed catalog of issue #6 can absorb them unchanged.
 * Payloads are narrow and serializable: ids, ISO dates, safe-integer minor
 * units (the caller converts bigint → number via the shared safe-int guard).
 */
import type { Clock, Uuid } from '../shared';
import { domainEvent, type DomainEvent } from './events';

export interface PlanPaymentRecordedPayload {
  readonly planId: Uuid;
  readonly customerId: Uuid;
  readonly installmentNo: number;
  readonly amountMinor: number;
  /** Cumulative paid on that installment after this payment. */
  readonly paidMinor: number;
  readonly currency: string;
}

export interface PlanCompletedPayload {
  readonly planId: Uuid;
  readonly customerId: Uuid;
  readonly currency: string;
  /** ISO-8601 */
  readonly completedAt: string;
}

export interface PlanDefaultedPayload {
  readonly planId: Uuid;
  readonly customerId: Uuid;
  /** The earliest unpaid installment that crossed the default threshold. */
  readonly installmentNo: number;
  readonly daysOverdue: number;
  readonly defaultAfterDays: number;
}

export interface PlanCancelledPayload {
  readonly planId: Uuid;
  readonly customerId: Uuid;
  readonly reason: string;
}

export type PlanEvent =
  | DomainEvent<'paymentplan.paymentRecorded', PlanPaymentRecordedPayload>
  | DomainEvent<'paymentplan.completed', PlanCompletedPayload>
  | DomainEvent<'paymentplan.defaulted', PlanDefaultedPayload>
  | DomainEvent<'paymentplan.cancelled', PlanCancelledPayload>;

export const planPaymentRecordedEvent = (
  payload: PlanPaymentRecordedPayload,
  clock: Clock,
): DomainEvent<'paymentplan.paymentRecorded', PlanPaymentRecordedPayload> =>
  domainEvent('paymentplan.paymentRecorded', payload.planId, payload, clock);

export const planCompletedEvent = (
  payload: PlanCompletedPayload,
  clock: Clock,
): DomainEvent<'paymentplan.completed', PlanCompletedPayload> =>
  domainEvent('paymentplan.completed', payload.planId, payload, clock);

export const planDefaultedEvent = (
  payload: PlanDefaultedPayload,
  clock: Clock,
): DomainEvent<'paymentplan.defaulted', PlanDefaultedPayload> =>
  domainEvent('paymentplan.defaulted', payload.planId, payload, clock);

export const planCancelledEvent = (
  payload: PlanCancelledPayload,
  clock: Clock,
): DomainEvent<'paymentplan.cancelled', PlanCancelledPayload> =>
  domainEvent('paymentplan.cancelled', payload.planId, payload, clock);
