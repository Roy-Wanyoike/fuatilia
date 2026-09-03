/**
 * The policy engine — deterministic action governance (issue #34, VISION §3.9).
 *
 *   AI → recommendation → POLICY ENGINE → allow | deny | requires_approval → execution
 *
 * `evaluate` is a PURE function of (ActionRequest, PolicyRuleSet, Clock):
 * the same rules, the same request and the same instant ALWAYS produce the
 * same decision and the same audit event (deterministic replay — the clock
 * is injected, never read). It never mutates its inputs (rule sets are
 * deep-frozen at creation; the request is read-only) and it never performs
 * I/O.
 *
 * Evaluation order:
 *
 *   1. the request must be structurally valid (malformed input throws a
 *      stable POLICY_* code — a bug, not a governance outcome);
 *   2. the rule set must be a well-formed reference (lightweight — full
 *      validation happened once, at creation) and belong to the request's
 *      org (mismatch throws);
 *   3. engine pre-guards, fail-closed, BEFORE any rule runs:
 *        - unknown actionType            → deny POLICY_ACTION_UNKNOWN
 *          (safe by default — an automation inventing an action type gets a
 *          governed refusal and an audit record, never an exception it could
 *          crash past); the pre-guards run BEFORE the rule set, so even a
 *          permissive custom rule set cannot allow-list an unknown action;
 *        - write_off/refund with no amount → deny POLICY_AMOUNT_REQUIRED
 *          (fail-closed: an unquantified loss never passes the gate);
 *        - a channel that contradicts the action type (send_whatsapp over
 *          sms) → deny POLICY_CHANNEL_ACTION_MISMATCH;
 *   4. FIRST MATCH WINS over the rule set's priority-ordered rules (lower
 *      priority number first; priorities are unique, so the order is total);
 *      the engine re-sorts defensively by priority — sorting never mutates
 *      the frozen rule set;
 *   5. no rule matched → deny POLICY_NO_RULE_MATCHED — silence never
 *      widens permissions.
 *
 * EVERY evaluation — allow, deny AND requires_approval — records the
 * `policy.decisionRecorded` audit event (narrow, PII-free payload), because
 * refusals and approval demands are first-class facts (mirrors
 * collections.dunningBlockedNoConsent / comms.sendBlockedNoConsent).
 *
 * Explicitly OUT OF SCOPE (issue #34): executing anything, talking to the
 * consent registry (callers pass plain-data facts), auth/RBAC (the caller is
 * an opaque actor id + type). An `allow` here does not mean "sent" —
 * downstream gates (comms K2 guard, execution lanes) still apply.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  ACTION_TYPES,
  IMPLIED_CHANNEL,
  assertActionRequest,
  effectiveChannel,
  type ActionRequest,
} from './request';
import {
  actionRequiresAmount,
  assertRuleSetReference,
  conditionMatches,
  deepFreeze,
  type Decision,
  type DecisionConditions,
  type PolicyRule,
  type PolicyRuleSet,
} from './rules';
import {
  POLICY_DECISION_RECORDED,
  domainEvent,
  minorToNumber,
  type DecisionRecordedEvent,
  type DecisionRecordedPayload,
} from './events';

// --- engine reason codes (stable, machine-readable) -----------------------------------

/** The requested action type is not in the governed vocabulary — denied, safe by default. */
export const POLICY_ACTION_UNKNOWN = 'POLICY_ACTION_UNKNOWN';
/** No rule in the (custom) rule set matched — denied, fail-closed. */
export const POLICY_NO_RULE_MATCHED = 'POLICY_NO_RULE_MATCHED';
/** A write_off/refund was requested without an amount — denied, fail-closed. */
export const POLICY_AMOUNT_REQUIRED = 'POLICY_AMOUNT_REQUIRED';
/** The requested channel contradicts the action type (send_whatsapp over sms). */
export const POLICY_CHANNEL_ACTION_MISMATCH = 'POLICY_CHANNEL_ACTION_MISMATCH';

// --- the decision ----------------------------------------------------------------------

/**
 * The governed outcome of ONE action request. `matchedRuleIds` is the audit
 * trail (the winning rule; empty for engine pre-guard denials).
 * `conditions` carries the bounds the decision travels with (max amount,
 * allowed channels, expiry) — null for denials, a refusal grants nothing.
 */
export interface PolicyDecision {
  readonly decision: Decision;
  /** Stable POLICY_* machine reason. */
  readonly reasonCode: string;
  /** Human-readable explanation (goes to reviewers/approvers, NOT into the narrow event payload). */
  readonly explanation: string;
  readonly matchedRuleIds: readonly string[];
  readonly conditions: DecisionConditions | null;
  readonly orgId: Uuid;
  readonly ruleSetVersion: number;
  /** ISO-8601 — evaluation instant, from the injected Clock. */
  readonly requestedAt: string;
  /** `policy.decisionRecorded` — emit exactly this, for EVERY evaluation. */
  readonly event: DecisionRecordedEvent;
}

const assertClockDate = (at: Date): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError('POLICY_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return at;
};

/** A rule matches when its actionType scope covers the request AND all its conditions (AND) hold. */
const ruleMatches = (rule: PolicyRule, request: ActionRequest, now: Date): boolean =>
  (rule.actionType === 'any' || rule.actionType === request.actionType) &&
  rule.conditions.every((condition) => conditionMatches(condition, request, now));

