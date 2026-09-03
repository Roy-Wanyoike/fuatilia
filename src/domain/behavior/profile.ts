/**
 * Behavior profile — the point-in-time customer behavior snapshot (F19,
 * issue #26, SPEC §4 "Customer Payment Behavior Engine"; the foundation of
 * VISION §3.3 "customer financial memory").
 *
 * `buildBehaviorProfile(orgId, customerId, facts, asOf)` reduces PLAIN-DATA
 * fact histories (projected by the adapter from other lanes' event streams)
 * into one explainable snapshot. The lane never imports other lanes:
 * cross-lane ids are opaque `Uuid`s and callers pass facts.
 *
 * Fact inputs (all optional; empty history ⇒ a valid, claim-less profile):
 *
 *   payments       settledAt vs dueDate        → cadence stats (integer
 *                  (ISO-8601 strings)            UTC-day arithmetic)
 *   promises       outcome kept|broken|expired → reliability counts + rate
 *                  |pending, resolvedAt
 *   disputes       openedAt / resolvedAt       → counts + currentlyOpen
 *   communications channel/direction/sentAt    → inbound vs outbound per channel
 *   allocations    allocatedAt/amountMinor     → how money was applied
 *
 * Explainability is a hard requirement (H7): EVERY metric block carries
 * `evidence` — the source aggregate ids that produced the numbers — so F23
 * ("explainable financial memory") can trace any claim back to events.
 *
 * Point-in-time semantics: only facts observed at or before `asOf` count
 * (payments settled, promises decided, disputes opened, messages sent,
 * allocations made); later facts are invisible to the snapshot. This is what
 * makes before/after drift comparison (./drift.ts) well-defined.
 *
 * Determinism: pure function of (facts, asOf) — no wall clock, no RNG;
 * identical inputs build identical (deep-frozen, immutable) profiles.
 */
import { DomainError, type Uuid } from '../shared';

// ---------------------------------------------------------------------------
// Evidence — the explainability contract (H7)
// ---------------------------------------------------------------------------

/** The fact kinds this lane consumes (the projection surface for adapters). */
export const BEHAVIOR_FACT_KINDS = ['payment', 'promise', 'dispute', 'communication', 'allocation'] as const;
export type BehaviorFactKind = (typeof BEHAVIOR_FACT_KINDS)[number];

/**
 * A pointer to the source aggregate/event an observation came from. Claims
 * are never bare numbers: every dimension of the profile lists the refs it
 * was computed from (kind + opaque id — never dereferenced in this lane).
 */
export interface EvidenceRef {
  readonly kind: BehaviorFactKind;
  readonly id: string;
}

// ---------------------------------------------------------------------------
// Fact inputs — plain data, projected by the adapter from other lanes
// ---------------------------------------------------------------------------

/**
 * A settled payment anchored to its receivable's due date. `partial` is the
 * adapter's verdict that the payment settled less than the amount due at the
 * time (feeds the partial-payment pattern detector).
 */
export interface PaymentFact {
  readonly paymentId: Uuid;
  readonly receivableId: Uuid;
  /** Positive safe integer, minor units. */
  readonly amountMinor: number;
  /** ISO-8601 — the due date the payment is measured against. */
  readonly dueDate: string;
  /** ISO-8601 — when the payment settled (cadence = settledAt − dueDate). */
  readonly settledAt: string;
  readonly partial: boolean;
}

export type PromiseOutcome = 'kept' | 'broken' | 'expired' | 'pending';

/**
 * A promise-to-pay with its outcome (the promises lane's `fulfilled` maps to
 * `kept` at the adapter). Decided outcomes carry `resolvedAt`; `pending`
 * carries `null` — the pair is validated.
 */
export interface PromiseFact {
  readonly promiseId: Uuid;
  readonly receivableId: Uuid;
  /** ISO-8601 — the date the customer committed to pay by. */
  readonly promisedDate: string;
  readonly outcome: PromiseOutcome;
  /** ISO-8601 when decided (kept/broken/expired); null while pending. */
  readonly resolvedAt: string | null;
}

