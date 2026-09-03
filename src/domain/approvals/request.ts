/**
 * The ApprovalRequest aggregate — maker-checker workflow state (issue #52,
 * SPEC §36).
 *
 *   drafted → pending → approved | rejected | expired | cancelled
 *   approved → applied (terminal); rejected/expired/cancelled/applied terminal
 *
 * A request is OPENED (drafted) by the maker against one matched org policy,
 * SUBMITTED to the checker queue (pending), then decided: approvals
 * accumulate until the quorum of DISTINCT approvers is crossed (state flips
 * to approved — `approvals.quorumMet` then `approvals.approved`, exactly
 * once, same instant), or a checker rejects, the TTL expires it, the maker
 * cancels it. Only an APPROVED request can be MARKED APPLIED — and this
 * lane NEVER executes the operation itself: markApplied returns the
 * approval EVIDENCE BUNDLE for the audit trail (SPEC §37 "approval
 * information"); the fund-truth write belongs to the operation's own lane.
 *
 * Two-tier input contract (house style, matching policy/request.ts):
 *
 *   - MALFORMED input (bad ids, unknown operation type, corrupt snapshot,
 *     broken clock, a non-pending TRANSITION via the table) THROWS a stable
 *     `APPROVAL_*` DomainError — a bug, not a governance outcome;
 *   - GOVERNANCE REFUSALS (self-approval, approver without a required role,
 *     duplicate approver, deciding a cancelled/expired request, applying a
 *     request whose quorum is unmet, cancelling as a non-requester) are
 *     VALUES carrying a stable reason code AND an
 *     `approvals.decisionRefused` event — every refusal is both, never
 *     silent (deny-by-default).
 *
 * Everything is pure: no I/O, no RNG, no Date.now() — ONE injected-Clock
 * read per call stamps the aggregate AND its events (deterministic replay).
 * Every transition returns a FRESH immutable (deep-frozen) aggregate; the
 * decisions log is append-only and the input is never mutated.
 */
import { DomainError, CURRENCIES, type Clock, type Currency, type Uuid } from '../shared';
import {
  AMOUNT_REQUIRED_OPERATIONS,
  OPERATION_TYPES,
  assertApprovalPolicy,
  type ApprovalPolicy,
  type OperationType,
} from './policy';
import {
  APPROVALS_APPROVED,
  APPROVALS_CANCELLED,
  APPROVALS_DECISION_REFUSED,
  APPROVALS_EXPIRED,
  APPROVALS_APPLIED,
  APPROVALS_QUORUM_MET,
  APPROVALS_REJECTED,
  APPROVALS_REQUEST_CREATED,
  domainEvent,
  type AppliedEvent,
  type ApprovalLaneEvent,
  type ApprovedEvent,
  type CancelledEvent,
  type DecisionRefusedEvent,
  type ExpiredEvent,
  type QuorumMetEvent,
  type RejectedEvent,
  type RequestCreatedEvent,
} from './events';

// --- the lifecycle ------------------------------------------------------------------

export const APPROVAL_STATUSES = [
  'drafted',
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'applied',
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The transition table. Terminals are empty rows: `applied`,
 * `rejected`, `expired` and `cancelled` are dead ends — history is never
 * rewritten (R3 spirit).
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  drafted: ['pending'],
  pending: ['approved', 'rejected', 'expired', 'cancelled'],
  approved: ['applied'],
  rejected: [],
  expired: [],
  cancelled: [],
  applied: [],
};

/** Manual (actor-driven) targets of the generic transition; the rest are dedicated functions. */
const MANUAL_TARGETS: readonly ApprovalStatus[] = ['cancelled'];

/** The snapshot of what would execute — caller-redacted by contract, stored verbatim. */
export interface PayloadSnapshot {
  readonly amountMinor: number | null;
  readonly currency: Currency | null;
  /** Non-blank, ≤ 512 chars — the REDACTED summary of the operation. */
  readonly summary: string;
}

/** One recorded approval decision — the append-only checker log. */
export interface ApprovalDecisionRecord {
  readonly approverId: string;
  /** The REQUIRED roles this approver actually holds (sorted, deduped). */
  readonly matchedRoles: readonly string[];
  readonly decidedAt: Date;
}

