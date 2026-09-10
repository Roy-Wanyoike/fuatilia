import type { Money } from '@/lib/api/envelope';
import type {
  AgingBucket,
  CaseActionSource,
  CaseActionType,
  CaseView,
  PaymentView,
  ReceivableView,
} from '@/lib/api/wire-types';
import { isBeforeNairobiDay, isOnOrBeforeNairobiDay } from '@/lib/dates';
import { sumMoney } from '@/lib/money';

/**
 * Customer 360 derivations (issue #134).
 *
 * The mounted /v1 surface has NO customer directory operation: customer
 * identities exist only as the opaque `customerId` field on the receivable
 * and payment read models, and collections cases link to a customer ONLY
 * through `receivableIds`. Nothing below invents a directory — every rule is
 * a grouping / filter / transcript over the three typed read models
 * (GET /v1/receivables, GET /v1/payments, GET /v1/collections/cases):
 *
 *   - directory        — distinct customerIds derived from receivables +
 *                        payments rows (payments with a null customerId are
 *                        unattributable and never mint a customer);
 *   - receivables view — the customer's rows + aging buckets over money
 *                        still outstanding (the lane refuses to age settled
 *                        money — `aging: null` rows are skipped);
 *   - payments view    — the customer's rows + the allocation ledger
 *                        flattened from each payment's `allocations[]`;
 *   - cases view       — cases whose `receivableIds` intersect the
 *                        customer's receivable ids (the only contract link);
 *                        promises come from the lane's `derivedStatus:
 *                        'promised'` overlay + each live case's earliest
 *                        uncompleted action (due-now / missed per the
 *                        Africa/Nairobi calendar day);
 *   - comms timeline   — one entry per case action (call/sms/whatsapp/
 *                        letter/fieldVisit/escalation) across the customer's
 *                        cases, newest-scheduled first.
 *
 * All sums are exact integer minor-unit arithmetic via lib/money.ts.
 * Mixed-currency lists REFUSE to be totaled (R10): totals become `null`
 * with `mixedCurrency: true` and the UI presents count-only — money never
 * rounds silently.
 */

export interface CustomerCountTotal {
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

const OUTSTANDING_STATES: ReadonlySet<ReceivableView['state']> = new Set([
  'open',
  'partially_paid',
]);

const LIVE_CASE_STATUSES: ReadonlySet<CaseView['status']> = new Set([
  'open',
  'in_progress',
]);

/** Render order for aging buckets (shallow → deep). */
export const BUCKET_ORDER: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '90+'];

function countTotal<T>(rows: readonly T[], moneyOf: (row: T) => Money): CustomerCountTotal {
  const monies = rows.map(moneyOf);
  const first = monies[0]?.currency;
  const mixed = first !== undefined && monies.some((m) => m.currency !== first);
  return {
    count: rows.length,
    total: mixed ? null : sumMoney(monies),
    mixedCurrency: mixed,
  };
}

