import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  DEFAULT_QUORUM,
  defineApprovalPolicy,
  type ApprovalPolicy,
} from './policy';
import {
  APPROVAL_TRANSITIONS,
  type ApprovalRequest,
  type ApproveArgs,
  type OpenApprovalRequestArgs,
  approve,
  cancelApprovalRequest,
  expireApprovalRequest,
  markApplied,
  openApprovalRequest,
  reject,
  submitApprovalRequest,
  transitionApproval,
} from './request';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const REQ_ID = uid(902);
const REQ_ID_2 = uid(903);
const SUBJECT = uid(904);
const MAKER = 'user_maker';
const CHECKER = 'user_checker';
const SECOND_CHECKER = 'user_checker_2';
const T0 = '2026-03-01T08:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const plus = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();
const DAY = 86_400_000;

/** Quorum-1 policy: one manager checks the refund. */
const policy: ApprovalPolicy = defineApprovalPolicy({
  policyId: uid(910),
  orgId: ORG,
  operationType: 'refund',
  threshold: { amountMinor: 100_000, currency: 'KES' },
  requiredApproverRoles: ['role_manager'],
  quorum: DEFAULT_QUORUM,
  ttlDays: 3,
});

/** Quorum-2 panel policy: a manager AND a finance officer must both check. */
const panelPolicy: ApprovalPolicy = defineApprovalPolicy({
  policyId: uid(911),
  orgId: ORG,
  operationType: 'refund',
  threshold: { amountMinor: 1_000_000, currency: 'KES' },
  requiredApproverRoles: ['role_manager', 'role_finance'],
  quorum: 2,
  ttlDays: 2,
});

const ALICE = { approverId: 'user_alice', roleIds: ['role_manager'] };
const BOB = { approverId: 'user_bob', roleIds: ['role_finance'] };

const openArgs = (overrides: Record<string, unknown> = {}): OpenApprovalRequestArgs => ({
  approvalRequestId: REQ_ID,
  orgId: ORG,
  operationType: 'refund',
  subjectRefs: [SUBJECT],
  payloadSnapshot: {
    amountMinor: 250_000,
    currency: 'KES',
    summary: 'refund of a double-charged M-Pesa receipt',
  },
  requesterId: MAKER,
  ...overrides,
});

const openReq = (p: ApprovalPolicy = policy, atIso: string = T0): ApprovalRequest =>
  openApprovalRequest(openArgs(), p, at(atIso)).request;

const pendingReq = (p: ApprovalPolicy = policy, atIso: string = T0): ApprovalRequest =>
  submitApprovalRequest(openReq(p, atIso), at(atIso)).request;

/** A pending quorum-2 request with ALICE's decision already recorded (below quorum). */
const pendingPanel2WithOne = (): ApprovalRequest =>
  approve(pendingReq(panelPolicy), ALICE, at(T0)).request;

/** The instant 1ms past the quorum-2 request's 2-day TTL. */
const PAST_TTL = plus(T0, 2 * DAY + 1);

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- opening ------------------------------------------------------------------