/**
 * Evaluate one action request against one org's rule set.
 *
 * Throws (caller bugs, not governance outcomes):
 *   - POLICY_CLOCK_INVALID — broken injected clock;
 *   - everything assertActionRequest throws (POLICY_REQUEST_INVALID,
 *     POLICY_ORG_REQUIRED, POLICY_CUSTOMER_REQUIRED, POLICY_SUBJECT_INVALID,
 *     POLICY_ACTOR_REQUIRED, POLICY_ACTOR_TYPE_INVALID,
 *     POLICY_AUTONOMY_MISMATCH, POLICY_ACTION_TYPE_INVALID,
 *     POLICY_AMOUNT_INVALID, POLICY_CURRENCY_INVALID,
 *     POLICY_RISK_CLASS_INVALID, POLICY_CHANNEL_INVALID,
 *     POLICY_REQUEST_FLAG_INVALID);
 *   - POLICY_RULESET_INVALID / POLICY_RULESET_ORG_REQUIRED /
 *     POLICY_RULESET_VERSION_INVALID — a structurally broken rule set;
 *   - POLICY_RULESET_ORG_MISMATCH — the rule set belongs to another org.
 */
export function evaluate(
  request: ActionRequest,
  ruleSet: PolicyRuleSet,
  clock: Clock,
): PolicyDecision {
  // ONE Clock read per evaluation: the decision's requestedAt and the audit
  // event's occurredAt are THE SAME instant, so a replay of (request, rule
  // set, clock instant) is bit-for-bit reproducible.
  const now = assertClockDate(clock.now());
  assertActionRequest(request);
  assertRuleSetReference(ruleSet);
  if (ruleSet.orgId !== request.orgId) {
    throw new DomainError(
      'POLICY_RULESET_ORG_MISMATCH',
      `rule set belongs to org ${ruleSet.orgId}, but the request targets org ${request.orgId}`,
      { ruleSetOrgId: ruleSet.orgId, requestOrgId: request.orgId },
    );
  }

  const requestedAt = now.toISOString();

  const decide = (
    decision: Decision,
    reasonCode: string,
    explanation: string,
    matchedRuleIds: readonly string[],
    conditions: DecisionConditions | null,
  ): PolicyDecision => {
    const channel = effectiveChannel(request);
    const payload: DecisionRecordedPayload = {
      orgId: request.orgId,
      customerId: request.customerId,
      receivableId: request.receivableId,
      caseId: request.caseId,
      actionType: request.actionType,
      actorType: request.actor.type,
      autonomous: request.autonomous,
      riskClass: request.riskClass,
      amountMinor: request.amountMinor === null ? null : minorToNumber(request.amountMinor),
      currency: request.currency,
      channel,
      decision,
      reasonCode,
      matchedRuleIds,
      ruleSetVersion: ruleSet.version,
      requestedAt,
    };
    const event = domainEvent(POLICY_DECISION_RECORDED, request.orgId, payload, { now: () => now });
    return deepFreeze({
      decision,
      reasonCode,
      explanation,
      matchedRuleIds,
      conditions,
      orgId: request.orgId,
      ruleSetVersion: ruleSet.version,
      requestedAt,
      event,
    });
  };

  // --- pre-guard 1: unknown action types are governed refusals, never crashes -----
  if (!(ACTION_TYPES as readonly string[]).includes(request.actionType)) {
    return decide(
      'deny',
      POLICY_ACTION_UNKNOWN,
      `action type "${request.actionType}" is not recognized — denied (safe by default)`,
      [],
      null,
    );
  }

  // --- pre-guard 2: money-losing actions need an amount ----------------------------
  if (actionRequiresAmount(request.actionType) && request.amountMinor === null) {
    return decide(
      'deny',
      POLICY_AMOUNT_REQUIRED,
      `${request.actionType} requires an amount — denied (fail-closed: an unquantified loss is never approved)`,
      [],
      null,
    );
  }

  // --- pre-guard 3: the channel must not contradict the action type ----------------
  const requiredChannel = IMPLIED_CHANNEL[request.actionType as keyof typeof IMPLIED_CHANNEL];
  if (request.channel !== null && requiredChannel !== undefined && request.channel !== requiredChannel) {
    return decide(
      'deny',
      POLICY_CHANNEL_ACTION_MISMATCH,
      `${request.actionType} operates on ${requiredChannel}, but the request asked for ${request.channel}`,
      [],
      null,
    );
  }

  // --- first match wins -------------------------------------------------------------
  // createRuleSet already orders rules by ascending priority; the defensive
  // copy-sort keeps the documented total order even for hand-built rule sets
  // and never touches the frozen original. Array#sort is stable and the
  // priorities are unique, so the order — and therefore the decision — is
  // deterministic.
  const ordered = [...ruleSet.rules].sort((a, b) => a.priority - b.priority);
  const matched = ordered.find((rule) => ruleMatches(rule, request, now));
  if (matched === undefined) {
    return decide(
      'deny',
      POLICY_NO_RULE_MATCHED,
      `no rule in rule set v${ruleSet.version} matched — denied (fail-closed: silence never widens permissions)`,
      [],
      null,
    );
  }

  const conditions =
    matched.decision === 'deny' ? null : (matched.grants ?? null);
  return decide(
    matched.decision,
    matched.reasonCode,
    matched.explanation,
    [matched.id],
    conditions,
  );
}
