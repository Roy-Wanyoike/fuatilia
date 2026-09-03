import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { INTELLIGENCE_EVENT_NAMES, type RecommendationOutcomeRecordedPayload } from './events';
import {
  OUTCOME_VERDICTS,
  RECOMMENDATION_OUTCOMES,
  feedbackEffectiveness,
  feedbackEffectivenessByCapability,
  recordRecommendationOutcome,
  type EffectivenessStats,
  type RecommendationFeedback,
  type RecommendationOutcome,
} from './feedback';
import {
  createRecommendation,
  type CreateRecommendationArgs,
  type RecommendationFact,
} from './recommendations';
import type { NextActionCapability } from './recommendations';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(931);
const CUSTOMER = uid(932);
const RECEIVABLE = uid(933);
const NOW = '2026-07-01T09:00:00.000Z';
const at = (iso: string = NOW): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

let recSeq = 0;
const recommendationArgs = (
  overrides: Partial<CreateRecommendationArgs> = {},
): CreateRecommendationArgs => {
  recSeq += 1;
  return {
    id: uid(940 + recSeq),
    orgId: ORG,
    receivableId: RECEIVABLE,
    customerId: CUSTOMER,
    capability: 'send_payment_link',
    score: 15,
    reasons: ['fresh delinquency with dunning consent on file — a payment link is the lowest-friction self-serve step'],
    ...overrides,
  };
};

const recommendation = (
  capability: NextActionCapability = 'send_payment_link',
  overrides: Partial<CreateRecommendationArgs> = {},
): RecommendationFact => createRecommendation(recommendationArgs({ capability, ...overrides }), at()).recommendation;

const record = (
  rec: RecommendationFact,
  outcome: RecommendationOutcome,
  existing: readonly RecommendationFeedback[] = [],
  args: Partial<Parameters<typeof recordRecommendationOutcome>[1]> = {},
  clock: Clock = at(),
): ReturnType<typeof recordRecommendationOutcome> =>
  recordRecommendationOutcome(rec, { outcome, ...args }, existing, clock);

// --- the outcome → verdict signal ---------------------------------------------

describe('OUTCOME_VERDICTS — the deterministic H7 signal', () => {
  it('maps every outcome to exactly one verdict (table)', () => {
    const table: Array<[RecommendationOutcome, string]> = [
      ['paid', 'effective'],
      ['partial', 'partially_effective'],
      ['promise_made', 'partially_effective'],
      ['escalated', 'ineffective'],
      ['no_response', 'ineffective'],
    ];
    expect(RECOMMENDATION_OUTCOMES).toEqual(table.map(([outcome]) => outcome));
    for (const [outcome, verdict] of table) {
      expect(OUTCOME_VERDICTS[outcome], `${outcome}`).toBe(verdict);
    }
  });
});

// --- the intake: append-only fact + typed events -------------------------------

