import { describe, expect, it } from 'vitest';
import { DomainError, uuid } from '../shared';
import { NBA_MAX_SCORABLE_AMOUNT_MINOR, validateNbaFeatureBundle } from './features';
import type { NbaFeatureBundle } from './features';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): NbaFeatureBundle['orgId'] =>
  uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const baseBundle: NbaFeatureBundle = {
  orgId: uid(651),
  customerId: uid(652),
  receivableId: uid(653),
  amountMinor: 1_000_000,
  currency: 'KES',
  ageDays: 10,
  riskClass: 'moderate',
  paymentHistory: { onTime: 8, late: 2, unpaid: 0 },
};

/** Bundle fixture — overrides are untyped on purpose: the validation table feeds it junk. */
const bundle = (overrides: Record<string, unknown> = {}): NbaFeatureBundle =>
  ({ ...baseBundle, ...overrides }) as NbaFeatureBundle;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- the happy path ----------------------------------------------------------

describe('validateNbaFeatureBundle — the engine’s only input', () => {
  it('accepts a minimal bundle (ids + amount + age + risk + history)', () => {
    const minimal = bundle({
      promise: undefined,
      disputeOpen: undefined,
      channelPreferences: undefined,
      recentActions: undefined,
      priorOutcomes: undefined,
    });
    expect(validateNbaFeatureBundle(minimal)).toBe(minimal);
  });

  it('accepts a fully-populated bundle and returns it unchanged', () => {
    const full = bundle({
      promise: { state: 'pending', reliabilityPermill: 800 },
      disputeOpen: true,
      channelPreferences: { whatsapp: 'opted_in', sms: 'neutral', call: 'opted_out' },
      recentActions: [{ action: 'call', daysAgo: 2 }, { action: 'sms', daysAgo: 30 }],
      priorOutcomes: [{ action: 'whatsapp', outcome: 'promise_made' }],
    });
    expect(validateNbaFeatureBundle(full)).toEqual(full);
  });

  it('never mutates the bundle (deep-frozen input is read, not written)', () => {
    const frozen = bundle({ recentActions: [{ action: 'call', daysAgo: 1 }] });
    Object.freeze(frozen);
    Object.freeze(frozen.paymentHistory);
    expect(() => validateNbaFeatureBundle(frozen)).not.toThrow();
  });

  // --- the validation table: every malformed field names its stable code ---

  it('refuses malformed bundles field by field (table)', () => {
    const table: Array<[Record<string, unknown>, string]> = [
      [{ orgId: '' }, 'NBA_ID_REQUIRED'],
      [{ customerId: '   ' }, 'NBA_ID_REQUIRED'],
      [{ receivableId: undefined }, 'NBA_ID_REQUIRED'],
      [{ amountMinor: 1.5 }, 'NBA_AMOUNT_INVALID'],
      [{ amountMinor: -100 }, 'NBA_AMOUNT_INVALID'],
      [{ amountMinor: Number.MAX_SAFE_INTEGER + 1 }, 'NBA_AMOUNT_INVALID'],
      [{ amountMinor: NBA_MAX_SCORABLE_AMOUNT_MINOR + 1 }, 'NBA_AMOUNT_INVALID'],
      [{ currency: 'XYZ' }, 'NBA_CURRENCY_INVALID'],
      [{ ageDays: -1 }, 'NBA_AGE_INVALID'],
      [{ ageDays: 2.5 }, 'NBA_AGE_INVALID'],
      [{ riskClass: 'extreme' }, 'NBA_RISK_INVALID'],
      [{ paymentHistory: undefined }, 'NBA_HISTORY_INVALID'],
      [{ paymentHistory: { onTime: -1, late: 0, unpaid: 0 } }, 'NBA_HISTORY_INVALID'],
      [{ paymentHistory: { onTime: 0, late: 0.5, unpaid: 0 } }, 'NBA_HISTORY_INVALID'],
      [{ promise: { state: 'maybe', reliabilityPermill: 500 } }, 'NBA_PROMISE_STATE_INVALID'],
      [{ promise: { state: 'pending', reliabilityPermill: 1001 } }, 'NBA_RELIABILITY_INVALID'],
      [{ promise: { state: 'pending', reliabilityPermill: -1 } }, 'NBA_RELIABILITY_INVALID'],
      [{ disputeOpen: 'yes' }, 'NBA_DISPUTE_FLAG_INVALID'],
      [{ channelPreferences: { email: 'opted_in' } }, 'NBA_CHANNEL_PREF_INVALID'],
      [{ channelPreferences: { whatsapp: 'maybe' } }, 'NBA_CHANNEL_PREF_INVALID'],
      [{ recentActions: [{ action: 'letter', daysAgo: 1 }] }, 'NBA_ACTION_INVALID'],
      [{ recentActions: [{ action: 'call', daysAgo: -2 }] }, 'NBA_RECENT_ACTION_INVALID'],
      [{ recentActions: [{ action: 'call', daysAgo: 1.5 }] }, 'NBA_RECENT_ACTION_INVALID'],
      [{ priorOutcomes: [{ action: 'call', outcome: 'won' }] }, 'NBA_PRIOR_OUTCOME_INVALID'],
      [{ priorOutcomes: [{ action: 'letter', outcome: 'paid' }] }, 'NBA_ACTION_INVALID'],
    ];
    for (const [overrides, code] of table) {
      expectCode(() => validateNbaFeatureBundle(bundle(overrides)), code);
    }
  });

  it('accepts the exact scoring headroom bound and the action vocabulary boundaries', () => {
    expect(validateNbaFeatureBundle(bundle({ amountMinor: NBA_MAX_SCORABLE_AMOUNT_MINOR }))).toEqual(
      bundle({ amountMinor: NBA_MAX_SCORABLE_AMOUNT_MINOR }),
    );
    // every do_nothing-adjacent boundary is a real action
    const allActions = bundle({
      recentActions: [{ action: 'do_nothing', daysAgo: 0 }],
      priorOutcomes: [{ action: 'do_nothing', outcome: 'no_response' }],
    });
    expect(validateNbaFeatureBundle(allActions)).toEqual(allActions);
  });
});
