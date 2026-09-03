/**
 * The policy engine — table-driven decision matrix, precedence, safe-by-default,
 * conditions propagation, audit event shape, determinism and no-mutation pins
 * (issue #34, VISION §3.9).
 */
import { describe, expect, it } from 'vitest';
import { DomainError, uuid, type Clock, type Uuid } from '../shared';
import {
  POLICY_AUTONOMOUS_LOW_RISK,
  POLICY_CHANNEL_REQUIRED,
  POLICY_CONSENT_REQUIRED,
  POLICY_DISPUTE_OPEN,
  POLICY_REFUND_APPROVAL_REQUIRED,
  POLICY_RISK_APPROVAL_REQUIRED,
  POLICY_SUPERVISED_ACTION,
  POLICY_WRITE_OFF_APPROVAL_REQUIRED,
  createRuleSet,
  defaultRuleSetFor,
  nextVersion,
  type PolicyRule,
  type PolicyRuleSet,
} from './rules';
import { evaluate, POLICY_AMOUNT_REQUIRED, POLICY_ACTION_UNKNOWN, POLICY_CHANNEL_ACTION_MISMATCH, POLICY_NO_RULE_MATCHED, type PolicyDecision } from './engine';
import type { ActionRequest } from './request';

// --- fixtures -----------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const OTHER_ORG = uid(9);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);
const CASE = uid(4);
const T0 = '2026-03-04T10:30:00.000Z'; // Wednesday, minute 630 of the UTC day
const T1 = '2026-03-04T19:30:00.000Z'; // same day, minute 1170 (past an 18:00 window edge)
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock = at(T0);

/** One autonomous ai_agent request — the baseline automation case. */
const baseRequest = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  orgId: ORG,
  customerId: CUSTOMER,
  receivableId: RECEIVABLE,
  caseId: null,
  actor: { type: 'ai_agent', actorId: 'agent-1' },
  actionType: 'send_whatsapp',
  amountMinor: null,
  currency: null,
  riskClass: 'low',
  channel: null,
  consentPresent: true,
  disputeOpen: false,
  promisePending: false,
  autonomous: true,
  ...over,
});

/** The default rule set, evaluated at a fixed instant. */
const defaults = defaultRuleSetFor(ORG, clock);

/** One human-supervised request against the defaults — the baseline "fine" case. */
const supervised = (over: Partial<ActionRequest> = {}): ActionRequest =>
  baseRequest({ actor: { type: 'human', actorId: 'collector-7' }, autonomous: false, ...over });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the full decision matrix (actor × action × amount × risk × consent × dispute × channel) --

