/**
 * Policy rules — deterministic, versioned, per-org DATA (issue #34).
 *
 * A rule set is ordered configuration, not code: rules carry a `priority`
 * (lower number = evaluated first; priorities are unique, so the evaluation
 * order is a total one), an `actionType` scope ('any' or one known action),
 * a list of condition predicates over the request facts (ALL must match —
 * AND), and the decision they produce. `evaluate` picks the FIRST matching
 * rule and falls back to a fail-closed deny when nothing matches — so a rule
 * set that forgets a case never widens permissions.
 *
 * Conditions are typed predicates over known fields with known operators:
 *
 *   fields      actionType | actorType | riskClass | channel | amountMinor
 *               | minuteOfDayUtc | dayOfWeekUtc | consentPresent
 *               | disputeOpen | promisePending | autonomous
 *   operators   eq | ne | in | not_in | gt | gte | lt | lte
 *               | is_true | is_false | present | absent
 *
 * `minuteOfDayUtc` (0–1439) and `dayOfWeekUtc` (0–6, 0 = Sunday) are derived
 * from the engine's injected Clock — that is how time windows are expressed
 * with the SAME generic operators as everything else, deterministically.
 *
 * Validation is strict because a typo'd rule is a security bug: unknown
 * fields, unknown operators, values outside a field's domain (a 'whatsap'
 * channel condition that would silently never match) and malformed grants
 * are all refused at creation with stable `POLICY_*` codes. Created rule
 * sets are deep-frozen — versions are immutable; new rules mean a NEW
 * version (strictly +1 via `nextVersion`).
 *
 * `DEFAULT_RULES` ships the safe-by-default posture (VISION §3.5/§3.9):
 * disputed receivables are never touched by automation, autonomous sends
 * need consent, write-offs/refunds above a threshold need a human approver,
 * humans bypass autonomy restrictions but NOT compliance rules, and low-risk
 * autonomous work is allowed — everything else is denied by the engine.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import {
  ACTOR_TYPES,
  ACTION_TYPES,
  AMOUNT_REQUIRED_ACTION_TYPES,
  CHANNELS,
  CONTACT_ACTION_TYPES,
  RISK_CLASSES,
  effectiveChannel,
  type ActionRequest,
  type ActionType,
  type Channel,
} from './request';

// --- decisions -----------------------------------------------------------------

export const DECISIONS = ['allow', 'deny', 'requires_approval'] as const;
export type Decision = (typeof DECISIONS)[number];

// --- conditions ------------------------------------------------------------------

export const POLICY_FIELDS = [
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
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];

export const POLICY_OPERATORS = [
  'eq',
  'ne',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_true',
  'is_false',
  'present',
  'absent',
] as const;
export type PolicyOperator = (typeof POLICY_OPERATORS)[number];

/** One predicate over one request fact. All conditions of a rule must match (AND). */
export interface PolicyCondition {
  readonly field: PolicyField;
  readonly op: PolicyOperator;
  /** Operand for eq/ne/in/not_in/gt/gte/lt/lte — forbidden on is_true/is_false/present/absent. */
  readonly value?: unknown;
}

type FieldKind = 'enum' | 'numeric' | 'boolean';
interface FieldSpec {
  readonly kind: FieldKind;
  /** For enum fields: the exact members a condition value may name. */
  readonly enumValues?: readonly string[];
  /** For numeric fields: the inclusive range a condition value must land in. */
  readonly range?: readonly [number, number];
  /** True only for fields a request may legitimately leave null (amountMinor, channel). */
  readonly nullable?: boolean;
}

const FIELD_SPECS: Readonly<Record<PolicyField, FieldSpec>> = {
  actionType: { kind: 'enum', enumValues: ACTION_TYPES },
  actorType: { kind: 'enum', enumValues: ACTOR_TYPES },
  riskClass: { kind: 'enum', enumValues: RISK_CLASSES },
  channel: { kind: 'enum', enumValues: CHANNELS, nullable: true },
  amountMinor: { kind: 'numeric', range: [0, Number.MAX_SAFE_INTEGER], nullable: true },
  minuteOfDayUtc: { kind: 'numeric', range: [0, 1439] },
  dayOfWeekUtc: { kind: 'numeric', range: [0, 6] },
  consentPresent: { kind: 'boolean' },
  disputeOpen: { kind: 'boolean' },
  promisePending: { kind: 'boolean' },
  autonomous: { kind: 'boolean' },
};