export interface ApprovalRequest {
  readonly approvalRequestId: Uuid;
  readonly orgId: Uuid;
  readonly operationType: OperationType;
  /** The matched policy that spawned this request (same org). */
  readonly policyId: Uuid;
  /** Opaque cross-lane subject ids (receivable, payment, bank account, …). */
  readonly subjectRefs: readonly Uuid[];
  readonly payloadSnapshot: PayloadSnapshot;
  /** The maker — opaque actor id (auth lane owns identity). */
  readonly requesterId: string;
  readonly state: ApprovalStatus;
  readonly requiredApproverRoles: readonly string[];
  /** DISTINCT approvers required before the state flips to approved. */
  readonly quorum: number;
  readonly createdAt: Date;
  /** Hard stop for decisions: createdAt + policy.ttlDays. */
  readonly expiresAt: Date;
  readonly submittedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly rejectedAt: Date | null;
  readonly rejectedReason: string | null;
  readonly expiredAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly appliedAt: Date | null;
  /** Append-only; duplicates by approverId are refused upstream. */
  readonly decisions: readonly ApprovalDecisionRecord[];
}

// --- refusal shape (every refusal is a VALUE and an event) ---------------------------

export type ApprovalRefusalOperation =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'expire'
  | 'cancel'
  | 'apply';

export interface ApprovalRefusal {
  readonly operation: ApprovalRefusalOperation;
  /** Stable `APPROVAL_*` reason — the machine-readable "why". */
  readonly reasonCode: string;
  readonly detail: string;
  /** Opaque actor who attempted the operation; null when none applies (expire/apply). */
  readonly attemptedBy: string | null;
}

export type ApprovalOperationResult =
  | {
      readonly accepted: true;
      readonly request: ApprovalRequest;
      readonly events: readonly ApprovalLaneEvent[];
    }
  | {
      readonly accepted: false;
      /** The UNCHANGED aggregate (no transition happened). */
      readonly request: ApprovalRequest;
      readonly refusal: ApprovalRefusal;
      /** approvals.decisionRefused — the refusal made observable (audit). */
      readonly event: DecisionRefusedEvent;
    };

// --- the approval evidence bundle (SPEC §37 "approval information") ------------------

export interface ApprovalEvidence {
  readonly approvalRequestId: Uuid;
  readonly orgId: Uuid;
  readonly operationType: OperationType;
  readonly policyId: Uuid;
  readonly subjectRefs: readonly Uuid[];
  readonly payloadSnapshot: PayloadSnapshot;
  readonly requesterId: string;
  readonly requiredApproverRoles: readonly string[];
  readonly quorum: number;
  readonly distinctApproverCount: number;
  /** Every checker decision — serialized ISO, append-only log snapshot. */
  readonly decisions: readonly {
    readonly approverId: string;
    readonly matchedRoles: readonly string[];
    readonly decidedAt: string;
  }[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string;
  readonly appliedAt: string;
}

export type ApplyResult =
  | {
      readonly accepted: true;
      readonly request: ApprovalRequest;
      readonly event: AppliedEvent;
      /** For the audit trail — this lane never executes the operation itself. */
      readonly evidence: ApprovalEvidence;
    }
  | {
      readonly accepted: false;
      readonly request: ApprovalRequest;
      readonly refusal: ApprovalRefusal;
      readonly event: DecisionRefusedEvent;
    };

// --- shared helpers -------------------------------------------------------------------

const SUMMARY_MAX_CHARS = 512;

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
};

const assertClockDate = (clock: Clock): Date => {
  if (typeof clock?.now !== 'function') {
    throw new DomainError('APPROVAL_CLOCK_INVALID', `clock must expose now(): got ${String(clock)}`);
  }
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('APPROVAL_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return now;
};

/** A Clock frozen to ONE already-read instant — ONE read per call, shared by stamps and events. */
const at = (instant: Date): Clock => ({ now: () => instant });

const assertApprovalRequestShape = (request: ApprovalRequest): void => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new DomainError('APPROVAL_REQUEST_INVALID', 'an approval request must be an object');
  }
  if (!(APPROVAL_STATUSES as readonly string[]).includes(request.state)) {
    throw new DomainError(
      'APPROVAL_STATUS_INVALID',
      `unknown approval state: ${String(request.state)}`,
      { allowed: APPROVAL_STATUSES },
    );
  }
};