describe('openApprovalRequest — the maker opens a request against a matched policy', () => {
  it('creates a frozen drafted request and emits approvals.requestCreated', () => {
    const { request, event } = openApprovalRequest(openArgs(), policy, at(T0));
    expect(request.state).toBe('drafted');
    expect(request.policyId).toBe(policy.policyId);
    expect(request.requiredApproverRoles).toEqual(['role_manager']);
    expect(request.quorum).toBe(1);
    expect(request.decisions).toEqual([]);
    expect(request.submittedAt).toBeNull();
    expect(Object.isFrozen(request)).toBe(true);
    // TTL: expiresAt is createdAt + ttlDays, to the millisecond
    expect(request.expiresAt.toISOString()).toBe(plus(T0, 3 * DAY));
    // envelope in repo style
    expect(event.name).toBe('approvals.requestCreated');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(REQ_ID);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toEqual({
      orgId: ORG,
      approvalRequestId: REQ_ID,
      operationType: 'refund',
      policyId: policy.policyId,
      subjectRefs: [SUBJECT],
      payloadSnapshot: request.payloadSnapshot,
      requesterId: MAKER,
      requiredApproverRoles: ['role_manager'],
      quorum: 1,
      ttlDays: 3,
      expiresAt: plus(T0, 3 * DAY),
      createdAt: T0,
    });
  });

  it('TTL arithmetic — ttlDays 1 and 7 land on exact UTC-day boundaries', () => {
    for (const ttlDays of [1, 7]) {
      const p = defineApprovalPolicy({ ...policy, ttlDays });
      const request = openReq(p);
      expect(request.expiresAt.toISOString()).toBe(plus(T0, ttlDays * DAY));
    }
  });

  it('refuses malformed opens with stable codes (table)', () => {
    const cases: readonly { readonly name: string; readonly args: OpenApprovalRequestArgs; readonly code: string }[] = [
      { name: 'args not an object', args: null as unknown as OpenApprovalRequestArgs, code: 'APPROVAL_REQUEST_INVALID' },
      { name: 'blank approvalRequestId', args: openArgs({ approvalRequestId: '' }), code: 'APPROVAL_ID_REQUIRED' },
      { name: 'blank orgId', args: openArgs({ orgId: ' ' }), code: 'APPROVAL_ORG_REQUIRED' },
      { name: 'unknown operation type', args: openArgs({ operationType: 'purge_ledger' }), code: 'APPROVAL_OPERATION_INVALID' },
      { name: 'operation contradicts the policy', args: openArgs({ operationType: 'write_off' }), code: 'APPROVAL_OPERATION_MISMATCH' },
      { name: 'no subject refs', args: openArgs({ subjectRefs: [] }), code: 'APPROVAL_SUBJECTS_REQUIRED' },
      { name: 'blank subject ref', args: openArgs({ subjectRefs: [''] }), code: 'APPROVAL_SUBJECT_INVALID' },
      { name: 'duplicate subject ref', args: openArgs({ subjectRefs: [SUBJECT, SUBJECT] }), code: 'APPROVAL_SUBJECT_DUPLICATE' },
      { name: 'snapshot not an object', args: openArgs({ payloadSnapshot: '250 KES' }), code: 'APPROVAL_SNAPSHOT_INVALID' },
      { name: 'blank summary', args: openArgs({ payloadSnapshot: { amountMinor: 1, currency: 'KES', summary: '  ' } }), code: 'APPROVAL_SUMMARY_REQUIRED' },
      {
        name: 'summary over 512 chars',
        args: openArgs({ payloadSnapshot: { amountMinor: 1, currency: 'KES', summary: 'x'.repeat(513) } }),
        code: 'APPROVAL_SUMMARY_TOO_LONG',
      },
      {
        name: 'amount without currency',
        args: openArgs({ payloadSnapshot: { amountMinor: 100, currency: null, summary: 's' } }),
        code: 'APPROVAL_AMOUNT_INVALID',
      },
      {
        name: 'unknown snapshot currency',
        args: openArgs({ payloadSnapshot: { amountMinor: 100, currency: 'EURO', summary: 's' } }),
        code: 'APPROVAL_CURRENCY_INVALID',
      },
      {
        name: 'refund snapshot without an amount',
        args: openArgs({ payloadSnapshot: { amountMinor: null, currency: null, summary: 's' } }),
        code: 'APPROVAL_AMOUNT_REQUIRED',
      },
      { name: 'blank requesterId', args: openArgs({ requesterId: ' ' }), code: 'APPROVAL_REQUESTER_REQUIRED' },
    ];
    for (const c of cases) {
      expectCode(
        () => openApprovalRequest(c.args as unknown as Parameters<typeof openApprovalRequest>[0], policy, at(T0)),
        c.code,
      );
    }
  });

  it('refuses a policy from another org and a malformed policy (caller bugs)', () => {
    expectCode(
      () =>
        openApprovalRequest(
          openArgs(),
          defineApprovalPolicy({ ...policy, orgId: uid(999) }),
          at(T0),
        ),
      'APPROVAL_POLICY_ORG_MISMATCH',
    );
    expectCode(
      () => openApprovalRequest(openArgs(), { ...policy, quorum: 99 } as ApprovalPolicy, at(T0)),
      'APPROVAL_POLICY_QUORUM_EXCEEDS_ROLES',
    );
  });

  it('a bank-destination change MAY be amount-less (no APPROVAL_AMOUNT_REQUIRED)', () => {
    const bankPolicy = defineApprovalPolicy({
      ...policy,
      operationType: 'bank_destination_change',
      threshold: null,
    });
    const request = openApprovalRequest(
      openArgs({
        operationType: 'bank_destination_change',
        payloadSnapshot: { amountMinor: null, currency: null, summary: 'destination moved to Co-op Bank acct …4471' },
      }),
      bankPolicy,
      at(T0),
    ).request;
    expect(request.payloadSnapshot.amountMinor).toBeNull();
  });

  it('a broken clock surfaces as APPROVAL_CLOCK_INVALID', () => {
    expectCode(() => openApprovalRequest(openArgs(), policy, {} as Clock), 'APPROVAL_CLOCK_INVALID');
  });
});

// --- submitting ---------------------------------------------------------------

