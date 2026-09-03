/**
 * collectionRecommendations — "for the receivables that matter most, what
 * should we DO next?" (issue #35; the read-model sibling of F22, which ranks
 * *actions* with cost/benefit — these contracts are plain data so F22 can
 * consume them without importing this lane).
 *
 * The query reuses the priorities scorer, keeps only HIGH-PRIORITY
 * receivables (score ≥ HIGH_PRIORITY_MIN_SCORE, or any receivable under an
 * open dispute — a contested debt always needs a decision, whatever its
 * score), and maps each through a deterministic, first-match-wins matrix to
 * one of four platform capabilities:
 *
 *   offer_payment_plan | send_payment_link | human_review | do_nothing_yet
 *
 * The matrix (documented in the lane README, rule ids stable):
 *   1. dispute_open            → human_review        (SPEC §29: never automate a contested debt)
 *   2. credit_covers_balance   → do_nothing_yet      (allocate the C4 credit instead — fund truth, not outreach)
 *   3. not_yet_due             → do_nothing_yet      (dunning starts after the due date)
 *   4. promise_pending_future  → do_nothing_yet      (waiting on the commitment)
 *   5. promise_failed          → offer_payment_plan  (broken or past-due commitment — restructure)
 *   6. aged_90_plus            → human_review        (escalation territory)
 *   7. customer_unresponsive   → human_review        (automated channels exhausted)
 *   8. large_stale_balance     → offer_payment_plan  (big 31–90d balances: restructure, don't dun)
 *   9. default_self_serve      → send_payment_link   (frictionless self-serve for the rest)
 *
 * Read-only: recommendations are advice. Executing them (opening a case,
 * sending a link, offering a plan) is other lanes' fund-truth work, gated by
 * the policy engine (F20) — never this module.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { ageBucketOf, FLAG_WEIGHTS } from './facts';
import {
  rankReceivables,
  validatePrioritiesQuery,
  type PriorityOptions,
  type PrioritiesQuery,
} from './priorities';

// ---------------------------------------------------------------------------
// Configuration + answer shapes
// ---------------------------------------------------------------------------

/** A receivable is high-priority at this score or above (or when disputed). */
export const HIGH_PRIORITY_MIN_SCORE = 30;

/** Balances at or above this many minor units count as "large" (KES 50,000.00). */
export const LARGE_EXPOSURE_MINOR = 5_000_000n;

export const RECOMMENDED_CAPABILITIES = [
  'offer_payment_plan',
  'send_payment_link',
  'human_review',
  'do_nothing_yet',
] as const;
export type RecommendationCapability = (typeof RECOMMENDED_CAPABILITIES)[number];

export const RECOMMENDATION_RULES = [
  'dispute_open',
  'credit_covers_balance',
  'not_yet_due',
  'promise_pending_future',
  'promise_failed',
  'aged_90_plus',
  'customer_unresponsive',
  'large_stale_balance',
  'default_self_serve',
] as const;
export type RecommendationRule = (typeof RECOMMENDATION_RULES)[number];

export interface RecommendationOptions extends PriorityOptions {
  /** Override HIGH_PRIORITY_MIN_SCORE for this query. */
  readonly highPriorityMinScore?: number;
}

export interface RecommendationsQuery extends Omit<PrioritiesQuery, 'options'> {
  readonly options?: RecommendationOptions;
}

/** One recommendation — the issue-#35 answer shape plus the decision detail. */
export interface CollectionRecommendationAnswer {
  readonly subject: Uuid;
  readonly capability: 'collection_recommendation';
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly recommended: RecommendationCapability;
  /** The stable id of the first matching matrix rule — machine-readable why. */
  readonly rule: RecommendationRule;
  readonly priorityRank: number;
  readonly priorityScore: number;
  readonly confidenceBasis: string;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly Uuid[];
}

// ---------------------------------------------------------------------------
// The capability query
// ---------------------------------------------------------------------------

