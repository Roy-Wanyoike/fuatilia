/**
 * diffProfiles — behavior-change detection over two point-in-time memories
 * (issue #37, VISION §3.3 "Recent behavior: Deteriorating").
 *
 * Compares the same customer's memory before vs after and classifies each
 * behavioral dimension as `improving | stable | deteriorating` against a
 * TRANSPARENT, configurable significance threshold (safe defaults below).
 * Changes below threshold are SILENT: they appear in `changes` (explainability
 * — you can always ask what was compared) but never emit an event. Only a
 * threshold crossing emits the typed fact:
 *
 *   memory.behaviorChanged   (= the VISION's customer.behavior.changed, §3.10)
 *
 * Metric semantics per dimension (documented so callers can rely on them):
 *   payment_cadence     median days-to-pay — lower is better; missing claim on
 *                       either side ⇒ not comparable ⇒ stable (a customer with
 *                       no payment history is not "stable", it is unknown);
 *   promise_reliability kept rate (0..1) — higher is better; same missing rule;
 *   exposure            open balance per currency in minor units — higher is
 *                       worse; a missing claim counts as 0 (nothing owed);
 *   disputes            currently-open count — higher is worse; missing ⇒ 0.
 *
 * Pure: (before, after, clock, thresholds?) → result. The clock is read ONCE
 * and only stamps the emitted event's occurredAt — classification itself is
 * clock-free.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { MEMORY_CLAIMS, type Claim } from './claims';
import { isIsoTimestamp } from './facts';
import type { CustomerMemory } from './snapshot';
import { claimOf } from './snapshot';
import {
  memoryEventAt,
  readClock,
  type BehaviorChangedDimension,
  type BehaviorChangedPayload,
  type MemoryEvent,
} from './events';

export type DiffDimension =
  | 'payment_cadence'
  | 'promise_reliability'
  | 'exposure'
  | 'disputes';

export type DiffDirection = 'improving' | 'stable' | 'deteriorating';

/** Significance thresholds — |Δ| ≥ threshold means the change is significant. */
export interface DiffThresholds {
  /** Median days-to-pay change (whole days). Default 3. */
  readonly cadenceMedianDays?: number;
  /** Kept-rate change (0..1). Default 0.1. */
  readonly reliabilityRate?: number;
  /** Open-balance change per currency (minor units). Default 500_000 (5,000.00). */
  readonly exposureMinor?: number;
  /** Currently-open disputes change (whole disputes). Default 1. */
  readonly disputeCount?: number;
}

/** Safe defaults — deliberately coarse so ordinary noise stays silent. */
export const DEFAULT_DIFF_THRESHOLDS: Required<DiffThresholds> = {
  cadenceMedianDays: 3,
  reliabilityRate: 0.1,
  exposureMinor: 500_000,
  disputeCount: 1,
};

/** One dimension's classified change, with its full evidence chain. */
export interface BehaviorChange {
  readonly dimension: DiffDimension;
  readonly direction: DiffDirection;
  /** Metric before / after (null = no comparable claim on that side). */
  readonly before: number | null;
  readonly after: number | null;
  /** The configured significance threshold applied to this row. */
  readonly threshold: number;
  /** Exposure rows only. */
  readonly currency?: string;
  /** Deterministic human-readable explanation. */
  readonly reason: string;
  /** Evidence anchors: union of both sides' claim evidence (before first). */
  readonly computedFrom: readonly Uuid[];
}

export interface DiffResult {
  readonly customerId: Uuid;
  /** The AFTER snapshot's asOf. */
  readonly asOf: string;
  /** One row per comparable dimension, fixed order, stable rows included. */
  readonly changes: readonly BehaviorChange[];
  /** Set iff at least one dimension crossed its threshold; otherwise null. */
  readonly event: MemoryEvent<'memory.behaviorChanged', BehaviorChangedPayload> | null;
}

const isNonBlank = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const requireNumber = (value: unknown, path: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new DomainError(
      'MEM_SNAPSHOT_INVALID',
      `${path}: expected a finite number, got ${String(value)}`,
      { path },
    );
  }
  return value;
};

const assertMemoryArg = (memory: CustomerMemory, label: string): void => {
  if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) {
    throw new DomainError('MEM_SNAPSHOT_INVALID', `${label} must be a CustomerMemory object`);
  }
  if (!isNonBlank(memory.customerId) || !Array.isArray(memory.claims)) {
    throw new DomainError(
      'MEM_SNAPSHOT_INVALID',
      `${label} must carry a customerId and a claims array`,
      { label },
    );
  }
  if (!isIsoTimestamp(memory.asOf)) {
    throw new DomainError(
      'MEM_SNAPSHOT_INVALID',
      `${label}.asOf must be ISO-8601 (e.g. 2026-03-02T08:00:00.000Z), got ${String(memory.asOf)}`,
      { label, asOf: String(memory.asOf) },
    );
  }
};

