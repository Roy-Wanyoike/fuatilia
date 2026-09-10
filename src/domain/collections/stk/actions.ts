/**
 * The `collect_now_stk_push` execution action — the rail-native "collect now"
 * move on a collection (RICE #2, docs/research/product-gaps.md).
 *
 * Converts next-best-action output into M-Pesa money movement WITHOUT giving
 * up any safety layer the domain already ships:
 *
 *   NBA economics → proposeStkPush → CONSENT GATE (DPA) → POLICY ENGINE
 *     → (human approval) → StkPushWire.initiate (injected port)
 *     → the Daraja STK result callback → EXISTING payments intake core
 *     (`intakePayment`) → confirmed | failed — or TIMED OUT when stuck.
 *
 * House rules, enforced here:
 *
 *   - Pure functions only: time from the injected Clock (read once per
 *     transition and pinned onto the event envelope — replay-exact), ids
 *     from the caller or derived deterministically (`uuidFromSeed`). No
 *     I/O, no RNG, no Date.now().
 *   - Money only via `Money` in KES integer minor units (R10) — floats are
 *     banned; the safe-integer ceiling is asserted so the policy request and
 *     event payloads (JSON numbers) can carry the amount losslessly.
 *   - The action log discipline (R3): every transition returns a FRESH
 *     aggregate; nothing is mutated in place; nothing is ever removed.
 *   - MSISDN: 07/254 normalization is NOT re-implemented — the lane reuses
 *     the ussd lane's `normalizeMsisdn` and only re-encodes the result into
 *     Daraja wire form. The MSISDN is PII: it lives on the aggregate and the
 *     transient wire command, NEVER in an event payload.
 *   - Fund truth: this lane NEVER invents money. The result callback flows
 *     through the existing `intakePayment` funnel (R9 idempotency on
 *     `daraja:stk:<checkoutRequestId>`, byte-identical to the daraja
 *     conformance convention) and the existing payment transitions
 *     (`awaitConfirmation`/`confirmPayment`/`failPayment`). A duplicate
 *     callback returns the SAME payment and emits
 *     `payments.duplicateCallbackObserved`; a contradicting amount is a hard
 *     error (K1 untrusted input); nothing outside the intake/match core is
 *     ever written.
 *   - Refusal is a first-class outcome (mirrors the K2 pattern in
 *     collections/actions.ts): consent and policy refusals return the
 *     refusal as a VALUE with machine-readable reason codes and emit the
 *     compliance event; only malformed input throws stable `STK_*` codes.
 */
import { DomainError, Money } from '../../shared';
import type { Clock, Uuid } from '../../shared';
import { normalizeMsisdn } from '../../ussd/session';
import { uuidFromSeed } from '../../payments/ids';
import { intakePayment } from '../../payments/intake';
import type { Payment } from '../../payments/payment';
import { awaitConfirmation, confirmPayment, failPayment } from '../../payments/payment';
import type { PaymentEvent } from '../../payments/events';
import { ACTOR_TYPES, RISK_CLASSES } from '../../policy/request';
import type { PolicyActor, RiskClass } from '../../policy/request';
import type { PolicyDecision } from '../../policy/engine';
import { DECISIONS } from '../../policy/rules';
import type { DecisionConditions } from '../../policy/rules';
import {
  domainEvent,
  type StkPushApprovedPayload,
  type StkPushAwaitingApprovalPayload,
  type StkPushConfirmedPayload,
  type StkPushEvent,
  type StkPushFailedPayload,
  type StkPushInitiatedPayload,
  type StkPushNotInitiatedPayload,
  type StkPushProposedPayload,
  type StkPushRefusedPayload,
  type StkPushTimedOutPayload,
} from './events';
import {
  assertStkResultCallback,
  initiationIdempotencyKey,
  paymentIdempotencyKey,
  toDarajaMsisdn,
} from './wire';
import type { StkPushResultCallbackInput, StkPushWire } from './wire';

// --- vocabulary ---------------------------------------------------------------------

/**
 * The new execution-action vocabulary entry. It follows the existing action
 * pattern (closed constant + typed membership, like CASE_ACTION_TYPES and
 * the policy engine's ACTION_TYPES) and is the string the policy engine
 * governs. NOTE: until the policy lane registers this entry in its governed
 * `ACTION_TYPES` vocabulary, the engine's documented safe-by-default
 * pre-guard denies every request carrying it (`POLICY_ACTION_UNKNOWN`) — the
 * gate below handles all three engine outcomes deterministically either way.
 */
export const STK_PUSH_ACTION_TYPE = 'collect_now_stk_push';

/**
 * The DPA consent surface of an STK push: it is an automated outbound
 * dunning contact delivered to the customer's handset, and the consent
 * registry models handset contact as the `sms` channel. A dunning grant on
 * whatsapp/email never unlocks a push (same K2 discipline as the whatsapp
 * gate); a marketing grant never implies dunning (assertCanContact enforces
 * the exact triple).
 */
export const STK_CONSENT_CHANNEL = 'sms' as const;
export const STK_CONSENT_PURPOSE = 'dunning' as const;

/** Default stuck-push deadline: Daraja itself abandons the prompt in ~2 min. */
export const DEFAULT_STK_PUSH_TTL_MS = 120_000;

/** docs/03-style lifecycle of one collect-now attempt. */
export type StkPushActionState =
  | 'proposed' // representable + recommendable; not yet gated
  | 'awaiting_approval' // policy answered requires_approval; parked for a human
  | 'approved' // a human approved; initiation unlocked
  | 'refused' // consent or policy refusal — terminal, compliance-recorded
  | 'initiated' // live on the rail; awaiting the result callback
  | 'reconciled' // the callback flowed through intake; money confirmed
  | 'failed' // the callback reported cancel/timeout/failure — terminal
  | 'timed_out'; // no result within the TTL; a late callback can still land

