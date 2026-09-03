import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  AGED_HUMAN_REVIEW_DAYS,
  LARGE_EXPOSURE_MIN_AGE_DAYS,
  LARGE_EXPOSURE_MINOR,
  NEXT_ACTION_CAPABILITIES,
  PAY_PLAN_MIN_AGE_DAYS,
  createRecommendation,
  recommendNextAction,
  recommendNextActions,
  type CreateRecommendationArgs,
  type NextActionRecommendation,
  type RecommendationFact,
} from './recommendations';
import { UNRELIABLE_PROMISER_THRESHOLD_PCT, type CustomerFacts, type ReceivableFacts } from './scoring';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(911);
const CUSTOMER = uid(912);
const NOW = '2026-06-15T00:00:00.000Z';
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

const facts = (overrides: Partial<ReceivableFacts> = {}): ReceivableFacts => ({
  receivableId: uid(913),
  orgId: ORG,
  customerId: CUSTOMER,
  amountMinor: 500_000,
  currency: 'KES',
  status: 'open',
  agingBucket: '31-60',
  ageDays: 45,
  disputed: false,
  ...overrides,
});

const rel = (pct: number): CustomerFacts => ({ customerId: CUSTOMER, promiseReliabilityPct: pct });

// --- the selection matrix ----------------------------------------------------------------

