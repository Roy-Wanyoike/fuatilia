/**
 * The next-best-action ranking engine (issue #36, VISION §3.4 + §3.9).
 *
 * Answers: "what is the most effective action we can take right now to
 * maximize recovery while respecting customer preferences and business
 * policy?" — deterministically, over the plain-data feature bundle of
 * `features.ts`, with EVERY weight and intermediate value exposed in the
 * result. Explainability beats an opaque score in finance (VISION §3.7).
 *
 * The TRANSPARENT scoring expression, identical for every candidate:
 *
 *     score(candidate) = expectedRecovery × channelFit − cost − fatigue
 *
 * evaluated in integer minor units with fixed rounding points:
 *
 *   1. expectedRecovery = floor( floor(amountMinor × recoveryRateBps / 10 000)
 *                               × signalBps / 10 000 )
 *      — `recoveryRateBps` is the per-action historical collection proxy;
 *      `signalBps` folds the bundle's signals (history, risk, promise,
 *      dispute, age, opt-out) stepwise, each factor a bps multiplier with a
 *      documented fixed order;
 *   2. channelFit ∈ 0..1000‰ — from the customer's channel preferences
 *      (opted_in / neutral / opted_out; internal actions are always 1000‰);
 *   3. weighted = floor(expectedRecovery × channelFit / 1000);
 *   4. minus `costMinor` (per-action operating-cost proxy), minus the
 *      fatigue penalty (recent same-type actions within the window ×
 *      per-action penalty), minus the approval friction when policy demands
 *      human approval.
 *
 * `do_nothing` scores exactly 0 — zero recovery, zero cost, zero fatigue —
 * so it wins whenever every other candidate scores ≤ 0. It is a first-class
 * recommendation, not an absence of one.
 *
 * Policy filter (VISION §3.9 — AI never decides what it may do): the caller
 * supplies F20-shape decisions (allow | deny | requires_approval + reason
 * code). A deny EXCLUDES the candidate from recommendation (the denial is
 * recorded in its reasons and in the plan's policy evidence); a
 * requires_approval keeps the candidate runnable but downgrades it by the
 * approval friction. Silence (no decision) counts as allow — the policy
 * engine evaluated and did not object; callers wanting deny-by-default pass
 * explicit denies. NBA never bypasses policy.
 *
 * Fatigue: recent same-type actions within `fatigueWindowDays` (counts +
 * recency come from the bundle) each add their penalty; a per-action cap
 * (DEFAULT_ACTION_CAPS, overridable) exhausts the action entirely —
 * gracefully: the candidate stays visible as `fatigue_capped` and the
 * ranking falls through to the next-best (ultimately do_nothing, which is
 * never capped).
 *
 * Everything is pure and deterministic: integer arithmetic only, no I/O, no
 * RNG, no Date.now() — the injected Clock stamps the plan and its event.
 * The bps/‰ scalings use an exact split identity (see `scaleBps`) so no
 * float ever drifts a score at ANY safe-integer amount. Equal scores
 * tie-break by the canonical NBA_ACTIONS order.
 */
import { DomainError, type Clock, type Currency, type Uuid, uuid } from '../shared';
import {
  NBA_ACTIONS,
  NBA_CUSTOMER_FACING_ACTIONS,
  NBA_DIGITAL_DELIVERY_CHANNELS,
  type NbaActionType,
} from './actions';
import {
  validateNbaFeatureBundle,
  type NbaChannelPreference,
  type NbaFeatureBundle,
} from './features';
import {
  domainEvent,
  type NbaEvent,
  type NbaRecommendationCreatedPayload,
  type PolicyDenialEvidence,
  type RecommendationAlternative,
} from './events';

// --- weights (exposed in every result — explainability over opaque scores) ---------