/** Epoch-ms comparison over contract date-time strings (validated upstream). */
function compareInstants(a: string, b: string): number {
  const at = Date.parse(a);
  const bt = Date.parse(b);
  if (at !== bt) return at < bt ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Customer directory — derived identities (no /v1 directory endpoint exists)
// ---------------------------------------------------------------------------

export interface CustomerDirectoryEntry {
  customerId: string;
  /** Receivables attributed to this customer (any state). */
  receivableCount: number;
  /** open + partially_paid balances for this customer. */
  outstanding: CustomerCountTotal;
  /** How many of the outstanding rows carry the lane's overdue flag. */
  overdueCount: number;
  /**
   * Latest attributable instant: the newest receivable `openedAt` (when the
   * lane has opened it) or payment `initiatedAt` — null when the customer
   * has no dated activity yet (draft-only book).
   */
  lastActivityAt: string | null;
}

export interface CustomerDirectoryInputs {
  receivables: readonly ReceivableView[];
  payments: readonly PaymentView[];
}

export function deriveCustomerDirectory(
  inputs: CustomerDirectoryInputs,
): CustomerDirectoryEntry[] {
  const ids = new Set<string>();
  for (const receivable of inputs.receivables) ids.add(receivable.customerId);
  for (const payment of inputs.payments) {
    if (payment.customerId !== null) ids.add(payment.customerId);
  }

  const entries: CustomerDirectoryEntry[] = [];
  for (const customerId of ids) {
    const receivables = inputs.receivables.filter((r) => r.customerId === customerId);
    const payments = inputs.payments.filter((p) => p.customerId === customerId);
    const outstandingRows = receivables.filter((r) => OUTSTANDING_STATES.has(r.state));

    let lastActivityAt: string | null = null;
    for (const receivable of receivables) {
      if (receivable.openedAt === null) continue;
      if (lastActivityAt === null || compareInstants(receivable.openedAt, lastActivityAt) > 0) {
        lastActivityAt = receivable.openedAt;
      }
    }
    for (const payment of payments) {
      if (lastActivityAt === null || compareInstants(payment.initiatedAt, lastActivityAt) > 0) {
        lastActivityAt = payment.initiatedAt;
      }
    }

    entries.push({
      customerId,
      receivableCount: receivables.length,
      outstanding: countTotal(outstandingRows, (r) => r.balance),
      overdueCount: outstandingRows.filter((r) => r.overdue).length,
      lastActivityAt,
    });
  }

  // Newest activity first (nulls last); deterministic id tie-break.
  return entries.sort((a, b) => {
    if (a.lastActivityAt !== b.lastActivityAt) {
      if (a.lastActivityAt === null) return 1;
      if (b.lastActivityAt === null) return -1;
      return -compareInstants(a.lastActivityAt, b.lastActivityAt);
    }
    return a.customerId < b.customerId ? -1 : a.customerId > b.customerId ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Customer receivables — rows + aging buckets over outstanding money
// ---------------------------------------------------------------------------

export interface CustomerAgingBucketSummary {
  count: number;
  total: Money | null;
  mixedCurrency: boolean;
}

export interface CustomerReceivablesSummary {
  customerId: string;
  /** The customer's rows, due-date ascending (id tie-break). */
  receivables: ReceivableView[];
  /** open + partially_paid balances. */
  outstanding: CustomerCountTotal;
  /** The overdue subset + its aging-bucket distribution. */
  overdue: CustomerCountTotal & {
    buckets: Record<AgingBucket, number>;
    worstBucket: AgingBucket | null;
  };
  /**
   * Balance per aging bucket over OUTSTANDING rows that carry an aging view.
   * Settled money (`aging: null`) is never aged (lane rule).
   */
  agingBuckets: Record<AgingBucket, CustomerAgingBucketSummary>;
  /** Rows in non-outstanding states (settled, written_off, recovered, …). */
  terminalCount: number;
}

function emptyBucketCounts(): Record<AgingBucket, number> {
  return { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
}

function emptyBucketGroups(): Record<AgingBucket, ReceivableView[]> {
  return { '0-30': [], '31-60': [], '61-90': [], '90+': [] };
}

export function summarizeCustomerReceivables(inputs: {
  customerId: string;
  receivables: readonly ReceivableView[];
}): CustomerReceivablesSummary {
  const receivables = inputs.receivables
    .filter((r) => r.customerId === inputs.customerId)
    .sort((a, b) => {
      const byDue = compareInstants(a.dueDate, b.dueDate);
      if (byDue !== 0) return byDue;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const outstandingRows = receivables.filter((r) => OUTSTANDING_STATES.has(r.state));
  const overdueRows = outstandingRows.filter((r) => r.overdue);

  const buckets = emptyBucketCounts();
  for (const row of overdueRows) {
    if (row.aging !== null) buckets[row.aging.bucket] += 1;
  }
  const worstBucket =
    [...BUCKET_ORDER].reverse().find((bucket) => buckets[bucket] > 0) ?? null;

  const grouped = emptyBucketGroups();
  for (const row of outstandingRows) {
    if (row.aging === null) continue; // the lane refuses to age it — skip, don't invent
    grouped[row.aging.bucket].push(row);
  }
  const agingBuckets: Record<AgingBucket, CustomerAgingBucketSummary> = {
    '0-30': countTotal(grouped['0-30'], (r) => r.balance),
    '31-60': countTotal(grouped['31-60'], (r) => r.balance),
    '61-90': countTotal(grouped['61-90'], (r) => r.balance),
    '90+': countTotal(grouped['90+'], (r) => r.balance),
  };

  return {
    customerId: inputs.customerId,
    receivables,
    outstanding: countTotal(outstandingRows, (r) => r.balance),
    overdue: {
      ...countTotal(overdueRows, (r) => r.balance),
      buckets,
      worstBucket,
    },
    agingBuckets,
    terminalCount: receivables.length - outstandingRows.length,
  };
}

// ---------------------------------------------------------------------------
// Customer payments — history + the allocation ledger
// ---------------------------------------------------------------------------

export interface CustomerAllocation {
  /** Deterministic key for list rendering. */
  key: string;
  paymentId: string;
  /** The payment's Daraja receipt reference (contract `externalRef`). */
  externalRef: string;
  receivableId: string;
  amount: Money;
  recordedAt: string;
}

export interface CustomerPaymentsSummary {
  customerId: string;
  /** The customer's rows, initiated newest first (id tie-break). */
  payments: PaymentView[];
  /** Confirmed cash (rows where the success callback has landed). */
  confirmed: CustomerCountTotal;
  /** Confirmed cash not yet applied to any receivable (unapplied > 0). */
  heldOnAccount: CustomerCountTotal;
  /** The allocation ledger flattened across the customer's payments. */
  allocations: CustomerAllocation[];
}

export function summarizeCustomerPayments(inputs: {
  customerId: string;
  payments: readonly PaymentView[];
}): CustomerPaymentsSummary {
  const payments = inputs.payments
    .filter((p) => p.customerId === inputs.customerId)
    .sort((a, b) => {
      const byInitiated = -compareInstants(a.initiatedAt, b.initiatedAt);
      if (byInitiated !== 0) return byInitiated;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const confirmedRows = payments.filter((p) => p.confirmed !== null);
  const heldRows = confirmedRows.filter((p) => p.unapplied.minor > 0);

  const allocations: CustomerAllocation[] = [];
  for (const payment of payments) {
    for (const allocation of payment.allocations) {
      allocations.push({
        key: `${payment.id}:allocation:${allocation.id}`,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        receivableId: allocation.receivableId,
        amount: allocation.amount,
        recordedAt: allocation.recordedAt,
      });
    }
  }
  allocations.sort((a, b) => {
    const byRecorded = -compareInstants(a.recordedAt, b.recordedAt);
    if (byRecorded !== 0) return byRecorded;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    customerId: inputs.customerId,
    payments,
    confirmed: countTotal(
      confirmedRows,
      (p) => p.confirmed as NonNullable<PaymentView['confirmed']>,
    ),
    heldOnAccount: countTotal(heldRows, (p) => p.unapplied),
    allocations,
  };
}

// ---------------------------------------------------------------------------
// Customer cases — attribution via receivableIds, promises, comms timeline
// ---------------------------------------------------------------------------

export interface CustomerPromise {
  caseId: string;
  caseNumber: string;
  /**
   * Earliest UNCOMPLETED action's scheduledFor on the case — null when the
   * promised case has no pending follow-up.
   */
  nextActionAt: string | null;
  /** nextActionAt falls on or before today (Africa/Nairobi). */
  dueNow: boolean;
  /** nextActionAt falls strictly before today (Africa/Nairobi). */
  missed: boolean;
}

export interface CustomerCommsEntry {
  key: string;
  caseId: string;
  caseNumber: string;
  type: CaseActionType;
  source: CaseActionSource;
  scheduledFor: string;
  completedAt: string | null;
  outcome: string | null;
  consentRef: string | null;
}

export interface CustomerCasesSummary {
  /** Cases touching the customer's receivables, opened newest first. */
  cases: CaseView[];
  /** Live cases (open + in_progress). */
  openCaseCount: number;
  /** Live promised cases + their next-follow-up posture, due/missed first. */
  promises: CustomerPromise[];
  /**
   * One entry per action across the customer's cases (all statuses — closed
   * cases keep their history), scheduled newest first.
   */
  comms: CustomerCommsEntry[];
}

export function attributeCustomerCases(
  inputs: {
    customerId: string;
    receivables: readonly ReceivableView[];
    cases: readonly CaseView[];
  },
  now: Date,
): CustomerCasesSummary {
  // The contract links a case to a customer ONLY through receivableIds —
  // attribute against the customer's receivable rows.
  const receivableIds = new Set(
    inputs.receivables
      .filter((r) => r.customerId === inputs.customerId)
      .map((r) => r.id),
  );
  const cases = inputs.cases
    .filter((c) => c.receivableIds.some((id) => receivableIds.has(id)))
    .sort((a, b) => {
      const byOpened = -compareInstants(a.openedAt, b.openedAt);
      if (byOpened !== 0) return byOpened;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const liveCases = cases.filter((c) => LIVE_CASE_STATUSES.has(c.status));
  const promises: CustomerPromise[] = [];
  for (const liveCase of liveCases) {
    if (liveCase.derivedStatus !== 'promised') continue;
    let nextActionAt: string | null = null;
    for (const action of liveCase.actions) {
      if (action.completedAt !== null) continue;
      if (nextActionAt === null || compareInstants(action.scheduledFor, nextActionAt) < 0) {
        nextActionAt = action.scheduledFor;
      }
    }
    promises.push({
      caseId: liveCase.id,
      caseNumber: liveCase.caseNumber,
      nextActionAt,
      dueNow:
        nextActionAt !== null && isOnOrBeforeNairobiDay(new Date(nextActionAt), now),
      missed: nextActionAt !== null && isBeforeNairobiDay(new Date(nextActionAt), now),
    });
  }
  // Most-urgent promise first: due-now/missed before future, then by time.
  promises.sort((a, b) => {
    if (a.dueNow !== b.dueNow) return a.dueNow ? -1 : 1;
    if (a.nextActionAt !== null && b.nextActionAt !== null) {
      const byTime = compareInstants(a.nextActionAt, b.nextActionAt);
      if (byTime !== 0) return byTime;
    }
    if (a.nextActionAt !== null && b.nextActionAt === null) return -1;
    if (a.nextActionAt === null && b.nextActionAt !== null) return 1;
    return a.caseNumber < b.caseNumber ? -1 : a.caseNumber > b.caseNumber ? 1 : 0;
  });

  const comms: CustomerCommsEntry[] = [];
  for (const attributed of cases) {
    for (const action of attributed.actions) {
      comms.push({
        key: `${attributed.id}:${action.id}`,
        caseId: attributed.id,
        caseNumber: attributed.caseNumber,
        type: action.type,
        source: action.source,
        scheduledFor: action.scheduledFor,
        completedAt: action.completedAt,
        outcome: action.outcome,
        consentRef: action.consentRef,
      });
    }
  }
  comms.sort((a, b) => {
    const byScheduled = -compareInstants(a.scheduledFor, b.scheduledFor);
    if (byScheduled !== 0) return byScheduled;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    cases,
    openCaseCount: liveCases.length,
    promises,
    comms,
  };
}
