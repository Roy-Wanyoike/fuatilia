import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { recordOutcome, actionEffectiveness, priorOutcomesOf, type ActionOutcomeFact } from './feedback';
import { rankNextBestActions, type NbaRankedPlan } from './rank';
import type { NbaFeatureBundle, NbaOutcome } from './features';
import type { NbaPolicyDecision } from './rank';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(951);
const CUSTOMER = uid(952);

const CLOCK_ISO = '2026-03-15T09:30:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };
const clockAt = (iso: string): Clock => ({ now: () => new Date(iso) });

const bundle = (overrides: Partial<NbaFeatureBundle> = {}): NbaFeatureBundle => ({
  orgId: ORG,
  customerId: CUSTOMER,
  receivableId: uid(953),
  amountMinor: 1_000_000,
  currency: 'KES',
  ageDays: 10,
  riskClass: 'moderate',
  paymentHistory: { onTime: 8, late: 2, unpaid: 0 },
  ...overrides,
});

/** A canonical plan: recommend = call (see rank.spec.ts for the full derivation). */
const plan = (overrides: Partial<NbaFeatureBundle> = {}): NbaRankedPlan =>
  rankNextBestActions(bundle(overrides), { clock });

const denyAllPlan = (): NbaRankedPlan =>
  rankNextBestActions(bundle(), {
    clock,
    policyDecisions: (
      ['call', 'whatsapp', 'sms', 'offer_payment_plan', 'send_payment_link', 'human_review', 'escalate', 'do_nothing'] as const
    ).map((action) => ({ action, decision: 'deny' as const, reasonCode: 'F20_LOCKDOWN' })),
  });

