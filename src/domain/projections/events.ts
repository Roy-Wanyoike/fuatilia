/**
 * Projections-lane domain events (wave 4, issue #24, SPEC §19/§20/§66).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   projections.agingSnapshotTaken   an AR aging snapshot (ACTUALS) was taken
 *   projections.collectionsProjected a cash-collection PROJECTION was computed
 *   segment.customerSegmentAssigned  a customer was assigned a stable segment
 *   segment.strategyAssigned         a customer was assigned a collections
 *                                    strategy (default or explicit override)
 *
 * These are observability/audit facts ABOUT projections and segmentations —
 * the numbers themselves stay in the returned structures (adapters persist
 * and serve them); the events make the intelligence layer's reads visible in
 * the event fabric (VISION §3.10) without ever writing fund truth.
 *
 * Envelope mirrors the wave-3 lanes: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` (the typed catalog +
 * outbox of issue #6 wraps these; `version` stays 1 until a breaking payload
 * change). Payloads are narrow, serializable and id-only: dates travel as
 * ISO-8601 strings, monetary values as safe-integer minor-unit numbers
 * (guarded against precision loss — PROJ_AMOUNT_NOT_SAFE_INTEGER), segments
 * /strategies as their stable names, cross-lane ids (org, customer) as
 * opaque Uuids. One `clock.now()` read per event — `occurredAt` and the
 * payload's `assignedAt` always agree.
 *
 * Kind guards: `agingSnapshotTaken` accepts only `kind: 'actual'` snapshots
 * and `collectionsProjected` only `kind: 'projection'` results — the lane
 * refuses to label a prediction as an actual (or vice versa) on the wire.
 */
import { DomainError, type Clock, type Currency, type Uuid } from '../shared';
import type { AgingSnapshot } from './aging';
import type { CollectionsProjection } from './projection';
import { SEGMENTS, type Segment, type SegmentAssignment } from './segments';
import type { CustomerStrategyAssignment } from './strategies';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Minor units → JSON-safe number. Refuses silent precision loss. */
export function minorToNumber(amountMinor: bigint): number {
  const asNumber = Number(amountMinor);
  if (!Number.isSafeInteger(asNumber)) {
    throw new DomainError(
      'PROJ_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amountMinor} exceeds the safe-integer range for event payloads`,
    );
  }
  return asNumber;
}

/** Single validated Clock read → ISO-8601 (PROJ_CLOCK_INVALID on a broken clock). */
function nowIso(clock: Clock): string {
  const occurred = clock.now();
  if (!(occurred instanceof Date) || Number.isNaN(occurred.getTime())) {
    throw new DomainError('PROJ_CLOCK_INVALID', 'clock.now() must return a valid Date', { now: String(occurred) });
  }
  return occurred.toISOString();
}

/** The only way this module builds events — one clock read, frozen-in-time envelope. */
function envelope<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): DomainEvent<TName, TPayload> {
  return { name, version: 1, aggregateId, occurredAt: nowIso(clock), payload };
}

// ---------------------------------------------------------------------------
// projections.agingSnapshotTaken
// ---------------------------------------------------------------------------

export interface AgingCurrencyTotalsPayload {
  readonly currency: Currency;
  readonly totalMinor: number;
  readonly receivableCount: number;
  /** Minor units per bucket — all five keys, always present. */
  readonly bucketMinors: Readonly<Record<string, number>>;
}

export interface AgingSnapshotTakenPayload {
  readonly orgId: Uuid;
  /** ISO-8601 — the snapshot's asOf. */
  readonly asOf: string;
  readonly receivablesAged: number;
  readonly zeroBalanceCount: number;
  /** Receivables that aged (contributed), deterministic view order — the evidence trail. */
  readonly evidenceRefs: readonly Uuid[];
  readonly currencies: readonly AgingCurrencyTotalsPayload[];
}

/** Build the `projections.agingSnapshotTaken` event (aggregate = the org). */
export function agingSnapshotTakenEvent(
  orgId: Uuid,
  snapshot: AgingSnapshot,
  clock: Clock,
): DomainEvent<'projections.agingSnapshotTaken', AgingSnapshotTakenPayload> {
  if (snapshot.kind !== 'actual') {
    throw new DomainError('PROJ_KIND_INVALID', `an aging snapshot event requires kind 'actual', got ${String(snapshot.kind)}`);
  }
  return envelope(
    'projections.agingSnapshotTaken',
    orgId,
    {
      orgId,
      asOf: snapshot.asOf,
      receivablesAged: snapshot.receivablesAged,
      zeroBalanceCount: snapshot.zeroBalanceCount,
      evidenceRefs: snapshot.currencies.flatMap((view) =>
        view.buckets.flatMap((bucket) => [...bucket.evidenceRefs]),
      ),
      currencies: snapshot.currencies.map((view) => ({
        currency: view.currency,
        totalMinor: minorToNumber(view.totalMinor),
        receivableCount: view.buckets.reduce((sum, bucket) => sum + bucket.receivableCount, 0),
        bucketMinors: Object.fromEntries(view.buckets.map((bucket) => [bucket.bucket, minorToNumber(bucket.amountMinor)])),
      })),
    },
    clock,
  );
}

// ---------------------------------------------------------------------------
// projections.collectionsProjected
// ---------------------------------------------------------------------------

