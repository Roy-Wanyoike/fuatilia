/**
 * Collections priority scoring — the transparent, deterministic core of F13
 * (issue #23, review finding H7, docs/08 phase 3, VISION §3.4/§3.7).
 *
 * The intelligence layer NEVER owns fund truth (README design principle 2):
 * this module is read-only arithmetic over PLAIN-DATA projections the caller
 * supplies (per-receivable facts projected from the receivables/payments/
 * promises/disputes/consent lanes, referenced by opaque Uuid only). Data in →
 * data out: no I/O, no RNG, no Date.now() — the optional recency check takes
 * an explicit `now` and the event-emitting wrapper takes the injected Clock.
 *
 * THE SCORING EXPRESSION (transparent by design — H7: no opaque numbers):
 *
 *     score = agePoints + amountPoints + Σ behaviorPoints + Σ adjustments
 *
 *   agePoints      aging bucket of the receivable ('0-30'…'90+', the same
 *                  bucket values the receivables lane derives) — 0…60
 *   amountPoints   exposure tier in minor units — 0…20
 *   behaviorPoints broken promise (+15, the E27 boost) · unresponsive prior
 *                  actions (+8) · recent payment (+5) · unreliable promiser
 *                  (+10, from optional customer facts)
 *   adjustments    open dispute (−100 — SPEC §29: never automate against a
 *                  dispute) · pending promise (−25 — back off a live promise)
 *
 * Every component is returned with its points and a human-readable reason —
 * `scoreReceivable` answers "why is this customer prioritized?" with
 * evidence, never a bare number (VISION §3.7: explainability beats an opaque
 * score in finance). The total is the plain integer sum of the components,
 * so the score can always be re-derived from its reasons.
 *
 * Ranking is a total, deterministic order (no clock, no RNG):
 *
 *   1. collectible before non-collectible (settled/written-off receivables
 *      are history, they can never outrank live debt);
 *   2. score descending;
 *   3. amountMinor descending (bigger exposure first);
 *   4. ageDays descending;
 *   5. receivableId ascending (lexicographic) — guarantees a stable total
 *      order even for fully identical facts.
 *
 * Illegal/malformed projections throw DomainError with stable SCREAMING_SNAKE
 * codes (`INTEL_*` prefix) — corrupt facts must fail loudly, never silently
 * re-rank a portfolio. Cross-currency batches are refused (R10 discipline):
 * score one currency per run.
 */
import { DomainError, type Clock, type Currency, type Uuid } from '../shared';
import {
  domainEvent,
  type IntelligenceEvent,
  type PriorityComputedPayload,
} from './events';

// --- aging buckets (same literal values as src/domain/receivables/aging.ts) ----

export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Points per aging bucket — the "age" leg of the expression. */
export const AGE_BUCKET_POINTS: Readonly<Record<AgingBucket, number>> = {
  '0-30': 10,
  '31-60': 25,
  '61-90': 40,
  '90+': 60,
};

/**
 * The bucket a given days-past-due value maps to (receivables/aging.ts rules:
 * day 30 → '0-30', day 31 → '31-60', day 61 → '61-90', day 90 → '61-90',
 * day 91 → '90+'). Used to reject internally inconsistent projections.
 */
export function bucketForAgeDays(ageDays: number): AgingBucket {
  if (ageDays <= 30) return '0-30';
  if (ageDays <= 60) return '31-60';
  if (ageDays <= 90) return '61-90';
  return '90+';
}

// --- amount tiers (minor units; currency-agnostic bands) -------------------------

export interface AmountTier {
  readonly label: string;
  /** Upper bound (exclusive) in minor units; null = no upper bound. */
  readonly maxMinor: number | null;
  readonly points: number;
}

/**
 * Exposure tiers in minor units (KES minor unit = cents, so 20_000_000 minor
 * = KES 200,000). Fixed, exported bands — callers can always see which tier
 * fired and why.
 */
export const AMOUNT_TIERS: readonly AmountTier[] = [
  { label: '<10k_minor', maxMinor: 1_000_000, points: 0 },
  { label: '10k-50k_minor', maxMinor: 5_000_000, points: 5 },
  { label: '50k-200k_minor', maxMinor: 20_000_000, points: 10 },
  { label: '200k+_minor', maxMinor: null, points: 20 },
];