export const STK_PUSH_TERMINAL_STATES: readonly StkPushActionState[] = [
  'refused',
  'reconciled',
  'failed',
];

// --- the aggregate -------------------------------------------------------------------

/**
 * Cost/benefit + explanation — the NBA shape (rank.ts's transparent
 * expression `expectedRecovery × channelFit − cost − fatigue`, in integer
 * minor units / permill). `scoreMinor` is RECOMPUTED from the parts at
 * propose time and refused when it disagrees: the economics are data, and a
 * self-inconsistent bundle is a bug, not a recommendation.
 */
export interface StkPushEconomics {
  /** Historical-collection proxy for this action, minor units (≥ 0). */
  readonly expectedRecoveryMinor: number;
  /** Operating-cost proxy, minor units (≥ 0). */
  readonly costMinor: number;
  /** Fatigue penalty, minor units (≥ 0). */
  readonly fatiguePenaltyMinor: number;
  /** Channel fit, 0..1000‰. */
  readonly channelFitPermill: number;
  /** Net benefit = floor(recovery × fit / 1000) − cost − fatigue (safe int, may be ≤ 0). */
  readonly scoreMinor: number;
  /** Evidence reasons — explainability is a hard requirement (H7). */
  readonly reasons: readonly string[];
}

/** The governed decision's audit handle, stamped whenever the engine spoke. */
export interface StkPushPolicyRef {
  readonly reasonCode: string;
  readonly matchedRuleIds: readonly string[];
  readonly ruleSetVersion: number;
}

/** Why the attempt never reached the rail — consent or policy. */
export interface StkPushRefusal {
  readonly stage: 'consent' | 'policy';
  readonly reasonCode: string;
  readonly detail: string;
}

export interface StkPushApproval {
  readonly ref: string;
  readonly approverId: string;
  readonly approvedAt: Date;
}

export interface StkPushInitiation {
  readonly merchantRequestId: string;
  readonly checkoutRequestId: string;
  /** R9 — retry-safe initiation key: `stkpush:<actionId>`. */
  readonly idempotencyKey: string;
  readonly initiatedAt: Date;
  /** The stuck-push deadline: initiatedAt + ttlMs. */
  readonly expiresAt: Date;
}

export interface StkPushAction {
  readonly actionId: Uuid;
  readonly actionType: typeof STK_PUSH_ACTION_TYPE;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** Opaque receivable under collection; null when not receivable-scoped. */
  readonly receivableId: Uuid | null;
  /** Opaque collections case driving the push; null when not case-scoped. */
  readonly caseId: Uuid | null;
  readonly state: StkPushActionState;
  /** What the customer is asked to pay — KES integer minor units (R10). */
  readonly amount: Money;
  /** Payer handset, normalized E.164 (+254…) — PII, never mirrored into events. */
  readonly msisdn: string;
  readonly riskClass: RiskClass;
  /** Who is executing (human collector or the AI agent) — opaque. */
  readonly actor: PolicyActor;
  /** TRUE = would push with no human in the loop. */
  readonly autonomous: boolean;
  readonly economics: StkPushEconomics;
  /** Account reference shown on the customer's prompt (≤ 12 alphanumerics). */
  readonly accountReference: string;
  /** Transaction description shown on the prompt (≤ 26 chars). */
  readonly transactionDesc: string;
  readonly proposedAt: Date;
  readonly policyRef: StkPushPolicyRef | null;
  readonly refusal: StkPushRefusal | null;
  readonly approval: StkPushApproval | null;
  readonly initiation: StkPushInitiation | null;
  /** Set by the intake reconciliation — the ONE payment this attempt produced. */
  readonly paymentId: Uuid | null;
  readonly resolvedAt: Date | null;
  /** TRUE when the resolving callback landed after the push had timed out. */
  readonly resolvedLate: boolean | null;
  /** `STK_RESULT_<resultCode>` from the payments-lane failure transition. */
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly timedOutAt: Date | null;
}

// --- shared guards ---------------------------------------------------------------------

const assertClockDate = (at: Date, code: string): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'clock returned an invalid Date');
  }
  return at;
};

const pinnedClock = (at: Date): Clock => ({ now: () => at });

const assertNonBlank = (raw: string, code: string, label: string, max = 256): string => {
  if (typeof raw !== 'string') {
    throw new DomainError(code, `${label} must be a string`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new DomainError(code, `a non-blank ${label} is required`);
  }
  if (value.length > max) {
    throw new DomainError(code, `${label} exceeds ${max} characters`);
  }
  return value;
};

const assertSafeNonNegativeInt = (raw: number, code: string, label: string): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new DomainError(code, `${label} must be a non-negative safe integer, got ${String(raw)}`);
  }
  return raw;
};

const subjectRef = (raw: Uuid | null | undefined, code: string): Uuid | null => {
  if (raw === undefined || raw === null) return null;
  return assertNonBlank(raw, code, 'subject id') as Uuid;
};

// --- proposing -------------------------------------------------------------------------