describe('decision matrix over the default rule set', () => {
  interface Row {
    readonly label: string;
    readonly request: ActionRequest;
    readonly decision: PolicyDecision['decision'];
    readonly reasonCode: string;
  }

  const W_OFF = 10_000_000; // exactly at the write-off approval line
  const W_OVER = 10_000_001; // one minor unit past it
  const R_LINE = 5_000_000;
  const R_OVER = 5_000_001;

  const matrix: readonly Row[] = [
    // --- human-supervised actions: autonomy restrictions bypassed -------------
    { label: 'human send_reminder (email), low risk', request: supervised({ actionType: 'send_reminder', channel: 'email' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human offer_payment_plan, elevated risk', request: supervised({ actionType: 'offer_payment_plan', riskClass: 'elevated' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human escalate, high risk', request: supervised({ actionType: 'escalate', riskClass: 'high' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human issue_payment_link with amount', request: supervised({ actionType: 'issue_payment_link', amountMinor: 4_999, currency: 'KES' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'ai_agent supervised send without consent (a human is in the loop)', request: baseRequest({ actor: { type: 'ai_agent', actorId: 'a' }, autonomous: false, consentPresent: false }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'integration supervised send without consent', request: baseRequest({ actor: { type: 'integration', actorId: 'erp' }, autonomous: false, consentPresent: false, channel: 'email', actionType: 'send_reminder' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human action on a disputed receivable (automation pauses, humans do not)', request: supervised({ actionType: 'escalate', disputeOpen: true }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },

    // --- compliance rules bind EVERY actor, humans included --------------------
    { label: 'human write_off exactly at the threshold (> is strict)', request: supervised({ actionType: 'write_off', amountMinor: W_OFF, currency: 'KES' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human write_off one minor unit past the threshold', request: supervised({ actionType: 'write_off', amountMinor: W_OVER, currency: 'KES' }), decision: 'requires_approval', reasonCode: POLICY_WRITE_OFF_APPROVAL_REQUIRED },
    { label: 'ai write_off one minor unit past the threshold', request: baseRequest({ actionType: 'write_off', amountMinor: W_OVER, currency: 'KES' }), decision: 'requires_approval', reasonCode: POLICY_WRITE_OFF_APPROVAL_REQUIRED },
    { label: 'integration write_off one minor unit past the threshold', request: baseRequest({ actor: { type: 'integration', actorId: 'erp' }, actionType: 'write_off', amountMinor: W_OVER, currency: 'KES' }), decision: 'requires_approval', reasonCode: POLICY_WRITE_OFF_APPROVAL_REQUIRED },
    { label: 'human refund exactly at the threshold', request: supervised({ actionType: 'refund', amountMinor: R_LINE, currency: 'KES' }), decision: 'allow', reasonCode: POLICY_SUPERVISED_ACTION },
    { label: 'human refund one minor unit past the threshold', request: supervised({ actionType: 'refund', amountMinor: R_OVER, currency: 'KES' }), decision: 'requires_approval', reasonCode: POLICY_REFUND_APPROVAL_REQUIRED },

    // --- autonomous automation under the safe-by-default posture ----------------
    { label: 'autonomous low-risk whatsapp with consent', request: baseRequest(), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous low-risk sms with consent', request: baseRequest({ actionType: 'send_sms' }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous low-risk send_reminder naming email', request: baseRequest({ actionType: 'send_reminder', channel: 'email' }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous low-risk payment-plan offer', request: baseRequest({ actionType: 'offer_payment_plan' }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous low-risk payment link with amount', request: baseRequest({ actionType: 'issue_payment_link', amountMinor: 1_000, currency: 'KES' }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'integration autonomous low-risk action', request: baseRequest({ actor: { type: 'integration', actorId: 'erp' } }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous send WITHOUT consent (K2)', request: baseRequest({ consentPresent: false }), decision: 'deny', reasonCode: POLICY_CONSENT_REQUIRED },
    { label: 'autonomous whatsapp send without consent, high risk (dispute rule does not mask consent)', request: baseRequest({ consentPresent: false, riskClass: 'high' }), decision: 'deny', reasonCode: POLICY_CONSENT_REQUIRED },
    { label: 'autonomous send_reminder without consent AND without channel (consent rule wins by priority)', request: baseRequest({ actionType: 'send_reminder', channel: null, consentPresent: false }), decision: 'deny', reasonCode: POLICY_CONSENT_REQUIRED },
    { label: 'autonomous send WITH consent but no channel (send_reminder is channel-generic)', request: baseRequest({ actionType: 'send_reminder', channel: null }), decision: 'deny', reasonCode: POLICY_CHANNEL_REQUIRED },
    { label: 'autonomous action while the receivable is disputed', request: baseRequest({ disputeOpen: true }), decision: 'deny', reasonCode: POLICY_DISPUTE_OPEN },
    { label: 'autonomous disputed action even with consent + low risk', request: baseRequest({ disputeOpen: true, consentPresent: true, riskClass: 'low' }), decision: 'deny', reasonCode: POLICY_DISPUTE_OPEN },
    { label: 'autonomous elevated-risk action', request: baseRequest({ riskClass: 'elevated' }), decision: 'requires_approval', reasonCode: POLICY_RISK_APPROVAL_REQUIRED },
    { label: 'autonomous high-risk action', request: baseRequest({ riskClass: 'high' }), decision: 'requires_approval', reasonCode: POLICY_RISK_APPROVAL_REQUIRED },
    { label: 'autonomous write_off at the threshold on a low-risk subject', request: baseRequest({ actionType: 'write_off', amountMinor: W_OFF, currency: 'KES' }), decision: 'allow', reasonCode: POLICY_AUTONOMOUS_LOW_RISK },
    { label: 'autonomous refund past the threshold wins over the risk rule (priority 101 < 120)', request: baseRequest({ actionType: 'refund', amountMinor: R_OVER, currency: 'KES', riskClass: 'high' }), decision: 'requires_approval', reasonCode: POLICY_REFUND_APPROVAL_REQUIRED },
  ];

  it.each(matrix)('$label', ({ request, decision, reasonCode }) => {
    const result = evaluate(request, defaults, clock);
    expect(result.decision).toBe(decision);
    expect(result.reasonCode).toBe(reasonCode);
  });

  it('matrix covers all three actors, all three risk classes and all three decisions', () => {
    const actors = new Set(matrix.map((r) => r.request.actor.type));
    const risks = new Set(matrix.map((r) => r.request.riskClass));
    const decisions = new Set(matrix.map((r) => r.decision));
    expect([...actors].sort()).toEqual(['ai_agent', 'human', 'integration']);
    expect([...risks].sort()).toEqual(['elevated', 'high', 'low']);
    expect([...decisions].sort()).toEqual(['allow', 'deny', 'requires_approval']);
  });
});

// --- engine pre-guards: fail-closed BEFORE any rule -------------------------------------

describe('engine pre-guards — safe by default, even against permissive custom rules', () => {
  /** A maximally permissive custom rule set: every known action, no conditions. */
  const allowAll = createRuleSet(
    ORG,
    1,
    [{ id: 'allow-everything', priority: 1, actionType: 'any', decision: 'allow', conditions: [], reasonCode: 'POLICY_ALLOW_ALL', explanation: 'custom permissive posture' }],
    clock,
  );

  it('an unknown actionType is a governed DENY, never an exception, never allow-listable', () => {
    const result = evaluate(baseRequest({ actionType: 'wipe_ledger' }), allowAll, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_ACTION_UNKNOWN);
    expect(result.matchedRuleIds).toEqual([]); // no rule ran — the engine refused
    expect(result.event.payload.reasonCode).toBe(POLICY_ACTION_UNKNOWN);
  });

  it.each(['wipe_ledger', 'send_fax', 'self_approve', ''])('unknown action "%s" denies even for a human actor', (actionType) => {
    const result = evaluate(supervised({ actionType }), allowAll, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_ACTION_UNKNOWN);
  });

  it('a write_off without an amount is denied (an unquantified loss is never governed)', () => {
    const result = evaluate(supervised({ actionType: 'write_off', amountMinor: null, currency: null }), allowAll, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_AMOUNT_REQUIRED);
    expect(result.matchedRuleIds).toEqual([]);
  });

  it('a refund without an amount is denied for automation too', () => {
    const result = evaluate(baseRequest({ actionType: 'refund', amountMinor: null, currency: null }), allowAll, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_AMOUNT_REQUIRED);
  });

  it.each([
    ['send_whatsapp over sms', 'send_whatsapp', 'sms' as const],
    ['send_whatsapp over email', 'send_whatsapp', 'email' as const],
    ['send_sms over whatsapp', 'send_sms', 'whatsapp' as const],
    ['send_sms over email', 'send_sms', 'email' as const],
  ])('%s is a channel/action contradiction', (_label, actionType, channel) => {
    const result = evaluate(baseRequest({ actionType, channel }), allowAll, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_CHANNEL_ACTION_MISMATCH);
  });

  it('a send_whatsapp implying whatsapp is NOT a mismatch', () => {
    const result = evaluate(baseRequest({ actionType: 'send_whatsapp', channel: null }), allowAll, clock);
    expect(result.decision).toBe('allow');
    expect(result.reasonCode).toBe('POLICY_ALLOW_ALL');
  });

  it('an empty rule set denies everything it is asked about (fail-closed)', () => {
    const empty = createRuleSet(ORG, 1, [], clock);
    const result = evaluate(baseRequest(), empty, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_NO_RULE_MATCHED);
    expect(result.matchedRuleIds).toEqual([]);
  });

  it('silence never widens permissions: a rule set without a covering rule denies', () => {
    const narrow = createRuleSet(
      ORG,
      1,
      [{ id: 'only-reminders', priority: 1, actionType: 'send_reminder', decision: 'allow', conditions: [], reasonCode: 'POLICY_REMIND_OK', explanation: 'reminders only' }],
      clock,
    );
    const result = evaluate(baseRequest({ actionType: 'offer_payment_plan' }), narrow, clock);
    expect(result.decision).toBe('deny');
    expect(result.reasonCode).toBe(POLICY_NO_RULE_MATCHED);
  });
});

// --- first-match-wins precedence over custom rule sets ------------------------------------

describe('first-match-wins precedence', () => {
  it('the lowest-priority matching rule wins', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [
        { id: 'loose-allow', priority: 100, actionType: 'any', decision: 'allow', conditions: [], reasonCode: 'POLICY_LOOSE_ALLOW', explanation: 'loose' },
        { id: 'strict-deny', priority: 10, actionType: 'any', decision: 'deny', conditions: [{ field: 'riskClass', op: 'eq', value: 'high' }], reasonCode: 'POLICY_STRICT_DENY', explanation: 'strict' },
      ],
      clock,
    );
    const denied = evaluate(baseRequest({ riskClass: 'high' }), ruleSet, clock);
    expect(denied.decision).toBe('deny');
    expect(denied.reasonCode).toBe('POLICY_STRICT_DENY');
    expect(denied.matchedRuleIds).toEqual(['strict-deny']);

    const allowed = evaluate(baseRequest({ riskClass: 'low' }), ruleSet, clock);
    expect(allowed.decision).toBe('allow');
    expect(allowed.matchedRuleIds).toEqual(['loose-allow']);
  });

  it('precedence follows priority, not array order', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [
        { id: 'later-in-array-wins', priority: 5, actionType: 'any', decision: 'requires_approval', conditions: [], reasonCode: 'POLICY_SECOND', explanation: 'second' },
        { id: 'earlier-in-array-loses', priority: 50, actionType: 'any', decision: 'allow', conditions: [], reasonCode: 'POLICY_FIRST', explanation: 'first' },
      ],
      clock,
    );
    const result = evaluate(baseRequest(), ruleSet, clock);
    expect(result.matchedRuleIds).toEqual(['later-in-array-wins']);
    expect(result.reasonCode).toBe('POLICY_SECOND');
  });

  it('priority decides, specificity does not (a specific rule can lose to any)', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [
        { id: 'any-deny', priority: 1, actionType: 'any', decision: 'deny', conditions: [{ field: 'disputeOpen', op: 'is_true' }], reasonCode: 'POLICY_ANY_DENY', explanation: 'any' },
        { id: 'specific-allow', priority: 2, actionType: 'send_whatsapp', decision: 'allow', conditions: [{ field: 'disputeOpen', op: 'is_true' }], reasonCode: 'POLICY_SPECIFIC_ALLOW', explanation: 'specific' },
      ],
      clock,
    );
    const result = evaluate(baseRequest({ disputeOpen: true }), ruleSet, clock);
    expect(result.matchedRuleIds).toEqual(['any-deny']);
  });

  it('conditions are AND — a rule fires only when every condition holds', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [
        { id: 'double-condition', priority: 1, actionType: 'any', decision: 'allow', conditions: [{ field: 'consentPresent', op: 'is_true' }, { field: 'promisePending', op: 'is_false' }], reasonCode: 'POLICY_BOTH', explanation: 'both' },
      ],
      clock,
    );
    expect(evaluate(baseRequest({ promisePending: false }), ruleSet, clock).reasonCode).toBe('POLICY_BOTH');
    const noMatch = evaluate(baseRequest({ promisePending: true }), ruleSet, clock);
    expect(noMatch.decision).toBe('deny');
    expect(noMatch.reasonCode).toBe(POLICY_NO_RULE_MATCHED);
  });

  it('a rule scoped to one actionType does not fire for another', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [
        { id: 'reminders-only', priority: 1, actionType: 'send_reminder', decision: 'allow', conditions: [], reasonCode: 'POLICY_REMIND_OK', explanation: 'reminders' },
      ],
      clock,
    );
    expect(evaluate(baseRequest({ actionType: 'send_reminder', channel: 'email' }), ruleSet, clock).decision).toBe('allow');
    expect(evaluate(baseRequest({ actionType: 'send_sms' }), ruleSet, clock).reasonCode).toBe(POLICY_NO_RULE_MATCHED);
  });

  it('time windows are Clock-driven: the same rules + request flip at the boundary', () => {
    const dayShift = createRuleSet(
      ORG,
      1,
      [
        { id: 'business-hours-only', priority: 1, actionType: 'any', decision: 'allow', conditions: [{ field: 'minuteOfDayUtc', op: 'lte', value: 1079 }], reasonCode: 'POLICY_IN_HOURS', explanation: 'only before 18:00 UTC' },
      ],
      clock,
    );
    expect(evaluate(baseRequest(), dayShift, at(T0)).reasonCode).toBe('POLICY_IN_HOURS'); // 10:30 → minute 630
    expect(evaluate(baseRequest(), dayShift, at(T1)).reasonCode).toBe(POLICY_NO_RULE_MATCHED); // 19:30 → minute 1170
  });

  it('day-of-week windows evaluate the UTC day from the Clock', () => {
    const weekdays = createRuleSet(
      ORG,
      1,
      [
        { id: 'weekdays-only', priority: 1, actionType: 'any', decision: 'allow', conditions: [{ field: 'dayOfWeekUtc', op: 'not_in', value: [0, 6] }], reasonCode: 'POLICY_WEEKDAY', explanation: 'weekdays only' },
      ],
      clock,
    );
    expect(evaluate(baseRequest(), weekdays, at('2026-03-04T00:00:00.000Z')).decision).toBe('allow'); // Wednesday
    expect(evaluate(baseRequest(), weekdays, at('2026-03-07T00:00:00.000Z')).decision).toBe('deny'); // Saturday
    expect(evaluate(baseRequest(), weekdays, at('2026-03-01T00:00:00.000Z')).decision).toBe('deny'); // Sunday
  });

  it('eq/in conditions over channel evaluate the EFFECTIVE channel', () => {
    const whatsappOnly = createRuleSet(
      ORG,
      1,
      [
        { id: 'whatsapp-only', priority: 1, actionType: 'any', decision: 'allow', conditions: [{ field: 'channel', op: 'eq', value: 'whatsapp' }], reasonCode: 'POLICY_WA_ONLY', explanation: 'whatsapp only' },
      ],
      clock,
    );
    expect(evaluate(baseRequest({ actionType: 'send_whatsapp', channel: null }), whatsappOnly, clock).decision).toBe('allow');
    expect(evaluate(baseRequest({ actionType: 'send_sms', channel: null }), whatsappOnly, clock).reasonCode).toBe(POLICY_NO_RULE_MATCHED);
  });
});

// --- conditions (grants) propagation ---------------------------------------------------

describe('decision conditions propagation', () => {
  const bounded: PolicyRule = {
    id: 'bounded-link',
    priority: 1,
    actionType: 'issue_payment_link',
    decision: 'allow',
    conditions: [{ field: 'riskClass', op: 'in', value: ['low', 'elevated'] }],
    reasonCode: 'POLICY_LINK_BOUNDED',
    explanation: 'payment links up to KES 50,000 on listed channels, expiring at month end',
    grants: { maxAmountMinor: 5_000_000, allowedChannels: ['sms', 'whatsapp'], expiresAt: '2026-04-01T00:00:00.000Z' },
  };

  it('an allow rule’s grants travel on the decision', () => {
    const ruleSet = createRuleSet(ORG, 1, [bounded], clock);
    const result = evaluate(baseRequest({ actionType: 'issue_payment_link' }), ruleSet, clock);
    expect(result.decision).toBe('allow');
    expect(result.conditions).toEqual({
      maxAmountMinor: 5_000_000,
      allowedChannels: ['sms', 'whatsapp'],
      expiresAt: '2026-04-01T00:00:00.000Z',
    });
  });

  it('a requires_approval rule’s grants travel on the decision too', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [{ ...bounded, id: 'bounded-refund', actionType: 'refund', decision: 'requires_approval', conditions: [], grants: { maxAmountMinor: 1_000_000 } }],
      clock,
    );
    const result = evaluate(baseRequest({ actionType: 'refund', amountMinor: 999, currency: 'KES' }), ruleSet, clock);
    expect(result.decision).toBe('requires_approval');
    expect(result.conditions).toEqual({ maxAmountMinor: 1_000_000 });
  });

  it('a deny rule carries NO conditions — a refusal grants nothing', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [{ ...bounded, id: 'plain-deny', decision: 'deny', conditions: [{ field: 'disputeOpen', op: 'is_true' }], grants: undefined }],
      clock,
    );
    const result = evaluate(baseRequest({ disputeOpen: true }), ruleSet, clock);
    expect(result.decision).toBe('deny');
    expect(result.conditions).toBeNull();
  });

  it('an allow rule without grants yields null conditions', () => {
    const ruleSet = createRuleSet(
      ORG,
      1,
      [{ id: 'plain-allow', priority: 1, actionType: 'any', decision: 'allow', conditions: [], reasonCode: 'POLICY_PLAIN', explanation: 'plain' }],
      clock,
    );
    expect(evaluate(baseRequest(), ruleSet, clock).conditions).toBeNull();
  });

  it('conditions are frozen on the decision (callers cannot widen the grant)', () => {
    const ruleSet = createRuleSet(ORG, 1, [bounded], clock);
    const result = evaluate(baseRequest({ actionType: 'issue_payment_link' }), ruleSet, clock);
    expect(Object.isFrozen(result.conditions)).toBe(true);
  });
});

