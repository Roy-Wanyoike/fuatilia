/**
 * The STK-push gate — consent FIRST, then the policy engine (RICE #2).
 *
 *   proposal → CONSENT GATE (DPA 2019) → POLICY ENGINE → allow |
 *              requires_approval → execution …or the refusal record.
 *
 * Consent first, deliberately: an STK push is an automated outbound dunning
 * contact on the customer's handset, so before the request is even BUILT the
 * lane asks the existing consent-lane guard (`assertCanContact`, the pure
 * K2/K3 decision boundary) whether an active (customer, sms, dunning) grant
 * covers it. A refusal there is final — the DPA forbids the attempt, so the
 * policy engine never sees it (the request would carry consentPresent: true
 * only because the gate already proved it). The typed refusal reason
 * (NO_GRANT | REVOKED | WRONG_PURPOSE | WRONG_CHANNEL) travels verbatim as
 * the machine-readable reason.
 *
 * Then the EXISTING deterministic policy engine evaluates a real
 * `ActionRequest` (actionType `collect_now_stk_push`, amount in minor units,
 * sms channel, autonomous flag, plain-fact dispute/promise context) against
 * the org's rule set and answers allow | deny | requires_approval with a
 * machine-readable reason code, matched-rule audit trail and its OWN
 * `policy.decisionRecorded` event — which this gate emits for EVERY
 * evaluation. The engine's safe-by-default pre-guard denies the action type
 * until the policy lane registers `collect_now_stk_push` in its governed
 * vocabulary (reported cross-lane follow-up); the gate handles all three
 * outcomes deterministically either way, so the lane is correct the moment
 * the vocabulary lands.
 *
 * Everything is pure: no I/O, no registry access (grants are plain data the
 * caller projected), no Date.now() — the injected Clock stamps everything.
 */
import type { Clock } from '../../shared';
import { assertCanContact } from '../../consent/guard';
import type { ConsentGrant } from '../../consent/consent-grant';
import type { RefusalReason } from '../../consent/guard';
import { evaluate } from '../../policy/engine';
import type { PolicyDecision } from '../../policy/engine';
import type { ActionRequest } from '../../policy/request';
import type { DecisionRecordedEvent } from '../../policy/events';
import type { PolicyRuleSet } from '../../policy/rules';
import {
  applyStkPolicyDecision,
  STK_CONSENT_CHANNEL,
  STK_CONSENT_PURPOSE,
  STK_PUSH_ACTION_TYPE,
} from './actions';
import type { StkPushAction } from './actions';
import { domainEvent, type StkPushEvent, type StkPushRefusedPayload } from './events';

// --- the plain-fact context the caller projects ----------------------------------------

export interface StkPushGateFacts {
  /** The customer's consent registry rows (plain data — no registry access here). */
  readonly grants: readonly ConsentGrant[];
  /** The org's rule set version the engine evaluates against. */
  readonly ruleSet: PolicyRuleSet;
  /** Plain fact from the disputes lane (SPEC §29 pause). */
  readonly disputeOpen: boolean;
  /** Plain fact from the promises lane. */
  readonly promisePending: boolean;
}

export type StkPushGateOutcome =
  | { readonly kind: 'allowed'; readonly decision: PolicyDecision }
  | { readonly kind: 'approval_required'; readonly decision: PolicyDecision }
  | {
      readonly kind: 'refused';
      /** 'consent' — the DPA gate refused before the engine was consulted. */
      readonly stage: 'consent' | 'policy';
      readonly reasonCode: string;
      readonly detail: string;
      /** The engine's decision when stage === 'policy'; null for consent refusals. */
      readonly decision: PolicyDecision | null;
      /** The typed consent refusal reason when stage === 'consent'. */
      readonly consentReason: RefusalReason | null;
    };

export interface StkPushGateResult {
  /** The (possibly terminal) attempt after the gate. */
  readonly action: StkPushAction;
  readonly outcome: StkPushGateOutcome;
  /**
   * EVERY event the gate produced, in order: the engine's existing
   * `policy.decisionRecorded` audit fact (when the engine evaluated) plus
   * this lane's `stk.pushRefused` / `stk.pushAwaitingApproval` compliance
   * facts. Emit them exactly as returned.
   */
  readonly events: readonly (StkPushEvent | DecisionRecordedEvent)[];
}

