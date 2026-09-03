/**
 * Org-configurable approval policies (wave 7, issue #52, SPEC §36).
 *
 * A policy is the org's answer to "which sensitive operations need a second
 * pair of eyes": per operation type, optionally above an amount threshold,
 * with the roles allowed to check, how many DISTINCT approvers are required
 * (quorum) and how long a request stays decidable (TTL).
 *
 *   operationType   closed vocabulary — refund | write_off | credit_note |
 *                   bank_destination_change | manual_adjustment (adapters
 *                   cannot invent a seventh kind and have it governed)
 *   threshold       optional amountMinor + Currency; AT or ABOVE the
 *                   threshold requires approval. A threshold of 0 always
 *                   requires approval. No threshold = every request of the
 *                   operation type requires approval (the catch-all gate).
 *   requiredApproverRoles   ≥1 opaque role ids (the auth lane owns role
 *                   truth — this lane only matches ids)
 *   quorum          default 1; N distinct approvers; never more than the
 *                   number of required roles
 *   ttlDays         an approval request stops accepting decisions this many
 *                   days after it is opened
 *
 * `evaluateApprovalRequirement` is DETERMINISTIC and pure: same policies,
 * same request, same clock instant ⇒ same requirement and evidence,
 * bit-for-bit. Matching is deny-by-default in the safe direction:
 *
 *   - no policy for the operation type ⇒ EXEMPT (`NO_POLICY_MATCH`) — the
 *     operation proceeds without maker-checker (an org that never configures
 *     a policy for an operation type has decided it needs none; a MISSING
 *     policy never silently demands approval either);
 *   - a policy whose threshold cannot be compared (amount not supplied)
 *     does NOT match — but `refund` / `write_off` requests without an
 *     amount are REFUSED outright (`APPROVAL_AMOUNT_REQUIRED`, mirrors the
 *     policy lane's POLICY_AMOUNT_REQUIRED pre-guard): an unquantified loss
 *     never slips past the gate by omitting its own amount;
 *   - among several matching policies the MOST SPECIFIC wins — the highest
 *     qualifying threshold (layered gates: ≥100k one checker, ≥1M a
 *     stricter panel); a threshold hit beats the catch-all.
 *
 * Everything is validated data (a typo'd policy is a security bug), deep-
 * frozen once defined, and never mutated by evaluation.
 */
import { DomainError, CURRENCIES, type Clock, type Currency, type Uuid } from '../shared';

// --- vocabularies -------------------------------------------------------------------

/** The governed sensitive-operation vocabulary (SPEC §36, closed). */
export const OPERATION_TYPES = [
  'refund',
  'write_off',
  'credit_note',
  'bank_destination_change',
  'manual_adjustment',
] as const;
export type OperationType = (typeof OPERATION_TYPES)[number];

/**
 * Money-losing operations whose evaluation REQUIRES a quantified amount —
 * mirrors the policy lane's AMOUNT_REQUIRED_ACTION_TYPES. An amount-less
 * refund/write-off is a caller bug (APPROVAL_AMOUNT_REQUIRED), never an
 * exempt evaluation. The other operations may legitimately be amount-less
 * (a bank-destination change carries no amount).
 */
export const AMOUNT_REQUIRED_OPERATIONS: readonly OperationType[] = ['refund', 'write_off'];

// --- the policy ---------------------------------------------------------------------

/** At-or-above this amount (in ONE currency), the operation requires approval. */
export interface ApprovalThreshold {
  /** Non-negative safe integer, minor units. 0 = ALWAYS requires approval. */
  readonly amountMinor: number;
  readonly currency: Currency;
}

export interface ApprovalPolicy {
  readonly policyId: Uuid;
  readonly orgId: Uuid;
  readonly operationType: OperationType;
  /** null = every request of this operation type requires approval (catch-all). */
  readonly threshold: ApprovalThreshold | null;
  /** ≥1 opaque role ids (auth lane owns role truth). */
  readonly requiredApproverRoles: readonly string[];
  /** ≥1 DISTINCT approvers required; ≤ requiredApproverRoles.length. */
  readonly quorum: number;
  /** ≥1 — approval requests expire this many days after opening. */
  readonly ttlDays: number;
}

