/**
 * Receivable priorities — the transparent, deterministic scoring expression
 * (issue #35, VISION §3.7: "Explainability beats an opaque score in finance").
 *
 * The agent asks "which receivables should we work first?" and gets back a
 * RANKED LIST where every item exposes the full arithmetic: the expression,
 * its per-item components and the reasons. There are no opaque scores — the
 * formula is four integer components summed:
 *
 *   priority = agePoints + sizePoints + flagPoints + statusPoints
 *
 *   agePoints    = AGE_POINTS_PER_BUCKET × agingBucketIndex   (buckets 0–3,
 *                  same '0-30'|'31-60'|'61-90'|'90+' boundaries as the
 *                  receivables lane's aging)
 *   sizePoints   = the points of the DEFAULT_SIZE_BANDS row the open
 *                  balance falls into (KES-calibrated defaults; override per
 *                  query for other scales/currencies)
 *   flagPoints   = Σ FLAG_WEIGHTS over the customer's behavior flags
 *                  (fixed vocabulary — see facts.ts; counted once per flag)
 *   statusPoints = first match wins, mirroring deriveCaseStatus precedence:
 *                  open dispute +12 | broken promise +12 | pending promise
 *                  −10 | plain open 0
 *
 * Determinism: identical inputs always produce the identical ranked list.
 * Ties break on (1) larger open balance, (2) older due date, (3) receivable
 * id ascending — documented so callers can rely on the order.
 *
 * Read-only over plain facts (no lane imports, no fund-truth writes). Facts
 * whose receivable is not supplied are ignored (they belong to another
 * scope); facts stamped with a different orgId are REFUSED. R10 currency
 * discipline: the receivables being ranked must share ONE currency (scores
 * are currency-neutral points, but the size bands are calibrated per query
 * and the tie-break compares balances — cross-currency comparison is
 * refused, AGENT_CURRENCY_MISMATCH, as the intelligence lane does). One
 * injected-Clock read per query; every derived field uses that instant.
 */
import { DomainError, type Clock, type Currency, type Uuid } from '../shared';
import {
  ageBucketOf,
  ageDaysOf,
  AGENT_FLAGS,
  assertAgentClock,
  assertCustomerFact,
  assertDisputeFact,
  assertPromiseFact,
  assertReceivableFact,
  assertUuidRef,
  FLAG_WEIGHTS,
  OPEN_RECEIVABLE_STATES,
  type AgeBucket,
  type AgentFlag,
  type CustomerFact,
  type DisputeFact,
  type PromiseFact,
  type ReceivableFact,
} from './facts';

// ---------------------------------------------------------------------------
// Scoring configuration — every number here is public contract
// ---------------------------------------------------------------------------

/** Points per aging-bucket step: bucket 0 ('0-30') → 0, bucket 3 ('90+') → 30. */
export const AGE_POINTS_PER_BUCKET = 10;

/** KES-calibrated default size bands (minor units): <KES 1,000 / <10,000 / <100,000 / ≥100,000. */
export interface SizeBand {
  /** Inclusive lower bound in minor units; the first band must start at 0. */
  readonly minMinor: bigint;
  readonly points: number;
}

export const DEFAULT_SIZE_BANDS: readonly SizeBand[] = Object.freeze([
  Object.freeze({ minMinor: 0n, points: 0 }),
  Object.freeze({ minMinor: 100_000n, points: 4 }),
  Object.freeze({ minMinor: 1_000_000n, points: 8 }),
  Object.freeze({ minMinor: 10_000_000n, points: 12 }),
]);

/** Status points — first match wins (dispute outranks promise, per derive.ts). */
export const STATUS_POINTS = Object.freeze({
  disputed: 12,
  broken_promise: 12,
  promised: -10,
  open: 0,
} as const);

export type PriorityStatus = keyof typeof STATUS_POINTS;

/** The scoring expression as a human-readable string, exposed on every query. */
export const PRIORITY_EXPRESSION =
  'priority = agePoints(bucketIndex*10) + sizePoints(sizeBands) + flagPoints(sum of FLAG_WEIGHTS) + statusPoints(disputed+12 | broken_promise+12 | promised-10 | open+0)';

