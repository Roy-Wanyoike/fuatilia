import { describe, expect, it, vi } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { MEMORY_CLAIMS, type Claim, type MemoryClaimName } from './claims';
import { memorySnapshot, type CustomerMemory } from './snapshot';
import {
  DEFAULT_DIFF_THRESHOLDS,
  diffProfiles,
  resolveDiffThresholds,
  type BehaviorChange,
  type DiffResult,
  type DiffThresholds,
} from './diff';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(1);
const OTHER = uid(9);
const BEFORE_AS_OF = '2026-01-01T00:00:00.000Z';
const AFTER_AS_OF = '2026-04-01T00:00:00.000Z';
const CLOCK_ISO = '2026-04-02T12:00:00.000Z';
const clock: Clock = { now: () => new Date(CLOCK_ISO) };

let seq = 3000;
const ev = (): Uuid => uid(++seq);

const claim = (name: MemoryClaimName, value: unknown, ids: readonly Uuid[] = [ev()]): Claim => ({
  claim: name, value, computedFrom: ids, asOf: AFTER_AS_OF,
});

const cadenceClaim = (medianDaysToPay: number): Claim =>
  claim(MEMORY_CLAIMS.cadence, { sampleCount: 4, minDaysToPay: 1, medianDaysToPay, p90DaysToPay: 12 });

const reliabilityClaim = (rate: number): Claim =>
  claim(MEMORY_CLAIMS.reliability, { kept: 2, broken: 1, expired: 1, total: 4, rate });

const exposureClaim = (rows: { currency: string; openMinor: number }[]): Claim =>
  claim(MEMORY_CLAIMS.exposure, {
    currencies: rows.map((row) => ({ ...row, openReceivables: 1, aging: [] })),
  });

const disputesClaim = (currentlyOpen: number): Claim =>
  claim(MEMORY_CLAIMS.disputes, { opened: 1, resolved: 0, currentlyOpen });

const memoryOf = (customerId: Uuid, claims: Claim[], asOf = AFTER_AS_OF): CustomerMemory => ({
  customerId, asOf, claims, factCount: 4,
});

const emptyMemory = (customerId: Uuid = CUSTOMER, asOf = BEFORE_AS_OF): CustomerMemory =>
  memoryOf(customerId, [], asOf);

const rowOf = (result: DiffResult, dimension: string, currency?: string): BehaviorChange | undefined =>
  result.changes.find((change) => change.dimension === dimension && (currency === undefined || change.currency === currency));

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- classification tables ------------------------------------------------------