export const DEFAULT_QUORUM = 1;

// --- structural validation (stable codes; a typo'd policy is a security bug) --------

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * Validate ONE policy. Throws:
 *   - APPROVAL_POLICY_INVALID — not an object;
 *   - APPROVAL_POLICY_ORG_REQUIRED / APPROVAL_POLICY_ID_REQUIRED — blank ids;
 *   - APPROVAL_POLICY_OPERATION_INVALID — unknown operation type;
 *   - APPROVAL_POLICY_THRESHOLD_INVALID — threshold not object, amount not a
 *     non-negative safe integer, or amount/currency not supplied together;
 *   - APPROVAL_POLICY_CURRENCY_INVALID — unknown currency code;
 *   - APPROVAL_POLICY_ROLES_REQUIRED / APPROVAL_POLICY_ROLE_INVALID /
 *     APPROVAL_POLICY_ROLE_DUPLICATE — malformed approver-role list;
 *   - APPROVAL_POLICY_QUORUM_INVALID — not an integer ≥ 1;
 *   - APPROVAL_POLICY_QUORUM_EXCEEDS_ROLES — quorum > number of roles
 *     (N distinct approvers, each matching a required role, cannot exceed
 *     the role count);
 *   - APPROVAL_POLICY_TTL_INVALID — not an integer ≥ 1.
 */
export function assertApprovalPolicy(policy: ApprovalPolicy): void {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new DomainError('APPROVAL_POLICY_INVALID', 'an approval policy must be an object');
  }
  if (!isNonBlank(policy.orgId)) {
    throw new DomainError('APPROVAL_POLICY_ORG_REQUIRED', 'an approval policy requires an orgId');
  }
  if (!isNonBlank(policy.policyId)) {
    throw new DomainError('APPROVAL_POLICY_ID_REQUIRED', 'an approval policy requires a policyId');
  }
  if (!(OPERATION_TYPES as readonly string[]).includes(policy.operationType)) {
    throw new DomainError(
      'APPROVAL_POLICY_OPERATION_INVALID',
      `unknown operation type: ${String(policy.operationType)}`,
      { allowed: OPERATION_TYPES },
    );
  }
  const threshold = policy.threshold;
  if (threshold !== null && threshold !== undefined) {
    if (typeof threshold !== 'object' || Array.isArray(threshold)) {
      throw new DomainError(
        'APPROVAL_POLICY_THRESHOLD_INVALID',
        'a threshold must be an object with amountMinor and currency',
      );
    }
    if (
      typeof threshold.amountMinor !== 'number' ||
      !Number.isSafeInteger(threshold.amountMinor) ||
      threshold.amountMinor < 0
    ) {
      throw new DomainError(
        'APPROVAL_POLICY_THRESHOLD_INVALID',
        `threshold amountMinor must be a non-negative safe integer, got ${String(threshold.amountMinor)}`,
      );
    }
    if (typeof threshold.currency !== 'string') {
      throw new DomainError(
        'APPROVAL_POLICY_THRESHOLD_INVALID',
        'a threshold requires a currency alongside amountMinor',
      );
    }
    if (!(CURRENCIES as readonly string[]).includes(threshold.currency)) {
      throw new DomainError(
        'APPROVAL_POLICY_CURRENCY_INVALID',
        `unknown threshold currency: ${threshold.currency}`,
        { allowed: CURRENCIES },
      );
    }
  }
  if (!Array.isArray(policy.requiredApproverRoles) || policy.requiredApproverRoles.length === 0) {
    throw new DomainError(
      'APPROVAL_POLICY_ROLES_REQUIRED',
      'an approval policy requires at least one approver role',
    );
  }
  for (const role of policy.requiredApproverRoles) {
    if (!isNonBlank(role)) {
      throw new DomainError(
        'APPROVAL_POLICY_ROLE_INVALID',
        `approver roles must be non-blank ids, got ${String(role)}`,
      );
    }
  }
  if (new Set(policy.requiredApproverRoles).size !== policy.requiredApproverRoles.length) {
    throw new DomainError(
      'APPROVAL_POLICY_ROLE_DUPLICATE',
      'an approval policy lists the same approver role twice',
    );
  }
  if (typeof policy.quorum !== 'number' || !Number.isSafeInteger(policy.quorum) || policy.quorum < 1) {
    throw new DomainError(
      'APPROVAL_POLICY_QUORUM_INVALID',
      `quorum must be a safe integer >= 1, got ${String(policy.quorum)}`,
    );
  }
  if (policy.quorum > policy.requiredApproverRoles.length) {
    throw new DomainError(
      'APPROVAL_POLICY_QUORUM_EXCEEDS_ROLES',
      `quorum ${policy.quorum} cannot exceed the ${policy.requiredApproverRoles.length} required role(s)`,
    );
  }
  if (typeof policy.ttlDays !== 'number' || !Number.isSafeInteger(policy.ttlDays) || policy.ttlDays < 1) {
    throw new DomainError(
      'APPROVAL_POLICY_TTL_INVALID',
      `ttlDays must be a safe integer >= 1, got ${String(policy.ttlDays)}`,
    );
  }
}