export interface NbaWeights {
  /** Per-action historical recovery proxy, in basis points of the amount (0..10000). */
  readonly recoveryRateBps: Readonly<Record<NbaActionType, number>>;
  /** Per-action operating-cost proxy, in minor units of the bundle's currency. */
  readonly costMinor: Readonly<Record<NbaActionType, number>>;
  /** Penalty per recent same-type action within the fatigue window (minor units). */
  readonly fatiguePenaltyMinor: Readonly<Record<NbaActionType, number>>;
  /** Recent actions with `daysAgo` ≤ this window count as fatiguing. */
  readonly fatigueWindowDays: number;
  /** Channel fit for an opted-in channel (‰). */
  readonly channelFitOptedInPermill: number;
  /** Channel fit when no preference is stated (‰). */
  readonly channelFitNeutralPermill: number;
  /** Channel fit for an opted-out channel (‰) — 0 kills the candidate. */
  readonly channelFitOptedOutPermill: number;
  /** Extra cost applied when policy says requires_approval (the downgrade). */
  readonly approvalFrictionMinor: number;
}

const rate = (call: number, whatsapp: number, sms: number, plan: number, link: number, review: number, escalate: number): Record<NbaActionType, number> => ({
  call,
  whatsapp,
  sms,
  offer_payment_plan: plan,
  send_payment_link: link,
  human_review: review,
  escalate,
  do_nothing: 0,
});

/**
 * The shipped weight set. Recovery rates are the historical-collection
 * proxies (calls recover most but cost most; self-serve links are cheap);
 * internal actions carry human-time costs and no customer fatigue.
 */
export const DEFAULT_NBA_WEIGHTS: NbaWeights = {
  recoveryRateBps: rate(3500, 2500, 1500, 3000, 2500, 1500, 2000),
  costMinor: {
    call: 5000,
    whatsapp: 500,
    sms: 300,
    offer_payment_plan: 2000,
    send_payment_link: 200,
    human_review: 10000,
    escalate: 4000,
    do_nothing: 0,
  },
  fatiguePenaltyMinor: {
    call: 3000,
    whatsapp: 1000,
    sms: 800,
    offer_payment_plan: 1500,
    send_payment_link: 500,
    human_review: 0,
    escalate: 0,
    do_nothing: 0,
  },
  fatigueWindowDays: 14,
  channelFitOptedInPermill: 1000,
  channelFitNeutralPermill: 600,
  channelFitOptedOutPermill: 0,
  approvalFrictionMinor: 2500,
};

/**
 * Per-action fatigue caps: the maximum recent same-type actions within the
 * window before the action is exhausted (status `fatigue_capped`).
 * `do_nothing` is deliberately absent — it can never be capped, so a fully
 * exhausted slate always degrades gracefully to it.
 */
export const DEFAULT_ACTION_CAPS: Partial<Record<NbaActionType, number>> = {
  call: 3,
  whatsapp: 3,
  sms: 3,
  offer_payment_plan: 1,
  send_payment_link: 2,
  human_review: 2,
  escalate: 1,
};

// --- signals (bps multipliers; every value is a documented table) -------------------

/**
 * floor(amount × rate / divisor) in EXACT integer arithmetic — no float
 * drift at any (validated) safe-integer amount. Identity: with
 * amount = q·divisor + r, floor(amount × rate / divisor) = q·rate +
 * floor(r × rate / divisor). `features.ts` bounds amountMinor so every
 * intermediate product (≤ amount × 15 for the largest 15000bps factor)
 * stays within the safe-integer range.
 */
const scaleBy = (amount: number, rate: number, divisor: number): number =>
  Math.floor(amount / divisor) * rate + Math.floor(((amount % divisor) * rate) / divisor);
/** Basis points (per 10 000). */
const scaleBps = (amount: number, bps: number): number => scaleBy(amount, bps, 10_000);
/** Permill (per 1 000). */
const scalePermill = (amount: number, permill: number): number => scaleBy(amount, permill, 1_000);

const RISK_BPS: Record<NbaFeatureBundle['riskClass'], number> = {
  low: 11000,
  moderate: 10000,
  elevated: 8500,
  high: 6500,
};

/** Human review gets MORE valuable as risk rises (the inverse of recovery). */
const HUMAN_REVIEW_RISK_BPS: Record<NbaFeatureBundle['riskClass'], number> = {
  low: 8000,
  moderate: 10000,
  elevated: 12000,
  high: 14000,
};

/** SPEC §29: an open dispute pauses aggressive automation, demands a human. */
const DISPUTE_CUSTOMER_FACING_BPS = 3000;
const DISPUTE_HUMAN_REVIEW_BPS = 15000;
const DISPUTE_ESCALATE_BPS = 8000;