const ORDERING_OPS: readonly PolicyOperator[] = ['gt', 'gte', 'lt', 'lte'];
const VALUE_OPS: readonly PolicyOperator[] = ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'];
const NULLARY_OPS: readonly PolicyOperator[] = ['is_true', 'is_false', 'present', 'absent'];
const BOOLEAN_ONLY_OPS: readonly PolicyOperator[] = ['is_true', 'is_false'];

const labelOf = (op: PolicyOperator): string => op;

/**
 * Does ONE condition match this request at instant `now`?
 *
 * Null facts (no amount, no channel) are STRICT: only `absent` matches them
 * — `in`/`not_in`/ordering comparisons against a missing fact never match,
 * so a rule that needs a fact cannot fire on a request that lacks it.
 * `channel` is evaluated against the request's EFFECTIVE channel (explicit
 * wins, send_whatsapp/send_sms imply theirs).
 */
export function conditionMatches(
  condition: PolicyCondition,
  request: ActionRequest,
  now: Date,
): boolean {
  let actual: unknown;
  switch (condition.field) {
    case 'actionType':
      actual = request.actionType;
      break;
    case 'actorType':
      actual = request.actor.type;
      break;
    case 'riskClass':
      actual = request.riskClass;
      break;
    case 'channel':
      actual = effectiveChannel(request);
      break;
    case 'amountMinor':
      actual = request.amountMinor;
      break;
    case 'minuteOfDayUtc':
      actual = now.getUTCHours() * 60 + now.getUTCMinutes();
      break;
    case 'dayOfWeekUtc':
      actual = now.getUTCDay();
      break;
    case 'consentPresent':
      actual = request.consentPresent;
      break;
    case 'disputeOpen':
      actual = request.disputeOpen;
      break;
    case 'promisePending':
      actual = request.promisePending;
      break;
    case 'autonomous':
      actual = request.autonomous;
      break;
  }

  if (actual === null || actual === undefined) return condition.op === 'absent';

  switch (condition.op) {
    case 'is_true':
      return actual === true;
    case 'is_false':
      return actual === false;
    case 'present':
      return true;
    case 'absent':
      return false;
    case 'eq':
      return actual === condition.value;
    case 'ne':
      return actual !== condition.value;
    case 'in':
      return (
        Array.isArray(condition.value) &&
        (condition.value as readonly unknown[]).includes(actual)
      );
    case 'not_in':
      return (
        Array.isArray(condition.value) &&
        !(condition.value as readonly unknown[]).includes(actual)
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof actual !== 'number' || typeof condition.value !== 'number') return false;
      return condition.op === 'gt'
        ? actual > condition.value
        : condition.op === 'gte'
          ? actual >= condition.value
          : condition.op === 'lt'
            ? actual < condition.value
            : actual <= condition.value;
  }
}

// --- condition + rule + rule-set validation -----------------------------------------

