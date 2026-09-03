/**
 * Recommendation selection — the F13 next-capability matrix (issue #23,
 * review finding H7, VISION §3.4 precursor to F22 next-best-action).
 *
 * For a receivable's plain-data facts the matrix picks ONE recommended next
 * capability, with named rules and evidence reasons. First match wins and
 * the matching rule's name travels with the result (`rule`), so the answer
 * to "why did Fuatilia recommend this?" is always auditable.
 *
 * Deliberate contract boundary: this lane recommends CAPABILITIES, never
 * executions. The future F22 next-best-action lane ranks concrete actions
 * with cost/benefit + the F20 policy filter — it can consume these plain
 * facts verbatim (no lane imports either way); the F20 policy engine and
 * the K2 consent gate own every actual send decision at execution time.
 *
 * THE MATRIX (first match wins — order is the policy, documented + tested):
 *
 *   1. not collectible (settled/written_off/…)  → do_nothing_yet
 *   2. open dispute                             → human_review
 *      (SPEC §29: never automate against a dispute)
 *   3. live promise (pending)                   → do_nothing_yet
 *      (the customer committed; pressure would harass)
 *   4. broken promise                           → prioritize_for_collector
 *      (the E27 priority boost: commitment missed)
 *   5. aged ≥90d AND ≥3 touches, zero responses → human_review
 *      (beyond automation — human judgment on a dead thread)
 *   6. large exposure AND aged ≥60d             → prioritize_for_collector
 *   7. aged ≥30d AND unreliable promiser        → prioritize_for_collector
 *      (don't offer another commitment they'll break)
 *   8. aged ≥30d                                → offer_payment_plan
 *   9. dunning consent present                  → send_payment_link
 *  10. otherwise (no consent)                   → prioritize_for_collector
 *      (K2: no automated self-serve — a human follows up)
 *
 * Everything is a pure function: data in → data out, no I/O, no Date.now()
 * (the recommendation FACT's timestamps come from the injected Clock).
 * Illegal inputs throw DomainError with stable `INTEL_*` codes.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { domainEvent, type IntelligenceEvent, type RecommendationCreatedPayload } from './events';
import {
  MIN_UNRESPONSIVE_PRIOR_ACTIONS,
  UNRELIABLE_PROMISER_THRESHOLD_PCT,
  assertCustomerFacts,
  assertReceivableFacts,
  bandFor,
  isCollectibleStatus,
  type CustomerFacts,
  type PrioritizedReceivable,
  type ReceivableFacts,
} from './scoring';

export const NEXT_ACTION_CAPABILITIES = [
  'prioritize_for_collector',
  'offer_payment_plan',
  'send_payment_link',
  'human_review',
  'do_nothing_yet',
] as const;
export type NextActionCapability = (typeof NEXT_ACTION_CAPABILITIES)[number];

/** Exposure (minor units) that counts as "large" for rule 6 (KES 200,000). */
export const LARGE_EXPOSURE_MINOR = 20_000_000;
/** Days past due that count as "aged" for rule 6. */
export const LARGE_EXPOSURE_MIN_AGE_DAYS = 60;
/** Days past due from which restructuring beats more reminders (rules 7/8). */
export const PAY_PLAN_MIN_AGE_DAYS = 30;
/** Days past due that count as "aged" for the human-review rule 5. */
export const AGED_HUMAN_REVIEW_DAYS = 90;

export interface NextActionRecommendation {
  readonly receivableId: Uuid;
  readonly capability: NextActionCapability;
  /** The matrix rule that fired — stable machine key for audit + tests. */
  readonly rule: string;
  /** Evidence reasons (explainability is a hard requirement, H7). */
  readonly reasons: readonly string[];
}

/**
 * Pick the recommended next capability for one receivable — the matrix
 * above, first match wins. Pure: the facts are never mutated, nothing is
 * emitted (recommendation FACTS + events come from `createRecommendation`).
 */