/** Validate + fill the threshold config — negative or non-finite is refused. */
export function resolveDiffThresholds(thresholds: DiffThresholds = {}): Required<DiffThresholds> {
  const merged: Required<DiffThresholds> = { ...DEFAULT_DIFF_THRESHOLDS, ...thresholds };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new DomainError(
        'MEM_THRESHOLD_INVALID',
        `threshold "${key}" must be a finite number ≥ 0, got ${String(value)}`,
        { key, value: String(value) },
      );
    }
  }
  return merged;
}

/**
 * |Δ| ≥ threshold ⇒ significant; Δ = 0 is always stable.
 *
 * The delta is rounded to 12 decimal places before comparing: IEEE-754 noise
 * (0.4 − 0.5 = −0.09999999999999998) must never flip a classification at the
 * exact threshold. Deterministic — a pure function of the two metrics.
 */
const classify = (
  delta: number,
  threshold: number,
  upMeans: Exclude<DiffDirection, 'stable'>,
): DiffDirection => {
  const rounded = Number(delta.toFixed(12));
  if (rounded === 0 || Math.abs(rounded) < threshold) return 'stable';
  if (rounded > 0) return upMeans;
  return upMeans === 'improving' ? 'deteriorating' : 'improving';
};

const unionEvidence = (before?: Claim, after?: Claim): Uuid[] => [
  ...new Set([...(before?.computedFrom ?? []), ...(after?.computedFrom ?? [])]),
];

const claimMetric = (claim: Claim | undefined, field: string): number | null => {
  if (!claim) return null;
  const value = claim.value as Record<string, unknown>;
  return requireNumber(value[field], `claim "${claim.claim}".${field}`);
};

interface ExposureRow {
  readonly currency: string;
  readonly openMinor: number;
}

const exposureRows = (claim: Claim | undefined): ExposureRow[] => {
  if (!claim) return [];
  const value = claim.value as { currencies?: unknown };
  if (!Array.isArray(value.currencies)) {
    throw new DomainError(
      'MEM_SNAPSHOT_INVALID',
      `claim "${MEMORY_CLAIMS.exposure}": value.currencies must be an array`,
    );
  }
  return value.currencies.map((row) => {
    const record = row as { currency?: unknown; openMinor?: unknown };
    if (!isNonBlank(record.currency)) {
      throw new DomainError(
        'MEM_SNAPSHOT_INVALID',
        `claim "${MEMORY_CLAIMS.exposure}": a currency row requires a currency code`,
      );
    }
    return {
      currency: record.currency,
      openMinor: requireNumber(record.openMinor, `claim "${MEMORY_CLAIMS.exposure}".openMinor`),
    };
  });
};

/**
 * Compare two point-in-time memories of the SAME customer.
 *
 * Throws:
 *   - MEM_SNAPSHOT_INVALID — malformed before/after argument (or a malformed
 *     claim value inside — snapshots are normally produced by memorySnapshot);
 *   - MEM_CUSTOMER_MISMATCH — the two snapshots speak of different customers;
 *   - MEM_THRESHOLD_INVALID — a threshold is negative or non-finite;
 *   - MEM_CLOCK_INVALID — broken injected clock.
 */