/** A dispute, open or resolved (resolvedAt null while live). */
export interface DisputeFact {
  readonly disputeId: Uuid;
  readonly receivableId: Uuid;
  /** ISO-8601 */
  readonly openedAt: string;
  /** ISO-8601 once resolved; null while open. */
  readonly resolvedAt: string | null;
}

/** One message on one channel. Channels are opaque strings (adapter's taxonomy). */
export interface CommunicationFact {
  readonly messageId: Uuid;
  readonly channel: string;
  readonly direction: 'inbound' | 'outbound';
  /** ISO-8601 */
  readonly sentAt: string;
}

/** Money applied to a receivable (the allocation lane's settlement fact). */
export interface AllocationFact {
  readonly allocationId: Uuid;
  readonly paymentId: Uuid;
  readonly receivableId: Uuid;
  /** Positive safe integer, minor units. */
  readonly amountMinor: number;
  /** ISO-8601 */
  readonly allocatedAt: string;
}

/** The full fact bundle for one customer — every array optional. */
export interface BehaviorFacts {
  readonly payments?: readonly PaymentFact[];
  readonly promises?: readonly PromiseFact[];
  readonly disputes?: readonly DisputeFact[];
  readonly communications?: readonly CommunicationFact[];
  readonly allocations?: readonly AllocationFact[];
}

// ---------------------------------------------------------------------------
// Profile output — frozen, evidence-backed, extensible (F23 layers on top)
// ---------------------------------------------------------------------------

/**
 * Payment cadence statistics over integer UTC days from due date to
 * settlement (negative = paid early). `median` of an even count is the mean
 * of the two middle values (may end in .5); `p90DaysToPay` uses R-7 linear
 * interpolation between closest ranks. `null` stats mean "no settled
 * payments yet" — never fabricate a number.
 */
export interface PaymentCadenceStats {
  readonly count: number;
  readonly minDaysToPay: number | null;
  readonly medianDaysToPay: number | null;
  readonly p90DaysToPay: number | null;
  /** Settled on or before the due date (days-to-pay ≤ 0). */
  readonly onTimeCount: number;
  /** Settled after the due date (days-to-pay > 0). */
  readonly lateCount: number;
  /** Payments the adapter flagged as partial. */
  readonly partialCount: number;
  readonly evidence: readonly EvidenceRef[];
}

/** Promise reliability: counts of decided promises + the kept share. */
export interface PromiseReliability {
  readonly keptCount: number;
  readonly brokenCount: number;
  readonly expiredCount: number;
  /** Promises undecided as of the snapshot (incl. decided-later ones). */
  readonly pendingCount: number;
  readonly decidedCount: number;
  /** kept / decided; null when no promise has been decided yet. */
  readonly reliabilityRate: number | null;
  readonly evidence: readonly EvidenceRef[];
}

/** Dispute history as of the snapshot. */
export interface DisputeHistory {
  readonly totalCount: number;
  readonly resolvedCount: number;
  /** Disputes still open at `asOf` (opened ≤ asOf, not resolved by then). */
  readonly openCount: number;
  readonly currentlyOpen: boolean;
  readonly evidence: readonly EvidenceRef[];
}

/** Inbound vs outbound message counts per channel (channels sorted a→z). */
export interface ChannelResponsiveness {
  readonly channel: string;
  readonly inbound: number;
  readonly outbound: number;
}

export interface CommunicationResponsiveness {
  readonly byChannel: readonly ChannelResponsiveness[];
  readonly inboundTotal: number;
  readonly outboundTotal: number;
  /**
   * inbound / (inbound + outbound) — the customer-initiated share of the
   * conversation; null when no messages exist. The drift engine reads this
   * as "responsiveness".
   */
  readonly responseRate: number | null;
  readonly evidence: readonly EvidenceRef[];
}

