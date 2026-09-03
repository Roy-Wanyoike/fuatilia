import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  MATCH_ALWAYS,
  MATCH_THRESHOLD_MET,
  NO_POLICY_MATCH,
  type ApprovalEvalRequest,
  type ApprovalPolicy,
  assertApprovalPolicy,
  assertPolicySet,
  defineApprovalPolicy,
  definePolicySet,
  evaluateApprovalRequirement,
} from './policy';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const OTHER_ORG = uid(999);
const POLICY_ID = uid(902);
const T0 = '2026-03-01T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const basePolicy: ApprovalPolicy = {
  policyId: POLICY_ID,
  orgId: ORG,
  operationType: 'refund',
  threshold: { amountMinor: 100_000, currency: 'KES' },
  requiredApproverRoles: ['role_manager'],
  quorum: 1,
  ttlDays: 3,
};

// Overrides are deliberately loose — this builder exists to produce BOTH
// valid requests and malformed ones (unknown currencies, blank ids, ...).
const evalRequest = (overrides: Record<string, unknown> = {}): ApprovalEvalRequest =>
  ({
    orgId: ORG,
    operationType: 'refund',
    amountMinor: 250_000,
    currency: 'KES',
    ...overrides,
  }) as unknown as ApprovalEvalRequest;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- structural validation -----------------------------------------------------

describe('assertApprovalPolicy / assertPolicySet — a typo-d policy is a security bug', () => {
  it('accepts a valid policy and deep-freezes it via defineApprovalPolicy', () => {
    const policy = defineApprovalPolicy(basePolicy);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.requiredApproverRoles)).toBe(true);
    expect(Object.isFrozen(policy.threshold)).toBe(true);
    // defineApprovalPolicy copies: mutating the input afterwards cannot touch the policy
    (basePolicy.requiredApproverRoles as string[]).push('role_sneaky');
    expect(policy.requiredApproverRoles).toEqual(['role_manager']);
  });

  it('refuses malformed single policies with stable codes (table)', () => {
    const cases: readonly {
      readonly name: string;
      readonly policy: unknown;
      readonly code: string;
    }[] = [
      { name: 'not an object', policy: null, code: 'APPROVAL_POLICY_INVALID' },
      { name: 'an array', policy: [basePolicy], code: 'APPROVAL_POLICY_INVALID' },
      { name: 'blank orgId', policy: { ...basePolicy, orgId: '  ' }, code: 'APPROVAL_POLICY_ORG_REQUIRED' },
      { name: 'blank policyId', policy: { ...basePolicy, policyId: '' }, code: 'APPROVAL_POLICY_ID_REQUIRED' },
      {
        name: 'unknown operation type',
        policy: { ...basePolicy, operationType: 'gdpr_erase' },
        code: 'APPROVAL_POLICY_OPERATION_INVALID',
      },
      {
        name: 'negative threshold',
        policy: { ...basePolicy, threshold: { amountMinor: -1, currency: 'KES' } },
        code: 'APPROVAL_POLICY_THRESHOLD_INVALID',
      },
      {
        name: 'non-integer threshold',
        policy: { ...basePolicy, threshold: { amountMinor: 10.5, currency: 'KES' } },
        code: 'APPROVAL_POLICY_THRESHOLD_INVALID',
      },
      {
        name: 'threshold amount without currency',
        policy: { ...basePolicy, threshold: { amountMinor: 5, currency: null as unknown as string } },
        code: 'APPROVAL_POLICY_THRESHOLD_INVALID',
      },
      {
        name: 'unknown threshold currency',
        policy: { ...basePolicy, threshold: { amountMinor: 5, currency: 'GBPX' } },
        code: 'APPROVAL_POLICY_CURRENCY_INVALID',
      },
      {
        name: 'zero roles',
        policy: { ...basePolicy, requiredApproverRoles: [] },
        code: 'APPROVAL_POLICY_ROLES_REQUIRED',
      },
      {
        name: 'blank role id',
        policy: { ...basePolicy, requiredApproverRoles: [' '] },
        code: 'APPROVAL_POLICY_ROLE_INVALID',
      },
      {
        name: 'duplicate role',
        policy: { ...basePolicy, requiredApproverRoles: ['role_manager', 'role_manager'] },
        code: 'APPROVAL_POLICY_ROLE_DUPLICATE',
      },
      { name: 'quorum 0', policy: { ...basePolicy, quorum: 0 }, code: 'APPROVAL_POLICY_QUORUM_INVALID' },
      {
        name: 'fractional quorum',
        policy: { ...basePolicy, quorum: 1.5 },
        code: 'APPROVAL_POLICY_QUORUM_INVALID',
      },
      {
        name: 'quorum above the role count',
        policy: { ...basePolicy, requiredApproverRoles: ['role_manager'], quorum: 2 },
        code: 'APPROVAL_POLICY_QUORUM_EXCEEDS_ROLES',
      },
      { name: 'ttl 0', policy: { ...basePolicy, ttlDays: 0 }, code: 'APPROVAL_POLICY_TTL_INVALID' },
      {
        name: 'fractional ttl',
        policy: { ...basePolicy, ttlDays: 2.5 },
        code: 'APPROVAL_POLICY_TTL_INVALID',
      },
    ];
    for (const c of cases) {
      expectCode(() => assertApprovalPolicy(c.policy as ApprovalPolicy), c.code);
    }
  });

  it('quorum equal to the role count is the legal boundary', () => {
    assertApprovalPolicy({ ...basePolicy, requiredApproverRoles: ['a', 'b'], quorum: 2 });
  });

  it('refuses a non-array set', () => {
    expectCode(() => assertPolicySet(basePolicy as unknown as ApprovalPolicy[]), 'APPROVAL_POLICYSET_INVALID');
  });

  it('accepts an EMPTY set — an org that opted out of maker-checker entirely', () => {
    expect(() => assertPolicySet([])).not.toThrow();
  });

  it('refuses set-level ambiguities with stable codes (table)', () => {
    const catchAll: ApprovalPolicy = { ...basePolicy, policyId: uid(910), threshold: null };
    const secondCatchAll: ApprovalPolicy = { ...catchAll, policyId: uid(911) };
    const thresholded: ApprovalPolicy = { ...basePolicy, policyId: uid(912) };
    const sameThreshold: ApprovalPolicy = { ...thresholded, policyId: uid(913) };
    const cases: readonly { readonly name: string; readonly set: ApprovalPolicy[]; readonly code: string }[] = [
      {
        name: 'duplicate policyId',
        set: [thresholded, { ...thresholded }],
        code: 'APPROVAL_POLICY_ID_DUPLICATE',
      },
      {
        name: 'two catch-alls for one operation type',
        set: [catchAll, secondCatchAll],
        code: 'APPROVAL_POLICY_DUPLICATE',
      },
      {
        name: 'two policies at the same threshold',
        set: [thresholded, sameThreshold],
        code: 'APPROVAL_POLICY_DUPLICATE',
      },
      {
        name: 'mixed orgs in one set',
        set: [basePolicy, { ...basePolicy, orgId: OTHER_ORG, policyId: uid(914) }],
        code: 'APPROVAL_POLICYSET_ORG_MISMATCH',
      },
    ];
    for (const c of cases) {
      expectCode(() => assertPolicySet(c.set), c.code);
    }
  });

  it('allows layered thresholds for one operation type (distinct amounts)', () => {
    const set = definePolicySet([
      basePolicy,
      { ...basePolicy, policyId: uid(915), threshold: { amountMinor: 1_000_000, currency: 'KES' } },
      {
        ...basePolicy,
        policyId: uid(916),
        operationType: 'write_off',
        threshold: { amountMinor: 100_000, currency: 'KES' },
      },
    ]);
    expect(set).toHaveLength(3);
  });
});

