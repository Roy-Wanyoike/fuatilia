import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { DAY_MS, type BehaviorFacts, type DisputeFact, type PaymentFact, type PromiseFact } from './profile';
import {
  BEHAVIOR_ANOMALY_RULES,
  DEFAULT_ANOMALY_THRESHOLDS,
  detectAnomalies,
  severityRank,
  type BehaviorAnomaly,
} from './anomaly';

// --- fixtures ---------------------------------------------------------------
//
// Fixed clock at 2026-04-01T00:00:00Z. The default cadence/partial/dispute
// windows span (2026-01-01, 2026-04-01] — "recent" facts settle inside it,
// "baseline" facts settle on/before 2026-01-01T00:00:00Z (the window start,
// inclusive on the baseline side).

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const CUSTOMER = uid(2);
const RECEIVABLE = uid(3);

const CLOCK_ISO = '2026-04-01T00:00:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };
const WINDOW_START = '2026-01-01T00:00:00.000Z';

const DAY = DAY_MS;
const NOON = 12 * 3600_000;
let seq = 0;

/**
 * A payment settled at noon UTC of `settledDate`, `daysLate` whole UTC days
 * after its (midnight-UTC) due date.
 */
const pay = (settledDate: string, daysLate: number, partial = false): PaymentFact => {
  const settledMs = Date.parse(`${settledDate}T12:00:00.000Z`);
  return {
    paymentId: uid(100 + ++seq),
    receivableId: RECEIVABLE,
    amountMinor: 100_000,
    dueDate: new Date(settledMs - daysLate * DAY - NOON).toISOString(),
    settledAt: new Date(settledMs).toISOString(),
    partial,
  };
};

const promise = (outcome: PromiseFact['outcome'], resolvedAt: string | null, promisedDate = '2026-01-20T00:00:00.000Z'): PromiseFact => ({
  promiseId: uid(200 + ++seq),
  receivableId: RECEIVABLE,
  promisedDate,
  outcome,
  resolvedAt,
});

const dispute = (openedAt: string): DisputeFact => ({
  disputeId: uid(300 + ++seq),
  receivableId: RECEIVABLE,
  openedAt,
  resolvedAt: null,
});

const detect = (facts: BehaviorFacts, options?: Parameters<typeof detectAnomalies>[4]): readonly BehaviorAnomaly[] =>
  detectAnomalies(ORG, CUSTOMER, facts, clock, options);

const ofType = (anomalies: readonly BehaviorAnomaly[], type: string): readonly BehaviorAnomaly[] =>
  anomalies.filter((a) => a.type === type);

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

// --- detector 1: cadence deterioration ----------------------------------------