const assertValidCondition = (condition: PolicyCondition, index: number): void => {
  const where = `conditions[${index}]`;
  if (condition === null || typeof condition !== 'object') {
    throw new DomainError('POLICY_RULE_CONDITION_INVALID', `${where} must be an object`, {
      where,
    });
  }
  if (!(POLICY_FIELDS as readonly string[]).includes(condition.field)) {
    throw new DomainError(
      'POLICY_RULE_FIELD_UNKNOWN',
      `${where}: unknown condition field ${String(condition.field)}`,
      { field: condition.field, allowed: POLICY_FIELDS },
    );
  }
  if (!(POLICY_OPERATORS as readonly string[]).includes(condition.op)) {
    throw new DomainError(
      'POLICY_RULE_OPERATOR_INVALID',
      `${where}: unknown operator ${String(condition.op)}`,
      { op: condition.op, allowed: POLICY_OPERATORS },
    );
  }
  const spec = FIELD_SPECS[condition.field];
  if (BOOLEAN_ONLY_OPS.includes(condition.op) && spec.kind !== 'boolean') {
    throw new DomainError(
      'POLICY_RULE_OPERATOR_INVALID',
      `${where}: ${condition.op} only applies to boolean fields, not ${condition.field}`,
      { field: condition.field, op: condition.op },
    );
  }
  if (NULLARY_OPS.includes(condition.op)) {
    // present/absent are existence tests over NULLABLE facts — on a field a
    // request can never leave null they would be constant (always-match or
    // never-match) and only mask authoring bugs, so they are refused.
    // (is_true/is_false are nullary too but belong to boolean fields — the
    // BOOLEAN_ONLY check above already scopes them.)
    if ((condition.op === 'present' || condition.op === 'absent') && !spec.nullable) {
      throw new DomainError(
        'POLICY_RULE_OPERATOR_INVALID',
        `${where}: ${condition.op} only applies to nullable fields (amountMinor, channel), not ${condition.field}`,
        { field: condition.field, op: condition.op },
      );
    }
    if (condition.value !== undefined) {
      throw new DomainError(
        'POLICY_RULE_CONDITION_VALUE_FORBIDDEN',
        `${where}: ${condition.op} takes no value`,
        { field: condition.field, op: condition.op },
      );
    }
    return;
  }
  if (!VALUE_OPS.includes(condition.op)) {
    throw new DomainError(
      'POLICY_RULE_OPERATOR_INVALID',
      `${where}: operator ${String(condition.op)} is not a value operator`,
      { op: condition.op },
    );
  }
  if (condition.value === undefined) {
    throw new DomainError(
      'POLICY_RULE_CONDITION_VALUE_REQUIRED',
      `${where}: ${condition.op} requires a value`,
      { field: condition.field, op: condition.op },
    );
  }
  const { value } = condition;
  if (ORDERING_OPS.includes(condition.op) && spec.kind !== 'numeric') {
    throw new DomainError(
      'POLICY_RULE_OPERATOR_INVALID',
      `${where}: ordering operators only apply to numeric fields, not ${condition.field}`,
      { field: condition.field, op: condition.op },
    );
  }
  const assertValue = (v: unknown, label: string): void => {
    if (spec.kind === 'boolean') {
      if (typeof v !== 'boolean') {
        throw new DomainError(
          'POLICY_RULE_CONDITION_VALUE_INVALID',
          `${where}: ${label} must be a boolean for field ${condition.field}`,
          { field: condition.field, value: v },
        );
      }
      return;
    }
    if (spec.kind === 'numeric') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new DomainError(
          'POLICY_RULE_CONDITION_VALUE_INVALID',
          `${where}: ${label} must be a finite number for field ${condition.field}`,
          { field: condition.field, value: v },
        );
      }
      const [min, max] = spec.range as readonly [number, number];
      if (v < min || v > max) {
        throw new DomainError(
          'POLICY_RULE_CONDITION_VALUE_INVALID',
          `${where}: ${label} ${v} outside ${condition.field} range [${min}, ${max}]`,
          { field: condition.field, value: v },
        );
      }
      return;
    }
    if (typeof v !== 'string' || !(spec.enumValues as readonly string[]).includes(v)) {
      throw new DomainError(
        'POLICY_RULE_CONDITION_VALUE_INVALID',
        `${where}: ${label} "${String(v)}" is not a valid ${condition.field}`,
        { field: condition.field, value: v, allowed: spec.enumValues },
      );
    }
  };

  if (condition.op === 'in' || condition.op === 'not_in') {
    if (!Array.isArray(value) || value.length === 0) {
      throw new DomainError(
        'POLICY_RULE_CONDITION_VALUE_INVALID',
        `${where}: ${condition.op} requires a non-empty array value`,
        { field: condition.field },
      );
    }
    value.forEach((v, i) => assertValue(v, `${labelOf(condition.op)}[${i}]`));
    return;
  }
  assertValue(value, labelOf(condition.op));
};