// --- evaluation ----------------------------------------------------------------

describe('evaluateApprovalRequirement — deterministic requirement resolution', () => {
  it('no policy for the operation type ⇒ EXEMPT with reason NO_POLICY_MATCH', () => {
    const requirement = evaluateApprovalRequirement([basePolicy], evalRequest({ operationType: 'write_off' }), at(T0));
    expect(requirement.requiresApproval).toBe(false);
    if (!requirement.requiresApproval) {
      expect(requirement.reason).toBe(NO_POLICY_MATCH);
      expect(requirement.reason).toBe('NO_POLICY_MATCH');
    }
  });

  it('an EMPTY policy set exempts everything', () => {
    const requirement = evaluateApprovalRequirement([], evalRequest(), at(T0));
    expect(requirement).toEqual({ requiresApproval: false, reason: 'NO_POLICY_MATCH' });
  });

  it('threshold boundary — BELOW the threshold is exempt (99 999 vs 100 000)', () => {
    const requirement = evaluateApprovalRequirement([basePolicy], evalRequest({ amountMinor: 99_999 }), at(T0));
    expect(requirement.requiresApproval).toBe(false);
  });

  it('threshold boundary — AT the threshold requires approval (100 000)', () => {
    const requirement = evaluateApprovalRequirement([basePolicy], evalRequest({ amountMinor: 100_000 }), at(T0));
    expect(requirement.requiresApproval).toBe(true);
    if (requirement.requiresApproval) {
      expect(requirement.matchedPolicy.policyId).toBe(POLICY_ID);
      expect(requirement.evidence.matchBasis).toBe(MATCH_THRESHOLD_MET);
      expect(requirement.evidence.threshold).toEqual({ amountMinor: 100_000, currency: 'KES' });
    }
  });

  it('threshold boundary — ABOVE the threshold requires approval (100 001)', () => {
    const requirement = evaluateApprovalRequirement([basePolicy], evalRequest({ amountMinor: 100_001 }), at(T0));
    expect(requirement.requiresApproval).toBe(true);
  });

  it('a threshold of 0 ALWAYS requires approval — even for a zero-amount request', () => {
    const policy = defineApprovalPolicy({ ...basePolicy, threshold: { amountMinor: 0, currency: 'KES' } });
    for (const amountMinor of [0, 1, 99_999_999]) {
      const requirement = evaluateApprovalRequirement([policy], evalRequest({ amountMinor }), at(T0));
      expect(requirement.requiresApproval).toBe(true);
    }
  });

  it('a catch-all (threshold null) governs every request of the type — including amount-less ones', () => {
    const policy = defineApprovalPolicy({
      ...basePolicy,
      operationType: 'bank_destination_change',
      threshold: null,
    });
    const requirement = evaluateApprovalRequirement(
      [policy],
      evalRequest({ operationType: 'bank_destination_change', amountMinor: null, currency: null }),
      at(T0),
    );
    expect(requirement.requiresApproval).toBe(true);
    if (requirement.requiresApproval) {
      expect(requirement.evidence.matchBasis).toBe(MATCH_ALWAYS);
      expect(requirement.evidence.threshold).toBeNull();
      expect(requirement.evidence.amountMinor).toBeNull();
    }
  });

  it('an amount-less credit_note under a THRESHOLDED credit_note policy is exempt (no match)', () => {
    const policy = defineApprovalPolicy({
      ...basePolicy,
      operationType: 'credit_note',
      threshold: { amountMinor: 50_000, currency: 'KES' },
    });
    const requirement = evaluateApprovalRequirement(
      [policy],
      evalRequest({ operationType: 'credit_note', amountMinor: null, currency: null }),
      at(T0),
    );
    expect(requirement).toEqual({ requiresApproval: false, reason: 'NO_POLICY_MATCH' });
  });

  it('a threshold in another currency does not match (no cross-currency comparison)', () => {
    const requirement = evaluateApprovalRequirement(
      [basePolicy],
      evalRequest({ amountMinor: 99_999_999_999, currency: 'USD' }),
      at(T0),
    );
    expect(requirement.requiresApproval).toBe(false);
  });

  it('MOST SPECIFIC wins: the highest qualifying threshold (layered gates)', () => {
    const set = definePolicySet([
      { ...basePolicy, policyId: uid(920), threshold: { amountMinor: 100_000, currency: 'KES' } },
      { ...basePolicy, policyId: uid(921), threshold: { amountMinor: 1_000_000, currency: 'KES' } },
    ]);
    const big = evaluateApprovalRequirement(set, evalRequest({ amountMinor: 2_000_000 }), at(T0));
    expect(big.requiresApproval).toBe(true);
    if (big.requiresApproval) expect(big.matchedPolicy.policyId).toBe(uid(921));
    const mid = evaluateApprovalRequirement(set, evalRequest({ amountMinor: 500_000 }), at(T0));
    expect(mid.requiresApproval).toBe(true);
    if (mid.requiresApproval) expect(mid.matchedPolicy.policyId).toBe(uid(920));
  });

  it('a threshold hit beats the catch-all for the same operation type', () => {
    const set = definePolicySet([
      { ...basePolicy, policyId: uid(922), threshold: null },
      { ...basePolicy, policyId: uid(923), threshold: { amountMinor: 100_000, currency: 'KES' } },
    ]);
    const requirement = evaluateApprovalRequirement(set, evalRequest({ amountMinor: 150_000 }), at(T0));
    expect(requirement.requiresApproval).toBe(true);
    if (requirement.requiresApproval) {
      expect(requirement.matchedPolicy.policyId).toBe(uid(923));
      expect(requirement.evidence.matchBasis).toBe(MATCH_THRESHOLD_MET);
    }
  });

  it('evidence carries the full audit shape (roles/quorum/ttl copied, evaluatedAt from the Clock)', () => {
    const policy = defineApprovalPolicy({
      ...basePolicy,
      requiredApproverRoles: ['role_manager', 'role_finance'],
      quorum: 2,
      ttlDays: 5,
    });
    const requirement = evaluateApprovalRequirement([policy], evalRequest(), at(T0));
    expect(requirement.requiresApproval).toBe(true);
    if (requirement.requiresApproval) {
      expect(requirement.evidence).toEqual({
        orgId: ORG,
        policyId: POLICY_ID,
        operationType: 'refund',
        matchBasis: 'THRESHOLD_MET',
        amountMinor: 250_000,
        currency: 'KES',
        threshold: { amountMinor: 100_000, currency: 'KES' },
        requiredApproverRoles: ['role_manager', 'role_finance'],
        quorum: 2,
        ttlDays: 5,
        evaluatedAt: T0,
      });
      expect(Object.isFrozen(requirement)).toBe(true);
      expect(Object.isFrozen(requirement.evidence)).toBe(true);
    }
  });

  it('DETERMINISM: same policies + request + instant ⇒ bit-for-bit the same requirement', () => {
    const set = definePolicySet([basePolicy]);
    const a = evaluateApprovalRequirement(set, evalRequest(), at(T0));
    const b = evaluateApprovalRequirement(set, evalRequest(), at(T0));
    expect(a).toEqual(b);
  });

  it('purity: evaluation never mutates (or freezes) its inputs', () => {
    const raw: ApprovalPolicy = {
      ...basePolicy,
      policyId: uid(924),
      requiredApproverRoles: ['role_manager'],
    };
    const set: ApprovalPolicy[] = [raw];
    evaluateApprovalRequirement(set, evalRequest(), at(T0));
    expect(Object.isFrozen(set)).toBe(false);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(set).toHaveLength(1);
    expect(set[0]).toBe(raw);
  });

  it('malformed evaluation requests throw stable codes (table)', () => {
    const cases: readonly { readonly name: string; readonly request: unknown; readonly code: string }[] = [
      { name: 'not an object', request: 'refund please', code: 'APPROVAL_REQUEST_INVALID' },
      { name: 'blank orgId', request: evalRequest({ orgId: ' ' }), code: 'APPROVAL_ORG_REQUIRED' },
      {
        name: 'unknown operation type',
        request: evalRequest({ operationType: 'purge_ledger' }),
        code: 'APPROVAL_OPERATION_INVALID',
      },
      {
        name: 'amount without currency',
        request: evalRequest({ currency: null }),
        code: 'APPROVAL_AMOUNT_INVALID',
      },
      {
        name: 'currency without amount',
        request: evalRequest({ amountMinor: null }),
        code: 'APPROVAL_AMOUNT_INVALID',
      },
      {
        name: 'negative amount',
        request: evalRequest({ amountMinor: -5 }),
        code: 'APPROVAL_AMOUNT_INVALID',
      },
      {
        name: 'non-integer amount',
        request: evalRequest({ amountMinor: 250.5 }),
        code: 'APPROVAL_AMOUNT_INVALID',
      },
      {
        name: 'unknown currency',
        request: evalRequest({ currency: 'KSH' }),
        code: 'APPROVAL_CURRENCY_INVALID',
      },
    ];
    for (const c of cases) {
      expectCode(
        () => evaluateApprovalRequirement([basePolicy], c.request as ApprovalEvalRequest, at(T0)),
        c.code,
      );
    }
  });

  it('fail-closed: a refund without an amount never evaluates to exempt', () => {
    expectCode(
      () => evaluateApprovalRequirement([basePolicy], evalRequest({ amountMinor: null, currency: null }), at(T0)),
      'APPROVAL_AMOUNT_REQUIRED',
    );
    // write_off carries the same pre-guard…
    expectCode(
      () =>
        evaluateApprovalRequirement(
          [basePolicy],
          evalRequest({ operationType: 'write_off', amountMinor: null, currency: null }),
          at(T0),
        ),
      'APPROVAL_AMOUNT_REQUIRED',
    );
    // …and even an org with NO refund policy cannot be talked into an exempt answer
    expectCode(
      () => evaluateApprovalRequirement([], evalRequest({ amountMinor: null, currency: null }), at(T0)),
      'APPROVAL_AMOUNT_REQUIRED',
    );
  });

  it('a cross-org request is a caller bug, never a silent exemption', () => {
    expectCode(
      () => evaluateApprovalRequirement([basePolicy], evalRequest({ orgId: OTHER_ORG }), at(T0)),
      'APPROVAL_POLICYSET_ORG_MISMATCH',
    );
  });

  it('a broken injected clock surfaces as APPROVAL_CLOCK_INVALID', () => {
    expectCode(
      () => evaluateApprovalRequirement([basePolicy], evalRequest(), { now: () => new Date('nope') }),
      'APPROVAL_CLOCK_INVALID',
    );
    expectCode(
      () => evaluateApprovalRequirement([basePolicy], evalRequest(), {} as Clock),
      'APPROVAL_CLOCK_INVALID',
    );
  });
});
