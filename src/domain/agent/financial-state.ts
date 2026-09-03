/**
 * financialStateOf — "what is this customer's financial position with us,
 * right now?" (issue #35, VISION §3.8: GET /agent/v1/customers/{id}/financial-state).
 *
 * A READ-ONLY projection over plain-data facts the caller supplies. It never
 * writes fund truth and never imports another lane: receivables, payments,
 * promises, disputes and the C4 credit balance arrive as fact rows with
 * opaque ids and bigint minor-unit amounts.
 *
 * What it answers, every field with evidence refs (the fact aggregate ids +
 * any source ids the adapter attached):
 *
 *   - current exposure per currency (open receivable balances, bigint minor
 *     units — currencies never mix, R10),
 *   - the open receivables with their age (whole days past due, same bucket
 *     boundaries as the receivables lane) and their relation split:
 *     disputed vs promised vs plain open (an open dispute outranks a pending
 *     promise — the deriveCaseStatus precedence),
 *   - the last payment date (money that landed),
 *   - unallocated payments (confirmed money parked, R2 remainder) and the
 *     customer credit balance (C4) — reported SEPARATELY so nothing is
 *     double-counted,
 *   - risk-relevant behavior flags with their published weights.
 *
 * The answer is one issue-#35 answer item: { subject, capability,
 * confidenceBasis, reasons[], evidenceIds[] } with the detail nested inside.
 *
 * Refusals (stable codes): empty inputs, cross-org facts, facts about a
 * different customer than the query subject, duplicate facts, malformed
 * fields. Facts about receivables that were not supplied are ignored (they
 * belong to another scope — derive.ts precedent).
 */
import { CURRENCIES, DomainError, type Clock, type Currency, type Uuid } from '../shared';
import {
  ageBucketOf,
  ageDaysOf,
  assertAgentClock,
  assertCustomerFact,
  assertDisputeFact,
  assertPaymentFact,
  assertPromiseFact,
  assertReceivableFact,
  assertUuidRef,
  FLAG_WEIGHTS,
  OPEN_RECEIVABLE_STATES,
  type AgentFlag,
  type CustomerFact,
  type DisputeFact,
  type PaymentFact,
  type PromiseFact,
  type ReceivableFact,
} from './facts';

// ---------------------------------------------------------------------------
// Answer shapes
// ---------------------------------------------------------------------------

export type FinancialStateCapability = 'financial_state';

/** Exposure of one currency: Σ open receivable balances in that currency. */
export interface ExposureRow {
  readonly currency: Currency;
  readonly exposureMinor: bigint;
  readonly receivableCount: number;
  readonly evidenceIds: readonly Uuid[];
}

/** One open receivable with its age, relation split and evidence. */
export interface OpenReceivableView {
  readonly receivableId: Uuid;
  readonly invoiceId: Uuid;
  readonly currency: Currency;
  readonly originalMinor: bigint;
  readonly paidMinor: bigint;
  readonly balanceMinor: bigint;
  readonly dueDate: string;
  readonly ageDays: number;
  readonly ageBucket: '0-30' | '31-60' | '61-90' | '90+';
  readonly overdue: boolean;
  /** disputed | promised | plain — dispute outranks promise (derive.ts precedence). */
  readonly relation: 'disputed' | 'promised' | 'plain';
  readonly evidenceIds: readonly Uuid[];
}

/** Confirmed money parked on the customer because it is not yet allocated (R2 remainder). */
export interface UnallocatedRow {
  readonly currency: Currency;
  readonly amountMinor: bigint;
  readonly paymentIds: readonly Uuid[];
  readonly evidenceIds: readonly Uuid[];
}

export interface CreditBalanceView {
  readonly currency: Currency;
  readonly amountMinor: bigint;
  readonly evidenceIds: readonly Uuid[];
}

export interface LastPaymentView {
  readonly paymentId: Uuid;
  readonly currency: Currency;
  readonly amountMinor: bigint;
  readonly receivedAt: string;
  readonly evidenceIds: readonly Uuid[];
}