export interface PriorityOptions {
  /** Replace the KES-calibrated DEFAULT_SIZE_BANDS (validated, stable code on malformation). */
  readonly sizeBands?: readonly SizeBand[];
}

// ---------------------------------------------------------------------------
// Query + answer shapes
// ---------------------------------------------------------------------------

export interface PrioritiesQuery {
  readonly orgId: Uuid;
  readonly receivables: readonly ReceivableFact[];
  /** Customer facts keyed by customerId — the flags source for scoring. */
  readonly customers?: readonly CustomerFact[];
  readonly promises?: readonly PromiseFact[];
  readonly disputes?: readonly DisputeFact[];
  readonly options?: PriorityOptions;
}

export interface PriorityComponents {
  readonly ageDays: number;
  readonly ageBucket: AgeBucket;
  readonly agePoints: number;
  readonly sizeBand: number;
  readonly sizePoints: number;
  readonly flags: readonly AgentFlag[];
  readonly flagPoints: number;
  readonly status: PriorityStatus;
  readonly statusPoints: number;
}

/** One ranked answer item — the issue-#35 answer shape plus the scoring detail. */
export interface ReceivablePriorityAnswer {
  readonly subject: Uuid;
  readonly capability: 'receivable_priority';
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  readonly balanceMinor: bigint;
  readonly originalMinor: bigint;
  readonly dueDate: string;
  readonly overdue: boolean;
  readonly rank: number;
  readonly score: number;
  readonly components: PriorityComponents;
  readonly expression: string;
  readonly confidenceBasis: string;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly Uuid[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const assertSizeBands = (bands: readonly SizeBand[] | undefined): readonly SizeBand[] => {
  if (bands === undefined) return DEFAULT_SIZE_BANDS;
  if (!Array.isArray(bands) || bands.length === 0) {
    throw new DomainError('AGENT_SIZE_BANDS_INVALID', 'size bands must be a non-empty array');
  }
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i]!;
    if (typeof band.minMinor !== 'bigint' || band.minMinor < 0n) {
      throw new DomainError(
        'AGENT_SIZE_BANDS_INVALID',
        `size band ${i} minMinor must be a non-negative bigint, got ${String(band.minMinor)}`,
      );
    }
    if (!Number.isSafeInteger(band.points) || band.points < 0) {
      throw new DomainError(
        'AGENT_SIZE_BANDS_INVALID',
        `size band ${i} points must be a non-negative integer, got ${String(band.points)}`,
      );
    }
    if (i === 0 && band.minMinor !== 0n) {
      throw new DomainError('AGENT_SIZE_BANDS_INVALID', 'the first size band must start at minMinor 0');
    }
    if (i > 0 && band.minMinor <= bands[i - 1]!.minMinor) {
      throw new DomainError('AGENT_SIZE_BANDS_INVALID', 'size bands must be strictly ascending by minMinor');
    }
  }
  return bands;
};

const sizePointsOf = (balanceMinor: bigint, bands: readonly SizeBand[]): { band: number; points: number } => {
  let band = 0;
  for (let i = 0; i < bands.length; i += 1) {
    if (balanceMinor >= bands[i]!.minMinor) band = i;
  }
  return { band, points: bands[band]!.points };
};

/**
 * Flag points: the customer's flags, each counted once, summed from the
 * published weights. The exposed list is canonicalized to the AGENT_FLAGS
 * vocabulary order so the same flags always render the same expression,
 * whatever order the adapter supplied.
 */
const flagPointsOf = (flags: readonly string[]): { flags: AgentFlag[]; points: number } => {
  const unique = new Set(flags);
  const ordered = AGENT_FLAGS.filter((flag) => unique.has(flag));
  const points = ordered.reduce((sum, flag) => sum + FLAG_WEIGHTS[flag], 0);
  return { flags: [...ordered], points };
};

// ---------------------------------------------------------------------------
// Shared validation core — also feeds collectionRecommendations
// ---------------------------------------------------------------------------

/**
 * Validate a priorities-shaped query and build the per-receivable context.
 * Exported for lane-internal reuse (recommendations); the contract is plain
 * data in both directions.
 */