describe('anomaly cadence_deterioration (recent-window median vs baseline)', () => {
  const baseline = [pay('2025-12-10', 2), pay('2025-12-20', 4)]; // median 3

  it('fires (low) when the recent median rises ≥ trigger but < medium', () => {
    const anomalies = detect({ payments: [...baseline, pay('2026-02-01', 8), pay('2026-02-10', 10)] }); // median 9 → Δ 6
    const hits = ofType(anomalies, 'cadence_deterioration');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: BEHAVIOR_ANOMALY_RULES.cadence_deterioration,
      severity: 'low',
      measured: { baselineMedianDays: 3, recentMedianDays: 9, deltaDays: 6, baselineCount: 2, recentCount: 2 },
      detectedAt: CLOCK_ISO,
    });
    expect(hits[0]!.evidence.map((e) => e.kind)).toEqual(['payment', 'payment', 'payment', 'payment']);
    expect(hits[0]!.explanation).toMatch(/rose from 3 .* to 9/i);
  });

  it('severity ladder: Δ 8 → medium, Δ 16 → high', () => {
    const medium = ofType(detect({ payments: [...baseline, pay('2026-02-01', 10), pay('2026-02-10', 12)] }), 'cadence_deterioration'); // Δ 8
    expect(medium[0]!.severity).toBe('medium');
    const high = ofType(detect({ payments: [...baseline, pay('2026-02-01', 18), pay('2026-02-10', 20)] }), 'cadence_deterioration'); // Δ 16
    expect(high[0]!.severity).toBe('high');
  });

  it('no-fire below the trigger; fires at exactly the trigger', () => {
    const below = detect({ payments: [...baseline, pay('2026-02-01', 4), pay('2026-02-10', 6)] }); // Δ 2 < 3
    expect(ofType(below, 'cadence_deterioration')).toHaveLength(0);
    const at = detect({ payments: [...baseline, pay('2026-02-01', 5), pay('2026-02-10', 7)] }); // median 6 → Δ 3
    expect(ofType(at, 'cadence_deterioration')[0]!.measured.deltaDays).toBe(3);
  });

  it('needs both a trustworthy baseline (≥2) and recent sample (≥2)', () => {
    expect(ofType(detect({ payments: [pay('2025-12-10', 2), pay('2026-02-01', 10), pay('2026-02-10', 12)] }), 'cadence_deterioration')).toHaveLength(0);
    expect(ofType(detect({ payments: [...baseline, pay('2026-02-10', 12)] }), 'cadence_deterioration')).toHaveLength(0);
  });

  it('window edges: settled exactly at the window start is BASELINE; exactly at asOf is recent', () => {
    const settledAtWindowStart: PaymentFact = { ...pay('2026-01-01', 2), settledAt: WINDOW_START, dueDate: '2025-12-31T00:00:00.000Z' };
    const settledAtAsOf: PaymentFact = { ...pay('2026-04-01', 10), settledAt: CLOCK_ISO }; // due 2026-03-22, gap 10
    const anomalies = detect({
      payments: [settledAtWindowStart, pay('2025-12-20', 4), pay('2026-02-01', 10), pay('2026-02-10', 12), settledAtAsOf],
    });
    const hit = ofType(anomalies, 'cadence_deterioration');
    // baseline [gap 1 @window-start, gap 4] → median 2.5; recent [10, 12, 10] → median 10
    expect(hit[0]!.measured).toMatchObject({ baselineCount: 2, recentCount: 3, baselineMedianDays: 2.5, recentMedianDays: 10 });
  });

  it('custom thresholds widen the trigger', () => {
    const facts: BehaviorFacts = { payments: [...baseline, pay('2026-02-01', 8), pay('2026-02-10', 10)] }; // Δ 6
    expect(ofType(detect(facts, { thresholds: { cadenceTriggerDays: 7, cadenceMediumDays: 8 } }), 'cadence_deterioration')).toHaveLength(0);
    expect(ofType(detect(facts, { thresholds: { cadenceTriggerDays: 6 } }), 'cadence_deterioration')).toHaveLength(1);
  });

  it('evidence refs cover the baseline AND recent payment ids', () => {
    const facts: BehaviorFacts = { payments: [...baseline, pay('2026-02-01', 8), pay('2026-02-10', 10)] };
    const hit = ofType(detect(facts), 'cadence_deterioration')[0]!;
    expect(hit.evidence.map((e) => e.id)).toEqual(facts.payments!.map((p) => p.paymentId));
    expect(hit.thresholds).toMatchObject({ cadenceWindowDays: 90, cadenceTriggerDays: 3, cadenceMediumDays: 7, cadenceHighDays: 15 });
  });
});

// --- detector 2: promise break after streak ------------------------------------

