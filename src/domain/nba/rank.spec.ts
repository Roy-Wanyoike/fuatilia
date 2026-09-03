import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { NBA_ACTIONS, type NbaActionType } from './actions';
import {
  DEFAULT_ACTION_CAPS,
  DEFAULT_NBA_WEIGHTS,
  channelFitPermillOf,
  rankNextBestActions,
  type NbaPolicyDecision,
  type NbaRankedPlan,
  type NbaScoredCandidate,
  type NbaWeights,
} from './rank';
import type { NbaFeatureBundle } from './features';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(901);
const CUSTOMER = uid(902);
const RECEIVABLE = uid(903);

const CLOCK_ISO = '2026-03-15T09:30:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

const baseBundle: NbaFeatureBundle = {
  orgId: ORG,
  customerId: CUSTOMER,
  receivableId: RECEIVABLE,
  amountMinor: 1_000_000, // KES 10,000.00
  currency: 'KES',
  ageDays: 10,
  riskClass: 'moderate',
  paymentHistory: { onTime: 8, late: 2, unpaid: 0 },
};
const bundle = (overrides: Partial<NbaFeatureBundle> = {}): NbaFeatureBundle => ({
  ...baseBundle,
  ...overrides,
});

const weights = (overrides: Partial<NbaWeights> = {}): NbaWeights => ({
  ...DEFAULT_NBA_WEIGHTS,
  ...overrides,
});

/** Patch one entry of a per-action weight record (defaults carry the rest). */
const patchAll = (
  record: Readonly<Record<NbaActionType, number>>,
  value: number,
): Record<NbaActionType, number> => {
  const patched = { ...record };
  for (const action of NBA_ACTIONS) patched[action] = value;
  return patched;
};

const rank = (b: NbaFeatureBundle = bundle(), options: Omit<Parameters<typeof rankNextBestActions>[1], 'clock'> & { clock?: Clock } = {}): NbaRankedPlan =>
  rankNextBestActions(b, { clock, ...options });

const candidateOf = (plan: NbaRankedPlan, action: NbaActionType): NbaScoredCandidate => {
  const found = plan.ranked.find((c) => c.action === action);
  if (found === undefined) throw new Error(`candidate ${action} missing from the ranked plan`);
  return found;
};

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- plan shape + the transparent expression, hand-computed ---------------------------

