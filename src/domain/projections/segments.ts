/**
 * Customer segmentation (issue #24, SPEC §19 "Organizations can create
 * strategies based on: customer segment / customer value / risk / payment
 * behavior / dispute state").
 *
 * `segmentCustomers(customerFacts)` maps each customer's plain behavior/
 * exposure facts to one of five STABLE named segments — stable because
 * downstream strategies, dashboards and agent prompts key on them:
 *
 *   high_value_reliable   big exposure, nothing overdue, reliable payer
 *   watch                 live exposure, nothing alarming yet
 *   at_risk               open dispute, 31+ days overdue, or poor reliability
 *   chronic_late          repeated broken promises or 90+ days overdue
 *   dormant               no outstanding exposure or long payment silence
 *
 * DECISION MATRIX — first match wins, in this fixed order (risk outranks
 * value; dormancy outranks everything because a silent customer gets no
 * active pursuit at all):
 *
 *   1. exposure = 0                                   → dormant
 *   2. daysSinceLastPayment ≥ 180                     → dormant
 *   3. brokenPromiseCount ≥ 3                         → chronic_late
 *   4. worstDaysOverdue ≥ 90                          → chronic_late
 *   5. disputeOpen                                    → at_risk
 *   6. worstDaysOverdue ≥ 31                          → at_risk
 *   7. promiseKeptRate < 0.5                          → at_risk
 *   8. exposure ≥ 10M minor ∧ worstDaysOverdue = 0
 *      ∧ promiseKeptRate ≥ 0.8 (or no history)        → high_value_reliable
 *   9. otherwise                                      → watch
 *
 * Every assignment carries `reasons` — the exact conditions that fired, as
 * structured strings — so the segment is always explainable (VISION §3.7).
 * Thresholds are exported frozen (SEGMENT_THRESHOLDS): readable by callers
 * and agents, mutable by no one.
 *
 * Pure over relative facts (days-ago numbers, not dates): no clock needed,
 * so the same facts always segment identically.
 */
import { DomainError, type Uuid } from '../shared';
import { assertCurrency, assertUuidShape, parseMinorAmount } from './facts';