describe('submitApprovalRequest — the dedicated drafted→pending transition', () => {
  it('moves drafted→pending with a submittedAt stamp and NO event (catalog has no requestSubmitted)', () => {
    const result = submitApprovalRequest(openReq(), at(T0));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('pending');
      expect(result.request.submittedAt).toEqual(new Date(T0));
      expect(result.events).toEqual([]);
    }
  });

  it('refuses submissions from other states (refusal VALUE + decisionRefused event)', () => {
    const approved = approve(pendingReq(), { approverId: CHECKER, roleIds: ['role_manager'] }, at(T0))
      .request as ApprovalRequest & { state: 'approved' };
    const cases: readonly { readonly request: ApprovalRequest; readonly at: string; readonly code: string }[] = [
      { request: pendingReq(), at: T0, code: 'APPROVAL_NOT_DRAFTED' },
      { request: approved, at: T0, code: 'APPROVAL_NOT_DRAFTED' },
      { request: openReq(), at: plus(T0, 3 * DAY + 1), code: 'APPROVAL_REQUEST_EXPIRED' },
    ];
    for (const c of cases) {
      const result = submitApprovalRequest(c.request, at(c.at));
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.refusal.reasonCode).toBe(c.code);
        expect(result.event.name).toBe('approvals.decisionRefused');
        expect(result.event.payload.reasonCode).toBe(c.code);
        expect(result.event.payload.attempted).toBe('submit');
      }
    }
  });
});

// --- approving ----------------------------------------------------------------