/** The tier a given exposure falls into (first match wins, deterministic). */
export function amountTierOf(amountMinor: number): AmountTier {
  return AMOUNT_TIERS.find((t) => t.maxMinor === null || amountMinor < t.maxMinor)!;
}

// --- behavior flags ----------------------------------------------------------------

/** E27 boost: the customer made AND broke a promise-to-pay on this receivable. */
export const BROKEN_PROMISE_POINTS = 15;
/** Worked ≥ MIN_UNRESPONSIVE_PRIOR_ACTIONS times with zero customer responses. */
export const UNRESPONSIVE_PRIOR_ACTIONS_POINTS = 8;
export const MIN_UNRESPONSIVE_PRIOR_ACTIONS = 3;
/** Payer paid something recently — engaged payer, worth a low-friction nudge. */
export const RECENT_PAYMENT_POINTS = 5;
export const RECENT_PAYMENT_WINDOW_DAYS = 30;
/** Customer-level: promise reliability below this % bumps priority. */
export const UNRELIABLE_PROMISER_POINTS = 10;
export const UNRELIABLE_PROMISER_THRESHOLD_PCT = 50;

// --- adjustments (negative components) ---------------------------------------------

/** SPEC §29: a disputed invoice must not blindly continue automated collection. */
export const OPEN_DISPUTE_ADJUSTMENT_POINTS = -100;
/** A live promise-to-pay is being honored — hold automated pressure on it. */
export const PENDING_PROMISE_ADJUSTMENT_POINTS = -25;

// --- priority bands ------------------------------------------------------------------

export const PRIORITY_BANDS = ['critical', 'high', 'medium', 'low'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

/** Band thresholds (score ≥ threshold). Deterministic, exported, tested. */
export const PRIORITY_BAND_THRESHOLDS: Readonly<Record<'critical' | 'high' | 'medium', number>> = {
  critical: 70,
  high: 45,
  medium: 20,
};

export function bandFor(score: number): PriorityBand {
  if (score >= PRIORITY_BAND_THRESHOLDS.critical) return 'critical';
  if (score >= PRIORITY_BAND_THRESHOLDS.high) return 'high';
  if (score >= PRIORITY_BAND_THRESHOLDS.medium) return 'medium';
  return 'low';
}

// --- the plain-data contract ---------------------------------------------------------

/** Receivable lifecycle states, as projected from the receivables lane. */
export const RECEIVABLE_FACT_STATUSES = [
  'open',
  'partially_paid',
  'settled',
  'written_off',
  'recovered',
  'uncollectible',
  'voided',
] as const;
export type ReceivableFactStatus = (typeof RECEIVABLE_FACT_STATUSES)[number];

/** Only live debt can be collected — everything else is history (docs/03). */
export const COLLECTIBLE_STATUSES: readonly ReceivableFactStatus[] = ['open', 'partially_paid'];

export const isCollectibleStatus = (status: ReceivableFactStatus): boolean =>
  COLLECTIBLE_STATUSES.includes(status);

/** Promise signal, as projected from the promises/collections lanes. */
export const PROMISE_SIGNALS = ['pending', 'broken', 'fulfilled'] as const;
export type PromiseSignal = (typeof PROMISE_SIGNALS)[number];

/** How many collection touches happened, and how many got a customer response. */
export interface PriorActionCounts {
  readonly total: number;
  readonly withResponse: number;
}

/** One receivable's facts, exactly as the adapter projects them (plain data). */
export interface ReceivableFacts {
  readonly receivableId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** Open exposure in minor units — positive safe integer. */
  readonly amountMinor: number;
  readonly currency: Currency;
  /** Receivables-lane status (only 'open' | 'partially_paid' are collectible). */
  readonly status: ReceivableFactStatus;
  readonly agingBucket: AgingBucket;
  /** Whole days past due (≥ 0) — must agree with agingBucket. */
  readonly ageDays: number;
  /** An open dispute pauses automated collections (SPEC §29). */
  readonly disputed: boolean;
  /** Strongest live promise signal on this receivable (undefined = none). */
  readonly promiseState?: PromiseSignal;
  /** ISO-8601 instant of the last payment on this receivable, if any. */
  readonly lastPaymentAt?: string | null;
  /** Whether the customer has a consent grant covering dunning outreach (K2). */
  readonly consentPresent?: boolean;
  readonly priorActionCounts?: PriorActionCounts;
}

/** Optional customer-level facts (the F19 behavior lane will project these). */
export interface CustomerFacts {
  readonly customerId: Uuid;
  /** 0–100: share of past promises kept (undefined = unknown). */
  readonly promiseReliabilityPct?: number;
}

// --- one scoring component (explainability is a hard requirement) --------------------

export interface ScoreComponent {
  /** Stable machine key, e.g. 'age', 'amount', 'brokenPromise', 'openDispute'. */
  readonly key: string;
  /** Signed contribution to the total. */
  readonly points: number;
  /** Human-readable evidence — the answer to "why?". */
  readonly reason: string;
}

export interface ReceivableScore {
  readonly receivableId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly currency: Currency;
  readonly amountMinor: number;
  readonly ageDays: number;
  /** false → settled/written-off history: sorts last, recommends do_nothing_yet. */
  readonly collectible: boolean;
  /** The plain integer sum of the components — always re-derivable. */
  readonly score: number;
  readonly band: PriorityBand;
  /** Every contributing component, fixed order: age → amount → behavior → adjustments. */
  readonly components: readonly ScoreComponent[];
  /** Flattened reasons (component.order), ready for UI/agent display. */
  readonly reasons: readonly string[];
}

// --- validation (stable INTEL_* codes) --------------------------------------------------

const assertNonBlankId = (raw: string, label: string): Uuid => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError('INTEL_FACTS_INVALID', `receivable facts require a non-blank ${label}`, {
      field: label,
    });
  }
  return raw as Uuid;
};