describe('diffProfiles — per-dimension classification (transparent thresholds)', () => {
  it('classifies payment_cadence: lower median days-to-pay is improving', () => {
    const table: { before: number; after: number; direction: string; threshold?: number }[] = [
      { before: 10, after: 4, direction: 'improving' },    // Δ −6 crosses
      { before: 10, after: 8, direction: 'stable' },        // Δ −2 within ±3
      { before: 5, after: 7, direction: 'stable' },         // Δ +2 within ±3
      { before: 5, after: 8, direction: 'deteriorating' }, // Δ +3 → at-threshold crosses
      { before: 5, after: 15, direction: 'deteriorating' },
      { before: 5, after: 5, direction: 'stable' },         // Δ 0
      { before: 10, after: 4, direction: 'stable', threshold: 20 }, // custom threshold swallows Δ −6
    ];
    table.forEach(({ before, after, direction, threshold }) => {
      const result = diffProfiles(
        memoryOf(CUSTOMER, [cadenceClaim(before)], BEFORE_AS_OF),
        memoryOf(CUSTOMER, [cadenceClaim(after)]),
        clock,
        threshold === undefined ? {} : { cadenceMedianDays: threshold },
      );
      expect(rowOf(result, 'payment_cadence')?.direction, `${before}→${after}`).toBe(direction);
    });
  });

  it('classifies promise_reliability: higher kept rate is improving (at-threshold crosses)', () => {
    const table: { before: number; after: number; direction: string }[] = [
      { before: 0.5, after: 0.65, direction: 'improving' },
      { before: 0.5, after: 0.6, direction: 'improving' },   // Δ exactly 0.1 → crosses
      { before: 0.5, after: 0.55, direction: 'stable' },
      { before: 0.5, after: 0.4, direction: 'deteriorating' }, // Δ −0.1 → crosses
      { before: 1, after: 0, direction: 'deteriorating' },
      { before: 0.8, after: 0.8, direction: 'stable' },
    ];
    table.forEach(({ before, after, direction }) => {
      const result = diffProfiles(
        memoryOf(CUSTOMER, [reliabilityClaim(before)], BEFORE_AS_OF),
        memoryOf(CUSTOMER, [reliabilityClaim(after)]),
        clock,
      );
      expect(rowOf(result, 'promise_reliability')?.direction, `${before}→${after}`).toBe(direction);
    });
  });

  it('classifies exposure per currency: higher open balance is worse; missing side counts as 0', () => {
    const table: { before: number | null; after: number | null; direction: string; threshold?: number }[] = [
      { before: 500_000, after: 1_000_000, direction: 'deteriorating' },   // Δ exactly threshold
      { before: 500_000, after: 900_000, direction: 'stable' },             // Δ 400k below
      { before: 1_000_000, after: 200_000, direction: 'improving' },
      { before: null, after: 600_000, direction: 'deteriorating' },         // new exposure
      { before: 700_000, after: null, direction: 'improving' },             // fully settled
      { before: 800_000, after: 1_600_000, direction: 'stable', threshold: 1_000_000 },
    ];
    table.forEach(({ before, after, direction, threshold }) => {
      const beforeMemory = memoryOf(CUSTOMER, before === null ? [] : [exposureClaim([{ currency: 'KES', openMinor: before }])], BEFORE_AS_OF);
      const afterMemory = memoryOf(CUSTOMER, after === null ? [] : [exposureClaim([{ currency: 'KES', openMinor: after }])]);
      const result = diffProfiles(beforeMemory, afterMemory, clock, threshold === undefined ? {} : { exposureMinor: threshold });
      expect(rowOf(result, 'exposure', 'KES')?.direction, `${before}→${after}`).toBe(direction);
    });
  });

  it('emits NO exposure row when neither side carries the claim (nothing to compare)', () => {
    const result = diffProfiles(emptyMemory(), memoryOf(CUSTOMER, [cadenceClaim(5)]), clock);
    expect(result.changes.filter((change) => change.dimension === 'exposure')).toEqual([]);
  });

  it('classifies disputes: currently-open count, higher is worse; missing ⇒ 0', () => {
    const table: { before: number | null; after: number | null; direction: string }[] = [
      { before: 0, after: 1, direction: 'deteriorating' }, // at-threshold (1)
      { before: 0, after: 0, direction: 'stable' },
      { before: 2, after: 0, direction: 'improving' },
      { before: 1, after: 2, direction: 'deteriorating' },
      { before: 3, after: 3, direction: 'stable' },
      { before: null, after: 1, direction: 'deteriorating' },
      { before: 1, after: null, direction: 'improving' },
    ];
    table.forEach(({ before, after, direction }) => {
      const beforeMemory = memoryOf(CUSTOMER, before === null ? [] : [disputesClaim(before)], BEFORE_AS_OF);
      const afterMemory = memoryOf(CUSTOMER, after === null ? [] : [disputesClaim(after)]);
      const result = diffProfiles(beforeMemory, afterMemory, clock);
      expect(rowOf(result, 'disputes')?.direction, `${before}→${after}`).toBe(direction);
    });
  });

  it('treats cadence/reliability claims missing on one side as NOT COMPARABLE (stable, nulls)', () => {
    const beforeMemory = memoryOf(CUSTOMER, [cadenceClaim(10), reliabilityClaim(0.9)], BEFORE_AS_OF);
    const afterMemory = memoryOf(CUSTOMER, [], AFTER_AS_OF); // memory reset — no history is not "improving"
    const result = diffProfiles(beforeMemory, afterMemory, clock);
    expect(rowOf(result, 'payment_cadence')).toMatchObject({ direction: 'stable', before: 10, after: null });
    expect(rowOf(result, 'promise_reliability')).toMatchObject({ direction: 'stable', before: 0.9, after: null });
    expect(rowOf(result, 'payment_cadence')?.reason).toContain('not comparable');
    expect(result.event).toBeNull(); // an unknown history is never a crossing
  });

  it('emits one exposure row per currency, sorted, with the row currency on it', () => {
    const before = memoryOf(CUSTOMER, [exposureClaim([{ currency: 'USD', openMinor: 1_000_000 }, { currency: 'KES', openMinor: 100_000 }])], BEFORE_AS_OF);
    const after = memoryOf(CUSTOMER, [exposureClaim([{ currency: 'KES', openMinor: 100_000 }, { currency: 'USD', openMinor: 1_000_000 }])]);
    const result = diffProfiles(before, after, clock);
    const rows = result.changes.filter((change) => change.dimension === 'exposure');
    expect(rows.map((row) => row.currency)).toEqual(['KES', 'USD']);
    expect(rows.every((row) => row.direction === 'stable')).toBe(true);
    expect(rowOf(result, 'exposure', 'KES')?.currency).toBe('KES');
  });
});