describe('recordRecommendationOutcome — append-only intake (first record wins)', () => {
  it('appends ONE fact and emits exactly TWO events on a fresh key', () => {
    const rec = recommendation();
    const { feedback, events, replayed } = record(rec, 'paid');
    expect(replayed).toBe(false);
    expect(events.map((e) => e.name)).toEqual([
      'intelligence.recommendationOutcomeRecorded',
      'intelligence.feedbackRecorded',
    ]);
    expect(feedback.feedbackKey).toBe(`${rec.recommendationId}:paid`);
    expect(feedback).toEqual({
      feedbackKey: `${rec.recommendationId}:paid`,
      recommendationId: rec.recommendationId,
      orgId: ORG,
      receivableId: RECEIVABLE,
      customerId: CUSTOMER,
      capability: 'send_payment_link',
      outcome: 'paid',
      outcomeKey: 'paid',
      verdict: 'effective',
      details: null,
      occurredAt: NOW,
      recordedAt: NOW,
    });
  });

  it('events carry the repo envelope shape (v1, aggregate = recommendation, ISO occurredAt)', () => {
    const clock = at('2026-07-01T10:30:00.000Z');
    const rec = recommendation();
    const { events } = record(rec, 'partial', [], {}, clock);
    for (const event of events) {
      expect(event.version).toBe(1);
      expect(event.aggregateId).toBe(rec.recommendationId);
      expect(event.occurredAt).toBe('2026-07-01T10:30:00.000Z');
      expect(INTELLIGENCE_EVENT_NAMES).toContain(event.name);
      expect(JSON.parse(JSON.stringify(event))).toEqual(event); // narrow + serializable
    }
  });

  it('the intake event carries the raw outcome; the feedback event carries the derived verdict', () => {
    const rec = recommendation('offer_payment_plan');
    const { events } = record(rec, 'promise_made');
    const [recorded, feedback] = events;
    expect(recorded!.payload).toEqual({
      recommendationId: rec.recommendationId,
      orgId: ORG,
      receivableId: RECEIVABLE,
      outcome: 'promise_made',
      outcomeKey: 'promise_made',
      details: null,
      occurredAt: NOW,
      recordedAt: NOW,
    });
    expect(feedback!.payload).toEqual({
      recommendationId: rec.recommendationId,
      capability: 'offer_payment_plan',
      outcome: 'promise_made',
      verdict: 'partially_effective',
      feedbackKey: `${rec.recommendationId}:promise_made`,
      recordedAt: NOW,
    });
  });

  it('occurredAt defaults to the clock instant (recorded when observed)', () => {
    const { feedback } = record(recommendation(), 'paid');
    expect(feedback.occurredAt).toBe(feedback.recordedAt);
  });

  it('an explicit occurredAt travels (the real-world instant, e.g. a settlement date)', () => {
    const settledAt = new Date('2026-06-28T14:05:00.000Z');
    const { feedback, events } = record(recommendation(), 'paid', [], { occurredAt: settledAt });
    expect(feedback.occurredAt).toBe('2026-06-28T14:05:00.000Z');
    expect(feedback.recordedAt).toBe(NOW);
    expect(events[0]!.name).toBe('intelligence.recommendationOutcomeRecorded');
    expect((events[0]!.payload as RecommendationOutcomeRecordedPayload).occurredAt).toBe('2026-06-28T14:05:00.000Z');
  });

  it('occurredAt == recordedAt exactly is accepted (the observation boundary)', () => {
    const { feedback } = record(recommendation(), 'paid', [], { occurredAt: new Date(NOW) });
    expect(feedback.occurredAt).toBe(NOW);
  });

  it('details travel to the fact and the intake payload; absent means null', () => {
    const withDetails = record(recommendation(), 'paid', [], { details: 'M-Pesa settlement INV-2044' });
    expect(withDetails.feedback.details).toBe('M-Pesa settlement INV-2044');
    expect(
      (withDetails.events[0]!.payload as RecommendationOutcomeRecordedPayload).details,
    ).toBe('M-Pesa settlement INV-2044');
    const without = record(recommendation(), 'paid');
    expect(without.feedback.details).toBeNull();
  });

  it('a custom outcomeKey becomes the idempotency key (feedbackKey = id:key)', () => {
    const rec = recommendation();
    const { feedback } = record(rec, 'paid', [], { outcomeKey: 'settlement-88' });
    expect(feedback.feedbackKey).toBe(`${rec.recommendationId}:settlement-88`);
    expect(feedback.outcomeKey).toBe('settlement-88');
  });

  it('one recommendation accumulates history: a different outcomeKey is a NEW fact', () => {
    const rec = recommendation('prioritize_for_collector');
    const first = record(rec, 'promise_made', [], { outcomeKey: 'attempt-1' });
    const second = record(rec, 'paid', [first.feedback], { outcomeKey: 'attempt-2' });
    expect(second.replayed).toBe(false);
    expect(second.feedback.feedbackKey).toBe(`${rec.recommendationId}:attempt-2`);
    expect([first.feedback.feedbackKey, second.feedback.feedbackKey]).toHaveLength(2);
  });

  it('REPLAY: the same (recommendationId, outcomeKey) returns the ORIGINAL fact untouched', () => {
    const rec = recommendation();
    const first = record(rec, 'paid');
    const replay = record(rec, 'paid', [first.feedback], {}, at('2026-07-02T09:00:00.000Z'));
    expect(replay.replayed).toBe(true);
    expect(replay.feedback).toEqual(first.feedback); // the original fact, bit for bit
    expect(replay.feedback).not.toEqual({
      ...first.feedback,
      recordedAt: '2026-07-02T09:00:00.000Z',
    });
  });

  it('REPLAY emits exactly ONE duplicate tripwire event, nothing else', () => {
    const rec = recommendation();
    const first = record(rec, 'paid');
    const replay = record(rec, 'paid', [first.feedback], {}, at('2026-07-02T09:00:00.000Z'));
    expect(replay.events).toHaveLength(1);
    const [event] = replay.events;
    expect(event!.name).toBe('intelligence.duplicateOutcomeObserved');
    expect(event!.payload).toEqual({
      recommendationId: rec.recommendationId,
      outcomeKey: 'paid',
      outcome: 'paid',
      originalRecordedAt: NOW,
      observedAt: '2026-07-02T09:00:00.000Z',
    });
  });

  it('a replay is NOT appended — the caller knows nothing new is to be stored', () => {
    const rec = recommendation();
    const first = record(rec, 'no_response');
    const before = [first.feedback];
    const replay = record(rec, 'no_response', before);
    expect(replay.replayed).toBe(true);
    expect(replay.feedback).toBe(first.feedback); // same object identity — nothing was re-derived
  });

  it('same key replayed with a DIFFERENT outcome is tampering (INTEL_OUTCOME_CONFLICT)', () => {
    const rec = recommendation();
    const first = record(rec, 'paid', [], { outcomeKey: 'k1' });
    try {
      record(rec, 'no_response', [first.feedback], { outcomeKey: 'k1' });
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('INTEL_OUTCOME_CONFLICT');
      expect((error as DomainError).details).toMatchObject({
        feedbackKey: `${rec.recommendationId}:k1`,
        recordedOutcome: 'paid',
        attemptedOutcome: 'no_response',
      });
      return;
    }
    throw new Error('expected INTEL_OUTCOME_CONFLICT');
  });

  it('rejects malformed intake (table of stable codes)', () => {
    const rec = recommendation();
    const table: Array<[() => unknown, string]> = [
      [() => record(rec, 'settled' as RecommendationOutcome), 'INTEL_OUTCOME_INVALID'],
      [() => record(rec, 'paid', [], { outcomeKey: '   ' }), 'INTEL_OUTCOME_KEY_REQUIRED'],
      [() => record(rec, 'paid', [], { details: '' }), 'INTEL_DETAILS_INVALID'],
      [() => record(rec, 'paid', [], { details: '  ' }), 'INTEL_DETAILS_INVALID'],
      [
        () =>
          recordRecommendationOutcome(
            { ...rec, recommendationId: ' ' as unknown as Uuid },
            { outcome: 'paid' },
            [],
            at(),
          ),
        'INTEL_RECOMMENDATION_INVALID',
      ],
      [
        () =>
          recordRecommendationOutcome(
            { ...rec, receivableId: '' as unknown as Uuid },
            { outcome: 'paid' },
            [],
            at(),
          ),
        'INTEL_RECOMMENDATION_INVALID',
      ],
      [
        () => recordRecommendationOutcome({ ...rec, capability: 'send_email' as NextActionCapability }, { outcome: 'paid' }, [], at()),
        'INTEL_CAPABILITY_INVALID',
      ],
      [() => recordRecommendationOutcome(rec, { outcome: 'paid' }, [], { now: () => new Date('nope') }), 'INTEL_CLOCK_INVALID'],
      [() => record(rec, 'paid', [], { occurredAt: new Date('garbage') }), 'INTEL_OCCURRED_AT_INVALID'],
    ];
    for (const [fn, code] of table) {
      expectCode(fn, code);
    }
  });

  it('a future-dated occurredAt is refused (outcomes cannot precede their observation)', () => {
    expectCode(
      () => record(recommendation(), 'paid', [], { occurredAt: new Date('2026-07-01T09:00:00.001Z') }),
      'INTEL_OCCURRED_AT_INVALID',
    );
  });

  it('never mutates the recommendation fact or the existing feedback log (no-mutation pin)', () => {
    const rec = recommendation();
    const existing: readonly RecommendationFeedback[] = [record(recommendation(), 'paid').feedback];
    const beforeRec = JSON.stringify(rec);
    const beforeLog = JSON.stringify(existing);
    Object.freeze(rec);
    Object.freeze(existing);
    record(rec, 'partial', existing);
    record(rec, 'paid', existing); // even a replay must not touch anything
    expect(JSON.stringify(rec)).toBe(beforeRec);
    expect(JSON.stringify(existing)).toBe(beforeLog);
  });
});

