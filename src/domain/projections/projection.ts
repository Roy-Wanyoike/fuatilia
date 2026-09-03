/**
 * Cash-collection projection (issue #24, SPEC §20 "Clearly label predictions
 * as predictions" + §22 "Clearly distinguish actual values from predictions").
 *
 * `projectCollections(receivables, behaviorFacts, horizonDays, clock)` answers
 * "how much of the outstanding book do we EXPECT to collect within the next
 * N days?" with three bands — pessimistic / expected / optimistic — built
 * from simple, transparent, fully documented rules:
 *
 *   1. Scope: receivables with balance > 0 and due on/before the horizon end
 *      (already-overdue debt is in scope — it is exactly what collections
 *      chases; receivables due after the horizon cannot be collected in it).
 *   2. Base propensity: the customer's behavior fact
 *      `collectionPropensity` (share historically collected within a
 *      comparable horizon); customers without a fact get DEFAULT_PROPENSITY
 *      — and the assumption is SURFACED in the assumptions list.
 *   3. Overdue risk haircuts (days past due): ≤30d ×0.8, 31-60d ×0.6,
 *      61-90d ×0.4, >90d ×0.2 — the older the debt, the less of it that
 *      historically converts without escalation.
 *   4. Bands: optimistic propensity ×OPTIMISTIC_LIFT (capped at 1),
 *      pessimistic propensity ×PESSIMISTIC_DISCOUNT, both BEFORE haircuts,
 *      so pessimistic ≤ expected ≤ optimistic holds by construction.
 *   5. Disputed receivables (SPEC §29 pause) are excluded from ALL bands —
 *      surfacing that as an assumption line, never silently.
 *
 * Fraction application uses `Money.allocate` ([fraction, 1−fraction]) so the
 * applied part + remainder always sum back to the balance: no cent is
 * invented, no float ever touches the ledger-adjacent arithmetic, and the
 * result is deterministic for identical inputs.
 *
 * STRUCTURAL CONTRACT (tested): every projection output carries
 * `kind: 'projection'` + an `assumptions` list, and contains NO actual
 * balance field — actuals live in aging snapshots (`kind: 'actual'`) and
 * the two structures are never mixed. A projection is a labeled prediction,
 * never a balance.
 */
import { DomainError, Money, type Clock, type Currency, type Uuid } from '../shared';
import {
  nowMs,
  parseBehaviorFacts,
  parseReceivableFacts,
  type BehaviorFact,
  type ParsedReceivable,
  type ReceivableFact,
} from './facts';
import { daysOverdue } from './aging';

/** The transparent, frozen rule set — exported so callers/agents can read the exact knobs. */
export const PROJECTION_RULES = Object.freeze({
  /** Propensity assumed for customers with no behavior fact (surfaced as an assumption). */
  DEFAULT_PROPENSITY: 0.5,
  /** Optimistic band: propensity lifted before haircuts, capped at 1. */
  OPTIMISTIC_LIFT: 1.25,
  /** Pessimistic band: propensity discounted before haircuts. */
  PESSIMISTIC_DISCOUNT: 0.75,
  /** Overdue haircuts: first tier whose maxDays covers the days past due. */
  OVERDUE_HAIRCUTS: Object.freeze([
    { maxDays: 30, factor: 0.8 },
    { maxDays: 60, factor: 0.6 },
    { maxDays: 90, factor: 0.4 },
    { maxDays: Number.POSITIVE_INFINITY, factor: 0.2 },
  ]) as readonly { readonly maxDays: number; readonly factor: number }[],
});

/** Haircut factor for whole days past due (0 while not overdue). */
export function overdueHaircut(daysPastDue: number): number {
  for (const tier of PROJECTION_RULES.OVERDUE_HAIRCUTS) {
    if (daysPastDue <= tier.maxDays) return tier.factor;
  }
  return PROJECTION_RULES.OVERDUE_HAIRCUTS[PROJECTION_RULES.OVERDUE_HAIRCUTS.length - 1]!.factor;
}

export interface ProjectionBands {
  readonly pessimisticMinor: bigint;
  readonly expectedMinor: bigint;
  readonly optimisticMinor: bigint;
}

export interface ProjectionCurrencyView extends ProjectionBands {
  readonly currency: Currency;
  readonly inScopeCount: number;
  /** Disputed receivables excluded from all bands (dispute pause) in this currency. */
  readonly excludedDisputedCount: number;
}

export interface CollectionsProjection {
  /** Always 'projection' — a labeled prediction, structurally never an actual. */
  readonly kind: 'projection';
  /** ISO-8601 — the instant the projection was computed from. */
  readonly asOf: string;
  readonly horizonDays: number;
  /** ISO-8601 — asOf + horizonDays; receivables due after this are out of scope. */
  readonly horizonEnd: string;
  /** One view per currency in scope, first-seen order. */
  readonly currencies: readonly ProjectionCurrencyView[];
  /** The exact assumptions behind these numbers, human- and machine-readable. */
  readonly assumptions: readonly string[];
  /** In-scope receivable ids backing the bands (input order). */
  readonly evidenceRefs: readonly Uuid[];
}

const DAY_MS = 86_400_000;

/**
 * Split `amount` by a 0..1 fraction via Money.allocate: applied + remainder
 * always sum back to the amount (nothing invented, nothing lost),
 * deterministic, bigint-only.
 */
function applyFraction(amount: Money, fraction: number): Money {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new DomainError('PROJ_FRACTION_INVALID', `fraction must be in [0, 1], got ${String(fraction)}`);
  }
  return amount.allocate([fraction, 1 - fraction])[0]!;
}