// --- result shape, reasons, evidence ---------------------------------------------

describe('diffProfiles — result shape + explainability', () => {
  it('keeps the fixed dimension order with stable rows listed (silent but visible)', () => {
    const before = memoryOf(CUSTOMER, [cadenceClaim(5), reliabilityClaim(0.5), exposureClaim([{ currency: 'KES', openMinor: 100_000 }]), disputesClaim(0)], BEFORE_AS_OF);
    const after = memoryOf(CUSTOMER, [cadenceClaim(5), reliabilityClaim(0.5), exposureClaim([{ currency: 'KES', openMinor: 100_000 }]), disputesClaim(0)]);
    const result = diffProfiles(before, after, clock);
    expect(result.customerId).toBe(CUSTOMER);
    expect(result.asOf).toBe(AFTER_AS_OF);
    expect(result.changes.map((change) => change.dimension)).toEqual([
      'payment_cadence', 'promise_reliability', 'exposure', 'disputes',
    ]);
    expect(result.changes.every((change) => change.direction === 'stable')).toBe(true);
    expect(result.event).toBeNull();
  });

  it('pins deterministic, human-readable reasons per direction', () => {
    const result = diffProfiles(
      memoryOf(CUSTOMER, [cadenceClaim(10), reliabilityClaim(0.5), exposureClaim([{ currency: 'KES', openMinor: 100_000 }])], BEFORE_AS_OF),
      memoryOf(CUSTOMER, [cadenceClaim(4), reliabilityClaim(0.65), exposureClaim([{ currency: 'KES', openMinor: 800_000 }])]),
      clock,
      { exposureMinor: 500_000 },
    );
    expect(rowOf(result, 'payment_cadence')?.reason).toBe('median days-to-pay improved from 10 to 4 (threshold 3 days)');
    expect(rowOf(result, 'promise_reliability')?.reason).toBe('promise reliability rate improved from 0.5 to 0.65 (threshold 0.1)');
    expect(rowOf(result, 'exposure', 'KES')?.reason).toBe('open exposure for KES grew from 100000 to 800000 minor (threshold 500000)');
  });

  it('pins before/after/threshold on every row', () => {
    const result = diffProfiles(
      memoryOf(CUSTOMER, [cadenceClaim(2)], BEFORE_AS_OF),
      memoryOf(CUSTOMER, [cadenceClaim(9)]),
      clock,
    );
    expect(rowOf(result, 'payment_cadence')).toMatchObject({
      dimension: 'payment_cadence', direction: 'deteriorating', before: 2, after: 9, threshold: 3,
    });
    expect(rowOf(result, 'payment_cadence')?.currency).toBeUndefined();
  });

  it('unions the evidence of both sides (before first, deduped) on each row', () => {
    const beforeIds = [ev(), ev()];
    const afterIds = [ev()];
    const result = diffProfiles(
      memoryOf(CUSTOMER, [claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 9 }, beforeIds)], BEFORE_AS_OF),
      memoryOf(CUSTOMER, [claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 2 }, afterIds)]),
      clock,
    );
    expect(rowOf(result, 'payment_cadence')?.computedFrom).toEqual([...beforeIds, ...afterIds]);
  });
});

// --- the memory.behaviorChanged fact ----------------------------------------------

