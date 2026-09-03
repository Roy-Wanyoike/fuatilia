/**
 * Agent lane facts — the plain-data contracts the capability queries reason
 * over (issue #35, VISION §3.8 "expose capabilities, not CRUD").
 *
 * The repo has no DB layer by design: an AI agent (or human UI, or
 * integration) asks a business question, and Fuatilia answers WITH EVIDENCE
 * by reading plain-data facts the caller supplies. Nothing here writes fund
 * truth — every function in this lane is a read-only projection.
 *
 * Contract rules (lane README):
 *  - Facts are PLAIN DATA projected by the adapter from the owning lanes
 *    (receivables, payments, promises, disputes, adjustments, behavior).
 *    Cross-lane references are opaque `Uuid` ids — the agent lane never
 *    imports another lane.
 *  - Money is `bigint` minor units (house rule: floats are banned). Numbers
 *    are refused so no float can sneak into the money path.
 *  - Facts that reference entities not supplied (a dispute fact whose
 *    receivable is absent) are IGNORED — they belong to some other scope
 *    (same rule as src/domain/collections/derive.ts). Facts that carry a
 *    DIFFERENT orgId than the query are REFUSED — an agent must never be
 *    served a confident answer built from the wrong org's data.
 *  - Optional `evidenceIds` on any fact let the adapter attach the source
 *    event ids; they flow through into the answer's evidence so every claim
 *    resolves to supplied inputs (issue #35 acceptance).
 *  - Every malformed input throws DomainError with a stable AGENT_* code —
 *    never a silent default (house style: derive.ts, pause.ts).
 */
import { DomainError, CURRENCIES, type Clock, type Currency, type Uuid } from '../shared';