describe('rankNextBestActions — plan shape and the transparent expression', () => {
  it('ranks the canonical bundle exactly as the documented expression computes it', () => {
    const plan = rank();
    // hand-computed (README tables): history 11200 × risk 10000 × promise 10000
    // × dispute 10000 × age 9000 × opt_out 10000 → signalBps 10080.
    expect(plan.recommended?.action).toBe('call');
    expect(plan.ranked.map((c) => c.action)).toEqual([
      'call', //               211680 − 5000 = 206680
      'offer_payment_plan', // 181440 − 2000 = 179440
      'send_payment_link', //  151200 − 200 = 151000
      'whatsapp', //           151200 − 500 = 150700
      'human_review', //       150000 − 10000 = 140000
      'escalate', //           100000 − 4000 = 96000
      'sms', //                90720 − 300 = 90420
      'do_nothing', //         always 0
    ]);
    expect(plan.ranked.map((c) => c.score)).toEqual([
      206_680, 179_440, 151_000, 150_700, 140_000, 96_000, 90_420, 0,
    ]);
  });

  it('exposes every intermediate value of the recommended candidate (explainability, VISION §3.7)', () => {
    const call = candidateOf(rank(), 'call');
    expect(call.status).toBe('eligible');
    expect(call.components.signalBps).toBe(10_080);
    expect(call.components.signalFactors).toEqual([
      { name: 'history', bps: 11_200 }, // 4000 + floor(9000 × 8/10)
      { name: 'risk', bps: 10_000 },
      { name: 'promise', bps: 10_000 },
      { name: 'dispute', bps: 10_000 },
      { name: 'age', bps: 9000 }, // 10000 − 100 × 10
      { name: 'opt_out', bps: 10_000 },
    ]);
    expect(call.components.expectedRecoveryMinor).toBe(352_800); // floor(350000 × 10080bps)
    expect(call.components.channelFitPermill).toBe(600); // no stated preference → neutral
    expect(call.components.weightedRecoveryMinor).toBe(211_680); // floor(352800 × 600‰)
    expect(call.components.costMinor).toBe(5_000);
    expect(call.components.approvalFrictionMinor).toBe(0);
    expect(call.components.fatigueCount).toBe(0);
    expect(call.components.fatiguePenaltyMinor).toBe(0);
  });

  it('spells the whole derivation out in human-readable reasons (every number, in order)', () => {
    const call = candidateOf(rank(), 'call');
    expect(call.reasons).toEqual([
      'expected_recovery: floor(amount 1000000 × rate 3500bps) = 350000; ' +
        'signal 10080bps (history 11200, risk 10000, promise 10000, dispute 10000, age 9000, opt_out 10000) → 352800',
      'channel_fit: 600‰',
      'weighted: floor(352800 × 600‰) = 211680',
      'cost: −5000 (call)',
      'score = 206680',
    ]);
  });

  it('carries the plan identity, amount context and the weight/cap set IN FORCE', () => {
    const plan = rank();
    expect(plan.planId).toBeDefined();
    expect(plan.orgId).toBe(ORG);
    expect(plan.customerId).toBe(CUSTOMER);
    expect(plan.receivableId).toBe(RECEIVABLE);
    expect(plan.amountMinor).toBe(1_000_000);
    expect(plan.currency).toBe('KES');
    expect(plan.createdAt).toBe(CLOCK_ISO);
    expect(plan.weights).toEqual(DEFAULT_NBA_WEIGHTS);
    expect(plan.caps).toEqual(DEFAULT_ACTION_CAPS);

    const custom = weights({ fatigueWindowDays: 7, approvalFrictionMinor: 1234 });
    const customPlan = rank(bundle(), { weights: custom, caps: { call: 9 } });
    expect(customPlan.weights.fatigueWindowDays).toBe(7);
    expect(customPlan.weights.approvalFrictionMinor).toBe(1234);
    expect(customPlan.caps).toEqual({ call: 9 });
  });

  it('emits exactly one nba.recommendationCreated event with the narrow, evidence-refed payload', () => {
    const plan = rank();
    expect(plan.events).toHaveLength(1);
    const event = plan.events[0]!;
    expect(event.name).toBe('nba.recommendationCreated');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(plan.planId);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload).toEqual({
      planId: plan.planId,
      orgId: ORG,
      customerId: CUSTOMER,
      receivableId: RECEIVABLE,
      amountMinor: 1_000_000,
      currency: 'KES',
      recommendedAction: 'call',
      recommendedScore: 206_680,
      // every eligible candidate below the recommendation, best first
      alternatives: [
        { action: 'offer_payment_plan', score: 179_440 },
        { action: 'send_payment_link', score: 151_000 },
        { action: 'whatsapp', score: 150_700 },
        { action: 'human_review', score: 140_000 },
        { action: 'escalate', score: 96_000 },
        { action: 'sms', score: 90_420 },
        { action: 'do_nothing', score: 0 },
      ],
      policyEvidence: [],
      createdAt: CLOCK_ISO,
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event); // serializable for the outbox
  });

  it('is a pure function: two runs over the same bundle + clock are bit-for-bit identical', () => {
    const a = rank();
    const b = rank();
    expect(a).toEqual(b);
    expect(a.planId).toBe(b.planId);
    expect(a.ranked).not.toBe(b.ranked); // fresh arrays every call — no shared state
  });

  it('derives planId deterministically from org/customer/receivable/amount/instant', () => {
    const same = rank();
    const otherInstant = rankNextBestActions(baseBundle, { clock: clockAt('2026-03-15T09:30:00.001Z') });
    const otherCustomer = rank(bundle({ customerId: uid(999) }));
    expect(otherInstant.planId).not.toBe(same.planId);
    expect(otherCustomer.planId).not.toBe(same.planId);
  });

  it('never mutates the caller’s bundle (deep-frozen input, unchanged output)', () => {
    const deepFreeze = (value: object): void => {
      for (const inner of Object.values(value)) {
        if (inner !== null && typeof inner === 'object') deepFreeze(inner);
      }
      Object.freeze(value);
    };
    const populated = bundle({
      channelPreferences: { whatsapp: 'opted_in' },
      recentActions: [{ action: 'call', daysAgo: 2 }],
      priorOutcomes: [{ action: 'sms', outcome: 'no_response' }],
      promise: { state: 'pending', reliabilityPermill: 500 },
    });
    const snapshot = JSON.parse(JSON.stringify(populated));
    deepFreeze(populated); // any mutation attempt throws in strict mode
    const plan = rankNextBestActions(populated, { clock });
    expect(plan.recommended).not.toBeNull();
    expect(JSON.parse(JSON.stringify(populated))).toEqual(snapshot); // bit-for-bit unchanged
  });
});

// --- ranking tables (deterministic; every row hand-checked) ----------------------------