const fact = (overrides: Partial<ActionOutcomeFact> = {}): ActionOutcomeFact => ({
  planId: uid(700),
  action: 'call',
  outcome: 'paid',
  occurredAt: '2026-03-01T00:00:00.000Z',
  recordedAt: '2026-03-02T00:00:00.000Z',
  ...overrides,
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

// --- recordOutcome: append-only, idempotent, evented ---------------------------------------

describe('recordOutcome — the feedback hook', () => {
  it('appends exactly one fact attributing the outcome to the recommended action', () => {
    const p = plan();
    const occurredAt = new Date('2026-03-20T10:00:00.000Z');
    const result = recordOutcome([], p, 'paid', occurredAt, clock);
    expect(result.duplicate).toBe(false);
    expect(result.facts).toEqual([
      {
        planId: p.planId,
        action: 'call', // the plan's recommendation — never an invented action
        outcome: 'paid',
        occurredAt: '2026-03-20T10:00:00.000Z',
        recordedAt: CLOCK_ISO,
      },
    ]);
  });

  it('emits nba.actionOutcomeRecorded with the narrow, id-only payload', () => {
    const p = plan({ customerId: CUSTOMER, receivableId: uid(955) });
    const result = recordOutcome([], p, 'promise_made', new Date('2026-03-18T08:00:00.000Z'), clock);
    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.name).toBe('nba.actionOutcomeRecorded');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(p.planId);
    expect(event.occurredAt).toBe(CLOCK_ISO);
    expect(event.payload).toEqual({
      planId: p.planId,
      orgId: ORG,
      customerId: CUSTOMER,
      receivableId: uid(955),
      action: 'call',
      outcome: 'promise_made',
      occurredAt: '2026-03-18T08:00:00.000Z',
      recordedAt: CLOCK_ISO,
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('is idempotent on unique(planId, outcome): a replay returns the ORIGINAL facts + the tripwire', () => {
    const p = plan();
    const first = recordOutcome([], p, 'paid', new Date('2026-03-20T10:00:00.000Z'), clock);
    const replay = recordOutcome(first.facts, p, 'paid', new Date('2026-03-21T10:00:00.000Z'), clockAt('2026-03-21T11:00:00.000Z'));
    expect(replay.duplicate).toBe(true);
    expect(replay.facts).toEqual(first.facts); // original content AND order, unchanged
    expect(replay.facts).toHaveLength(1); // NOT appended twice
    const tripwire = replay.events[0]!;
    expect(tripwire.name).toBe('nba.duplicateOutcomeObserved');
    expect(tripwire.version).toBe(1);
    expect(tripwire.aggregateId).toBe(p.planId);
    expect(tripwire.occurredAt).toBe('2026-03-21T11:00:00.000Z');
    expect(tripwire.payload).toEqual({ planId: p.planId, outcome: 'paid', seenAt: '2026-03-21T11:00:00.000Z' });
  });

  it('appends again for the same plan with a DIFFERENT outcome (genuinely new fact)', () => {
    const p = plan();
    const first = recordOutcome([], p, 'no_response', new Date('2026-03-20T10:00:00.000Z'), clock);
    const second = recordOutcome(first.facts, p, 'paid', new Date('2026-03-25T10:00:00.000Z'), clock);
    expect(second.duplicate).toBe(false);
    expect(second.facts.map((f) => f.outcome)).toEqual(['no_response', 'paid']);
    expect(second.events[0]!.name).toBe('nba.actionOutcomeRecorded');
  });

  it('appends again for a DIFFERENT plan with the same outcome', () => {
    const p1 = plan({ receivableId: uid(953) });
    const p2 = plan({ receivableId: uid(954) });
    const first = recordOutcome([], p1, 'paid', new Date('2026-03-20T10:00:00.000Z'), clock);
    const second = recordOutcome(first.facts, p2, 'paid', new Date('2026-03-21T10:00:00.000Z'), clock);
    expect(second.duplicate).toBe(false);
    expect(second.facts.map((f) => f.planId)).toEqual([p1.planId, p2.planId]);
  });

  it('stamps recordedAt from the injected Clock but preserves the caller-supplied occurredAt', () => {
    const result = recordOutcome([], plan(), 'partial', new Date('2026-01-01T00:00:00.000Z'), clockAt('2026-02-01T12:34:56.789Z'));
    expect(result.facts[0]!.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.facts[0]!.recordedAt).toBe('2026-02-01T12:34:56.789Z');
  });

  it('never mutates the caller’s fact list (fresh array every call)', () => {
    const existing = [fact({ outcome: 'no_response' })];
    const snapshot = [...existing];
    const result = recordOutcome(existing, plan(), 'paid', new Date(), clock);
    expect(existing).toEqual(snapshot); // input untouched
    expect(result.facts).not.toBe(existing); // new array
    expect(result.facts).toHaveLength(2);
  });

  it('refuses to record an outcome for a plan that recommended nothing (NBA never invents an action)', () => {
    expectCode(() => recordOutcome([], denyAllPlan(), 'paid', new Date(), clock), 'NBA_PLAN_HAS_NO_RECOMMENDATION');
  });

  it('validates malformed input (table)', () => {
    const p = plan();
    expectCode(() => recordOutcome([], p, 'won' as NbaOutcome, new Date(), clock), 'NBA_OUTCOME_INVALID');
    expectCode(() => recordOutcome([], p, 'paid', new Date('bogus'), clock), 'NBA_OCCURRED_AT_INVALID');
    expectCode(() => recordOutcome([], p, 'paid', 'not-a-date' as unknown as Date, clock), 'NBA_OCCURRED_AT_INVALID');
    expectCode(() => recordOutcome([], p, 'paid', new Date(), { now: () => 'garbage' } as unknown as Clock), 'NBA_CLOCK_INVALID');
    expectCode(() => recordOutcome([], null as unknown as NbaRankedPlan, 'paid', new Date(), clock), 'NBA_PLAN_INVALID');
    expectCode(
      () => recordOutcome([], { planId: '   ' } as unknown as NbaRankedPlan, 'paid', new Date(), clock),
      'NBA_PLAN_INVALID',
    );
    expectCode(
      () =>
        recordOutcome(
          [],
          { ...p, recommended: { ...p.recommended!, action: 'smoke_signal' } } as unknown as NbaRankedPlan,
          'paid',
          new Date(),
          clock,
        ),
      'NBA_ACTION_INVALID',
    );
  });
});

// --- actionEffectiveness: deterministic replay over accumulated facts -----------------------

describe('actionEffectiveness — derived stats', () => {
  it('returns [] for an empty ledger', () => {
    expect(actionEffectiveness([])).toEqual([]);
  });

  it('counts every outcome per action and derives the success rate (floor permill)', () => {
    const facts = [
      fact({ action: 'call', outcome: 'paid' }),
      fact({ action: 'call', outcome: 'paid' }),
      fact({ action: 'call', outcome: 'no_response' }),
      fact({ action: 'sms', outcome: 'promise_made' }),
    ];
    const stats = actionEffectiveness(facts);
    expect(stats.map((s) => s.action)).toEqual(['call', 'sms']); // canonical NBA_ACTIONS order
    const call = stats[0]!;
    expect(call.total).toBe(3);
    expect(call.byOutcome).toEqual({ paid: 2, partial: 0, promise_made: 0, no_response: 1, escalated: 0, opted_out: 0 });
    expect(call.successCount).toBe(2); // paid + partial + promise_made
    expect(call.successRatePermill).toBe(666); // floor(2000/3)
    const sms = stats[1]!;
    expect(sms.total).toBe(1);
    expect(sms.successRatePermill).toBe(1000);
  });

  it('deterministically replays: same facts in → identical stats out (and input untouched)', () => {
    const facts = [fact({ outcome: 'partial' }), fact({ action: 'whatsapp', outcome: 'opted_out' })];
    const frozen = Object.freeze([...facts]);
    const a = actionEffectiveness(frozen);
    const b = actionEffectiveness(frozen);
    expect(a).toEqual(b);
    expect(frozen).toHaveLength(2);
  });

  it('only reports actions with at least one fact — no zero rows', () => {
    const stats = actionEffectiveness([fact({ action: 'escalate', outcome: 'escalated' })]);
    expect(stats.map((s) => s.action)).toEqual(['escalate']);
    expect(stats[0]!.byOutcome.escalated).toBe(1);
  });

  it('rejects a corrupted ledger instead of skewing stats (table)', () => {
    expectCode(() => actionEffectiveness([null as unknown as ActionOutcomeFact]), 'NBA_FACT_INVALID');
    expectCode(() => actionEffectiveness([fact({ action: 'letter' as 'call' })]), 'NBA_ACTION_INVALID');
    expectCode(() => actionEffectiveness([fact({ outcome: 'won' as 'paid' })]), 'NBA_OUTCOME_INVALID');
  });

  it('priorOutcomesOf projects facts into the feature-bundle shape (one source of truth)', () => {
    const facts = [fact({ action: 'sms', outcome: 'no_response' }), fact({ action: 'call', outcome: 'paid' })];
    const projected = priorOutcomesOf(facts);
    expect(projected).toEqual([
      { action: 'sms', outcome: 'no_response' },
      { action: 'call', outcome: 'paid' },
    ]);
    // and the projection is a valid bundle section end-to-end
    expect(() => rankNextBestActions(bundle({ priorOutcomes: projected }), { clock })).not.toThrow();
  });
});