// --- effectiveness stats ---------------------------------------------------------

describe('feedbackEffectiveness — pure stats over the feedback log', () => {
  // Synthetic history: 6 facts across two capabilities.
  const history = (): RecommendationFeedback[] => {
    const facts: RecommendationFeedback[] = [];
    const push = (capability: NextActionCapability, outcome: RecommendationOutcome, atIso: string): void => {
      const rec = recommendation(capability);
      facts.push(record(rec, outcome, [], {}, at(atIso)).feedback);
    };
    push('send_payment_link', 'paid', '2026-07-01T09:00:00.000Z');
    push('send_payment_link', 'paid', '2026-07-02T09:00:00.000Z');
    push('send_payment_link', 'no_response', '2026-07-03T09:00:00.000Z');
    push('offer_payment_plan', 'promise_made', '2026-07-04T09:00:00.000Z');
    push('offer_payment_plan', 'escalated', '2026-07-05T09:00:00.000Z');
    push('prioritize_for_collector', 'partial', '2026-07-06T09:00:00.000Z');
    return facts;
  };

  it('aggregates a synthetic history into counts and a plain ratio', () => {
    const stats = feedbackEffectiveness(history());
    expect(stats.capability).toBe('all');
    expect(stats.total).toBe(6);
    expect(stats.byOutcome).toEqual({ paid: 2, partial: 1, promise_made: 1, escalated: 1, no_response: 1 });
    expect(stats.byVerdict).toEqual({ effective: 2, partially_effective: 2, ineffective: 2 });
    expect(stats.effectivenessRate).toBeCloseTo(2 / 6);
  });

  it('an empty log scores 0 with zero-filled maps (no signal ≠ perfect score)', () => {
    const stats = feedbackEffectiveness([]);
    expect(stats.total).toBe(0);
    expect(stats.effectivenessRate).toBe(0);
    expect(stats.byOutcome).toEqual({ paid: 0, partial: 0, promise_made: 0, escalated: 0, no_response: 0 });
    expect(stats.byVerdict).toEqual({ effective: 0, partially_effective: 0, ineffective: 0 });
  });

  it('the capability filter restricts the population (and labels the row)', () => {
    const stats = feedbackEffectiveness(history(), { capability: 'send_payment_link' });
    expect(stats.capability).toBe('send_payment_link');
    expect(stats.total).toBe(3);
    expect(stats.byOutcome).toEqual({ paid: 2, partial: 0, promise_made: 0, escalated: 0, no_response: 1 });
    expect(stats.effectivenessRate).toBeCloseTo(2 / 3);
  });

  it('an unknown capability simply has no facts (total 0, never an error)', () => {
    const stats = feedbackEffectiveness(history(), { capability: 'human_review' });
    expect(stats.total).toBe(0);
    expect(stats.effectivenessRate).toBe(0);
  });

  it('asOf time-boxes the log: facts recorded after the instant are excluded (boundary inclusive)', () => {
    const facts = history();
    const atThird = new Date('2026-07-03T09:00:00.000Z');
    const stats = feedbackEffectiveness(facts, { asOf: atThird });
    expect(stats.total).toBe(3); // 07-01, 07-02, and 07-03 exactly
    expect(stats.byOutcome.paid).toBe(2);
    const statsBefore = feedbackEffectiveness(facts, { asOf: new Date('2026-07-02T23:59:59.999Z') });
    expect(statsBefore.total).toBe(2);
  });

  it('rejects a malformed asOf and a corrupt log (stable codes)', () => {
    expectCode(() => feedbackEffectiveness([], { asOf: new Date('nope') }), 'INTEL_CLOCK_INVALID');
    const corrupt = [{ ...history()[0]!, outcome: 'refunded' as RecommendationOutcome }];
    expectCode(() => feedbackEffectiveness(corrupt), 'INTEL_OUTCOME_INVALID');
  });

  it('is pure: stats never reorder, filter or mutate the log they read', () => {
    const facts = history();
    const before = JSON.stringify(facts);
    Object.freeze(facts);
    feedbackEffectiveness(facts, { capability: 'send_payment_link' });
    feedbackEffectiveness(facts);
    expect(JSON.stringify(facts)).toBe(before);
  });
});