describe('rankNextBestActions — ranking tables', () => {
  it('picks the next-best action per scenario (table)', () => {
    const table: Array<[Partial<NbaFeatureBundle>, NbaActionType, string]> = [
      // canonical good payer, fresh debt, neutral channels → the call recovers most
      [{}, 'call', 'default bundle'],
      // aged + high risk: escalation out-ranks every customer-facing action
      [{ ageDays: 60, riskClass: 'high' }, 'escalate', 'aged high-risk'],
      // SPEC §29: an open dispute demands a human, never aggressive automation
      [{ ageDays: 60, riskClass: 'high', disputeOpen: true }, 'human_review', 'dispute pause'],
      // tiny amount: nothing covers its own cost — do nothing
      [{ amountMinor: 100 }, 'do_nothing', 'dust amount'],
      // every channel opted out: automation has no fit, humans cost more than dust recovers
      [
        {
          amountMinor: 10_000,
          channelPreferences: { call: 'opted_out', whatsapp: 'opted_out', sms: 'opted_out' },
        },
        'do_nothing',
        'all channels opted out',
      ],
      // an opted-out outcome is a consent hard-stop for customer-facing automation
      [{ priorOutcomes: [{ action: 'call', outcome: 'opted_out' }], amountMinor: 10_000 }, 'do_nothing', 'prior opt-out'],
      // …but the opted-out customer still deserves a HUMAN — only automation stops
      [{ priorOutcomes: [{ action: 'call', outcome: 'opted_out' }] }, 'human_review', 'opt-out keeps human review'],
      // a reliable live promise suppresses customer-facing outreach (see the focused test below)
      [{ amountMinor: 100_000, promise: { state: 'pending', reliabilityPermill: 900 } }, 'escalate', 'live promise'],
    ];
    for (const [overrides, expected, label] of table) {
      const plan = rank(bundle(overrides));
      expect(plan.recommended?.action, label).toBe(expected);
    }
  });

  it('suppresses outreach under a reliable live promise and restores it when a promise breaks', () => {
    const pending = rank(bundle({ amountMinor: 100_000, promise: { state: 'pending', reliabilityPermill: 900 } }));
    // the pending promise cuts call's signal to 3250bps: call (1879) drops below whatsapp (4414)
    expect(candidateOf(pending, 'call').components.signalFactors.find((f) => f.name === 'promise')?.bps).toBe(3_250);
    expect(candidateOf(pending, 'call').score).toBe(1_879);
    expect(candidateOf(pending, 'whatsapp').score).toBe(4_414);
    expect(pending.ranked.indexOf(candidateOf(pending, 'call'))).toBeGreaterThan(
      pending.ranked.indexOf(candidateOf(pending, 'whatsapp')),
    );
    const broken = rank(bundle({ amountMinor: 100_000, promise: { state: 'broken', reliabilityPermill: 900 } }));
    // a BROKEN promise boosts the signal (12000bps): call (20401) is back on top
    expect(candidateOf(broken, 'call').components.signalFactors.find((f) => f.name === 'promise')?.bps).toBe(12_000);
    expect(candidateOf(broken, 'call').score).toBe(20_401);
    expect(broken.recommended?.action).toBe('call');
  });

  it('ranks escalate → human_review → call for the aged high-risk row (order evidence)', () => {
    const plan = rank(bundle({ ageDays: 60, riskClass: 'high' }));
    expect(plan.ranked.slice(0, 3).map((c) => c.action)).toEqual(['escalate', 'human_review', 'call']);
    expect(plan.ranked[0]!.score).toBe(296_000); // 300000 weighted − 4000 cost
  });

  it('folds the dispute signal per action class: 3000 customer-facing, 15000 review, 8000 escalate', () => {
    const plan = rank(bundle({ disputeOpen: true }));
    expect(candidateOf(plan, 'call').components.signalFactors.find((f) => f.name === 'dispute')?.bps).toBe(3_000);
    expect(candidateOf(plan, 'human_review').components.signalFactors).toEqual([
      { name: 'dispute', bps: 15_000 },
      { name: 'review_risk', bps: 10_000 },
    ]);
    expect(candidateOf(plan, 'escalate').components.signalFactors).toEqual([
      { name: 'dispute', bps: 8_000 },
      { name: 'escalate_age', bps: 5_000 },
    ]);
  });

  it('tables the per-signal factor values (history, promise, age, risk, review-risk, escalation age)', () => {
    const factorBps = (b: NbaFeatureBundle, action: NbaActionType, name: string): number => {
      const factors = candidateOf(rank(b), action).components.signalFactors;
      const factor = factors.find((f) => f.name === name);
      if (factor === undefined) throw new Error(`factor ${name} missing for ${action}`);
      return factor.bps;
    };
    const table: Array<[NbaFeatureBundle, NbaActionType, string, number]> = [
      [bundle({ paymentHistory: { onTime: 10, late: 0, unpaid: 0 } }), 'call', 'history', 13_000],
      [bundle({ paymentHistory: { onTime: 0, late: 10, unpaid: 0 } }), 'call', 'history', 4_000],
      [bundle({ paymentHistory: { onTime: 0, late: 0, unpaid: 0 } }), 'call', 'history', 10_000], // no history → neutral
      [bundle({ paymentHistory: { onTime: 5, late: 5, unpaid: 0 } }), 'call', 'history', 8_500],
      [bundle({ promise: { state: 'pending', reliabilityPermill: 1000 } }), 'call', 'promise', 2_500],
      [bundle({ promise: { state: 'pending', reliabilityPermill: 0 } }), 'call', 'promise', 10_000],
      [bundle({ promise: { state: 'pending', reliabilityPermill: 800 } }), 'call', 'promise', 4_000],
      [bundle({ promise: { state: 'fulfilled', reliabilityPermill: 500 } }), 'call', 'promise', 11_000],
      [bundle({ promise: { state: 'broken', reliabilityPermill: 500 } }), 'call', 'promise', 12_000],
      [bundle({ ageDays: 0 }), 'call', 'age', 10_000],
      [bundle({ ageDays: 30 }), 'call', 'age', 7_000],
      [bundle({ ageDays: 60 }), 'call', 'age', 4_000],
      [bundle({ ageDays: 365 }), 'call', 'age', 4_000], // floor holds
      [bundle({ riskClass: 'low' }), 'call', 'risk', 11_000],
      [bundle({ riskClass: 'elevated' }), 'call', 'risk', 8_500],
      [bundle({ riskClass: 'high' }), 'call', 'risk', 6_500],
      [bundle({ riskClass: 'high' }), 'human_review', 'review_risk', 14_000],
      [bundle({ riskClass: 'low' }), 'human_review', 'review_risk', 8_000],
      [bundle({ ageDays: 29 }), 'escalate', 'escalate_age', 5_000],
      [bundle({ ageDays: 30 }), 'escalate', 'escalate_age', 12_000],
      [bundle({ ageDays: 60 }), 'escalate', 'escalate_age', 15_000],
    ];
    for (const [b, action, name, expected] of table) {
      expect(factorBps(b, action, name), `${action}.${name}`).toBe(expected);
    }
  });

  it('keeps do_nothing a first-class candidate scoring exactly 0 with its own reasons', () => {
    const nothing = candidateOf(rank(), 'do_nothing');
    expect(nothing.status).toBe('eligible');
    expect(nothing.score).toBe(0);
    expect(nothing.components.signalFactors).toEqual([]);
    expect(nothing.components.channelFitPermill).toBe(1000); // internal, channel-free
    expect(nothing.reasons).toEqual([
      'expected_recovery: 0 — no action taken, nothing collected',
      'cost: −0 (do_nothing)',
      'always scores 0: zero recovery, zero cost, zero fatigue — wins when every other candidate scores ≤ 0',
      'score = 0',
    ]);
  });

  it('never exhausts do_nothing: a fully capped slate degrades gracefully to it', () => {
    const caps = Object.fromEntries(
      NBA_ACTIONS.filter((a) => a !== 'do_nothing').map((a) => [a, 0]),
    ) as Partial<Record<NbaActionType, number>>;
    const plan = rank(bundle(), { caps });
    expect(plan.ranked.filter((c) => c.action !== 'do_nothing').map((c) => c.status)).toEqual(
      NBA_ACTIONS.filter((a) => a !== 'do_nothing').map(() => 'fatigue_capped'),
    );
    expect(plan.recommended?.action).toBe('do_nothing');
  });
});

