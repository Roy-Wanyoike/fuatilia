/**
 * Reconciliation — matches money to explanations (issue #3, findings C1/C5).
 *
 * C1 fix (docs/02 v2): a ReconciliationMatch points at the PAYMENT and at
 * nothing else (R5). One payer settles three invoices? The match carries the
 * three declared refs; one Payment → N receivables is expressed later through
 * allocations (wave 2, issue #5). A match NEVER allocates.
 *
 * `matchDecision` is a pure advisory decision for humans + the future allocation
 * engine: exact externalRef→invoiceNumber first, then fuzzy declaredRefs, else
 * the payment stays/becomes unapplied (parked on the customer — never dropped).
 *
 * Reversals are append-only (R3): `reverseMatch` returns a NEW match carrying
 * reversedAt/reason; the original match object is never edited.
 */
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import { matchReversedEvent, paymentMatchedEvent } from './events';
import type { PaymentEvent } from './events';
import { uuidFromSeed } from './ids';
import { isConfirmedFamily, isTerminal } from './payment';
import type { Payment } from './payment';

export type MatchConfidence = 'auto' | 'manual';

export interface ReconciliationMatch {
  readonly id: Uuid;
  readonly paymentId: Uuid; // the ONLY target (R5/C1)
  readonly declaredRefs: readonly string[]; // payer-typed invoice/receipt references
  readonly confidence: MatchConfidence;
  readonly matchedAt: Date;
  readonly reversedAt?: Date;
  readonly reversalReason?: string;
}

export interface OpenInvoiceRef {
  readonly receivableId: Uuid; // opaque — receivables are another lane
  readonly invoiceNumber: string;
  readonly dueDate: Date;
}

export interface InvoiceCandidate {
  readonly receivableId: Uuid;
  readonly invoiceNumber: string;
  readonly dueDate: Date;
}

/**
 * Advisory decision — a HINT for the allocation engine (E16 "Allocation (hint)"),
 * never an allocation. `candidates` carries every matching invoice (a payment
 * may explain many), sorted by earliest due date; no amounts, no posting.
 */
export type MatchDecision =
  | {
      readonly decision: 'matched';
      readonly basis: 'exact' | 'fuzzy';
      readonly paymentId: Uuid;
      readonly candidates: readonly InvoiceCandidate[];
    }
  | { readonly decision: 'unapplied'; readonly paymentId: Uuid };

export interface MatchResult {
  readonly match: ReconciliationMatch;
  readonly events: readonly PaymentEvent[];
}

const trimmed = (raw: string): string => raw.trim();

const normalizeDeclaredRefs = (refs: readonly string[] | undefined): readonly string[] => {
  const out: string[] = [];
  for (const raw of refs ?? []) {
    const ref = raw.trim();
    if (!ref) {
      throw new DomainError('MATCH_REF_BLANK', 'declared references cannot be blank');
    }
    if (!out.includes(ref)) out.push(ref);
  }
  if (out.length === 0) {
    throw new DomainError('MATCH_REFS_REQUIRED', 'a reconciliation match requires declared refs');
  }
  return out;
};

const assertMatchablePayment = (payment: Payment): void => {
  if (isTerminal(payment)) {
    throw new DomainError(
      'PAYMENT_TERMINAL',
      `payment ${payment.id} is ${payment.state} (terminal); it cannot be matched`,
    );
  }
  if (!isConfirmedFamily(payment)) {
    throw new DomainError(
      'PAYMENT_NOT_CONFIRMED',
      `matching applies to confirmed money; payment ${payment.id} is ${payment.state}`,
    );
  }
};

/**
 * Record that a payment is explained by the payer's declared references.
 * The match's only target is paymentId (R5). Validation is strict: channel
 * input is untrusted, so refs are trimmed/deduped and blank input is rejected.
 */
