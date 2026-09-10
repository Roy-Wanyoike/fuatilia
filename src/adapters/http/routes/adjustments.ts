/**
 * `/v1/adjustments/*` — the adjustments feed + the two INTENT evaluators
 * (issue #132).
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows, in the style of `routes/payments.ts`; every route here
 * requires the `adjustments:request` vocabulary permission; the kernel's
 * middleware does authenticate → `can(principal, permission)` → audited
 * denial (401/403) BEFORE the handler runs.
 *
 * THE INTENT CONTRACT: the two POST routes are DRY-RUN evaluators. They run
 * the adjustments lane's refusal tables verbatim — `draftCreditNote`
 * (src/domain/adjustments/credit-note.ts) and `requestRefund`
 * (src/domain/adjustments/refund.ts, over the R6 ceiling computed from the
 * payment snapshot via the payments lane's own `unappliedMinorOf` math,
 * payment.ts:132-140) — and answer **200** with the validation refusals AS
 * STRUCTURED VALUES `{ code, message, field, details }`. Value refusals are
 * collected (one proposal can fail several independent guards at once); they
 * never become HTTP errors and NOTHING is persisted — no refunds row, no
 * credit note, no ledger entry, no recorded event (R3/R6/R7: the write path
 * belongs to the adjustments lane's own aggregate lifecycle). Only JSON-SHAPE
 * violations are transport 400s (HTTP_BODY_INVALID), exactly like every other
 * mounted field guard.
 *
 * The feed (`GET /v1/adjustments`) is the org's refund + credit-note truth as
 * one discriminated union (kind `refund` | `credit_note`). In the REFERENCE
 * composition the stored side of that union is the payments lane's
 * append-only refund reservation rows (the payment-side R6 ceiling, projected
 * at the Refund aggregate's entry state `requested` — the lifecycle edges
 * belong to the adjustments lane, issue #4); the reservation row carries no
 * requester, so `requestedBy` projects null where the persistence-backed
 * deployments read `refunds.requested_by`. Draft credit notes are pure
 * proposals — nothing is stored — so the reference feed carries refunds only.
 * A persistence adapter swaps in the real credit_notes/refunds rows behind
 * the same contract.
 *
 * Org scoping: the payment aggregate carries no orgId (lane value) — see
 * runtime/resources.ts for the reference-store scoping note.
 */
import { DomainError } from '../../../domain/shared/errors';
import type { Uuid } from '../../../domain/shared/ids';
import { CURRENCIES, Money, type Currency } from '../../../domain/shared/money';
import { draftCreditNote } from '../../../domain/adjustments/credit-note';
import { requestRefund } from '../../../domain/adjustments/refund';
import { unappliedMinorOf, type Payment } from '../../../domain/payments/payment';
import {
  HTTP_BODY_INVALID,
  HTTP_PAYMENT_NOT_FOUND,
  HTTP_QUERY_INVALID,
  HTTP_UNAUTHENTICATED,
} from '../kernel/errors';
import type { RouteRecord } from '../kernel/types';
import { paginatedMeta, parsePagination, parseSorting } from '../pagination';
import type { ResourceRouteDeps } from '../runtime/resources';

// --- refusal values (the intent surface's refusal-as-value contract) --------------------

/** One domain refusal carried as a VALUE in the 200 body — never an error envelope. */
export interface AdjustmentRefusalView {
  readonly code: string;
  readonly message: string;
  readonly field: string;
  readonly details: Record<string, unknown> | null;
}

const refusalOf = (code: string, message: string, field: string, details?: Record<string, unknown>): AdjustmentRefusalView => ({
  code,
  message,
  field,
  details: details ?? null,
});

/**
 * The lane's error details carry the domain's bigint minor-unit counters
 * (`Money.amount` is a bigint — shared/money.ts); the wire speaks JSON
 * numbers. Every bigint riding these details is a minor-unit count that the
 * route's own `Number.isSafeInteger` wire guard already admitted, so the
 * widening is lossless; the JSON-safe projection happens exactly once, at
 * this adapter boundary.
 */
