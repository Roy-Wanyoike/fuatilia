/**
 * STK-push execution lane tests (issue #92) — the full lifecycle over the
 * PURE cores: propose → gate (consent + policy) → (approve) → initiate →
 * reconcile through the EXISTING payments intake core; plus the R9 duplicate
 * tripwire, the stuck-push timeout, and the late-callback-lands path.
 * Deterministic fakes only (simulatedStkWire, fixed clocks). No network.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../shared';
import { Money } from '../../shared/money';
import { createRuleSet } from '../../policy/rules';
import type { PolicyRuleSet } from '../../policy/rules';
import { grantConsent, revokeConsent } from '../../consent/consent-grant';
import type { ConsentGrant } from '../../consent/consent-grant';
import type { Uuid } from '../../shared';
import {
  approveStkPush,
  expireStkPushIfDue,
  initiateStkPush,
  isStkPushDue,
  proposeStkPush,
  reconcileStkCallback,
  STK_PUSH_ACTION_TYPE,
  stkPushScoreMinor,
  type ProposeStkPushArgs,
  type StkPushAction,
} from './actions';
import { gateStkPush } from './gate';
import { simulatedStkWire, type StkPushInitiationOutcome, type StkPushResultCallbackInput } from './wire';

const uid = (n: number): Uuid => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as unknown as Uuid;
const ORG = uid(1);
const CUSTOMER = uid(2);
const AGENT = { type: 'ai_agent' as const, actorId: 'agent-nba-1' };
const HUMAN = { type: 'human' as const, actorId: 'collector-7' };

const t0 = new Date('2026-09-08T09:00:00Z');
const clock = (at: Date = t0) => ({ now: () => at });
const tick = (ms: number) => new Date(t0.getTime() + ms);
const tickClock = (ms: number) => ({ now: () => tick(ms) });

const KES = (minor: number) => Money.ofMinor(minor, 'KES');

const allowRuleSet = (): PolicyRuleSet =>
  createRuleSet(
    ORG,
    1,
    [
      {
        id: 'stk-allow-low',
        priority: 10,
        actionType: STK_PUSH_ACTION_TYPE as unknown as 'any',
        decision: 'allow',
        conditions: [{ field: 'riskClass', op: 'eq', value: 'low' }],
        reasonCode: 'POLICY_STK_ALLOW',
        explanation: 'low-risk collect-now push allowed autonomously',
      },
    ],
    clock(),
  );

const denyRuleSet = (): PolicyRuleSet =>
  createRuleSet(
    ORG,
    1,
    [
      {
        id: 'deny-all',
        priority: 10,
        actionType: 'any',
        decision: 'deny',
        conditions: [],
        reasonCode: 'POLICY_STK_DENY',
        explanation: 'org paused pushes',
      },
    ],
    clock(),
  );

const approvalRuleSet = (): PolicyRuleSet =>
  createRuleSet(
    ORG,
    1,
    [
      {
        id: 'stk-approval',
        priority: 10,
        actionType: STK_PUSH_ACTION_TYPE as unknown as 'any',
        decision: 'requires_approval',
        conditions: [],
        reasonCode: 'POLICY_STK_APPROVAL',
        explanation: 'human sign-off required',
      },
    ],
    clock(),
  );

const liveGrant = (): readonly ConsentGrant[] => [
  grantConsent({ id: uid(3), customerId: CUSTOMER, channel: 'sms', purpose: 'dunning' }, [], clock()),
];

const economics = {
  expectedRecoveryMinor: 250_000,
  costMinor: 2_000,
  fatiguePenaltyMinor: 1_000,
  channelFitPermill: 900,
  scoreMinor: 222_000,
  reasons: ['pattern: pays within 3 days of prompt', 'exposure: 1 invoice 32 days past due'],
};

const proposeArgs = (): ProposeStkPushArgs => ({
  orgId: ORG,
  customerId: CUSTOMER,
  receivableId: uid(4),
  caseId: null,
  actor: AGENT,
  amount: KES(250_000),
  msisdn: '0712345678',
  riskClass: 'low',
  autonomous: true,
  economics,
  accountReference: 'INV1042',
  transactionDesc: 'Fuatilia collect now',
});

const proposeOne = (): StkPushAction => proposeStkPush(proposeArgs(), clock()).action;

const acceptedEcho = (): readonly StkPushInitiationOutcome[] => [
  { status: 'accepted', merchantRequestId: '58234-11940372-1', checkoutRequestId: 'ws_CO_12092025143105741', customerMessage: 'A payment request has been sent to the customer' },
];

const initiatedOne = () => {
  const proposed = proposeOne();
  const gated = gateStkPush(proposed, { grants: liveGrant(), ruleSet: allowRuleSet(), disputeOpen: false, promisePending: false }, clock());
  if (gated.outcome.kind !== 'allowed') throw new Error('fixture: gate should allow');
  const wire = simulatedStkWire(acceptedEcho());
  const result = initiateStkPush(gated.action, { clearance: gated.outcome.decision }, wire, clock());
  if (!result.ok) throw new Error('fixture: initiation should succeed');
  return { action: result.attempt, events: result.events, wire };
};

const checkoutIdOf = (action: StkPushAction): string => {
  if (action.initiation === null) throw new Error(`fixture: action not initiated — state ${action.state}`);
  return action.initiation.checkoutRequestId;
};

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const successCallback = (checkoutRequestId: string): StkPushResultCallbackInput => ({
  checkoutRequestId,
  merchantRequestId: '58234-11940372-1',
  resultCode: 0,
  resultDesc: 'The service request is processed successfully.',
  receiptNumber: 'SBK81KZ9QF',
  paidMinor: 250_000,
  msisdn: '254712345678',
});

// --- propose -------------------------------------------------------------------

describe('proposeStkPush', () => {
  it('normalizes Kenyan MSISDN shapes and stamps NBA economics + score', () => {
    const { action, events } = proposeStkPush(proposeArgs(), clock());
    expect(action.state).toBe('proposed');
    expect(action.amount.amount).toBe(250_000n);
    expect(action.msisdn).toBe('+254712345678'); // normalized E.164
    expect(action.economics.scoreMinor).toBe(stkPushScoreMinor(economics));
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('stk.pushProposed');
    // PII discipline: the aggregate carries the msisdn; the EVENTS never do.
    expect(JSON.stringify(events)).not.toContain('+254712345678');
    expect(JSON.stringify(events)).not.toContain('0712345678');
  });

  it('refuses non-KES amounts (STK is a KES rail)', () => {
    expectCode(() => proposeStkPush({ ...proposeArgs(), amount: Money.ofMinor(250_000, 'USD') }, clock()), 'STK_CURRENCY_UNSUPPORTED');
  });

  it('refuses a human actor claiming autonomy', () => {
    expectCode(() => proposeStkPush({ ...proposeArgs(), actor: HUMAN, autonomous: true }, clock()), 'STK_AUTONOMY_MISMATCH');
  });

  it('refuses an unpromptable account reference', () => {
    expectCode(() => proposeStkPush({ ...proposeArgs(), accountReference: 'INVOICE20260042LONG' }, clock()), 'STK_REFERENCE_INVALID');
  });
});

// --- gate ----------------------------------------------------------------------

describe('gateStkPush — the DPA consent gate THEN the policy engine', () => {
  it('allows a consented low-risk push and stamps the decision handle', () => {
    const gated = gateStkPush(proposeOne(), { grants: liveGrant(), ruleSet: allowRuleSet(), disputeOpen: false, promisePending: false }, clock());
    expect(gated.outcome.kind).toBe('allowed');
    expect(gated.action.state).toBe('proposed');
    // every evaluation emits the engine's audit fact
    expect(gated.events.some((e) => e.name === 'policy.decisionRecorded')).toBe(true);
  });

  it('consent refusal is fail-closed and happens BEFORE the engine (no policy event)', () => {
    const gated = gateStkPush(proposeOne(), { grants: [], ruleSet: allowRuleSet(), disputeOpen: false, promisePending: false }, clock());
    expect(gated.outcome.kind).toBe('refused');
    if (gated.outcome.kind === 'refused') {
      expect(gated.outcome.stage).toBe('consent');
      expect(gated.action.state).toBe('refused');
    }
    expect(gated.events.some((e) => e.name === 'policy.decisionRecorded')).toBe(false);
    expect(gated.events.some((e) => e.name === 'stk.pushRefused')).toBe(true);
  });

  it('a REVOKED grant refuses (K3 — re-consent required)', () => {
    const revoked: readonly ConsentGrant[] = [revokeConsent(liveGrant()[0] as ConsentGrant, tickClock(1000))];
    const gated = gateStkPush(proposeOne(), { grants: revoked, ruleSet: allowRuleSet(), disputeOpen: false, promisePending: false }, clock(tick(2000)));
    expect(gated.outcome.kind).toBe('refused');
  });

  it('a policy deny refuses with the machine-readable reason', () => {
    const gated = gateStkPush(proposeOne(), { grants: liveGrant(), ruleSet: denyRuleSet(), disputeOpen: false, promisePending: false }, clock());
    expect(gated.outcome.kind).toBe('refused');
    if (gated.outcome.kind === 'refused') {
      expect(gated.outcome.stage).toBe('policy');
      expect(gated.outcome.reasonCode).toBe('POLICY_STK_DENY');
      expect(gated.outcome.decision).not.toBeNull();
    }
    expect(gated.action.state).toBe('refused');
  });

  it('requires_approval parks the attempt for a human', () => {
    const gated = gateStkPush(proposeOne(), { grants: liveGrant(), ruleSet: approvalRuleSet(), disputeOpen: false, promisePending: false }, clock());
    expect(gated.outcome.kind).toBe('approval_required');
    expect(gated.action.state).toBe('awaiting_approval');
  });
});

// --- approve + initiate ----------------------------------------------------------

describe('approveStkPush + initiateStkPush', () => {
  it('approval unlocks initiation without a clearance', () => {
    const gated = gateStkPush(proposeOne(), { grants: liveGrant(), ruleSet: approvalRuleSet(), disputeOpen: false, promisePending: false }, clock());
    if (gated.outcome.kind !== 'approval_required') throw new Error('fixture');
    const approved = approveStkPush(gated.action, { approvalRef: 'APPR-77', approverId: HUMAN.actorId }, clock());
    expect(approved.action.state).toBe('approved');
    const result = initiateStkPush(approved.action, {}, simulatedStkWire(acceptedEcho()), clock());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attempt.state).toBe('initiated');
      expect(result.attempt.initiation?.checkoutRequestId.startsWith('ws_CO_')).toBe(true);
      expect(result.attempt.initiation?.idempotencyKey).toBe(`stkpush:${result.attempt.actionId}`);
    }
  });

  it('initiation without a clearance on a proposed attempt is refused', () => {
    expectCode(() => initiateStkPush(proposeOne(), {}, simulatedStkWire(acceptedEcho()), clock()), 'STK_CLEARANCE_INVALID');
  });

  it('a wire rejection leaves the attempt retryable with the rejection on the record', () => {
    const gated = gateStkPush(proposeOne(), { grants: liveGrant(), ruleSet: allowRuleSet(), disputeOpen: false, promisePending: false }, clock());
    if (gated.outcome.kind !== 'allowed') throw new Error('fixture');
    const wire = simulatedStkWire([{ status: 'rejected', failureReason: 'DARAJA_AUTH_FAILED' }]);
    const result = initiateStkPush(gated.action, { clearance: gated.outcome.decision }, wire, clock());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.attempt.state).toBe('proposed'); // unchanged, retryable
      expect(result.events[0]?.name).toBe('stk.pushNotInitiated');
    }
  });
});

// --- reconcile -------------------------------------------------------------------

describe('reconcileStkCallback — through the EXISTING payments intake core (R9)', () => {
  it('success: one payment created, action reconciled, intake events returned', () => {
    const { action } = initiatedOne();
    const checkout = checkoutIdOf(action);
    const result = reconcileStkCallback(action, successCallback(checkout), { clock: tickClock(30_000) });
    expect(result.duplicate).toBe(false);
    expect(result.payment.requestedMinor.amount).toBe(250_000n);
    expect(result.attempt.state).toBe('reconciled');
    expect(result.stkEvents.some((e) => e.name === 'stk.pushConfirmed')).toBe(true);
    expect(result.paymentEvents.some((e) => e.name === 'payment.confirmed')).toBe(true);
  });

  it('DUPLICATE callback: the SAME payment + the tripwire, never a second Payment (R9)', () => {
    const { action } = initiatedOne();
    const checkout = checkoutIdOf(action);
    const first = reconcileStkCallback(action, successCallback(checkout), { clock: tickClock(30_000) });
    const second = reconcileStkCallback(action, successCallback(checkout), { clock: tickClock(31_000), existing: [first.payment] });
    expect(second.duplicate).toBe(true);
    expect(second.payment).toEqual(first.payment);
    expect(second.paymentEvents.some((e) => e.name === 'payments.duplicateCallbackObserved')).toBe(true);
  });

  it('failure result codes flow through the existing failPayment transition', () => {
    const { action } = initiatedOne();
    const checkout = checkoutIdOf(action);
    const result = reconcileStkCallback(
      action,
      { checkoutRequestId: checkout, merchantRequestId: '58234-1', resultCode: 1032, resultDesc: 'Request cancelled by user' },
      { clock: tickClock(30_000) },
    );
    expect(result.attempt.state).toBe('failed');
    expect(result.paymentEvents.some((e) => e.name === 'payment.failed')).toBe(true);
    expect(result.attempt.failureCode).toBe('STK_RESULT_1032');
  });

  it('a SUCCESS callback whose metadata amount disagrees with the initiated amount is TAMPERING (K1)', () => {
    const { action } = initiatedOne();
    const checkout = checkoutIdOf(action);
    expectCode(
      () => reconcileStkCallback(action, { ...successCallback(checkout), paidMinor: 350_000 }, { clock: tickClock(30_000) }),
      'STK_AMOUNT_MISMATCH',
    );
  });

  it('a checkout this attempt never opened is refused (dead-letter)', () => {
    const { action } = initiatedOne();
    expectCode(() => reconcileStkCallback(action, successCallback('ws_CO_unknown123456'), { clock: clock() }), 'STK_CALLBACK_UNKNOWN');
  });

  it('junk callbacks are refused at the boundary (dead-letter, never invented state)', () => {
    const { action } = initiatedOne();
    expectCode(
      () =>
        reconcileStkCallback(action, { checkoutRequestId: 'pi_stripe_1', merchantRequestId: 'x', resultCode: 0, resultDesc: 'ok' }, { clock: clock() }),
      'STK_CALLBACK_INVALID',
    );
  });
});

// --- the stuck path ----------------------------------------------------------------

describe('expireStkPushIfDue — the stuck push', () => {
  it('an initiated push past its TTL times out; a LATE callback still lands (resolvedLate)', () => {
    const { action } = initiatedOne();
    const checkout = checkoutIdOf(action);
    expect(isStkPushDue(action, tick(60_000))).toBe(false);
    expect(isStkPushDue(action, tick(121_000))).toBe(true);

    const expired = expireStkPushIfDue(action, tickClock(121_000));
    expect(expired.attempt.state).toBe('timed_out');
    expect(expired.events[0]?.name).toBe('stk.pushTimedOut');
    expect(expireStkPushIfDue(action, tickClock(60_000)).attempt.state).toBe('initiated'); // not yet due

    // The late callback still lands — money truth is never dropped.
    const late = reconcileStkCallback(expired.attempt, successCallback(checkout), { clock: tickClock(130_000) });
    expect(late.payment.requestedMinor.amount).toBe(250_000n);
    expect(late.attempt.state).toBe('reconciled');
    expect(late.attempt.resolvedLate).toBe(true);
  });
});