/** Escalation is for aged receivables: near-worthless fresh, strong at 30/60d. */
const escalateAgeBps = (ageDays: number): number => {
  if (ageDays >= 60) return 15000;
  if (ageDays >= 30) return 12000;
  return 5000;
};

/** Recovery decays with age: the older the debt, the harder to collect. */
const ageDecayBps = (ageDays: number): number => Math.max(4000, 10000 - 100 * ageDays);

/**
 * A pending promise suppresses outreach — but only as much as the customer's
 * promise reliability earns: a promise from a 1000‰-reliable promiser cuts
 * the recovery signal to 2500bps (wait — they pay), while a 0‰-reliability
 * promise counts for nothing (10000bps — treat as no promise).
 */
const promiseBps = (bundle: NbaFeatureBundle): number => {
  const promise = bundle.promise;
  if (promise === undefined) return 10000;
  switch (promise.state) {
    case 'none':
      return 10000;
    case 'fulfilled':
      return 11000;
    case 'broken':
      return 12000;
    case 'pending': {
      const slack = 1000 - promise.reliabilityPermill;
      return 2500 + Math.floor((7500 * slack) / 1000);
    }
  }
};

/** Payment-history signal: 0% on-time → 4000bps, 100% → 13000bps, none → 10000. */
const historyBps = (bundle: NbaFeatureBundle): number => {
  const { onTime, late, unpaid } = bundle.paymentHistory;
  const total = onTime + late + unpaid;
  if (total === 0) return 10000;
  return 4000 + Math.floor((9000 * onTime) / total);
};

const foldBps = (factors: readonly number[]): number =>
  factors.reduce((acc, f) => Math.floor((acc * f) / 10000), 10000);

const customerOptedOut = (bundle: NbaFeatureBundle): boolean =>
  (bundle.priorOutcomes ?? []).some((o) => o.outcome === 'opted_out');

/**
 * The per-candidate signal factors, in their FIXED fold order (documented so
 * replays are bit-for-bit reproducible). Customer-facing actions fold
 * history → risk → promise → dispute → age → opt-out; human_review folds
 * dispute → human-review-risk; escalate folds dispute → escalation-age.
 * do_nothing carries no factors (its recovery rate is 0 anyway).
 */
const signalFactorsOf = (bundle: NbaFeatureBundle, action: NbaActionType): readonly { name: string; bps: number }[] => {
  if ((NBA_CUSTOMER_FACING_ACTIONS as readonly string[]).includes(action)) {
    const dispute = bundle.disputeOpen === true ? DISPUTE_CUSTOMER_FACING_BPS : 10000;
    const optOut = customerOptedOut(bundle) ? 0 : 10000;
    return [
      { name: 'history', bps: historyBps(bundle) },
      { name: 'risk', bps: RISK_BPS[bundle.riskClass] },
      { name: 'promise', bps: promiseBps(bundle) },
      { name: 'dispute', bps: dispute },
      { name: 'age', bps: ageDecayBps(bundle.ageDays) },
      { name: 'opt_out', bps: optOut },
    ];
  }
  if (action === 'human_review') {
    return [
      { name: 'dispute', bps: bundle.disputeOpen === true ? DISPUTE_HUMAN_REVIEW_BPS : 10000 },
      { name: 'review_risk', bps: HUMAN_REVIEW_RISK_BPS[bundle.riskClass] },
    ];
  }
  if (action === 'escalate') {
    return [
      { name: 'dispute', bps: bundle.disputeOpen === true ? DISPUTE_ESCALATE_BPS : 10000 },
      { name: 'escalate_age', bps: escalateAgeBps(bundle.ageDays) },
    ];
  }
  return [];
};

// --- channel fit ---------------------------------------------------------------------

const fitOf = (preference: NbaChannelPreference | undefined, weights: NbaWeights): number => {
  if (preference === 'opted_in') return weights.channelFitOptedInPermill;
  if (preference === 'opted_out') return weights.channelFitOptedOutPermill;
  return weights.channelFitNeutralPermill;
};

/**
 * Channel fit for a candidate, in ‰ (0..1000). Direct channels read their
 * own preference; `offer_payment_plan` / `send_payment_link` are self-serve
 * content and travel over the BEST available digital channel (whatsapp |
 * sms — a plan offer is never delivered by voice); internal actions have no
 * customer channel and always fit 1000‰.
 */