/**
 * Validate a whole policy set (one org's configuration). Throws everything
 * `assertApprovalPolicy` throws, plus:
 *   - APPROVAL_POLICYSET_INVALID — not an array;
 *   - APPROVAL_POLICY_ID_DUPLICATE — the same policyId twice;
 *   - APPROVAL_POLICY_DUPLICATE — two catch-all (threshold-less) policies
 *     for the same operation type, or two thresholds at the exact same
 *     amountMinor + currency for the same operation type (ambiguous which
 *     gate would win);
 *   - APPROVAL_POLICYSET_ORG_MISMATCH — policies from different orgs in one
 *     set (a set IS one org's configuration).
 * An EMPTY set is legal — the org has opted out of maker-checker entirely
 * (every evaluation is then exempt).
 */
export function assertPolicySet(policies: readonly ApprovalPolicy[]): void {
  if (!Array.isArray(policies)) {
    throw new DomainError('APPROVAL_POLICYSET_INVALID', 'a policy set must be an array');
  }
  const seenIds = new Set<string>();
  const seenOrgs = new Set<string>();
  const catchAllOps = new Set<string>();
  const seenThresholds = new Set<string>();
  for (const policy of policies) {
    assertApprovalPolicy(policy);
    if (seenIds.has(policy.policyId)) {
      throw new DomainError(
        'APPROVAL_POLICY_ID_DUPLICATE',
        `policyId ${policy.policyId} appears twice in the set`,
      );
    }
    seenIds.add(policy.policyId);
    // Org isolation is checked IN-LOOP (before ambiguity checks) — a set from
    // two orgs is a configuration error regardless of threshold overlap.
    if (seenOrgs.size > 0 && !seenOrgs.has(policy.orgId)) {
      throw new DomainError(
        'APPROVAL_POLICYSET_ORG_MISMATCH',
        `a policy set belongs to ONE org (${[...seenOrgs][0]}), found ${policy.orgId}`,
        { orgIds: [...seenOrgs, policy.orgId] },
      );
    }
    seenOrgs.add(policy.orgId);
    if (policy.threshold === null || policy.threshold === undefined) {
      if (catchAllOps.has(policy.operationType)) {
        throw new DomainError(
          'APPROVAL_POLICY_DUPLICATE',
          `two catch-all policies for ${policy.operationType} — ambiguous configuration`,
        );
      }
      catchAllOps.add(policy.operationType);
    } else {
      const key = `${policy.operationType}:${policy.threshold.currency}:${policy.threshold.amountMinor}`;
      if (seenThresholds.has(key)) {
        throw new DomainError(
          'APPROVAL_POLICY_DUPLICATE',
          `two policies for ${policy.operationType} at the same threshold ${policy.threshold.amountMinor} ${policy.threshold.currency}`,
        );
      }
      seenThresholds.add(key);
    }
  }
}

/** Deep-copy + deep-freeze ONE validated policy — policies are immutable data. */
export function defineApprovalPolicy(policy: ApprovalPolicy): ApprovalPolicy {
  assertApprovalPolicy(policy);
  return deepFreeze({
    ...policy,
    threshold:
      policy.threshold === null || policy.threshold === undefined
        ? null
        : { ...policy.threshold },
    requiredApproverRoles: [...policy.requiredApproverRoles],
  });
}

