/**
 * `/v1/payments/*` — the fund-truth surface over the payments lane (issue
 * #60): the ONE intake funnel, lookup/read-model and the refund lifecycle.
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows, in the style of `routes/auth.ts`; permissions come from
 * the closed vocabulary:
 *
 *   - `payments:intake` — the Daraja at-least-once funnel: intake (C2B
 *     callbacks + STK push results converge here, R9/C5) and the success
 *     callback (confirmation). Replays are NORMAL and idempotent:
 *     duplicate intake → 200 with the EXISTING payment and the lane's
 *     `payments.duplicateCallbackObserved` tripwire recorded; a re-confirmed
 *     success callback with the SAME amount → 200 `alreadyConfirmed`, with a
 *     DIFFERENT amount → 409 `CONFIRMED_AMOUNT_MISMATCH`.
 *   - `payments:read` — lookup / list (read model).
 *   - `payments:refund` — refund reservations (R6: refunds draw only on
 *     funds not already allocated/refunded; over-draw → 422
 *     `REFUND_EXCEEDS_AVAILABLE`).
 *
 * Handlers are wire→lane adapters ONLY: validate body shape
 * (`HTTP_BODY_INVALID`), look up the aggregate (`HTTP_PAYMENT_NOT_FOUND`),
 * call the lane's pure functions with the injected clock/ids (money math is
 * the lane's — never re-implemented here), persist through the injected
 * ResourceStore, record the lane's events, project serializable views.
 * Refusal-as-value decisions map per the kernel's status table (409/422).
 *
 * Confirmation orchestration note: the wire route represents the Daraja
 * success callback. A callback may race ahead of the platform's
 * "awaiting confirmation" step, so the adapter advances an `initiated`
 * payment through the lane's own `awaitConfirmation` transition before
 * calling `confirmPayment` — lane transitions, no re-implementation.
 *
 * Org scoping: the payment aggregate carries no orgId (lane value) — see
 * runtime/resources.ts for the reference-store scoping note.
 */
import type { Uuid } from '../../../domain/shared/ids';
import { DomainError } from '../../../domain/shared/errors';
import { CURRENCIES, Money, type Currency } from '../../../domain/shared/money';
import { intakePayment } from '../../../domain/payments/intake';
import {
  awaitConfirmation,
  confirmPayment,
  recordRefundReservation,
  unappliedMinorOf,
  type Payment,
} from '../../../domain/payments/payment';
import { HTTP_BODY_INVALID, HTTP_PAYMENT_NOT_FOUND, HTTP_QUERY_INVALID } from '../kernel/errors';
import type { RequestContext, RouteRecord } from '../kernel/types';
import { paginatedMeta, parsePagination, parseSorting } from '../pagination';
import { toStoredEvent, type ResourceRouteDeps } from '../runtime/resources';

// --- body field guards (wire-shape validation only — the domain re-validates values) ----

const bodyObject = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(HTTP_BODY_INVALID, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

const stringField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty string`);
  }
  return value.trim();
};

const uuidField = (body: Record<string, unknown>, name: string): Uuid => {
  const raw = stringField(body, name);
  try {
    return uuidOf(raw);
  } catch {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a UUID`);
  }
};

const optionalUuidField = (body: Record<string, unknown>, name: string): Uuid | undefined => {
  if (body[name] === undefined) return undefined;
  return uuidField(body, name);
};

const optionalStringArrayField = (body: Record<string, unknown>, name: string): readonly string[] | undefined => {
  const raw = body[name];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an array of strings`);
  }
  return raw as string[];
};

/** Money on the wire: `{ minor, currency }` — minor units as a safe positive integer (R10). */
const moneyField = (body: Record<string, unknown>, name: string): Money => {
  const raw = body[name];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an object { minor, currency }`);
  }
  const shape = raw as Record<string, unknown>;
  const minor = shape['minor'];
  const currency = shape['currency'];
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor <= 0) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}.minor' must be a positive integer (minor units)`);
  }
  if (typeof currency !== 'string' || !(CURRENCIES as readonly string[]).includes(currency)) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}.currency' must be one of: ${CURRENCIES.join(', ')}`);
  }
  return Money.ofMinor(minor, currency as Currency);
};

const uuidOf = (raw: string): Uuid => {
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) throw new Error(`invalid uuid: ${raw}`);
  return raw as Uuid;
};

// --- serializable views -----------------------------------------------------------------

const jsonMoney = (amount: Money): { minor: number; currency: Currency } => ({
  minor: Number(amount.amount),
  currency: amount.currency,
});

const isoOrNull = (at: Date | undefined | null): string | null => (at ? at.toISOString() : null);

export const paymentView = (payment: Payment) => ({
  id: payment.id,
  channel: payment.channel,
  externalRef: payment.externalRef,
  idempotencyKey: payment.idempotencyKey,
  customerId: payment.customerId ?? null,
  state: payment.state,
  currency: payment.currency,
  requested: jsonMoney(payment.requestedMinor),
  confirmed: payment.confirmedMinor ? jsonMoney(payment.confirmedMinor) : null,
  // Derivable unapplied balance — the lane's own ceiling math (R2/R6), not the handler's.
  unapplied: jsonMoney(unappliedMinorOf(payment)),
  declaredRefs: [...payment.declaredRefs],
  allocations: payment.allocations.map((row) => ({
    id: row.id,
    receivableId: row.receivableId,
    amount: jsonMoney(row.amount),
    recordedAt: row.recordedAt.toISOString(),
  })),
  refunds: payment.refunds.map((row) => ({
    id: row.id,
    amount: jsonMoney(row.amount),
    reason: row.reason,
    recordedAt: row.recordedAt.toISOString(),
  })),
  initiatedAt: payment.initiatedAt.toISOString(),
  confirmedAt: isoOrNull(payment.confirmedAt),
  failedAt: isoOrNull(payment.failedAt),
  failureCode: payment.failureCode ?? null,
  reversedAt: isoOrNull(payment.reversedAt),
  reversalReason: payment.reversalReason ?? null,
});