export const channelFitPermillOf = (bundle: NbaFeatureBundle, action: NbaActionType, weights: NbaWeights): number => {
  const prefs = bundle.channelPreferences ?? {};
  if (action === 'call' || action === 'whatsapp' || action === 'sms') {
    return fitOf(prefs[action], weights);
  }
  if (action === 'offer_payment_plan' || action === 'send_payment_link') {
    const fits = NBA_DIGITAL_DELIVERY_CHANNELS.map((c) => fitOf(prefs[c], weights));
    return Math.max(...fits);
  }
  return 1000; // human_review | escalate | do_nothing — internal, channel-free
};

// --- policy filter (F20 contract shape, minimal local type) ---------------------------

export type NbaPolicyDecisionValue = 'allow' | 'deny' | 'requires_approval';

/**
 * Minimal plain-data policy decision, matching the F20 contract shape:
 * the policy engine's verdict for ONE candidate action, with its stable
 * reason code. NBA never evaluates policy itself — it only honors these.
 */
export interface NbaPolicyDecision {
  readonly action: NbaActionType;
  readonly decision: NbaPolicyDecisionValue;
  /** Stable F20 reason code — travels into the plan's reasons and event. */
  readonly reasonCode: string;
}

const assertPolicyDecisions = (decisions: readonly NbaPolicyDecision[]): Map<NbaActionType, NbaPolicyDecision> => {
  const byAction = new Map<NbaActionType, NbaPolicyDecision>();
  for (const decision of decisions) {
    if (!(NBA_ACTIONS as readonly string[]).includes(decision.action)) {
      throw new DomainError('NBA_POLICY_DECISION_INVALID', `policy decision for unknown action: ${String(decision.action)}`, {
        action: String(decision.action),
        allowed: NBA_ACTIONS,
      });
    }
    if (!['allow', 'deny', 'requires_approval'].includes(decision.decision)) {
      throw new DomainError('NBA_POLICY_DECISION_INVALID', `unknown policy decision: ${String(decision.decision)}`, {
        action: decision.action,
        decision: String(decision.decision),
        allowed: ['allow', 'deny', 'requires_approval'],
      });
    }
    if (typeof decision.reasonCode !== 'string' || decision.reasonCode.trim().length === 0) {
      throw new DomainError('NBA_POLICY_DECISION_INVALID', 'a policy decision requires a non-blank reasonCode', {
        action: decision.action,
      });
    }
    if (byAction.has(decision.action)) {
      throw new DomainError('NBA_POLICY_DECISION_DUPLICATE', `more than one policy decision for action ${decision.action}`, {
        action: decision.action,
      });
    }
    byAction.set(decision.action, decision);
  }
  return byAction;
};

// --- weights / caps validation ---------------------------------------------------------

const assertWeights = (weights: NbaWeights): NbaWeights => {
  const assertRecord = (record: Readonly<Record<NbaActionType, number>>, label: string, max: number | null): void => {
    for (const action of NBA_ACTIONS) {
      const value = record[action];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new DomainError('NBA_WEIGHTS_INVALID', `weights.${label}.${action} must be a safe integer ≥ 0, got ${String(value)}`, {
          field: `${label}.${action}`,
        });
      }
      if (max !== null && value > max) {
        throw new DomainError('NBA_WEIGHTS_INVALID', `weights.${label}.${action} must be ≤ ${max}, got ${String(value)}`, {
          field: `${label}.${action}`,
        });
      }
    }
  };
  assertRecord(weights.recoveryRateBps, 'recoveryRateBps', 10000);
  assertRecord(weights.costMinor, 'costMinor', null);
  assertRecord(weights.fatiguePenaltyMinor, 'fatiguePenaltyMinor', null);
  if (typeof weights.fatigueWindowDays !== 'number' || !Number.isSafeInteger(weights.fatigueWindowDays) || weights.fatigueWindowDays < 0) {
    throw new DomainError('NBA_WEIGHTS_INVALID', `weights.fatigueWindowDays must be a safe integer ≥ 0, got ${String(weights.fatigueWindowDays)}`, {
      field: 'fatigueWindowDays',
    });
  }
  for (const [field, value] of [
    ['channelFitOptedInPermill', weights.channelFitOptedInPermill],
    ['channelFitNeutralPermill', weights.channelFitNeutralPermill],
    ['channelFitOptedOutPermill', weights.channelFitOptedOutPermill],
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1000) {
      throw new DomainError('NBA_WEIGHTS_INVALID', `weights.${field} must be a safe integer in 0..1000, got ${String(value)}`, {
        field,
      });
    }
  }
  if (
    typeof weights.approvalFrictionMinor !== 'number' ||
    !Number.isSafeInteger(weights.approvalFrictionMinor) ||
    weights.approvalFrictionMinor < 0
  ) {
    throw new DomainError('NBA_WEIGHTS_INVALID', `weights.approvalFrictionMinor must be a safe integer ≥ 0, got ${String(weights.approvalFrictionMinor)}`, {
      field: 'approvalFrictionMinor',
    });
  }
  return weights;
};

