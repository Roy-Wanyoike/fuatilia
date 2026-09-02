/**
 * Allocation strategies (issue #5; review finding H3 — "allocation order
 * undefined"). Default fifo (oldest-invoice-first), then explicit, then
 * pro-rata; pro-rata is built directly on `Money.allocate` (largest
 * remainder), fifo/explicit walk the receivables in cent-exact steps.
 *
 * Strategy contract (holds for ALL three):
 *   1. never allocate more than a receivable's outstanding balance;
 *   2. never allocate more than the funds passed in — the leftover stays
 *      unapplied (R2, parks on the customer per C4);
 *   3. cent-exact: Σ plan amounts ≤ payment, with equality whenever the
 *      outstanding debt can absorb the payment;
 *   4. deterministic: identical inputs → identical plans, in canonical
 *      receivable order, so replay yields the same sequenceNos.
 *
 * Illegal inputs throw DomainError with stable codes (table-driven tests pin
 * both the legal and illegal paths).
 */
import { DomainError, Money } from '../shared';
import type { Uuid } from '../shared';
import { ALLOCATION_ERRORS, balanceOf, type AllocatableReceivable } from './allocation';

/** One planned split leg — the engine turns these into Allocation rows. */
export interface StrategyPlan {
  readonly receivableId: Uuid;
  readonly amount: Money;
}

const byReceivableId = (a: AllocatableReceivable, b: AllocatableReceivable): number =>
  a.receivableId < b.receivableId ? -1 : a.receivableId > b.receivableId ? 1 : 0;

/** R10 — one execution, one currency. */
const assertSingleCurrency = (funds: Money, receivables: readonly AllocatableReceivable[]): void => {
  for (const receivable of receivables) {
    if (receivable.currency !== funds.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `receivable ${receivable.receivableId} is ${receivable.currency}, funds are ${funds.currency}`,
      );
    }
  }
};

/** Duplicate entries would double-count a balance and break R1. */
const assertNoDuplicates = (receivables: readonly AllocatableReceivable[]): void => {
  const seen = new Set<Uuid>();
  for (const receivable of receivables) {
    if (seen.has(receivable.receivableId)) {
      throw new DomainError(
        ALLOCATION_ERRORS.DUPLICATE_RECEIVABLE,
        `receivable ${receivable.receivableId} appears more than once`,
      );
    }
    seen.add(receivable.receivableId);
  }
};

/**
 * `fifo` (default, H3) — oldest invoice first: order by dueDate ascending,
 * ties broken by receivableId; undated receivables sort last (also by id).
 * Walk the queue, take min(remaining funds, outstanding balance) per
 * receivable, stop when the funds are exhausted. Skips zero-balance
 * receivables (no row — amountMinor must be > 0 per docs/05).
 */
export const allocateOldestFirst = (
  funds: Money,
  receivables: readonly AllocatableReceivable[],
): StrategyPlan[] => {
  assertSingleCurrency(funds, receivables);
  assertNoDuplicates(receivables);

  const ordered = [...receivables].sort((a, b) => {
    const ad = a.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bd = b.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
    return ad !== bd ? ad - bd : byReceivableId(a, b);
  });

  const plans: StrategyPlan[] = [];
  let remaining = funds.amount;
  for (const receivable of ordered) {
    if (remaining === 0n) break;
    const balance = balanceOf(receivable);
    if (!balance.isPositive()) continue;
    const take = balance.amount < remaining ? balance.amount : remaining;
    plans.push({ receivableId: receivable.receivableId, amount: Money.ofMinor(take, funds.currency) });
    remaining -= take;
  }
  return plans;
};

