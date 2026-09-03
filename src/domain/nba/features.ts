/**
 * The next-best-action feature bundle — the engine's ONLY input (issue #36).
 *
 * The bundle is PLAIN DATA, projected by the adapter from the rest of the
 * platform (receivables, promises, disputes, behavior profiles, prior action
 * outcomes — cf. F19/F21/F23, which are separate lanes: this lane defines its
 * own shape and imports none of them). Cross-lane ids travel as opaque
 * `Uuid`s and are never dereferenced here.
 *
 * Every field exists because the transparent scoring expression in `rank.ts`
 * consumes it:
 *
 *   - amountMinor/currency/ageDays  → expected-recovery proxy + age decay;
 *   - riskClass                     → risk multiplier (high risk collects less);
 *   - paymentHistory                → payers with a good record respond better;
 *   - promise (state + reliability) → a pending promise suppresses outreach,
 *     scaled by how reliable the customer's promises are;
 *   - disputeOpen                   → SPEC §29: open disputes pause aggressive
 *     automation and demand human review;
 *   - channelPreferences            → channel fit (opt-in/opt-out, K2/DPA);
 *   - recentActions (counts + recency as whole-day ages, supplied by the
 *     caller) → fatigue penalties + per-action caps;
 *   - priorOutcomes                 → an `opted_out` outcome is a hard stop
 *     for customer-facing automation (consent is never implied).
 *
 * Recency travels IN the bundle as non-negative whole `daysAgo` integers, so
 * ranking itself is a pure function of plain data — the injected Clock is
 * only needed for event envelopes and feedback timestamps.
 *
 * All arithmetic downstream is integer-only (bps/‰); `reliabilityPermill`
 * is 0–1000 so no float ever enters the pipeline.
 */
import { CURRENCIES, DomainError, type Currency, type Uuid } from '../shared';
import {
  NBA_ACTIONS,
  NBA_CONTACT_CHANNELS,
  assertNbaActionType,
  type NbaActionType,
  type NbaContactChannel,
} from './actions';

// --- enums -------------------------------------------------------------------------

export const NBA_RISK_CLASSES = ['low', 'moderate', 'elevated', 'high'] as const;
export type NbaRiskClass = (typeof NBA_RISK_CLASSES)[number];

export const NBA_PROMISE_STATES = ['none', 'pending', 'broken', 'fulfilled'] as const;
export type NbaPromiseState = (typeof NBA_PROMISE_STATES)[number];

export const NBA_CHANNEL_PREFERENCES = ['opted_in', 'neutral', 'opted_out'] as const;
export type NbaChannelPreference = (typeof NBA_CHANNEL_PREFERENCES)[number];

/**
 * Outcomes of PRIOR executed actions, as summarized by the caller. The same
 * vocabulary the feedback hook records (`NbaOutcome` in feedback.ts) — the
 * bundle replays historical outcomes the same way the feedback ledger stores
 * them, so adapters project both from one source of truth.
 */
export const NBA_OUTCOMES = ['paid', 'partial', 'promise_made', 'no_response', 'escalated', 'opted_out'] as const;
export type NbaOutcome = (typeof NBA_OUTCOMES)[number];

/**
 * Upper bound for a scorable amount. The largest signal factor is 15 000bps,
 * so scoring multiplies amounts by up to 15 — this bound (× 15 = the
 * safe-integer ceiling) guarantees every intermediate product in `rank.ts`'s
 * exact integer arithmetic stays within `Number.MAX_SAFE_INTEGER`.
 * 600 trillion minor units (e.g. KES 6 trillion at 100 minor/KES) is far
 * above any real receivable.
 */
export const NBA_MAX_SCORABLE_AMOUNT_MINOR = 600_000_000_000_000;

// --- bundle -----------------------------------------------------------------------

/** One recent executed action: what, and how many whole days ago. */
export interface NbaRecentAction {
  readonly action: NbaActionType;
  /** Whole days since the action was executed (0 = today); ≥ 0. */
  readonly daysAgo: number;
}

/** One historical outcome of an executed action (same vocabulary as feedback). */
export interface NbaPriorOutcome {
  readonly action: NbaActionType;
  readonly outcome: NbaOutcome;
}