// --- the route table -----------------------------------------------------------------------

const SORTABLE = ['id', 'state', 'initiatedAt'] as const;

/** The opaque reference cursor is the offset into the deterministic order. */
const decodeCursor = (cursor: string): number => {
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' is not a valid page cursor`);
  }
  return offset;
};

export function paymentsRoutes(deps: ResourceRouteDeps): RouteRecord[] {
  const { store, clock, idGen } = deps;

  const intakeRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/payments/intake',
    permission: 'payments:intake',
    handler: (ctx) => {
      const body = bodyObject(ctx.body);
      const channel = body['channel'];
      if (channel !== 'c2b' && channel !== 'stk') {
        throw new DomainError(HTTP_BODY_INVALID, "field 'channel' must be 'c2b' or 'stk'");
      }
      const result = intakePayment(
        {
          channel,
          externalRef: stringField(body, 'externalRef'),
          idempotencyKey: stringField(body, 'idempotencyKey'),
          amount: moneyField(body, 'amount'),
          customerId: optionalUuidField(body, 'customerId'),
          declaredRefs: optionalStringArrayField(body, 'declaredRefs'),
          paymentId: idGen() as Uuid,
        },
        { clock, existing: store.payments() },
      );
      store.savePayment(result.payment);
      for (const event of result.events) store.record(toStoredEvent(event));
      return {
        // R9/C5 replay semantics: a duplicate is the SAME logical payment —
        // 200 with the existing row, never a second Payment.
        status: result.duplicate ? 200 : 201,
        data: { payment: paymentView(result.payment), duplicate: result.duplicate },
      };
    },
  };

  const getPaymentRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/payments/:paymentId',
    permission: 'payments:read',
    handler: (ctx) => {
      const payment = store.payments().find((p) => p.id === ctx.params['paymentId']);
      if (!payment) {
        throw new DomainError(HTTP_PAYMENT_NOT_FOUND, `payment ${ctx.params['paymentId']} does not exist`);
      }
      return { status: 200, data: { payment: paymentView(payment) } };
    },
  };

  const listPaymentsRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/payments',
    permission: 'payments:read',
    handler: (ctx) => {
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const views = store.payments().map((payment) => paymentView(payment) as unknown as Record<string, unknown>);
      const ordered =
        field === null ? views : [...views].sort((a, b) => {
          const cmp = String(a[field]).localeCompare(String(b[field]));
          return order === 'asc' ? cmp : -cmp;
        });
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { payments: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  const confirmRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/payments/:paymentId/confirmations',
    permission: 'payments:intake',
    handler: (ctx) => {
      const payment = store.payments().find((p) => p.id === ctx.params['paymentId']);
      if (!payment) {
        throw new DomainError(HTTP_PAYMENT_NOT_FOUND, `payment ${ctx.params['paymentId']} does not exist`);
      }
      const amount = moneyField(bodyObject(ctx.body), 'amount');
      if (payment.state === 'confirmed') {
        // Replay of the same success callback: the lane validates the amount
        // (a DIFFERENT amount throws CONFIRMED_AMOUNT_MISMATCH → 409) and
        // answers a no-op — confirmedMinor is set exactly ONCE.
        confirmPayment(payment, amount, clock);
        return { status: 200, data: { payment: paymentView(payment), alreadyConfirmed: true } };
      }
      const staged = payment.state === 'initiated' ? awaitConfirmation(payment).payment : payment;
      const { payment: confirmed, events } = confirmPayment(staged, amount, clock);
      store.savePayment(confirmed);
      for (const event of events) store.record(toStoredEvent(event));
      return { status: 201, data: { payment: paymentView(confirmed), alreadyConfirmed: false } };
    },
  };

  const refundRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/payments/:paymentId/refund-reservations',
    permission: 'payments:refund',
    handler: (ctx) => {
      const payment = store.payments().find((p) => p.id === ctx.params['paymentId']);
      if (!payment) {
        throw new DomainError(HTTP_PAYMENT_NOT_FOUND, `payment ${ctx.params['paymentId']} does not exist`);
      }
      const body = bodyObject(ctx.body);
      const result = recordRefundReservation(
        payment,
        { amount: moneyField(body, 'amount'), reason: stringField(body, 'reason') },
        clock,
      );
      store.savePayment(result.payment);
      // The lane emits no event here: the Refunded/PartiallyRefunded edges
      // belong to the adjustments lane's Refund aggregate (issue #4); the
      // reservation row keeps the payment-side R6 ceiling honest.
      return { status: 201, data: { payment: paymentView(result.payment) } };
    },
  };

  return [intakeRoute, getPaymentRoute, listPaymentsRoute, confirmRoute, refundRoute];
}