describe('recommendNextAction — the published matrix (first match wins)', () => {
  it('fires every rule with its stable name (table over the 10 matrix rows)', () => {
    const table: Array<[ReceivableFacts, CustomerFacts | undefined, NextActionRecommendation['capability'], string]> = [
      // 1 — history is not work
      [facts({ status: 'settled' }), undefined, 'do_nothing_yet', 'not_collectible'],
      // 2 — SPEC §29 dispute pause
      [facts({ agingBucket: '0-30', ageDays: 10, disputed: true }), undefined, 'human_review', 'dispute_pause'],
      // 3 — live promise: hold pressure
      [facts({ promiseState: 'pending' }), undefined, 'do_nothing_yet', 'live_promise'],
      // 4 — broken promise: the E27 boost
      [facts({ promiseState: 'broken' }), undefined, 'prioritize_for_collector', 'broken_promise'],
      // 5 — aged + worked + silent → human judgment
      [
        facts({
          agingBucket: '90+',
          ageDays: AGED_HUMAN_REVIEW_DAYS + 5,
          priorActionCounts: { total: 3, withResponse: 0 },
        }),
        undefined,
        'human_review',
        'aged_unresponsive',
      ],
      // 6 — large + aged → a dedicated collector
      [
        facts({
          agingBucket: '61-90',
          ageDays: LARGE_EXPOSURE_MIN_AGE_DAYS + 10,
          amountMinor: LARGE_EXPOSURE_MINOR + 1,
          priorActionCounts: { total: 2, withResponse: 1 },
        }),
        undefined,
        'prioritize_for_collector',
        'large_aged_exposure',
      ],
      // 7 — aged promise-breaker: no another structured commitment
      [facts(), rel(UNRELIABLE_PROMISER_THRESHOLD_PCT - 10), 'prioritize_for_collector', 'unreliable_promiser'],
      // 8 — aged, reliable enough → restructure
      [facts(), rel(UNRELIABLE_PROMISER_THRESHOLD_PCT + 10), 'offer_payment_plan', 'aged_needs_structure'],
      // 9 — fresh + consented → self-serve link
      [
        facts({ agingBucket: '0-30', ageDays: 10, consentPresent: true }),
        undefined,
        'send_payment_link',
        'consented_self_serve',
      ],
      // 10 — fresh, no consent (K2) → human follow-up
      [
        facts({ agingBucket: '0-30', ageDays: 10, consentPresent: false }),
        undefined,
        'prioritize_for_collector',
        'no_consent_manual_follow_up',
      ],
    ];
    for (const [fact, customer, capability, rule] of table) {
      const recommendation = recommendNextAction(fact, customer);
      expect(
        { capability: recommendation.capability, rule: recommendation.rule },
        `${fact.receivableId} → expected ${rule}`,
      ).toEqual({ capability, rule });
      expect(recommendation.receivableId).toBe(fact.receivableId);
      expect(recommendation.reasons.length).toBeGreaterThan(0);
      for (const reason of recommendation.reasons) expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('pay-plan thresholds hold exactly at the boundary (≥ PAY_PLAN_MIN_AGE_DAYS)', () => {
    expect(
      recommendNextAction(facts({ ageDays: PAY_PLAN_MIN_AGE_DAYS - 1, agingBucket: '0-30' })).rule,
    ).toBe('no_consent_manual_follow_up');
    expect(recommendNextAction(facts({ ageDays: PAY_PLAN_MIN_AGE_DAYS, agingBucket: '0-30' })).capability).toBe(
      'offer_payment_plan',
    );
  });

  it('precedence: an open dispute outranks a live promise (rule 2 before rule 3)', () => {
    const recommendation = recommendNextAction(facts({ disputed: true, promiseState: 'pending' }));
    expect(recommendation.rule).toBe('dispute_pause');
  });

  it('precedence: a broken promise outranks aged-unresponsive and large-aged rules (rule 4 first)', () => {
    const recommendation = recommendNextAction(
      facts({
        promiseState: 'broken',
        agingBucket: '90+',
        ageDays: 120,
        priorActionCounts: { total: 5, withResponse: 0 },
        amountMinor: LARGE_EXPOSURE_MINOR * 2,
      }),
    );
    expect(recommendation.rule).toBe('broken_promise');
  });

  it('precedence: a live promise outranks aged-unresponsive (rule 3 before rule 5)', () => {
    const recommendation = recommendNextAction(
      facts({
        promiseState: 'pending',
        agingBucket: '90+',
        ageDays: 120,
        priorActionCounts: { total: 5, withResponse: 0 },
      }),
    );
    expect(recommendation.rule).toBe('live_promise');
  });

  it('an unreliable promiser does not get another plan even when consented and mid-aged', () => {
    const recommendation = recommendNextAction(facts({ consentPresent: true }), rel(20));
    expect(recommendation.rule).toBe('unreliable_promiser');
  });

  it('do_nothing_yet is representable and carries its evidence (the deliberate no-op)', () => {
    for (const noOp of [
      recommendNextAction(facts({ status: 'written_off' })),
      recommendNextAction(facts({ promiseState: 'pending' })),
    ]) {
      expect(noOp.capability).toBe('do_nothing_yet');
      expect(noOp.reasons.length).toBeGreaterThan(0);
    }
  });

  it('validates the projection before recommending (corrupt facts never recommend)', () => {
    expectCode(() => recommendNextAction(facts({ agingBucket: '90+', ageDays: 5 })), 'INTEL_FACTS_INVALID');
    expectCode(
      () => recommendNextAction(facts(), { customerId: CUSTOMER, promiseReliabilityPct: 150 }),
      'INTEL_CUSTOMER_FACTS_INVALID',
    );
  });

  it('recommendNextActions maps a batch in order and refuses duplicate customer facts', () => {
    const batch = [facts({ receivableId: uid(1), promiseState: 'broken' }), facts({ receivableId: uid(2), disputed: true })];
    const recommendations = recommendNextActions(batch, [rel(80)]);
    expect(recommendations.map((r) => [r.receivableId, r.rule])).toEqual([
      [uid(1), 'broken_promise'],
      [uid(2), 'dispute_pause'],
    ]);
    expectCode(
      () => recommendNextActions(batch, [rel(80), rel(20)]),
      'INTEL_CUSTOMER_FACTS_DUPLICATE',
    );
  });

  it('never mutates the input facts (no-mutation pin)', () => {
    const batch: readonly ReceivableFacts[] = [facts({ promiseState: 'broken' }), facts({ disputed: true })];
    const before = JSON.stringify(batch);
    Object.freeze(batch);
    recommendNextActions(batch, [rel(15)]);
    expect(JSON.stringify(batch)).toBe(before);
  });
});

// --- the recommendation FACT ----------------------------------------------------------------

describe('createRecommendation — the append-only fact + intelligence.recommendationCreated', () => {
  const args = (overrides: Partial<CreateRecommendationArgs> = {}): CreateRecommendationArgs => ({
    id: uid(920),
    orgId: ORG,
    receivableId: uid(913),
    customerId: CUSTOMER,
    capability: 'prioritize_for_collector',
    score: 80,
    reasons: ['aging bucket 90+ (120 days past due)', 'exposure 25000000 minor (200k+_minor)'],
    ...overrides,
  });

  it('records the fact with the derived band and emits a narrow, serializable event', () => {
    const { recommendation, events } = createRecommendation(args(), at('2026-06-15T10:00:00.000Z'));
    expect(recommendation).toEqual({
      recommendationId: uid(920),
      orgId: ORG,
      receivableId: uid(913),
      customerId: CUSTOMER,
      capability: 'prioritize_for_collector',
      score: 80,
      band: 'critical',
      reasons: ['aging bucket 90+ (120 days past due)', 'exposure 25000000 minor (200k+_minor)'],
      createdAt: new Date('2026-06-15T10:00:00.000Z'),
    });
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.name).toBe('intelligence.recommendationCreated');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(uid(920));
    expect(event.occurredAt).toBe('2026-06-15T10:00:00.000Z');
    expect(event.payload).toEqual({
      recommendationId: uid(920),
      orgId: ORG,
      receivableId: uid(913),
      customerId: CUSTOMER,
      capability: 'prioritize_for_collector',
      score: 80,
      band: 'critical',
      reasons: ['aging bucket 90+ (120 days past due)', 'exposure 25000000 minor (200k+_minor)'],
      createdAt: '2026-06-15T10:00:00.000Z',
    });
    expect(JSON.parse(JSON.stringify(event))).toEqual(event); // serializable
  });

  it('derives the band from the score with the same thresholds as scoring', () => {
    for (const [score, band] of [
      [-75, 'low'],
      [30, 'medium'],
      [45, 'high'],
      [95, 'critical'],
    ] as const) {
      expect(createRecommendation(args({ score }), at()).recommendation.band).toBe(band);
    }
  });

  it('rejects invalid recommendations (table)', () => {
    const table: Array<[Partial<CreateRecommendationArgs>, string]> = [
      [{ id: '  ' as unknown as Uuid }, 'blank id'],
      [{ orgId: '' as unknown as Uuid }, 'blank orgId'],
      [{ receivableId: undefined as unknown as Uuid }, 'missing receivableId'],
      [{ customerId: '' as unknown as Uuid }, 'blank customerId'],
      [{ capability: 'call_customer' }, 'unknown capability'],
      [{ capability: '' }, 'empty capability'],
      [{ score: 1.5 }, 'fractional score'],
      [{ score: Number.NaN }, 'NaN score'],
      [{ reasons: [] }, 'no reasons'],
      [{ reasons: [''] }, 'blank reason'],
      [{ reasons: ['ok', '   '] }, 'whitespace reason'],
    ];
    for (const [overrides, label] of table) {
      try {
        createRecommendation(args(overrides), at());
      } catch (error) {
        expect(error, label).toBeInstanceOf(DomainError);
        const code = (error as DomainError).code;
        expect(
          ['INTEL_RECOMMENDATION_INVALID', 'INTEL_CAPABILITY_INVALID', 'INTEL_SCORE_INVALID', 'INTEL_REASONS_REQUIRED'],
          label,
        ).toContain(code);
        continue;
      }
      throw new Error(`expected a DomainError for: ${label}`);
    }
  });

  it('rejects a broken clock (INTEL_CLOCK_INVALID)', () => {
    expectCode(() => createRecommendation(args(), { now: () => new Date('nope') }), 'INTEL_CLOCK_INVALID');
  });

  it('knows its capability taxonomy (used by F22/F20 downstream, never imported by them)', () => {
    expect(NEXT_ACTION_CAPABILITIES).toEqual([
      'prioritize_for_collector',
      'offer_payment_plan',
      'send_payment_link',
      'human_review',
      'do_nothing_yet',
    ]);
  });

  it('the fact type is opaque-safe: ids travel as plain Uuids, no lane types attached', () => {
    const { recommendation }: { recommendation: RecommendationFact } = createRecommendation(args(), at());
    expect(Object.keys(recommendation).sort()).toEqual([
      'band',
      'capability',
      'createdAt',
      'customerId',
      'orgId',
      'reasons',
      'receivableId',
      'recommendationId',
      'score',
    ]);
  });
});
