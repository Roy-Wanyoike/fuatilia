/**
 * AR aging & portfolio snapshot (issue #24, SPEC §66 "Outstanding receivables").
 *
 * `arAgingByBucket(receivables, asOf)` totals OUTSTANDING balances per
 * currency into the standard AR buckets: current (nothing past due yet),
 * 1-30, 31-60, 61-90 and 90+ days PAST DUE. This is an ACTUALS snapshot —
 * `kind: 'actual'` — structurally distinct from any projection (see
 * projection.ts): the two are never mixed in one structure, so a consumer
 * can never mistake a forecast for a balance.
 *
 * Rules:
 *  - Whole days past due, floored (a partial late day is not yet a full day
 *    late — same boundary semantics as the receivables lane's aging) and
 *    clamped at 0: `current` covers not-yet-due AND due-now receivables.
 *    Boundaries: day 1 → '1-30', day 30 → '1-30', day 31 → '31-60',
 *    day 60 → '31-60', day 61 → '61-90', day 90 → '61-90', day 91 → '90+'.
 *  - Per-currency ONLY (docs/07 R10): each currency gets its own view, in
 *    first-seen order; cross-currency sums are structurally impossible.
 *  - Zero-balance facts (settled debt) contribute nothing to age: they are
 *    counted as `zeroBalanceCount` and skipped — a settled receivable has
 *    nothing left to age.
 *  - Every bucket total (figure) carries its own `asOf` AND its evidence: the
 *    receivable ids that contributed (input order), so every figure is
 *    self-contained and traceable (VISION §3.7).
 *  - All sums run through the shared Money kernel (bigint minor units) —
 *    no floats, no negatives, single-currency arithmetic enforced.
 */
import { Money, type Currency, type Uuid } from '../shared';
import { parseInstant, parseReceivableFacts, type ReceivableFact } from './facts';

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY_MS = 86_400_000;

/** Whole days past due, floored and clamped at 0 (future dues are never negative). */
export function daysOverdue(dueTime: number, asOfTime: number): number {
  return Math.max(0, Math.floor((asOfTime - dueTime) / DAY_MS));
}

/**
 * Bucket for a receivable `daysPastDue` whole days late.
 * `daysPastDue <= 0` (nothing past due) → 'current'; the ±1-day boundary
 * semantics are pinned by tests.
 */
export function agingBucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current';
  if (daysPastDue <= 30) return '1-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
}

export interface AgingBucketTotal {
  readonly bucket: AgingBucket;
  readonly amountMinor: bigint;
  readonly receivableCount: number;
  /** ISO-8601 — every figure carries the asOf it was measured at. */
  readonly asOf: string;
  /** Receivables that contributed to THIS bucket, in input order. */
  readonly evidenceRefs: readonly Uuid[];
}

export interface AgingCurrencyView {
  readonly currency: Currency;
  /** Σ of all five buckets (bigint minor units). */
  readonly totalMinor: bigint;
  /** All five buckets, always present in `AGING_BUCKETS` order (zero-filled). */
  readonly buckets: readonly AgingBucketTotal[];
}

export interface AgingSnapshot {
  /** ACTUALS — never a projection. Projections carry `kind: 'projection'`. */
  readonly kind: 'actual';
  /** ISO-8601 — the `asOf` the snapshot was taken at. */
  readonly asOf: string;
  /** One view per currency present, first-seen order. */
  readonly currencies: readonly AgingCurrencyView[];
  /** Receivables that actually aged (balance > 0). */
  readonly receivablesAged: number;
  /** Settled/zero-balance facts skipped (nothing left to age). */
  readonly zeroBalanceCount: number;
}

interface BucketAccumulator {
  readonly amount: Money;
  readonly refs: readonly Uuid[];
}

interface CurrencyAccumulator {
  readonly total: Money;
  readonly buckets: ReadonlyMap<AgingBucket, BucketAccumulator>;
}

/**
 * Snapshot the outstanding AR portfolio by aging bucket, per currency, as of
 * `asOf` (Date or ISO string). Pure: reads nothing, mutates nothing, emits
 * no event — callers decide whether to persist/emit
 * `projections.agingSnapshotTaken` (see events.ts).
 */
export function arAgingByBucket(receivables: readonly ReceivableFact[], asOf: Date | string): AgingSnapshot {
  const asOfTime = parseInstant(asOf, 'PROJ_AS_OF_INVALID', 'asOf');
  const parsed = parseReceivableFacts(receivables);

  const order: Currency[] = [];
  const byCurrency = new Map<Currency, CurrencyAccumulator>();
  let receivablesAged = 0;
  let zeroBalanceCount = 0;

  for (const receivable of parsed) {
    if (receivable.balance.isZero()) {
      zeroBalanceCount += 1; // settled debt has nothing left to age
      continue;
    }
    receivablesAged += 1;

    let acc = byCurrency.get(receivable.currency);
    if (!acc) {
      acc = { total: Money.zero(receivable.currency), buckets: new Map() };
      byCurrency.set(receivable.currency, acc);
      order.push(receivable.currency);
    }

    const bucket = agingBucketFor(daysOverdue(receivable.dueTime, asOfTime));
    const previous = acc.buckets.get(bucket) ?? { amount: Money.zero(receivable.currency), refs: [] };
    const buckets = new Map(acc.buckets);
    buckets.set(bucket, {
      amount: previous.amount.add(receivable.balance),
      refs: [...previous.refs, receivable.receivableId],
    });
    byCurrency.set(receivable.currency, { total: acc.total.add(receivable.balance), buckets });
  }

  const asOfIso = new Date(asOfTime).toISOString();
  const currencies = order.map((currency) => {
    const acc = byCurrency.get(currency)!;
    const buckets = AGING_BUCKETS.map((bucket): AgingBucketTotal => {
      const entry = acc.buckets.get(bucket);
      return {
        bucket,
        amountMinor: (entry?.amount ?? Money.zero(currency)).amount,
        receivableCount: entry?.refs.length ?? 0,
        asOf: asOfIso,
        evidenceRefs: entry?.refs ?? [],
      };
    });
    return { currency, totalMinor: acc.total.amount, buckets };
  });

  return {
    kind: 'actual',
    asOf: asOfIso,
    currencies,
    receivablesAged,
    zeroBalanceCount,
  };
}