export function collectionRecommendations(
  query: RecommendationsQuery,
  clock: Clock,
): readonly CollectionRecommendationAnswer[] {
  const threshold = query.options?.highPriorityMinScore;
  if (threshold !== undefined && !Number.isSafeInteger(threshold)) {
    throw new DomainError(
      'AGENT_THRESHOLD_INVALID',
      `highPriorityMinScore must be an integer, got ${String(threshold)}`,
    );
  }
  const highPriorityMinScore = threshold ?? HIGH_PRIORITY_MIN_SCORE;

  // ONE validation + ONE ranking on the SAME clock instant (the context
  // carries the validated `now`) — the ranked list and the recommendation
  // matrix can never disagree about how old a receivable is. Own-lane import
  // only; no cross-lane coupling.
  const context = validatePrioritiesQuery(query, clock);
  const ranked = rankReceivables(context);
  const { now, customersByCustomerId, promisesByReceivableId, openDisputesByReceivableId } = context;

  const answers: CollectionRecommendationAnswer[] = [];
  for (const item of ranked) {
    const isDisputed = item.components.status === 'disputed';
    if (item.score < highPriorityMinScore && !isDisputed) continue; // not high-priority — no recommendation

    const disputes = openDisputesByReceivableId.get(item.subject) ?? [];
    const promises = promisesByReceivableId.get(item.subject) ?? [];
    const customer = customersByCustomerId.get(item.customerId);
    const pending = promises.find((p) => p.status === 'pending');
    const broken = promises.find((p) => p.status === 'broken');
    const creditCovers =
      customer?.creditBalanceMinor !== undefined &&
      customer.creditCurrency === item.currency &&
      customer.creditBalanceMinor >= item.balanceMinor;
    const notYetDue = new Date(item.dueDate).getTime() > now.getTime();

    // The matrix — first match wins (order documented in the module doc).
    let recommended: RecommendationCapability;
    let rule: RecommendationRule;
    const ruleReasons: string[] = [];
    const ruleEvidence: Uuid[] = [];

    if (disputes.length > 0) {
      recommended = 'human_review';
      rule = 'dispute_open';
      for (const dispute of disputes) {
        ruleReasons.push(`open dispute ${dispute.disputeId} — automated collection is paused (SPEC §29)`);
        ruleEvidence.push(dispute.disputeId);
      }
      ruleReasons.push('route to a human to resolve or escalate the dispute before any outreach');
    } else if (creditCovers && customer?.creditBalanceMinor !== undefined) {
      recommended = 'do_nothing_yet';
      rule = 'credit_covers_balance';
      ruleReasons.push(
        `customer credit ${customer.creditBalanceMinor} minor ${item.currency} covers the open balance ${item.balanceMinor}`,
      );
      ruleReasons.push('allocate the credit first (fund truth) — collection outreach would be noise');
      ruleEvidence.push(item.customerId);
    } else if (notYetDue) {
      recommended = 'do_nothing_yet';
      rule = 'not_yet_due';
      ruleReasons.push(`not due until ${item.dueDate} — dunning starts after the due date`);
    } else if (pending?.promisedDate !== undefined && new Date(pending.promisedDate).getTime() > now.getTime()) {
      recommended = 'do_nothing_yet';
      rule = 'promise_pending_future';
      ruleReasons.push(`promise ${pending.promiseId} pending until ${pending.promisedDate} — waiting on the commitment`);
      ruleEvidence.push(pending.promiseId);
    } else if (broken !== undefined || (pending?.promisedDate !== undefined && new Date(pending.promisedDate).getTime() <= now.getTime())) {
      recommended = 'offer_payment_plan';
      rule = 'promise_failed';
      if (broken) {
        ruleReasons.push(`promise ${broken.promiseId} broken — the commitment to pay failed`);
        ruleEvidence.push(broken.promiseId);
      } else if (pending) {
        ruleReasons.push(
          `promise ${pending.promiseId} was due ${pending.promisedDate} and the balance is still outstanding`,
        );
        ruleEvidence.push(pending.promiseId);
      }
      ruleReasons.push('offer a structured payment plan instead of re-dunning');
    } else if (item.components.ageBucket === '90+') {
      recommended = 'human_review';
      rule = 'aged_90_plus';
      ruleReasons.push(
        `${item.components.ageDays}d past due (90+) — escalation territory, a human owns the recovery decision`,
      );
    } else if (item.components.flags.includes('unresponsive')) {
      recommended = 'human_review';
      rule = 'customer_unresponsive';
      ruleReasons.push('customer flagged unresponsive — automated channels are exhausted, make human contact');
    } else if (
      (item.components.ageBucket === '31-60' || item.components.ageBucket === '61-90') &&
      item.balanceMinor >= LARGE_EXPOSURE_MINOR
    ) {
      recommended = 'offer_payment_plan';
      rule = 'large_stale_balance';
      ruleReasons.push(
        `large stale balance (${item.balanceMinor} minor ${item.currency}, bucket ${item.components.ageBucket}) — restructure rather than dun`,
      );
    } else {
      recommended = 'send_payment_link';
      rule = 'default_self_serve';
      ruleReasons.push(
        `open receivable within 90d (bucket ${ageBucketOf(item.components.ageDays)}) — a payment link lets the customer self-serve`,
      );
    }

    if (pending && rule !== 'promise_pending_future' && rule !== 'promise_failed') {
      ruleReasons.push(`note: a pending promise (${pending.promiseId}) also covers this receivable`);
    }
    if (item.components.flags.length > 0 && rule !== 'customer_unresponsive') {
      ruleReasons.push(
        `behavior flags: ${item.components.flags.map((f) => `${f}(${FLAG_WEIGHTS[f]})`).join(', ')}`,
      );
    }

    const evidenceIds = [...new Set([...item.evidenceIds, ...ruleEvidence])];
    answers.push({
      subject: item.subject,
      capability: 'collection_recommendation',
      orgId: item.orgId,
      customerId: item.customerId,
      recommended,
      rule,
      priorityRank: item.rank,
      priorityScore: item.score,
      confidenceBasis: `priority score ${item.score} (rank ${item.rank}) vs high-priority bar ${highPriorityMinScore}${isDisputed && item.score < highPriorityMinScore ? ', disputed receivables are always surfaced' : ''}; first matching rule of ${RECOMMENDATION_RULES.length} applied deterministically`,
      reasons: [
        `ranked #${item.rank} with priority score ${item.score} (high-priority bar: ${highPriorityMinScore})`,
        ...ruleReasons,
      ],
      evidenceIds,
    });
  }

  return answers;
}

/**
 * Shared validation entry for adapters that want to validate a
 * recommendations query without running the full pipeline — re-exports the
 * priorities validator (same facts, same codes).
 */
export function validateRecommendationsQuery(
  query: RecommendationsQuery,
  clock: Clock,
): ReturnType<typeof validatePrioritiesQuery> {
  const threshold = query.options?.highPriorityMinScore;
  if (threshold !== undefined && !Number.isSafeInteger(threshold)) {
    throw new DomainError(
      'AGENT_THRESHOLD_INVALID',
      `highPriorityMinScore must be an integer, got ${String(threshold)}`,
    );
  }
  return validatePrioritiesQuery(query, clock);
}