const validateSnapshot = (snapshot: PayloadSnapshot): void => {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new DomainError(
      'APPROVAL_SNAPSHOT_INVALID',
      'a payload snapshot must be an object with amountMinor, currency and summary',
    );
  }
  if (!isNonBlank(snapshot.summary)) {
    throw new DomainError(
      'APPROVAL_SUMMARY_REQUIRED',
      'a payload snapshot requires a non-blank (redacted) summary',
    );
  }
  if (snapshot.summary.length > SUMMARY_MAX_CHARS) {
    throw new DomainError(
      'APPROVAL_SUMMARY_TOO_LONG',
      `snapshot summary exceeds ${SUMMARY_MAX_CHARS} chars (keep it redacted and small)`,
    );
  }
  const hasAmount = snapshot.amountMinor !== null && snapshot.amountMinor !== undefined;
  const hasCurrency = snapshot.currency !== null && snapshot.currency !== undefined;
  if (hasAmount !== hasCurrency) {
    throw new DomainError(
      'APPROVAL_AMOUNT_INVALID',
      'snapshot amountMinor and currency must be supplied together (both or neither)',
    );
  }
  if (hasAmount) {
    if (
      typeof snapshot.amountMinor !== 'number' ||
      !Number.isSafeInteger(snapshot.amountMinor) ||
      snapshot.amountMinor < 0
    ) {
      throw new DomainError(
        'APPROVAL_AMOUNT_INVALID',
        `snapshot amountMinor must be a non-negative safe integer, got ${String(snapshot.amountMinor)}`,
      );
    }
    if (!(CURRENCIES as readonly string[]).includes(String(snapshot.currency))) {
      throw new DomainError(
        'APPROVAL_CURRENCY_INVALID',
        `unknown snapshot currency: ${String(snapshot.currency)}`,
        { allowed: CURRENCIES },
      );
    }
  }
};

/**
 * The state guard every decision-accepting operation runs first. Returns
 * the stable refusal code when the request cannot be decided NOW:
 *   - pending but past its TTL, or already expired → APPROVAL_REQUEST_EXPIRED
 *   - cancelled                                    → APPROVAL_REQUEST_CANCELLED
 *   - any other non-`pending` state                → `fallbackCode`
 * (fail-closed: a sweeper that forgot to expire a rotted request cannot
 * smuggle a late decision past its TTL).
 */
const stateRefusalFor = (
  request: ApprovalRequest,
  now: Date,
  fallbackCode: string,
): { code: string; detail: string } | null => {
  if (request.state === 'pending') {
    if (now.getTime() > request.expiresAt.getTime()) {
      return {
        code: 'APPROVAL_REQUEST_EXPIRED',
        detail: `request expired at ${request.expiresAt.toISOString()} — the TTL sweep owns the transition`,
      };
    }
    return null;
  }
  if (request.state === 'expired') {
    return { code: 'APPROVAL_REQUEST_EXPIRED', detail: 'the request has expired' };
  }
  if (request.state === 'cancelled') {
    return { code: 'APPROVAL_REQUEST_CANCELLED', detail: 'the request was cancelled by its requester' };
  }
  return {
    code: fallbackCode,
    detail: `the request is ${request.state}, not pending`,
  };
};

const refuse = (
  request: ApprovalRequest,
  operation: ApprovalRefusalOperation,
  attemptedBy: string | null,
  code: string,
  detail: string,
  now: Date,
): { accepted: false; request: ApprovalRequest; refusal: ApprovalRefusal; event: DecisionRefusedEvent } => ({
  accepted: false,
  request,
  refusal: deepFreeze({ operation, reasonCode: code, detail, attemptedBy }),
  event: domainEvent(
    APPROVALS_DECISION_REFUSED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      attempted: operation,
      attemptedBy,
      reasonCode: code,
      detail,
    },
    at(now),
  ),
});

// --- opening (the maker) ---------------------------------------------------------------

export interface OpenApprovalRequestArgs {
  readonly approvalRequestId: Uuid;
  readonly orgId: Uuid;
  readonly operationType: string;
  readonly subjectRefs: readonly Uuid[];
  readonly payloadSnapshot: PayloadSnapshot;
  readonly requesterId: string;
}