// --- deterministic tie-breaks ------------------------------------------------------------

describe('rankNextBestActions — deterministic tie-breaks', () => {
  it('breaks score ties by the canonical NBA_ACTIONS order (whatsapp before send_payment_link)', () => {
    // equal rates + zero costs + uniformly perfect channel fit → a genuine tie
    const w = weights({
      costMinor: patchAll(DEFAULT_NBA_WEIGHTS.costMinor, 0),
      channelFitNeutralPermill: 1000,
    });
    const plan = rank(bundle(), { weights: w });
    const whatsapp = candidateOf(plan, 'whatsapp');
    const link = candidateOf(plan, 'send_payment_link');
    expect(whatsapp.score).toBe(link.score);
    expect(plan.ranked.indexOf(whatsapp)).toBeLessThan(plan.ranked.indexOf(link));
    expect(plan.ranked.map((c) => c.action)).toEqual([
      'call', 'offer_payment_plan', 'whatsapp', 'send_payment_link', 'sms', 'human_review', 'escalate', 'do_nothing',
    ]);
  });

  it('breaks an all-tie (every candidate 0) by the canonical order — call first, do_nothing last', () => {
    const w = weights({
      recoveryRateBps: patchAll(DEFAULT_NBA_WEIGHTS.recoveryRateBps, 0),
      costMinor: patchAll(DEFAULT_NBA_WEIGHTS.costMinor, 0),
    });
    const plan = rank(bundle(), { weights: w });
    expect(plan.ranked.map((c) => c.score)).toEqual(Array(8).fill(0));
    expect(plan.ranked.map((c) => c.action)).toEqual([...NBA_ACTIONS]);
    expect(plan.recommended?.action).toBe('call');
  });
});