const assertSafeNonNegativeInt = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `${label} must be a safe integer ≥ 0, got ${String(value)}`,
      { field: label, value },
    );
  }
  return value;
};

const assertIsoDate = (raw: string, label: string): Date => {
  const parsed = new Date(raw);
  if (typeof raw !== 'string' || raw.trim().length === 0 || Number.isNaN(parsed.getTime())) {
    throw new DomainError('INTEL_FACTS_INVALID', `${label} must be a valid ISO-8601 date`, {
      field: label,
      value: String(raw),
    });
  }
  return parsed;
};

/** Validate one receivable projection; throws INTEL_FACTS_INVALID on corruption. */
export function assertReceivableFacts(facts: ReceivableFacts): ReceivableFacts {
  assertNonBlankId(facts.receivableId, 'receivableId');
  assertNonBlankId(facts.orgId, 'orgId');
  assertNonBlankId(facts.customerId, 'customerId');
  if (!Number.isSafeInteger(facts.amountMinor) || facts.amountMinor <= 0) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `amountMinor must be a positive safe integer, got ${String(facts.amountMinor)}`,
      { receivableId: facts.receivableId, amountMinor: facts.amountMinor },
    );
  }
  if (typeof facts.currency !== 'string' || facts.currency.trim().length === 0) {
    throw new DomainError('INTEL_FACTS_INVALID', 'currency is required', {
      receivableId: facts.receivableId,
    });
  }
  if (!(RECEIVABLE_FACT_STATUSES as readonly string[]).includes(facts.status)) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `unknown receivable status: ${String(facts.status)}`,
      { receivableId: facts.receivableId, status: String(facts.status), allowed: RECEIVABLE_FACT_STATUSES },
    );
  }
  if (!(AGING_BUCKETS as readonly string[]).includes(facts.agingBucket)) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `unknown aging bucket: ${String(facts.agingBucket)}`,
      { receivableId: facts.receivableId, agingBucket: String(facts.agingBucket), allowed: AGING_BUCKETS },
    );
  }
  assertSafeNonNegativeInt(facts.ageDays, 'ageDays');
  // Corrupt-facts guard: bucket and ageDays are two views of one truth.
  if (bucketForAgeDays(facts.ageDays) !== facts.agingBucket) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `agingBucket ${facts.agingBucket} does not match ageDays ${facts.ageDays} (expected ${bucketForAgeDays(facts.ageDays)})`,
      { receivableId: facts.receivableId, ageDays: facts.ageDays, agingBucket: facts.agingBucket },
    );
  }
  if (typeof facts.disputed !== 'boolean') {
    throw new DomainError('INTEL_FACTS_INVALID', 'disputed must be a boolean', {
      receivableId: facts.receivableId,
      disputed: facts.disputed,
    });
  }
  if (facts.consentPresent !== undefined && typeof facts.consentPresent !== 'boolean') {
    throw new DomainError('INTEL_FACTS_INVALID', 'consentPresent must be a boolean', {
      receivableId: facts.receivableId,
      consentPresent: facts.consentPresent,
    });
  }
  if (
    facts.promiseState !== undefined &&
    !(PROMISE_SIGNALS as readonly string[]).includes(facts.promiseState)
  ) {
    throw new DomainError(
      'INTEL_FACTS_INVALID',
      `unknown promiseState: ${String(facts.promiseState)}`,
      { receivableId: facts.receivableId, promiseState: String(facts.promiseState), allowed: PROMISE_SIGNALS },
    );
  }
  if (facts.lastPaymentAt !== undefined && facts.lastPaymentAt !== null) {
    assertIsoDate(facts.lastPaymentAt, 'lastPaymentAt');
  }
  if (facts.priorActionCounts !== undefined) {
    const counts = facts.priorActionCounts;
    assertSafeNonNegativeInt(counts.total, 'priorActionCounts.total');
    assertSafeNonNegativeInt(counts.withResponse, 'priorActionCounts.withResponse');
    if (counts.withResponse > counts.total) {
      throw new DomainError(
        'INTEL_FACTS_INVALID',
        `priorActionCounts.withResponse (${counts.withResponse}) cannot exceed total (${counts.total})`,
        { receivableId: facts.receivableId },
      );
    }
  }
  return facts;
}