export interface ProposeStkPushArgs {
  /** Caller-supplied id (preferred); deterministic fallback otherwise. */
  readonly id?: Uuid;
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly receivableId?: Uuid | null;
  readonly caseId?: Uuid | null;
  readonly actor: PolicyActor;
  /** What to collect — KES Money (integer minor units, > 0, R10). */
  readonly amount: Money;
  /** Payer handset in any Kenyan shape (07… / 254… / +254… / 0…) — normalized here. */
  readonly msisdn: string;
  readonly riskClass: RiskClass;
  readonly autonomous: boolean;
  readonly economics: StkPushEconomics;
  readonly accountReference: string;
  readonly transactionDesc: string;
}

/**
 * The NBA-recomputable score: floor(recovery × fitPermill / 1000) − cost −
 * fatigue, exact in BigInt so no float ever drifts a score at any
 * safe-integer amount (mirrors the NBA lane's integer discipline).
 */
export const stkPushScoreMinor = (economics: StkPushEconomics): number =>
  Number(
    (BigInt(economics.expectedRecoveryMinor) * BigInt(economics.channelFitPermill)) / 1000n -
      BigInt(economics.costMinor) -
      BigInt(economics.fatiguePenaltyMinor),
  );

/** Daraja prompt constraints (conformance mirror): reference ≤ 12 alphanumerics. */
const ACCOUNT_REFERENCE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
/** Daraja prompt description cap. */
const TRANSACTION_DESC_MAX = 26;

/**
 * Propose a collect-now STK push from NBA output. Emits `stk.pushProposed`
 * with the full economics + reasons. Malformed input throws stable `STK_*`
 * codes — a bug, never a governance outcome.
 *
 * Throws: STK_ORG_REQUIRED, STK_CUSTOMER_REQUIRED, STK_SUBJECT_INVALID,
 * STK_ACTOR_INVALID, STK_AUTONOMY_MISMATCH (human claiming autonomy),
 * STK_AMOUNT_INVALID, STK_CURRENCY_UNSUPPORTED (STK is KES-only),
 * STK_MSISDN_INVALID (not a normalizable Kenyan number),
 * STK_RISK_CLASS_INVALID, STK_ECONOMICS_INVALID (inconsistent cost/benefit
 * bundle or blank reasons), STK_REFERENCE_INVALID (prompt text),
 * STK_CLOCK_INVALID.
 */