/**
 * Build the real policy-engine request for one proposed attempt. Exported so
 * the agent/NBA lanes can preview the governance decision without executing.
 * `consentPresent` is always true HERE — the gate runs the DPA check before
 * building the request and refuses otherwise; building a request for an
 * unconsented customer is a caller bug the engine must never paper over.
 */
export const buildStkPushActionRequest = (
  action: StkPushAction,
  facts: Pick<StkPushGateFacts, 'disputeOpen' | 'promisePending'>,
): ActionRequest => ({
  orgId: action.orgId,
  customerId: action.customerId,
  receivableId: action.receivableId,
  caseId: action.caseId,
  actor: action.actor,
  actionType: STK_PUSH_ACTION_TYPE,
  amountMinor: Number(action.amount.amount),
  currency: 'KES',
  riskClass: action.riskClass,
  channel: STK_CONSENT_CHANNEL,
  consentPresent: true,
  disputeOpen: facts.disputeOpen,
  promisePending: facts.promisePending,
  autonomous: action.autonomous,
});

/**
 * Gate one proposed attempt: DPA consent (fail-closed, before anything
 * else), then the deterministic policy engine. On refusal the attempt flips
 * to `refused` with the machine-readable reason stamped on the aggregate AND
 * the `stk.pushRefused` compliance event emitted; on requires_approval it
 * parks at `awaiting_approval`; on allow it stays `proposed` with the
 * decision handle stamped (the SAME decision must be handed to
 * `initiateStkPush` as its clearance).
 *
 * Malformed input (bad risk class, broken clock, a rule set from another
 * org) throws the engine's/lane's stable codes — a bug, not a governance
 * outcome. Refusals are values.
 */
export function gateStkPush(
  action: StkPushAction,
  facts: StkPushGateFacts,
  clock: Clock,
): StkPushGateResult {
  // --- 1. the DPA gate (K2/K3): fail-closed, before the engine exists in the story.
  const consent = assertCanContact(
    facts.grants,
    { customerId: action.customerId, channel: STK_CONSENT_CHANNEL, purpose: STK_CONSENT_PURPOSE },
    clock,
  );
  if (!consent.allowed) {
    const now = clock.now();
    const payload: StkPushRefusedPayload = {
      actionId: action.actionId,
      orgId: action.orgId,
      customerId: action.customerId,
      receivableId: action.receivableId,
      caseId: action.caseId,
      stage: 'consent',
      reasonCode: consent.reason,
      detail: consent.detail,
      refusedAt: now.toISOString(),
    };
    const refused = domainEvent<'stk.pushRefused', StkPushRefusedPayload>(
      'stk.pushRefused',
      action.actionId,
      payload,
      clock,
    );
    const next: StkPushAction = {
      ...action,
      state: 'refused',
      refusal: { stage: 'consent', reasonCode: consent.reason, detail: consent.detail },
    };
    return {
      action: next,
      outcome: {
        kind: 'refused',
        stage: 'consent',
        reasonCode: consent.reason,
        detail: consent.detail,
        decision: null,
        consentReason: consent.reason,
      },
      events: [refused],
    };
  }

  // --- 2. the deterministic policy engine (existing evaluate contract).
  const request = buildStkPushActionRequest(action, facts);
  const decision = evaluate(request, facts.ruleSet, clock);
  const applied = applyStkPolicyDecision(action, decision, clock);

  if (decision.decision === 'deny') {
    return {
      action: applied.action,
      outcome: {
        kind: 'refused',
        stage: 'policy',
        reasonCode: decision.reasonCode,
        detail: decision.explanation,
        decision,
        consentReason: null,
      },
      events: [decision.event, ...applied.events],
    };
  }
  if (decision.decision === 'requires_approval') {
    return {
      action: applied.action,
      outcome: { kind: 'approval_required', decision },
      events: [decision.event, ...applied.events],
    };
  }
  return {
    action: applied.action,
    outcome: { kind: 'allowed', decision },
    events: [decision.event],
  };
}