/** Validate optional customer facts; throws INTEL_CUSTOMER_FACTS_INVALID. */
export function assertCustomerFacts(facts: CustomerFacts): CustomerFacts {
  if (typeof facts.customerId !== 'string' || facts.customerId.trim().length === 0) {
    throw new DomainError('INTEL_CUSTOMER_FACTS_INVALID', 'customer facts require a non-blank customerId');
  }
  const pct = facts.promiseReliabilityPct;
  if (pct !== undefined && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
    throw new DomainError(
      'INTEL_CUSTOMER_FACTS_INVALID',
      `promiseReliabilityPct must be a number in [0, 100], got ${String(pct)}`,
      { customerId: facts.customerId, promiseReliabilityPct: pct },
    );
  }
  return facts;
}

const assertNowDate = (now: Date): Date => {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('INTEL_CLOCK_INVALID', 'now must be a valid Date');
  }
  return now;
};

// --- scoring -------------------------------------------------------------------------

const isWithinRecencyWindow = (lastPaymentAt: Date, now: Date): boolean => {
  const days = (now.getTime() - lastPaymentAt.getTime()) / 86_400_000;
  return days >= 0 && days <= RECENT_PAYMENT_WINDOW_DAYS;
};

/**
 * Score one receivable from plain facts — the transparent expression above,
 * with every component exposed. `customer` (optional) contributes the
 * unreliable-promiser flag. `opts.now` (optional, validated) enables the
 * recent-payment recency flag; without it recency is simply not scored.
 * Pure: never mutates the inputs, returns fresh objects.
 */