describe('feedbackEffectivenessByCapability — the per-capability breakdown', () => {
  it('returns one row per capability with facts, in canonical capability order', () => {
    const facts: RecommendationFeedback[] = [];
    const push = (capability: NextActionCapability, outcome: RecommendationOutcome): void => {
      const rec = recommendation(capability);
      facts.push(record(rec, outcome, [], {}, at(`2026-07-0${facts.length + 1}T09:00:00.000Z`)).feedback);
    };
    push('offer_payment_plan', 'paid');
    push('send_payment_link', 'no_response');
    push('offer_payment_plan', 'partial');
    push('prioritize_for_collector', 'paid');

    const rows = feedbackEffectivenessByCapability(facts);
    expect(rows.map((r) => r.capability)).toEqual([
      'prioritize_for_collector',
      'offer_payment_plan',
      'send_payment_link',
    ]);
    const plans = rows.find((r) => r.capability === 'offer_payment_plan') as EffectivenessStats;
    expect(plans.total).toBe(2);
    expect(plans.byVerdict).toEqual({ effective: 1, partially_effective: 1, ineffective: 0 });
  });

  it('skips capabilities without feedback — absent, never zero-filled guesses', () => {
    const rec = recommendation('human_review');
    const facts = [record(rec, 'escalated', [], { outcomeKey: 'case-9' }).feedback];
    const rows = feedbackEffectivenessByCapability(facts);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capability).toBe('human_review');
    expect(rows[0]!.effectivenessRate).toBe(0);
  });

  it('passes the asOf window through to every row', () => {
    const rec = recommendation('send_payment_link');
    const early = record(rec, 'paid', [], { outcomeKey: 'a' }, at('2026-07-01T09:00:00.000Z')).feedback;
    const late = record(recommendation('send_payment_link'), 'paid', [], { outcomeKey: 'b' }, at('2026-07-09T09:00:00.000Z')).feedback;
    const rows = feedbackEffectivenessByCapability([early, late], { asOf: new Date('2026-07-05T00:00:00.000Z') });
    const row = rows.find((r) => r.capability === 'send_payment_link') as EffectivenessStats;
    expect(row.total).toBe(1);
  });
});