/** Bands for one receivable given propensity + haircut (ordering guaranteed: p×D ≤ p ≤ min(1, p×L)). */
function bandFractions(propensity: number, haircut: number): { pessimistic: number; expected: number; optimistic: number } {
  return {
    pessimistic: propensity * PROJECTION_RULES.PESSIMISTIC_DISCOUNT * haircut,
    expected: propensity * haircut,
    optimistic: Math.min(1, propensity * PROJECTION_RULES.OPTIMISTIC_LIFT) * haircut,
  };
}

/**
 * Project collections over the horizon. Pure: the injected Clock supplies
 * `asOf`; nothing is mutated; nothing is persisted; the result is a labeled
 * PROJECTION that shares no structure with actual balances.
 */
export function projectCollections(
  receivables: readonly ReceivableFact[],
  behaviorFacts: readonly BehaviorFact[],
  horizonDays: number,
  clock: Clock,
): CollectionsProjection {
  const asOfTime = nowMs(clock, 'PROJ_CLOCK_INVALID');
  if (typeof horizonDays !== 'number' || !Number.isInteger(horizonDays) || horizonDays < 1) {
    throw new DomainError('PROJ_HORIZON_INVALID', `horizonDays must be an integer >= 1, got ${String(horizonDays)}`);
  }
  const parsed = parseReceivableFacts(receivables);
  const propensityByCustomer = parseBehaviorFacts(behaviorFacts);

  const horizonEndTime = asOfTime + horizonDays * DAY_MS;
  const asOf = new Date(asOfTime).toISOString();
  const horizonEnd = new Date(horizonEndTime).toISOString();

  const order: Currency[] = [];
  const byCurrency = new Map<Currency, { pessimistic: bigint; expected: bigint; optimistic: bigint; inScope: number; disputed: number }>();
  const evidence: Uuid[] = [];
  const defaultedCustomers = new Set<Uuid>();
  let excludedDisputed = 0;
  let skippedZeroBalance = 0;

  for (const receivable of parsed) {
    if (receivable.balance.isZero()) {
      skippedZeroBalance += 1; // nothing outstanding to collect
      continue;
    }
    if (receivable.disputed) {
      excludedDisputed += 1; // SPEC §29 pause — surfaced as an assumption, never silently dropped
      continue;
    }
    if (receivable.dueTime > horizonEndTime) {
      continue; // due after the horizon — cannot be collected within it
    }

    const fact = propensityByCustomer.get(receivable.customerId);
    if (!fact) defaultedCustomers.add(receivable.customerId);
    const propensity = fact?.collectionPropensity ?? PROJECTION_RULES.DEFAULT_PROPENSITY;
    const haircut = overdueHaircut(daysOverdue(receivable.dueTime, asOfTime));
    const fractions = bandFractions(propensity, haircut);

    let acc = byCurrency.get(receivable.currency);
    if (!acc) {
      acc = { pessimistic: 0n, expected: 0n, optimistic: 0n, inScope: 0, disputed: 0 };
      byCurrency.set(receivable.currency, acc);
      order.push(receivable.currency);
    }
    acc.pessimistic += applyFraction(receivable.balance, fractions.pessimistic).amount;
    acc.expected += applyFraction(receivable.balance, fractions.expected).amount;
    acc.optimistic += applyFraction(receivable.balance, fractions.optimistic).amount;
    acc.inScope += 1;
    evidence.push(receivable.receivableId);
  }

  const currencies = order.map((currency) => {
    const acc = byCurrency.get(currency)!;
    return {
      currency,
      pessimisticMinor: acc.pessimistic,
      expectedMinor: acc.expected,
      optimisticMinor: acc.optimistic,
      inScopeCount: acc.inScope,
      excludedDisputedCount: countDisputed(parsed, currency),
    };
  });

  const assumptions: string[] = [
    `scope: receivables with balance > 0 and dueDate <= ${horizonEnd} (asOf ${asOf} + ${horizonDays}d)`,
  ];
  const inScope = evidence.length;
  if (inScope > 0) {
    assumptions.push(
      `overdue haircuts on days past due: <=30d x${PROJECTION_RULES.OVERDUE_HAIRCUTS[0]!.factor}, ` +
        `31-60d x${PROJECTION_RULES.OVERDUE_HAIRCUTS[1]!.factor}, 61-90d x${PROJECTION_RULES.OVERDUE_HAIRCUTS[2]!.factor}, ` +
        `>90d x${PROJECTION_RULES.OVERDUE_HAIRCUTS[3]!.factor}`,
    );
    assumptions.push(
      `bands: optimistic propensity x${PROJECTION_RULES.OPTIMISTIC_LIFT} (capped at 1), ` +
        `pessimistic propensity x${PROJECTION_RULES.PESSIMISTIC_DISCOUNT}, applied before haircuts`,
    );
  }
  if (defaultedCustomers.size > 0) {
    assumptions.push(
      `default propensity ${PROJECTION_RULES.DEFAULT_PROPENSITY} assumed for ${defaultedCustomers.size} customer(s) with no behavior fact`,
    );
  }
  if (excludedDisputed > 0) {
    assumptions.push(`${excludedDisputed} disputed receivable(s) excluded from all bands (dispute pause)`);
  }
  if (skippedZeroBalance > 0) {
    assumptions.push(`${skippedZeroBalance} zero-balance receivable(s) skipped (nothing outstanding)`);
  }

  return {
    kind: 'projection',
    asOf,
    horizonDays,
    horizonEnd,
    currencies,
    assumptions,
    evidenceRefs: evidence,
  };
}

/** Disputed receivables per currency (zero-balance ones are already skipped as zero-balance). */
function countDisputed(parsed: readonly ParsedReceivable[], currency: Currency): number {
  return parsed.filter((r) => r.currency === currency && r.disputed && !r.balance.isZero()).length;
}
