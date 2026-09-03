/**
 * Plain-data fact contracts for the projections lane (wave 4, issue #24).
 *
 * The intelligence layer NEVER owns fund truth (README design principle 2):
 * every function here is a pure, read-only projection over PLAIN DATA the
 * caller supplies. Cross-lane entities (receivables, customers, disputes,
 * promises) are referenced by opaque `Uuid` ids only — this lane never
 * imports another lane's types. Facts are wire-shaped (ISO dates, minor
 * units as bigint/safe numbers) so adapters can project them straight from
 * an event store or a query without re-wrapping aggregates.
 *
 * All amounts are non-negative integers in MINOR UNITS (bigint discipline,
 * docs/07 R10): parsing goes through Money-safe guards and all arithmetic
 * downstream uses `Money`, so float drift is structurally impossible.
 */
import { DomainError, CURRENCIES, Money, type Clock, type Currency, type Uuid } from '../shared';

// ---------------------------------------------------------------------------
// Receivable fact (aging + cash-collection projections)
// ---------------------------------------------------------------------------

/** Plain-data receivable fact, projected by the adapter from the receivables lane. */
export interface ReceivableFact {
  readonly receivableId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  /** Outstanding (unpaid) balance in minor units — bigint or safe integer. */
  readonly balanceMinor: bigint | number;
  /** ISO-8601 date (`YYYY-MM-DD`) or timestamp (`...Z|±hh:mm`) the payment was due. */
  readonly dueDate: string | Date;
  /**
   * An OPEN dispute exists on this receivable (SPEC §29 pause). Disputed
   * receivables are excluded from collection projections entirely — no
   * automated pursuit while the dispute is live.
   */
  readonly disputed?: boolean;
}

/** A receivable fact validated + normalized for arithmetic (internal contract). */
export interface ParsedReceivable {
  readonly receivableId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  readonly balance: Money;
  readonly dueTime: number; // epoch ms
  readonly disputed: boolean;
}

// ---------------------------------------------------------------------------
// Behavior fact (cash-collection projections)
// ---------------------------------------------------------------------------

/**
 * Plain-data payment-behavior fact per customer, projected by the adapter
 * from collected history (the behavior/memory lanes). Absence of a fact for
 * a customer is legal — the projection then assumes the documented default
 * propensity and SAYS SO in its assumptions list.
 */
export interface BehaviorFact {
  readonly customerId: Uuid;
  /**
   * Share (0..1) of this customer's billed amounts historically collected
   * within a comparable horizon — the transparent basis of every band.
   */
  readonly collectionPropensity: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (stable PROJ_* codes; shapes validated, ids opaque)
// ---------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Full timestamp REQUIRES an explicit zone (Z or ±hh:mm) — local-time parsing is environment-dependent, i.e. non-deterministic. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Validates an opaque Uuid-shaped id (canonical 8-4-4-4-12 hex). */
export function assertUuidShape(value: unknown, code: string, field: string): Uuid {
  if (typeof value !== 'string' || !UUID_SHAPE.test(value)) {
    throw new DomainError(code, `${field} must be a UUID-shaped id, got ${String(value)}`, { field });
  }
  return value as Uuid;
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: unknown, code: string): Currency {
  if (!isCurrency(value)) {
    throw new DomainError(code, `currency must be one of ${CURRENCIES.join('|')}, got ${String(value)}`);
  }
  return value;
}

/**
 * Parses an ISO-8601 date (`YYYY-MM-DD`, UTC midnight) or full timestamp
 * (explicit zone required) into epoch ms. Accepts an already-materialized
 * `Date` (e.g. from an injected Clock). Deterministic: local-time strings
 * are refused, never guessed.
 */
export function parseInstant(value: Date | string, code: string, field: string): number {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new DomainError(code, `${field} is an invalid Date`, { field });
    }
    return value.getTime();
  }
  if (typeof value === 'string' && (ISO_DATE_ONLY.test(value) || ISO_TIMESTAMP.test(value))) {
    const time = new Date(value).getTime();
    if (!Number.isNaN(time)) return time;
  }
  throw new DomainError(
    code,
    `${field} must be an ISO-8601 date (YYYY-MM-DD) or zoned timestamp, got ${String(value)}`,
    { field, value: String(value) },
  );
}