describe('approve — DISTINCT-approver quorum, self-approval guard, append-only log', () => {
  it('quorum 1: the single approval flips the state and emits quorumMet THEN approved', () => {
    const result = approve(pendingReq(), { approverId: CHECKER, roleIds: ['role_manager'] }, at(T0));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('approved');
      expect(result.request.approvedAt).toEqual(new Date(T0));
      expect(result.request.decisions).toHaveLength(1);
      expect(result.request.decisions[0]).toEqual({
        approverId: CHECKER,
        matchedRoles: ['role_manager'],
        decidedAt: new Date(T0),
      });
      expect(result.events.map((e) => e.name)).toEqual(['approvals.quorumMet', 'approvals.approved']);
      const [quorumMet, approved] = result.events;
      if (quorumMet?.name === 'approvals.quorumMet' && approved?.name === 'approvals.approved') {
        expect(quorumMet.payload).toEqual({
          orgId: ORG,
          approvalRequestId: REQ_ID,
          operationType: 'refund',
          quorum: 1,
          distinctApproverCount: 1,
          metAt: T0,
        });
        expect(approved.payload.distinctApproverCount).toBe(1);
        // ONE clock read: the stamps and BOTH events share the same instant
        expect(quorumMet.occurredAt).toBe(T0);
        expect(approved.occurredAt).toBe(T0);
        expect(approved.payload.approvedAt).toBe(T0);
      }
    }
  });

  it('quorum 2: below quorum the decision lands in the log with NO event; the second DISTINCT approval crosses', () => {
    const first = approve(pendingReq(panelPolicy), ALICE, at(T0));
    expect(first.accepted).toBe(true);
    if (first.accepted) {
      expect(first.request.state).toBe('pending');
      expect(first.request.decisions).toHaveLength(1);
      expect(first.events).toEqual([]);
    }
    const second = approve(pendingPanel2WithOne(), BOB, at(T0));
    expect(second.accepted).toBe(true);
    if (second.accepted) {
      expect(second.request.state).toBe('approved');
      expect(second.request.decisions.map((d) => d.approverId)).toEqual(['user_alice', 'user_bob']);
      expect(second.events.map((e) => e.name)).toEqual(['approvals.quorumMet', 'approvals.approved']);
      const quorumMet = second.events[0];
      if (quorumMet?.name === 'approvals.quorumMet') {
        expect(quorumMet.payload.distinctApproverCount).toBe(2);
        expect(quorumMet.payload.quorum).toBe(2);
      }
    }
  });

  it('SELF-APPROVAL is refused — refusal value AND decisionRefused event, state untouched', () => {
    const pending = pendingReq();
    const result = approve(pending, { approverId: MAKER, roleIds: ['role_manager'] }, at(T0));
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.refusal).toEqual({
        operation: 'approve',
        reasonCode: 'APPROVAL_SELF_APPROVAL_REFUSED',
        detail: expect.any(String),
        attemptedBy: MAKER,
      });
      expect(result.event.name).toBe('approvals.decisionRefused');
      expect(result.event.payload.reasonCode).toBe('APPROVAL_SELF_APPROVAL_REFUSED');
      expect(result.event.payload.attempted).toBe('approve');
      expect(result.event.payload.attemptedBy).toBe(MAKER);
      expect(result.event.occurredAt).toBe(T0);
    }
    // the aggregate is untouched: no decision, still pending, input not mutated
    expect(result.request).toBe(pending);
    expect(pending.state).toBe('pending');
    expect(pending.decisions).toHaveLength(0);
  });

  it('the self-approval guard runs BEFORE the role check (holding the role is no exemption)', () => {
    const result = approve(pendingReq(), { approverId: MAKER, roleIds: [] }, at(T0));
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.refusal.reasonCode).toBe('APPROVAL_SELF_APPROVAL_REFUSED');
    }
  });

  it('an approver holding NONE of the required roles is refused (deny-by-default)', () => {
    const result = approve(pendingReq(), { approverId: CHECKER, roleIds: ['role_collector', 'role_auditor'] }, at(T0));
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.refusal.reasonCode).toBe('APPROVAL_ROLE_NOT_HELD');
      expect(result.event.payload.reasonCode).toBe('APPROVAL_ROLE_NOT_HELD');
    }
  });

  it('an approver with NO roles at all is refused the same way (empty list is legal input)', () => {
    const result = approve(pendingReq(), { approverId: CHECKER, roleIds: [] }, at(T0));
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.refusal.reasonCode).toBe('APPROVAL_ROLE_NOT_HELD');
  });

  it('matchedRoles records the sorted intersection of held and required roles', () => {
    const result = approve(
      pendingReq(),
      { approverId: CHECKER, roleIds: ['role_collector', 'role_finance', 'role_manager'] },
      at(T0),
    );
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.decisions[0]?.matchedRoles).toEqual(['role_manager']);
    }
  });

  it('a DUPLICATE approver is refused and the append-only log keeps exactly one decision', () => {
    const once = approve(pendingReq(), { approverId: CHECKER, roleIds: ['role_manager'] }, at(T0));
    expect(once.accepted).toBe(true);
    // a quorum-2 request keeps accepting after one decision — the duplicate is the interesting case
    const onceBelowQuorum = approve(pendingReq(panelPolicy), ALICE, at(T0));
    expect(onceBelowQuorum.accepted).toBe(true);
    const duplicate = approve(pendingPanel2WithOne(), ALICE, at(T0));
    expect(duplicate.accepted).toBe(false);
    if (!duplicate.accepted) {
      expect(duplicate.refusal.reasonCode).toBe('APPROVAL_APPROVER_DUPLICATE');
      expect(duplicate.event.payload.reasonCode).toBe('APPROVAL_APPROVER_DUPLICATE');
    }
    expect(duplicate.request.decisions).toHaveLength(1);
  });

  it('malformed approver input throws stable codes (table)', () => {
    const pending = pendingReq();
    expectCode(() => approve(pending, { approverId: ' ', roleIds: [] }, at(T0)), 'APPROVAL_APPROVER_REQUIRED');
    expectCode(
      () => approve(pending, { approverId: CHECKER, roleIds: 'role_manager' as unknown as string[] }, at(T0)),
      'APPROVAL_APPROVER_ROLES_INVALID',
    );
    expectCode(
      () => approve(pending, { approverId: CHECKER, roleIds: ['role_manager', ''] }, at(T0)),
      'APPROVAL_APPROVER_ROLES_INVALID',
    );
    expectCode(() => approve(pending, null as unknown as ApproveArgs, at(T0)), 'APPROVAL_APPROVER_REQUIRED');
  });

  it('state refusals — deciding a request that is not live (table)', () => {
    const rejected = reject(pendingReq(), { rejectedBy: CHECKER, reason: 'wrong receipt' }, at(T0))
      .request as ApprovalRequest & { state: 'rejected' };
    const approved = approve(pendingReq(), ALICE, at(T0))
      .request as ApprovalRequest & { state: 'approved' };
    const applied = markApplied(approved, at(T0)).request as ApprovalRequest & { state: 'applied' };
    const cases: readonly {
      readonly name: string;
      readonly request: ApprovalRequest;
      readonly at: string;
      readonly code: string;
    }[] = [
      { name: 'drafted', request: openReq(), at: T0, code: 'APPROVAL_NOT_PENDING' },
      { name: 'rotted pending (sweeper has not run)', request: pendingReq(panelPolicy), at: PAST_TTL, code: 'APPROVAL_REQUEST_EXPIRED' },
      {
        name: 'expired',
        request: expireApprovalRequest(pendingReq(), at(plus(T0, 3 * DAY + 1))).request as ApprovalRequest,
        at: T0,
        code: 'APPROVAL_REQUEST_EXPIRED',
      },
      {
        name: 'cancelled',
        request: cancelApprovalRequest(pendingReq(), at(T0)).request as ApprovalRequest,
        at: T0,
        code: 'APPROVAL_REQUEST_CANCELLED',
      },
      { name: 'rejected', request: rejected, at: T0, code: 'APPROVAL_NOT_PENDING' },
      { name: 'approved', request: approved, at: T0, code: 'APPROVAL_NOT_PENDING' },
      { name: 'applied', request: applied, at: T0, code: 'APPROVAL_NOT_PENDING' },
    ];
    for (const c of cases) {
      const result = approve(c.request, ALICE, at(c.at));
      expect(result.accepted, c.name).toBe(false);
      if (!result.accepted) {
        expect(result.refusal.reasonCode, c.name).toBe(c.code);
        expect(result.event.payload.reasonCode, c.name).toBe(c.code);
      }
    }
  });

  it('TTL boundary — AT the expiry instant the request is still decidable; 1ms later it is not', () => {
    const atExpiry = approve(pendingReq(panelPolicy), ALICE, at(plus(T0, 2 * DAY)));
    expect(atExpiry.accepted).toBe(true);
    const refused = approve(pendingReq(panelPolicy), ALICE, at(PAST_TTL));
    expect(refused.accepted).toBe(false);
    if (!refused.accepted) expect(refused.refusal.reasonCode).toBe('APPROVAL_REQUEST_EXPIRED');
  });

  it('a corrupt aggregate state is a caller bug (throws)', () => {
    const corrupt = { ...pendingReq(), state: 'quantum' } as unknown as ApprovalRequest;
    expectCode(() => approve(corrupt, ALICE, at(T0)), 'APPROVAL_STATUS_INVALID');
    expectCode(() => approve(null as unknown as ApprovalRequest, ALICE, at(T0)), 'APPROVAL_REQUEST_INVALID');
  });
});