// --- channel fit -------------------------------------------------------------------------

describe('rankNextBestActions — channel fit (‰)', () => {
  it('maps preferences per channel: opted_in 1000 / neutral 600 / opted_out 0', () => {
    const prefs = { call: 'opted_in', whatsapp: 'neutral', sms: 'opted_out' } as const;
    const b = bundle({ channelPreferences: { ...prefs } });
    const plan = rank(b);
    const table: Array<[NbaActionType, number]> = [
      ['call', 1000],
      ['whatsapp', 600],
      ['sms', 0],
      ['offer_payment_plan', 600], // best digital channel (whatsapp neutral)
      ['send_payment_link', 600],
      ['human_review', 1000], // internal — channel-free
      ['escalate', 1000],
      ['do_nothing', 1000],
    ];
    for (const [action, fit] of table) {
      expect(candidateOf(plan, action).components.channelFitPermill, action).toBe(fit);
    }
    expect(channelFitPermillOf(b, 'call', DEFAULT_NBA_WEIGHTS)).toBe(1000);
    expect(channelFitPermillOf(bundle(), 'sms', DEFAULT_NBA_WEIGHTS)).toBe(600);
  });

  it('rides offers and links over the BEST digital channel, and a 0 fit zeroes the weighted recovery', () => {
    const b = bundle({ channelPreferences: { whatsapp: 'opted_in', sms: 'opted_out' } });
    expect(candidateOf(rank(b), 'offer_payment_plan').components.channelFitPermill).toBe(1000);
    const bothOut = bundle({ channelPreferences: { whatsapp: 'opted_out', sms: 'opted_out' } });
    const link = candidateOf(rank(bothOut), 'send_payment_link');
    expect(link.components.channelFitPermill).toBe(0);
    expect(link.components.weightedRecoveryMinor).toBe(0);
    expect(link.score).toBe(-link.components.costMinor); // nothing weighted, cost still real
  });

  it('tables the fit × fatigue interaction (opted-out channel + fatigue never adds back)', () => {
    const b = bundle({
      channelPreferences: { sms: 'opted_out' },
      recentActions: [{ action: 'sms', daysAgo: 1 }],
    });
    const sms = candidateOf(rank(b), 'sms');
    expect(sms.components.weightedRecoveryMinor).toBe(0);
    expect(sms.components.fatiguePenaltyMinor).toBe(800);
    expect(sms.score).toBe(-300 - 800);
  });
});

// --- fatigue penalties + per-action caps -------------------------------------------------