/** Non-negative integer amount in minor units → bigint (Money-safe input gate). */
export function parseMinorAmount(value: unknown, code: string, field: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new DomainError(code, `${field} must be a non-negative amount in minor units, got ${value}`, { field });
    }
    return value;
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new DomainError(
    code,
    `${field} must be a non-negative integer amount in minor units (bigint or integer number), got ${String(value)}`,
    { field },
  );
}

/** Validates a Clock by using it — an invalid `now()` is refused, never defaulted (no wall-clock reads in the core). */
export function nowMs(clock: Clock, code: string): number {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError(code, 'clock.now() must return a valid Date', { now: String(now) });
  }
  return now.getTime();
}

/**
 * Validates + normalizes receivable facts: shape gate (ids, currency,
 * balance, dueDate, disputed), duplicate detection. Order is preserved —
 * deterministic outputs depend on deterministic input order.
 */
export function parseReceivableFacts(receivables: readonly ReceivableFact[]): readonly ParsedReceivable[] {
  const seen = new Set<Uuid>();
  return receivables.map((fact, index) => {
    const where = `receivables[${index}]`;
    const receivableId = assertUuidShape(fact.receivableId, 'PROJ_RECEIVABLE_INVALID', `${where}.receivableId`);
    if (seen.has(receivableId)) {
      throw new DomainError('PROJ_RECEIVABLE_DUPLICATE', `duplicate receivableId ${receivableId}`, {
        receivableId,
      });
    }
    seen.add(receivableId);
    const customerId = assertUuidShape(fact.customerId, 'PROJ_RECEIVABLE_INVALID', `${where}.customerId`);
    const currency = assertCurrency(fact.currency, 'PROJ_CURRENCY_INVALID');
    const balanceMinor = parseMinorAmount(fact.balanceMinor, 'PROJ_BALANCE_INVALID', `${where}.balanceMinor`);
    const dueTime = parseInstant(fact.dueDate, 'PROJ_DUE_DATE_INVALID', `${where}.dueDate`);
    if (fact.disputed !== undefined && typeof fact.disputed !== 'boolean') {
      throw new DomainError(
        'PROJ_RECEIVABLE_INVALID',
        `${where}.disputed must be a boolean, got ${String(fact.disputed)}`,
        { field: `${where}.disputed` },
      );
    }
    return {
      receivableId,
      customerId,
      currency,
      balance: Money.ofMinor(balanceMinor, currency),
      dueTime,
      disputed: fact.disputed === true,
    };
  });
}

/** Validates + indexes behavior facts by customer (duplicates refused). */
export function parseBehaviorFacts(facts: readonly BehaviorFact[]): ReadonlyMap<Uuid, BehaviorFact> {
  const byCustomer = new Map<Uuid, BehaviorFact>();
  for (const [index, fact] of facts.entries()) {
    const where = `behaviorFacts[${index}]`;
    const customerId = assertUuidShape(fact.customerId, 'PROJ_BEHAVIOR_FACT_INVALID', `${where}.customerId`);
    if (byCustomer.has(customerId)) {
      throw new DomainError('PROJ_BEHAVIOR_FACT_DUPLICATE', `duplicate behavior fact for customer ${customerId}`, {
        customerId,
      });
    }
    const propensity = fact.collectionPropensity;
    if (typeof propensity !== 'number' || !Number.isFinite(propensity) || propensity < 0 || propensity > 1) {
      throw new DomainError(
        'PROJ_PROPENSITY_INVALID',
        `${where}.collectionPropensity must be a number in [0, 1], got ${String(propensity)}`,
        { customerId },
      );
    }
    byCustomer.set(customerId, fact);
  }
  return byCustomer;
}