/** The only keys a grant block may carry — a typo'd key would silently grant nothing. */
const GRANT_KEYS = ['maxAmountMinor', 'allowedChannels', 'expiresAt'] as const;

/** Validate a grant block (the conditions a matching rule attaches to its decision). */
const assertValidGrant = (grants: DecisionConditions): void => {
  if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) {
    throw new DomainError('POLICY_RULE_GRANT_INVALID', 'grants must be an object');
  }
  for (const key of Object.keys(grants)) {
    if (!(GRANT_KEYS as readonly string[]).includes(key)) {
      throw new DomainError(
        'POLICY_RULE_GRANT_INVALID',
        `grants has unknown key "${key}" (a typo'd grant would silently grant nothing)`,
        { key, allowed: GRANT_KEYS },
      );
    }
  }
  if (Object.keys(grants).length === 0) {
    throw new DomainError(
      'POLICY_RULE_GRANT_INVALID',
      'grants must carry at least one of maxAmountMinor / allowedChannels / expiresAt',
    );
  }
  if (grants.maxAmountMinor !== undefined) {
    const max = grants.maxAmountMinor;
    if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0) {
      throw new DomainError(
        'POLICY_RULE_GRANT_INVALID',
        `grants.maxAmountMinor must be a non-negative safe integer, got ${String(max)}`,
      );
    }
  }
  if (grants.allowedChannels !== undefined) {
    const channels = grants.allowedChannels;
    if (
      !Array.isArray(channels) ||
      channels.length === 0 ||
      !channels.every((c) => (CHANNELS as readonly string[]).includes(c))
    ) {
      throw new DomainError(
        'POLICY_RULE_GRANT_INVALID',
        'grants.allowedChannels must be a non-empty array of known channels',
        { allowed: CHANNELS },
      );
    }
  }
  if (grants.expiresAt !== undefined) {
    const expiresAt = grants.expiresAt;
    if (typeof expiresAt !== 'string' || Number.isNaN(new Date(expiresAt).getTime())) {
      throw new DomainError(
        'POLICY_RULE_GRANT_INVALID',
        `grants.expiresAt must be a parseable ISO-8601 instant, got "${String(expiresAt)}"`,
      );
    }
  }
};

/**
 * Validate one rule. Throws (stable codes):
 *   POLICY_RULE_INVALID, POLICY_RULE_ID_REQUIRED, POLICY_RULE_PRIORITY_INVALID,
 *   POLICY_RULE_ACTION_INVALID, POLICY_RULE_DECISION_INVALID,
 *   POLICY_RULE_REASON_INVALID (blank or missing the POLICY_ prefix),
 *   POLICY_RULE_EXPLANATION_REQUIRED, POLICY_RULE_CONDITIONS_INVALID,
 *   POLICY_RULE_FIELD_UNKNOWN, POLICY_RULE_OPERATOR_INVALID,
 *   POLICY_RULE_CONDITION_VALUE_REQUIRED/_FORBIDDEN/_INVALID,
 *   POLICY_RULE_GRANT_INVALID (malformed grant, or a grant on a DENY rule —
 *   a refusal grants nothing).
 */
