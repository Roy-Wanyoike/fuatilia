/**
 * Collection effectiveness over a reporting window (issue #24, SPEC §66
 * "Collection rate / Promise fulfillment / Disputes").
 *
 * `collectionEffectiveness(facts, window)` reduces plain window-facts into
 * three explainable ratio figures:
 *
 *   collectedVsBilled  Σ collected minor / Σ billed minor   (money ratio)
 *   promiseKept        kept promises / resolved promises     (count ratio)
 *   disputeRate        disputes raised / invoices billed     (count ratio)
 *
 * Every figure is an ACTUAL (historical) ratio — `kind: 'actual'` on the
 * report — and carries `asOf` (the window end) plus `evidenceRefs` (the ids
 * behind numerator and denominator), so any figure can be audited back to
 * its facts (VISION §3.7: explainability beats an opaque score).
 *
 * A figure that cannot be computed honestly is `value: null` WITH a reason
 * (e.g. nothing billed in the window) — never a silently misleading 0.
 * Ratios may exceed 1 legitimately (collections of invoices billed before
 * the window); they are reported as-is, never clamped.
 *
 * Single-currency by construction (docs/07 R10): the facts carry one
 * currency; every amount is validated and summed through Money.
 */
import { DomainError, Money, type Currency, type Uuid } from '../shared';
import { assertCurrency, assertUuidShape, parseInstant, parseMinorAmount } from './facts';

export interface EffectivenessWindow {
  /** ISO-8601 date or zoned timestamp — inclusive lower bound. */
  readonly from: string;
  /** ISO-8601 date or zoned timestamp — inclusive upper bound. */
  readonly to: string;
}

export interface BilledFact {
  /** Opaque source id (e.g. the invoice/receivable billed). */
  readonly ref: Uuid;
  readonly amountMinor: bigint | number;
  /** ISO-8601 — when the amount was billed. */
  readonly date: string;
}

export interface CollectedFact {
  /** Opaque settlement/allocation id. */
  readonly ref: Uuid;
  /** Opaque receivable the money landed on. */
  readonly receivableId: Uuid;
  readonly amountMinor: bigint | number;
  /** ISO-8601 — when the money was collected. */
  readonly date: string;
}

export interface PromiseOutcomeFact {
  /** Opaque promise id. */
  readonly ref: Uuid;
  /** true = kept (fulfilled), false = broken. */
  readonly kept: boolean;
  /** ISO-8601 — when the promise resolved. */
  readonly date: string;
}

export interface DisputeRaisedFact {
  /** Opaque dispute id. */
  readonly ref: Uuid;
  /** Opaque receivable disputed. */
  readonly receivableId: Uuid;
  /** ISO-8601 — when the dispute was raised. */
  readonly date: string;
}

export interface EffectivenessFacts {
  /** Single-currency discipline: all money facts are in this currency. */
  readonly currency: Currency;
  readonly billed: readonly BilledFact[];
  readonly collected: readonly CollectedFact[];
  readonly promises: readonly PromiseOutcomeFact[];
  readonly disputes: readonly DisputeRaisedFact[];
}

/** Money-against-money ratio; minor units travel as bigints in-domain. */
export interface MoneyRatioFigure {
  readonly kind: 'money_ratio';
  /** numerator/denominator as a 0..1+ fraction; null when not computable. */
  readonly value: number | null;
  /** Why the figure is not computable (null when it is). */
  readonly reason: string | null;
  readonly numeratorMinor: bigint;
  readonly denominatorMinor: bigint;
  /** ISO-8601 — the window end this figure is measured as of. */
  readonly asOf: string;
  /** Numerator contributors first, then denominator-only contributors (input order, deduped). */
  readonly evidenceRefs: readonly Uuid[];
}

/** Count-against-count ratio. */
export interface CountRatioFigure {
  readonly kind: 'count_ratio';
  readonly value: number | null;
  readonly reason: string | null;
  readonly numerator: number;
  readonly denominator: number;
  readonly asOf: string;
  readonly evidenceRefs: readonly Uuid[];
}

export interface EffectivenessReport {
  /** ACTUALS (historical ratios) — never a projection. */
  readonly kind: 'actual';
  /** ISO-8601 — the window end. */
  readonly asOf: string;
  readonly window: EffectivenessWindow;
  readonly currency: Currency;
  readonly figures: {
    readonly collectedVsBilled: MoneyRatioFigure;
    readonly promiseKept: CountRatioFigure;
    readonly disputeRate: CountRatioFigure;
  };
}

