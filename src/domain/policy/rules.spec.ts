/**
 * Policy rules — condition predicates, validation refusals, versioning and
 * the safe-by-default defaults (issue #34, table-driven).
 */
import { describe, expect, it } from 'vitest';
import { DomainError, uuid, type Clock, type Uuid } from '../shared';
import { type ActionRequest } from './request';
import {
  DECISIONS,
  DEFAULT_RULES,
  DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR,
  DEFAULT_WRITE_OFF_APPROVAL_THRESHOLD_MINOR,
  POLICY_AUTONOMOUS_LOW_RISK,
  POLICY_CHANNEL_REQUIRED,
  POLICY_CONSENT_REQUIRED,
  POLICY_DISPUTE_OPEN,
  POLICY_FIELDS,
  POLICY_OPERATORS,
  POLICY_REFUND_APPROVAL_REQUIRED,
  POLICY_RISK_APPROVAL_REQUIRED,
  POLICY_SUPERVISED_ACTION,
  POLICY_WRITE_OFF_APPROVAL_REQUIRED,
  assertRuleSetReference,
  assertValidRule,
  conditionMatches,
  createRuleSet,
  defaultRuleSetFor,
  deepFreeze,
  nextVersion,
  validateRuleSet,
  type DecisionConditions,
  type PolicyCondition,
  type PolicyRule,
  type PolicyRuleSet,
} from './rules';

// --- fixtures -----------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const T0 = '2026-03-04T10:30:00.000Z'; // a Wednesday, 630 minutes into the UTC day
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const clock = at(T0);

const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  orgId: ORG,
  customerId: uid(2),
  receivableId: uid(3),
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

const rule = (over: Partial<PolicyRule> = {}): PolicyRule => ({
  id: 'rule-1',
  priority: 10,
  actionType: 'any',
  decision: 'deny',
  conditions: [],
  reasonCode: 'POLICY_TEST_RULE',
  explanation: 'test rule',
  ...over,
});

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- vocabularies -----------------------------------------------------------------

describe('rule vocabularies', () => {
  it('pins decisions, fields and operators', () => {
    expect([...DECISIONS]).toEqual(['allow', 'deny', 'requires_approval']);
    expect([...POLICY_FIELDS]).toEqual([
      'actionType',
      'actorType',
      'riskClass',
      'channel',
      'amountMinor',
      'minuteOfDayUtc',
      'dayOfWeekUtc',
      'consentPresent',
      'disputeOpen',
      'promisePending',
      'autonomous',
    ]);
    expect([...POLICY_OPERATORS]).toEqual([
      'eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte',
      'is_true', 'is_false', 'present', 'absent',
    ]);
  });

  it('pins the default approval thresholds (VISION §3.9 example amounts)', () => {
    expect(DEFAULT_WRITE_OFF_APPROVAL_THRESHOLD_MINOR).toBe(10_000_000); // KES 100,000.00
    expect(DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR).toBe(5_000_000); // KES 50,000.00
  });
});

// --- condition matching -------------------------------------------------------------