export function recommendNextAction(
  facts: ReceivableFacts,
  customer?: CustomerFacts,
): NextActionRecommendation {
  assertReceivableFacts(facts);
  if (customer !== undefined) assertCustomerFacts(customer);
  const id = facts.receivableId;
  const unreliable =
    customer !== undefined &&
    customer.customerId === facts.customerId &&
    customer.promiseReliabilityPct !== undefined &&
    customer.promiseReliabilityPct < UNRELIABLE_PROMISER_THRESHOLD_PCT;

  // 1 — history is not work
  if (!isCollectibleStatus(facts.status)) {
    return {
      receivableId: id,
      capability: 'do_nothing_yet',
      rule: 'not_collectible',
      reasons: [`status '${facts.status}' is not collectible — nothing left to recover`],
    };
  }
  // 2 — SPEC §29: disputes pause automation
  if (facts.disputed) {
    return {
      receivableId: id,
      capability: 'human_review',
      rule: 'dispute_pause',
      reasons: [
        'open dispute pauses automated collections (SPEC §29) — a human must resolve the dispute first',
      ],
    };
  }
  // 3 — honor the live promise
  if (facts.promiseState === 'pending') {
    return {
      receivableId: id,
      capability: 'do_nothing_yet',
      rule: 'live_promise',
      reasons: [
        'live promise-to-pay — the customer has committed; hold automated pressure until it is kept or breaks',
      ],
    };
  }
  // 4 — the E27 broken-promise boost
  if (facts.promiseState === 'broken') {
    return {
      receivableId: id,
      capability: 'prioritize_for_collector',
      rule: 'broken_promise',
      reasons: [
        'customer made and broke a promise-to-pay (E27 collections.promiseBroken) — a commitment was missed',
      ],
    };
  }
  const counts = facts.priorActionCounts;
  // 5 — a dead thread is a human decision
  if (
    facts.ageDays >= AGED_HUMAN_REVIEW_DAYS &&
    counts !== undefined &&
    counts.total >= MIN_UNRESPONSIVE_PRIOR_ACTIONS &&
    counts.withResponse === 0
  ) {
    return {
      receivableId: id,
      capability: 'human_review',
      rule: 'aged_unresponsive',
      reasons: [
        `${facts.ageDays} days past due with ${counts.total} collection touches and zero customer responses — beyond automation`,
      ],
    };
  }
  // 6 — large aged exposure deserves a dedicated owner
  if (facts.amountMinor >= LARGE_EXPOSURE_MINOR && facts.ageDays >= LARGE_EXPOSURE_MIN_AGE_DAYS) {
    return {
      receivableId: id,
      capability: 'prioritize_for_collector',
      rule: 'large_aged_exposure',
      reasons: [
        `exposure ${facts.amountMinor} minor aged ${facts.ageDays} days — high-value aged debt warrants a dedicated collector`,
      ],
    };
  }
  // 7 — don't offer another commitment to a promise-breaker
  if (facts.ageDays >= PAY_PLAN_MIN_AGE_DAYS && unreliable) {
    return {
      receivableId: id,
      capability: 'prioritize_for_collector',
      rule: 'unreliable_promiser',
      reasons: [
        `${facts.ageDays} days past due and customer promise reliability ${customer?.promiseReliabilityPct}% is below ${UNRELIABLE_PROMISER_THRESHOLD_PCT}% — do not offer another commitment`,
      ],
    };
  }
  // 8 — early enough to restructure
  if (facts.ageDays >= PAY_PLAN_MIN_AGE_DAYS) {
    return {
      receivableId: id,
      capability: 'offer_payment_plan',
      rule: 'aged_needs_structure',
      reasons: [
        `${facts.ageDays} days past due — early enough to restructure into installments before escalation`,
      ],
    };
  }
  // 9 — consented customer: lowest-friction self-serve
  if (facts.consentPresent === true) {
    const reasons = [
      'fresh delinquency with dunning consent on file — a payment link is the lowest-friction self-serve step',
    ];
    if (
      facts.lastPaymentAt !== undefined &&
      facts.lastPaymentAt !== null &&
      facts.promiseState === undefined
    ) {
      reasons.push('recent payment history suggests the payer will respond to a self-serve nudge');
    }
    return { receivableId: id, capability: 'send_payment_link', rule: 'consented_self_serve', reasons };
  }
  // 10 — no consent: K2 blocks automated self-serve, a human follows up
  return {
    receivableId: id,
    capability: 'prioritize_for_collector',
    rule: 'no_consent_manual_follow_up',
    reasons: [
      'no dunning consent on file (K2) — automated self-serve is unavailable; a human follows up instead',
    ],
  };
}

/**
 * Recommend for a whole batch, in input order. Same validation as
 * `rankPriorities` (malformed facts, duplicate customer facts). Pure.
 */