// --- the audit event: policy.decisionRecorded for EVERY evaluation ------------------------

describe('policy.decisionRecorded — audit event shape', () => {
  it('allow: exact narrow payload, envelope pinned, occurredAt === requestedAt', () => {
    const result = evaluate(baseRequest(), defaults, clock);
    expect(result.event).toEqual({
      name: 'policy.decisionRecorded',
      version: 1,
      aggregateId: ORG,
      occurredAt: T0,
      payload: {
        orgId: ORG,
        customerId: CUSTOMER,
        receivableId: RECEIVABLE,
        caseId: null,
        actionType: 'send_whatsapp',
        actorType: 'ai_agent',
        autonomous: true,
        riskClass: 'low',
        amountMinor: null,
        currency: null,
        channel: 'whatsapp', // the EFFECTIVE channel
        decision: 'allow',
        reasonCode: POLICY_AUTONOMOUS_LOW_RISK,
        matchedRuleIds: ['default-allow-autonomous-low-risk'],
        ruleSetVersion: 1,
        requestedAt: T0,
      },
    });
    expect(result.requestedAt).toBe(T0);
  });

  it('deny by rule: matched rule id in the payload', () => {
    const result = evaluate(baseRequest({ consentPresent: false }), defaults, clock);
    expect(result.event.payload.decision).toBe('deny');
    expect(result.event.payload.reasonCode).toBe(POLICY_CONSENT_REQUIRED);
    expect(result.event.payload.matchedRuleIds).toEqual(['default-deny-autonomous-send-without-consent']);
  });

  it('deny by pre-guard: empty matchedRuleIds, verbatim unknown actionType', () => {
    const result = evaluate(baseRequest({ actionType: 'move_money_shadow' }), defaults, clock);
    expect(result.event.payload.decision).toBe('deny');
    expect(result.event.payload.reasonCode).toBe(POLICY_ACTION_UNKNOWN);
    expect(result.event.payload.actionType).toBe('move_money_shadow');
    expect(result.event.payload.matchedRuleIds).toEqual([]);
  });

  it('requires_approval emits the SAME audit event shape', () => {
    const result = evaluate(baseRequest({ actionType: 'write_off', amountMinor: 10_000_001, currency: 'KES' }), defaults, clock);
    expect(result.event.payload.decision).toBe('requires_approval');
    expect(result.event.payload.reasonCode).toBe(POLICY_WRITE_OFF_APPROVAL_REQUIRED);
    expect(result.event.payload.amountMinor).toBe(10_000_001);
    expect(result.event.payload.currency).toBe('KES');
    expect(result.event.payload.matchedRuleIds).toEqual(['default-write-off-approval']);
  });

  it('the payload is NARROW and PII-free: exactly the pinned key set, never the actorId', () => {
    const result = evaluate(baseRequest(), defaults, clock);
    expect(Object.keys(result.event.payload).sort()).toEqual([
      'actionType',
      'actorType',
      'amountMinor',
      'autonomous',
      'caseId',
      'channel',
      'currency',
      'customerId',
      'decision',
      'matchedRuleIds',
      'orgId',
      'reasonCode',
      'receivableId',
      'requestedAt',
      'riskClass',
      'ruleSetVersion',
    ]);
    const serialized = JSON.stringify(result.event);
    expect(serialized).not.toContain('agent-1'); // actor id never leaves the lane
    expect(serialized).not.toContain('explanation'); // explanations stay on the decision
  });

  it('the event carries caseId when the action is case-scoped', () => {
    const result = evaluate(baseRequest({ caseId: CASE, receivableId: null }), defaults, clock);
    expect(result.event.payload.caseId).toBe(CASE);
    expect(result.event.payload.receivableId).toBeNull();
  });

  it('amountMinor travels as a JSON-safe number; a broken clock is refused', () => {
    const result = evaluate(baseRequest({ amountMinor: 250_000, currency: 'KES' }), defaults, clock);
    expect(result.event.payload.amountMinor).toBe(250_000);
    expectCode(() => evaluate(baseRequest(), defaults, { now: () => new Date('nope') }), 'POLICY_CLOCK_INVALID');
  });

  it('a different rule-set version is stamped on the audit event', () => {
    const v2 = nextVersion(
      defaults,
      [
        ...defaults.rules,
        { id: 'extra-guard', priority: 500, actionType: 'any', decision: 'deny', conditions: [{ field: 'promisePending', op: 'is_true' }], reasonCode: 'POLICY_PROMISE_GUARD', explanation: 'no dunning over a pending promise' },
      ],
      clock,
    );
    const result = evaluate(baseRequest({ promisePending: true }), v2, clock);
    expect(result.ruleSetVersion).toBe(2);
    expect(result.event.payload.ruleSetVersion).toBe(2);
    expect(result.matchedRuleIds).toEqual(['extra-guard']);
  });
});