export const SEGMENTS = ['high_value_reliable', 'watch', 'at_risk', 'chronic_late', 'dormant'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** The transparent threshold set — frozen; tests pin every boundary against it. */
export const SEGMENT_THRESHOLDS = Object.freeze({
  /** No payment for this many days → dormant. */
  DORMANT_SILENCE_DAYS: 180,
  /** This many broken promises → chronic_late. */
  CHRONIC_BROKEN_PROMISES: 3,
  /** This many days overdue (worst receivable) → chronic_late. */
  CHRONIC_DAYS_OVERDUE: 90,
  /** This many days overdue (worst receivable) → at_risk. */
  AT_RISK_DAYS_OVERDUE: 31,
  /** Kept-promise rate below this → at_risk. */
  AT_RISK_KEPT_RATE: 0.5,
  /** Outstanding exposure at/above this (minor units) + clean record → high_value_reliable. */
  HIGH_VALUE_EXPOSURE_MINOR: 10_000_000,
  /** Kept-promise rate at/above this supports high_value_reliable (null = no history, allowed). */
  RELIABLE_KEPT_RATE: 0.8,
});

export interface CustomerFact {
  readonly customerId: Uuid;
  /** Exposure currency — segmentation reads one exposure figure per customer. */
  readonly currency: string;
  /** Outstanding balance across the customer's receivables (minor units). */
  readonly exposureMinor: bigint | number;
  /** Worst days-past-due across the customer's receivables (0 = nothing overdue). */
  readonly worstDaysOverdue: number;
  /** Kept/resolved promise share 0..1, or null when there is no promise history. */
  readonly promiseKeptRate: number | null;
  /** Resolved promises that were broken (count ≥ 0). */
  readonly brokenPromiseCount: number;
  /** Whole days since the customer last paid, or null when they never paid. */
  readonly daysSinceLastPayment: number | null;
  /** Any receivable currently disputed? */
  readonly disputeOpen: boolean;
}

export interface SegmentAssignment {
  readonly customerId: Uuid;
  readonly segment: Segment;
  /** The exact conditions that fired, in matrix order — the audit trail. */
  readonly reasons: readonly string[];
}

/** Validates one customer fact, returning the parsed exposure (Money-safe). */
function parseCustomerFact(fact: CustomerFact, index: number): { customerId: Uuid; exposureMinor: bigint } {
  const where = `customerFacts[${index}]`;
  const customerId = assertUuidShape(fact.customerId, 'SEG_CUSTOMER_FACT_INVALID', `${where}.customerId`);
  assertCurrency(fact.currency, 'SEG_CURRENCY_INVALID');
  const exposureMinor = parseMinorAmount(fact.exposureMinor, 'SEG_EXPOSURE_INVALID', `${where}.exposureMinor`);
  if (typeof fact.worstDaysOverdue !== 'number' || !Number.isInteger(fact.worstDaysOverdue) || fact.worstDaysOverdue < 0) {
    throw new DomainError(
      'SEG_CUSTOMER_FACT_INVALID',
      `${where}.worstDaysOverdue must be an integer >= 0, got ${String(fact.worstDaysOverdue)}`,
      { customerId },
    );
  }
  if (
    fact.promiseKeptRate !== null &&
    (typeof fact.promiseKeptRate !== 'number' || !Number.isFinite(fact.promiseKeptRate) || fact.promiseKeptRate < 0 || fact.promiseKeptRate > 1)
  ) {
    throw new DomainError(
      'SEG_RATE_INVALID',
      `${where}.promiseKeptRate must be null or a number in [0, 1], got ${String(fact.promiseKeptRate)}`,
      { customerId },
    );
  }
  if (typeof fact.brokenPromiseCount !== 'number' || !Number.isInteger(fact.brokenPromiseCount) || fact.brokenPromiseCount < 0) {
    throw new DomainError(
      'SEG_CUSTOMER_FACT_INVALID',
      `${where}.brokenPromiseCount must be an integer >= 0, got ${String(fact.brokenPromiseCount)}`,
      { customerId },
    );
  }
  if (
    fact.daysSinceLastPayment !== null &&
    (typeof fact.daysSinceLastPayment !== 'number' || !Number.isInteger(fact.daysSinceLastPayment) || fact.daysSinceLastPayment < 0)
  ) {
    throw new DomainError(
      'SEG_CUSTOMER_FACT_INVALID',
      `${where}.daysSinceLastPayment must be null or an integer >= 0, got ${String(fact.daysSinceLastPayment)}`,
      { customerId },
    );
  }
  if (typeof fact.disputeOpen !== 'boolean') {
    throw new DomainError('SEG_CUSTOMER_FACT_INVALID', `${where}.disputeOpen must be a boolean, got ${String(fact.disputeOpen)}`, {
      customerId,
    });
  }
  return { customerId, exposureMinor };
}

/**
 * Segment every customer fact, preserving input order. Pure and
 * deterministic — identical facts always yield identical segments, reasons
 * and ordering.
 */
export function segmentCustomers(customerFacts: readonly CustomerFact[]): readonly SegmentAssignment[] {
  const seen = new Set<Uuid>();
  return customerFacts.map((fact, index) => {
    const { customerId, exposureMinor } = parseCustomerFact(fact, index);
    if (seen.has(customerId)) {
      throw new DomainError('SEG_CUSTOMER_DUPLICATE', `duplicate customer fact for ${customerId}`, { customerId });
    }
    seen.add(customerId);

    const T = SEGMENT_THRESHOLDS;
    const overdue = fact.worstDaysOverdue;
    const kept = fact.promiseKeptRate;

    // 1. Nothing outstanding — no active collections relationship at all.
    if (exposureMinor === 0n) {
      return { customerId, segment: 'dormant', reasons: ['exposureMinor=0 — no outstanding balance to collect'] };
    }
    // 2. Long payment silence dominates: no active pursuit, re-activation first.
    if (fact.daysSinceLastPayment !== null && fact.daysSinceLastPayment >= T.DORMANT_SILENCE_DAYS) {
      return {
        customerId,
        segment: 'dormant',
        reasons: [`daysSinceLastPayment=${fact.daysSinceLastPayment} >= ${T.DORMANT_SILENCE_DAYS}`],
      };
    }
    // 3./4. Chronic behaviour: repeated broken promises or deeply overdue debt.
    const chronic: string[] = [];
    if (fact.brokenPromiseCount >= T.CHRONIC_BROKEN_PROMISES) {
      chronic.push(`brokenPromiseCount=${fact.brokenPromiseCount} >= ${T.CHRONIC_BROKEN_PROMISES}`);
    }
    if (overdue >= T.CHRONIC_DAYS_OVERDUE) {
      chronic.push(`worstDaysOverdue=${overdue} >= ${T.CHRONIC_DAYS_OVERDUE}`);
    }
    if (chronic.length > 0) {
      return { customerId, segment: 'chronic_late', reasons: chronic };
    }
    // 5./6./7. Elevated risk: dispute, meaningful lateness, or poor reliability.
    const atRisk: string[] = [];
    if (fact.disputeOpen) {
      atRisk.push('disputeOpen=true');
    }
    if (overdue >= T.AT_RISK_DAYS_OVERDUE) {
      atRisk.push(`worstDaysOverdue=${overdue} >= ${T.AT_RISK_DAYS_OVERDUE}`);
    }
    if (kept !== null && kept < T.AT_RISK_KEPT_RATE) {
      atRisk.push(`promiseKeptRate=${kept} < ${T.AT_RISK_KEPT_RATE}`);
    }
    if (atRisk.length > 0) {
      return { customerId, segment: 'at_risk', reasons: atRisk };
    }
    // 8. High value with a clean, reliable record.
    if (
      exposureMinor >= BigInt(T.HIGH_VALUE_EXPOSURE_MINOR) &&
      overdue === 0 &&
      (kept === null || kept >= T.RELIABLE_KEPT_RATE)
    ) {
      const reasons = [
        `exposureMinor=${exposureMinor} >= ${T.HIGH_VALUE_EXPOSURE_MINOR}`,
        'worstDaysOverdue=0 — nothing overdue',
        kept === null ? 'promiseKeptRate unknown — no promise history' : `promiseKeptRate=${kept} >= ${T.RELIABLE_KEPT_RATE}`,
      ];
      return { customerId, segment: 'high_value_reliable', reasons };
    }
    // 9. Live exposure, nothing remarkable — keep an eye on it.
    return { customerId, segment: 'watch', reasons: ['no risk, dormancy or high-value condition matched — default segment'] };
  });
}