/** Deep-copy + deep-freeze a validated set (order preserved — matching is order-independent anyway). */
export function definePolicySet(policies: readonly ApprovalPolicy[]): readonly ApprovalPolicy[] {
  assertPolicySet(policies);
  return deepFreeze(policies.map(defineApprovalPolicy));
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

// --- evaluation ---------------------------------------------------------------------

/** The plain-data input to `evaluateApprovalRequirement` (opaque ids in, plain data out). */
export interface ApprovalEvalRequest {
  readonly orgId: Uuid;
  readonly operationType: string;
  /** Minor units; null ⇔ currency null — both or neither. */
  readonly amountMinor: number | null;
  readonly currency: Currency | null;
}

/** Why the matched policy matched — audit evidence for the approval demand. */
export const MATCH_THRESHOLD_MET = 'THRESHOLD_MET';
export const MATCH_ALWAYS = 'ALWAYS';
export type MatchBasis = typeof MATCH_THRESHOLD_MET | typeof MATCH_ALWAYS;

/** Exemption reason: no policy governs this operation type for this org. */
export const NO_POLICY_MATCH = 'NO_POLICY_MATCH';

export interface ApprovalRequirementEvidence {
  readonly orgId: Uuid;
  readonly policyId: Uuid;
  readonly operationType: OperationType;
  readonly matchBasis: MatchBasis;
  /** The request amount that crossed the gate (JSON-safe); null for catch-all matches. */
  readonly amountMinor: number | null;
  readonly currency: Currency | null;
  /** Fresh copy of the winning gate; null for catch-all matches. */
  readonly threshold: ApprovalThreshold | null;
  readonly requiredApproverRoles: readonly string[];
  readonly quorum: number;
  readonly ttlDays: number;
  /** ISO-8601 — the evaluation instant, from the injected Clock. */
  readonly evaluatedAt: string;
}

export type ApprovalRequirement =
  | {
      readonly requiresApproval: true;
      readonly matchedPolicy: ApprovalPolicy;
      readonly evidence: ApprovalRequirementEvidence;
    }
  | {
      readonly requiresApproval: false;
      readonly reason: typeof NO_POLICY_MATCH;
    };

const assertClockDate = (clock: Clock): Date => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('APPROVAL_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('APPROVAL_CLOCK_INVALID', `clock returned an invalid Date`);
  }
  return now;
};

/**
 * Resolve whether ONE operation request requires maker-checker approval.
 * Deterministic: ONE Clock read per evaluation (`evaluatedAt` and the
 * caller's downstream stamps can be the same instant on replay).
 *
 * Throws (caller bugs, not governance outcomes):
 *   - APPROVAL_CLOCK_INVALID — broken injected clock;
 *   - APPROVAL_POLICYSET_INVALID / assertPolicySet codes — a broken set;
 *   - APPROVAL_REQUEST_INVALID — the eval request is not an object;
 *   - APPROVAL_ORG_REQUIRED — blank orgId;
 *   - APPROVAL_OPERATION_INVALID — unknown operation type (closed vocab);
 *   - APPROVAL_AMOUNT_INVALID — amount without currency (or vice versa),
 *     negative or non-safe-integer amount;
 *   - APPROVAL_CURRENCY_INVALID — unknown currency code;
 *   - APPROVAL_AMOUNT_REQUIRED — refund/write_off without an amount
 *     (fail-closed pre-guard: an unquantified loss never evaluates to
 *     "exempt" by omitting its amount);
 *   - APPROVAL_POLICYSET_ORG_MISMATCH — the request targets another org
 *     than the set governs (cross-org evaluation must never silently
 *     exempt).
 */
