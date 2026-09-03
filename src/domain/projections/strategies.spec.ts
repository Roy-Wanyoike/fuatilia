import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { DEFAULT_STRATEGIES, STRATEGIES, assignStrategies, strategyFor, type StrategyOverrides } from './strategies';
import { SEGMENTS, type SegmentAssignment } from './segments';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const assignment = (n: number, segment: SegmentAssignment['segment']): SegmentAssignment => ({
  customerId: uid(n),
  segment,
  reasons: ['test — matrix condition fired'],
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

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// --- tests ------------------------------------------------------------------

describe('strategyFor — the default SPEC §19 mapping', () => {
  it.each([
    ['high_value_reliable', 'self_serve_reminders'], // friendly, low-touch: autonomy, not pressure
    ['watch', 'guided_follow_up'], // standard cadence
    ['at_risk', 'intensive_follow_up'], // hands-on sequences
    ['chronic_late', 'escalate_early'], // repeated broken promises + deep overdue → humans, early
    ['dormant', 'self_serve_reminders'], // no active pursuit — lightest possible touch
  ] as const)('%s → %s', (segment, strategy) => {
    const result = strategyFor(segment);
    expect(result).toEqual({
      segment,
      strategy,
      source: 'default',
      reason: `default mapping for segment '${segment}'`,
    });
  });

  it('is complete: every stable segment maps, and every named strategy is reachable', () => {
    for (const segment of SEGMENTS) {
      const result = strategyFor(segment);
      expect(STRATEGIES).toContain(result.strategy);
    }
    expect(new Set(Object.values(DEFAULT_STRATEGIES)).size).toBe(STRATEGIES.length); // all four used
    expect(Object.isFrozen(DEFAULT_STRATEGIES)).toBe(true);
  });

  it('strategies are NAMES, not executions — results carry no channel, timing or payload', () => {
    const result = strategyFor('chronic_late');
    expect(Object.keys(result).sort()).toEqual(['reason', 'segment', 'source', 'strategy'].sort());
    expect(typeof result.strategy).toBe('string');
  });
});

describe('strategyFor — segment-level overrides', () => {
  it('an explicit per-segment override replaces the default and names its source', () => {
    const result = strategyFor('watch', { bySegment: { watch: 'intensive_follow_up' } });
    expect(result.strategy).toBe('intensive_follow_up');
    expect(result.source).toBe('segment_override');
    expect(result.reason).toBe("explicit segment override for 'watch'");
    expect(result.segment).toBe('watch');
  });

  it('overrides are scoped: other segments keep the default mapping', () => {
    const overrides: StrategyOverrides = { bySegment: { watch: 'intensive_follow_up' } };
    expect(strategyFor('watch', overrides).source).toBe('segment_override');
    expect(strategyFor('at_risk', overrides).source).toBe('default');
    expect(strategyFor('at_risk', overrides).strategy).toBe('intensive_follow_up');
  });
});

describe('assignStrategies — override precedence (customer > segment > default)', () => {
  const assignments = [assignment(1, 'high_value_reliable'), assignment(2, 'watch'), assignment(3, 'at_risk')];

  it('no overrides → the default mapping for every row', () => {
    const results = assignStrategies(assignments);
    expect(results.map((r) => r.strategy)).toEqual(['self_serve_reminders', 'guided_follow_up', 'intensive_follow_up']);
    expect(results.every((r) => r.source === 'default')).toBe(true);
  });

  it('per-customer override beats a per-segment override for the same customer', () => {
    const overrides: StrategyOverrides = {
      bySegment: { at_risk: 'escalate_early' },
      byCustomer: { [uid(3)]: 'guided_follow_up' }, // explicit exception to the segment rule
    };
    const [high, watch, atRisk] = assignStrategies(assignments, overrides);
    expect(high!.strategy).toBe('self_serve_reminders'); // default
    expect(watch!.strategy).toBe('guided_follow_up'); // default (no segment override for watch here)
    expect(atRisk!.source).toBe('customer_override'); // customer beats segment
    expect(atRisk!.strategy).toBe('guided_follow_up');
    expect(atRisk!.reason).toBe('explicit customer override');
  });

  it('per-segment override beats the default for every customer in that segment', () => {
    const results = assignStrategies(assignments, { bySegment: { watch: 'intensive_follow_up' } });
    const watch = results.find((r) => r.customerId === uid(2))!;
    expect(watch.source).toBe('segment_override');
    expect(watch.strategy).toBe('intensive_follow_up');
  });

  it('preserves input order, carries the segment and every explainability field', () => {
    const results = assignStrategies(assignments);
    expect(results.map((r) => r.customerId)).toEqual(assignments.map((a) => a.customerId));
    for (const result of results) {
      expect(result.segment).toBe(assignments.find((a) => a.customerId === result.customerId)!.segment);
      expect(typeof result.reason).toBe('string');
      expect(['default', 'segment_override', 'customer_override']).toContain(result.source);
    }
  });

  it('never mutates its inputs (frozen pin)', () => {
    const frozen = deepFreeze(assignments);
    const overrides = deepFreeze({ bySegment: { watch: 'intensive_follow_up' as const } });
    let results: ReturnType<typeof assignStrategies> | undefined;
    expect(() => (results = assignStrategies(frozen, overrides))).not.toThrow();
    expect(results).toHaveLength(3);
  });
});

describe('stable error codes for segments/strategies/overrides', () => {
  it.each([
    ['unknown segment', () => strategyFor('vip' as never), 'SEG_SEGMENT_UNKNOWN'],
    ['override targets an unknown segment', () => strategyFor('watch', { bySegment: { vip: 'guided_follow_up' } as never }), 'SEG_OVERRIDE_SEGMENT_UNKNOWN'],
    ['override strategy is not a named strategy', () => strategyFor('watch', { bySegment: { watch: 'phone_them' as never } }), 'SEG_STRATEGY_INVALID'],
    ['customer override key is not uuid-shaped', () => assignStrategies([], { byCustomer: { 'cust-1': 'guided_follow_up' } }), 'SEG_OVERRIDE_CUSTOMER_INVALID'],
    ['customer override value is not a named strategy', () => assignStrategies([], { byCustomer: { [uid(1)]: 'shout' as never } }), 'SEG_STRATEGY_INVALID'],
    ['assignment carries an unknown segment', () => assignStrategies([{ customerId: uid(1), segment: 'nope' as never, reasons: [] }]), 'SEG_SEGMENT_UNKNOWN'],
  ])('%s → %s', (_label, fn, code) => {
    expectCode(fn, code);
  });
});
