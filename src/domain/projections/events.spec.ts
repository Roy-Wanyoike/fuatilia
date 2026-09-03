import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { arAgingByBucket } from './aging';
import { projectCollections } from './projection';
import { segmentCustomers } from './segments';
import { assignStrategies } from './strategies';
import {
  agingSnapshotTakenEvent,
  collectionsProjectedEvent,
  customerSegmentAssignedEvent,
  minorToNumber,
  strategyAssignedEvent,
} from './events';
import type { ReceivableFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(1);
const NOW = '2025-07-01T12:00:00.000Z';
const clock: Clock = { now: () => new Date(NOW) };

const receivable = (n: number, overrides: Partial<ReceivableFact> = {}): ReceivableFact => ({
  receivableId: uid(n),
  customerId: uid(900),
  currency: 'KES',
  balanceMinor: 1_000_000n,
  dueDate: '2025-05-01T00:00:00.000Z', // 61 days before NOW → 61-90 bucket
  ...overrides,
});

const snapshotOf = () =>
  arAgingByBucket([receivable(10), receivable(11, { balanceMinor: 500_000n, dueDate: '2025-06-20T00:00:00.000Z' })], NOW);

const projectionOf = () =>
  projectCollections([receivable(10), receivable(11, { balanceMinor: 500_000n, dueDate: '2025-06-20T00:00:00.000Z' })], [], 30, clock);

const segmentAssignmentOf = () => segmentCustomers([{ customerId: uid(20), currency: 'KES', exposureMinor: 0n, worstDaysOverdue: 0, promiseKeptRate: null, brokenPromiseCount: 0, daysSinceLastPayment: null, disputeOpen: false }])[0]!;

const strategyAssignmentOf = () =>
  assignStrategies([segmentAssignmentOf()])[0]!;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- tests ------------------------------------------------------------------

describe('projections.agingSnapshotTaken (ACTUALS event)', () => {
  const event = agingSnapshotTakenEvent(ORG, snapshotOf(), clock);

  it('uses the repo envelope: name, v1, aggregate = the org, ISO occurredAt from the Clock', () => {
    expect(event.name).toBe('projections.agingSnapshotTaken');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(ORG);
    expect(event.occurredAt).toBe(NOW);
  });

  it('carries a narrow, serializable payload with all five buckets per currency', () => {
    expect(event.payload.orgId).toBe(ORG);
    expect(event.payload.asOf).toBe(NOW);
    expect(event.payload.receivablesAged).toBe(2);
    expect(event.payload.zeroBalanceCount).toBe(0);
    const [kes] = event.payload.currencies;
    expect(kes!.currency).toBe('KES');
    expect(kes!.totalMinor).toBe(1_500_000); // safe-integer NUMBER, not bigint
    expect(kes!.receivableCount).toBe(2);
    expect(Object.keys(kes!.bucketMinors).sort()).toEqual(['1-30', '31-60', '61-90', '90+', 'current'].sort());
    expect(kes!.bucketMinors['61-90']).toBe(1_000_000);
    expect(kes!.bucketMinors['11-30']).toBeUndefined(); // only real bucket keys
    // wire-shaped: JSON round-trips cleanly (no bigints, no Dates)
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('carries the evidence trail — every receivable that aged (deterministic view order: current → 90+)', () => {
    // receivable 11 (11d overdue) lands in '1-30', receivable 10 (61d) in '61-90' — bucket-major order
    expect(event.payload.evidenceRefs).toEqual([uid(11), uid(10)]);
  });

  it('refuses to label a PROJECTION as an actual on the wire (kind guard)', () => {
    const forged = { kind: 'projection' } as unknown as Parameters<typeof agingSnapshotTakenEvent>[1];
    expectCode(() => agingSnapshotTakenEvent(ORG, forged, clock), 'PROJ_KIND_INVALID');
  });
});

describe('projections.collectionsProjected (PROJECTION event)', () => {
  const event = collectionsProjectedEvent(ORG, projectionOf(), clock);

  it('uses the repo envelope: name, v1, aggregate = the org, ISO occurredAt from the Clock', () => {
    expect(event.name).toBe('projections.collectionsProjected');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(ORG);
    expect(event.occurredAt).toBe(NOW);
  });

  it('labels the payload as a PROJECTION on the wire, never a balance', () => {
    expect(event.payload.kind).toBe('projection');
    expect(event.payload).not.toHaveProperty('balanceMinor');
    expect(event.payload).not.toHaveProperty('buckets');
    expect(event.payload.horizonDays).toBe(30);
    expect(event.payload.horizonEnd).toBe(projectionOf().horizonEnd);
    expect(event.payload.asOf).toBe(NOW);
    expect(event.payload.assumptionCount).toBe(projectionOf().assumptions.length);
  });

  it('carries per-currency bands as safe-integer numbers plus the evidence trail', () => {
    const [kes] = event.payload.currencies;
    expect(kes!.currency).toBe('KES');
    expect(typeof kes!.pessimisticMinor).toBe('number');
    expect(kes!.expectedMinor).toBe(400_000); // 200k (61d overdue ×0.4 haircut) + 200k (11d overdue ×0.8)
    expect(event.payload.inScopeReceivables).toBe(2);
    expect(event.payload.evidenceRefs).toEqual([uid(10), uid(11)]);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it('refuses to label an ACTUAL snapshot as a projection on the wire (kind guard)', () => {
    const forged = { kind: 'actual' } as unknown as Parameters<typeof collectionsProjectedEvent>[1];
    expectCode(() => collectionsProjectedEvent(ORG, forged, clock), 'PROJ_KIND_INVALID');
  });
});

describe('segment.customerSegmentAssigned / segment.strategyAssigned', () => {
  it('segment event: aggregate = the customer, stable segment name, reasons trail, assignedAt = occurredAt', () => {
    const assignment = segmentAssignmentOf();
    const event = customerSegmentAssignedEvent(ORG, assignment, clock);
    expect(event.name).toBe('segment.customerSegmentAssigned');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(assignment.customerId);
    expect(event.occurredAt).toBe(NOW);
    expect(event.payload).toEqual({
      orgId: ORG,
      customerId: assignment.customerId,
      segment: 'dormant',
      reasons: assignment.reasons,
      assignedAt: NOW,
    });
  });

  it('strategy event: names the strategy, its source and the machine-readable reason', () => {
    const assignment = strategyAssignmentOf();
    const event = strategyAssignedEvent(ORG, assignment, clock);
    expect(event.name).toBe('segment.strategyAssigned');
    expect(event.aggregateId).toBe(assignment.customerId);
    expect(event.payload).toEqual({
      orgId: ORG,
      customerId: assignment.customerId,
      segment: 'dormant',
      strategy: 'self_serve_reminders',
      source: 'default',
      reason: assignment.reason,
      assignedAt: NOW,
    });
  });

  it('reads the Clock exactly once — occurredAt and assignedAt can never disagree', () => {
    let reads = 0;
    const countingClock: Clock = { now: () => { reads += 1; return new Date(NOW); } };
    customerSegmentAssignedEvent(ORG, segmentAssignmentOf(), countingClock);
    expect(reads).toBe(1);
    const strategyClock: Clock = { now: () => { reads += 1; return new Date(NOW); } };
    strategyAssignedEvent(ORG, strategyAssignmentOf(), strategyClock);
    expect(reads).toBe(2);
  });

  it('refuses an unknown segment name on the wire', () => {
    const forged = { customerId: uid(20), segment: 'vip', reasons: [] } as unknown as Parameters<typeof customerSegmentAssignedEvent>[1];
    expectCode(() => customerSegmentAssignedEvent(ORG, forged, clock), 'SEG_SEGMENT_UNKNOWN');
  });
});

describe('minorToNumber — wire-shape guard', () => {
  it('converts bigint minor units to a safe-integer number', () => {
    expect(minorToNumber(1_500_000n)).toBe(1_500_000);
    expect(minorToNumber(0n)).toBe(0);
  });

  it('refuses amounts beyond the safe-integer range (no silent precision loss)', () => {
    expectCode(() => minorToNumber(9_007_199_254_740_993n), 'PROJ_AMOUNT_NOT_SAFE_INTEGER');
  });
});