const assertCaps = (caps: Partial<Record<NbaActionType, number>>): Partial<Record<NbaActionType, number>> => {
  for (const [action, cap] of Object.entries(caps)) {
    if (!(NBA_ACTIONS as readonly string[]).includes(action)) {
      throw new DomainError('NBA_CAPS_INVALID', `cap for unknown action: ${action}`, { action });
    }
    if (action === 'do_nothing') {
      throw new DomainError('NBA_CAPS_INVALID', 'do_nothing can never be capped — it is the graceful fallback', {
        action,
      });
    }
    if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0) {
      throw new DomainError('NBA_CAPS_INVALID', `cap for ${action} must be a safe integer ≥ 0, got ${String(cap)}`, {
        action,
        cap: String(cap),
      });
    }
  }
  return caps;
};

// --- plan shapes ------------------------------------------------------------------------

export type NbaCandidateStatus = 'eligible' | 'denied' | 'requires_approval' | 'fatigue_capped';

/** One named bps factor of the signal fold — the explainability evidence. */
export interface NbaSignalFactor {
  readonly name: string;
  readonly bps: number;
}

/** The fully-exposed computation behind one candidate's score. */
export interface NbaScoredCandidate {
  readonly action: NbaActionType;
  readonly score: number;
  readonly status: NbaCandidateStatus;
  readonly components: {
    readonly expectedRecoveryMinor: number;
    readonly signalBps: number;
    readonly signalFactors: readonly NbaSignalFactor[];
    readonly channelFitPermill: number;
    readonly weightedRecoveryMinor: number;
    readonly costMinor: number;
    readonly approvalFrictionMinor: number;
    readonly fatigueCount: number;
    readonly fatiguePenaltyMinor: number;
  };
  /** Human-readable derivation lines — every number above, spelled out. */
  readonly reasons: readonly string[];
}

export interface NbaRankedPlan {
  readonly planId: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId: Uuid;
  readonly amountMinor: number;
  readonly currency: Currency;
  /** ISO-8601 — from the injected Clock. */
  readonly createdAt: string;
  /**
   * The next-best action: the top-ranked candidate policy permits. Null
   * only when policy denied EVERY candidate (including do_nothing) — NBA
   * never bypasses policy, so "no legal action" is a possible answer.
   */
  readonly recommended: NbaScoredCandidate | null;
  /** All candidates, best-first (denied/capped included and flagged). */
  readonly ranked: readonly NbaScoredCandidate[];
  /** The full weight set IN FORCE for this plan (issue #36: weights exposed in the result). */
  readonly weights: NbaWeights;
  /** The per-action fatigue caps IN FORCE (`do_nothing` is never capped). */
  readonly caps: Partial<Record<NbaActionType, number>>;
  readonly events: readonly [NbaEvent & { name: 'nba.recommendationCreated' }];
}

// --- deterministic plan ids (same technique as payments/ids.ts, local copy) --------------

const FNV_OFFSET = 0x811c9dc5n;
const FNV_PRIME = 0x01000193n;
const WORD_MASK = 0xffffffffn;

const fnv1a32 = (round: number, input: string): bigint => {
  let hash = FNV_OFFSET ^ BigInt(round);
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & WORD_MASK;
  }
  return hash;
};

/** Deterministic UUID-shaped id from a seed — replaying a plan coincides. */
const uuidFromSeed = (seed: string): Uuid => {
  const w = (round: number): string => fnv1a32(round, seed).toString(16).padStart(8, '0');
  return uuid(`${w(0)}-${w(1).slice(0, 4)}-${w(1).slice(4, 8)}-${w(2).slice(0, 4)}-${w(2).slice(4, 8)}${w(3)}`);
};

