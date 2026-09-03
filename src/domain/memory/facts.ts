/**
 * Memory facts — the normalized, event-derived plain-data input shape of the
 * financial memory lane (issue #37, VISION §3.3/§3.7).
 *
 * Financial Events → Normalized Facts → Customer Financial Memory:
 * the caller (an adapter or projection job) reduces raw lane events into
 * THESE facts and hands them over as plain data. This lane owns the fact
 * vocabulary — no other lane's types are imported; every id (eventId,
 * invoiceId, receivableId, promiseId, disputeId, customerId, paymentId) is an
 * opaque Uuid and every fact is a frozen-in-time plain record:
 *
 *   { eventId, type, at (ISO-8601), customerId, …type payload }
 *
 * `eventId` is the EVIDENCE ANCHOR: every claim this lane produces lists the
 * eventIds it was computed from, so any number can be traced back to the
 * supplied inputs (VISION §3.7 — explainable, not a vector dump).
 *
 * Fact vocabulary (v1):
 *   invoice_issued     { invoiceId, currency, totalMinor }
 *   payment_received   { paymentId, invoiceId?, currency, amountMinor }
 *   allocation_applied { receivableId, currency, amountMinor }
 *   receivable_opened  { receivableId, currency, amountMinor, dueDate }
 *   receivable_settled { receivableId }
 *   promise_outcome    { promiseId, outcome: kept | broken | expired }
 *   message_exchanged  { channel, direction: inbound | outbound }
 *   consent_changed    { channel, status: granted | revoked }
 *   dispute_opened     { disputeId, receivableId? }
 *   dispute_resolved   { disputeId }
 *
 * Ids are UUID-SHAPED opaque ids (canonical 8-4-4-4-12 hex — the house gate,
 * same discipline as the events envelope and the behavior/projections lanes);
 * channel names are the one free-form field (non-blank string, as used by the
 * comms lanes). Purity: data in → data out. No I/O, no RNG, no Date.now() —
 * the only time input is the ISO strings on the facts and the caller's `asOf`.
 */
import { CURRENCIES, DomainError, type Currency, type Uuid } from '../shared';

export const MEMORY_FACT_TYPES = [
  'invoice_issued',
  'payment_received',
  'allocation_applied',
  'receivable_opened',
  'receivable_settled',
  'promise_outcome',
  'message_exchanged',
  'consent_changed',
  'dispute_opened',
  'dispute_resolved',
] as const;
export type MemoryFactType = (typeof MEMORY_FACT_TYPES)[number];