// --- rejecting ------------------------------------------------------------------

describe('reject — the checker refuses the operation, reason REQUIRED', () => {
  it('rejects a pending request and stores the trimmed reason', () => {
    const result = reject(pendingReq(), { rejectedBy: CHECKER, reason: '  receipt does not match the ledger  ' }, at(T0));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('rejected');
      expect(result.request.rejectedReason).toBe('receipt does not match the ledger');
      expect(result.request.rejectedAt).toEqual(new Date(T0));
      const event = result.events[0];
      if (event?.name === 'approvals.rejected') {
        expect(event.payload).toEqual({
          orgId: ORG,
          approvalRequestId: REQ_ID,
          operationType: 'refund',
          rejectedBy: CHECKER,
          reason: 'receipt does not match the ledger',
          rejectedAt: T0,
        });
      } else {
        throw new Error('expected approvals.rejected');
      }
    }
  });

  it('a rejection without a reason is not an audit record (throws)', () => {
    const pending = pendingReq();
    expectCode(() => reject(pending, { rejectedBy: CHECKER, reason: '   ' }, at(T0)), 'APPROVAL_REASON_REQUIRED');
    expectCode(() => reject(pending, { rejectedBy: CHECKER, reason: '' }, at(T0)), 'APPROVAL_REASON_REQUIRED');
    expectCode(() => reject(pending, { rejectedBy: ' ', reason: 'x' }, at(T0)), 'APPROVAL_ACTOR_REQUIRED');
  });

  it('state refusals carry the specific code (table)', () => {
    const cases: readonly { readonly request: ApprovalRequest; readonly code: string }[] = [
      {
        request: expireApprovalRequest(pendingReq(), at(plus(T0, 3 * DAY + 1))).request as ApprovalRequest,
        code: 'APPROVAL_REQUEST_EXPIRED',
      },
      {
        request: cancelApprovalRequest(pendingReq(), at(T0)).request as ApprovalRequest,
        code: 'APPROVAL_REQUEST_CANCELLED',
      },
      {
        request: approve(pendingReq(), ALICE, at(T0)).request as ApprovalRequest,
        code: 'APPROVAL_NOT_PENDING',
      },
      { request: openReq(), code: 'APPROVAL_NOT_PENDING' },
    ];
    for (const c of cases) {
      const result = reject(c.request, { rejectedBy: CHECKER, reason: 'nope' }, at(T0));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.refusal.reasonCode).toBe(c.code);
    }
  });
});

// --- expiring ------------------------------------------------------------------

