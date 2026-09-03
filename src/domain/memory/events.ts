/**
 * Memory-lane domain events (issue #37, wave 5).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   memory.snapshotTaken   a point-in-time customer memory was projected —
 *                          carries the claim names so consumers can audit
 *                          what the memory claimed at that moment;
 *   memory.behaviorChanged a significant behavior change was detected by
 *                          diffProfiles — the VISION's customer.behavior.changed
 *                          fact (§3.10), with per-dimension direction + reasons
 *                          + evidence refs; changes below threshold are silent
 *                          (no event, by design).
 *
 * Envelope mirrors the wave-3 lanes (disputes/promises/communications):
 * plain objects `{ name, version, aggregateId, occurredAt, payload }` — the
 * typed catalog + outbox of issue #6 wraps these; `version` stays 1 until a
 * breaking payload change. Payloads are narrow and serializable: opaque ids,
 * safe-integer minor units, ISO-8601 dates, no entity references, no bigints.
 * occurredAt comes from the injected Clock — never Date.now().
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import type { CustomerMemory } from './snapshot';

export type MemoryEventName = 'memory.snapshotTaken' | 'memory.behaviorChanged';

/** Stable envelope (issue #4 pattern); unifies with the typed catalog in issue #6. */
export interface MemoryEvent<TName extends MemoryEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  /** The customer the memory speaks about. */
  readonly aggregateId: Uuid;
  /** ISO-8601, from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/**
 * Read + validate the injected Clock once — the house "one clock read per
 * event" rule: `occurredAt` is derived from a single `clock.now()` call so a
 * step-clock or a real wall clock cannot yield two different stamps for one
 * event, and a broken clock fails fast with a stable code.
 */
export function readClock(clock: Clock): Date {
  const now = clock?.now?.();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new DomainError('MEM_CLOCK_INVALID', 'clock returned an invalid Date');
  }
  return now;
}

/** Event factory over an ALREADY-READ instant (see readClock). */
export function memoryEventAt<TName extends MemoryEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  occurredAt: Date,
): MemoryEvent<TName, TPayload> {
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    throw new DomainError('MEM_CLOCK_INVALID', 'occurredAt must be a valid Date');
  }
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: occurredAt.toISOString(),
    payload,
  };
}

/** Pure event factory — the only way this module builds events. */
export function memoryEvent<TName extends MemoryEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): MemoryEvent<TName, TPayload> {
  return memoryEventAt(name, aggregateId, payload, readClock(clock));
}

// ---------------------------------------------------------------------------
// memory.snapshotTaken
// ---------------------------------------------------------------------------

/**
 * `memory.snapshotTaken` — emitted when a customer's memory was projected.
 * `claims` lists the STABLE CLAIM NAMES included (the evidence for "what did
 * the memory know"); the snapshot itself is the payload of record.
 */
export interface SnapshotTakenPayload {
  readonly customerId: Uuid;
  /** ISO-8601 — mirrors memory.asOf. */
  readonly asOf: string;
  readonly claimCount: number;
  /** Claim names in the snapshot's fixed dimension order. */
  readonly claims: readonly string[];
  /** How many facts (≤ asOf) the customer's memory was built from. */
  readonly factCount: number;
}

export const snapshotTakenEvent = (
  memory: CustomerMemory,
  clock: Clock,
): MemoryEvent<'memory.snapshotTaken', SnapshotTakenPayload> =>
  memoryEvent(
    'memory.snapshotTaken',
    memory.customerId,
    {
      customerId: memory.customerId,
      asOf: memory.asOf,
      claimCount: memory.claims.length,
      claims: memory.claims.map((claim) => claim.claim),
      factCount: memory.factCount,
    },
    clock,
  );

// ---------------------------------------------------------------------------
// memory.behaviorChanged
// ---------------------------------------------------------------------------

/** One dimension's significant change — payload shape of memory.behaviorChanged. */
export interface BehaviorChangedDimension {
  readonly dimension: string;
  readonly direction: 'improving' | 'deteriorating';
  readonly before: number | null;
  readonly after: number | null;
  /** The significance threshold that was crossed (transparent, configurable). */
  readonly threshold: number;
  /** Exposure rows only: the currency the amounts are denominated in. */
  readonly currency?: string;
  /** Human-readable, deterministic explanation. */
  readonly reason: string;
}

export interface BehaviorChangedPayload {
  readonly customerId: Uuid;
  /** ISO-8601 — the `asOf` of the AFTER snapshot. */
  readonly asOf: string;
  /** Only the dimensions that crossed a threshold — stable rows stay silent. */
  readonly changes: readonly BehaviorChangedDimension[];
  /** Union of the evidence refs behind every reported dimension. */
  readonly evidenceRefs: readonly string[];
}