// --- scoring -----------------------------------------------------------------------------

const buildReasons = (
  action: NbaActionType,
  amountMinor: number,
  rateBps: number,
  components: NbaScoredCandidate['components'],
  weights: NbaWeights,
  policyLine: string | null,
  capped: boolean,
  cap: number | undefined,
): readonly string[] => {
  const reasons: string[] = [];
  if (action === 'do_nothing') {
    reasons.push('expected_recovery: 0 — no action taken, nothing collected');
  } else {
    const first = scaleBps(amountMinor, rateBps);
    const factorText = components.signalFactors.map((f) => `${f.name} ${f.bps}`).join(', ');
    reasons.push(
      `expected_recovery: floor(amount ${amountMinor} × rate ${rateBps}bps) = ${first}; ` +
        `signal ${components.signalBps}bps (${factorText}) → ${components.expectedRecoveryMinor}`,
    );
    reasons.push(`channel_fit: ${components.channelFitPermill}‰`);
    reasons.push(`weighted: floor(${components.expectedRecoveryMinor} × ${components.channelFitPermill}‰) = ${components.weightedRecoveryMinor}`);
  }
  reasons.push(`cost: −${components.costMinor} (${action})`);
  if (components.approvalFrictionMinor > 0) {
    reasons.push(`approval_friction: −${components.approvalFrictionMinor} (requires_approval)`);
  }
  if (components.fatigueCount > 0) {
    reasons.push(
      `fatigue: ${components.fatigueCount} recent ${action} within ${weights.fatigueWindowDays}d → −${components.fatiguePenaltyMinor}`,
    );
  }
  if (capped && cap !== undefined) {
    reasons.push(`cap: ${components.fatigueCount}/${cap} recent ${action} within ${weights.fatigueWindowDays}d — exhausted, excluded from recommendation`);
  }
  if (policyLine !== null) reasons.push(policyLine);
  if (action === 'do_nothing') {
    reasons.push('always scores 0: zero recovery, zero cost, zero fatigue — wins when every other candidate scores ≤ 0');
  }
  reasons.push(`score = ${components.weightedRecoveryMinor - components.costMinor - components.approvalFrictionMinor - components.fatiguePenaltyMinor}`);
  return reasons;
};

// --- the engine ----------------------------------------------------------------------------

export interface RankOptions {
  readonly clock: Clock;
  /** Replace the shipped weight set (all-or-nothing — validated). */
  readonly weights?: NbaWeights;
  /** Replace the shipped caps (validated; do_nothing cannot be capped). */
  readonly caps?: Partial<Record<NbaActionType, number>>;
  /** F20-shape policy decisions; absence of a decision counts as allow. */
  readonly policyDecisions?: readonly NbaPolicyDecision[];
}

/**
 * Rank the next-best action for one feature bundle. Pure: data in → plan
 * out, with exactly one `nba.recommendationCreated` event in the result.
 * Throws stable `NBA_*` codes on malformed input; never on "nothing to do"
 * — that is do_nothing's job (or `recommended: null` when policy denies all).
 */