describe('expireApprovalRequest — the TTL sweep owns the expired transition', () => {
  it('is NOT due before — and AT — the expiry instant (strictly-past boundary)', () => {
    for (const atIso of [plus(T0, 1), plus(T0, 3 * DAY)]) {
      const result = expireApprovalRequest(pendingReq(), at(atIso));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.refusal.reasonCode).toBe('APPROVAL_EXPIRY_NOT_DUE');
    }
  });

  it('expires a pending request strictly past its TTL and emits approvals.expired', () => {
    const expiredAtIso = plus(T0, 3 * DAY + 1);
    const result = expireApprovalRequest(pendingReq(), at(expiredAtIso));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('expired');
      expect(result.request.expiredAt).toEqual(new Date(expiredAtIso));
      const event = result.events[0];
      if (event?.name === 'approvals.expired') {
        expect(event.payload.expiresAt).toBe(plus(T0, 3 * DAY));
        expect(event.payload.expiredAt).toBe(expiredAtIso);
        expect(event.occurredAt).toBe(expiredAtIso);
      } else {
        throw new Error('expected approvals.expired');
      }
    }
  });

  it('only LIVE requests expire (table)', () => {
    for (const request of [openReq(), approve(pendingReq(), ALICE, at(T0)).request as ApprovalRequest]) {
      const result = expireApprovalRequest(request, at(plus(T0, 3 * DAY + 1)));
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.refusal.reasonCode).toBe('APPROVAL_NOT_PENDING');
    }
  });
});

// --- cancelling + the generic transition ----------------------------------------

describe('transitionApproval — generic transition restricted to cancelled; requester-only', () => {
  it('any target other than cancelled throws APPROVAL_TRANSITION_NOT_AUTOMATIC (use the dedicated functions)', () => {
    const pending = pendingReq();
    for (const to of ['pending', 'approved', 'rejected', 'expired', 'applied', 'drafted'] as const) {
      expectCode(() => transitionApproval(pending, to, { actorId: MAKER }, at(T0)), 'APPROVAL_TRANSITION_NOT_AUTOMATIC');
    }
  });

  it('an unknown target state throws APPROVAL_STATUS_INVALID', () => {
    expectCode(
      () => transitionApproval(pendingReq(), 'obliterated' as ApprovalRequest['state'], { actorId: MAKER }, at(T0)),
      'APPROVAL_STATUS_INVALID',
    );
  });

  it('a table-illegal cancellation throws APPROVAL_TRANSITION_INVALID (a draft is not cancellable)', () => {
    expectCode(
      () => transitionApproval(openReq(), 'cancelled', { actorId: MAKER }, at(T0)),
      'APPROVAL_TRANSITION_INVALID',
    );
  });

  it('a missing actor throws APPROVAL_ACTOR_REQUIRED', () => {
    expectCode(
      () => transitionApproval(pendingReq(), 'cancelled', { actorId: ' ' }, at(T0)),
      'APPROVAL_ACTOR_REQUIRED',
    );
  });

  it('a NON-REQUESTER is refused with a value AND an event; the requester cancels cleanly', () => {
    const stranger = transitionApproval(pendingReq(), 'cancelled', { actorId: CHECKER }, at(T0));
    expect(stranger.accepted).toBe(false);
    if (!stranger.accepted) {
      expect(stranger.refusal.reasonCode).toBe('APPROVAL_CANCEL_NOT_REQUESTER');
      expect(stranger.refusal.attemptedBy).toBe(CHECKER);
      expect(stranger.event.payload.reasonCode).toBe('APPROVAL_CANCEL_NOT_REQUESTER');
      expect(stranger.event.payload.attempted).toBe('cancel');
    }
    const result = cancelApprovalRequest(pendingReq(), at(T0));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('cancelled');
      expect(result.request.cancelledBy).toBe(MAKER);
      expect(result.request.cancelledAt).toEqual(new Date(T0));
      const event = result.events[0];
      if (event?.name === 'approvals.cancelled') {
        expect(event.payload).toEqual({
          orgId: ORG,
          approvalRequestId: REQ_ID,
          operationType: 'refund',
          cancelledBy: MAKER,
          cancelledAt: T0,
        });
      } else {
        throw new Error('expected approvals.cancelled');
      }
    }
  });

  it('the table row set matches the SPEC §36 lifecycle exactly', () => {
    expect(APPROVAL_TRANSITIONS).toEqual({
      drafted: ['pending'],
      pending: ['approved', 'rejected', 'expired', 'cancelled'],
      approved: ['applied'],
      rejected: [],
      expired: [],
      cancelled: [],
      applied: [],
    });
  });
});

// --- applying -----------------------------------------------------------------