export function assertValidRule(rule: PolicyRule, index: number): void {
  const where = `rules[${index}]`;
  if (rule === null || typeof rule !== 'object') {
    throw new DomainError('POLICY_RULE_INVALID', `${where} must be an object`, { where });
  }
  if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
    throw new DomainError('POLICY_RULE_ID_REQUIRED', `${where} requires a non-blank id`, { where });
  }
  if (typeof rule.priority !== 'number' || !Number.isSafeInteger(rule.priority) || rule.priority < 0) {
    throw new DomainError(
      'POLICY_RULE_PRIORITY_INVALID',
      `${where} (${rule.id}): priority must be a safe integer ≥ 0, got ${String(rule.priority)}`,
      { ruleId: rule.id, priority: rule.priority },
    );
  }
  if (rule.actionType !== 'any' && !(ACTION_TYPES as readonly string[]).includes(rule.actionType)) {
    throw new DomainError(
      'POLICY_RULE_ACTION_INVALID',
      `${where} (${rule.id}): actionType must be 'any' or a known action, got "${String(rule.actionType)}"`,
      { ruleId: rule.id, actionType: rule.actionType, allowed: ACTION_TYPES },
    );
  }
  if (!(DECISIONS as readonly string[]).includes(rule.decision)) {
    throw new DomainError(
      'POLICY_RULE_DECISION_INVALID',
      `${where} (${rule.id}): unknown decision "${String(rule.decision)}"`,
      { ruleId: rule.id, allowed: DECISIONS },
    );
  }
  if (
    typeof rule.reasonCode !== 'string' ||
    rule.reasonCode.trim().length === 0 ||
    !rule.reasonCode.startsWith('POLICY_')
  ) {
    throw new DomainError(
      'POLICY_RULE_REASON_INVALID',
      `${where} (${rule.id}): reasonCode must be a non-blank POLICY_* code`,
      { ruleId: rule.id, reasonCode: rule.reasonCode },
    );
  }
  if (typeof rule.explanation !== 'string' || rule.explanation.trim().length === 0) {
    throw new DomainError(
      'POLICY_RULE_EXPLANATION_REQUIRED',
      `${where} (${rule.id}): explanation must be human-readable and non-blank`,
      { ruleId: rule.id },
    );
  }
  if (!Array.isArray(rule.conditions)) {
    throw new DomainError(
      'POLICY_RULE_CONDITIONS_INVALID',
      `${where} (${rule.id}): conditions must be an array (possibly empty)`,
      { ruleId: rule.id },
    );
  }
  rule.conditions.forEach((condition, i) => assertValidCondition(condition, i));
  if (rule.grants !== undefined && rule.grants !== null) {
    if (rule.decision === 'deny') {
      throw new DomainError(
        'POLICY_RULE_GRANT_INVALID',
        `${where} (${rule.id}): a deny rule cannot grant conditions — a refusal grants nothing`,
        { ruleId: rule.id },
      );
    }
    assertValidGrant(rule.grants);
  }
}

// --- rules + rule sets --------------------------------------------------------------

/** Optional bounds a matching allow/requires_approval rule attaches to its decision. */
export interface DecisionConditions {
  readonly maxAmountMinor?: number;
  readonly allowedChannels?: readonly Channel[];
  /** ISO-8601 — the grant (or the approval it backs) lapses after this instant. */
  readonly expiresAt?: string;
}

export interface PolicyRule {
  /** Unique, stable within its rule set — the audit-trail handle. */
  readonly id: string;
  /** Lower = evaluated first; unique within the rule set (total evaluation order). */
  readonly priority: number;
  /** 'any' scopes the rule to every known action type. */
  readonly actionType: ActionType | 'any';
  readonly decision: Decision;
  /** ALL must match (AND). Empty = unconditional. */
  readonly conditions: readonly PolicyCondition[];
  /** Stable POLICY_* machine reason emitted when the rule matches. */
  readonly reasonCode: string;
  /** Human-readable explanation emitted when the rule matches. */
  readonly explanation: string;
  /** Bounds attached to allow/requires_approval decisions; a deny rule cannot grant. */
  readonly grants?: DecisionConditions | null;
}

export interface PolicyRuleSet {
  readonly orgId: Uuid;
  /** Monotonic, immutable — a new rule set object per version, never a mutation. */
  readonly version: number;
  /** ISO-8601 — when this version was created (from the injected Clock). */
  readonly createdAt: string;
  /** Deep-frozen, ordered by ascending priority — first match wins. */
  readonly rules: readonly PolicyRule[];
}