export const PROMISE_OUTCOMES = ['kept', 'broken', 'expired'] as const;
export type PromiseOutcome = (typeof PROMISE_OUTCOMES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const CONSENT_CHANGE_STATUSES = ['granted', 'revoked'] as const;
export type ConsentChangeStatus = (typeof CONSENT_CHANGE_STATUSES)[number];

/** Whole days live in UTC-day arithmetic — deterministic, no DST surprises. */
export const DAY_MS = 86_400_000;

/** ISO-8601 with UTC offset (the repo envelope contract for timestamps). */
export const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Canonical Uuid shape (8-4-4-4-12 hex) — evidence anchors must be unambiguous. */
export const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Fields shared by every fact: the evidence anchor, the subject, the when. */
export interface MemoryFactBase {
  /** Evidence anchor — the upstream lane event this fact was derived from. */
  readonly eventId: Uuid;
  /** Opaque customer id — the memory lane never dereferences it. */
  readonly customerId: Uuid;
  /** ISO-8601 — when the upstream event happened (not when it was projected). */
  readonly at: string;
}

export interface InvoiceIssuedFact extends MemoryFactBase {
  readonly type: 'invoice_issued';
  readonly invoiceId: Uuid;
  readonly currency: Currency;
  readonly totalMinor: number;
}

export interface PaymentReceivedFact extends MemoryFactBase {
  readonly type: 'payment_received';
  readonly paymentId: Uuid;
  /** Links the payment to its invoice for days-to-pay; null when unallocated. */
  readonly invoiceId?: Uuid | null;
  readonly currency: Currency;
  readonly amountMinor: number;
}

export interface AllocationAppliedFact extends MemoryFactBase {
  readonly type: 'allocation_applied';
  readonly receivableId: Uuid;
  readonly currency: Currency;
  readonly amountMinor: number;
}

export interface ReceivableOpenedFact extends MemoryFactBase {
  readonly type: 'receivable_opened';
  readonly receivableId: Uuid;
  readonly currency: Currency;
  readonly amountMinor: number;
  /** ISO-8601 — the aging clock runs from the due date. */
  readonly dueDate: string;
}

export interface ReceivableSettledFact extends MemoryFactBase {
  readonly type: 'receivable_settled';
  readonly receivableId: Uuid;
}

export interface PromiseOutcomeFact extends MemoryFactBase {
  readonly type: 'promise_outcome';
  readonly promiseId: Uuid;
  readonly outcome: PromiseOutcome;
}

export interface MessageExchangedFact extends MemoryFactBase {
  readonly type: 'message_exchanged';
  /** Free-form channel name as used by the comms lanes (e.g. 'whatsapp'). */
  readonly channel: string;
  readonly direction: MessageDirection;
}

export interface ConsentChangedFact extends MemoryFactBase {
  readonly type: 'consent_changed';
  readonly channel: string;
  readonly status: ConsentChangeStatus;
}

export interface DisputeOpenedFact extends MemoryFactBase {
  readonly type: 'dispute_opened';
  readonly disputeId: Uuid;
  readonly receivableId?: Uuid | null;
}

export interface DisputeResolvedFact extends MemoryFactBase {
  readonly type: 'dispute_resolved';
  readonly disputeId: Uuid;
}

export type MemoryFact =
  | InvoiceIssuedFact
  | PaymentReceivedFact
  | AllocationAppliedFact
  | ReceivableOpenedFact
  | ReceivableSettledFact
  | PromiseOutcomeFact
  | MessageExchangedFact
  | ConsentChangedFact
  | DisputeOpenedFact
  | DisputeResolvedFact;

// --- validation (stable MEM_* codes) -------------------------------------------

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const isIsoDate = (value: unknown): value is string =>
  isNonBlank(value) && ISO_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime());

const isSafeAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isCurrency = (value: unknown): value is Currency =>
  (CURRENCIES as readonly string[]).includes(value as string);

const fail = (index: number, field: string, why: string): DomainError =>
  new DomainError('MEM_FACT_INVALID', `facts[${index}].${field}: ${why}`, { index, field });

/** Opaque ids are UUID-shaped — a malformed evidence anchor breaks traceability. */
const assertId = (value: unknown, index: number, field: string): void => {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw fail(index, field, `expected a UUID-shaped id (8-4-4-4-12 hex), got ${String(value)}`);
  }
};

/** Optional id: absent (undefined/null) or a UUID-shaped id. */
const assertOptionalId = (value: unknown, index: number, field: string): void => {
  if (value === undefined || value === null) return;
  assertId(value, index, field);
};

/** Channel names are free-form (comms-lane vocabulary) — only non-blank is enforced. */
const assertChannel = (value: unknown, index: number, field: string): void => {
  if (!isNonBlank(value)) {
    throw fail(index, field, `expected a non-blank channel name, got ${String(value)}`);
  }
};

const assertAmount = (value: unknown, index: number, field: string): void => {
  if (!isSafeAmount(value)) {
    throw fail(index, field, `expected a safe non-negative integer (minor units), got ${String(value)}`);
  }
};

const assertCurrency = (value: unknown, index: number, field: string): void => {
  if (!isCurrency(value)) {
    throw new DomainError(
      'MEM_CURRENCY_INVALID',
      `facts[${index}].${field}: unknown currency ${String(value)} — allowed: ${CURRENCIES.join(', ')}`,
      { index, field, currency: String(value) },
    );
  }
};

const assertEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  index: number,
  field: string,
): void => {
  if (!(allowed as readonly string[]).includes(value as string)) {
    throw fail(index, field, `expected one of ${allowed.join(' | ')}, got ${String(value)}`);
  }
};