describe('markApplied — approved only; returns the evidence bundle; never executes anything', () => {
  const approved2 = (): ApprovalRequest => {
    const first = approve(pendingReq(panelPolicy), ALICE, at(T0));
    const second = approve(first.request as ApprovalRequest, BOB, at(plus(T0, 1)));
    if (!second.accepted) throw new Error('fixture approval must be accepted');
    return second.request;
  };

  it('marks an approved request applied and returns the FULL approval evidence bundle', () => {
    const approved = approve(pendingReq(), { approverId: CHECKER, roleIds: ['role_manager'] }, at(T0));
    if (!approved.accepted) throw new Error('fixture approval must be accepted');
    const appliedAtIso = plus(T0, 5);
    const result = markApplied(approved.request, at(appliedAtIso));
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.request.state).toBe('applied');
      expect(result.request.appliedAt).toEqual(new Date(appliedAtIso));
      expect(result.event.name).toBe('approvals.applied');
      expect(result.event.payload).toEqual({
        orgId: ORG,
        approvalRequestId: REQ_ID,
        operationType: 'refund',
        appliedAt: appliedAtIso,
      });
      // SPEC §37 approval information — everything an auditor needs, ids opaque
      expect(result.evidence).toEqual({
        approvalRequestId: REQ_ID,
        orgId: ORG,
        operationType: 'refund',
        policyId: policy.policyId,
        subjectRefs: [SUBJECT],
        payloadSnapshot: approved.request.payloadSnapshot,
        requesterId: MAKER,
        requiredApproverRoles: ['role_manager'],
        quorum: 1,
        distinctApproverCount: 1,
        decisions: [{ approverId: CHECKER, matchedRoles: ['role_manager'], decidedAt: T0 }],
        createdAt: T0,
        expiresAt: plus(T0, 3 * DAY),
        approvedAt: T0,
        appliedAt: appliedAtIso,
      });
    }
  });

  it('the evidence bundle serializes decisions to ISO — dates leave the domain as strings', () => {
    const second = approve(pendingPanel2WithOne(), BOB, at(plus(T0, 1)));
    if (!second.accepted) throw new Error('fixture approval must be accepted');
    const result = markApplied(second.request, at(T0));
    if (!result.accepted) throw new Error('fixture apply must be accepted');
    expect(result.evidence.decisions).toEqual([
      { approverId: 'user_alice', matchedRoles: ['role_manager'], decidedAt: T0 },
      { approverId: 'user_bob', matchedRoles: ['role_finance'], decidedAt: plus(T0, 1) },
    ]);
    expect(result.evidence.distinctApproverCount).toBe(2);
  });

  it('refuses every non-approved source with the SPECIFIC code (table)', () => {
    const approved = approve(pendingReq(), ALICE, at(T0)).request as ApprovalRequest;
    const cases: readonly {
      readonly name: string;
      readonly request: ApprovalRequest;
      readonly code: string;
      readonly detail?: string;
    }[] = [
      { name: 'pending, zero decisions', request: pendingReq(panelPolicy), code: 'APPROVAL_QUORUM_NOT_MET', detail: '0 of 2' },
      { name: 'pending, 1 of 2', request: pendingPanel2WithOne(), code: 'APPROVAL_QUORUM_NOT_MET', detail: '1 of 2' },
      { name: 'already applied', request: markApplied(approved, at(T0)).request as ApprovalRequest, code: 'APPROVAL_ALREADY_APPLIED' },
      {
        name: 'rejected',
        request: reject(pendingReq(), { rejectedBy: CHECKER, reason: 'x' }, at(T0)).request as ApprovalRequest,
        code: 'APPROVAL_NOT_APPROVED',
      },
      {
        name: 'expired',
        request: expireApprovalRequest(pendingReq(), at(plus(T0, 3 * DAY + 1))).request as ApprovalRequest,
        code: 'APPROVAL_NOT_APPROVED',
      },
      {
        name: 'cancelled',
        request: cancelApprovalRequest(pendingReq(), at(T0)).request as ApprovalRequest,
        code: 'APPROVAL_NOT_APPROVED',
      },
      { name: 'drafted', request: openReq(), code: 'APPROVAL_NOT_APPROVED' },
    ];
    for (const c of cases) {
      const result = markApplied(c.request, at(T0));
      expect(result.accepted, c.name).toBe(false);
      if (!result.accepted) {
        expect(result.refusal.reasonCode, c.name).toBe(c.code);
        if (c.detail !== undefined) {
          expect(result.refusal.detail).toContain(c.detail);
        }
        expect(result.event.payload.reasonCode, c.name).toBe(c.code);
      }
    }
  });

  it('purity: applying never mutates the approved aggregate (fresh frozen copy instead)', () => {
    const approved = approve(pendingReq(), ALICE, at(T0));
    if (!approved.accepted) throw new Error('fixture approval must be accepted');
    const before = approved.request;
    const result = markApplied(before, at(T0));
    if (!result.accepted) throw new Error('fixture apply must be accepted');
    expect(before.state).toBe('approved');
    expect(before.appliedAt).toBeNull();
    expect(result.request).not.toBe(before);
    expect(Object.isFrozen(result.request)).toBe(true);
  });

  it('the quorum-2 happy path approves ONLY with two distinct approvers (a second ALICE never counts)', () => {
    const panel = pendingReq(panelPolicy);
    const a = approve(panel, ALICE, at(T0));
    expect(a.accepted).toBe(true);
    const dupe = approve(a.request as ApprovalRequest, { ...ALICE }, at(T0));
    expect(dupe.accepted).toBe(false);
    const b = approve(a.request as ApprovalRequest, BOB, at(plus(T0, 1)));
    expect(b.accepted).toBe(true);
    if (b.accepted) {
      expect(b.request.state).toBe('approved');
      expect(b.request.decisions).toHaveLength(2);
      const applied = markApplied(b.request, at(plus(T0, 2)));
      expect(applied.accepted).toBe(true);
    }
  });
});