const jsonSafeDetails = (details: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
  );

// --- body field guards (wire-shape validation only — the lane re-validates values) ------

const bodyObject = (body: unknown): Record<string, unknown> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(HTTP_BODY_INVALID, 'request body must be a JSON object');
  }
  return body as Record<string, unknown>;
};

const uuidOf = (raw: string): Uuid => {
  if (!/^[0-9a-fA-F-]{36}$/.test(raw)) throw new Error(`invalid uuid: ${raw}`);
  return raw as Uuid;
};

const uuidField = (body: Record<string, unknown>, name: string): Uuid => {
  const value = body[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a non-empty string`);
  }
  try {
    return uuidOf(value.trim());
  } catch {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a UUID`);
  }
};

const optionalUuidField = (body: Record<string, unknown>, name: string): Uuid | undefined => {
  if (body[name] === undefined || body[name] === null) return undefined;
  return uuidField(body, name);
};

/**
 * A required string WITHOUT the blankness rule — blankness is the lane's
 * refusal VALUE (CREDIT_NOTE_REASON_REQUIRED, REFUND_REASON_REQUIRED), not a
 * shape violation. A non-string is not evaluable and refuses 400.
 */
const rawStringField = (body: Record<string, unknown>, name: string): string => {
  const value = body[name];
  if (typeof value !== 'string') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a string`);
  }
  return value;
};

/** An optional string without the blankness rule (see rawStringField). */
const rawOptionalStringField = (body: Record<string, unknown>, name: string): string | undefined => {
  const raw = body[name];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be a string`);
  }
  return raw;
};

/**
 * Money on the wire for the intent surface: `{ minor, currency }` where
 * minor is a safe JSON integer of ANY sign (a non-positive minor is the
 * lane's refusal VALUE, not a shape violation — Money's own guards refuse
 * zero/negative) and currency a member of the closed ISO set. Everything
 * else refuses HTTP_BODY_INVALID.
 */
const rawMoneyField = (body: Record<string, unknown>, name: string): { minor: number; currency: Currency } => {
  const raw = body[name];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an object { minor, currency }`);
  }
  const shape = raw as Record<string, unknown>;
  const minor = shape['minor'];
  const currency = shape['currency'];
  if (!('minor' in shape) || !('currency' in shape)) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}' must be an object { minor, currency }`);
  }
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor)) {
    throw new DomainError(HTTP_BODY_INVALID, `field '${name}.minor' must be an integer (minor units)`);
  }
  if (typeof currency !== 'string' || !(CURRENCIES as readonly string[]).includes(currency)) {
    throw new DomainError(
      HTTP_BODY_INVALID,
      `field '${name}.currency' must be one of: ${CURRENCIES.join(', ')}`,
    );
  }
  return { minor, currency: currency as Currency };
};

// --- serializable views -----------------------------------------------------------------

const draftIntentView = (note: ReturnType<typeof draftCreditNote>['note']) => ({
  id: note.id,
  customerId: note.customerId,
  invoiceId: note.invoiceId ?? null,
  reason: note.reason,
  total: { minor: Number(note.total.amount), currency: note.total.currency },
  state: note.state,
});

const refundIntentView = (
  refund: ReturnType<typeof requestRefund>['refund'],
  ceiling: Money,
) => ({
  id: refund.id,
  paymentId: refund.paymentId,
  requestedBy: refund.requestedBy,
  reason: refund.reason,
  total: { minor: Number(refund.total.amount), currency: refund.total.currency },
  state: refund.state,
  // the R6 ceiling the proposal was evaluated against — an audit value
  ceiling: { minor: Number(ceiling.amount), currency: ceiling.currency },
});

/** One feed row of the discriminated adjustments union (kind refund | credit_note). */
export type AdjustmentView = {
  readonly kind: 'refund';
  readonly id: Uuid;
  readonly paymentId: Uuid;
  readonly requestedBy: string | null;
  readonly reason: string;
  readonly total: { readonly minor: number; readonly currency: Currency };
  readonly state: string;
  readonly externalRef: string | null;
  readonly rejectedReason: string | null;
  readonly failedReason: string | null;
  readonly createdAt: string;
};