/**
 * The plain-data feature bundle per receivable/customer. Optional sections
 * default to neutral signals (no promise, no dispute, no history) so a
 * minimal bundle of ids + amount + age is enough to rank.
 */
export interface NbaFeatureBundle {
  readonly orgId: Uuid;
  readonly customerId: Uuid;
  /** Opaque receivable id the recommendation is for. */
  readonly receivableId: Uuid;
  /** Outstanding balance in minor units (safe integer ≥ 0). */
  readonly amountMinor: number;
  readonly currency: Currency;
  /** Whole days since the receivable was issued (safe integer ≥ 0). */
  readonly ageDays: number;
  readonly riskClass: NbaRiskClass;
  /** Payment history summary — counts of past settlements by punctuality. */
  readonly paymentHistory: {
    readonly onTime: number;
    readonly late: number;
    readonly unpaid: number;
  };
  /** Promise-to-pay state + the customer's promise reliability (0–1000‰). */
  readonly promise?: {
    readonly state: NbaPromiseState;
    readonly reliabilityPermill: number;
  };
  /** An open dispute pauses aggressive automation (SPEC §29). */
  readonly disputeOpen?: boolean;
  /** Per-channel contact preferences; channels not listed count as neutral. */
  readonly channelPreferences?: Partial<Record<NbaContactChannel, NbaChannelPreference>>;
  /** Recently executed actions (fatigue input — counts + recency). */
  readonly recentActions?: readonly NbaRecentAction[];
  /** Historical outcomes of executed actions (signal input). */
  readonly priorOutcomes?: readonly NbaPriorOutcome[];
}

// --- validation (defensive: the bundle is caller-supplied plain data) --------------

const assertId = (value: Uuid, field: string): Uuid => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DomainError('NBA_ID_REQUIRED', `the feature bundle requires a non-blank ${field}`, {
      field,
    });
  }
  return value;
};

const assertSafeNonNegativeInt = (value: unknown, code: string, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(code, `${label} must be a safe integer ≥ 0, got ${String(value)}`, {
      field: label,
      value: String(value),
    });
  }
  return value;
};

/**
 * Validate a feature bundle. Pure: returns the same bundle (typed), never
 * mutates it. Throws stable `NBA_*` codes naming the malformed field.
 */
