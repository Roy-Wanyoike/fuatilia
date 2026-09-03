/**
 * The posting matrix — the core of F11 (issue #18; docs/05 "Posting matrix
 * (sub-ledger, K5/R4)"; review finding K5).
 *
 * A pure, frozen table mapping every money-moving source event to EXACTLY ONE
 * balanced journal entry:
 *
 *   | Issue #18 row    | Source event                   | Debit           | Credit          |
 *   |------------------|--------------------------------|-----------------|-----------------|
 *   | invoiceIssued    | invoicing.invoiceIssued        | AR_CONTROL      | REVENUE         |
 *   | paymentCompleted | payments.paymentCompleted      | CASH            | AR_CONTROL      |
 *   | creditNoteApplied| adjustments.creditNoteApplied  | REVENUE_CONTRA  | AR_CONTROL      |
 *   | refundCompleted  | adjustments.refundCompleted    | SALES_REFUNDS   | CASH            |
 *   | writeOffApproved | receivables.writeOffApproved   | BAD_DEBT_EXPENSE| AR_CONTROL      |
 *   | lateFeeAssessed  | receivables.lateFeeAssessed    | AR_CONTROL      | OTHER_INCOME    |
 *
 * docs/05's "Allocation executed" row is deliberately ABSENT: an allocation
 * moves nothing across accounts (the docs mark it "memo only; movement is
 * within AR") — there is nothing to post, so there is no matrix row, and an
 * allocation event reaching `post` is rejected with LEDGER_EVENT_NOT_POSTABLE
 * rather than silently zero-posted.
 *
 * The matrix is data, not code paths: `post` (./journal.ts) reads it, builds
 * the two lines, and the balance check proves the entry balances. A matrix row
 * can therefore never drift out of balance.
 */
import type { Account } from './accounts';
import type { MoneyMovementEventName } from './events';

/** One matrix row: the balanced Dr/Cr pair an event posts to. */
export interface MatrixRow {
  readonly debit: Account;
  readonly credit: Account;
}

export const POSTING_MATRIX: Readonly<Record<MoneyMovementEventName, MatrixRow>> = Object.freeze({
  'invoicing.invoiceIssued': { debit: 'AR_CONTROL', credit: 'REVENUE' },
  'payments.paymentCompleted': { debit: 'CASH', credit: 'AR_CONTROL' },
  'adjustments.creditNoteApplied': { debit: 'REVENUE_CONTRA', credit: 'AR_CONTROL' },
  'adjustments.refundCompleted': { debit: 'SALES_REFUNDS', credit: 'CASH' },
  'receivables.writeOffApproved': { debit: 'BAD_DEBT_EXPENSE', credit: 'AR_CONTROL' },
  'receivables.lateFeeAssessed': { debit: 'AR_CONTROL', credit: 'OTHER_INCOME' },
});

/** True when an event name has a matrix row (i.e. is postable). */
export const isPostableEvent = (name: string): name is MoneyMovementEventName =>
  Object.prototype.hasOwnProperty.call(POSTING_MATRIX, name);
