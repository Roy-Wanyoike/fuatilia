import type { Money } from '@/lib/api/envelope';
import type { PaymentView, ReceivableView } from '@/lib/api/wire-types';
import { sumMoney } from '@/lib/money';

/**
 * Portal balance derivations (issue #86) — the payer's headline positions:
 * outstanding / overdue / payments held on account.
 *
 * The mounted /v1 surface has no aggregate endpoints, so the overview is
 * DERIVED client-side over the two typed read models (GET /v1/receivables +
 * GET /v1/payments). Every rule uses contract fields only; all sums are
 * exact integer minor-unit arithmetic via lib/money.ts::sumMoney. Mixed-
 * currency lists REFUSE to be totaled (R10): the caller gets `total: null`
 * with `mixedCurrency: true` and presents count-only — money never rounds
 * silently.
 */

export interface PortalCountTotal {
  count: number;
  /** null when the rows cannot be totaled exactly (R10 — see mixedCurrency). */
  total: Money | null;
  /**
   * Why `total` is null: true → the contributing rows mix currencies
   * (cross-currency sums are forbidden); false → the sum exceeded the exact
   * integer range.
   */
  mixedCurrency: boolean;
}

export interface PortalBalanceSummary {
  /** Receivables with money outstanding: `open` + `partially_paid` balances. */
  outstanding: PortalCountTotal;
  /** The subset the lane flags `overdue`, with balance outstanding. */
  overdue: PortalCountTotal;
  /** Confirmed cash not yet applied to any receivable (`unapplied > 0`). */
  heldOnAccount: PortalCountTotal;
}

const OUTSTANDING_STATES: ReadonlySet<ReceivableView['state']> = new Set([
  'open',
  'partially_paid',
]);

/** CountTotal over one money-bearing row list (refuses mixed currencies). */
function countTotal<T>(rows: readonly T[], moneyOf: (row: T) => Money): PortalCountTotal {
  const monies = rows.map(moneyOf);
  const first = monies[0]?.currency;
  const mixed = first !== undefined && monies.some((m) => m.currency !== first);
  return {
    count: rows.length,
    total: mixed ? null : sumMoney(monies),
    mixedCurrency: mixed,
  };
}

export function derivePortalBalance(inputs: {
  receivables: readonly ReceivableView[];
  payments: readonly PaymentView[];
}): PortalBalanceSummary {
  const outstandingRows = inputs.receivables.filter((r) => OUTSTANDING_STATES.has(r.state));
  const overdueRows = outstandingRows.filter((r) => r.overdue);
  const heldRows = inputs.payments.filter(
    (p) => p.confirmed !== null && p.unapplied.minor > 0,
  );
  return {
    outstanding: countTotal(outstandingRows, (r) => r.balance),
    overdue: countTotal(overdueRows, (r) => r.balance),
    heldOnAccount: countTotal(heldRows, (p) => p.unapplied),
  };
}