describe('rankNextBestActions — fatigue penalties and caps', () => {
  it('penalizes each recent same-type action inside the window (count × per-action penalty)', () => {
    const plan = rank(bundle({ recentActions: [{ action: 'call', daysAgo: 2 }, { action: 'call', daysAgo: 5 }] }));
    const call = candidateOf(plan, 'call');
    expect(call.components.fatigueCount).toBe(2);
    expect(call.components.fatiguePenaltyMinor).toBe(6_000);
    expect(call.score).toBe(206_680 - 6_000);
    expect(call.reasons).toContain('fatigue: 2 recent call within 14d → −6000');
  });

  it('tables the window boundary: daysAgo == window counts, beyond it does not', () => {
    const inside = candidateOf(rank(bundle({ recentActions: [{ action: 'call', daysAgo: 14 }] })), 'call');
    const outside = candidateOf(rank(bundle({ recentActions: [{ action: 'call', daysAgo: 15 }] })), 'call');
    expect(inside.components.fatigueCount).toBe(1);
    expect(outside.components.fatigueCount).toBe(0);
  });

  it('charges per-action penalties, not a global one (whatsapp and sms independent)', () => {
    const plan = rank(
      bundle({ recentActions: [{ action: 'whatsapp', daysAgo: 1 }, { action: 'whatsapp', daysAgo: 2 }, { action: 'sms', daysAgo: 1 }] }),
    );
    expect(candidateOf(plan, 'whatsapp').components.fatiguePenaltyMinor).toBe(2_000);
    expect(candidateOf(plan, 'sms').components.fatiguePenaltyMinor).toBe(800);
    expect(candidateOf(plan, 'call').components.fatiguePenaltyMinor).toBe(0);
  });

  it('internal actions take no fatigue penalty but still exhaust at their cap', () => {
    const plan = rank(bundle({ recentActions: [{ action: 'escalate', daysAgo: 1 }] }));
    const escalate = candidateOf(plan, 'escalate');
    expect(escalate.components.fatigueCount).toBe(1);
    expect(escalate.components.fatiguePenaltyMinor).toBe(0);
    expect(escalate.status).toBe('fatigue_capped'); // default escalate cap = 1
    expect(escalate.reasons).toContain('cap: 1/1 recent escalate within 14d — exhausted, excluded from recommendation');
  });

  it('exhausts an action at its cap and recommends the NEXT-BEST instead (graceful fall-through)', () => {
    const plan = rank(
      bundle({
        recentActions: [
          { action: 'call', daysAgo: 1 },
          { action: 'call', daysAgo: 3 },
          { action: 'call', daysAgo: 5 },
        ],
      }),
    );
    const call = candidateOf(plan, 'call');
    expect(call.status).toBe('fatigue_capped'); // 3 recent calls ≥ default cap 3
    expect(call.score).toBe(206_680 - 9_000); // still scored, penalty included
    expect(plan.recommended?.action).toBe('offer_payment_plan'); // next-best takes over
    expect(plan.events[0]!.payload.recommendedAction).toBe('offer_payment_plan');
  });

  it('honors custom caps, including cap 0 (the action is configured off)', () => {
    const plan = rank(bundle(), { caps: { call: 0 } });
    expect(candidateOf(plan, 'call').status).toBe('fatigue_capped');
    expect(candidateOf(plan, 'call').components.fatigueCount).toBe(0);
    expect(plan.recommended?.action).toBe('offer_payment_plan');
  });

  it('never lets fatigue touch do_nothing (it ignores recentActions entirely)', () => {
    const plan = rank(bundle({ recentActions: [{ action: 'do_nothing', daysAgo: 0 }, { action: 'do_nothing', daysAgo: 1 }] }));
    const nothing = candidateOf(plan, 'do_nothing');
    expect(nothing.components.fatigueCount).toBe(0);
    expect(nothing.components.fatiguePenaltyMinor).toBe(0);
    expect(nothing.score).toBe(0);
  });
});

// --- policy filter (VISION §3.9 — NBA never bypasses policy) ------------------------------