export const recordMatch = (
  payment: Payment,
  declaredRefs: readonly string[],
  confidence: MatchConfidence,
  clock: Clock,
  matchId?: Uuid,
): MatchResult => {
  if (confidence !== 'auto' && confidence !== 'manual') {
    throw new DomainError(
      'MATCH_CONFIDENCE_INVALID',
      `confidence must be 'auto' or 'manual', got ${String(confidence)}`,
    );
  }
  assertMatchablePayment(payment);
  const refs = normalizeDeclaredRefs(declaredRefs);
  const matchedAt = clock.now();
  const id =
    matchId ??
    uuidFromSeed(
      `match:${payment.id}:${refs.join('|')}:${confidence}:${matchedAt.toISOString()}`,
    );
  const match: ReconciliationMatch = {
    id,
    paymentId: payment.id,
    declaredRefs: refs,
    confidence,
    matchedAt,
  };
  return {
    match,
    events: [
      paymentMatchedEvent(
        { matchId: id, paymentId: payment.id, declaredRefs: refs, confidence },
        clock,
      ),
    ],
  };
};

/**
 * Append-only reversal (R3): returns a NEW match carrying reversedAt/reason;
 * the input match is never edited. A reversed match stays in history forever.
 */
export const reverseMatch = (
  match: ReconciliationMatch,
  reason: string,
  clock: Clock,
): MatchResult => {
  const why = reason.trim();
  if (!why) {
    throw new DomainError('REVERSAL_REASON_REQUIRED', 'a match reversal requires an explicit reason (R3)');
  }
  if (match.reversedAt) {
    throw new DomainError(
      'MATCH_ALREADY_REVERSED',
      `match ${match.id} was already reversed at ${match.reversedAt.toISOString()}`,
    );
  }
  const reversed: ReconciliationMatch = {
    ...match,
    reversedAt: clock.now(),
    reversalReason: why,
  };
  return {
    match: reversed,
    events: [matchReversedEvent({ matchId: match.id, reason: why }, clock)],
  };
};

/** Invoice numbers and payer-typed refs both get squashed to [A-Z0-9] before comparing. */
const normalizeRef = (value: string): string => value.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();

/**
 * Fuzzy declared-ref equality: exact after normalization, or a suffix
 * relationship for payer-typed partial refs (≥3 chars, so "12" never matches).
 */
const fuzzyRefMatch = (declared: string, invoiceNumber: string): boolean => {
  const ref = normalizeRef(declared);
  const inv = normalizeRef(invoiceNumber);
  if (!ref || !inv) return false;
  if (ref === inv) return true;
  if (ref.length >= 3 && inv.endsWith(ref)) return true;
  if (inv.length >= 3 && ref.endsWith(inv)) return true;
  return false;
};

const byDueDate = (a: InvoiceCandidate, b: InvoiceCandidate): number =>
  a.dueDate.getTime() - b.dueDate.getTime() ||
  (a.receivableId < b.receivableId ? -1 : a.receivableId > b.receivableId ? 1 : 0);

/**
 * Pure decision for "what does this payment explain?":
 *  1. exact: any open invoice whose invoiceNumber equals the payment's externalRef;
 *  2. fuzzy: any open invoice matched by the payer's declaredRefs;
 *  3. else: `unapplied` — the money parks on the customer, it is never dropped.
 * The decision carries candidates only — it never allocates (allocation is wave 2).
 */
export const matchDecision = (
  payment: Payment,
  openInvoices: readonly OpenInvoiceRef[],
): MatchDecision => {
  assertMatchablePayment(payment);
  const external = normalizeRef(payment.externalRef);
  if (external) {
    const exact = openInvoices
      .filter((inv) => normalizeRef(inv.invoiceNumber) === external)
      .map((inv) => ({ receivableId: inv.receivableId, invoiceNumber: inv.invoiceNumber, dueDate: inv.dueDate }))
      .sort(byDueDate);
    if (exact.length > 0) {
      return { decision: 'matched', basis: 'exact', paymentId: payment.id, candidates: exact };
    }
  }
  const fuzzy = openInvoices
    .filter((inv) => payment.declaredRefs.some((ref) => fuzzyRefMatch(ref, inv.invoiceNumber)))
    .map((inv) => ({ receivableId: inv.receivableId, invoiceNumber: inv.invoiceNumber, dueDate: inv.dueDate }))
    .sort(byDueDate);
  if (fuzzy.length > 0) {
    return { decision: 'matched', basis: 'fuzzy', paymentId: payment.id, candidates: fuzzy };
  }
  return { decision: 'unapplied', paymentId: payment.id };
};