/**
 * Open an approval request (state `drafted`) against ONE matched policy —
 * the policy that `evaluateApprovalRequirement` handed back. Computes
 * `expiresAt` from the policy TTL via the injected Clock. Emits
 * `approvals.requestCreated`.
 *
 * Throws (stable codes): APPROVAL_REQUEST_INVALID, APPROVAL_CLOCK_INVALID,
 * APPROVAL_ID_REQUIRED, APPROVAL_ORG_REQUIRED, every assertApprovalPolicy
 * code (a malformed policy is a caller bug), APPROVAL_POLICY_ORG_MISMATCH,
 * APPROVAL_OPERATION_INVALID, APPROVAL_OPERATION_MISMATCH,
 * APPROVAL_SUBJECTS_REQUIRED, APPROVAL_SUBJECT_INVALID,
 * APPROVAL_SUBJECT_DUPLICATE, APPROVAL_SNAPSHOT_INVALID,
 * APPROVAL_SUMMARY_REQUIRED, APPROVAL_SUMMARY_TOO_LONG,
 * APPROVAL_AMOUNT_INVALID, APPROVAL_CURRENCY_INVALID,
 * APPROVAL_AMOUNT_REQUIRED (refund/write_off snapshot without an amount),
 * APPROVAL_REQUESTER_REQUIRED.
 */
export function openApprovalRequest(
  args: OpenApprovalRequestArgs,
  policy: ApprovalPolicy,
  clock: Clock,
): { request: ApprovalRequest; event: RequestCreatedEvent } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new DomainError('APPROVAL_REQUEST_INVALID', 'openApprovalRequest args must be an object');
  }
  const createdAt = assertClockDate(clock);
  if (!isNonBlank(args.approvalRequestId)) {
    throw new DomainError('APPROVAL_ID_REQUIRED', 'an approval request requires an approvalRequestId');
  }
  if (!isNonBlank(args.orgId)) {
    throw new DomainError('APPROVAL_ORG_REQUIRED', 'an approval request requires an orgId');
  }
  assertApprovalPolicy(policy);
  if (policy.orgId !== args.orgId) {
    throw new DomainError(
      'APPROVAL_POLICY_ORG_MISMATCH',
      `policy ${policy.policyId} belongs to org ${policy.orgId}, but the request targets org ${args.orgId}`,
    );
  }
  if (!(OPERATION_TYPES as readonly string[]).includes(args.operationType)) {
    throw new DomainError(
      'APPROVAL_OPERATION_INVALID',
      `unknown operation type: ${String(args.operationType)}`,
      { allowed: OPERATION_TYPES },
    );
  }
  if (args.operationType !== policy.operationType) {
    throw new DomainError(
      'APPROVAL_OPERATION_MISMATCH',
      `request operationType ${args.operationType} does not match policy ${policy.operationType}`,
    );
  }
  if (!Array.isArray(args.subjectRefs) || args.subjectRefs.length === 0) {
    throw new DomainError(
      'APPROVAL_SUBJECTS_REQUIRED',
      'an approval request must reference at least one subject',
    );
  }
  for (const subject of args.subjectRefs) {
    if (!isNonBlank(subject)) {
      throw new DomainError(
        'APPROVAL_SUBJECT_INVALID',
        `subject refs must be non-blank ids, got ${String(subject)}`,
      );
    }
  }
  if (new Set(args.subjectRefs).size !== args.subjectRefs.length) {
    throw new DomainError(
      'APPROVAL_SUBJECT_DUPLICATE',
      'an approval request references the same subject twice',
    );
  }
  validateSnapshot(args.payloadSnapshot);
  if (
    (AMOUNT_REQUIRED_OPERATIONS as readonly string[]).includes(args.operationType) &&
    (args.payloadSnapshot.amountMinor === null || args.payloadSnapshot.amountMinor === undefined)
  ) {
    throw new DomainError(
      'APPROVAL_AMOUNT_REQUIRED',
      `${args.operationType} requires a quantified amount in the snapshot — fail-closed`,
    );
  }
  if (!isNonBlank(args.requesterId)) {
    throw new DomainError('APPROVAL_REQUESTER_REQUIRED', 'an approval request requires a requesterId');
  }

  const expiresAt = new Date(createdAt.getTime() + policy.ttlDays * 86_400_000);

  const request: ApprovalRequest = deepFreeze({
    approvalRequestId: args.approvalRequestId,
    orgId: args.orgId,
    operationType: args.operationType as OperationType,
    policyId: policy.policyId,
    subjectRefs: [...args.subjectRefs],
    payloadSnapshot: deepFreeze({
      amountMinor: args.payloadSnapshot.amountMinor ?? null,
      currency: args.payloadSnapshot.currency ?? null,
      summary: args.payloadSnapshot.summary,
    }),
    requesterId: args.requesterId,
    state: 'drafted',
    requiredApproverRoles: [...policy.requiredApproverRoles],
    quorum: policy.quorum,
    createdAt,
    expiresAt,
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    rejectedReason: null,
    expiredAt: null,
    cancelledAt: null,
    cancelledBy: null,
    appliedAt: null,
    decisions: [],
  });

  const event = domainEvent(
    APPROVALS_REQUEST_CREATED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      policyId: request.policyId,
      subjectRefs: request.subjectRefs,
      payloadSnapshot: request.payloadSnapshot,
      requesterId: request.requesterId,
      requiredApproverRoles: request.requiredApproverRoles,
      quorum: request.quorum,
      ttlDays: policy.ttlDays,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString(),
    },
    clock,
  );
  return { request, event };
}