/**
 * Recursively freeze a value (rule sets, rules, grants, decisions, events).
 * In strict-mode ESM any later mutation attempt throws, so versions are
 * immutable by construction, not by convention.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const assertClockDate = (at: Date): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError('POLICY_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return at;
};

/**
 * Validate a rule set's parts and return its rules in evaluation order
 * (ascending priority — the sort is stable and priorities are unique, so
 * the order is total and deterministic).
 *
 * Throws: POLICY_RULESET_ORG_REQUIRED, POLICY_RULESET_VERSION_INVALID,
 * POLICY_RULESET_RULES_INVALID, POLICY_RULE_ID_DUPLICATE,
 * POLICY_RULE_PRIORITY_DUPLICATE, plus everything assertValidRule throws.
 * An EMPTY rule set is legal — it is the maximally safe posture (the engine
 * denies everything via its fail-closed fallback).
 */
export function validateRuleSet(
  orgId: Uuid,
  version: number,
  rules: readonly PolicyRule[],
): readonly PolicyRule[] {
  if (typeof orgId !== 'string' || orgId.trim().length === 0) {
    throw new DomainError('POLICY_RULESET_ORG_REQUIRED', 'a rule set requires an orgId');
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new DomainError(
      'POLICY_RULESET_VERSION_INVALID',
      `rule set version must be a safe integer ≥ 1, got ${String(version)}`,
    );
  }
  if (!Array.isArray(rules)) {
    throw new DomainError('POLICY_RULESET_RULES_INVALID', 'rules must be an array');
  }
  const seenIds = new Set<string>();
  const seenPriorities = new Set<number>();
  rules.forEach((rule, i) => {
    assertValidRule(rule, i);
    if (seenIds.has(rule.id)) {
      throw new DomainError(
        'POLICY_RULE_ID_DUPLICATE',
        `duplicate rule id: ${rule.id}`,
        { ruleId: rule.id },
      );
    }
    seenIds.add(rule.id);
    if (seenPriorities.has(rule.priority)) {
      throw new DomainError(
        'POLICY_RULE_PRIORITY_DUPLICATE',
        `duplicate priority ${rule.priority} (rule ${rule.id}) — evaluation order must be total`,
        { ruleId: rule.id, priority: rule.priority },
      );
    }
    seenPriorities.add(rule.priority);
  });
  return [...rules].sort((a, b) => a.priority - b.priority);
}

/**
 * Validate + deep-freeze a rule set version. The returned object is the
 * immutable datum adapters persist; evaluating against it never mutates it.
 */
export function createRuleSet(
  orgId: Uuid,
  version: number,
  rules: readonly PolicyRule[],
  clock: Clock,
): PolicyRuleSet {
  const sorted = validateRuleSet(orgId, version, rules);
  const createdAt = assertClockDate(clock.now()).toISOString();
  // Copy every nested array/object BEFORE freezing: the caller's rule input is
  // never frozen, never mutated, never aliased into the published version.
  return deepFreeze({
    orgId,
    version,
    createdAt,
    rules: sorted.map((rule) =>
      deepFreeze({
        ...rule,
        conditions: [...rule.conditions].map((condition) => ({ ...condition })),
        ...(rule.grants
          ? {
              grants: {
                ...rule.grants,
                ...(rule.grants.allowedChannels
                  ? { allowedChannels: [...rule.grants.allowedChannels] }
                  : {}),
              },
            }
          : {}),
      }),
    ),
  });
}

/**
 * The next immutable version of an org's rule set: strictly version + 1,
 * fresh rules validated and frozen, the previous version object untouched.
 */
export function nextVersion(
  current: PolicyRuleSet,
  rules: readonly PolicyRule[],
  clock: Clock,
): PolicyRuleSet {
  return createRuleSet(current.orgId, current.version + 1, rules, clock);
}

// --- the safe-by-default rule set (issue #34 / VISION §3.5 + §3.9) -------------------

/** Write-offs above this require a human approver (VISION §3.9: "writeoff > 100,000"). */
export const DEFAULT_WRITE_OFF_APPROVAL_THRESHOLD_MINOR = 10_000_000; // KES 100,000.00
export const DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR = 5_000_000; // KES 50,000.00