export interface FlagView {
  readonly flag: AgentFlag;
  readonly weight: number;
  /** The customer fact the flag was projected from (behavior profiles are customer-level, F19). */
  readonly evidenceIds: readonly Uuid[];
}

/** The full answer — one issue-#35 answer item with the state detail nested. */
export interface FinancialStateAnswer {
  readonly subject: Uuid;
  readonly orgId: Uuid;
  readonly capability: FinancialStateCapability;
  /** ISO-8601 — the instant the state was derived (injected Clock). */
  readonly asOf: string;
  readonly confidenceBasis: string;
  readonly exposure: readonly ExposureRow[];
  readonly openReceivables: readonly OpenReceivableView[];
  readonly disputedReceivableIds: readonly Uuid[];
  readonly promisedReceivableIds: readonly Uuid[];
  readonly plainReceivableIds: readonly Uuid[];
  readonly lastPayment: LastPaymentView | null;
  readonly unallocatedPayments: readonly UnallocatedRow[];
  readonly creditBalance: CreditBalanceView | null;
  readonly flags: readonly FlagView[];
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly Uuid[];
}

export interface FinancialStateQuery {
  readonly orgId: Uuid;
  /** The subject customer the agent is asking about. */
  readonly customerId: Uuid;
  /** The customer's own fact row (flags, C4 credit balance) — optional. */
  readonly customer?: CustomerFact;
  readonly receivables?: readonly ReceivableFact[];
  readonly payments?: readonly PaymentFact[];
  readonly promises?: readonly PromiseFact[];
  readonly disputes?: readonly DisputeFact[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const currencyOrder = (currency: Currency): number => {
  const index = CURRENCIES.indexOf(currency);
  return index === -1 ? CURRENCIES.length : index;
};

const uniqueInOrder = (ids: readonly Uuid[]): Uuid[] => [...new Set(ids)];

// ---------------------------------------------------------------------------
// The capability query
// ---------------------------------------------------------------------------

export function financialStateOf(query: FinancialStateQuery, clock: Clock): FinancialStateAnswer {
  // ONE validated clock read for the whole answer (asOf + every age derive
  // from this instant — they can never disagree).
  const now = assertAgentClock(clock);
  const orgId = assertUuidRef(query.orgId, 'orgId');
  const customerId = assertUuidRef(query.customerId, 'customerId');

  const receivables = (query.receivables ?? []).map(assertReceivableFact);
  const payments = (query.payments ?? []).map(assertPaymentFact);
  if (receivables.length === 0 && payments.length === 0) {
    throw new DomainError(
      'AGENT_INPUT_EMPTY',
      `no receivable or payment facts for customer ${customerId} — there is no financial state to reason over`,
      { customerId },
    );
  }

  // The subject's customer fact (optional; at most one; others refused).
  let customer: CustomerFact | undefined;
  if (query.customer !== undefined) {
    const fact = assertCustomerFact(query.customer);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `customer fact belongs to org ${fact.orgId}, query is for org ${orgId}`,
      );
    }
    if (fact.customerId !== customerId) {
      throw new DomainError(
        'AGENT_CUSTOMER_MISMATCH',
        `customer fact is for ${fact.customerId}, query subject is ${customerId}`,
        { customerId },
      );
    }
    customer = fact;
  }