export function scoreReceivable(
  facts: ReceivableFacts,
  customer?: CustomerFacts,
  opts?: { readonly now?: Date },
): ReceivableScore {
  assertReceivableFacts(facts);
  if (customer !== undefined) assertCustomerFacts(customer);
  const now = opts?.now === undefined ? undefined : assertNowDate(opts.now);

  const components: ScoreComponent[] = [];
  const collectible = isCollectibleStatus(facts.status);

  if (!collectible) {
    components.push({
      key: 'notCollectible',
      points: 0,
      reason: `receivable status '${facts.status}' is not collectible — history, not live debt`,
    });
  } else {
    // --- age leg ---
    const agePoints = AGE_BUCKET_POINTS[facts.agingBucket];
    components.push({
      key: 'age',
      points: agePoints,
      reason: `aging bucket '${facts.agingBucket}' (${facts.ageDays} days past due)`,
    });

    // --- amount leg ---
    const tier = amountTierOf(facts.amountMinor);
    components.push({
      key: 'amount',
      points: tier.points,
      reason: `exposure ${facts.amountMinor} minor (${tier.label})`,
    });
  }

  if (collectible) {
    // --- behavior flags (fixed order) ---
    if (facts.promiseState === 'broken') {
      components.push({
        key: 'brokenPromise',
        points: BROKEN_PROMISE_POINTS,
        reason: 'customer made and broke a promise-to-pay (E27 collections.promiseBroken boost)',
      });
    }
    const counts = facts.priorActionCounts;
    if (
      counts !== undefined &&
      counts.total >= MIN_UNRESPONSIVE_PRIOR_ACTIONS &&
      counts.withResponse === 0
    ) {
      components.push({
        key: 'unresponsivePriorActions',
        points: UNRESPONSIVE_PRIOR_ACTIONS_POINTS,
        reason: `${counts.total} prior collection actions with zero customer responses`,
      });
    }
    if (now !== undefined && facts.lastPaymentAt !== undefined && facts.lastPaymentAt !== null) {
      const last = new Date(facts.lastPaymentAt);
      if (isWithinRecencyWindow(last, now)) {
        components.push({
          key: 'recentPayment',
          points: RECENT_PAYMENT_POINTS,
          reason: `last payment on ${facts.lastPaymentAt} is within ${RECENT_PAYMENT_WINDOW_DAYS} days — engaged payer`,
        });
      }
    }
    if (
      customer !== undefined &&
      customer.customerId === facts.customerId &&
      customer.promiseReliabilityPct !== undefined &&
      customer.promiseReliabilityPct < UNRELIABLE_PROMISER_THRESHOLD_PCT
    ) {
      components.push({
        key: 'unreliablePromiser',
        points: UNRELIABLE_PROMISER_POINTS,
        reason: `customer promise reliability ${customer.promiseReliabilityPct}% is below ${UNRELIABLE_PROMISER_THRESHOLD_PCT}%`,
      });
    }

    // --- adjustments (fixed order) ---
    if (facts.disputed) {
      components.push({
        key: 'openDispute',
        points: OPEN_DISPUTE_ADJUSTMENT_POINTS,
        reason: 'open dispute pauses automated collections (SPEC §29) — resolve the dispute first',
      });
    }
    if (facts.promiseState === 'pending') {
      components.push({
        key: 'pendingPromise',
        points: PENDING_PROMISE_ADJUSTMENT_POINTS,
        reason: 'live promise-to-pay — back off until it is kept or breaks',
      });
    }
  }

  const score = components.reduce((sum, c) => sum + c.points, 0);
  return {
    receivableId: facts.receivableId,
    orgId: facts.orgId,
    customerId: facts.customerId,
    currency: facts.currency,
    amountMinor: facts.amountMinor,
    ageDays: facts.ageDays,
    collectible,
    score,
    band: bandFor(score),
    components,
    reasons: components.map((c) => c.reason),
  };
}

// --- ranking ---------------------------------------------------------------------------

export interface PrioritizedReceivable extends ReceivableScore {
  /** 1-based position in the deterministic total order. */
  readonly rank: number;
}

/**
 * Rank a batch of receivable projections. Deterministic total order (see the
 * module doc). Validates every projection, refuses duplicate receivable ids
 * (INTEL_FACTS_DUPLICATE) and mixed currencies (INTEL_CURRENCY_MISMATCH, R10
 * discipline — one currency per scoring run). Never mutates the input array.
 *
 * Customer facts are optional; each applies to its `customerId` only, and a
 * customerId may appear at most once (INTEL_CUSTOMER_FACTS_DUPLICATE).
 */