describe('conditionMatches — operator tables', () => {
  const matches = (condition: PolicyCondition, request: ActionRequest, now: Date = clock.now()): boolean =>
    conditionMatches(condition, request, now);

  it.each([
    ['eq on enum matches the member', { field: 'riskClass', op: 'eq', value: 'low' }, 'low', true],
    ['eq on enum refuses another member', { field: 'riskClass', op: 'eq', value: 'high' }, 'low', false],
    ['ne is strict inequality', { field: 'riskClass', op: 'ne', value: 'high' }, 'low', true],
    ['in matches list membership', { field: 'actionType', op: 'in', value: ['send_reminder', 'send_whatsapp'] }, 'low', true],
    ['in refuses when absent from the list', { field: 'actionType', op: 'in', value: ['send_reminder'] }, 'low', false],
    ['not_in is the complement of in', { field: 'actionType', op: 'not_in', value: ['send_reminder'] }, 'low', true],
    ['is_true matches only true', { field: 'consentPresent', op: 'is_true' }, 'low', true],
    ['is_false matches only false', { field: 'consentPresent', op: 'is_false' }, 'low', false],
  ] as const)('%s', (_label, condition, risk, expected) => {
    expect(matches(condition, req({ riskClass: risk }))).toBe(expected);
  });

  it.each([
    ['gt is strict (boundary excluded)', { op: 'gt', value: 100 }, 100, false],
    ['gt above the boundary', { op: 'gt', value: 100 }, 101, true],
    ['gte includes the boundary', { op: 'gte', value: 100 }, 100, true],
    ['lt is strict (boundary excluded)', { op: 'lt', value: 100 }, 100, false],
    ['lt below the boundary', { op: 'lt', value: 100 }, 99, true],
    ['lte includes the boundary', { op: 'lte', value: 100 }, 100, true],
  ] as const)('%s', (_label, partial, amount, expected) => {
    const condition = { field: 'amountMinor', ...partial } as PolicyCondition;
    expect(matches(condition, req({ amountMinor: amount, currency: 'KES' }))).toBe(expected);
  });

  it('present matches a supplied fact; absent does not', () => {
    const supplied = req({ amountMinor: 5, currency: 'KES' });
    expect(matches({ field: 'amountMinor', op: 'present' }, supplied)).toBe(true);
    expect(matches({ field: 'amountMinor', op: 'absent' }, supplied)).toBe(false);
  });

  it('null facts are STRICT — only absent matches them', () => {
    // send_reminder implies no channel, so an explicit null stays null
    const missing = req({ actionType: 'send_reminder', amountMinor: null, currency: null, channel: null });
    expect(matches({ field: 'amountMinor', op: 'absent' }, missing)).toBe(true);
    expect(matches({ field: 'channel', op: 'absent' }, missing)).toBe(true);
    expect(matches({ field: 'amountMinor', op: 'present' }, missing)).toBe(false);
    expect(matches({ field: 'amountMinor', op: 'gt', value: 0 }, missing)).toBe(false);
    expect(matches({ field: 'amountMinor', op: 'gte', value: 0 }, missing)).toBe(false);
    expect(matches({ field: 'channel', op: 'eq', value: 'sms' }, missing)).toBe(false);
    expect(matches({ field: 'channel', op: 'ne', value: 'sms' }, missing)).toBe(false);
    expect(matches({ field: 'channel', op: 'in', value: ['sms', 'whatsapp'] }, missing)).toBe(false);
    expect(matches({ field: 'channel', op: 'not_in', value: ['sms'] }, missing)).toBe(false);
  });

  it('channel conditions evaluate the EFFECTIVE channel (implied fills in)', () => {
    const implied = req({ actionType: 'send_whatsapp', channel: null });
    expect(matches({ field: 'channel', op: 'eq', value: 'whatsapp' }, implied)).toBe(true);
    const explicit = req({ actionType: 'send_reminder', channel: 'email' });
    expect(matches({ field: 'channel', op: 'eq', value: 'email' }, explicit)).toBe(true);
  });

  it.each([
    ['midnight is minute 0', '2026-03-04T00:00:00.000Z', 'minuteOfDayUtc', 'eq', 0, true],
    ['just before midnight is minute 1439', '2026-03-04T23:59:00.000Z', 'minuteOfDayUtc', 'eq', 1439, true],
    ['10:30 is minute 630', T0, 'minuteOfDayUtc', 'eq', 630, true],
    ['minute window edge (lte)', T0, 'minuteOfDayUtc', 'lte', 630, true],
    ['just past a window edge', T0, 'minuteOfDayUtc', 'lte', 629, false],
    ['2026-03-04 is a Wednesday (day 3)', T0, 'dayOfWeekUtc', 'eq', 3, true],
    ['Sunday is day 0', '2026-03-01T00:00:00.000Z', 'dayOfWeekUtc', 'eq', 0, true],
    ['Saturday is day 6', '2026-03-07T00:00:00.000Z', 'dayOfWeekUtc', 'eq', 6, true],
    ['Sunday is not day 1', '2026-03-01T00:00:00.000Z', 'dayOfWeekUtc', 'eq', 1, false],
  ] as const)('%s', (_label, iso, field, op, value, expected) => {
    expect(matches({ field, op, value } as PolicyCondition, req(), new Date(iso))).toBe(expected);
  });

  it('time facts are never null — ordering operators always evaluate them', () => {
    expect(matches({ field: 'minuteOfDayUtc', op: 'gt', value: 600 }, req(), clock.now())).toBe(true);
    expect(matches({ field: 'dayOfWeekUtc', op: 'in', value: [0, 6] }, req(), new Date('2026-03-07T00:00:00.000Z'))).toBe(true);
  });
});