  // Receivables + payments must belong to the subject customer AND the org —
  // a wrong-subject fact would silently zero the answer, so it is refused.
  const receivablesById = new Map<Uuid, ReceivableFact>();
  for (const fact of receivables) {
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `receivable ${fact.receivableId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { receivableId: fact.receivableId },
      );
    }
    if (fact.customerId !== customerId) {
      throw new DomainError(
        'AGENT_CUSTOMER_MISMATCH',
        `receivable ${fact.receivableId} belongs to customer ${fact.customerId}, query subject is ${customerId}`,
        { receivableId: fact.receivableId },
      );
    }
    if (receivablesById.has(fact.receivableId)) {
      throw new DomainError(
        'AGENT_RECEIVABLE_DUPLICATE',
        `receivable ${fact.receivableId} supplied twice — duplicate evidence is refused`,
        { receivableId: fact.receivableId },
      );
    }
    receivablesById.set(fact.receivableId, fact);
  }

  const paymentsById = new Map<Uuid, PaymentFact>();
  for (const fact of payments) {
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `payment ${fact.paymentId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { paymentId: fact.paymentId },
      );
    }
    if (fact.customerId !== customerId) {
      throw new DomainError(
        'AGENT_CUSTOMER_MISMATCH',
        `payment ${fact.paymentId} belongs to customer ${fact.customerId}, query subject is ${customerId}`,
        { paymentId: fact.paymentId },
      );
    }
    if (paymentsById.has(fact.paymentId)) {
      throw new DomainError(
        'AGENT_PAYMENT_DUPLICATE',
        `payment ${fact.paymentId} supplied twice — duplicate evidence is refused`,
        { paymentId: fact.paymentId },
      );
    }
    paymentsById.set(fact.paymentId, fact);
  }

  // Promise/dispute facts are matched through their receivable; facts about
  // receivables that were not supplied are ignored (another scope's data).
  // Duplicate ids are refused — the same evidence supplied twice is a
  // projection bug, never silently merged (README: AGENT_*_DUPLICATE).
  const promisesByReceivableId = new Map<Uuid, PromiseFact[]>();
  const seenPromises = new Set<Uuid>();
  for (const raw of query.promises ?? []) {
    const fact = assertPromiseFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `promise ${fact.promiseId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { promiseId: fact.promiseId },
      );
    }
    if (seenPromises.has(fact.promiseId)) {
      throw new DomainError(
        'AGENT_PROMISE_DUPLICATE',
        `promise ${fact.promiseId} supplied twice — duplicate evidence is refused`,
        { promiseId: fact.promiseId },
      );
    }
    seenPromises.add(fact.promiseId);
    if (!receivablesById.has(fact.receivableId)) continue; // orphan — out of scope
    const rows = promisesByReceivableId.get(fact.receivableId) ?? [];
    rows.push(fact);
    promisesByReceivableId.set(fact.receivableId, rows);
  }

  const openDisputesByReceivableId = new Map<Uuid, DisputeFact[]>();
  const seenDisputes = new Set<Uuid>();
  for (const raw of query.disputes ?? []) {
    const fact = assertDisputeFact(raw);
    if (fact.orgId !== orgId) {
      throw new DomainError(
        'AGENT_ORG_MISMATCH',
        `dispute ${fact.disputeId} belongs to org ${fact.orgId}, query is for org ${orgId}`,
        { disputeId: fact.disputeId },
      );
    }
    if (seenDisputes.has(fact.disputeId)) {
      throw new DomainError(
        'AGENT_DISPUTE_DUPLICATE',
        `dispute ${fact.disputeId} supplied twice — duplicate evidence is refused`,
        { disputeId: fact.disputeId },
      );
    }
    seenDisputes.add(fact.disputeId);
    if (!fact.open || !receivablesById.has(fact.receivableId)) continue; // terminal or out of scope
    const rows = openDisputesByReceivableId.get(fact.receivableId) ?? [];
    rows.push(fact);
    openDisputesByReceivableId.set(fact.receivableId, rows);
  }

  // --- exposure + open receivables -----------------------------------------

  const openFacts = receivables.filter(
    (r) =>
      (OPEN_RECEIVABLE_STATES as readonly string[]).includes(r.state) &&
      r.originalMinor - r.paidMinor > 0n,
  );

  const exposureByCurrency = new Map<Currency, { minor: bigint; ids: Uuid[]; count: number }>();
  const openViews: OpenReceivableView[] = openFacts.map((fact) => {
    const balanceMinor = fact.originalMinor - fact.paidMinor;
    const row = exposureByCurrency.get(fact.currency) ?? { minor: 0n, ids: [], count: 0 };
    row.minor += balanceMinor;
    row.ids.push(fact.receivableId, ...(fact.evidenceIds ?? []));
    row.count += 1;
    exposureByCurrency.set(fact.currency, row);

    const disputes = openDisputesByReceivableId.get(fact.receivableId) ?? [];
    const promises = promisesByReceivableId.get(fact.receivableId) ?? [];
    const hasOpenDispute = disputes.length > 0;
    const hasPendingPromise = promises.some((p) => p.status === 'pending');
    const relation: OpenReceivableView['relation'] = hasOpenDispute
      ? 'disputed'
      : hasPendingPromise
        ? 'promised'
        : 'plain';

    const evidenceIds: Uuid[] = [fact.receivableId, ...(fact.evidenceIds ?? [])];
    if (relation === 'disputed') {
      for (const dispute of disputes) evidenceIds.push(dispute.disputeId, ...(dispute.evidenceIds ?? []));
    }
    if (relation === 'promised') {
      for (const promise of promises) {
        if (promise.status === 'pending') evidenceIds.push(promise.promiseId, ...(promise.evidenceIds ?? []));
      }
    }

    const ageDays = ageDaysOf(fact.dueDate, now);
    return {
      receivableId: fact.receivableId,
      invoiceId: fact.invoiceId,
      currency: fact.currency,
      originalMinor: fact.originalMinor,
      paidMinor: fact.paidMinor,
      balanceMinor,
      dueDate: fact.dueDate,
      ageDays,
      ageBucket: ageBucketOf(ageDays),
      overdue: fact.overdue === true,
      relation,
      evidenceIds: uniqueInOrder(evidenceIds),
    };
  });

  // Deterministic: oldest first, then larger balance, then id.
  openViews.sort((a, b) => {
    if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;
    if (a.balanceMinor !== b.balanceMinor) return a.balanceMinor > b.balanceMinor ? -1 : 1;
    return a.receivableId < b.receivableId ? -1 : 1;
  });

  const exposure: ExposureRow[] = [...exposureByCurrency.entries()]
    .sort((a, b) => currencyOrder(a[0]) - currencyOrder(b[0]))
    .map(([currency, row]) => ({
      currency,
      exposureMinor: row.minor,
      receivableCount: row.count,
      evidenceIds: uniqueInOrder(row.ids),
    }));

  const disputedReceivableIds = openViews.filter((v) => v.relation === 'disputed').map((v) => v.receivableId);
  const promisedReceivableIds = openViews.filter((v) => v.relation === 'promised').map((v) => v.receivableId);
  const plainReceivableIds = openViews.filter((v) => v.relation === 'plain').map((v) => v.receivableId);

  // --- payments: last payment + unallocated remainder ----------------------

  const lastPaymentFact = [...payments].sort((a, b) => {
    const t = new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
    if (t !== 0) return t; // most recent first
    return a.paymentId < b.paymentId ? -1 : 1; // deterministic tie-break
  })[0];
  const lastPayment: LastPaymentView | null = lastPaymentFact
    ? {
        paymentId: lastPaymentFact.paymentId,
        currency: lastPaymentFact.currency,
        amountMinor: lastPaymentFact.amountMinor,
        receivedAt: lastPaymentFact.receivedAt,
        evidenceIds: uniqueInOrder([lastPaymentFact.paymentId, ...(lastPaymentFact.evidenceIds ?? [])]),
      }
    : null;

  const unallocatedByCurrency = new Map<Currency, { minor: bigint; paymentIds: Uuid[]; evidenceIds: Uuid[] }>();
  for (const fact of payments) {
    const remainder = fact.amountMinor - (fact.allocatedMinor ?? fact.amountMinor);
    if (remainder <= 0n) continue;
    const row = unallocatedByCurrency.get(fact.currency) ?? { minor: 0n, paymentIds: [], evidenceIds: [] };
    row.minor += remainder;
    row.paymentIds.push(fact.paymentId);
    row.evidenceIds.push(fact.paymentId, ...(fact.evidenceIds ?? []));
    unallocatedByCurrency.set(fact.currency, row);
  }
  const unallocatedPayments: UnallocatedRow[] = [...unallocatedByCurrency.entries()]
    .sort((a, b) => currencyOrder(a[0]) - currencyOrder(b[0]))
    .map(([currency, row]) => ({
      currency,
      amountMinor: row.minor,
      paymentIds: row.paymentIds,
      evidenceIds: uniqueInOrder(row.evidenceIds),
    }));

  const creditBalance: CreditBalanceView | null =
    customer?.creditBalanceMinor !== undefined && customer.creditCurrency !== undefined
      ? {
          currency: customer.creditCurrency,
          amountMinor: customer.creditBalanceMinor,
          evidenceIds: uniqueInOrder([customerId, ...(customer.evidenceIds ?? [])]),
        }
      : null;

  // --- risk-relevant flags --------------------------------------------------

  const flags: FlagView[] = [];
  for (const flag of [...new Set(customer?.flags ?? [])]) {
    flags.push({
      flag: flag as AgentFlag,
      weight: FLAG_WEIGHTS[flag as AgentFlag],
      evidenceIds: uniqueInOrder([customerId, ...(customer?.evidenceIds ?? [])]),
    });
  }
  flags.sort((a, b) => (a.flag < b.flag ? -1 : a.flag > b.flag ? 1 : 0));

  // --- the answer item ------------------------------------------------------

  const evidenceIds = uniqueInOrder([
    ...openFacts.flatMap((r) => [r.receivableId, ...(r.evidenceIds ?? [])]),
    ...payments.flatMap((p) => [p.paymentId, ...(p.evidenceIds ?? [])]),
    ...[...promisesByReceivableId.values()].flat().map((p) => p.promiseId),
    ...[...openDisputesByReceivableId.values()].flat().map((d) => d.disputeId),
    ...(customer ? [customerId, ...(customer.evidenceIds ?? [])] : []),
  ]);

  const reasons: string[] = [];
  for (const row of exposure) {
    reasons.push(`exposure ${row.exposureMinor} minor ${row.currency} across ${row.receivableCount} open receivable(s)`);
  }
  if (openViews.length > 0) {
    const oldest = openViews[0]!;
    reasons.push(`oldest open receivable ${oldest.receivableId} is ${oldest.ageDays}d past due (${oldest.ageBucket})`);
  }
  if (disputedReceivableIds.length > 0) {
    reasons.push(
      `${disputedReceivableIds.length} open receivable(s) disputed — automated collection is paused (SPEC §29)`,
    );
  }
  if (promisedReceivableIds.length > 0) {
    reasons.push(`${promisedReceivableIds.length} open receivable(s) covered by a pending promise`);
  }
  reasons.push(
    lastPayment
      ? `last payment ${lastPayment.amountMinor} minor ${lastPayment.currency} received ${lastPayment.receivedAt}`
      : 'no payments on record',
  );
  for (const row of unallocatedPayments) {
    reasons.push(`unallocated payments parked: ${row.amountMinor} minor ${row.currency}`);
  }
  if (creditBalance) {
    reasons.push(`customer credit balance available: ${creditBalance.amountMinor} minor ${creditBalance.currency}`);
  }
  if (flags.length > 0) {
    reasons.push(`risk flags: ${flags.map((f) => `${f.flag}(${f.weight})`).join(', ')}`);
  }

  return {
    subject: customerId,
    orgId,
    capability: 'financial_state',
    asOf: now.toISOString(),
    confidenceBasis: `derived from ${openFacts.length} open + ${receivables.length - openFacts.length} closed receivable fact(s), ${payments.length} payment fact(s); every evidence id resolves to a supplied input`,
    exposure,
    openReceivables: openViews,
    disputedReceivableIds,
    promisedReceivableIds,
    plainReceivableIds,
    lastPayment,
    unallocatedPayments,
    creditBalance,
    flags,
    reasons,
    evidenceIds,
  };
}