// --- the whole lifecycle --------------------------------------------------------

describe('the full maker-checker lifecycle', () => {
  it('open → submit → approve ×2 → applied: state chain and event sequence', () => {
    const events: string[] = [];
    const opened = openApprovalRequest(openArgs({ approvalRequestId: REQ_ID_2 }), panelPolicy, at(T0));
    events.push(opened.event.name);
    const submitted = submitApprovalRequest(opened.request, at(T0));
    if (!submitted.accepted) throw new Error('fixture submit must be accepted');
    const first = approve(submitted.request, ALICE, at(plus(T0, 1)));
    if (!first.accepted) throw new Error('fixture approve must be accepted');
    events.push(...first.events.map((e) => e.name));
    const second = approve(first.request, BOB, at(plus(T0, 2)));
    if (!second.accepted) throw new Error('fixture approve must be accepted');
    events.push(...second.events.map((e) => e.name));
    const applied = markApplied(second.request, at(plus(T0, 3)));
    if (!applied.accepted) throw new Error('fixture apply must be accepted');
    events.push(applied.event.name);
    expect(events).toEqual([
      'approvals.requestCreated',
      'approvals.quorumMet',
      'approvals.approved',
      'approvals.applied',
    ]);
    expect(applied.request.state).toBe('applied');
  });

  it('the rejected path is terminal — nothing is decidable afterwards', () => {
    const result = reject(pendingReq(), { rejectedBy: CHECKER, reason: 'fraud flag' }, at(T0));
    if (!result.accepted) throw new Error('fixture reject must be accepted');
    expect(APPROVAL_TRANSITIONS.rejected).toEqual([]);
    const late = approve(result.request, ALICE, at(plus(T0, 1)));
    expect(late.accepted).toBe(false);
    if (!late.accepted) expect(late.refusal.reasonCode).toBe('APPROVAL_NOT_PENDING');
  });

  it('the expired path is terminal — the swept request never accepts a late decision', () => {
    const result = expireApprovalRequest(pendingReq(), at(plus(T0, 3 * DAY + 1)));
    if (!result.accepted) throw new Error('fixture expire must be accepted');
    const late = approve(result.request, ALICE, at(plus(T0, 3 * DAY + 2)));
    expect(late.accepted).toBe(false);
    if (!late.accepted) expect(late.refusal.reasonCode).toBe('APPROVAL_REQUEST_EXPIRED');
  });

  it('the cancelled path is terminal — and cancelling a second time is refused', () => {
    const result = cancelApprovalRequest(pendingReq(), at(T0));
    if (!result.accepted) throw new Error('fixture cancel must be accepted');
    expect(APPROVAL_TRANSITIONS.cancelled).toEqual([]);
    const again = cancelApprovalRequest(result.request, at(T0));
    expect(again.accepted).toBe(false);
    if (!again.accepted) expect(again.refusal.reasonCode).toBe('APPROVAL_REQUEST_CANCELLED');
  });

  it('purity end-to-end: the opened aggregate is never mutated by any later transition', () => {
    const opened = openApprovalRequest(openArgs(), panelPolicy, at(T0));
    const original = opened.request;
    submitApprovalRequest(original, at(T0));
    approve(original, ALICE, at(T0));
    reject(original, { rejectedBy: CHECKER, reason: 'x' }, at(T0));
    expect(original.state).toBe('drafted');
    expect(original.decisions).toEqual([]);
    expect(original.submittedAt).toBeNull();
    expect(Object.isFrozen(original)).toBe(true);
  });
});