/** Default reason codes — stable, machine-readable, pinned by tests. */
export const POLICY_DISPUTE_OPEN = 'POLICY_DISPUTE_OPEN';
export const POLICY_CONSENT_REQUIRED = 'POLICY_CONSENT_REQUIRED';
export const POLICY_CHANNEL_REQUIRED = 'POLICY_CHANNEL_REQUIRED';
export const POLICY_WRITE_OFF_APPROVAL_REQUIRED = 'POLICY_WRITE_OFF_APPROVAL_REQUIRED';
export const POLICY_REFUND_APPROVAL_REQUIRED = 'POLICY_REFUND_APPROVAL_REQUIRED';
export const POLICY_RISK_APPROVAL_REQUIRED = 'POLICY_RISK_APPROVAL_REQUIRED';
export const POLICY_SUPERVISED_ACTION = 'POLICY_SUPERVISED_ACTION';
export const POLICY_AUTONOMOUS_LOW_RISK = 'POLICY_AUTONOMOUS_LOW_RISK';

/**
 * The default rules, in evaluation order (priority = lower first):
 *
 *   10  deny    automated actions while the receivable is under dispute
 *   20  deny    autonomous customer contact without a consent fact (K2)
 *   30  deny    autonomous customer contact without an explicit channel
 *   100 requires_approval  write-off above the default threshold (ALL actors)
 *   101 requires_approval  refund above the default threshold (ALL actors)
 *   120 requires_approval  autonomous action on an elevated/high-risk subject
 *   900 allow   human-supervised actions (autonomy restrictions bypassed;
 *               the compliance rules above still applied to them)
 *   950 allow   autonomous low-risk actions
 *
 * Deliberate readings of the spec, pinned by tests:
 *   - humans bypass autonomy restrictions (10/20/30/120 are autonomous-only)
 *     but NOT compliance rules (100/101 carry no autonomy condition);
 *   - write_off/refund are the ONLY money-losing actions in the vocabulary;
 *   - anything the rules don't cover is denied by the engine's fail-closed
 *     fallback (POLICY_NO_RULE_MATCHED), never allowed by silence.
 */