export interface ProjectionCurrencyBandsPayload {
  readonly currency: Currency;
  readonly pessimisticMinor: number;
  readonly expectedMinor: number;
  readonly optimisticMinor: number;
}

export interface CollectionsProjectedPayload {
  readonly orgId: Uuid;
  /** Explicit on the wire: this event carries a PREDICTION, never a balance. */
  readonly kind: 'projection';
  /** ISO-8601 */
  readonly asOf: string;
  readonly horizonDays: number;
  /** ISO-8601 */
  readonly horizonEnd: string;
  readonly inScopeReceivables: number;
  readonly assumptionCount: number;
  /** In-scope receivable ids backing the bands — the evidence trail. */
  readonly evidenceRefs: readonly Uuid[];
  readonly currencies: readonly ProjectionCurrencyBandsPayload[];
}

/** Build the `projections.collectionsProjected` event (aggregate = the org). */
export function collectionsProjectedEvent(
  orgId: Uuid,
  projection: CollectionsProjection,
  clock: Clock,
): DomainEvent<'projections.collectionsProjected', CollectionsProjectedPayload> {
  if (projection.kind !== 'projection') {
    throw new DomainError(
      'PROJ_KIND_INVALID',
      `a collectionsProjected event requires kind 'projection', got ${String(projection.kind)}`,
    );
  }
  return envelope(
    'projections.collectionsProjected',
    orgId,
    {
      orgId,
      kind: 'projection',
      asOf: projection.asOf,
      horizonDays: projection.horizonDays,
      horizonEnd: projection.horizonEnd,
      inScopeReceivables: projection.evidenceRefs.length,
      assumptionCount: projection.assumptions.length,
      evidenceRefs: [...projection.evidenceRefs],
      currencies: projection.currencies.map((view) => ({
        currency: view.currency,
        pessimisticMinor: minorToNumber(view.pessimisticMinor),
        expectedMinor: minorToNumber(view.expectedMinor),
        optimisticMinor: minorToNumber(view.optimisticMinor),
      })),
    },
    clock,
  );
}

// ---------------------------------------------------------------------------
// segment.customerSegmentAssigned / segment.strategyAssigned
// ---------------------------------------------------------------------------

export interface CustomerSegmentAssignedPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** Stable segment name (SEGMENTS). */
  readonly segment: Segment;
  /** The exact conditions that fired — the explainability trail. */
  readonly reasons: readonly string[];
  /** ISO-8601 — identical to the envelope's occurredAt. */
  readonly assignedAt: string;
}

/** Build the `segment.customerSegmentAssigned` event (aggregate = the customer). */
export function customerSegmentAssignedEvent(
  orgId: Uuid,
  assignment: SegmentAssignment,
  clock: Clock,
): DomainEvent<'segment.customerSegmentAssigned', CustomerSegmentAssignedPayload> {
  assertSegmentName(assignment.segment);
  const occurredAt = nowIso(clock);
  const event: DomainEvent<'segment.customerSegmentAssigned', CustomerSegmentAssignedPayload> = {
    name: 'segment.customerSegmentAssigned',
    version: 1,
    aggregateId: assignment.customerId,
    occurredAt,
    payload: {
      orgId,
      customerId: assignment.customerId,
      segment: assignment.segment,
      reasons: [...assignment.reasons],
      assignedAt: occurredAt,
    },
  };
  return event;
}

export interface StrategyAssignedPayload {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  readonly segment: Segment;
  /** Stable strategy name (STRATEGIES). */
  readonly strategy: string;
  /** default | segment_override | customer_override */
  readonly source: string;
  readonly reason: string;
  /** ISO-8601 — identical to the envelope's occurredAt. */
  readonly assignedAt: string;
}

/** Build the `segment.strategyAssigned` event (aggregate = the customer). */
export function strategyAssignedEvent(
  orgId: Uuid,
  assignment: CustomerStrategyAssignment,
  clock: Clock,
): DomainEvent<'segment.strategyAssigned', StrategyAssignedPayload> {
  assertSegmentName(assignment.segment);
  const occurredAt = nowIso(clock);
  const event: DomainEvent<'segment.strategyAssigned', StrategyAssignedPayload> = {
    name: 'segment.strategyAssigned',
    version: 1,
    aggregateId: assignment.customerId,
    occurredAt,
    payload: {
      orgId,
      customerId: assignment.customerId,
      segment: assignment.segment,
      strategy: assignment.strategy,
      source: assignment.source,
      reason: assignment.reason,
      assignedAt: occurredAt,
    },
  };
  return event;
}

/** Everything this lane emits. */
export type ProjectionsLaneEvent =
  | DomainEvent<'projections.agingSnapshotTaken', AgingSnapshotTakenPayload>
  | DomainEvent<'projections.collectionsProjected', CollectionsProjectedPayload>
  | DomainEvent<'segment.customerSegmentAssigned', CustomerSegmentAssignedPayload>
  | DomainEvent<'segment.strategyAssigned', StrategyAssignedPayload>;

const assertSegmentName = (segment: Segment): void => {
  if (!(SEGMENTS as readonly string[]).includes(segment)) {
    throw new DomainError('SEG_SEGMENT_UNKNOWN', `unknown segment ${String(segment)} — see SEGMENTS`, { segment });
  }
};