// ---------------------------------------------------------------------------
// Shapes — id/date/amount primitives
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validate a canonical-UUID id with a stable code (AGENT_ID_MALFORMED). */
export function assertUuidRef(value: unknown, field: string): Uuid {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError('AGENT_ID_MALFORMED', `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value as Uuid;
}

/** Validate an ISO-8601 timestamp with a stable code (AGENT_DATE_INVALID). */
export function assertIsoDate(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !ISO_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    throw new DomainError(
      'AGENT_DATE_INVALID',
      `${field} must be ISO-8601 (e.g. 2026-03-01T09:00:00.000Z), got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
}

/** Validate a money amount: bigint minor units, >= 0 (AGENT_AMOUNT_INVALID). */
export function assertMinorAmount(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new DomainError(
      'AGENT_AMOUNT_INVALID',
      `${field} must be a non-negative bigint in minor units (floats are banned), got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
}

/** Validate currency membership against the shared CURRENCIES list. */
export function assertCurrency(value: unknown, field: string): Currency {
  if (typeof value !== 'string' || !(CURRENCIES as readonly string[]).includes(value)) {
    throw new DomainError(
      'AGENT_CURRENCY_UNSUPPORTED',
      `${field} must be one of ${CURRENCIES.join(', ')}, got ${String(value)}`,
      { field, value: String(value), allowed: CURRENCIES },
    );
  }
  return value as Currency;
}

/**
 * Validate the injected Clock and return the ONE instant every caller reads
 * (house convention: an assert returns the parsed value, as assertUuidRef
 * returns Uuid). Taking the validated instant from the assert itself keeps a
 * capability query to a single clock read — derived fields on the same answer
 * (event occurredAt, payload timestamps) can never disagree. House style:
 * DISPUTE_CLOCK_INVALID et al.
 */
export function assertAgentClock(clock: Clock | undefined): Date {
  if (!clock || typeof clock.now !== 'function') {
    throw new DomainError('AGENT_CLOCK_INVALID', 'a Clock with a now() method is required');
  }
  const t = clock.now();
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) {
    throw new DomainError('AGENT_CLOCK_INVALID', 'clock.now() must return a valid Date');
  }
  return t;
}

/** Every fact is org-stamped so queries can refuse unknown-org data. */
const assertOrgId = (value: unknown): Uuid => assertUuidRef(value, 'orgId');

// ---------------------------------------------------------------------------
// Facts — plain-data projections of the owning lanes
// ---------------------------------------------------------------------------

/** Behavior flags the scoring vocabulary knows (F19 projects these). */
export const AGENT_FLAGS = Object.freeze([
  'slow_payer',
  'broken_promise',
  'disputed_history',
  'partial_payer',
  'unresponsive',
  'reliable_payer',
] as const);
export type AgentFlag = (typeof AGENT_FLAGS)[number];

/**
 * The transparent flag vocabulary with its fixed weights — points each flag
 * contributes to a receivable's priority score. Exported so callers and tests
 * can pin the exact numbers; unknown flags are refused (AGENT_FLAG_UNKNOWN),
 * never silently ignored.
 */
export const FLAG_WEIGHTS: Readonly<Record<AgentFlag, number>> = Object.freeze({
  slow_payer: 6,
  broken_promise: 8,
  disputed_history: 3,
  partial_payer: 4,
  unresponsive: 5,
  reliable_payer: -6,
});

/** Receivable states copied as plain data from the receivables lifecycle (docs/03). */
export const RECEIVABLE_STATES = Object.freeze([
  'draft',
  'open',
  'partially_paid',
  'settled',
  'written_off',
  'recovered',
  'uncollectible',
  'voided',
] as const);
export type ReceivableStateName = (typeof RECEIVABLE_STATES)[number];

/** States with a collectible balance — the only ones exposure/priorities count. */
export const OPEN_RECEIVABLE_STATES = Object.freeze(['open', 'partially_paid'] as const);
export type OpenReceivableState = (typeof OPEN_RECEIVABLE_STATES)[number];

export interface CustomerFact {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** C4 credit balance parked on the customer (adjustments lane), minor units. */
  readonly creditBalanceMinor?: bigint;
  /** Required whenever creditBalanceMinor is supplied — credit is per-currency (R10). */
  readonly creditCurrency?: Currency;
  /** Behavior flags (opaque to this lane; validated against the vocabulary). */
  readonly flags?: readonly string[];
  /** Optional source ids (event ids etc.) — flow into answer evidence. */
  readonly evidenceIds?: readonly Uuid[];
}

export interface ReceivableFact {
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly invoiceId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  readonly originalMinor: bigint;
  /** Σ allocations applied so far (R1: balance = original − paid, never negative). */
  readonly paidMinor: bigint;
  readonly state: ReceivableStateName;
  /** ISO-8601 — the due date aging is computed against. */
  readonly dueDate: string;
  /** Stored overdue flag if the adapter has it; aging is derived either way. */
  readonly overdue?: boolean;
  readonly evidenceIds?: readonly Uuid[];
}

export interface PaymentFact {
  readonly orgId: Uuid;
  readonly paymentId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  /** Money that landed (the adapter projects the payments lane's confirmed family). */
  readonly amountMinor: bigint;
  /** ISO-8601 — when the money landed. */
  readonly receivedAt: string;
  /** Σ allocated to receivables so far; defaults to amountMinor (fully allocated). */
  readonly allocatedMinor?: bigint;
  readonly evidenceIds?: readonly Uuid[];
}

export interface PromiseFact {
  readonly orgId: Uuid;
  readonly promiseId: Uuid;
  readonly receivableId: Uuid;
  /** Same statuses the collections lane's derive facts use. */
  readonly status: 'pending' | 'fulfilled' | 'broken';
  /** ISO-8601, optional — the date the customer committed to pay by. */
  readonly promisedDate?: string;
  readonly amountMinor?: bigint;
  readonly evidenceIds?: readonly Uuid[];
}

export interface DisputeFact {
  readonly orgId: Uuid;
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  /** Is the dispute live right now (projected from the disputes lane's status)? */
  readonly open: boolean;
  /** Opaque passthrough (pricing | quality | …) — never interpreted here. */
  readonly category?: string;
  readonly openedAt?: string;
  readonly evidenceIds?: readonly Uuid[];
}

// ---------------------------------------------------------------------------
// Fact validation — every malformed field refuses with a stable AGENT_* code
// ---------------------------------------------------------------------------

const assertFlags = (flags: readonly string[] | undefined, field: string): readonly string[] => {
  if (flags === undefined) return [];
  if (!Array.isArray(flags)) {
    throw new DomainError('AGENT_FLAG_UNKNOWN', `${field} must be an array of flag strings`);
  }
  return flags.map((flag) => {
    if (typeof flag !== 'string' || !(AGENT_FLAGS as readonly string[]).includes(flag)) {
      throw new DomainError(
        'AGENT_FLAG_UNKNOWN',
        `unknown behavior flag ${String(flag)} — known flags: ${AGENT_FLAGS.join(', ')}`,
        { flag: String(flag), allowed: AGENT_FLAGS },
      );
    }
    return flag;
  });
};

const assertEvidenceIds = (evidenceIds: readonly Uuid[] | undefined, field: string): readonly Uuid[] => {
  if (evidenceIds === undefined) return [];
  if (!Array.isArray(evidenceIds)) {
    throw new DomainError('AGENT_ID_MALFORMED', `${field} must be an array of UUIDs`);
  }
  return evidenceIds.map((id) => assertUuidRef(id, field));
};

const assertOptionalMinor = (value: bigint | undefined, field: string): bigint | undefined =>
  value === undefined ? undefined : assertMinorAmount(value, field);

const assertOptionalDate = (value: string | undefined, field: string): string | undefined =>
  value === undefined ? undefined : assertIsoDate(value, field);

export function assertCustomerFact(fact: CustomerFact): CustomerFact {
  assertOrgId(fact.orgId);
  assertUuidRef(fact.customerId, 'customerId');
  const hasAmount = fact.creditBalanceMinor !== undefined;
  const hasCurrency = fact.creditCurrency !== undefined;
  if (hasAmount !== hasCurrency) {
    throw new DomainError(
      'AGENT_CREDIT_FACT_INVALID',
      'a customer credit balance requires BOTH creditBalanceMinor and creditCurrency',
      { customerId: fact.customerId },
    );
  }
  if (fact.creditBalanceMinor !== undefined) assertMinorAmount(fact.creditBalanceMinor, 'creditBalanceMinor');
  if (fact.creditCurrency !== undefined) assertCurrency(fact.creditCurrency, 'creditCurrency');
  assertFlags(fact.flags, 'customer.flags');
  assertEvidenceIds(fact.evidenceIds, 'customer.evidenceIds');
  return fact;
}

export function assertReceivableFact(fact: ReceivableFact): ReceivableFact {
  assertOrgId(fact.orgId);
  assertUuidRef(fact.receivableId, 'receivableId');
  assertUuidRef(fact.invoiceId, 'invoiceId');
  assertUuidRef(fact.customerId, 'customerId');
  assertCurrency(fact.currency, 'receivable.currency');
  assertMinorAmount(fact.originalMinor, 'originalMinor');
  assertMinorAmount(fact.paidMinor, 'paidMinor');
  if (fact.paidMinor > fact.originalMinor) {
    throw new DomainError(
      'AGENT_BALANCE_INVALID',
      `receivable ${fact.receivableId} paid ${fact.paidMinor} exceeds original ${fact.originalMinor} (R1: balance never negative)`,
      { receivableId: fact.receivableId },
    );
  }
  if (!(RECEIVABLE_STATES as readonly string[]).includes(fact.state)) {
    throw new DomainError(
      'AGENT_RECEIVABLE_STATE_INVALID',
      `unknown receivable state ${String(fact.state)} — known: ${RECEIVABLE_STATES.join(', ')}`,
      { receivableId: fact.receivableId, state: String(fact.state), allowed: RECEIVABLE_STATES },
    );
  }
  assertIsoDate(fact.dueDate, 'dueDate');
  if (fact.overdue !== undefined && typeof fact.overdue !== 'boolean') {
    throw new DomainError('AGENT_RECEIVABLE_STATE_INVALID', 'overdue must be a boolean when supplied', {
      receivableId: fact.receivableId,
    });
  }
  assertEvidenceIds(fact.evidenceIds, 'receivable.evidenceIds');
  return fact;
}

export function assertPaymentFact(fact: PaymentFact): PaymentFact {
  assertOrgId(fact.orgId);
  assertUuidRef(fact.paymentId, 'paymentId');
  assertUuidRef(fact.customerId, 'customerId');
  assertCurrency(fact.currency, 'payment.currency');
  assertMinorAmount(fact.amountMinor, 'amountMinor');
  assertIsoDate(fact.receivedAt, 'receivedAt');
  const allocated = assertOptionalMinor(fact.allocatedMinor, 'allocatedMinor');
  if (allocated !== undefined && allocated > fact.amountMinor) {
    throw new DomainError(
      'AGENT_ALLOCATION_INVALID',
      `payment ${fact.paymentId} allocated ${allocated} exceeds its amount ${fact.amountMinor} (R2: no over-allocation)`,
      { paymentId: fact.paymentId },
    );
  }
  assertEvidenceIds(fact.evidenceIds, 'payment.evidenceIds');
  return fact;
}

export function assertPromiseFact(fact: PromiseFact): PromiseFact {
  assertOrgId(fact.orgId);
  assertUuidRef(fact.promiseId, 'promiseId');
  assertUuidRef(fact.receivableId, 'receivableId');
  if (!(['pending', 'fulfilled', 'broken'] as readonly string[]).includes(fact.status)) {
    throw new DomainError(
      'AGENT_PROMISE_STATUS_INVALID',
      `unknown promise status ${String(fact.status)} — known: pending, fulfilled, broken`,
      { promiseId: fact.promiseId, status: String(fact.status) },
    );
  }
  assertOptionalDate(fact.promisedDate, 'promisedDate');
  assertOptionalMinor(fact.amountMinor, 'amountMinor');
  assertEvidenceIds(fact.evidenceIds, 'promise.evidenceIds');
  return fact;
}

export function assertDisputeFact(fact: DisputeFact): DisputeFact {
  assertOrgId(fact.orgId);
  assertUuidRef(fact.disputeId, 'disputeId');
  assertUuidRef(fact.receivableId, 'receivableId');
  if (typeof fact.open !== 'boolean') {
    throw new DomainError('AGENT_DISPUTE_FACT_INVALID', 'a dispute fact requires a boolean open flag', {
      disputeId: fact.disputeId,
      open: fact.open,
    });
  }
  assertOptionalDate(fact.openedAt, 'openedAt');
  assertEvidenceIds(fact.evidenceIds, 'dispute.evidenceIds');
  return fact;
}

// ---------------------------------------------------------------------------
// Aging — same whole-day, floor-at-zero semantics as the receivables lane
// ---------------------------------------------------------------------------

export const AGE_BUCKETS = Object.freeze(['0-30', '31-60', '61-90', '90+'] as const);
export type AgeBucket = (typeof AGE_BUCKETS)[number];

const DAY_MS = 86_400_000;

/**
 * Whole days past the due date at `now`, floored (a partial late day is not a
 * full late day) and clamped at 0 — receivables not yet due are age 0.
 */
export const ageDaysOf = (dueDateIso: string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(dueDateIso).getTime()) / DAY_MS));

/** Boundary semantics identical to the receivables lane: day 30 → '0-30', 31 → '31-60', 90 → '61-90', 91 → '90+'. */
export const ageBucketOf = (ageDays: number): AgeBucket => {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
};