export const DEFAULT_RULES: readonly PolicyRule[] = deepFreeze([
  {
    id: 'default-deny-automated-dispute-open',
    priority: 10,
    actionType: 'any',
    decision: 'deny',
    conditions: [
      { field: 'disputeOpen', op: 'is_true' },
      { field: 'autonomous', op: 'is_true' },
    ],
    reasonCode: POLICY_DISPUTE_OPEN,
    explanation:
      'automated actions are denied while the receivable is under an open dispute (SPEC §29 pause)',
  },
  {
    id: 'default-deny-autonomous-send-without-consent',
    priority: 20,
    actionType: 'any',
    decision: 'deny',
    conditions: [
      { field: 'actionType', op: 'in', value: [...CONTACT_ACTION_TYPES] },
      { field: 'autonomous', op: 'is_true' },
      { field: 'consentPresent', op: 'is_false' },
    ],
    reasonCode: POLICY_CONSENT_REQUIRED,
    explanation:
      'autonomous customer contact requires an active consent grant (K2 — consent is never implied)',
  },
  {
    id: 'default-deny-autonomous-send-without-channel',
    priority: 30,
    actionType: 'any',
    decision: 'deny',
    conditions: [
      { field: 'actionType', op: 'in', value: [...CONTACT_ACTION_TYPES] },
      { field: 'autonomous', op: 'is_true' },
      { field: 'channel', op: 'absent' },
    ],
    reasonCode: POLICY_CHANNEL_REQUIRED,
    explanation:
      'autonomous customer contact must name its channel (fail-closed; send_whatsapp/send_sms imply theirs)',
  },
  {
    id: 'default-write-off-approval',
    priority: 100,
    actionType: 'write_off',
    decision: 'requires_approval',
    conditions: [
      { field: 'amountMinor', op: 'gt', value: DEFAULT_WRITE_OFF_APPROVAL_THRESHOLD_MINOR },
    ],
    reasonCode: POLICY_WRITE_OFF_APPROVAL_REQUIRED,
    explanation: 'write-offs above the approval threshold require a human approver (any actor)',
  },
  {
    id: 'default-refund-approval',
    priority: 101,
    actionType: 'refund',
    decision: 'requires_approval',
    conditions: [
      { field: 'amountMinor', op: 'gt', value: DEFAULT_REFUND_APPROVAL_THRESHOLD_MINOR },
    ],
    reasonCode: POLICY_REFUND_APPROVAL_REQUIRED,
    explanation: 'refunds above the approval threshold require a human approver (any actor)',
  },
  {
    id: 'default-elevated-risk-approval',
    priority: 120,
    actionType: 'any',
    decision: 'requires_approval',
    conditions: [
      { field: 'autonomous', op: 'is_true' },
      { field: 'riskClass', op: 'in', value: ['elevated', 'high'] },
    ],
    reasonCode: POLICY_RISK_APPROVAL_REQUIRED,
    explanation:
      'autonomous actions on elevated/high-risk subjects require a human approver (VISION §3.5 human-controlled autonomy)',
  },
  {
    id: 'default-allow-supervised',
    priority: 900,
    actionType: 'any',
    decision: 'allow',
    conditions: [{ field: 'autonomous', op: 'is_false' }],
    reasonCode: POLICY_SUPERVISED_ACTION,
    explanation:
      'human-supervised action — autonomy restrictions do not apply; the compliance rules above still evaluated it',
  },
  {
    id: 'default-allow-autonomous-low-risk',
    priority: 950,
    actionType: 'any',
    decision: 'allow',
    conditions: [
      { field: 'autonomous', op: 'is_true' },
      { field: 'riskClass', op: 'eq', value: 'low' },
    ],
    reasonCode: POLICY_AUTONOMOUS_LOW_RISK,
    explanation: 'autonomous low-risk action allowed by the safe-by-default rule set',
  },
]) as readonly PolicyRule[];

/**
 * The shipped safe-by-default rule set for one org (version 1). Orgs that
 * want a different posture publish a NEW version with their own rules —
 * the defaults are data, so overriding them is data too.
 */
export function defaultRuleSetFor(orgId: Uuid, clock: Clock): PolicyRuleSet {
  return createRuleSet(orgId, 1, DEFAULT_RULES, clock);
}

/**
 * Cheap structural check of a rule-set REFERENCE before evaluation (full
 * validation happens once, at creation — see validateRuleSet). Throws stable
 * codes instead of letting a garbage rule set escape as a raw TypeError:
 *   POLICY_RULESET_INVALID (not an object / rules not an array),
 *   POLICY_RULESET_ORG_REQUIRED (blank org),
 *   POLICY_RULESET_VERSION_INVALID (not a safe integer ≥ 1).
 */
export function assertRuleSetReference(ruleSet: PolicyRuleSet): void {
  if (ruleSet === null || typeof ruleSet !== 'object') {
    throw new DomainError('POLICY_RULESET_INVALID', 'a rule set must be an object');
  }
  if (typeof ruleSet.orgId !== 'string' || ruleSet.orgId.trim().length === 0) {
    throw new DomainError('POLICY_RULESET_ORG_REQUIRED', 'a rule set requires an orgId');
  }
  if (typeof ruleSet.version !== 'number' || !Number.isSafeInteger(ruleSet.version) || ruleSet.version < 1) {
    throw new DomainError(
      'POLICY_RULESET_VERSION_INVALID',
      `rule set version must be a safe integer ≥ 1, got ${String(ruleSet.version)}`,
    );
  }
  if (!Array.isArray(ruleSet.rules)) {
    throw new DomainError('POLICY_RULESET_INVALID', 'rule set rules must be an array');
  }
}

// --- convenience ----------------------------------------------------------------------

/** True for the actions the engine refuses without an amount (write_off, refund). */
export const actionRequiresAmount = (actionType: string): boolean =>
  (AMOUNT_REQUIRED_ACTION_TYPES as readonly string[]).includes(actionType);