export function proposeStkPush(
  args: ProposeStkPushArgs,
  clock: Clock,
): { action: StkPushAction; events: readonly [StkPushEvent & { name: 'stk.pushProposed' }] } {
  const proposedAt = assertClockDate(clock.now(), 'STK_CLOCK_INVALID');
  const orgId = assertNonBlank(args.orgId, 'STK_ORG_REQUIRED', 'orgId') as Uuid;
  const customerId = assertNonBlank(args.customerId, 'STK_CUSTOMER_REQUIRED', 'customerId') as Uuid;
  const receivableId = subjectRef(args.receivableId, 'STK_SUBJECT_INVALID');
  const caseId = subjectRef(args.caseId, 'STK_SUBJECT_INVALID');

  const actor = args.actor;
  if (actor === null || typeof actor !== 'object') {
    throw new DomainError('STK_ACTOR_INVALID', 'an action requires an actor');
  }
  if (!(ACTOR_TYPES as readonly string[]).includes(actor.type)) {
    throw new DomainError('STK_ACTOR_INVALID', `unknown actor type: ${String(actor.type)}`, {
      type: String(actor.type),
      allowed: ACTOR_TYPES,
    });
  }
  const actorId = assertNonBlank(actor.actorId, 'STK_ACTOR_INVALID', 'actor id');
  if (typeof args.autonomous !== 'boolean') {
    throw new DomainError('STK_STATE_INVALID', 'autonomous must be a boolean');
  }
  if (actor.type === 'human' && args.autonomous) {
    throw new DomainError(
      'STK_AUTONOMY_MISMATCH',
      'a human actor cannot claim an autonomous push — autonomous means no human in the loop',
    );
  }

  const amount = args.amount;
  if (!(amount instanceof Money)) {
    throw new DomainError('STK_AMOUNT_INVALID', 'amount must be a Money value (minor units, R10)');
  }
  if (amount.currency !== 'KES') {
    throw new DomainError(
      'STK_CURRENCY_UNSUPPORTED',
      `STK push collects on the M-Pesa rail (KES only), got ${amount.currency} (R10)`,
      { currency: amount.currency },
    );
  }
  if (amount.amount <= 0n) {
    throw new DomainError('STK_AMOUNT_INVALID', 'the collection amount must be > 0');
  }
  if (amount.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      'STK_AMOUNT_INVALID',
      'the collection amount exceeds the safe-integer ceiling (cannot be carried losslessly)',
    );
  }

  // 07/254 normalization is NOT this lane's job — reuse the existing
  // normalizer; only its failure code is re-branded for this lane's contract.
  let msisdn: string;
  try {
    msisdn = normalizeMsisdn(args.msisdn);
  } catch (err) {
    if (err instanceof DomainError) {
      throw new DomainError('STK_MSISDN_INVALID', err.message, err.details);
    }
    throw err;
  }

  if (!(RISK_CLASSES as readonly string[]).includes(args.riskClass)) {
    throw new DomainError(
      'STK_RISK_CLASS_INVALID',
      `unknown risk class: ${String(args.riskClass)}`,
      { allowed: RISK_CLASSES },
    );
  }

  const economics = args.economics;
  if (economics === null || typeof economics !== 'object') {
    throw new DomainError('STK_ECONOMICS_INVALID', 'economics are required (NBA cost/benefit)');
  }
  const expectedRecoveryMinor = assertSafeNonNegativeInt(
    economics.expectedRecoveryMinor,
    'STK_ECONOMICS_INVALID',
    'expectedRecoveryMinor',
  );
  const costMinor = assertSafeNonNegativeInt(economics.costMinor, 'STK_ECONOMICS_INVALID', 'costMinor');
  const fatiguePenaltyMinor = assertSafeNonNegativeInt(
    economics.fatiguePenaltyMinor,
    'STK_ECONOMICS_INVALID',
    'fatiguePenaltyMinor',
  );
  const channelFitPermill = economics.channelFitPermill;
  if (
    typeof channelFitPermill !== 'number' ||
    !Number.isSafeInteger(channelFitPermill) ||
    channelFitPermill < 0 ||
    channelFitPermill > 1000
  ) {
    throw new DomainError(
      'STK_ECONOMICS_INVALID',
      `channelFitPermill must be a safe integer in 0..1000, got ${String(channelFitPermill)}`,
    );
  }
  const reasons = economics.reasons;
  if (
    !Array.isArray(reasons) ||
    reasons.length === 0 ||
    reasons.some((r) => typeof r !== 'string' || r.trim().length === 0)
  ) {
    throw new DomainError(
      'STK_ECONOMICS_INVALID',
      'a recommendation requires at least one non-blank reason (explainability is a hard requirement)',
    );
  }
  const recomputed = stkPushScoreMinor({
    expectedRecoveryMinor,
    costMinor,
    fatiguePenaltyMinor,
    channelFitPermill,
    scoreMinor: 0,
    reasons: [],
  });
  if (recomputed > BigInt(Number.MAX_SAFE_INTEGER) || recomputed < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new DomainError('STK_ECONOMICS_INVALID', 'scoreMinor exceeds the safe-integer ceiling');
  }
  if (economics.scoreMinor !== Number(recomputed)) {
    throw new DomainError(
      'STK_ECONOMICS_INVALID',
      `scoreMinor ${String(economics.scoreMinor)} disagrees with the recomputed net benefit ${Number(recomputed)} — the economics bundle is inconsistent`,
    );
  }

  const accountReference = assertNonBlank(
    args.accountReference,
    'STK_REFERENCE_INVALID',
    'accountReference',
    12,
  );
  if (!ACCOUNT_REFERENCE_PATTERN.test(accountReference)) {
    throw new DomainError(
      'STK_REFERENCE_INVALID',
      'accountReference must be 1-12 alphanumerics (the customer sees it on the prompt)',
      { value: accountReference },
    );
  }
  const transactionDesc = assertNonBlank(
    args.transactionDesc,
    'STK_REFERENCE_INVALID',
    'transactionDesc',
    TRANSACTION_DESC_MAX,
  );

  const actionId =
    args.id ??
    uuidFromSeed(
      `stkpush:${orgId}:${customerId}:${msisdn}:${amount.amount}:${proposedAt.toISOString()}`,
    );

  const action: StkPushAction = {
    actionId,
    actionType: STK_PUSH_ACTION_TYPE,
    orgId,
    customerId,
    receivableId,
    caseId,
    state: 'proposed',
    amount,
    msisdn,
    riskClass: args.riskClass,
    actor: { type: actor.type, actorId },
    autonomous: args.autonomous,
    economics: {
      expectedRecoveryMinor,
      costMinor,
      fatiguePenaltyMinor,
      channelFitPermill,
      scoreMinor: economics.scoreMinor,
      reasons: [...reasons],
    },
    accountReference,
    transactionDesc,
    proposedAt,
    policyRef: null,
    refusal: null,
    approval: null,
    initiation: null,
    paymentId: null,
    resolvedAt: null,
    resolvedLate: null,
    failureCode: null,
    failureReason: null,
    timedOutAt: null,
  };

  const payload: StkPushProposedPayload = {
    actionId,
    orgId,
    customerId,
    receivableId,
    caseId,
    actionType: STK_PUSH_ACTION_TYPE,
    amountMinor: Number(amount.amount),
    currency: 'KES',
    actorType: actor.type,
    autonomous: action.autonomous,
    riskClass: action.riskClass,
    expectedRecoveryMinor,
    costMinor,
    fatiguePenaltyMinor,
    channelFitPermill,
    scoreMinor: economics.scoreMinor,
    reasons: action.economics.reasons,
    proposedAt: proposedAt.toISOString(),
  };
  return {
    action,
    events: [
      domainEvent<'stk.pushProposed', StkPushProposedPayload>(
        'stk.pushProposed',
        actionId,
        payload,
        pinnedClock(proposedAt),
      ),
    ],
  };
}

// --- the policy decision -----------------------------------------------------------------

/**
 * Apply one governed PolicyDecision to a proposed attempt:
 *
 *   deny              → state `refused` (stage 'policy') + `stk.pushRefused`
 *                       — the machine-readable refusal reason is the
 *                       engine's own `reasonCode`;
 *   requires_approval → state `awaiting_approval` + `stk.pushAwaitingApproval`
 *                       — runnable once `approveStkPush` records a human;
 *   allow             → the attempt stays `proposed`, the decision handle is
 *                       stamped; initiation requires the SAME allow decision
 *                       as its clearance.
 *
 * The engine's own `policy.decisionRecorded` audit event (an EXISTING event
 * type, returned on every PolicyDecision) is emitted by the caller — the
 * gate composes it with this function's lane events.
 *
 * Throws: STK_STATE_INVALID (not proposed), STK_DECISION_MISMATCH (a
 * decision for another org/customer or a malformed decision).
 */