/**
 * `explicit` — the payer (or collections agent) declared which receivables
 * the funds settle. Guards:
 *   - every declared id must be a known receivable → ALLOCATION_UNKNOWN_RECEIVABLE;
 *   - a declaration above that receivable's outstanding balance is rejected,
 *     not silently capped → ALLOCATION_EXCEEDS_BALANCE (an explicit
 *     instruction that cannot be honored must fail loudly);
 *   - Σ declarations above the funds → ALLOCATION_EXCEEDS_AVAILABLE
 *     (over-declaration vs payment, R2);
 *   - declared Money must be in the funds' currency (R10).
 * Leftover (funds − Σ accepted declarations) stays unapplied.
 */
export const allocateExplicit = (
  funds: Money,
  receivables: readonly AllocatableReceivable[],
  declared: ReadonlyMap<Uuid, Money>,
): StrategyPlan[] => {
  assertSingleCurrency(funds, receivables);
  assertNoDuplicates(receivables);

  const byId = new Map<Uuid, AllocatableReceivable>(receivables.map((r) => [r.receivableId, r]));

  let declaredTotal = 0n;
  for (const [receivableId, amount] of declared) {
    const receivable = byId.get(receivableId);
    if (receivable === undefined) {
      throw new DomainError(
        ALLOCATION_ERRORS.UNKNOWN_RECEIVABLE,
        `declared receivable ${receivableId} is not in the allocatable set`,
      );
    }
    if (amount.currency !== funds.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `declaration for ${receivableId} is ${amount.currency}, funds are ${funds.currency}`,
      );
    }
    const balance = balanceOf(receivable);
    if (amount.amount > balance.amount) {
      throw new DomainError(
        ALLOCATION_ERRORS.EXCEEDS_BALANCE,
        `declared ${amount.amount} exceeds outstanding ${balance.amount} on ${receivableId}`,
      );
    }
    declaredTotal += amount.amount;
  }
  if (declaredTotal > funds.amount) {
    throw new DomainError(
      ALLOCATION_ERRORS.EXCEEDS_AVAILABLE,
      `declared ${declaredTotal} exceeds available ${funds.amount}`,
    );
  }

  return [...declared]
    .filter(([, amount]) => amount.isPositive())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([receivableId, amount]) => ({ receivableId, amount }));
};

/**
 * `pro_rata` — split the funds across outstanding balances proportionally
 * using Money.allocate (largest remainder): cent-exact (Σ parts === funds,
 * R10) and deterministic (ties broken by canonical receivable order).
 *
 * Zero-balance receivables are skipped before weighting (a zero weight can
 * carry no value, and an all-zero set means there is no debt to absorb
 * anything — empty plan, everything stays unapplied).
 *
 * Ceiling: weights ARE the outstanding balances, so when funds < Σ balances
 * every largest-remainder part is < its weight and the balance cap holds by
 * construction. When funds ≥ Σ balances, pro-rata degenerates to "settle
 * every receivable at its full balance" — the balance cap again — and the
 * surplus stays unapplied.
 */
export const allocateProRata = (
  funds: Money,
  receivables: readonly AllocatableReceivable[],
): StrategyPlan[] => {
  assertSingleCurrency(funds, receivables);
  assertNoDuplicates(receivables);

  const positive = receivables
    .map((receivable) => ({ receivable, balance: balanceOf(receivable) }))
    .filter(({ balance }) => balance.isPositive())
    .sort((a, b) => byReceivableId(a.receivable, b.receivable));

  if (positive.length === 0) return [];

  const outstanding = positive.reduce((sum, { balance }) => sum + balance.amount, 0n);
  if (funds.amount >= outstanding) {
    // Debt fully absorbed: every part equals its balance (cap-safe), surplus unapplied.
    return positive.map(({ receivable, balance }) => ({ receivableId: receivable.receivableId, amount: balance }));
  }

  // funds < Σ balances ⇒ every part is strictly below its weight (see header).
  const weights = positive.map(({ balance }) => Number(balance.amount));
  const parts = funds.allocate(weights);
  return positive
    .map(({ receivable }, index) => ({
      receivableId: receivable.receivableId,
      amount: parts[index] ?? Money.zero(funds.currency),
    }))
    .filter((plan) => plan.amount.isPositive());
};