/**
 * Validate a fact history — the gate every memory computation runs first.
 *
 * Throws:
 *   - MEM_FACT_REQUIRED — facts is not an array;
 *   - MEM_FACT_UNKNOWN_TYPE — a fact carries a type outside the v1 vocabulary;
 *   - MEM_FACT_DUPLICATE_EVENT_ID — the same eventId appears twice (evidence
 *     anchors must be unique or claims are not traceable);
 *   - MEM_FACT_INVALID — a fact field is malformed (details carry
 *     `{ index, field }` so the caller can pinpoint the record);
 *   - MEM_CURRENCY_INVALID — an unknown currency code.
 *
 * Pure: never mutates the input array.
 */
export function assertMemoryFacts(facts: readonly MemoryFact[]): void {
  if (!Array.isArray(facts)) {
    throw new DomainError('MEM_FACT_REQUIRED', 'facts must be an array of memory facts');
  }
  const seenEventIds = new Set<string>();
  facts.forEach((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw fail(index, '(root)', 'fact must be a plain object');
    }
    const fact = raw as MemoryFact;
    if (typeof fact.type !== 'string' || !(MEMORY_FACT_TYPES as readonly string[]).includes(fact.type)) {
      throw new DomainError(
        'MEM_FACT_UNKNOWN_TYPE',
        `facts[${index}].type: unknown memory fact type ${String(fact.type)} — allowed: ${MEMORY_FACT_TYPES.join(', ')}`,
        { index, type: String(fact.type) },
      );
    }
    assertId(fact.eventId, index, 'eventId');
    if (seenEventIds.has(fact.eventId)) {
      throw new DomainError(
        'MEM_FACT_DUPLICATE_EVENT_ID',
        `facts[${index}].eventId: evidence anchor ${fact.eventId} appears more than once`,
        { index, eventId: fact.eventId },
      );
    }
    seenEventIds.add(fact.eventId);
    assertId(fact.customerId, index, 'customerId');
    if (!isIsoDate(fact.at)) {
      throw fail(index, 'at', `expected ISO-8601 (e.g. 2026-03-02T08:00:00.000Z), got ${String(fact.at)}`);
    }

    switch (fact.type) {
      case 'invoice_issued':
        assertId(fact.invoiceId, index, 'invoiceId');
        assertCurrency(fact.currency, index, 'currency');
        assertAmount(fact.totalMinor, index, 'totalMinor');
        break;
      case 'payment_received':
        assertId(fact.paymentId, index, 'paymentId');
        assertOptionalId(fact.invoiceId, index, 'invoiceId');
        assertCurrency(fact.currency, index, 'currency');
        assertAmount(fact.amountMinor, index, 'amountMinor');
        break;
      case 'allocation_applied':
        assertId(fact.receivableId, index, 'receivableId');
        assertCurrency(fact.currency, index, 'currency');
        assertAmount(fact.amountMinor, index, 'amountMinor');
        break;
      case 'receivable_opened':
        assertId(fact.receivableId, index, 'receivableId');
        assertCurrency(fact.currency, index, 'currency');
        assertAmount(fact.amountMinor, index, 'amountMinor');
        if (!isIsoDate(fact.dueDate)) {
          throw fail(index, 'dueDate', `expected ISO-8601, got ${String(fact.dueDate)}`);
        }
        break;
      case 'receivable_settled':
        assertId(fact.receivableId, index, 'receivableId');
        break;
      case 'promise_outcome':
        assertId(fact.promiseId, index, 'promiseId');
        assertEnum(fact.outcome, PROMISE_OUTCOMES, index, 'outcome');
        break;
      case 'message_exchanged':
        assertChannel(fact.channel, index, 'channel');
        assertEnum(fact.direction, MESSAGE_DIRECTIONS, index, 'direction');
        break;
      case 'consent_changed':
        assertChannel(fact.channel, index, 'channel');
        assertEnum(fact.status, CONSENT_CHANGE_STATUSES, index, 'status');
        break;
      case 'dispute_opened':
        assertId(fact.disputeId, index, 'disputeId');
        assertOptionalId(fact.receivableId, index, 'receivableId');
        break;
      case 'dispute_resolved':
        assertId(fact.disputeId, index, 'disputeId');
        break;
    }
  });
}

/** ISO-8601 check shared with the snapshot's `asOf` gate. */
export const isIsoTimestamp = (value: unknown): value is string => isIsoDate(value);

/** Deterministic UTC-day distance, clamped at 0 (a partial day is not a day). */
export const wholeDaysBetween = (fromIso: string, toIso: string): number =>
  Math.max(0, Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS));