export function applyStkPolicyDecision(
  action: StkPushAction,
  decision: PolicyDecision,
  clock: Clock,
): {
  action: StkPushAction;
  events: readonly StkPushEvent[];
} {
  if (action.state !== 'proposed') {
    throw new DomainError(
      'STK_STATE_INVALID',
      `the policy decision applies to proposed attempts, got ${action.state}`,
      { actionId: action.actionId, state: action.state },
    );
  }
  if (decision === null || typeof decision !== 'object' || !(DECISIONS as readonly string[]).includes(decision.decision)) {
    throw new DomainError('STK_DECISION_MISMATCH', 'a governed PolicyDecision is required');
  }
  // A PolicyDecision is org-scoped (the engine's aggregate IS the org); the
  // attempt binds to it through the org match + the stamped rule handles.
  if (decision.orgId !== action.orgId) {
    throw new DomainError(
      'STK_DECISION_MISMATCH',
      'the decision belongs to another org — refusing to apply it',
      { decisionOrgId: decision.orgId, actionOrgId: action.orgId },
    );
  }
  const reasonCode = assertNonBlank(decision.reasonCode, 'STK_DECISION_MISMATCH', 'decision reasonCode');
  const matchedRuleIds = Array.isArray(decision.matchedRuleIds) ? [...decision.matchedRuleIds] : [];
  const at = assertClockDate(clock.now(), 'STK_CLOCK_INVALID');
  const pinned = pinnedClock(at);

  if (decision.decision === 'deny') {
    const detail = assertNonBlank(decision.explanation, 'STK_DECISION_MISMATCH', 'decision explanation');
    const next: StkPushAction = {
      ...action,
      state: 'refused',
      policyRef: { reasonCode, matchedRuleIds, ruleSetVersion: decision.ruleSetVersion },
      refusal: { stage: 'policy', reasonCode, detail },
    };
    const payload: StkPushRefusedPayload = {
      actionId: action.actionId,
      orgId: action.orgId,
      customerId: action.customerId,
      receivableId: action.receivableId,
      caseId: action.caseId,
      stage: 'policy',
      reasonCode,
      detail,
      refusedAt: at.toISOString(),
    };
    return {
      action: next,
      events: [domainEvent<'stk.pushRefused', StkPushRefusedPayload>('stk.pushRefused', action.actionId, payload, pinned)],
    };
  }

  const policyRef: StkPushPolicyRef = { reasonCode, matchedRuleIds, ruleSetVersion: decision.ruleSetVersion };

  if (decision.decision === 'requires_approval') {
    const next: StkPushAction = { ...action, state: 'awaiting_approval', policyRef };
    const payload: StkPushAwaitingApprovalPayload = {
      actionId: action.actionId,
      orgId: action.orgId,
      customerId: action.customerId,
      reasonCode,
      matchedRuleIds,
      ruleSetVersion: decision.ruleSetVersion,
      awaitingAt: at.toISOString(),
    };
    return {
      action: next,
      events: [
        domainEvent<'stk.pushAwaitingApproval', StkPushAwaitingApprovalPayload>(
          'stk.pushAwaitingApproval',
          action.actionId,
          payload,
          pinned,
        ),
      ],
    };
  }

  // allow — the decision travels with the attempt as its initiation clearance.
  return { action: { ...action, policyRef }, events: [] };
}

// --- the human approval -------------------------------------------------------------------

export interface ApproveStkPushArgs {
  /** Opaque approval reference (the approval lane's handle, verbatim). */
  readonly approvalRef: string;
  readonly approverId: string;
}

/**
 * Record the human approval that unlocks a parked (`requires_approval`)
 * attempt: awaiting_approval → approved. Emits `stk.pushApproved`.
 *
 * Throws: STK_STATE_INVALID (not awaiting approval), STK_APPROVAL_INVALID
 * (blank approval reference or approver), STK_CLOCK_INVALID.
 */
export function approveStkPush(
  action: StkPushAction,
  args: ApproveStkPushArgs,
  clock: Clock,
): { action: StkPushAction; events: readonly [StkPushEvent & { name: 'stk.pushApproved' }] } {
  if (action.state !== 'awaiting_approval') {
    throw new DomainError(
      'STK_STATE_INVALID',
      `only attempts awaiting approval can be approved, got ${action.state}`,
      { actionId: action.actionId, state: action.state },
    );
  }
  const approvalRef = assertNonBlank(args.approvalRef, 'STK_APPROVAL_INVALID', 'approval reference');
  const approverId = assertNonBlank(args.approverId, 'STK_APPROVAL_INVALID', 'approver id');
  const approvedAt = assertClockDate(clock.now(), 'STK_CLOCK_INVALID');

  const next: StkPushAction = {
    ...action,
    state: 'approved',
    approval: { ref: approvalRef, approverId, approvedAt },
  };
  const payload: StkPushApprovedPayload = {
    actionId: action.actionId,
    orgId: action.orgId,
    approvalRef,
    approverId,
    approvedAt: approvedAt.toISOString(),
  };
  return {
    action: next,
    events: [
      domainEvent<'stk.pushApproved', StkPushApprovedPayload>(
        'stk.pushApproved',
        action.actionId,
        payload,
        pinnedClock(approvedAt),
      ),
    ],
  };
}

// --- initiating (the injected wire port) ----------------------------------------------------

export interface InitiateStkPushArgs {
  /**
   * The engine's allow decision — REQUIRED for a `proposed` attempt (the
   * clearance IS the policy gate's permission), ignored-but-validated for an
   * `approved` one (the human approval already unlocked it).
   */
  readonly clearance?: PolicyDecision;
  /** Stuck-push deadline override; defaults to DEFAULT_STK_PUSH_TTL_MS. */
  readonly ttlMs?: number;
}