describe('diffProfiles — memory.behaviorChanged on threshold crossing ONLY', () => {
  it('emits NO event when every dimension is stable (sub-threshold changes are silent)', () => {
    const before = memoryOf(CUSTOMER, [cadenceClaim(5), reliabilityClaim(0.5), disputesClaim(1)], BEFORE_AS_OF);
    const after = memoryOf(CUSTOMER, [cadenceClaim(6), reliabilityClaim(0.55), disputesClaim(1)]);
    expect(diffProfiles(before, after, clock).event).toBeNull();
  });

  it('emits exactly one event when a single dimension crosses, stable rows excluded', () => {
    const cadenceIds = [ev(), ev()];
    const afterIds = [ev()];
    const result = diffProfiles(
      memoryOf(CUSTOMER, [claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 2 }, cadenceIds)], BEFORE_AS_OF),
      memoryOf(CUSTOMER, [claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 9 }, afterIds)]),
      clock,
    );
    const event = result.event;
    expect(event).not.toBeNull();
    expect(event?.name).toBe('memory.behaviorChanged');
    expect(event?.version).toBe(1);
    expect(event?.aggregateId).toBe(CUSTOMER);
    expect(event?.occurredAt).toBe(CLOCK_ISO);
    expect(event?.payload).toMatchObject({
      customerId: CUSTOMER,
      asOf: AFTER_AS_OF,
      changes: [{
        dimension: 'payment_cadence', direction: 'deteriorating', before: 2, after: 9, threshold: 3,
      }],
    });
    expect(event?.payload.changes).toHaveLength(1); // the 3 stable rows stay silent
    expect(event?.payload.evidenceRefs).toEqual([...cadenceIds, ...afterIds]);
  });

  it('aggregates multiple crossings into one event with deduped evidence', () => {
    const cadenceIds = [ev()];
    const disputeIds = [ev()];
    const afterCadenceIds = [ev()];
    const afterDisputeIds = [ev()];
    const result = diffProfiles(
      memoryOf(
        CUSTOMER,
        [
          claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 10 }, cadenceIds),
          claim(MEMORY_CLAIMS.disputes, { opened: 1, resolved: 0, currentlyOpen: 0 }, disputeIds),
        ],
        BEFORE_AS_OF,
      ),
      memoryOf(
        CUSTOMER,
        [
          claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 2 }, afterCadenceIds),
          claim(MEMORY_CLAIMS.disputes, { opened: 1, resolved: 0, currentlyOpen: 2 }, afterDisputeIds),
        ],
      ),
      clock,
    );
    const payload = result.event?.payload;
    expect(payload?.changes.map((change) => change.dimension)).toEqual(['payment_cadence', 'disputes']);
    expect(payload?.evidenceRefs).toEqual([...cadenceIds, ...afterCadenceIds, ...disputeIds, ...afterDisputeIds]);
  });

  it('carries the currency on a crossed exposure row (and never on other dimensions)', () => {
    const result = diffProfiles(
      emptyMemory(CUSTOMER, BEFORE_AS_OF),
      memoryOf(CUSTOMER, [exposureClaim([{ currency: 'KES', openMinor: 620_000 }])]),
      clock,
    );
    const payload = result.event?.payload;
    expect(payload?.changes).toHaveLength(1);
    expect(payload?.changes[0]).toMatchObject({ dimension: 'exposure', direction: 'deteriorating', currency: 'KES', before: 0, after: 620_000 });
  });

  it('stamps occurredAt from exactly ONE clock read (house rule) — even for stable diffs', () => {
    const now = vi.fn(() => new Date(CLOCK_ISO));
    const counting: Clock = { now };
    diffProfiles(memoryOf(CUSTOMER, [cadenceClaim(5)], BEFORE_AS_OF), memoryOf(CUSTOMER, [cadenceClaim(6)]), counting);
    expect(now).toHaveBeenCalledTimes(1);
    diffProfiles(memoryOf(CUSTOMER, [cadenceClaim(5)], BEFORE_AS_OF), memoryOf(CUSTOMER, [cadenceClaim(20)]), counting);
    expect(now).toHaveBeenCalledTimes(2);
  });
});

// --- integration with memorySnapshot -----------------------------------------------

describe('diffProfiles — over real memorySnapshot outputs', () => {
  const invoiceFact = (invoiceId: Uuid, atIso: string): MemoryFactShape => ({
    eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'invoice_issued', invoiceId, currency: 'KES', totalMinor: 100_000,
  });
  type MemoryFactShape = Parameters<typeof memorySnapshot>[0][number];

  const paidFact = (invoiceId: Uuid, atIso: string): MemoryFactShape => ({
    eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'payment_received', paymentId: uid(++seq), invoiceId, currency: 'KES', amountMinor: 100_000,
  });

  it('flags a deteriorating cadence from a cumulative fact history', () => {
    const earlyInv = uid(++seq);
    const lateInv = uid(++seq);
    const facts: MemoryFactShape[] = [
      invoiceFact(earlyInv, '2025-12-01T00:00:00.000Z'),
      paidFact(earlyInv, '2025-12-03T12:00:00.000Z'), // 2 days
      paidFact(earlyInv, '2025-12-04T12:00:00.000Z'), // 3 days  → before median 2.5
      invoiceFact(lateInv, '2026-01-05T00:00:00.000Z'),
      paidFact(lateInv, '2026-01-17T12:00:00.000Z'), // 12 days
      paidFact(lateInv, '2026-01-18T12:00:00.000Z'), // 13 days → after median 7.5
    ];
    const before = memorySnapshot(facts.slice(0, 3), BEFORE_AS_OF).customers[0] as CustomerMemory;
    const after = memorySnapshot(facts, AFTER_AS_OF).customers[0] as CustomerMemory;
    const result = diffProfiles(before, after, clock);
    const row = rowOf(result, 'payment_cadence');
    expect(row).toMatchObject({ before: 2.5, after: 7.5, direction: 'deteriorating', threshold: 3 });
    expect(result.event?.name).toBe('memory.behaviorChanged');
    // evidence resolves into the SUPPLIED facts
    for (const ref of result.event?.payload.evidenceRefs ?? []) {
      expect(facts.some((fact) => fact.eventId === ref)).toBe(true);
    }
  });

  it('is deterministic: two diffs over the same memories are byte-identical', () => {
    const before = memoryOf(CUSTOMER, [cadenceClaim(8), reliabilityClaim(0.25)], BEFORE_AS_OF);
    const after = memoryOf(CUSTOMER, [cadenceClaim(2), reliabilityClaim(0.75)]);
    const first = JSON.stringify(diffProfiles(before, after, clock));
    const second = JSON.stringify(diffProfiles(before, after, clock));
    expect(first).toBe(second);
  });
});