// --- submitting (drafted → pending) ------------------------------------------------------

/**
 * Submit a drafted request to the checker queue. The dedicated
 * drafted→pending transition (the generic transition is restricted to
 * `cancelled`). Emits NO event: the issue's catalog has no
 * requestSubmitted fact — the request going live is observable via the
 * aggregate's `state`/`submittedAt` (and `approvals.requestCreated` was
 * already emitted at opening). A draft whose TTL has already rotted is
 * refused (open a fresh request).
 */
export function submitApprovalRequest(request: ApprovalRequest, clock: Clock): ApprovalOperationResult {
  assertApprovalRequestShape(request);
  const now = assertClockDate(clock);
  if (request.state === 'drafted' && now.getTime() > request.expiresAt.getTime()) {
    return refuse(request, 'submit', null, 'APPROVAL_REQUEST_EXPIRED', 'the draft rotted past its TTL — open a fresh request', now);
  }
  if (request.state === 'expired') {
    return refuse(request, 'submit', null, 'APPROVAL_REQUEST_EXPIRED', 'the request has expired', now);
  }
  if (request.state === 'cancelled') {
    return refuse(request, 'submit', null, 'APPROVAL_REQUEST_CANCELLED', 'the request was cancelled', now);
  }
  if (request.state !== 'drafted') {
    return refuse(request, 'submit', null, 'APPROVAL_NOT_DRAFTED', `the request is ${request.state}, not drafted`, now);
  }
  const next: ApprovalRequest = deepFreeze({ ...request, state: 'pending', submittedAt: now });
  return { accepted: true, request: next, events: [] };
}

// --- approving (the checker) --------------------------------------------------------------

export interface ApproveArgs {
  readonly approverId: string;
  /** Role ids the approver HOLDS, projected by the caller (auth lane owns truth). */
  readonly roleIds: readonly string[];
}

/**
 * Record one checker's approval. Governance refusals (VALUES + an
 * `approvals.decisionRefused` event, checked in THIS order):
 *   1. APPROVAL_REQUEST_EXPIRED / APPROVAL_REQUEST_CANCELLED /
 *      APPROVAL_NOT_PENDING — the request is not decidable;
 *   2. APPROVAL_SELF_APPROVAL_REFUSED — the maker can never be their own
 *      checker (checked BEFORE roles: holding the role is no exemption);
 *   3. APPROVAL_ROLE_NOT_HELD — the approver holds NONE of the required
 *      roles (deny-by-default);
 *   4. APPROVAL_APPROVER_DUPLICATE — the same approver twice (quorum counts
 *      DISTINCT approvers).
 * On the decision that crosses the quorum the state flips to approved and
 * BOTH `approvals.quorumMet` (first) and `approvals.approved` are emitted —
 * exactly once per request. Below quorum the decision lands in the
 * append-only log with no event (the aggregate is the audit trail).
 */
