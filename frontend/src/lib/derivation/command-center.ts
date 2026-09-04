import type { Money } from '@/lib/api/envelope';
import type {
  AgingBucket,
  CaseView,
  PaymentView,
  ReceivableView,
} from '@/lib/api/wire-types';
import {
  isBeforeNairobiDay,
  isOnOrBeforeNairobiDay,
  isSameNairobiDay,
  nairobiDayKey,
} from '@/lib/dates';
import { sumMoney } from '@/lib/money';

/**
 * Collections Command Center derivations (issue #76 — "what should my
 * collections team do right now?").
 *
 * The mounted /v1 surface exposes three read models (receivables, payments,
 * collections cases) and NO aggregate endpoints, so the seven Command
 * Center sections are DERIVED client-side over the typed rows. Every rule
 * below uses only contract fields — nothing is invented — and each rule is
 * documented in frontend/README.md ("Card derivations") together with its
 * v1 limitations (the promise read model, for instance, is not yet on the
 * wire; a dedicated promise endpoint is roadmap).
 *
 * All sums are exact integer minor-unit arithmetic (see lib/money.ts).
 * Mixed-currency lists refuse to be totaled (R10) and surface as
 * `mixedCurrency: true`.
 */

export interface ReceivableFocus {
  receivableId: string;
  customerId: string;
  balance: Money;
  dueDate: string;
  overdue: boolean;
  daysPastDue: number | null;
  bucket: AgingBucket | null;
}

export interface CountTotal {
  count: number;
  /** null when the rows cannot be totaled exactly (R10 — see mixedCurrency). */
  total: Money | null;
  /**
   * Why `total` is null: true → the contributing rows mix currencies
   * (cross-currency sums are forbidden); false → the sum exceeded the exact
   * integer range, and money never rounds silently.
   */
  mixedCurrency: boolean;
}

export interface PromisesSection {
  /** Live cases whose derived status is `promised`. */
  count: number;
  /** Of those, cases with an uncompleted action scheduled today or earlier. */
  dueNow: number;
  caseNumbers: string[];
}

export interface MissedPromisesSection {
  count: number;
  caseNumbers: string[];
}

export interface OpportunitiesSection {
  focus: ReceivableFocus[];
  total: Money | null;
  count: number;
}

export interface CommandCenterSummary {
  /** Receivables falling due TODAY (Africa/Nairobi) with money outstanding. */
  expectedToday: CountTotal;
  /** Receivables flagged overdue by the lane. */
  overdue: CountTotal & {
    buckets: Record<AgingBucket, number>;
    worstBucket: AgingBucket | null;
  };
  /** Deep-aged exposure: aging buckets 61–90 and 90+. */
  atRisk: CountTotal;
  promisesDue: PromisesSection;
  missedPromises: MissedPromisesSection;
  /** Confirmed cash not yet applied to any receivable (unapplied > 0). */
  unmatchedPayments: CountTotal;
  /** Largest outstanding balances worth chasing first (top N). */
  opportunities: OpportunitiesSection;
  /** The Nairobi calendar day the derivations were computed for. */
  todayKey: string;
}

export interface CommandCenterInputs {
  receivables: readonly ReceivableView[];
  payments: readonly PaymentView[];
  cases: readonly CaseView[];
}

const OUTSTANDING_STATES: ReadonlySet<ReceivableView['state']> = new Set([
  'open',
  'partially_paid',
]);

const LIVE_CASE_STATUSES: ReadonlySet<CaseView['status']> = new Set([
  'open',
  'in_progress',
]);

/** How many high-value opportunities to surface (top N by balance). */
export const OPPORTUNITY_LIMIT = 5;

function toFocus(receivable: ReceivableView): ReceivableFocus {
  return {
    receivableId: receivable.id,
    customerId: receivable.customerId,
    balance: receivable.balance,
    dueDate: receivable.dueDate,
    overdue: receivable.overdue,
    daysPastDue: receivable.aging?.daysPastDue ?? null,
    bucket: receivable.aging?.bucket ?? null,
  };
}

/** CountTotal over one money-bearing row list (refuses mixed currencies). */
function countTotal<T>(rows: readonly T[], moneyOf: (row: T) => Money): CountTotal {
  const monies = rows.map(moneyOf);
  const first = monies[0]?.currency;
  const mixed = first !== undefined && monies.some((m) => m.currency !== first);
  return {
    count: rows.length,
    total: mixed ? null : sumMoney(monies),
    mixedCurrency: mixed,
  };
}