/**
 * The feed rows derived from the stored side of the union: the payments
 * lane's refund reservation rows at the Refund aggregate's entry state
 * (see the file header for the reference-composition scoping note).
 */
const adjustmentsFeed = (payments: readonly Payment[]): AdjustmentView[] =>
  payments.flatMap((payment) =>
    payment.refunds.map(
      (row): AdjustmentView => ({
        kind: 'refund',
        id: row.id,
        paymentId: row.paymentId,
        requestedBy: null,
        reason: row.reason,
        total: { minor: Number(row.amount.amount), currency: row.amount.currency },
        state: 'requested',
        externalRef: null,
        rejectedReason: null,
        failedReason: null,
        createdAt: row.recordedAt.toISOString(),
      }),
    ),
  );

// --- ordering (deterministic; the unique id is the tiebreak) ------------------------------

const SORTABLE = ['id', 'kind', 'state', 'createdAt'] as const;

const compareBy = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const orderFeed = (rows: readonly AdjustmentView[], field: string | null, order: 'asc' | 'desc'): AdjustmentView[] => {
  const sorted = [...rows];
  const direction = order === 'asc' ? 1 : -1;
  if (field === null) {
    // default: the write order — createdAt, then the unique id
    sorted.sort((a, b) => compareBy(a.createdAt, b.createdAt) * direction || compareBy(a.id, b.id));
    return sorted;
  }
  sorted.sort((a, b) => {
    const av = String(a[field as keyof AdjustmentView]);
    const bv = String(b[field as keyof AdjustmentView]);
    if (av !== bv) return (av < bv ? -1 : 1) * direction;
    return compareBy(a.id, b.id);
  });
  return sorted;
};

/** The opaque reference cursor is the offset into the deterministic order. */
const decodeCursor = (cursor: string): number => {
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' is not a valid page cursor`);
  }
  return offset;
};

// --- the route table ------------------------------------------------------------------------