// --- caller-bug throws (no event — a throw is not a governance outcome) ---------------------

describe('evaluate throws stable codes on caller bugs (no audit event)', () => {
  it('refuses a rule set belonging to another org', () => {
    const other = defaultRuleSetFor(OTHER_ORG, clock);
    expectCode(() => evaluate(baseRequest(), other, clock), 'POLICY_RULESET_ORG_MISMATCH');
  });

  it('refuses a structurally broken rule set instead of crashing raw', () => {
    expectCode(() => evaluate(baseRequest(), null as unknown as PolicyRuleSet, clock), 'POLICY_RULESET_INVALID');
    expectCode(() => evaluate(baseRequest(), { orgId: ORG, version: 1 } as unknown as PolicyRuleSet, clock), 'POLICY_RULESET_INVALID');
    expectCode(() => evaluate(baseRequest(), { orgId: ORG, version: 0, rules: [] } as unknown as PolicyRuleSet, clock), 'POLICY_RULESET_VERSION_INVALID');
    expectCode(() => evaluate(baseRequest(), { orgId: ' ' as Uuid, version: 1, rules: [] } as unknown as PolicyRuleSet, clock), 'POLICY_RULESET_ORG_REQUIRED');
  });

  it('refuses malformed requests (validation precedes governance)', () => {
    expectCode(() => evaluate(baseRequest({ actor: { type: 'alien', actorId: 'x' } as never }), defaults, clock), 'POLICY_ACTOR_TYPE_INVALID');
    expectCode(() => evaluate(baseRequest({ autonomous: 'yes' as unknown as boolean }), defaults, clock), 'POLICY_REQUEST_FLAG_INVALID');
    expectCode(() => evaluate(supervised({ autonomous: true }), defaults, clock), 'POLICY_AUTONOMY_MISMATCH');
  });
});