export function rankNextBestActions(
  bundle: NbaFeatureBundle,
  options: RankOptions,
): NbaRankedPlan {
  const now = options.clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('NBA_CLOCK_INVALID', 'the injected Clock returned an invalid Date', {});
  }
  const validBundle = validateNbaFeatureBundle(bundle);
  const weights = assertWeights(options.weights ?? DEFAULT_NBA_WEIGHTS);
  const caps = assertCaps(options.caps ?? DEFAULT_ACTION_CAPS);
  const policy = assertPolicyDecisions(options.policyDecisions ?? []);

  const occurredAt = now.toISOString();
  const planId = uuidFromSeed(
    `nba|${validBundle.orgId}|${validBundle.customerId}|${validBundle.receivableId}|${validBundle.amountMinor}|${occurredAt}`,
  );

  const scored: NbaScoredCandidate[] = NBA_ACTIONS.map((action) => {
    const rateBps = weights.recoveryRateBps[action];
    const factors = signalFactorsOf(validBundle, action);
    const signalBps = foldBps(factors.map((f) => f.bps));
    const afterRate = scaleBps(validBundle.amountMinor, rateBps);
    const expectedRecovery = scaleBps(afterRate, signalBps);
    const fit = channelFitPermillOf(validBundle, action, weights);
    const weighted = scalePermill(expectedRecovery, fit);
    const cost = weights.costMinor[action];

    const fatigueCount =
      action === 'do_nothing'
        ? 0
        : (validBundle.recentActions ?? []).filter((r) => r.action === action && r.daysAgo <= weights.fatigueWindowDays).length;
    const fatiguePenalty = fatigueCount * weights.fatiguePenaltyMinor[action];
    const cap = caps[action];
    const capped = action !== 'do_nothing' && cap !== undefined && fatigueCount >= cap;

    const decision = policy.get(action) ?? null;
    const approvalFriction = decision?.decision === 'requires_approval' ? weights.approvalFrictionMinor : 0;
    // Status precedence: a policy deny is the hardest gate (it wins over
    // fatigue so the denial evidence is never masked); a cap outranks
    // requires_approval (an exhausted action cannot run, approval or not).
    const status: NbaCandidateStatus =
      decision?.decision === 'deny'
        ? 'denied'
        : capped
          ? 'fatigue_capped'
          : decision?.decision === 'requires_approval'
            ? 'requires_approval'
            : 'eligible';

    const components = {
      expectedRecoveryMinor: expectedRecovery,
      signalBps,
      signalFactors: factors,
      channelFitPermill: fit,
      weightedRecoveryMinor: weighted,
      costMinor: cost,
      approvalFrictionMinor: approvalFriction,
      fatigueCount,
      fatiguePenaltyMinor: fatiguePenalty,
    };
    const score = weighted - cost - approvalFriction - fatiguePenalty;

    const policyLine =
      decision === null
        ? null
        : decision.decision === 'deny'
          ? `policy: denied (${decision.reasonCode}) — excluded from recommendation; NBA never bypasses policy`
          : decision.decision === 'requires_approval'
            ? `policy: requires_approval (${decision.reasonCode}) — downgraded by approval friction, runs only after sign-off`
            : `policy: allow (${decision.reasonCode})`;

    return {
      action,
      score,
      status,
      components,
      reasons: buildReasons(action, validBundle.amountMinor, rateBps, components, weights, policyLine, capped, cap),
    };
  });

  // Best first; ties break by the canonical NBA_ACTIONS order (stable rule).
  const ranked = [...scored].sort(
    (a, b) => b.score - a.score || NBA_ACTIONS.indexOf(a.action) - NBA_ACTIONS.indexOf(b.action),
  );
  const recommended = ranked.find((c) => c.status === 'eligible' || c.status === 'requires_approval') ?? null;

  const alternatives: RecommendationAlternative[] = ranked
    .filter((c) => c !== recommended && (c.status === 'eligible' || c.status === 'requires_approval'))
    .map((c) => ({ action: c.action, score: c.score }));
  const policyEvidence: PolicyDenialEvidence[] = ranked
    .filter((c) => c.status === 'denied' || c.status === 'requires_approval')
    .map((c) => ({
      action: c.action,
      reasonCode: policy.get(c.action)?.reasonCode ?? '',
      decision: c.status === 'denied' ? 'deny' : 'requires_approval',
    }));

  const payload: NbaRecommendationCreatedPayload = {
    planId,
    orgId: validBundle.orgId,
    customerId: validBundle.customerId,
    receivableId: validBundle.receivableId,
    amountMinor: validBundle.amountMinor,
    currency: validBundle.currency,
    recommendedAction: recommended?.action ?? null,
    recommendedScore: recommended?.score ?? 0,
    alternatives,
    policyEvidence,
    createdAt: occurredAt,
  };

  return {
    planId,
    orgId: validBundle.orgId,
    customerId: validBundle.customerId,
    receivableId: validBundle.receivableId,
    amountMinor: validBundle.amountMinor,
    currency: validBundle.currency,
    createdAt: occurredAt,
    recommended,
    ranked,
    weights,
    caps,
    events: [domainEvent<'nba.recommendationCreated', NbaRecommendationCreatedPayload>('nba.recommendationCreated', planId, payload, options.clock)],
  };
}