export function validatePrioritiesQuery(
  query: PrioritiesQuery,
  clock: Clock,
): {
  orgId: Uuid;
  /** The ONE validated clock read the whole ranking derives from. */
  now: Date;
  openReceivables: ReceivableFact[];
  receivablesById: Map<Uuid, ReceivableFact>;
  customersByCustomerId: Map<Uuid, CustomerFact>;
  promisesByReceivableId: Map<Uuid, PromiseFact[]>;
  openDisputesByReceivableId: Map<Uuid, DisputeFact[]>;
  sizeBands: readonly SizeBand[];
} {
  const now = assertAgentClock(clock);
  const orgId = assertUuidRef(query.orgId, 'orgId');

  if (!Array.isArray(query.receivables) || query.receivables.length === 0) {
    throw new DomainError(
      'AGENT_INPUT_EMPTY',
      'a priorities query requires at least one receivable fact — there is nothing to rank',
    );
  }

  const receivablesById = new Map<Uuid, ReceivableFact>();
  for (const raw of query.receivables) {
    const fact = assertReceivableFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `receivable ${fact.receivableId} belongs to org ${fact.orgId}, query is for org ${orgId} — refusing to rank another org's data`,
        { receivableId: fact.receivableId },
      );
    }
    if (receivablesById.has(fact.receivableId)) {
      throw new DomainError(
        'AGENT_RECEIVABLE_DUPLICATE',
        `receivable ${fact.receivableId} supplied twice — duplicate evidence is refused`,
        { receivableId: fact.receivableId },
      );
    }
    receivablesById.set(fact.receivableId, fact);
  }

  const customersByCustomerId = new Map<Uuid, CustomerFact>();
  for (const raw of query.customers ?? []) {
    const fact = assertCustomerFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `customer ${fact.customerId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { customerId: fact.customerId },
      );
    }
    if (customersByCustomerId.has(fact.customerId)) {
      throw new DomainError(
        'AGENT_CUSTOMER_DUPLICATE',
        `customer ${fact.customerId} supplied twice — supply one merged fact`,
        { customerId: fact.customerId },
      );
    }
    customersByCustomerId.set(fact.customerId, fact);
  }

  const promisesByReceivableId = new Map<Uuid, PromiseFact[]>();
  const seenPromises = new Set<Uuid>();
  for (const raw of query.promises ?? []) {
    const fact = assertPromiseFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `promise ${fact.promiseId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { promiseId: fact.promiseId },
      );
    }
    if (seenPromises.has(fact.promiseId)) {
      throw new DomainError(
        'AGENT_PROMISE_DUPLICATE',
        `promise ${fact.promiseId} supplied twice — duplicate evidence is refused`,
        { promiseId: fact.promiseId },
      );
    }
    seenPromises.add(fact.promiseId);
    if (!receivablesById.has(fact.receivableId)) continue; // orphan fact — belongs to another scope
    const rows = promisesByReceivableId.get(fact.receivableId) ?? [];
    rows.push(fact);
    promisesByReceivableId.set(fact.receivableId, rows);
  }

  const openDisputesByReceivableId = new Map<Uuid, DisputeFact[]>();
  const seenDisputes = new Set<Uuid>();
  for (const raw of query.disputes ?? []) {
    const fact = assertDisputeFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `dispute ${fact.disputeId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { disputeId: fact.disputeId },
      );
    }
    if (seenDisputes.has(fact.disputeId)) {
      throw new DomainError(
        'AGENT_DISPUTE_DUPLICATE',
        `dispute ${fact.disputeId} supplied twice — duplicate evidence is refused`,
        { disputeId: fact.disputeId },
      );
    }
    seenDisputes.add(fact.disputeId);
    if (!fact.open || !receivablesById.has(fact.receivableId)) continue; // terminal or out of scope
    const rows = openDisputesByReceivableId.get(fact.receivableId) ?? [];
    rows.push(fact);
    openDisputesByReceivableId.set(fact.receivableId, rows);
  }

  const openReceivables = [...receivablesById.values()].filter(
    (r) =>
      (OPEN_RECEIVABLE_STATES as readonly string[]).includes(r.state) &&
      r.originalMinor - r.paidMinor > 0n,
  );

  // R10 currency discipline for the RANKED set: scores are currency-neutral
  // points, but size bands are calibrated per query and the balance tie-break
  // compares balances — mixing currencies would be a cross-currency
  // comparison. Closed receivables are history and never ranked, so they do
  // not trip the guard. (financialStateOf stays multi-currency: exposure is
  // reported per-currency, never summed across.)
  const rankedCurrencies = new Set(openReceivables.map((r) => r.currency));
  if (rankedCurrencies.size > 1) {
    throw new DomainError(
      'AGENT_CURRENCY_MISMATCH',
      `priorities rank one currency at a time — supplied open receivables mix ${[...rankedCurrencies].sort().join(' + ')} (R10: no cross-currency comparison)`,
      { currencies: [...rankedCurrencies].sort() },
    );
  }

  return {
    orgId,
    now,
    openReceivables,
    receivablesById,
    customersByCustomerId,
    promisesByReceivableId,
    openDisputesByReceivableId,
    sizeBands: assertSizeBands(query.options?.sizeBands),
  };
}

// ---------------------------------------------------------------------------
// The scorer
// ---------------------------------------------------------------------------

export function scoreReceivable(
  receivable: ReceivableFact,
  context: {
    now: Date;
    customersByCustomerId: Map<Uuid, CustomerFact>;
    promisesByReceivableId: Map<Uuid, PromiseFact[]>;
    openDisputesByReceivableId: Map<Uuid, DisputeFact[]>;
    sizeBands: readonly SizeBand[];
  },
): { score: number; components: PriorityComponents } {
  const ageDays = ageDaysOf(receivable.dueDate, context.now);
  const bucket = ageBucketOf(ageDays);
  const bucketIndex = ['0-30', '31-60', '61-90', '90+'].indexOf(bucket);
  const agePoints = AGE_POINTS_PER_BUCKET * bucketIndex;

  const balanceMinor = receivable.originalMinor - receivable.paidMinor;
  const size = sizePointsOf(balanceMinor, context.sizeBands);

  const customer = context.customersByCustomerId.get(receivable.customerId);
  const { flags, points: flagPoints } = flagPointsOf(customer?.flags ?? []);

  const disputes = context.openDisputesByReceivableId.get(receivable.receivableId) ?? [];
  const promises = context.promisesByReceivableId.get(receivable.receivableId) ?? [];
  const hasOpenDispute = disputes.length > 0;
  const hasBrokenPromise = promises.some((p) => p.status === 'broken');
  const hasPendingPromise = promises.some((p) => p.status === 'pending');
  // First match wins — an open dispute outranks a pending promise (SPEC §29 /
  // deriveCaseStatus precedence): the debt is contested, not on hold.
  const status: PriorityStatus = hasOpenDispute
    ? 'disputed'
    : hasBrokenPromise
      ? 'broken_promise'
      : hasPendingPromise
        ? 'promised'
        : 'open';
  const statusPoints = STATUS_POINTS[status];

  const score = agePoints + size.points + flagPoints + statusPoints;
  return {
    score,
    components: {
      ageDays,
      ageBucket: bucket,
      agePoints,
      sizeBand: size.band,
      sizePoints: size.points,
      flags,
      flagPoints,
      status,
      statusPoints,
    },
  };
}

const renderExpression = (components: PriorityComponents): string => {
  const flagTerms =
    components.flags.length === 0
      ? 'none'
      : components.flags
          .map((flag) => `${flag}(${FLAG_WEIGHTS[flag] > -1 ? '+' : ''}${FLAG_WEIGHTS[flag]})`)
          .join(',');
  const statusSign = components.statusPoints > 0 ? '+' : '';
  const total =
    components.agePoints + components.sizePoints + components.flagPoints + components.statusPoints;
  return `priority = age:${components.ageBucket}(${['0-30', '31-60', '61-90', '90+'].indexOf(components.ageBucket)}*${AGE_POINTS_PER_BUCKET})=${components.agePoints} + size:band${components.sizeBand}=${components.sizePoints} + flags:${flagTerms}=${components.flagPoints} + status:${components.status}(${statusSign}${components.statusPoints})=${components.statusPoints} | total ${total}`;
};

// ---------------------------------------------------------------------------
// The capability query
// ---------------------------------------------------------------------------

/**
 * Rank an already-validated context. Split from `receivablePriorities` so
 * `collectionRecommendations` can rank and recommend against the SAME clock
 * instant with the SAME validation — one read, one validation, one ranking.
 * Deterministic ordering; every evidence id resolves to a supplied input.
 */
export function rankReceivables(context: ReturnType<typeof validatePrioritiesQuery>): readonly ReceivablePriorityAnswer[] {
  const scored = context.openReceivables.map((receivable) => {
    const { score, components } = scoreReceivable(receivable, context);
    return { receivable, score, components };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score; // highest priority first
    const balanceA = a.receivable.originalMinor - a.receivable.paidMinor;
    const balanceB = b.receivable.originalMinor - b.receivable.paidMinor;
    if (balanceA !== balanceB) return balanceA > balanceB ? -1 : 1; // larger exposure first
    const dueA = new Date(a.receivable.dueDate).getTime();
    const dueB = new Date(b.receivable.dueDate).getTime();
    if (dueA !== dueB) return dueA - dueB; // older due date first
    return a.receivable.receivableId < b.receivable.receivableId ? -1 : 1; // stable id tie-break
  });

  return scored.map(({ receivable, score, components }, index) => {
    const balanceMinor = receivable.originalMinor - receivable.paidMinor;
    const disputes = context.openDisputesByReceivableId.get(receivable.receivableId) ?? [];
    const promises = context.promisesByReceivableId.get(receivable.receivableId) ?? [];
    const customer = context.customersByCustomerId.get(receivable.customerId);

    const evidenceIds: Uuid[] = [receivable.receivableId, ...(receivable.evidenceIds ?? [])];
    for (const dispute of disputes) evidenceIds.push(dispute.disputeId, ...(dispute.evidenceIds ?? []));
    for (const promise of promises) evidenceIds.push(promise.promiseId, ...(promise.evidenceIds ?? []));
    if (customer) evidenceIds.push(...(customer.evidenceIds ?? []));
    const uniqueEvidence = [...new Set(evidenceIds)];

    const reasons: string[] = [
      `age ${components.ageDays}d past due (bucket ${components.ageBucket})`,
      `open balance ${balanceMinor} minor ${receivable.currency} (size band ${components.sizeBand})`,
    ];
    if (components.flags.length > 0) {
      reasons.push(`behavior flags: ${components.flags.map((f) => `${f}(${FLAG_WEIGHTS[f]})`).join(', ')}`);
    }
    if (components.status === 'disputed') {
      reasons.push(
        `open dispute ${String(disputes[0]!.disputeId)} — automated collection paused, human review required (SPEC §29)`,
      );
    } else if (components.status === 'broken_promise') {
      const broken = promises.find((p) => p.status === 'broken')!;
      reasons.push(`promise ${broken.promiseId} broken — the commitment to pay failed`);
    } else if (components.status === 'promised') {
      const pending = promises.find((p) => p.status === 'pending')!;
      reasons.push(
        `promise ${pending.promiseId} pending${pending.promisedDate ? ` until ${pending.promisedDate}` : ''} — holding outreach`,
      );
    }
    if (receivable.overdue === true) {
      reasons.push('flagged overdue by the receivables lane');
    }

    return {
      subject: receivable.receivableId,
      capability: 'receivable_priority' as const,
      orgId: context.orgId,
      customerId: receivable.customerId,
      currency: receivable.currency,
      balanceMinor,
      originalMinor: receivable.originalMinor,
      dueDate: receivable.dueDate,
      overdue: receivable.overdue === true,
      rank: index + 1,
      score,
      components,
      expression: renderExpression(components),
      confidenceBasis:
        'deterministic rule-based scoring (age buckets × size bands × flag weights × status points) — no model, no opaque score; every evidence id resolves to a supplied fact',
      reasons,
      evidenceIds: uniqueEvidence,
    };
  });
}

/**
 * The capability query: rank the supplied receivables. Only receivables with
 * a collectible balance (open | partially_paid and balance > 0) are ranked;
 * everything else is history. One clock read (validate → rank on the same
 * instant); refuses empty inputs and cross-org data with stable codes.
 */
export function receivablePriorities(
  query: PrioritiesQuery,
  clock: Clock,
): readonly ReceivablePriorityAnswer[] {
  const context = validatePrioritiesQuery(query, clock);
  return rankReceivables(context);
}