/** Evidence refs: numerator contributors first, then denominator-only, input order, deduped. */
function evidenceRefs(numerator: readonly Uuid[], denominator: readonly Uuid[]): readonly Uuid[] {
  const seen = new Set<Uuid>();
  const refs: Uuid[] = [];
  for (const ref of [...numerator, ...denominator]) {
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

interface Windowed<T> {
  readonly items: readonly T[];
  readonly refs: readonly Uuid[];
}

/** Filters facts to the inclusive [from, to] window, validating shape + uniqueness as it goes. */
function windowFacts<T extends { ref: Uuid; date: string }>(
  facts: readonly T[],
  label: string,
  fromMs: number,
  toMs: number,
): Windowed<T> {
  const seen = new Set<Uuid>();
  const items: T[] = [];
  const refs: Uuid[] = [];
  for (const [index, fact] of facts.entries()) {
    const where = `${label}[${index}]`;
    const ref = assertUuidShape(fact.ref, 'PROJ_EFFECTIVENESS_FACT_INVALID', `${where}.ref`);
    if (seen.has(ref)) {
      throw new DomainError('PROJ_FACT_REF_DUPLICATE', `duplicate ${label} ref ${ref}`, { ref });
    }
    seen.add(ref);
    const time = parseInstant(fact.date, 'PROJ_FACT_DATE_INVALID', `${where}.date`);
    if (time < fromMs || time > toMs) continue; // outside the window — not this report's business
    items.push(fact);
    refs.push(ref);
  }
  return { items, refs };
}

/**
 * Compute the window's collection-effectiveness figures. Pure and
 * deterministic: inclusive window bounds, input-order evidence, no clock —
 * `asOf` IS the window end the caller declared.
 */
export function collectionEffectiveness(facts: EffectivenessFacts, window: EffectivenessWindow): EffectivenessReport {
  const currency = assertCurrency(facts.currency, 'PROJ_CURRENCY_INVALID');
  const fromMs = parseInstant(window.from, 'PROJ_WINDOW_INVALID', 'window.from');
  const toMs = parseInstant(window.to, 'PROJ_WINDOW_INVALID', 'window.to');
  if (fromMs > toMs) {
    throw new DomainError(
      'PROJ_WINDOW_INVALID',
      `window.from (${window.from}) must not be after window.to (${window.to})`,
    );
  }

  const billed = windowFacts(facts.billed, 'billed', fromMs, toMs);
  const collected = windowFacts(facts.collected, 'collected', fromMs, toMs);
  const promises = windowFacts(facts.promises, 'promises', fromMs, toMs);
  const disputes = windowFacts(facts.disputes, 'disputes', fromMs, toMs);

  // Validate amounts through the Money gate (integer, non-negative, currency-bound).
  const billedTotal = billed.items.reduce(
    (sum, fact, index) =>
      sum.add(
        Money.ofMinor(parseMinorAmount(fact.amountMinor, 'PROJ_AMOUNT_INVALID', `billed[${index}].amountMinor`), currency),
      ),
    Money.zero(currency),
  );
  const collectedTotal = collected.items.reduce(
    (sum, fact, index) =>
      sum.add(
        Money.ofMinor(
          parseMinorAmount(fact.amountMinor, 'PROJ_AMOUNT_INVALID', `collected[${index}].amountMinor`),
          currency,
        ),
      ),
    Money.zero(currency),
  );

  const asOf = new Date(toMs).toISOString();

  const collectedVsBilled: MoneyRatioFigure = {
    kind: 'money_ratio',
    // Ratio as a reporting figure: Number() division is exact enough for a
    // displayed rate and keeps bigint money math out of float territory —
    // the numerator/denominator minor units themselves stay bigint.
    value: billedTotal.isZero() ? null : Number(collectedTotal.amount) / Number(billedTotal.amount),
    reason: billedTotal.isZero() ? 'no billed amount in window' : null,
    numeratorMinor: collectedTotal.amount,
    denominatorMinor: billedTotal.amount,
    asOf,
    evidenceRefs: evidenceRefs(collected.refs, billed.refs),
  };

  const keptCount = promises.items.filter((fact) => fact.kept === true).length;
  const resolvedCount = promises.items.length;
  const promiseKept: CountRatioFigure = {
    kind: 'count_ratio',
    value: resolvedCount === 0 ? null : keptCount / resolvedCount,
    reason: resolvedCount === 0 ? 'no promise outcomes in window' : null,
    numerator: keptCount,
    denominator: resolvedCount,
    asOf,
    evidenceRefs: evidenceRefs(promises.refs, []),
  };

  const disputeRate: CountRatioFigure = {
    kind: 'count_ratio',
    value: billed.items.length === 0 ? null : disputes.items.length / billed.items.length,
    reason: billed.items.length === 0 ? 'no billed invoices in window' : null,
    numerator: disputes.items.length,
    denominator: billed.items.length,
    asOf,
    evidenceRefs: evidenceRefs(disputes.refs, billed.refs),
  };

  return {
    kind: 'actual',
    asOf,
    window: { from: window.from, to: window.to },
    currency,
    figures: { collectedVsBilled, promiseKept, disputeRate },
  };
}