describe('rankNextBestActions — policy filter', () => {
  const deny = (action: NbaActionType, reasonCode: string): NbaPolicyDecision => ({
    action,
    decision: 'deny',
    reasonCode,
  });

  it('excludes a denied top action, recommends the NEXT-BEST, and records the denial in its reasons', () => {
    const plan = rank(bundle(), {
      policyDecisions: [deny('call', 'F20_VOICE_BLOCKED_FOR_SEGMENT')],
    });
    expect(plan.recommended?.action).toBe('offer_payment_plan'); // next-best, not the denied top
    const call = candidateOf(plan, 'call');
    expect(call.status).toBe('denied');
    expect(call.reasons).toContain(
      'policy: denied (F20_VOICE_BLOCKED_FOR_SEGMENT) — excluded from recommendation; NBA never bypasses policy',
    );
    expect(plan.events[0]!.payload.policyEvidence).toEqual([
      { action: 'call', reasonCode: 'F20_VOICE_BLOCKED_FOR_SEGMENT', decision: 'deny' },
    ]);
  });

  it('keeps requires_approval runnable but downgrades it by the approval friction', () => {
    const plan = rank(bundle(), {
      policyDecisions: [{ action: 'call', decision: 'requires_approval', reasonCode: 'F20_SIGNOFF_LARGE' }],
    });
    const call = candidateOf(plan, 'call');
    expect(call.status).toBe('requires_approval');
    expect(call.components.approvalFrictionMinor).toBe(2_500);
    expect(call.score).toBe(206_680 - 2_500);
    expect(plan.recommended?.action).toBe('call'); // still the best action — after sign-off
    expect(call.reasons).toContain(
      'policy: requires_approval (F20_SIGNOFF_LARGE) — downgraded by approval friction, runs only after sign-off',
    );
    expect(plan.events[0]!.payload.policyEvidence).toEqual([
      { action: 'call', reasonCode: 'F20_SIGNOFF_LARGE', decision: 'requires_approval' },
    ]);
  });

  it('lets the approval friction demote a candidate out of the top (table)', () => {
    const heavy = weights({ approvalFrictionMinor: 300_000 });
    const plan = rank(bundle(), {
      weights: heavy,
      policyDecisions: [{ action: 'call', decision: 'requires_approval', reasonCode: 'F20_SIGNOFF_LARGE' }],
    });
    expect(candidateOf(plan, 'call').score).toBe(206_680 - 300_000);
    expect(plan.recommended?.action).toBe('offer_payment_plan');
  });

  it('can recommend a requires_approval candidate when it survives the friction as best', () => {
    const plan = rank(bundle(), {
      policyDecisions: [
        deny('call', 'F20_VOICE_BLOCKED_FOR_SEGMENT'),
        { action: 'offer_payment_plan', decision: 'requires_approval', reasonCode: 'F20_PLAN_SIGNOFF' },
      ],
    });
    expect(plan.recommended?.action).toBe('offer_payment_plan');
    expect(plan.recommended?.status).toBe('requires_approval');
    expect(plan.recommended?.components.approvalFrictionMinor).toBe(2_500);
    expect(candidateOf(plan, 'send_payment_link').score).toBe(151_000); // eligible runner-up is far behind
  });

  it('counts silence as allow (no decision → eligible, no policy line)', () => {
    const plan = rank(bundle(), {
      policyDecisions: [{ action: 'sms', decision: 'allow', reasonCode: 'F20_SMS_OK' }],
    });
    const call = candidateOf(plan, 'call');
    expect(call.status).toBe('eligible');
    expect(call.reasons.some((r) => r.startsWith('policy:'))).toBe(false);
    const sms = candidateOf(plan, 'sms');
    expect(sms.status).toBe('eligible');
    expect(sms.reasons).toContain('policy: allow (F20_SMS_OK)');
  });

  it('returns recommended: null when policy denies EVERY candidate — "no legal action" is an answer', () => {
    const plan = rank(bundle(), { policyDecisions: NBA_ACTIONS.map((a) => deny(a, 'F20_TOTAL_LOCKDOWN')) });
    expect(plan.recommended).toBeNull();
    expect(plan.ranked.map((c) => c.status)).toEqual(Array(8).fill('denied'));
    expect(plan.events[0]!.payload.recommendedAction).toBeNull();
    expect(plan.events[0]!.payload.recommendedScore).toBe(0);
    expect(plan.events[0]!.payload.alternatives).toEqual([]);
    expect(plan.events[0]!.payload.policyEvidence).toHaveLength(8);
  });

  it('ranks policy above fatigue: a denied + exhausted action still shows as denied', () => {
    const plan = rank(
      bundle({ recentActions: [{ action: 'call', daysAgo: 1 }, { action: 'call', daysAgo: 2 }, { action: 'call', daysAgo: 3 }] }),
      { policyDecisions: [deny('call', 'F20_VOICE_BLOCKED_FOR_SEGMENT')] },
    );
    expect(candidateOf(plan, 'call').status).toBe('denied');
  });

  it('validates policy decisions (table)', () => {
    expectCode(
      () => rank(bundle(), { policyDecisions: [{ action: 'smoke_signal' as NbaActionType, decision: 'deny', reasonCode: 'X' }] }),
      'NBA_POLICY_DECISION_INVALID',
    );
    expectCode(
      () => rank(bundle(), { policyDecisions: [{ action: 'call', decision: 'maybe' as 'deny', reasonCode: 'X' }] }),
      'NBA_POLICY_DECISION_INVALID',
    );
    expectCode(
      () => rank(bundle(), { policyDecisions: [{ action: 'call', decision: 'deny', reasonCode: '   ' }] }),
      'NBA_POLICY_DECISION_INVALID',
    );
    expectCode(
      () =>
        rank(bundle(), {
          policyDecisions: [
            { action: 'call', decision: 'deny', reasonCode: 'A' },
            { action: 'call', decision: 'allow', reasonCode: 'B' },
          ],
        }),
      'NBA_POLICY_DECISION_DUPLICATE',
    );
  });
});

// --- weights / caps / clock validation -----------------------------------------------------