export function recommendNextActions(
  receivables: readonly ReceivableFacts[],
  customers?: readonly CustomerFacts[],
): readonly NextActionRecommendation[] {
  if (customers !== undefined) {
    const seen = new Set<string>();
    for (const customer of customers) {
      assertCustomerFacts(customer);
      if (seen.has(customer.customerId)) {
        throw new DomainError(
          'INTEL_CUSTOMER_FACTS_DUPLICATE',
          `customer facts supplied twice for ${customer.customerId}`,
          { customerId: customer.customerId },
        );
      }
      seen.add(customer.customerId);
    }
  }
  const byCustomer = new Map<string, CustomerFacts>((customers ?? []).map((c) => [c.customerId, c]));
  return receivables.map((facts) => recommendNextAction(facts, byCustomer.get(facts.customerId)));
}

// --- the recommendation FACT (append-only, emits intelligence.recommendationCreated) ----

export interface RecommendationFact {
  readonly recommendationId: Uuid;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly customerId: Uuid;
  readonly capability: NextActionCapability;
  /** The priority score this recommendation was based on. */
  readonly score: number;
  /** Band derived from score (same thresholds as scoring). */
  readonly band: PrioritizedReceivable['band'];
  readonly reasons: readonly string[];
  readonly createdAt: Date;
}

export interface CreateRecommendationArgs {
  readonly id: Uuid;
  readonly orgId: Uuid;
  readonly receivableId: Uuid;
  readonly customerId: Uuid;
  readonly capability: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

const assertFactId = (raw: string, label: string): Uuid => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError(
      'INTEL_RECOMMENDATION_INVALID',
      `a recommendation requires a non-blank ${label}`,
      { field: label },
    );
  }
  return raw as Uuid;
};

/**
 * Record a recommendation as an append-only FACT and emit
 * `intelligence.recommendationCreated`. The caller supplies the id (this lane
 * mints nothing) and copies `score`/`reasons` from the ranked entry it acted
 * on — the fact is self-describing and auditable end-to-end.
 *
 * Throws:
 *   - INTEL_RECOMMENDATION_INVALID — blank id/org/receivable/customer ids;
 *   - INTEL_CAPABILITY_INVALID — unknown capability string;
 *   - INTEL_SCORE_INVALID — score not a safe integer;
 *   - INTEL_REASONS_REQUIRED — empty/blank reasons (explainability is not
 *     optional: a recommendation without reasons cannot be recorded);
 *   - INTEL_CLOCK_INVALID — broken injected clock.
 */
export function createRecommendation(
  args: CreateRecommendationArgs,
  clock: Clock,
): {
  recommendation: RecommendationFact;
  events: readonly [IntelligenceEvent & { name: 'intelligence.recommendationCreated' }];
} {
  const recommendationId = assertFactId(args.id, 'id');
  const orgId = assertFactId(args.orgId, 'orgId');
  const receivableId = assertFactId(args.receivableId, 'receivableId');
  const customerId = assertFactId(args.customerId, 'customerId');
  if (!(NEXT_ACTION_CAPABILITIES as readonly string[]).includes(args.capability)) {
    throw new DomainError(
      'INTEL_CAPABILITY_INVALID',
      `unknown capability: ${String(args.capability)}`,
      { capability: String(args.capability), allowed: NEXT_ACTION_CAPABILITIES },
    );
  }
  if (!Number.isSafeInteger(args.score)) {
    throw new DomainError(
      'INTEL_SCORE_INVALID',
      `score must be a safe integer, got ${String(args.score)}`,
      { score: args.score },
    );
  }
  const reasons = args.reasons ?? [];
  if (reasons.length === 0 || reasons.some((r) => typeof r !== 'string' || r.trim().length === 0)) {
    throw new DomainError(
      'INTEL_REASONS_REQUIRED',
      'a recommendation requires at least one non-blank reason (explainability is a hard requirement)',
      { reasons },
    );
  }
  const createdAt = clock.now();
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    throw new DomainError('INTEL_CLOCK_INVALID', 'clock returned an invalid Date');
  }

  const capability = args.capability as NextActionCapability;
  const recommendation: RecommendationFact = {
    recommendationId,
    orgId,
    receivableId,
    customerId,
    capability,
    score: args.score,
    band: bandFor(args.score),
    reasons: [...reasons],
    createdAt,
  };

  const payload: RecommendationCreatedPayload = {
    recommendationId,
    orgId,
    receivableId,
    customerId,
    capability,
    score: args.score,
    band: recommendation.band,
    reasons: recommendation.reasons,
    createdAt: createdAt.toISOString(),
  };
  const event = domainEvent<'intelligence.recommendationCreated', RecommendationCreatedPayload>(
    'intelligence.recommendationCreated',
    recommendationId,
    payload,
    clock,
  );
  return { recommendation, events: [event] };
}