export function approve(
  request: ApprovalRequest,
  args: ApproveArgs,
  clock: Clock,
): ApprovalOperationResult {
  assertApprovalRequestShape(request);
  const decidedAt = assertClockDate(clock);
  if (!isNonBlank(args?.approverId)) {
    throw new DomainError('APPROVAL_APPROVER_REQUIRED', 'an approval requires a non-blank approverId');
  }
  if (!Array.isArray(args.roleIds)) {
    throw new DomainError(
      'APPROVAL_APPROVER_ROLES_INVALID',
      'roleIds must be an array of role ids (empty is allowed — it just never matches)',
    );
  }
  for (const role of args.roleIds) {
    if (!isNonBlank(role)) {
      throw new DomainError(
        'APPROVAL_APPROVER_ROLES_INVALID',
        `held role ids must be non-blank, got ${String(role)}`,
      );
    }
  }

  const stateRefusal = stateRefusalFor(request, decidedAt, 'APPROVAL_NOT_PENDING');
  if (stateRefusal !== null) {
    return refuse(request, 'approve', args.approverId, stateRefusal.code, stateRefusal.detail, decidedAt);
  }
  if (args.approverId === request.requesterId) {
    return refuse(
      request,
      'approve',
      args.approverId,
      'APPROVAL_SELF_APPROVAL_REFUSED',
      'the requester of an operation can never approve it (maker-checker)',
      decidedAt,
    );
  }
  const held = new Set(args.roleIds);
  const matchedRoles = [...new Set(request.requiredApproverRoles.filter((role) => held.has(role)))].sort();
  if (matchedRoles.length === 0) {
    return refuse(
      request,
      'approve',
      args.approverId,
      'APPROVAL_ROLE_NOT_HELD',
      `approver holds none of the required roles [${request.requiredApproverRoles.join(', ')}]`,
      decidedAt,
    );
  }
  if (request.decisions.some((decision) => decision.approverId === args.approverId)) {
    return refuse(
      request,
      'approve',
      args.approverId,
      'APPROVAL_APPROVER_DUPLICATE',
      `${args.approverId} has already approved this request — quorum counts DISTINCT approvers`,
      decidedAt,
    );
  }

  const decisions: readonly ApprovalDecisionRecord[] = [
    ...request.decisions,
    deepFreeze({ approverId: args.approverId, matchedRoles, decidedAt }),
  ];
  const distinctApproverCount = decisions.length;

  if (distinctApproverCount < request.quorum) {
    const next: ApprovalRequest = deepFreeze({ ...request, decisions });
    return { accepted: true, request: next, events: [] };
  }

  const approvedAt = decidedAt;
  const next: ApprovalRequest = deepFreeze({
    ...request,
    decisions,
    state: 'approved',
    approvedAt,
  });
  const quorumMet: QuorumMetEvent = domainEvent(
    APPROVALS_QUORUM_MET,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      quorum: request.quorum,
      distinctApproverCount,
      metAt: approvedAt.toISOString(),
    },
    at(decidedAt),
  );
  const approved: ApprovedEvent = domainEvent(
    APPROVALS_APPROVED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      quorum: request.quorum,
      distinctApproverCount,
      approvedAt: approvedAt.toISOString(),
    },
    at(decidedAt),
  );
  return { accepted: true, request: next, events: [quorumMet, approved] };
}

// --- rejecting (the checker) ----------------------------------------------------------------

export interface RejectArgs {
  readonly rejectedBy: string;
  /** REQUIRED — a rejection without a reason is not an audit record. */
  readonly reason: string;
}

/**
 * Reject the pending request (any required-role holder may check; the auth
 * lane gates who may attempt). The reason is REQUIRED and stored. Emits
 * `approvals.rejected`.
 */
export function reject(request: ApprovalRequest, args: RejectArgs, clock: Clock): ApprovalOperationResult {
  assertApprovalRequestShape(request);
  const rejectedAt = assertClockDate(clock);
  if (!isNonBlank(args?.rejectedBy)) {
    throw new DomainError('APPROVAL_ACTOR_REQUIRED', 'a rejection requires a non-blank rejectedBy');
  }
  if (!isNonBlank(args.reason)) {
    throw new DomainError('APPROVAL_REASON_REQUIRED', 'a rejection requires a non-blank reason');
  }
  const stateRefusal = stateRefusalFor(request, rejectedAt, 'APPROVAL_NOT_PENDING');
  if (stateRefusal !== null) {
    return refuse(request, 'reject', args.rejectedBy, stateRefusal.code, stateRefusal.detail, rejectedAt);
  }
  const reason = args.reason.trim();
  const next: ApprovalRequest = deepFreeze({
    ...request,
    state: 'rejected',
    rejectedAt,
    rejectedReason: reason,
  });
  const event: RejectedEvent = domainEvent(
    APPROVALS_REJECTED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      rejectedBy: args.rejectedBy,
      reason,
      rejectedAt: rejectedAt.toISOString(),
    },
    at(rejectedAt),
  );
  return { accepted: true, request: next, events: [event] };
}