describe('rankNextBestActions — configuration validation (stable NBA_* codes)', () => {
  it('refuses malformed weights (table)', () => {
    const bad: Array<[NbaWeights, string]> = [
      [weights({ recoveryRateBps: { ...DEFAULT_NBA_WEIGHTS.recoveryRateBps, call: 10_001 } }), 'recoveryRateBps.call > 10000'],
      [weights({ recoveryRateBps: { ...DEFAULT_NBA_WEIGHTS.recoveryRateBps, sms: -1 } }), 'negative rate'],
      [weights({ costMinor: { ...DEFAULT_NBA_WEIGHTS.costMinor, whatsapp: -1 } }), 'negative cost'],
      [weights({ costMinor: { ...DEFAULT_NBA_WEIGHTS.costMinor, whatsapp: 1.5 } }), 'fractional cost'],
      [weights({ fatiguePenaltyMinor: { ...DEFAULT_NBA_WEIGHTS.fatiguePenaltyMinor, sms: -800 } }), 'negative penalty'],
      [weights({ fatigueWindowDays: -1 }), 'negative window'],
      [weights({ fatigueWindowDays: 1.5 }), 'fractional window'],
      [weights({ channelFitOptedInPermill: 1001 }), 'fit > 1000'],
      [weights({ channelFitNeutralPermill: -1 }), 'negative fit'],
      [weights({ approvalFrictionMinor: -5 }), 'negative friction'],
    ];
    for (const [w, label] of bad) {
      expectCode(() => rankNextBestActions(baseBundle, { clock, weights: w }), 'NBA_WEIGHTS_INVALID');
      expect(label).toBeTruthy();
    }
  });

  it('refuses malformed caps (table)', () => {
    expectCode(() => rankNextBestActions(baseBundle, { clock, caps: { escalate: -1 } }), 'NBA_CAPS_INVALID');
    expectCode(() => rankNextBestActions(baseBundle, { clock, caps: { smoke_signal: 2 } as Partial<Record<NbaActionType, number>> }), 'NBA_CAPS_INVALID');
    expectCode(() => rankNextBestActions(baseBundle, { clock, caps: { do_nothing: 3 } }), 'NBA_CAPS_INVALID');
  });

  it('refuses a broken injected clock with NBA_CLOCK_INVALID (never a raw TypeError)', () => {
    expectCode(() => rankNextBestActions(baseBundle, { clock: { now: () => 'nope' as unknown as Date } }), 'NBA_CLOCK_INVALID');
    expectCode(() => rankNextBestActions(baseBundle, { clock: { now: () => new Date('bogus') } }), 'NBA_CLOCK_INVALID');
  });

  it('propagates bundle validation codes (sample rows)', () => {
    expectCode(() => rankNextBestActions(bundle({ riskClass: 'extreme' as 'low' }), { clock }), 'NBA_RISK_INVALID');
    expectCode(() => rankNextBestActions(bundle({ currency: 'XYZ' as 'KES' }), { clock }), 'NBA_CURRENCY_INVALID');
  });
});

// --- exact integer arithmetic + determinism -------------------------------------------------

describe('rankNextBestActions — exact arithmetic and determinism', () => {
  it('scores the maximum scorable amount exactly (BigInt oracle — no float drift)', () => {
    const amount = 600_000_000_000_000n; // NBA_MAX_SCORABLE_AMOUNT_MINOR
    // exact reference computation of call's score under the default weights
    const step1 = (amount * 3500n) / 10_000n; // rate
    const step2 = (step1 * 10_080n) / 10_000n; // signal
    const step3 = (step2 * 600n) / 1_000n; // channel fit
    const expected = Number(step3 - 5_000n);
    const plan = rank(bundle({ amountMinor: Number(amount) }));
    const call = candidateOf(plan, 'call');
    expect(call.components.expectedRecoveryMinor).toBe(Number(step2));
    expect(call.components.weightedRecoveryMinor).toBe(Number(step3));
    expect(call.score).toBe(expected);
  });

  it('is deterministic across runs and independent of object key order (replay safety)', () => {
    const a = rank(bundle({ recentActions: [{ action: 'call', daysAgo: 2 }] }));
    const reordered: NbaFeatureBundle = {
      priorOutcomes: undefined,
      recentActions: [{ action: 'call', daysAgo: 2 }],
      channelPreferences: undefined,
      disputeOpen: undefined,
      promise: undefined,
      paymentHistory: { onTime: 8, late: 2, unpaid: 0 },
      riskClass: 'moderate',
      ageDays: 10,
      currency: 'KES',
      amountMinor: 1_000_000,
      receivableId: RECEIVABLE,
      customerId: CUSTOMER,
      orgId: ORG,
    };
    const b = rankNextBestActions(reordered, { clock });
    expect(a.ranked.map((c) => [c.action, c.score])).toEqual(b.ranked.map((c) => [c.action, c.score]));
    expect(a.planId).toBe(b.planId);
  });
});