function emptyBuckets(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

const BUCKET_ORDER: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '90+'];

export function deriveCommandCenter(
  inputs: CommandCenterInputs,
  now: Date,
): CommandCenterSummary {
  const { receivables, payments, cases } = inputs;

  // -- receivable-based sections -------------------------------------------
  const outstanding = receivables.filter((r) => OUTSTANDING_STATES.has(r.state));

  const dueTodayRows = outstanding.filter((r) => isSameNairobiDay(new Date(r.dueDate), now));
  const expectedToday: CountTotal = countTotal(dueTodayRows, (r) => r.balance);

  const overdueRows = outstanding.filter((r) => r.overdue);
  const buckets = emptyBuckets();
  for (const row of overdueRows) {
    if (row.aging !== null) buckets[row.aging.bucket] += 1;
  }
  const worstBucket = [...BUCKET_ORDER]
    .reverse()
    .find((bucket) => buckets[bucket] > 0) ?? null;
  const overdue: CommandCenterSummary['overdue'] = {
    ...countTotal(overdueRows, (r) => r.balance),
    buckets,
    worstBucket,
  };
  const atRiskRows = outstanding.filter(
    (r) => r.aging?.bucket === '61-90' || r.aging?.bucket === '90+',
  );
  const atRisk: CountTotal = countTotal(atRiskRows, (r) => r.balance);

  const opportunityRows = [...outstanding]
    .sort((a, b) => {
      if (b.balance.minor !== a.balance.minor) return b.balance.minor - a.balance.minor;
      return a.id.localeCompare(b.id);
    })
    .slice(0, OPPORTUNITY_LIMIT)
    .map(toFocus);
  const opportunities: OpportunitiesSection = {
    focus: opportunityRows,
    total: sumMoney(outstanding.map((r) => r.balance)),
    count: opportunityRows.length,
  };

  // -- case-based sections ---------------------------------------------------
  const liveCases = cases.filter((c) => LIVE_CASE_STATUSES.has(c.status));
  const todayKey = nairobiDayKey(now);

  const promisedCases = liveCases.filter((c) => c.derivedStatus === 'promised');
  const promisesDueNow = promisedCases.filter((c) =>
    c.actions.some(
      (action) =>
        action.completedAt === null &&
        isOnOrBeforeNairobiDay(new Date(action.scheduledFor), now),
    ),
  );
  const promisesDue: PromisesSection = {
    count: promisedCases.length,
    dueNow: promisesDueNow.length,
    caseNumbers: promisedCases.map((c) => c.caseNumber),
  };

  const missedCases = promisedCases.filter((c) =>
    c.actions.some(
      (action) =>
        action.completedAt === null &&
        isBeforeNairobiDay(new Date(action.scheduledFor), now),
    ),
  );
  const missedPromises: MissedPromisesSection = {
    count: missedCases.length,
    caseNumbers: missedCases.map((c) => c.caseNumber),
  };

  // -- payment-based section --------------------------------------------------
  const unmatchedRows = payments.filter(
    (p) => p.confirmed !== null && p.unapplied.minor > 0,
  );
  const unmatchedPayments: CountTotal = countTotal(unmatchedRows, (p) => p.unapplied);

  return {
    expectedToday,
    overdue,
    atRisk,
    promisesDue,
    missedPromises,
    unmatchedPayments,
    opportunities,
    todayKey,
  };
}

/**
 * Overview headline metrics (the dashboard home page) — same honest
 * derivations, smaller surface.
 */
export interface OverviewSummary {
  outstanding: CountTotal;
  overdue: CountTotal;
  unmatchedPayments: CountTotal;
}

export function deriveOverview(
  inputs: Pick<CommandCenterInputs, 'receivables' | 'payments'>,
): OverviewSummary {
  const outstandingRows = inputs.receivables.filter((r) =>
    OUTSTANDING_STATES.has(r.state),
  );
  const overdueRows = outstandingRows.filter((r) => r.overdue);
  const unmatchedRows = inputs.payments.filter(
    (p) => p.confirmed !== null && p.unapplied.minor > 0,
  );
  return {
    outstanding: countTotal(outstandingRows, (r) => r.balance),
    overdue: countTotal(overdueRows, (r) => r.balance),
    unmatchedPayments: countTotal(unmatchedRows, (p) => p.unapplied),
  };
}