export type InitiateStkPushResult =
  | {
      readonly ok: true;
      readonly attempt: StkPushAction;
      readonly events: readonly [StkPushEvent & { name: 'stk.pushInitiated' }];
    }
  | {
      readonly ok: false;
      readonly kind: 'wire_rejected';
      readonly reason: string;
      /** Unchanged (retryable) — the rejection is on the record, not the state. */
      readonly attempt: StkPushAction;
      readonly events: readonly [StkPushEvent & { name: 'stk.pushNotInitiated' }];
    };

const assertClearance = (action: StkPushAction, decision: PolicyDecision, now: Date): void => {
  if (decision === null || typeof decision !== 'object') {
    throw new DomainError('STK_CLEARANCE_INVALID', 'an allow PolicyDecision is required to initiate');
  }
  if (decision.decision !== 'allow') {
    throw new DomainError(
      'STK_CLEARANCE_INVALID',
      `initiation requires an allow decision, got ${decision.decision} (a refusal grants nothing)`,
      { decision: decision.decision, reasonCode: decision.reasonCode },
    );
  }
  if (decision.orgId !== action.orgId) {
    throw new DomainError(
      'STK_DECISION_MISMATCH',
      'the clearance belongs to another org',
      { decisionOrgId: decision.orgId, actionOrgId: action.orgId },
    );
  }
  const conditions: DecisionConditions | null = decision.conditions ?? null;
  if (conditions !== null) {
    const amountMinor = Number(action.amount.amount);
    if (
      conditions.maxAmountMinor !== undefined &&
      (typeof conditions.maxAmountMinor !== 'number' || amountMinor > conditions.maxAmountMinor)
    ) {
      throw new DomainError(
        'STK_CLEARANCE_AMOUNT_EXCEEDED',
        `the collection amount ${amountMinor} exceeds the granted maxAmountMinor ${String(conditions.maxAmountMinor)}`,
        { amountMinor, maxAmountMinor: conditions.maxAmountMinor },
      );
    }
    if (
      conditions.allowedChannels !== undefined &&
      !(conditions.allowedChannels as readonly string[]).includes(STK_CONSENT_CHANNEL)
    ) {
      throw new DomainError(
        'STK_CLEARANCE_CHANNEL_FORBIDDEN',
        `the grant allows channels [${conditions.allowedChannels.join(', ')}], not ${STK_CONSENT_CHANNEL}`,
        { allowedChannels: conditions.allowedChannels },
      );
    }
    if (conditions.expiresAt !== undefined && now.getTime() >= Date.parse(conditions.expiresAt)) {
      throw new DomainError(
        'STK_CLEARANCE_EXPIRED',
        `the grant lapsed at ${conditions.expiresAt} — a lapsed clearance never initiates`,
        { expiresAt: conditions.expiresAt },
      );
    }
  }
};

/**
 * Push the prompt: consent + policy already satisfied, hand the initiation to
 * the INJECTED `StkPushWire` port. The port is synchronous-pure in the core
 * (comms-lane precedent) — the production adapter wraps its own async I/O.
 *
 * On acceptance the attempt flips to `initiated` with the rail's echo
 * (merchantRequestId + checkoutRequestId) stamped, the R9 initiation key
 * (`stkpush:<actionId>`) recorded, and the stuck-push deadline set
 * (initiatedAt + ttlMs). Emits `stk.pushInitiated`.
 *
 * On rejection the attempt is UNCHANGED (retryable) and `stk.pushNotInitiated`
 * puts the refusal on the record.
 *
 * Throws: STK_STATE_INVALID (wrong state / never proposed), STK_CLEARANCE_*
 * (a clearance that does not clear), STK_DECISION_MISMATCH, STK_TTL_INVALID,
 * STK_WIRE_ECHO_INVALID (malformed rail echo — treat as a dead attempt),
 * STK_CLOCK_INVALID.
 */