export function validateNbaFeatureBundle(bundle: NbaFeatureBundle): NbaFeatureBundle {
  assertId(bundle.orgId, 'orgId');
  assertId(bundle.customerId, 'customerId');
  assertId(bundle.receivableId, 'receivableId');
  assertSafeNonNegativeInt(bundle.amountMinor, 'NBA_AMOUNT_INVALID', 'amountMinor');
  if (bundle.amountMinor > NBA_MAX_SCORABLE_AMOUNT_MINOR) {
    throw new DomainError(
      'NBA_AMOUNT_INVALID',
      `amountMinor must be ≤ ${NBA_MAX_SCORABLE_AMOUNT_MINOR} (the scoring safe-integer headroom), got ${String(bundle.amountMinor)}`,
      { amountMinor: String(bundle.amountMinor), max: NBA_MAX_SCORABLE_AMOUNT_MINOR },
    );
  }
  if (!(CURRENCIES as readonly string[]).includes(bundle.currency)) {
    throw new DomainError('NBA_CURRENCY_INVALID', `unknown currency: ${String(bundle.currency)}`, {
      currency: String(bundle.currency),
      allowed: CURRENCIES,
    });
  }
  assertSafeNonNegativeInt(bundle.ageDays, 'NBA_AGE_INVALID', 'ageDays');
  if (!(NBA_RISK_CLASSES as readonly string[]).includes(bundle.riskClass)) {
    throw new DomainError('NBA_RISK_INVALID', `unknown risk class: ${String(bundle.riskClass)}`, {
      riskClass: String(bundle.riskClass),
      allowed: NBA_RISK_CLASSES,
    });
  }

  const history = bundle.paymentHistory;
  if (history === undefined || history === null || typeof history !== 'object') {
    throw new DomainError('NBA_HISTORY_INVALID', 'paymentHistory is required', {});
  }
  assertSafeNonNegativeInt(history.onTime, 'NBA_HISTORY_INVALID', 'paymentHistory.onTime');
  assertSafeNonNegativeInt(history.late, 'NBA_HISTORY_INVALID', 'paymentHistory.late');
  assertSafeNonNegativeInt(history.unpaid, 'NBA_HISTORY_INVALID', 'paymentHistory.unpaid');

  if (bundle.promise !== undefined) {
    const promise = bundle.promise;
    if (promise === null || typeof promise !== 'object') {
      throw new DomainError('NBA_PROMISE_STATE_INVALID', 'promise must be an object when present', {});
    }
    if (!(NBA_PROMISE_STATES as readonly string[]).includes(promise.state)) {
      throw new DomainError('NBA_PROMISE_STATE_INVALID', `unknown promise state: ${String(promise.state)}`, {
        state: String(promise.state),
        allowed: NBA_PROMISE_STATES,
      });
    }
    const reliability = promise.reliabilityPermill;
    if (typeof reliability !== 'number' || !Number.isSafeInteger(reliability) || reliability < 0 || reliability > 1000) {
      throw new DomainError(
        'NBA_RELIABILITY_INVALID',
        `promise.reliabilityPermill must be a safe integer in 0..1000, got ${String(reliability)}`,
        { reliabilityPermill: String(reliability) },
      );
    }
  }

  if (bundle.disputeOpen !== undefined && typeof bundle.disputeOpen !== 'boolean') {
    throw new DomainError('NBA_DISPUTE_FLAG_INVALID', 'disputeOpen must be a boolean when present', {
      disputeOpen: String(bundle.disputeOpen),
    });
  }

  if (bundle.channelPreferences !== undefined) {
    const prefs = bundle.channelPreferences;
    if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) {
      throw new DomainError('NBA_CHANNEL_PREF_INVALID', 'channelPreferences must be an object when present', {});
    }
    for (const [channel, preference] of Object.entries(prefs)) {
      if (!(NBA_CONTACT_CHANNELS as readonly string[]).includes(channel)) {
        throw new DomainError('NBA_CHANNEL_PREF_INVALID', `unknown channel preference key: ${channel}`, {
          channel,
          allowed: NBA_CONTACT_CHANNELS,
        });
      }
      if (!(NBA_CHANNEL_PREFERENCES as readonly string[]).includes(preference as string)) {
        throw new DomainError(
          'NBA_CHANNEL_PREF_INVALID',
          `unknown preference for ${channel}: ${String(preference)}`,
          { channel, preference: String(preference), allowed: NBA_CHANNEL_PREFERENCES },
        );
      }
    }
  }

  for (const recent of bundle.recentActions ?? []) {
    if (recent === null || typeof recent !== 'object') {
      throw new DomainError('NBA_RECENT_ACTION_INVALID', 'recentActions entries must be objects', {});
    }
    assertNbaActionType(recent.action); // throws NBA_ACTION_INVALID naming the value
    assertSafeNonNegativeInt(recent.daysAgo, 'NBA_RECENT_ACTION_INVALID', 'recentActions.daysAgo');
  }

  for (const prior of bundle.priorOutcomes ?? []) {
    if (prior === null || typeof prior !== 'object') {
      throw new DomainError('NBA_PRIOR_OUTCOME_INVALID', 'priorOutcomes entries must be objects', {});
    }
    if (!(NBA_ACTIONS as readonly string[]).includes(prior.action)) {
      throw new DomainError('NBA_ACTION_INVALID', `unknown NBA action: ${String(prior.action)}`, {
        action: String(prior.action),
        allowed: NBA_ACTIONS,
      });
    }
    if (!(NBA_OUTCOMES as readonly string[]).includes(prior.outcome)) {
      throw new DomainError('NBA_PRIOR_OUTCOME_INVALID', `unknown prior outcome: ${String(prior.outcome)}`, {
        outcome: String(prior.outcome),
        allowed: NBA_OUTCOMES,
      });
    }
  }

  return bundle;
}