/** How money actually reached receivables. */
export interface AllocationSummary {
  readonly count: number;
  /** Σ amounts in minor units (safe-integer guarded). */
  readonly totalAmountMinor: number;
  readonly evidence: readonly EvidenceRef[];
}

/**
 * The point-in-time behavior profile. Plain-data and extensible: wave-5 F23
 * layers further claims on WITHOUT breaking this shape (additive fields).
 */
export interface BehaviorProfile {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** ISO-8601 — the snapshot instant (from the caller's Clock). */
  readonly asOf: string;
  readonly paymentCadence: PaymentCadenceStats;
  readonly promiseReliability: PromiseReliability;
  readonly disputeHistory: DisputeHistory;
  readonly communications: CommunicationResponsiveness;
  readonly allocations: AllocationSummary;
  /** Latest observed fact instant across all dimensions; null when no facts. */
  readonly lastActivityAt: string | null;
}

// ---------------------------------------------------------------------------
// Validation — stable BEHAV_* codes, defensive against wire-shaped facts
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Full ISO-8601 instants only (the event-stream wire format). */
export const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const assertUuidShape = (value: unknown, code: string, field: string): Uuid => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError(code, `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value as Uuid;
};

const assertIsoInstant = (value: unknown, code: string, field: string): string => {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new DomainError(
      code,
      `${field} must be an ISO-8601 instant (e.g. 2026-03-02T08:00:00.000Z), got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
};

const assertPositiveMinorAmount = (value: unknown, code: string, field: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(
      code,
      `${field} must be a positive safe-integer minor-unit amount, got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
};

const factError = (code: string, kind: string, index: number, field: string, value: unknown): DomainError =>
  new DomainError(code, `${kind} fact at index ${index}: ${field} is invalid, got ${String(value)}`, {
    kind,
    index,
    field,
    value: String(value),
  });

const parseIso = (iso: string, code: string, index: number, field: string): number => {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw factError(code, 'fact', index, field, iso);
  return ms;
};

/**
 * Validate + normalize the fact bundle once; every consumer (profile,
 * anomaly detectors) works from this validated view.
 */
export interface NormalizedFacts {
  readonly payments: readonly {
    readonly ref: EvidenceRef;
    readonly receivableId: Uuid;
    readonly amountMinor: number;
    readonly dueMs: number;
    readonly settledMs: number;
    readonly partial: boolean;
  }[];
  readonly promises: readonly {
    readonly ref: EvidenceRef;
    readonly receivableId: Uuid;
    readonly promisedMs: number;
    readonly outcome: PromiseOutcome;
    readonly resolvedMs: number | null;
  }[];
  readonly disputes: readonly {
    readonly ref: EvidenceRef;
    readonly receivableId: Uuid;
    readonly openedMs: number;
    readonly resolvedMs: number | null;
  }[];
  readonly communications: readonly {
    readonly ref: EvidenceRef;
    readonly channel: string;
    readonly direction: 'inbound' | 'outbound';
    readonly sentMs: number;
  }[];
  readonly allocations: readonly {
    readonly ref: EvidenceRef;
    readonly paymentId: Uuid;
    readonly receivableId: Uuid;
    readonly amountMinor: number;
    readonly allocatedMs: number;
  }[];
}

const asArray = (value: readonly unknown[] | undefined, field: string): readonly unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new DomainError('BEHAV_FACTS_INVALID', `${field} must be an array when provided, got ${typeof value}`, {
      field,
    });
  }
  return value;
};

export function normalizeFacts(facts: BehaviorFacts): NormalizedFacts {
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new DomainError('BEHAV_FACTS_INVALID', `facts must be a plain object, got ${String(facts)}`);
  }

  const paymentRows = asArray(facts.payments, 'payments');
  const payments = paymentRows.map((raw, index) => {
    const f = raw as Partial<PaymentFact>;
    if (f === null || typeof f !== 'object') {
      throw factError('BEHAV_PAYMENT_FACT_INVALID', 'payment', index, '(row)', raw);
    }
    const partial = (f as { partial?: unknown }).partial;
    if (typeof partial !== 'boolean') {
      throw factError('BEHAV_PAYMENT_FACT_INVALID', 'payment', index, 'partial', partial);
    }
    return {
      ref: {
        kind: 'payment' as const,
        id: assertUuidShape(f.paymentId, 'BEHAV_PAYMENT_FACT_INVALID', `payments[${index}].paymentId`),
      },
      receivableId: assertUuidShape(f.receivableId, 'BEHAV_PAYMENT_FACT_INVALID', `payments[${index}].receivableId`),
      amountMinor: assertPositiveMinorAmount(f.amountMinor, 'BEHAV_AMOUNT_INVALID', `payments[${index}].amountMinor`),
      dueMs: parseIso(assertIsoInstant(f.dueDate, 'BEHAV_PAYMENT_FACT_INVALID', `payments[${index}].dueDate`), 'BEHAV_PAYMENT_FACT_INVALID', index, 'dueDate'),
      settledMs: parseIso(assertIsoInstant(f.settledAt, 'BEHAV_PAYMENT_FACT_INVALID', `payments[${index}].settledAt`), 'BEHAV_PAYMENT_FACT_INVALID', index, 'settledAt'),
      partial,
    };
  });

  const PROMISE_OUTCOMES: readonly string[] = ['kept', 'broken', 'expired', 'pending'];
  const promises = asArray(facts.promises, 'promises').map((raw, index) => {
    const f = raw as Partial<PromiseFact>;
    if (f === null || typeof f !== 'object') {
      throw factError('BEHAV_PROMISE_FACT_INVALID', 'promise', index, '(row)', raw);
    }
    const outcome = f.outcome;
    if (typeof outcome !== 'string' || !PROMISE_OUTCOMES.includes(outcome)) {
      throw factError('BEHAV_PROMISE_FACT_INVALID', 'promise', index, 'outcome', outcome);
    }
    const resolvedAt = (f as { resolvedAt?: unknown }).resolvedAt ?? null;
    if (outcome === 'pending' && resolvedAt !== null) {
      throw factError('BEHAV_PROMISE_FACT_INVALID', 'promise', index, 'resolvedAt', resolvedAt);
    }
    if (outcome !== 'pending' && resolvedAt === null) {
      throw factError('BEHAV_PROMISE_FACT_INVALID', 'promise', index, 'resolvedAt', resolvedAt);
    }
    return {
      ref: {
        kind: 'promise' as const,
        id: assertUuidShape(f.promiseId, 'BEHAV_PROMISE_FACT_INVALID', `promises[${index}].promiseId`),
      },
      receivableId: assertUuidShape(f.receivableId, 'BEHAV_PROMISE_FACT_INVALID', `promises[${index}].receivableId`),
      promisedMs: parseIso(
        assertIsoInstant(f.promisedDate, 'BEHAV_PROMISE_FACT_INVALID', `promises[${index}].promisedDate`),
        'BEHAV_PROMISE_FACT_INVALID',
        index,
        'promisedDate',
      ),
      outcome: outcome as PromiseOutcome,
      resolvedMs:
        resolvedAt === null
          ? null
          : parseIso(
              assertIsoInstant(resolvedAt, 'BEHAV_PROMISE_FACT_INVALID', `promises[${index}].resolvedAt`),
              'BEHAV_PROMISE_FACT_INVALID',
              index,
              'resolvedAt',
            ),
    };
  });

  const disputes = asArray(facts.disputes, 'disputes').map((raw, index) => {
    const f = raw as Partial<DisputeFact>;
    if (f === null || typeof f !== 'object') {
      throw factError('BEHAV_DISPUTE_FACT_INVALID', 'dispute', index, '(row)', raw);
    }
    const resolvedAt = (f as { resolvedAt?: unknown }).resolvedAt ?? null;
    return {
      ref: {
        kind: 'dispute' as const,
        id: assertUuidShape(f.disputeId, 'BEHAV_DISPUTE_FACT_INVALID', `disputes[${index}].disputeId`),
      },
      receivableId: assertUuidShape(f.receivableId, 'BEHAV_DISPUTE_FACT_INVALID', `disputes[${index}].receivableId`),
      openedMs: parseIso(
        assertIsoInstant(f.openedAt, 'BEHAV_DISPUTE_FACT_INVALID', `disputes[${index}].openedAt`),
        'BEHAV_DISPUTE_FACT_INVALID',
        index,
        'openedAt',
      ),
      resolvedMs:
        resolvedAt === null
          ? null
          : parseIso(
              assertIsoInstant(resolvedAt, 'BEHAV_DISPUTE_FACT_INVALID', `disputes[${index}].resolvedAt`),
              'BEHAV_DISPUTE_FACT_INVALID',
              index,
              'resolvedAt',
            ),
    };
  });

  const DIRECTIONS: readonly string[] = ['inbound', 'outbound'];
  const communications = asArray(facts.communications, 'communications').map((raw, index) => {
    const f = raw as Partial<CommunicationFact>;
    if (f === null || typeof f !== 'object') {
      throw factError('BEHAV_COMMUNICATION_FACT_INVALID', 'communication', index, '(row)', raw);
    }
    if (typeof f.channel !== 'string' || f.channel.trim() === '') {
      throw factError('BEHAV_COMMUNICATION_FACT_INVALID', 'communication', index, 'channel', f.channel);
    }
    if (typeof f.direction !== 'string' || !DIRECTIONS.includes(f.direction)) {
      throw factError('BEHAV_COMMUNICATION_FACT_INVALID', 'communication', index, 'direction', f.direction);
    }
    return {
      ref: {
        kind: 'communication' as const,
        id: assertUuidShape(f.messageId, 'BEHAV_COMMUNICATION_FACT_INVALID', `communications[${index}].messageId`),
      },
      channel: f.channel,
      direction: f.direction as 'inbound' | 'outbound',
      sentMs: parseIso(
        assertIsoInstant(f.sentAt, 'BEHAV_COMMUNICATION_FACT_INVALID', `communications[${index}].sentAt`),
        'BEHAV_COMMUNICATION_FACT_INVALID',
        index,
        'sentAt',
      ),
    };
  });

  const allocations = asArray(facts.allocations, 'allocations').map((raw, index) => {
    const f = raw as Partial<AllocationFact>;
    if (f === null || typeof f !== 'object') {
      throw factError('BEHAV_ALLOCATION_FACT_INVALID', 'allocation', index, '(row)', raw);
    }
    return {
      ref: {
        kind: 'allocation' as const,
        id: assertUuidShape(f.allocationId, 'BEHAV_ALLOCATION_FACT_INVALID', `allocations[${index}].allocationId`),
      },
      paymentId: assertUuidShape(f.paymentId, 'BEHAV_ALLOCATION_FACT_INVALID', `allocations[${index}].paymentId`),
      receivableId: assertUuidShape(f.receivableId, 'BEHAV_ALLOCATION_FACT_INVALID', `allocations[${index}].receivableId`),
      amountMinor: assertPositiveMinorAmount(f.amountMinor, 'BEHAV_AMOUNT_INVALID', `allocations[${index}].amountMinor`),
      allocatedMs: parseIso(
        assertIsoInstant(f.allocatedAt, 'BEHAV_ALLOCATION_FACT_INVALID', `allocations[${index}].allocatedAt`),
        'BEHAV_ALLOCATION_FACT_INVALID',
        index,
        'allocatedAt',
      ),
    };
  });

  return { payments, promises, disputes, communications, allocations };
}

// ---------------------------------------------------------------------------
// Integer-day arithmetic — UTC day indexes (DST-free by construction; the
// same midnight-UTC discipline as the promises lane, re-implemented locally
// because lanes never import each other)
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000;

/** Whole UTC days from `fromMs` to `toMs` (calendar-day gap; ±1ms across midnight flips it). */
export const utcDaysBetween = (fromMs: number, toMs: number): number => {
  const dayIndex = (ms: number): number => {
    const d = new Date(ms);
    return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
  };
  return dayIndex(toMs) - dayIndex(fromMs);
};

// ---------------------------------------------------------------------------
// Order statistics — exported pure helpers (pinned by table tests; reused by
// the drift engine and anomaly detectors)
// ---------------------------------------------------------------------------

/**
 * Median of a sample. Odd count → middle value; even count → mean of the
 * two middle values (may end in .5). The input order does NOT matter — a
 * defensive ascending copy is sorted internally. Empty sample → null
 * (never fabricate).
 */
export function medianOf(sample: readonly number[]): number | null {
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * q-th quantile (0 ≤ q ≤ 1) of a sample via R-7 linear interpolation (the
 * Excel/numpy 'linear' method): h = (n−1)·q, then interpolate between the
 * floor and ceiling ranks. The input order does NOT matter — a defensive
 * ascending copy is sorted internally. Single element → itself. Empty
 * sample → null.
 */
export function percentileOf(sample: readonly number[], q: number): number | null {
  const sorted = [...sample].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return null;
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new DomainError('BEHAV_PERCENTILE_INVALID', `percentile q must be within [0, 1], got ${String(q)}`, { q });
  }
  if (n === 1) return sorted[0] as number;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo] as number;
  // round to 4dp: the interpolated value is exact in ℚ but float noise (e.g.
  // 5 + 0.7·4 = 7.800000000000001) must not leak into a published metric
  return Math.round(((sorted[lo] as number) + (h - lo) * ((sorted[hi] as number) - (sorted[lo] as number))) * 10_000) / 10_000;
}

const ascending = (values: readonly number[]): readonly number[] => [...values].sort((a, b) => a - b);

const frozen = <T>(value: T): T => Object.freeze(value);

// ---------------------------------------------------------------------------
// buildBehaviorProfile
// ---------------------------------------------------------------------------

/**
 * Build the point-in-time behavior profile for one customer.
 *
 * Pure and deterministic: same (orgId, customerId, facts, asOf) ⇒ deeply
 * equal, deeply frozen output. Facts observed after `asOf` are invisible.
 */
export function buildBehaviorProfile(orgId: Uuid, customerId: Uuid, facts: BehaviorFacts, asOf: Date): BehaviorProfile {
  assertUuidShape(orgId, 'BEHAV_ORG_ID_INVALID', 'orgId');
  assertUuidShape(customerId, 'BEHAV_CUSTOMER_ID_INVALID', 'customerId');
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new DomainError('BEHAV_AS_OF_INVALID', `asOf must be a valid Date, got ${String(asOf)}`, { asOf: String(asOf) });
  }
  const asOfMs = asOf.getTime();
  const all = normalizeFacts(facts);

  // --- payments → cadence ----------------------------------------------------
  const settled = all.payments.filter((p) => p.settledMs <= asOfMs);
  const days = ascending(settled.map((p) => utcDaysBetween(p.dueMs, p.settledMs)));
  const paymentCadence = frozen({
    count: settled.length,
    minDaysToPay: days.length === 0 ? null : (days[0] as number),
    medianDaysToPay: medianOf(days),
    p90DaysToPay: percentileOf(days, 0.9),
    onTimeCount: days.filter((d) => d <= 0).length,
    lateCount: days.filter((d) => d > 0).length,
    partialCount: settled.filter((p) => p.partial).length,
    evidence: frozen(settled.map((p) => frozen({ kind: p.ref.kind, id: p.ref.id }))),
  } satisfies PaymentCadenceStats);

  // --- promises → reliability --------------------------------------------------
  const decided = all.promises.filter(
    (p) => p.outcome !== 'pending' && p.resolvedMs !== null && p.resolvedMs <= asOfMs,
  );
  const pending = all.promises.length - decided.length;
  const keptCount = decided.filter((p) => p.outcome === 'kept').length;
  const brokenCount = decided.filter((p) => p.outcome === 'broken').length;
  const expiredCount = decided.filter((p) => p.outcome === 'expired').length;
  const decidedCount = decided.length;
  const promiseReliability = frozen({
    keptCount,
    brokenCount,
    expiredCount,
    pendingCount: pending,
    decidedCount,
    reliabilityRate: decidedCount === 0 ? null : keptCount / decidedCount,
    evidence: frozen(decided.map((p) => frozen({ kind: p.ref.kind, id: p.ref.id }))),
  } satisfies PromiseReliability);

  // --- disputes → history -------------------------------------------------------
  const knownDisputes = all.disputes.filter((d) => d.openedMs <= asOfMs);
  const openDisputes = knownDisputes.filter((d) => d.resolvedMs === null || d.resolvedMs > asOfMs);
  const disputeHistory = frozen({
    totalCount: knownDisputes.length,
    resolvedCount: knownDisputes.length - openDisputes.length,
    openCount: openDisputes.length,
    currentlyOpen: openDisputes.length > 0,
    evidence: frozen(knownDisputes.map((d) => frozen({ kind: d.ref.kind, id: d.ref.id }))),
  } satisfies DisputeHistory);

  // --- communications → responsiveness -------------------------------------------
  const sent = all.communications.filter((c) => c.sentMs <= asOfMs);
  const channelMap = new Map<string, { inbound: number; outbound: number }>();
  for (const c of sent) {
    const row = channelMap.get(c.channel) ?? { inbound: 0, outbound: 0 };
    if (c.direction === 'inbound') row.inbound += 1;
    else row.outbound += 1;
    channelMap.set(c.channel, row);
  }
  const inboundTotal = sent.filter((c) => c.direction === 'inbound').length;
  const outboundTotal = sent.length - inboundTotal;
  const communications = frozen({
    byChannel: frozen(
      [...channelMap.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([channel, counts]) => frozen({ channel, inbound: counts.inbound, outbound: counts.outbound })),
    ),
    inboundTotal,
    outboundTotal,
    responseRate: sent.length === 0 ? null : inboundTotal / sent.length,
    evidence: frozen(sent.map((c) => frozen({ kind: c.ref.kind, id: c.ref.id }))),
  } satisfies CommunicationResponsiveness);

  // --- allocations → application summary -------------------------------------------
  const applied = all.allocations.filter((a) => a.allocatedMs <= asOfMs);
  let totalAllocated = 0;
  for (const a of applied) {
    totalAllocated += a.amountMinor;
    if (!Number.isSafeInteger(totalAllocated)) {
      throw new DomainError(
        'BEHAV_TOTAL_AMOUNT_INVALID',
        `Σ allocation amounts exceeds the safe-integer range (${totalAllocated})`,
      );
    }
  }
  const allocations = frozen({
    count: applied.length,
    totalAmountMinor: totalAllocated,
    evidence: frozen(applied.map((a) => frozen({ kind: a.ref.kind, id: a.ref.id }))),
  } satisfies AllocationSummary);

  // --- last activity -----------------------------------------------------------------
  const activityMs: number[] = [
    ...settled.map((p) => p.settledMs),
    ...decided.map((p) => p.resolvedMs as number),
    ...knownDisputes.flatMap((d) => (d.resolvedMs === null ? [d.openedMs] : [d.openedMs, d.resolvedMs])),
    ...sent.map((c) => c.sentMs),
    ...applied.map((a) => a.allocatedMs),
  ];
  const lastActivityAt = activityMs.length === 0 ? null : new Date(Math.max(...activityMs)).toISOString();

  return frozen({
    orgId,
    customerId,
    asOf: asOf.toISOString(),
    paymentCadence,
    promiseReliability,
    disputeHistory,
    communications,
    allocations,
    lastActivityAt,
  } satisfies BehaviorProfile);
}