export function initiateStkPush(
  action: StkPushAction,
  args: InitiateStkPushArgs,
  wire: StkPushWire,
  clock: Clock,
): InitiateStkPushResult {
  if (action.state !== 'proposed' && action.state !== 'approved') {
    throw new DomainError(
      'STK_STATE_INVALID',
      `only proposed or approved attempts can be initiated, got ${action.state}`,
      { actionId: action.actionId, state: action.state },
    );
  }
  if (action.state === 'proposed' && args.clearance === undefined) {
    throw new DomainError(
      'STK_CLEARANCE_INVALID',
      'a proposed attempt requires the engine allow decision as its clearance',
    );
  }
  if (args.clearance !== undefined) {
    assertClearance(action, args.clearance, assertClockDate(clock.now(), 'STK_CLOCK_INVALID'));
  }
  const initiatedAt = assertClockDate(clock.now(), 'STK_CLOCK_INVALID');
  const ttlMs = args.ttlMs ?? DEFAULT_STK_PUSH_TTL_MS;
  if (typeof ttlMs !== 'number' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new DomainError('STK_TTL_INVALID', `ttlMs must be a safe positive integer, got ${String(ttlMs)}`);
  }

  const command = {
    actionId: action.actionId,
    orgId: action.orgId,
    customerId: action.customerId,
    amountMinor: action.amount.amount,
    msisdn: toDarajaMsisdn(action.msisdn),
    accountReference: action.accountReference,
    transactionDesc: action.transactionDesc,
    idempotencyKey: initiationIdempotencyKey(action.actionId),
  };

  const outcome = wire.initiate(command);
  const attemptedAtIso = initiatedAt.toISOString();

  if (outcome.status === 'rejected') {
    const reason = assertNonBlank(outcome.failureReason, 'STK_WIRE_ECHO_INVALID', 'wire rejection reason');
    const payload: StkPushNotInitiatedPayload = {
      actionId: action.actionId,
      orgId: action.orgId,
      reason,
      attemptedAt: attemptedAtIso,
    };
    return {
      ok: false,
      kind: 'wire_rejected',
      reason,
      attempt: action,
      events: [
        domainEvent<'stk.pushNotInitiated', StkPushNotInitiatedPayload>(
          'stk.pushNotInitiated',
          action.actionId,
          payload,
          pinnedClock(initiatedAt),
        ),
      ],
    };
  }

  const merchantRequestId = assertNonBlank(
    outcome.merchantRequestId,
    'STK_WIRE_ECHO_INVALID',
    'merchantRequestId',
  );
  const checkoutRequestId = assertNonBlank(
    outcome.checkoutRequestId,
    'STK_WIRE_ECHO_INVALID',
    'checkoutRequestId',
  );
  if (!/^ws_CO_[A-Za-z0-9]{6,24}$/.test(checkoutRequestId)) {
    throw new DomainError(
      'STK_WIRE_ECHO_INVALID',
      `checkoutRequestId "${checkoutRequestId}" must match ws_CO_<alphanumerics> (conformance mirror)`,
      { value: checkoutRequestId },
    );
  }

  const expiresAt = new Date(initiatedAt.getTime() + ttlMs);
  const next: StkPushAction = {
    ...action,
    state: 'initiated',
    initiation: {
      merchantRequestId,
      checkoutRequestId,
      idempotencyKey: command.idempotencyKey,
      initiatedAt,
      expiresAt,
    },
  };
  const payload: StkPushInitiatedPayload = {
    actionId: action.actionId,
    orgId: action.orgId,
    customerId: action.customerId,
    merchantRequestId,
    checkoutRequestId,
    idempotencyKey: command.idempotencyKey,
    amountMinor: Number(action.amount.amount),
    currency: 'KES',
    ttlMs,
    expiresAt: expiresAt.toISOString(),
    initiatedAt: attemptedAtIso,
  };
  return {
    ok: true,
    attempt: next,
    events: [
      domainEvent<'stk.pushInitiated', StkPushInitiatedPayload>(
        'stk.pushInitiated',
        action.actionId,
        payload,
        pinnedClock(initiatedAt),
      ),
    ],
  };
}

// --- reconciling (through the EXISTING payments intake core) ---------------------------------

export interface ReconcileStkCallbackArgs {
  readonly clock: Clock;
  /** Payments already known to this process (the intake dedupe universe). */
  readonly existing?: readonly Payment[];
}

export interface ReconcileStkCallbackResult {
  readonly attempt: StkPushAction;
  /** The ONE payment this checkout maps to — the same object on every replay (R9). */
  readonly payment: Payment;
  readonly duplicate: boolean;
  /** Existing payments-lane events: initiated/confirmed/failed + the duplicate tripwire. */
  readonly paymentEvents: readonly PaymentEvent[];
  /** This lane's facts for the transition (empty on a pure duplicate replay). */
  readonly stkEvents: readonly StkPushEvent[];
}

/**
 * Reconcile one STK result callback through the EXISTING payments intake
 * core — the same funnel C2B uses, the same R9 semantics:
 *
 *   - the intake idempotency key is `daraja:stk:<checkoutRequestId>`
 *     (byte-identical to the daraja conformance convention), so a duplicate
 *     callback returns the SAME payment and emits
 *     `payments.duplicateCallbackObserved` — never a second Payment;
 *   - success (ResultCode 0): the payment is advanced through the existing
 *     `awaitConfirmation` → `confirmPayment` transitions with the ATTEMPT's
 *     amount (the merchant knows what it asked for, E11) — the callback's
 *     metadata amount is evidence and must agree exactly, or the callback is
 *     refused as tampered (K1) before anything is written;
 *   - failure (non-zero): the payment is advanced through the existing
 *     `failPayment` transition with `STK_RESULT_<resultCode>`;
 *   - the ACTION stays `initiated` until intake has spoken, then flips to
 *     `reconciled` | `failed`. A callback landing on an already-`timed_out`
 *     attempt still lands (money truth is never dropped) and stamps
 *     `resolvedLate`.
 *
 * Throws: STK_STATE_INVALID (never initiated), STK_CALLBACK_UNKNOWN (a
 * checkout this attempt never opened — dead-letter), STK_CALLBACK_INVALID
 * (junk — dead-letter), STK_AMOUNT_MISMATCH (success metadata disagrees with
 * the initiated amount — tampering, nothing is written), STK_CLOCK_INVALID.
 * The intake core's own errors (e.g. DUPLICATE_AMOUNT_MISMATCH) propagate
 * unchanged — that IS the existing R9 protection.
 */