// --- condition / rule / grant validation -----------------------------------------------

describe('rule validation refusals', () => {
  it('accepts a valid rule', () => {
    expect(() =>
      assertValidRule(
        rule({
          decision: 'allow',
          conditions: [{ field: 'riskClass', op: 'eq', value: 'low' }],
          grants: { maxAmountMinor: 5 },
        }),
        0,
      ),
    ).not.toThrow();
  });

  it.each([
    ['blank id', { id: '  ' }, 'POLICY_RULE_ID_REQUIRED'],
    ['negative priority', { priority: -1 }, 'POLICY_RULE_PRIORITY_INVALID'],
    ['fractional priority', { priority: 1.5 }, 'POLICY_RULE_PRIORITY_INVALID'],
    ['unknown action scope', { actionType: 'napalm_strike' as never }, 'POLICY_RULE_ACTION_INVALID'],
    ['unknown decision', { decision: 'maybe' as never }, 'POLICY_RULE_DECISION_INVALID'],
    ['reason without POLICY_ prefix', { reasonCode: 'DENY_BECAUSE' }, 'POLICY_RULE_REASON_INVALID'],
    ['blank reason', { reasonCode: '  ' }, 'POLICY_RULE_REASON_INVALID'],
    ['blank explanation', { explanation: '' }, 'POLICY_RULE_EXPLANATION_REQUIRED'],
    ['conditions not an array', { conditions: 'all' as unknown as PolicyRule['conditions'] }, 'POLICY_RULE_CONDITIONS_INVALID'],
    ['grants on a deny rule', { decision: 'deny', grants: { maxAmountMinor: 5 } }, 'POLICY_RULE_GRANT_INVALID'],
  ] as const)('%s', (_label, over, code) => {
    expectCode(() => assertValidRule(rule({ ...over }), 0), code);
  });

  it('accepts an explicitly null grants block on any decision', () => {
    expect(() => assertValidRule(rule({ grants: null }), 0)).not.toThrow();
  });

  it.each([
    ['unknown field', { field: 'weather', op: 'eq', value: 'rain' }, 'POLICY_RULE_FIELD_UNKNOWN'],
    ['unknown operator', { field: 'riskClass', op: 'between', value: 'low' }, 'POLICY_RULE_OPERATOR_INVALID'],
    ['is_true on a non-boolean field', { field: 'riskClass', op: 'is_true' }, 'POLICY_RULE_OPERATOR_INVALID'],
    ['gt on a non-numeric field', { field: 'riskClass', op: 'gt', value: 'low' }, 'POLICY_RULE_OPERATOR_INVALID'],
    ['present on a non-nullable field', { field: 'disputeOpen', op: 'present' }, 'POLICY_RULE_OPERATOR_INVALID'],
    ['absent on a non-nullable field', { field: 'autonomous', op: 'absent' }, 'POLICY_RULE_OPERATOR_INVALID'],
    ['value on a nullary operator', { field: 'channel', op: 'absent', value: 'sms' }, 'POLICY_RULE_CONDITION_VALUE_FORBIDDEN'],
    ['missing value on a value operator', { field: 'riskClass', op: 'eq' }, 'POLICY_RULE_CONDITION_VALUE_REQUIRED'],
    ['empty in-list', { field: 'riskClass', op: 'in', value: [] }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['in-list with an out-of-domain member', { field: 'riskClass', op: 'in', value: ['low', 'cosmic'] }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['eq with an out-of-domain enum value', { field: 'channel', op: 'eq', value: 'fax' }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['eq with a non-boolean on a boolean field', { field: 'consentPresent', op: 'eq', value: 'true' }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['minuteOfDayUtc above 1439', { field: 'minuteOfDayUtc', op: 'gt', value: 1440 }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['negative minuteOfDayUtc value', { field: 'minuteOfDayUtc', op: 'gt', value: -1 }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['dayOfWeekUtc above 6', { field: 'dayOfWeekUtc', op: 'eq', value: 7 }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['negative amountMinor threshold', { field: 'amountMinor', op: 'gt', value: -5 }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['non-finite numeric value', { field: 'amountMinor', op: 'gt', value: Number.NaN }, 'POLICY_RULE_CONDITION_VALUE_INVALID'],
    ['condition itself not an object', 'risk is low', 'POLICY_RULE_CONDITION_INVALID'],
  ] as readonly [string, unknown, string][])('%s', (_label, condition, code) => {
    expectCode(() => assertValidRule(rule({ conditions: [condition as PolicyCondition] }), 0), code);
  });

  it('accepts present/absent on the nullable facts (channel, amountMinor)', () => {
    expect(() => assertValidRule(rule({ conditions: [{ field: 'channel', op: 'absent' }] }), 0)).not.toThrow();
    expect(() => assertValidRule(rule({ conditions: [{ field: 'amountMinor', op: 'present' }] }), 0)).not.toThrow();
  });

  it.each([
    ['empty grants', {}, 'POLICY_RULE_GRANT_INVALID'],
    ['unknown grant key (typo)', { maxAmmountMinor: 5 }, 'POLICY_RULE_GRANT_INVALID'],
    ['negative maxAmountMinor', { maxAmountMinor: -1 }, 'POLICY_RULE_GRANT_INVALID'],
    ['fractional maxAmountMinor', { maxAmountMinor: 1.5 }, 'POLICY_RULE_GRANT_INVALID'],
    ['empty allowedChannels', { allowedChannels: [] }, 'POLICY_RULE_GRANT_INVALID'],
    ['unknown allowedChannels member', { allowedChannels: ['fax'] }, 'POLICY_RULE_GRANT_INVALID'],
    ['unparseable expiresAt', { expiresAt: 'next tuesday' }, 'POLICY_RULE_GRANT_INVALID'],
    ['grants not an object', 'free', 'POLICY_RULE_GRANT_INVALID'],
  ] as readonly [string, unknown, string][])('grant: %s', (_label, grants, code) => {
    expectCode(() => assertValidRule(rule({ decision: 'allow', grants: grants as DecisionConditions }), 0), code);
  });

  it('accepts every valid grant shape', () => {
    expect(() =>
      assertValidRule(
        rule({
          decision: 'requires_approval',
          grants: { maxAmountMinor: 0, allowedChannels: ['sms', 'whatsapp'], expiresAt: '2026-04-01T00:00:00.000Z' },
        }),
        0,
      ),
    ).not.toThrow();
  });
});

// --- rule sets: ordering, uniqueness, freezing, versioning -------------------------------

describe('rule-set validation', () => {
  it('requires an org, a safe integer version ≥ 1 and an array of rules', () => {
    expectCode(() => validateRuleSet(' ' as Uuid, 1, []), 'POLICY_RULESET_ORG_REQUIRED');
    expectCode(() => validateRuleSet(ORG, 0, []), 'POLICY_RULESET_VERSION_INVALID');
    expectCode(() => validateRuleSet(ORG, 1.5, []), 'POLICY_RULESET_VERSION_INVALID');
    expectCode(() => validateRuleSet(ORG, 1, 'none' as unknown as PolicyRule[]), 'POLICY_RULESET_RULES_INVALID');
  });

  it('refuses duplicate rule ids and duplicate priorities', () => {
    expectCode(
      () => validateRuleSet(ORG, 1, [rule(), rule({ priority: 11 })]),
      'POLICY_RULE_ID_DUPLICATE',
    );
    expectCode(
      () => validateRuleSet(ORG, 1, [rule(), rule({ id: 'rule-2' })]),
      'POLICY_RULE_PRIORITY_DUPLICATE',
    );
  });

  it('an EMPTY rule set is legal — the maximally safe posture', () => {
    expect(validateRuleSet(ORG, 1, [])).toEqual([]);
  });

  it('returns rules in ascending-priority order regardless of input order', () => {
    const sorted = validateRuleSet(ORG, 1, [
      rule({ id: 'late', priority: 900 }),
      rule({ id: 'early', priority: 10 }),
      rule({ id: 'middle', priority: 42 }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['early', 'middle', 'late']);
  });

  it('does not mutate (or reorder) the caller’s rule array', () => {
    const input = [rule({ id: 'b', priority: 20 }), rule({ id: 'a', priority: 10 })];
    const snapshot = JSON.stringify(input);
    validateRuleSet(ORG, 1, input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('createRuleSet — immutability', () => {
  it('freezes the rule set, every rule, every condition and every grant', () => {
    const condition = { field: 'riskClass', op: 'eq', value: 'low' } as const;
    const source = rule({
      conditions: [condition],
      decision: 'allow',
      grants: { allowedChannels: ['sms', 'whatsapp'], maxAmountMinor: 1 },
    });
    const ruleSet = createRuleSet(ORG, 3, [source], clock);
    expect(Object.isFrozen(ruleSet)).toBe(true);
    expect(Object.isFrozen(ruleSet.rules)).toBe(true);
    for (const frozen of ruleSet.rules) {
      expect(Object.isFrozen(frozen)).toBe(true);
      expect(Object.isFrozen(frozen.conditions)).toBe(true);
      for (const frozenCondition of frozen.conditions) expect(Object.isFrozen(frozenCondition)).toBe(true);
      if (frozen.grants) {
        expect(Object.isFrozen(frozen.grants)).toBe(true);
        if (frozen.grants.allowedChannels) expect(Object.isFrozen(frozen.grants.allowedChannels)).toBe(true);
      }
    }
  });

  it('never freezes the caller’s input (creation copies before freezing)', () => {
    const condition: PolicyCondition = { field: 'riskClass', op: 'eq', value: 'low' };
    const conditions: PolicyCondition[] = [condition];
    const grants: DecisionConditions = { allowedChannels: ['sms'] };
    const source = rule({ conditions, decision: 'allow', grants });
    createRuleSet(ORG, 1, [source], clock);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(conditions)).toBe(false);
    expect(Object.isFrozen(condition)).toBe(false);
    expect(Object.isFrozen(grants)).toBe(false);
    expect(Object.isFrozen(grants.allowedChannels)).toBe(false);
  });

  it('mutation attempts on a published version throw (strict mode)', () => {
    const ruleSet = createRuleSet(ORG, 1, [rule()], clock);
    expect(() => {
      (ruleSet as { version: number }).version = 99;
    }).toThrow(TypeError);
    expect(() => {
      (ruleSet.rules[0] as { priority: number }).priority = 0;
    }).toThrow(TypeError);
  });

  it('rejects a broken injected clock', () => {
    expectCode(
      () => createRuleSet(ORG, 1, [], { now: () => new Date('not-a-date') }),
      'POLICY_CLOCK_INVALID',
    );
  });

  it('stamps createdAt from the injected clock', () => {
    expect(createRuleSet(ORG, 2, [], clock).createdAt).toBe(T0);
  });
});

describe('nextVersion — versions are immutable and monotonic', () => {
  it('mints version+1 for the same org, leaving the previous version untouched', () => {
    const v1 = createRuleSet(ORG, 1, [rule({ id: 'r1', priority: 1 })], clock);
    const v1Snapshot = JSON.stringify(v1);
    const v2 = nextVersion(v1, [rule({ id: 'r2', priority: 1 }), rule({ id: 'r3', priority: 2 })], clock);
    expect(v2.version).toBe(2);
    expect(v2.orgId).toBe(ORG);
    expect(v2.rules.map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(JSON.stringify(v1)).toBe(v1Snapshot);
    expect(v1.rules.map((r) => r.id)).toEqual(['r1']);
  });

  it('validates the new version’s rules (refuses a duplicate inside the new set)', () => {
    const v1 = createRuleSet(ORG, 1, [rule({ id: 'r1', priority: 1 })], clock);
    expectCode(
      () => nextVersion(v1, [rule({ id: 'r2', priority: 1 }), rule({ id: 'r2', priority: 2 })], clock),
      'POLICY_RULE_ID_DUPLICATE',
    );
    expectCode(
      () => nextVersion(v1, [rule({ id: 'r3', priority: 1 }), rule({ id: 'r4', priority: 1 })], clock),
      'POLICY_RULE_PRIORITY_DUPLICATE',
    );
  });
});

describe('assertRuleSetReference — cheap pre-evaluation check', () => {
  it('accepts a created rule set', () => {
    expect(() => assertRuleSetReference(createRuleSet(ORG, 1, [], clock))).not.toThrow();
  });

  it.each([
    ['null rule set', null],
    ['non-object rule set', 42],
  ] as const)('%s', (_label, bad) => {
    expectCode(() => assertRuleSetReference(bad as unknown as PolicyRuleSet), 'POLICY_RULESET_INVALID');
  });

  it('refuses a blank org, a bad version or a missing rules array', () => {
    expectCode(() => assertRuleSetReference({ orgId: ' ' as Uuid, version: 1, rules: [] } as unknown as PolicyRuleSet), 'POLICY_RULESET_ORG_REQUIRED');
    expectCode(() => assertRuleSetReference({ orgId: ORG, version: 0, rules: [] } as unknown as PolicyRuleSet), 'POLICY_RULESET_VERSION_INVALID');
    expectCode(() => assertRuleSetReference({ orgId: ORG, version: 1 } as unknown as PolicyRuleSet), 'POLICY_RULESET_INVALID');
  });
});

// --- the safe-by-default defaults -----------------------------------------------------

describe('DEFAULT_RULES / defaultRuleSetFor', () => {
  it('ships the eight safe-by-default rules in priority order', () => {
    expect(DEFAULT_RULES.map((r) => r.id)).toEqual([
      'default-deny-automated-dispute-open',
      'default-deny-autonomous-send-without-consent',
      'default-deny-autonomous-send-without-channel',
      'default-write-off-approval',
      'default-refund-approval',
      'default-elevated-risk-approval',
      'default-allow-supervised',
      'default-allow-autonomous-low-risk',
    ]);
  });

  it('carries unique priorities and only POLICY_-prefixed reasons', () => {
    const priorities = new Set(DEFAULT_RULES.map((r) => r.priority));
    expect(priorities.size).toBe(DEFAULT_RULES.length);
    for (const r of DEFAULT_RULES) {
      expect(r.reasonCode.startsWith('POLICY_')).toBe(true);
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });

  it('is itself frozen', () => {
    expect(Object.isFrozen(DEFAULT_RULES)).toBe(true);
  });

  it('defaultRuleSetFor pins version 1 for the org and validates cleanly', () => {
    const ruleSet = defaultRuleSetFor(ORG, clock);
    expect(ruleSet.orgId).toBe(ORG);
    expect(ruleSet.version).toBe(1);
    expect(ruleSet.createdAt).toBe(T0);
    expect(ruleSet.rules).toHaveLength(DEFAULT_RULES.length);
  });

  it('every default reason code is exported with its pinned stable value', () => {
    expect(POLICY_DISPUTE_OPEN).toBe('POLICY_DISPUTE_OPEN');
    expect(POLICY_CONSENT_REQUIRED).toBe('POLICY_CONSENT_REQUIRED');
    expect(POLICY_CHANNEL_REQUIRED).toBe('POLICY_CHANNEL_REQUIRED');
    expect(POLICY_WRITE_OFF_APPROVAL_REQUIRED).toBe('POLICY_WRITE_OFF_APPROVAL_REQUIRED');
    expect(POLICY_REFUND_APPROVAL_REQUIRED).toBe('POLICY_REFUND_APPROVAL_REQUIRED');
    expect(POLICY_RISK_APPROVAL_REQUIRED).toBe('POLICY_RISK_APPROVAL_REQUIRED');
    expect(POLICY_SUPERVISED_ACTION).toBe('POLICY_SUPERVISED_ACTION');
    expect(POLICY_AUTONOMOUS_LOW_RISK).toBe('POLICY_AUTONOMOUS_LOW_RISK');
  });

  it('deepFreeze is recursive over plain objects and arrays', () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.a)).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
  });
});