// --- expiring (the TTL sweep) ------------------------------------------------------------------

/**
 * Expire a pending request whose TTL has passed (strictly: the Clock must
 * be PAST `expiresAt` — at the exact expiry instant the request is still
 * decidable). Emits `approvals.expired`.
 */
export function expireApprovalRequest(request: ApprovalRequest, clock: Clock): ApprovalOperationResult {
  assertApprovalRequestShape(request);
  const expiredAt = assertClockDate(clock);
  if (request.state !== 'pending') {
    return refuse(
      request,
      'expire',
      null,
      'APPROVAL_NOT_PENDING',
      `the request is ${request.state}, not pending — only live requests expire`,
      expiredAt,
    );
  }
  if (expiredAt.getTime() <= request.expiresAt.getTime()) {
    return refuse(
      request,
      'expire',
      null,
      'APPROVAL_EXPIRY_NOT_DUE',
      `the Clock (${expiredAt.toISOString()}) is not past expiresAt (${request.expiresAt.toISOString()})`,
      expiredAt,
    );
  }
  const next: ApprovalRequest = deepFreeze({ ...request, state: 'expired', expiredAt });
  const event: ExpiredEvent = domainEvent(
    APPROVALS_EXPIRED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      expiresAt: request.expiresAt.toISOString(),
      expiredAt: expiredAt.toISOString(),
    },
    at(expiredAt),
  );
  return { accepted: true, request: next, events: [event] };
}

// --- cancelling (the maker withdraws) --------------------------------------------------------

/**
 * The generic table-driven transition, restricted to the ONE manual target:
 * `cancelled` (everything else goes through its dedicated function — a
 * misuse throws APPROVAL_TRANSITION_NOT_AUTOMATIC). Cancelling keeps the
 * requester-only rule: any other actor gets the APPROVAL_CANCEL_NOT_REQUESTER
 * refusal value + event.
 */
export function transitionApproval(
  request: ApprovalRequest,
  to: ApprovalStatus,
  args: { readonly actorId: string },
  clock: Clock,
): ApprovalOperationResult {
  assertApprovalRequestShape(request);
  if (!(APPROVAL_STATUSES as readonly string[]).includes(to)) {
    throw new DomainError('APPROVAL_STATUS_INVALID', `unknown approval state: ${String(to)}`, {
      allowed: APPROVAL_STATUSES,
    });
  }
  if (!MANUAL_TARGETS.includes(to)) {
    throw new DomainError(
      'APPROVAL_TRANSITION_NOT_AUTOMATIC',
      `${to} is not the manual transition — use openApprovalRequest/submit/approve/reject/expire/markApplied`,
      { from: request.state, to },
    );
  }
  if (!isNonBlank(args?.actorId)) {
    throw new DomainError('APPROVAL_ACTOR_REQUIRED', 'a cancellation requires a non-blank actorId');
  }
  const cancelledAt = assertClockDate(clock);
  const stateRefusal = stateRefusalFor(request, cancelledAt, 'APPROVAL_NOT_PENDING');
  // A late cancellation of an ALREADY-TERMINAL post-live request (expired /
  // cancelled) is a redundant CUSTOMER action — refusal VALUE, not a caller
  // bug. Pre-live (drafted) and post-decision (rejected/approved/applied)
  // sources remain table-illegal THROWS.
  if (stateRefusal !== null && (request.state === 'expired' || request.state === 'cancelled')) {
    return refuse(request, 'cancel', args.actorId, stateRefusal.code, stateRefusal.detail, cancelledAt);
  }
  if (!APPROVAL_TRANSITIONS[request.state].includes(to)) {
    throw new DomainError(
      'APPROVAL_TRANSITION_INVALID',
      `cannot move an approval request from ${request.state} to ${to}`,
      { from: request.state, to },
    );
  }
  if (stateRefusal !== null) {
    return refuse(request, 'cancel', args.actorId, stateRefusal.code, stateRefusal.detail, cancelledAt);
  }
  if (args.actorId !== request.requesterId) {
    return refuse(
      request,
      'cancel',
      args.actorId,
      'APPROVAL_CANCEL_NOT_REQUESTER',
      'only the requester may cancel an approval request',
      cancelledAt,
    );
  }
  const next: ApprovalRequest = deepFreeze({
    ...request,
    state: 'cancelled',
    cancelledAt,
    cancelledBy: args.actorId,
  });
  const event: CancelledEvent = domainEvent(
    APPROVALS_CANCELLED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      cancelledBy: args.actorId,
      cancelledAt: cancelledAt.toISOString(),
    },
    at(cancelledAt),
  );
  return { accepted: true, request: next, events: [event] };
}

