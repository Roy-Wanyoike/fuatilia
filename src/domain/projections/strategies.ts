/**
 * Collections strategies per segment (issue #24, SPEC §19 strategy engine).
 *
 * `strategyFor(segment, overrides?)` is the pure, explainable mapping from a
 * stable segment to a named collections strategy; `assignStrategies(...)`
 * applies it across a batch of segment assignments with per-customer
 * explicit overrides. SPEC §19's example decision tables map cleanly:
 *
 *   high_value_reliable → self_serve_reminders   (friendly, low-touch —
 *                                                 high value + low risk gets
 *                                                 autonomy, not pressure)
 *   watch               → guided_follow_up        (standard cadence)
 *   at_risk             → intensive_follow_up     (hands-on sequences)
 *   chronic_late        → escalate_early          (SPEC §19: repeated broken
 *                                                 promises + deep overdue →
 *                                                 human escalation early)
 *   dormant             → self_serve_reminders    (no active pursuit — the
 *                                                 lightest possible touch)
 *
 * Override precedence (explainable, tested): explicit per-CUSTOMER override
 * > explicit per-SEGMENT override > default mapping. Every result names its
 * `source` and a machine-readable `reason`, so "why is this customer on the
 * escalation track?" always has an answer.
 *
 * Strategies are NAMES, not executions: this lane never contacts a customer,
 * never moves money, never writes fund truth — execution lanes consume the
 * `segment.strategyAssigned` events (events.ts).
 */
import { DomainError, type Uuid } from '../shared';
import { assertUuidShape } from './facts';
import { SEGMENTS, type Segment, type SegmentAssignment } from './segments';

export const STRATEGIES = ['self_serve_reminders', 'guided_follow_up', 'intensive_follow_up', 'escalate_early'] as const;
export type CollectionsStrategy = (typeof STRATEGIES)[number];

/** The default segment → strategy mapping. Frozen; overrides layer on top, never mutate it. */
export const DEFAULT_STRATEGIES: Readonly<Record<Segment, CollectionsStrategy>> = Object.freeze({
  high_value_reliable: 'self_serve_reminders',
  watch: 'guided_follow_up',
  at_risk: 'intensive_follow_up',
  chronic_late: 'escalate_early',
  dormant: 'self_serve_reminders',
});

/** Caller-supplied explicit overrides. Keys/values are validated (stable codes). */
export interface StrategyOverrides {
  /** Replace the default strategy for whole segments. */
  readonly bySegment?: Partial<Record<Segment, CollectionsStrategy>>;
  /** Replace the strategy for specific customers (keyed by their opaque Uuid). */
  readonly byCustomer?: Readonly<Record<string, CollectionsStrategy>>;
}

export type StrategySource = 'default' | 'segment_override' | 'customer_override';

export interface StrategyAssignment {
  readonly segment: Segment;
  readonly strategy: CollectionsStrategy;
  /** Where the strategy came from — always explicit. */
  readonly source: StrategySource;
  /** Machine-readable explanation of the choice. */
  readonly reason: string;
}

/** A strategy assignment tied to its customer (what segment.strategyAssigned events carry). */
export interface CustomerStrategyAssignment extends StrategyAssignment {
  readonly customerId: Uuid;
}

const assertSegment = (segment: unknown): Segment => {
  if (typeof segment !== 'string' || !(SEGMENTS as readonly string[]).includes(segment)) {
    throw new DomainError('SEG_SEGMENT_UNKNOWN', `unknown segment ${String(segment)} — see SEGMENTS`, { segment });
  }
  return segment as Segment;
};

const assertStrategy = (value: unknown, code: string, field: string): CollectionsStrategy => {
  if (typeof value !== 'string' || !(STRATEGIES as readonly string[]).includes(value)) {
    throw new DomainError(code, `${field} must be one of ${STRATEGIES.join('|')}, got ${String(value)}`, { field });
  }
  return value as CollectionsStrategy;
};

const assertOverrides = (overrides: StrategyOverrides): void => {
  if (overrides.bySegment !== undefined) {
    for (const [segment, strategy] of Object.entries(overrides.bySegment)) {
      if (!(SEGMENTS as readonly string[]).includes(segment)) {
        throw new DomainError('SEG_OVERRIDE_SEGMENT_UNKNOWN', `override for unknown segment ${segment}`, { segment });
      }
      assertStrategy(strategy, 'SEG_STRATEGY_INVALID', `bySegment.${segment}`);
    }
  }
  if (overrides.byCustomer !== undefined) {
    for (const [customerId, strategy] of Object.entries(overrides.byCustomer)) {
      assertUuidShape(customerId, 'SEG_OVERRIDE_CUSTOMER_INVALID', 'byCustomer key');
      assertStrategy(strategy, 'SEG_STRATEGY_INVALID', `byCustomer.${customerId}`);
    }
  }
};

/**
 * Map ONE segment to its strategy — the pure SPEC §19 mapping with
 * segment-level overrides applied. Explainable: `source` + `reason` always
 * name how the decision was made.
 */
export function strategyFor(segment: Segment, overrides: StrategyOverrides = {}): StrategyAssignment {
  assertSegment(segment);
  assertOverrides(overrides);
  const overridden = overrides.bySegment?.[segment];
  if (overridden !== undefined) {
    return {
      segment,
      strategy: overridden,
      source: 'segment_override',
      reason: `explicit segment override for '${segment}'`,
    };
  }
  return {
    segment,
    strategy: DEFAULT_STRATEGIES[segment],
    source: 'default',
    reason: `default mapping for segment '${segment}'`,
  };
}

/**
 * Assign strategies across a batch of segment assignments with full
 * override precedence: per-customer > per-segment > default. Input order is
 * preserved; every row is explainable.
 */
export function assignStrategies(
  assignments: readonly SegmentAssignment[],
  overrides: StrategyOverrides = {},
): readonly CustomerStrategyAssignment[] {
  assertOverrides(overrides);
  return assignments.map((assignment) => {
    assertSegment(assignment.segment);
    const customerOverride = overrides.byCustomer?.[assignment.customerId];
    if (customerOverride !== undefined) {
      return {
        customerId: assignment.customerId,
        segment: assignment.segment,
        strategy: customerOverride,
        source: 'customer_override',
        reason: 'explicit customer override',
      };
    }
    const segmentResult = strategyFor(assignment.segment, overrides);
    return { customerId: assignment.customerId, ...segmentResult };
  });
}