export function reconcileStkCallback(
  action: StkPushAction,
  raw: StkPushResultCallbackInput,
  ctx: ReconcileStkCallbackArgs,
): ReconcileStkCallbackResult {
  const callback = assertStkResultCallback(raw);
  const initiation = action.initiation;
  if (initiation === null || !(['initiated', 'reconciled', 'failed', 'timed_out'] as readonly string[]).includes(action.state)) {
    throw new DomainError(
      'STK_STATE_INVALID',
      `a result callback reconciles an initiated attempt, got ${action.state}`,
      { actionId: action.actionId, state: action.state },
    );
  }
  if (callback.checkoutRequestId !== initiation.checkoutRequestId) {
    throw new DomainError(
      'STK_CALLBACK_UNKNOWN',
      `callback checkout ${callback.checkoutRequestId} does not belong to attempt ${action.actionId} (opened ${initiation.checkoutRequestId})`,
      { checkoutRequestId: callback.checkoutRequestId, expected: initiation.checkoutRequestId },
    );
  }
  if (callback.success && callback.paidMinor !== action.amount.amount) {
    throw new DomainError(
      'STK_AMOUNT_MISMATCH',
      `success metadata carries ${callback.paidMinor} minor but the attempt initiated ${action.amount.amount} — refusing to confirm untrusted money (K1)`,
      { paidMinor: callback.paidMinor?.toString(), initiatedMinor: action.amount.amount.toString() },
    );
  }

  const intake = intakePayment(
    {
      channel: 'stk',
      externalRef: callback.receiptNumber ?? callback.checkoutRequestId,
      idempotencyKey: paymentIdempotencyKey(callback.checkoutRequestId),
      amount: action.amount,
      customerId: action.customerId,
      declaredRefs: [],
    },
    { clock: ctx.clock, existing: ctx.existing },
  );

  // R9: the SAME logical payment, the tripwire event, nothing else.
  if (intake.duplicate) {
    return {
      attempt: action,
      payment: intake.payment,
      duplicate: true,
      paymentEvents: intake.events,
      stkEvents: [],
    };
  }

  const now = assertClockDate(ctx.clock.now(), 'STK_CLOCK_INVALID');
  const late = action.state === 'timed_out';

  if (callback.success) {
    const awaited = awaitConfirmation(intake.payment);
    const confirmed = confirmPayment(awaited.payment, action.amount, ctx.clock);
    const next: StkPushAction = {
      ...action,
      state: 'reconciled',
      paymentId: confirmed.payment.id,
      resolvedAt: now,
      resolvedLate: late,
    };
    const payload: StkPushConfirmedPayload = {
      actionId: action.actionId,
      orgId: action.orgId,
      customerId: action.customerId,
      paymentId: confirmed.payment.id,
      checkoutRequestId: callback.checkoutRequestId,
      receiptNumber: callback.receiptNumber ?? '',
      amountMinor: Number(action.amount.amount),
      currency: 'KES',
      late,
      reconciledAt: now.toISOString(),
    };
    return {
      attempt: next,
      payment: confirmed.payment,
      duplicate: false,
      paymentEvents: [...intake.events, ...confirmed.events],
      stkEvents: [
        domainEvent<'stk.pushConfirmed', StkPushConfirmedPayload>(
          'stk.pushConfirmed',
          action.actionId,
          payload,
          pinnedClock(now),
        ),
      ],
    };
  }

  const failureCode = `STK_RESULT_${callback.resultCode}`;
  const failed = failPayment(intake.payment, failureCode, ctx.clock);
  const next: StkPushAction = {
    ...action,
    state: 'failed',
    paymentId: failed.payment.id,
    resolvedAt: now,
    resolvedLate: late,
    failureCode,
    failureReason: callback.resultDesc,
  };
  const payload: StkPushFailedPayload = {
    actionId: action.actionId,
    orgId: action.orgId,
    paymentId: failed.payment.id,
    checkoutRequestId: callback.checkoutRequestId,
    resultCode: callback.resultCode,
    failureCode,
    resultDesc: callback.resultDesc,
    late,
    failedAt: now.toISOString(),
  };
  return {
    attempt: next,
    payment: failed.payment,
    duplicate: false,
    paymentEvents: [...intake.events, ...failed.events],
    stkEvents: [
      domainEvent<'stk.pushFailed', StkPushFailedPayload>(
        'stk.pushFailed',
        action.actionId,
        payload,
        pinnedClock(now),
      ),
    ],
  };
}

// --- the stuck path (timeout / poll) -----------------------------------------------------------

/** TRUE when the push is live and its TTL deadline has been reached. */
export const isStkPushDue = (action: StkPushAction, now: Date): boolean =>
  action.state === 'initiated' &&
  action.initiation !== null &&
  now.getTime() >= action.initiation.expiresAt.getTime();

/**
 * Time-driven close-out of a stuck push (the poll path): initiated →
 * timed_out once the deadline has passed. Emits `stk.pushTimedOut` ONLY when
 * it flips — otherwise a no-op returning the attempt unchanged (idempotent,
 * mirrors the payment-lane sweeper pattern). A late result callback can
 * still land on a timed-out attempt via `reconcileStkCallback`.
 *
 * Throws: STK_CLOCK_INVALID.
 */
export function expireStkPushIfDue(
  action: StkPushAction,
  clock: Clock,
): { attempt: StkPushAction; events: readonly (StkPushEvent & { name: 'stk.pushTimedOut' })[] } {
  const now = assertClockDate(clock.now(), 'STK_CLOCK_INVALID');
  if (!isStkPushDue(action, now) || action.initiation === null) {
    return { attempt: action, events: [] };
  }
  const next: StkPushAction = {
    ...action,
    state: 'timed_out',
    timedOutAt: now,
  };
  const payload: StkPushTimedOutPayload = {
    actionId: action.actionId,
    orgId: action.orgId,
    checkoutRequestId: action.initiation.checkoutRequestId,
    expiresAt: action.initiation.expiresAt.toISOString(),
    timedOutAt: now.toISOString(),
  };
  return {
    attempt: next,
    events: [
      domainEvent<'stk.pushTimedOut', StkPushTimedOutPayload>(
        'stk.pushTimedOut',
        action.actionId,
        payload,
        pinnedClock(now),
      ),
    ],
  };
}