// --- validation -------------------------------------------------------------------

describe('diffProfiles — validation gates', () => {
  it('refuses memories of different customers (MEM_CUSTOMER_MISMATCH)', () => {
    expectCode(
      () => diffProfiles(emptyMemory(OTHER, BEFORE_AS_OF), emptyMemory(CUSTOMER, AFTER_AS_OF), clock),
      'MEM_CUSTOMER_MISMATCH',
    );
  });

  it('refuses malformed before/after arguments (MEM_SNAPSHOT_INVALID)', () => {
    const badArgs: unknown[] = [null, undefined, 'memory', [], { customerId: CUSTOMER, asOf: AFTER_AS_OF }];
    badArgs.forEach((bad) => {
      expectCode(
        () => diffProfiles(bad as CustomerMemory, emptyMemory(CUSTOMER, AFTER_AS_OF), clock),
        'MEM_SNAPSHOT_INVALID',
      );
    });
    expectCode(
      () => diffProfiles({ customerId: CUSTOMER, asOf: 'not-iso', claims: [], factCount: 0 }, emptyMemory(CUSTOMER, AFTER_AS_OF), clock),
      'MEM_SNAPSHOT_INVALID',
    );
  });

  it('refuses malformed claim values inside a memory (MEM_SNAPSHOT_INVALID)', () => {
    const broken = memoryOf(CUSTOMER, [claim(MEMORY_CLAIMS.cadence, { medianDaysToPay: 'nine' })]);
    expectCode(() => diffProfiles(emptyMemory(CUSTOMER, BEFORE_AS_OF), broken, clock), 'MEM_SNAPSHOT_INVALID');
  });

  it('refuses invalid thresholds (MEM_THRESHOLD_INVALID) per key', () => {
    const badValues = [-1, Number.NaN, Number.POSITIVE_INFINITY, '3', null];
    (Object.keys(DEFAULT_DIFF_THRESHOLDS) as (keyof DiffThresholds)[]).forEach((key) => {
      badValues.forEach((bad) => {
        expectCode(
          () => resolveDiffThresholds({ [key]: bad } as DiffThresholds),
          'MEM_THRESHOLD_INVALID',
        );
      });
    });
  });

  it('merges partial threshold overrides over the safe defaults', () => {
    expect(resolveDiffThresholds()).toEqual({ cadenceMedianDays: 3, reliabilityRate: 0.1, exposureMinor: 500_000, disputeCount: 1 });
    expect(resolveDiffThresholds({ exposureMinor: 5 })).toEqual({ cadenceMedianDays: 3, reliabilityRate: 0.1, exposureMinor: 5, disputeCount: 1 });
  });

  it('refuses a broken clock with MEM_CLOCK_INVALID (validated once, up front)', () => {
    const brokenClocks: unknown[] = [
      { now: () => 'not a date' },
      { now: () => new Date(Number.NaN) },
      {},
      null,
      { now: () => undefined },
    ];
    brokenClocks.forEach((broken) => {
      expectCode(
        () => diffProfiles(emptyMemory(CUSTOMER, BEFORE_AS_OF), emptyMemory(CUSTOMER, AFTER_AS_OF), broken as Clock),
        'MEM_CLOCK_INVALID',
      );
    });
  });

  it('crosses on ANY nonzero delta when a threshold is 0', () => {
    const result = diffProfiles(
      memoryOf(CUSTOMER, [cadenceClaim(5)], BEFORE_AS_OF),
      memoryOf(CUSTOMER, [cadenceClaim(6)]),
      clock,
      { cadenceMedianDays: 0 },
    );
    expect(rowOf(result, 'payment_cadence')?.direction).toBe('deteriorating');
    expect(result.event?.payload.changes).toHaveLength(1);
  });
});