// --- the H7 loop, end to end ------------------------------------------------------

describe('the H7 feedback loop closes end to end (recommend → record → aggregate)', () => {
  it('a recommendation that gets paid raises its capability effectiveness; silence lowers it', () => {
    const linkCreated = createRecommendation(recommendationArgs({ capability: 'send_payment_link' }), at());
    expect(linkCreated.recommendation.capability).toBe('send_payment_link');

    const paid = record(linkCreated.recommendation, 'paid', [], { outcomeKey: 's-1' });
    expect(paid.events.map((e) => e.name)).toEqual([
      'intelligence.recommendationOutcomeRecorded',
      'intelligence.feedbackRecorded',
    ]);

    const silent = recommendation('send_payment_link');
    const nothing = record(silent, 'no_response', [paid.feedback], { outcomeKey: 's-2' });

    const stats = feedbackEffectiveness([paid.feedback, nothing.feedback], {
      capability: 'send_payment_link',
    });
    expect(stats.total).toBe(2);
    expect(stats.effectivenessRate).toBeCloseTo(0.5);
  });

  it('every fact in the loop is replay-safe: a duplicate callback returns the original AND raises the tripwire', () => {
    const rec = recommendation('prioritize_for_collector');
    const log: RecommendationFeedback[] = [];
    const first = recordRecommendationOutcome(rec, { outcome: 'promise_made', outcomeKey: 'attempt-1' }, log, at());
    log.push(first.feedback); // the caller appends the fresh fact
    const replay = recordRecommendationOutcome(
      rec,
      { outcome: 'promise_made', outcomeKey: 'attempt-1' },
      log,
      at('2026-07-03T00:00:00.000Z'),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.feedback).toEqual(first.feedback);
    expect(replay.events.map((e) => e.name)).toEqual(['intelligence.duplicateOutcomeObserved']);
    // a replay appends NOTHING — the caller's log is unchanged, the stats are unmoved
    expect(log).toHaveLength(1);
    expect(feedbackEffectiveness(log).total).toBe(1);
    expect(feedbackEffectiveness(log).byOutcome).toEqual({
      paid: 0,
      partial: 0,
      promise_made: 1,
      escalated: 0,
      no_response: 0,
    });
  });
});