export function adjustmentsRoutes(deps: ResourceRouteDeps): RouteRecord[] {
  const { store, clock, idGen } = deps;

  const feedRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/adjustments',
    permission: 'adjustments:request',
    handler: (ctx) => {
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const ordered = orderFeed(adjustmentsFeed(store.payments()), field, order);
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { adjustments: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  const creditNoteIntentRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/adjustments/credit-notes',
    permission: 'adjustments:request',
    handler: (ctx) => {
      // The evaluation is pure (nothing persists, nothing to scope), but the
      // fail-closed principal assertion still runs: a permission-gated handler
      // without a principal is a kernel bug.
      if (ctx.principal === null) {
        throw new DomainError(HTTP_UNAUTHENTICATED, 'an authenticated principal is required');
      }
      const body = bodyObject(ctx.body);
      const customerId = uuidField(body, 'customerId');
      const invoiceId = optionalUuidField(body, 'invoiceId');
      const reason = rawStringField(body, 'reason');
      const total = rawMoneyField(body, 'total');

      // The lane's refusal table (credit-note.ts:92-111), COLLECTED — the two
      // guards are independent value checks, so one proposal can fail both.
      const refusals: AdjustmentRefusalView[] = [];
      if (reason.trim() === '') {
        refusals.push(refusalOf('CREDIT_NOTE_REASON_REQUIRED', 'a credit note requires a reason', 'reason'));
      }
      if (total.minor <= 0) {
        refusals.push(refusalOf('CREDIT_NOTE_TOTAL_INVALID', 'credit note total must be positive', 'total.minor'));
      }
      if (refusals.length > 0) {
        return { status: 200, data: { intent: null, accepted: false, refusals } };
      }

      // The lane builds the draft — money construction cannot throw here (the
      // guard above pins a positive minor), and NOTHING is stored (R3/R7).
      const { note } = draftCreditNote({
        id: idGen() as Uuid,
        customerId,
        invoiceId,
        reason: reason.trim(),
        total: Money.ofMinor(total.minor, total.currency),
      });
      return { status: 200, data: { intent: draftIntentView(note), accepted: true, refusals: [] } };
    },
  };

  const refundIntentRoute: RouteRecord = {
    method: 'POST',
    pattern: '/v1/adjustments/refund-reservations',
    permission: 'adjustments:request',
    handler: (ctx) => {
      const principal = ctx.principal;
      if (principal === null) {
        throw new DomainError(HTTP_UNAUTHENTICATED, 'an authenticated principal is required');
      }
      const body = bodyObject(ctx.body);
      const paymentId = uuidField(body, 'paymentId');
      const amount = rawMoneyField(body, 'amount');
      const reason = rawStringField(body, 'reason');
      const requestedBy = rawOptionalStringField(body, 'requestedBy');

      // The lane's independent value guards (refund.ts:96-104), COLLECTED.
      // The requester defaults to the authenticated principal when the body
      // omits it — the transport's identity IS the requester.
      const refusals: AdjustmentRefusalView[] = [];
      if (reason.trim() === '') {
        refusals.push(refusalOf('REFUND_REASON_REQUIRED', 'a refund requires a reason (audit trail)', 'reason'));
      }
      const requester = requestedBy !== undefined && requestedBy !== '' ? requestedBy : principal.principalId;
      if (requester.trim() === '') {
        refusals.push(refusalOf('REFUND_REQUESTER_REQUIRED', 'a refund requires a requester', 'requestedBy'));
      }
      if (amount.minor <= 0) {
        refusals.push(refusalOf('REFUND_AMOUNT_INVALID', 'refund amount must be positive', 'amount.minor'));
      }
      if (refusals.length > 0) {
        return { status: 200, data: { intent: null, accepted: false, refusals } };
      }

      // Org-scoped payment lookup — an unknown (or foreign-org) payment
      // answers the payments surface's 404; existence never leaks.
      const payment = store.payments().find((p) => p.id === paymentId);
      if (!payment) {
        throw new DomainError(HTTP_PAYMENT_NOT_FOUND, `payment ${paymentId} does not exist`);
      }

      // The R6 ceiling from the payment snapshot — the payments lane's OWN
      // committed/unapplied math (confirmed − Σ allocations − Σ refunds,
      // clamped at zero; an unconfirmed payment has nothing landed → 0).
      const ceiling = unappliedMinorOf(payment);
      try {
        // The lane hard-enforces amount ≤ ceiling and throws the shared
        // money guard on cross-currency BEFORE the comparison can succeed
        // (refund.ts:105-113) — the refusal table's snapshot guards.
        const { refund } = requestRefund(
          {
            id: idGen() as Uuid,
            paymentId,
            amount: Money.ofMinor(amount.minor, amount.currency),
            reason: reason.trim(),
            requestedBy: requester,
          },
          ceiling,
          clock,
        );
        // An intent is a dry run: the proposed Requested refund is answered
        // as a value and NOTHING is written — not the payment's reservation
        // rows, not the lane's adjustment.refundRequested event (R3/R6).
        return { status: 200, data: { intent: refundIntentView(refund, ceiling), accepted: true, refusals: [] } };
      } catch (error) {
        if (error instanceof DomainError) {
          // CURRENCY_MISMATCH / REFUND_EXCEEDS_CEILING travel verbatim from
          // the lane — messages and details included — as refusal VALUES.
          const field = error.code === 'CURRENCY_MISMATCH' ? 'amount.currency' : 'amount';
          const details =
            error.details !== undefined && error.details !== null
              ? jsonSafeDetails(error.details as Record<string, unknown>)
              : undefined;
          return {
            status: 200,
            data: { intent: null, accepted: false, refusals: [refusalOf(error.code, error.message, field, details)] },
          };
        }
        throw error;
      }
    },
  };

  return [feedRoute, creditNoteIntentRoute, refundIntentRoute];
}