export function evaluateApprovalRequirement(
  policies: readonly ApprovalPolicy[],
  request: ApprovalEvalRequest,
  clock: Clock,
): ApprovalRequirement {
  assertPolicySet(policies);
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new DomainError('APPROVAL_REQUEST_INVALID', 'an evaluation request must be an object');
  }
  if (!isNonBlank(request.orgId)) {
    throw new DomainError('APPROVAL_ORG_REQUIRED', 'an evaluation request requires an orgId');
  }
  if (!(OPERATION_TYPES as readonly string[]).includes(request.operationType)) {
    throw new DomainError(
      'APPROVAL_OPERATION_INVALID',
      `unknown operation type: ${String(request.operationType)}`,
      { allowed: OPERATION_TYPES },
    );
  }
  const hasAmount = request.amountMinor !== null && request.amountMinor !== undefined;
  const hasCurrency = request.currency !== null && request.currency !== undefined;
  if (hasAmount !== hasCurrency) {
    throw new DomainError(
      'APPROVAL_AMOUNT_INVALID',
      'amountMinor and currency must be supplied together (both or neither)',
    );
  }
  if (hasAmount) {
    if (
      typeof request.amountMinor !== 'number' ||
      !Number.isSafeInteger(request.amountMinor) ||
      request.amountMinor < 0
    ) {
      throw new DomainError(
        'APPROVAL_AMOUNT_INVALID',
        `amountMinor must be a non-negative safe integer, got ${String(request.amountMinor)}`,
      );
    }
    if (!(CURRENCIES as readonly string[]).includes(String(request.currency))) {
      throw new DomainError(
        'APPROVAL_CURRENCY_INVALID',
        `unknown currency: ${String(request.currency)}`,
        { allowed: CURRENCIES },
      );
    }
  }
  if (
    (AMOUNT_REQUIRED_OPERATIONS as readonly string[]).includes(request.operationType) &&
    !hasAmount
  ) {
    throw new DomainError(
      'APPROVAL_AMOUNT_REQUIRED',
      `${request.operationType} requires a quantified amount — denied (fail-closed: an unquantified loss never evaluates to exempt)`,
    );
  }
  if (policies.length > 0 && policies[0] !== undefined && policies[0].orgId !== request.orgId) {
    throw new DomainError(
      'APPROVAL_POLICYSET_ORG_MISMATCH',
      `policy set governs org ${policies[0].orgId}, but the request targets org ${request.orgId}`,
      { setOrgId: policies[0].orgId, requestOrgId: request.orgId },
    );
  }

  // ONE Clock read per evaluation.
  const evaluatedAt = assertClockDate(clock).toISOString();

  const candidates = policies.filter((policy) => policy.operationType === request.operationType);
  const amountMinor = hasAmount ? (request.amountMinor as number) : null;
  const currency = hasCurrency ? (request.currency as Currency) : null;

  const matched = candidates.filter((policy) => {
    if (policy.threshold === null) return true; // catch-all governs every request of the type
    return (
      amountMinor !== null &&
      currency === policy.threshold.currency &&
      amountMinor >= policy.threshold.amountMinor // AT the threshold requires approval
    );
  });

  if (matched.length === 0) {
    return deepFreeze({ requiresApproval: false as const, reason: NO_POLICY_MATCH });
  }

  // Most specific wins: the highest qualifying threshold; a threshold hit
  // beats the catch-all. (assertPolicySet already guarantees at most ONE
  // catch-all per operation type, so this order is total and deterministic.)
  const winner = matched.reduce((best, policy) => {
    const bestAmount = best.threshold?.amountMinor ?? -1;
    const policyAmount = policy.threshold?.amountMinor ?? -1;
    return policyAmount > bestAmount ? policy : best;
  });

  const matchBasis = winner.threshold === null ? MATCH_ALWAYS : MATCH_THRESHOLD_MET;
  const evidence: ApprovalRequirementEvidence = deepFreeze({
    orgId: request.orgId,
    policyId: winner.policyId,
    operationType: winner.operationType,
    matchBasis,
    amountMinor,
    currency,
    threshold: winner.threshold === null ? null : { ...winner.threshold },
    requiredApproverRoles: [...winner.requiredApproverRoles],
    quorum: winner.quorum,
    ttlDays: winner.ttlDays,
    evaluatedAt,
  });
  // Fresh immutable copy — deep-freezing the matched policy itself would
  // freeze the CALLER's input (purity violation pinned by tests).
  return deepFreeze({
    requiresApproval: true as const,
    matchedPolicy: deepFreeze({
      ...winner,
      threshold: winner.threshold === null ? null : { ...winner.threshold },
      requiredApproverRoles: [...winner.requiredApproverRoles],
    }),
    evidence,
  });
}