describe('anomaly promise_break_after_streak (first break after a kept run)', () => {
  it('fires (medium) when the LAST decided promise is broken after ≥ minStreak keeps', () => {
    // input order deliberately shuffled — decisions order by resolvedAt
    const broken = promise('broken', '2026-03-05T00:00:00.000Z');
    const anomalies = detect({
      promises: [broken, promise('kept', '2026-01-25T00:00:00.000Z'), promise('kept', '2026-02-20T00:00:00.000Z')],
    });
    const hits = ofType(anomalies, 'promise_break_after_streak');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ severity: 'medium', measured: { streakKept: 2 }, detectedAt: CLOCK_ISO });
    expect(hits[0]!.evidence).toHaveLength(3); // the broken promise first, then the kept run
    expect(hits[0]!.evidence[0]).toEqual({ kind: 'promise', id: broken.promiseId });
    expect(hits[0]!.explanation).toMatch(/2 consecutive kept promises just broke one/);
  });

  it('severity high at promiseStreakHigh keeps (default 5)', () => {
    const kepts = Array.from({ length: 5 }, (_, i) => promise('kept', new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * DAY).toISOString()));
    const high = ofType(detect({ promises: [...kepts, promise('broken', '2026-03-01T00:00:00.000Z')] }), 'promise_break_after_streak');
    expect(high[0]!.severity).toBe('high');
    const four = Array.from({ length: 4 }, (_, i) => promise('kept', new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * DAY).toISOString()));
    const medium = ofType(detect({ promises: [...four, promise('broken', '2026-03-01T00:00:00.000Z')] }), 'promise_break_after_streak');
    expect(medium[0]!.severity).toBe('medium');
  });

  it('no-fire: streak below the minimum, last decided kept, or expired promises breaking the run', () => {
    expect(ofType(detect({ promises: [promise('kept', '2026-02-01T00:00:00.000Z'), promise('broken', '2026-03-01T00:00:00.000Z')] }), 'promise_break_after_streak')).toHaveLength(0);
    expect(ofType(detect({ promises: [promise('broken', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-03-01T00:00:00.000Z')] }), 'promise_break_after_streak')).toHaveLength(0);
    expect(
      ofType(
        detect({ promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-01-15T00:00:00.000Z'), promise('expired', '2026-02-01T00:00:00.000Z'), promise('broken', '2026-03-01T00:00:00.000Z')] }),
        'promise_break_after_streak',
      ),
    ).toHaveLength(0);
  });

  it('point-in-time: a break resolved AFTER asOf is invisible (the earlier kept promise stays last)', () => {
    const anomalies = detect({
      promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-01-15T00:00:00.000Z'), promise('broken', '2026-06-01T00:00:00.000Z')],
    });
    expect(ofType(anomalies, 'promise_break_after_streak')).toHaveLength(0);
  });

  it('pending promises never count as decided (no crash, no claim)', () => {
    const anomalies = detect({
      promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-01-15T00:00:00.000Z'), promise('pending', null, '2026-03-20T00:00:00.000Z'), promise('broken', '2026-02-01T00:00:00.000Z')],
    });
    const hit = ofType(anomalies, 'promise_break_after_streak');
    expect(hit[0]!.measured.streakKept).toBe(2);
  });

  it('custom minStreak raises the bar', () => {
    const facts: BehaviorFacts = { promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-01-15T00:00:00.000Z'), promise('broken', '2026-02-01T00:00:00.000Z')] };
    expect(ofType(detect(facts, { thresholds: { promiseMinStreak: 3 } }), 'promise_break_after_streak')).toHaveLength(0);
    expect(ofType(detect(facts, { thresholds: { promiseMinStreak: 2 } }), 'promise_break_after_streak')).toHaveLength(1);
  });
});

// --- detector 3: partial-payment pattern ---------------------------------------

describe('anomaly partial_payment_pattern (partial share jump vs baseline)', () => {
  /** baseline: 3 full payments (rate 0), recent: given partiality, all late 1 day. */
  const factsWith = (recent: boolean[]): BehaviorFacts => ({
    payments: [
      pay('2025-12-10', 1),
      pay('2025-12-15', 1),
      pay('2025-12-20', 1),
      ...recent.map((p, i) => pay(`2026-02-${String(10 + i).padStart(2, '0')}`, 1, p)),
    ],
  });

  it('fires when the recent share is 1 (medium severity) and the jump ≥ rateIncrease', () => {
    const hits = ofType(detect(factsWith([true, true, true])), 'partial_payment_pattern');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: BEHAVIOR_ANOMALY_RULES.partial_payment_pattern,
      severity: 'medium',
      measured: { baselinePartialRate: 0, recentPartialRate: 1, rateIncrease: 1, baselineCount: 3, recentCount: 3 },
    });
    expect(hits[0]!.explanation).toMatch(/partial-payment pattern/i);
    expect(hits[0]!.evidence.every((e) => e.kind === 'payment')).toBe(true);
  });

  it('low severity when the recent share is high but not total', () => {
    const hits = ofType(detect(factsWith([true, true, false])), 'partial_payment_pattern'); // 2/3 ≥ 0.5, increase 2/3 ≥ 0.5
    expect(hits[0]!.severity).toBe('low');
    expect(hits[0]!.measured).toMatchObject({ recentPartialRate: 0.6667 }); // rates travel 4dp-rounded
  });

  it('no-fire when the recent share is below partialMinRate', () => {
    expect(ofType(detect(factsWith([true, false, false])), 'partial_payment_pattern')).toHaveLength(0); // 1/3 < 0.5
  });

  it('no-fire when the jump is below partialRateIncrease even with a high share', () => {
    const anomalies = detect({
      payments: [
        pay('2025-12-05', 1, true),
        pay('2025-12-10', 1),
        pay('2025-12-15', 1, true),
        pay('2025-12-20', 1), // baseline rate 0.5
        pay('2026-02-10', 1, true),
        pay('2026-02-11', 1, true),
        pay('2026-02-12', 1), // recent rate 2/3 → increase 1/6 < 0.5
      ],
    });
    expect(ofType(anomalies, 'partial_payment_pattern')).toHaveLength(0);
  });

  it('needs ≥ partialMinPayments on EACH side of the split', () => {
    const anomalies = detect({
      payments: [pay('2025-12-10', 1), pay('2025-12-15', 1), pay('2026-02-10', 1, true), pay('2026-02-11', 1, true)],
    });
    expect(ofType(anomalies, 'partial_payment_pattern')).toHaveLength(0); // recent 2 < 3
  });

  it('custom thresholds lower the bar', () => {
    const anomalies = detect(
      {
        payments: [
          pay('2025-12-05', 1, true),
          pay('2025-12-10', 1),
          pay('2025-12-15', 1, true),
          pay('2025-12-20', 1),
          pay('2026-02-10', 1, true),
          pay('2026-02-11', 1, true),
          pay('2026-02-12', 1),
        ],
      },
      { thresholds: { partialRateIncrease: 0.1, partialMinRate: 0.6 } },
    );
    expect(ofType(anomalies, 'partial_payment_pattern')).toHaveLength(1);
  });
});

// --- detector 4: silence after promise -----------------------------------------

describe('anomaly silence_after_promise (quiet past a live promised date)', () => {
  it('fires (high) when a pending promise is ≥ silenceHighDays past due with no inbound and no payment', () => {
    const hits = ofType(detect({ promises: [promise('pending', null, '2026-02-01T00:00:00.000Z')] }), 'silence_after_promise'); // 59 days past
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: BEHAVIOR_ANOMALY_RULES.silence_after_promise,
      severity: 'high',
      measured: { daysPast: 59, promisedDate: '2026-02-01T00:00:00.000Z' },
    });
    expect(hits[0]!.evidence).toEqual([{ kind: 'promise', id: expect.any(String) }]);
    expect(hits[0]!.explanation).toMatch(/quiet for 59 days/i);
  });

  it('severity ladder by days past: 4 → low, 12 → medium, 30 → high', () => {
    const low = ofType(detect({ promises: [promise('pending', null, '2026-03-28T00:00:00.000Z')] }), 'silence_after_promise');
    expect(low[0]!.measured.daysPast).toBe(4);
    expect(low[0]!.severity).toBe('low');
    const medium = ofType(detect({ promises: [promise('pending', null, '2026-03-20T00:00:00.000Z')] }), 'silence_after_promise');
    expect(medium[0]!.severity).toBe('medium');
    const high = ofType(detect({ promises: [promise('pending', null, '2026-03-02T00:00:00.000Z')] }), 'silence_after_promise');
    expect(high[0]!.measured.daysPast).toBe(30);
    expect(high[0]!.severity).toBe('high');
  });

  it('day-boundary: fires at exactly grace days, silent one day earlier', () => {
    expect(ofType(detect({ promises: [promise('pending', null, '2026-03-29T00:00:00.000Z')] }), 'silence_after_promise')).toHaveLength(1); // 3 days
    expect(ofType(detect({ promises: [promise('pending', null, '2026-03-30T00:00:00.000Z')] }), 'silence_after_promise')).toHaveLength(0); // 2 days
  });

  it('no-fire when the customer answered (inbound after the promise)', () => {
    const anomalies = detect({
      promises: [promise('pending', null, '2026-02-01T00:00:00.000Z')],
      communications: [{ messageId: uid(400), channel: 'whatsapp', direction: 'inbound', sentAt: '2026-03-15T00:00:00.000Z' }],
    });
    expect(ofType(anomalies, 'silence_after_promise')).toHaveLength(0);
  });

  it('no-fire when a payment settled after the promise — but pre-promise messages/payments keep it silent', () => {
    const paid = detect({
      promises: [promise('pending', null, '2026-02-01T00:00:00.000Z')],
      payments: [pay('2026-03-10', 1)],
    });
    expect(ofType(paid, 'silence_after_promise')).toHaveLength(0);

    const onlyOldSignals = detect({
      promises: [promise('pending', null, '2026-02-01T00:00:00.000Z')],
      communications: [{ messageId: uid(401), channel: 'sms', direction: 'inbound', sentAt: '2026-01-15T00:00:00.000Z' }],
      payments: [pay('2026-01-20', 1)],
    });
    expect(ofType(onlyOldSignals, 'silence_after_promise')).toHaveLength(1);
  });

  it('one anomaly per silent promise, ordered by promisedDate then promiseId', () => {
    const early = promise('pending', null, '2026-02-01T00:00:00.000Z');
    const late = promise('pending', null, '2026-02-10T00:00:00.000Z');
    const hits = ofType(detect({ promises: [late, early] }), 'silence_after_promise');
    expect(hits.map((a) => a.measured.promisedDate)).toEqual(['2026-02-01T00:00:00.000Z', '2026-02-10T00:00:00.000Z']);
  });

  it('decided promises are never "silent" — only pending ones can go quiet', () => {
    const anomalies = detect({ promises: [promise('kept', '2026-01-25T00:00:00.000Z', '2026-01-20T00:00:00.000Z')] });
    expect(ofType(anomalies, 'silence_after_promise')).toHaveLength(0);
  });
});

// --- detector 5: dispute spike ---------------------------------------------------

describe('anomaly dispute_spike (disputes opened inside the window)', () => {
  it('fires (medium) at disputeSpikeMin, high at disputeSpikeHigh', () => {
    const medium = ofType(detect({ disputes: [dispute('2026-02-01T00:00:00.000Z'), dispute('2026-02-05T00:00:00.000Z')] }), 'dispute_spike');
    expect(medium[0]).toMatchObject({ severity: 'medium', measured: { windowDisputeCount: 2, windowDays: 90 } });
    expect(medium[0]!.evidence.map((e) => e.kind)).toEqual(['dispute', 'dispute']);
    const high = ofType(
      detect({ disputes: [dispute('2026-02-01T00:00:00.000Z'), dispute('2026-02-05T00:00:00.000Z'), dispute('2026-02-09T00:00:00.000Z')] }),
      'dispute_spike',
    );
    expect(high[0]!.severity).toBe('high');
  });

  it('no-fire below the minimum and for disputes outside the window', () => {
    expect(ofType(detect({ disputes: [dispute('2026-02-01T00:00:00.000Z')] }), 'dispute_spike')).toHaveLength(0);
    // both opened long before the window (window start 2026-01-01T00:00:00Z)
    expect(
      ofType(detect({ disputes: [dispute('2025-11-01T00:00:00.000Z'), dispute('2025-12-01T00:00:00.000Z')] }), 'dispute_spike'),
    ).toHaveLength(0);
  });

  it('window edge: opened exactly AT the window start is excluded (strict >), 1ms inside counts', () => {
    const atEdge = detect({ disputes: [dispute(WINDOW_START), dispute('2026-02-05T00:00:00.000Z')] });
    expect(ofType(atEdge, 'dispute_spike')).toHaveLength(0);
    const justInside = detect({ disputes: [dispute('2026-01-01T00:00:00.001Z'), dispute('2026-02-05T00:00:00.000Z')] });
    expect(ofType(justInside, 'dispute_spike')).toHaveLength(1);
  });

  it('disputes opened after asOf are invisible', () => {
    const anomalies = detect({ disputes: [dispute('2026-05-01T00:00:00.000Z'), dispute('2026-05-02T00:00:00.000Z')] });
    expect(ofType(anomalies, 'dispute_spike')).toHaveLength(0);
  });
});

// --- cross-cutting: order, clock, determinism, immutability, validation ----------

describe('detectAnomalies — cross-cutting contract', () => {
  it('fixed emission order when every detector fires (silence ordered inside its slot)', () => {
    const anomalies = detect({
      payments: [pay('2025-12-10', 2), pay('2025-12-15', 3), pay('2025-12-20', 4), pay('2026-02-01', 8, true), pay('2026-02-05', 8, true), pay('2026-02-10', 10, true)],
      promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('kept', '2026-01-15T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z'), promise('pending', null, '2026-02-20T00:00:00.000Z')],
      disputes: [dispute('2026-02-01T00:00:00.000Z'), dispute('2026-02-05T00:00:00.000Z')],
    });
    expect(anomalies.map((a) => a.type)).toEqual([
      'cadence_deterioration',
      'promise_break_after_streak',
      'partial_payment_pattern',
      'silence_after_promise',
      'dispute_spike',
    ]);
  });

  it('empty history ⇒ zero anomalies (a claim-less customer is not suspicious)', () => {
    expect(detect({})).toEqual([]);
  });

  it('detectedAt comes from the injected Clock; options.asOf only moves the analysis window', () => {
    const juneClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
    const facts: BehaviorFacts = { payments: [pay('2026-05-15', 30), pay('2026-05-20', 30), pay('2025-11-10', 2), pay('2025-11-20', 4)] };
    // analysis pinned to April via options.asOf → the May payments are future facts
    const pinned = detectAnomalies(ORG, CUSTOMER, facts, juneClock, { asOf: new Date(CLOCK_ISO) });
    expect(ofType(pinned, 'cadence_deterioration')).toHaveLength(0);
    expect(pinned).toEqual([]);
    // default (clock instant) → the May payments are recent history
    const byClock = detectAnomalies(ORG, CUSTOMER, facts, juneClock);
    const hit = ofType(byClock, 'cadence_deterioration');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.detectedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('deterministic: identical inputs produce deeply-identical anomaly lists', () => {
    const facts: BehaviorFacts = {
      payments: [pay('2025-12-10', 2), pay('2025-12-20', 4), pay('2026-02-01', 9), pay('2026-02-10', 11)],
      disputes: [dispute('2026-02-01T00:00:00.000Z'), dispute('2026-02-05T00:00:00.000Z')],
    };
    expect(detect(facts)).toEqual(detect(facts));
    expect(JSON.stringify(detect(facts))).toBe(JSON.stringify(detect(facts)));
  });

  it('no-mutation pin: the fact bundle is left untouched; output records are frozen', () => {
    const facts: BehaviorFacts = {
      payments: [pay('2025-12-10', 2), pay('2025-12-20', 4), pay('2026-02-01', 9), pay('2026-02-10', 11)],
      promises: [promise('kept', '2026-01-05T00:00:00.000Z'), promise('broken', '2026-02-05T00:00:00.000Z')],
      disputes: [dispute('2026-02-01T00:00:00.000Z'), dispute('2026-02-05T00:00:00.000Z')],
    };
    const snapshot = JSON.parse(JSON.stringify(facts));
    const anomalies = detect(facts);
    expect(facts).toEqual(snapshot);
    expect(anomalies.length).toBeGreaterThan(0);
    expect(Object.isFrozen(anomalies)).toBe(true);
    expect(Object.isFrozen(anomalies[0])).toBe(true);
    expect(Object.isFrozen(anomalies[0]!.evidence)).toBe(true);
    expect(Object.isFrozen(anomalies[0]!.measured)).toBe(true);
    expect(Object.isFrozen(anomalies[0]!.thresholds)).toBe(true);
  });

  it('every anomaly exposes the thresholds that decided it (transparency contract)', () => {
    const anomalies = detect({
      payments: [pay('2025-12-10', 2), pay('2025-12-20', 4), pay('2026-02-01', 9), pay('2026-02-10', 11)],
    });
    const cadence = ofType(anomalies, 'cadence_deterioration')[0]!;
    expect(Object.keys(cadence.thresholds).sort()).toEqual(['cadenceHighDays', 'cadenceMediumDays', 'cadenceMinBaseline', 'cadenceMinRecent', 'cadenceTriggerDays', 'cadenceWindowDays']);
  });

  it('severityRank orders low < medium < high', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('high'));
  });

  it('invalid clock / asOf refuse to run', () => {
    expectCode(() => detectAnomalies(ORG, CUSTOMER, {}, undefined as unknown as Clock), 'BEHAV_CLOCK_INVALID');
    expectCode(() => detectAnomalies(ORG, CUSTOMER, {}, { now: () => 'not-a-date' as unknown as Date }), 'BEHAV_AS_OF_INVALID');
    expectCode(() => detectAnomalies(ORG, CUSTOMER, {}, clock, { asOf: new Date('nope') }), 'BEHAV_AS_OF_INVALID');
  });

  it('malformed thresholds refuse to run (BEHAV_THRESHOLD_INVALID) — validated, not re-defaulted', () => {
    const bad = (thresholds: Parameters<typeof detectAnomalies>[4]): (() => void) => () => detectAnomalies(ORG, CUSTOMER, {}, clock, thresholds);
    expectCode(bad({ thresholds: { cadenceWindowDays: 0 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { cadenceMinBaseline: 1.5 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { cadenceTriggerDays: 5, cadenceMediumDays: 5 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { cadenceMediumDays: 20, cadenceHighDays: 15 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { promiseMinStreak: 0 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { partialMinRate: 1.5 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { partialRateIncrease: -0.1 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { partialMinPayments: 0 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { silenceGraceDays: 0 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { silenceGraceDays: 7, silenceMediumDays: 7 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { disputeSpikeMin: 3, disputeSpikeHigh: 3 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { disputeWindowDays: -1 } }), 'BEHAV_THRESHOLD_INVALID');
    expectCode(bad({ thresholds: { disputeSpikeHigh: 0 } }), 'BEHAV_THRESHOLD_INVALID');
  });

  it('default thresholds are exposed and frozen', () => {
    expect(DEFAULT_ANOMALY_THRESHOLDS.cadenceTriggerDays).toBe(3);
    expect(Object.isFrozen(DEFAULT_ANOMALY_THRESHOLDS)).toBe(true);
  });
});