export function diffProfiles(
  before: CustomerMemory,
  after: CustomerMemory,
  clock: Clock,
  thresholds: DiffThresholds = {},
): DiffResult {
  assertMemoryArg(before, 'before');
  assertMemoryArg(after, 'after');
  if (before.customerId !== after.customerId) {
    throw new DomainError(
      'MEM_CUSTOMER_MISMATCH',
      `cannot diff memories of different customers: ${before.customerId} vs ${after.customerId}`,
      { before: before.customerId, after: after.customerId },
    );
  }
  const limits = resolveDiffThresholds(thresholds);
  // ONE clock read per diff — occurredAt is stamped from this instant only
  // (house rule); classification itself is clock-free.
  const occurredAt = readClock(clock);

  const changes: BehaviorChange[] = [];

  // 1. payment_cadence — median days-to-pay; lower is better.
  {
    const beforeClaim = claimOf(before, MEMORY_CLAIMS.cadence);
    const afterClaim = claimOf(after, MEMORY_CLAIMS.cadence);
    const beforeValue = claimMetric(beforeClaim, 'medianDaysToPay');
    const afterValue = claimMetric(afterClaim, 'medianDaysToPay');
    const comparable = beforeValue !== null && afterValue !== null;
    const direction = comparable
      ? classify((afterValue as number) - (beforeValue as number), limits.cadenceMedianDays, 'deteriorating')
      : 'stable';
    const reason = comparable
      ? direction === 'improving'
        ? `median days-to-pay improved from ${beforeValue} to ${afterValue} (threshold ${limits.cadenceMedianDays} days)`
        : direction === 'deteriorating'
          ? `median days-to-pay worsened from ${beforeValue} to ${afterValue} (threshold ${limits.cadenceMedianDays} days)`
          : `median days-to-pay moved from ${beforeValue} to ${afterValue}, within ±${limits.cadenceMedianDays} days`
      : 'not comparable — payment.cadence claim missing on one side (no payment history)';
    changes.push({
      dimension: 'payment_cadence',
      direction,
      before: beforeValue,
      after: afterValue,
      threshold: limits.cadenceMedianDays,
      reason,
      computedFrom: unionEvidence(beforeClaim, afterClaim),
    });
  }

  // 2. promise_reliability — kept rate; higher is better.
  {
    const beforeClaim = claimOf(before, MEMORY_CLAIMS.reliability);
    const afterClaim = claimOf(after, MEMORY_CLAIMS.reliability);
    const beforeValue = claimMetric(beforeClaim, 'rate');
    const afterValue = claimMetric(afterClaim, 'rate');
    const comparable = beforeValue !== null && afterValue !== null;
    const direction = comparable
      ? classify((afterValue as number) - (beforeValue as number), limits.reliabilityRate, 'improving')
      : 'stable';
    const reason = comparable
      ? direction === 'improving'
        ? `promise reliability rate improved from ${beforeValue} to ${afterValue} (threshold ${limits.reliabilityRate})`
        : direction === 'deteriorating'
          ? `promise reliability rate fell from ${beforeValue} to ${afterValue} (threshold ${limits.reliabilityRate})`
          : `promise reliability rate moved from ${beforeValue} to ${afterValue}, within ±${limits.reliabilityRate}`
      : 'not comparable — promise.reliability claim missing on one side (no promise outcomes)';
    changes.push({
      dimension: 'promise_reliability',
      direction,
      before: beforeValue,
      after: afterValue,
      threshold: limits.reliabilityRate,
      reason,
      computedFrom: unionEvidence(beforeClaim, afterClaim),
    });
  }

  // 3. exposure — open balance per currency; higher is worse. Missing ⇒ 0.
  {
    const beforeClaim = claimOf(before, MEMORY_CLAIMS.exposure);
    const afterClaim = claimOf(after, MEMORY_CLAIMS.exposure);
    const beforeRows = exposureRows(beforeClaim);
    const afterRows = exposureRows(afterClaim);
    const currencies = [
      ...new Set([...beforeRows.map((r) => r.currency), ...afterRows.map((r) => r.currency)]),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const currency of currencies) {
      const beforeValue = beforeRows.find((r) => r.currency === currency)?.openMinor ?? 0;
      const afterValue = afterRows.find((r) => r.currency === currency)?.openMinor ?? 0;
      const direction = classify(afterValue - beforeValue, limits.exposureMinor, 'deteriorating');
      const reason =
        direction === 'improving'
          ? `open exposure for ${currency} fell from ${beforeValue} to ${afterValue} minor (threshold ${limits.exposureMinor})`
          : direction === 'deteriorating'
            ? `open exposure for ${currency} grew from ${beforeValue} to ${afterValue} minor (threshold ${limits.exposureMinor})`
            : `open exposure for ${currency} moved from ${beforeValue} to ${afterValue} minor, within ±${limits.exposureMinor}`;
      changes.push({
        dimension: 'exposure',
        direction,
        before: beforeValue,
        after: afterValue,
        threshold: limits.exposureMinor,
        currency,
        reason,
        computedFrom: unionEvidence(beforeClaim, afterClaim),
      });
    }
  }

  // 4. disputes — currently-open count; higher is worse. Missing ⇒ 0.
  {
    const beforeClaim = claimOf(before, MEMORY_CLAIMS.disputes);
    const afterClaim = claimOf(after, MEMORY_CLAIMS.disputes);
    const beforeValue = claimMetric(beforeClaim, 'currentlyOpen') ?? 0;
    const afterValue = claimMetric(afterClaim, 'currentlyOpen') ?? 0;
    const direction = classify(afterValue - beforeValue, limits.disputeCount, 'deteriorating');
    const reason =
      direction === 'improving'
        ? `currently open disputes fell from ${beforeValue} to ${afterValue} (threshold ${limits.disputeCount})`
        : direction === 'deteriorating'
          ? `currently open disputes rose from ${beforeValue} to ${afterValue} (threshold ${limits.disputeCount})`
          : `currently open disputes moved from ${beforeValue} to ${afterValue}, within ±${limits.disputeCount}`;
    changes.push({
      dimension: 'disputes',
      direction,
      before: beforeValue,
      after: afterValue,
      threshold: limits.disputeCount,
      reason,
      computedFrom: unionEvidence(beforeClaim, afterClaim),
    });
  }

  const significant = changes.filter((change) => change.direction !== 'stable');
  const event =
    significant.length === 0
      ? null
      : memoryEventAt<'memory.behaviorChanged', BehaviorChangedPayload>(
          'memory.behaviorChanged',
          after.customerId,
          {
            customerId: after.customerId,
            asOf: after.asOf,
            changes: significant.map(
              ({ dimension, direction, before: b, after: a, threshold, currency, reason }) =>
                ({
                  dimension,
                  direction: direction as Exclude<DiffDirection, 'stable'>,
                  before: b,
                  after: a,
                  threshold,
                  reason,
                  ...(currency === undefined ? {} : { currency }),
                }) satisfies BehaviorChangedDimension,
            ),
            evidenceRefs: [...new Set(significant.flatMap((change) => change.computedFrom))].map(String),
          },
          occurredAt,
        );

  return { customerId: after.customerId, asOf: after.asOf, changes, event };
}