export function rankPriorities(
  receivables: readonly ReceivableFacts[],
  customers?: readonly CustomerFacts[],
  opts?: { readonly now?: Date },
): readonly PrioritizedReceivable[] {
  if (customers !== undefined) {
    const seenCustomers = new Set<string>();
    for (const customer of customers) {
      assertCustomerFacts(customer);
      if (seenCustomers.has(customer.customerId)) {
        throw new DomainError(
          'INTEL_CUSTOMER_FACTS_DUPLICATE',
          `customer facts supplied twice for ${customer.customerId}`,
          { customerId: customer.customerId },
        );
      }
      seenCustomers.add(customer.customerId);
    }
  }
  const customerByCustomer = new Map<string, CustomerFacts>(
    (customers ?? []).map((c) => [c.customerId, c]),
  );

  const seenReceivables = new Set<string>();
  const currencies = new Set<string>();
  for (const facts of receivables) {
    assertReceivableFacts(facts);
    if (seenReceivables.has(facts.receivableId)) {
      throw new DomainError(
        'INTEL_FACTS_DUPLICATE',
        `receivable ${facts.receivableId} appears more than once in one scoring run`,
        { receivableId: facts.receivableId },
      );
    }
    seenReceivables.add(facts.receivableId);
    currencies.add(facts.currency);
  }
  if (currencies.size > 1) {
    throw new DomainError(
      'INTEL_CURRENCY_MISMATCH',
      `a scoring run is single-currency (R10); got ${[...currencies].sort().join(', ')}`,
      { currencies: [...currencies].sort() },
    );
  }

  const scored = receivables.map(
    (facts) => [facts, scoreReceivable(facts, customerByCustomer.get(facts.customerId), opts)] as const,
  );

  const ordered = scored
    .slice()
    .sort(([, a], [, b]) => {
      if (a.collectible !== b.collectible) return a.collectible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      if (b.amountMinor !== a.amountMinor) return b.amountMinor - a.amountMinor;
      if (b.ageDays !== a.ageDays) return b.ageDays - a.ageDays;
      return a.receivableId < b.receivableId ? -1 : 1;
    })
    .map(([, scoredReceivable], index) => ({
      ...scoredReceivable,
      rank: index + 1,
    }));

  return ordered;
}

// --- the event-emitting wrapper (the catalog's intelligence.priorityComputed) -----------

export interface ComputePrioritiesArgs {
  readonly orgId: Uuid;
  readonly receivables: readonly ReceivableFacts[];
  readonly customers?: readonly CustomerFacts[];
  readonly now?: Date;
}

/**
 * Score + rank a batch and emit the run-level catalog event
 * `intelligence.priorityComputed` (docs/04 deferred list): payload carries
 * the ranked receivable ids (ids only — scores live in the return value and
 * the caller's projection store). Pure apart from the injected Clock.
 */
export function computePriorities(
  args: ComputePrioritiesArgs,
  clock: Clock,
): { ranked: readonly PrioritizedReceivable[]; events: readonly [IntelligenceEvent & { name: 'intelligence.priorityComputed' }] } {
  if (typeof args.orgId !== 'string' || args.orgId.trim().length === 0) {
    throw new DomainError('INTEL_FACTS_INVALID', 'a scoring run requires a non-blank orgId', {
      field: 'orgId',
    });
  }
  const computedAt = clock.now();
  if (!(computedAt instanceof Date) || Number.isNaN(computedAt.getTime())) {
    throw new DomainError('INTEL_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  const ranked = rankPriorities(args.receivables, args.customers, { now: args.now });
  const payload: PriorityComputedPayload = {
    orgId: args.orgId,
    receivableCount: ranked.length,
    rankedReceivableIds: ranked.map((r) => r.receivableId),
    computedAt: computedAt.toISOString(),
  };
  const event = domainEvent<'intelligence.priorityComputed', PriorityComputedPayload>(
    'intelligence.priorityComputed',
    args.orgId,
    payload,
    clock,
  );
  return { ranked, events: [event] };
}