/** The maker withdraws their own pending request. Emits `approvals.cancelled`. */
export function cancelApprovalRequest(request: ApprovalRequest, clock: Clock): ApprovalOperationResult {
  return transitionApproval(request, 'cancelled', { actorId: request.requesterId }, clock);
}

// --- applying (the executor books the evidence) -------------------------------------------------

/**
 * Mark an APPROVED request applied and get the approval EVIDENCE BUNDLE for
 * the audit trail. This lane never executes the operation — no fund-truth
 * writes, ever (R1/R2 stay with the ledger). Refusals (VALUES + event):
 *   - pending → APPROVAL_QUORUM_NOT_MET (the checker panel is not done);
 *   - already applied → APPROVAL_ALREADY_APPLIED (idempotent replays of the
 *     STATE change are refused; the operation itself must be idempotent in
 *     its own lane);
 *   - drafted/rejected/expired/cancelled → APPROVAL_NOT_APPROVED.
 * Emits `approvals.applied` (narrow — the evidence travels in the RESULT).
 */
export function markApplied(request: ApprovalRequest, clock: Clock): ApplyResult {
  assertApprovalRequestShape(request);
  const appliedAt = assertClockDate(clock);
  if (request.state === 'pending') {
    return refuse(
      request,
      'apply',
      null,
      'APPROVAL_QUORUM_NOT_MET',
      `${request.decisions.length} of ${request.quorum} required approval(s) recorded — the panel is not done`,
      appliedAt,
    );
  }
  if (request.state === 'applied') {
    return refuse(request, 'apply', null, 'APPROVAL_ALREADY_APPLIED', 'the request is already applied', appliedAt);
  }
  if (request.state !== 'approved') {
    return refuse(
      request,
      'apply',
      null,
      'APPROVAL_NOT_APPROVED',
      `the request is ${request.state} — only an approved request can be marked applied`,
      appliedAt,
    );
  }
  const next: ApprovalRequest = deepFreeze({ ...request, state: 'applied', appliedAt });
  const event: AppliedEvent = domainEvent(
    APPROVALS_APPLIED,
    request.approvalRequestId,
    {
      orgId: request.orgId,
      approvalRequestId: request.approvalRequestId,
      operationType: request.operationType,
      appliedAt: appliedAt.toISOString(),
    },
    at(appliedAt),
  );
  const evidence: ApprovalEvidence = deepFreeze({
    approvalRequestId: request.approvalRequestId,
    orgId: request.orgId,
    operationType: request.operationType,
    policyId: request.policyId,
    subjectRefs: [...request.subjectRefs],
    payloadSnapshot: { ...request.payloadSnapshot },
    requesterId: request.requesterId,
    requiredApproverRoles: [...request.requiredApproverRoles],
    quorum: request.quorum,
    distinctApproverCount: request.decisions.length,
    decisions: request.decisions.map((decision) => ({
      approverId: decision.approverId,
      matchedRoles: [...decision.matchedRoles],
      decidedAt: decision.decidedAt.toISOString(),
    })),
    createdAt: request.createdAt.toISOString(),
    expiresAt: request.expiresAt.toISOString(),
    approvedAt: (request.approvedAt as Date).toISOString(),
    appliedAt: appliedAt.toISOString(),
  });
  return { accepted: true, request: next, event, evidence };
}