// --- determinism, immutability, no-mutation pins --------------------------------------------

describe('deterministic replay and purity', () => {
  it('same rules + same request + same clock instant ⇒ identical decision AND event', () => {
    const request = baseRequest({ riskClass: 'elevated' });
    const a = evaluate(request, defaults, clock);
    const b = evaluate(request, defaults, clock);
    expect(a).toEqual(b);
    expect(a.event).toEqual(b.event);
  });

  it('the Clock is read EXACTLY ONCE per evaluation (requestedAt === occurredAt)', () => {
    let reads = 0;
    const counting: Clock = {
      now: () => {
        reads += 1;
        return new Date(T0);
      },
    };
    evaluate(baseRequest(), defaults, counting);
    expect(reads).toBe(1);
  });

  it('evaluate never mutates the request or the rule set', () => {
    const request = baseRequest({ actionType: 'refund', amountMinor: 6_000_000, currency: 'KES' });
    const snapshot = JSON.stringify(request);
    const ruleSetSnapshot = JSON.stringify(defaults);
    evaluate(request, defaults, clock);
    expect(JSON.stringify(request)).toBe(snapshot);
    expect(JSON.stringify(defaults)).toBe(ruleSetSnapshot);
  });

  it('the decision and its event are deep-frozen', () => {
    const result = evaluate(baseRequest(), defaults, clock);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.event)).toBe(true);
    expect(Object.isFrozen(result.event.payload)).toBe(true);
    expect(Object.isFrozen(result.matchedRuleIds)).toBe(true);
    expect(() => {
      (result as { decision: string }).decision = 'allow';
    }).toThrow(TypeError);
  });
});
