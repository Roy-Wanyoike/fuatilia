import type { Money } from '@/lib/api/envelope';
import type { PaymentView } from '@/lib/api/wire-types';

/**
 * Statement-timeline derivation (issue #86).
 *
 * The payer's statement is derived from the GET /v1/payments read model —
 * the mounted surface has no statement endpoint, so every entry below is a
 * CONTRACT FIELD transcript, never an invention:
 *
 *   - confirmation — `confirmedAt` + `confirmed` (set exactly once by the
 *     success callback);
 *   - allocation   — one entry per row of `allocations[]` (`recordedAt`,
 *     `amount`, `receivableId`);
 *   - refund       — one entry per row of `refunds[]` (`recordedAt`,
 *     `amount`, `reason`);
 *   - reversal     — `reversedAt` + `reversalReason`; the money shown is the
 *     payment's `confirmed` amount (the funds being returned). A reversal of
 *     a never-confirmed payment carries no money — `amount: null`, stated.
 *   - failure      — `failedAt` + `failureCode`; the amount shown is the
 *     `requested` amount, labelled as attempted (a failed payment never took
 *     money).
 *
 * Money values pass through untouched in integer minor units; rendering is
 * lib/money.ts's exact formatter. Entries sort newest-first (`at` desc) with
 * a deterministic tie-break, so the timeline is stable across fetches.
 */

export const STATEMENT_KINDS = [
  'confirmation',
  'allocation',
  'refund',
  'reversal',
  'failure',
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export interface StatementEntry {
  /** Deterministic unique key for list rendering. */
  key: string;
  kind: StatementKind;
  /** ISO 8601 instant the entry happened at (contract field). */
  at: string;
  paymentId: string;
  /** Daraja receipt reference (contract field `externalRef`). */
  externalRef: string;
  /** Integer minor units, passed through untouched. */
  amount: Money | null;
  /** Human detail: reason / failure code / applied-to reference. */
  detail: string | null;
}

/** Deterministic tie-break order for entries sharing an instant. */
const KIND_TIE_ORDER: Record<StatementKind, number> = {
  confirmation: 0,
  allocation: 1,
  refund: 2,
  reversal: 3,
  failure: 4,
};

export function deriveStatement(payments: readonly PaymentView[]): StatementEntry[] {
  const entries: StatementEntry[] = [];

  for (const payment of payments) {
    if (payment.confirmedAt !== null && payment.confirmed !== null) {
      entries.push({
        key: `${payment.id}:confirmation`,
        kind: 'confirmation',
        at: payment.confirmedAt,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        amount: payment.confirmed,
        detail: null,
      });
    }

    for (const allocation of payment.allocations) {
      entries.push({
        key: `${payment.id}:allocation:${allocation.id}`,
        kind: 'allocation',
        at: allocation.recordedAt,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        amount: allocation.amount,
        detail: `applied to receivable ${allocation.receivableId}`,
      });
    }

    for (const refund of payment.refunds) {
      entries.push({
        key: `${payment.id}:refund:${refund.id}`,
        kind: 'refund',
        at: refund.recordedAt,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        amount: refund.amount,
        detail: refund.reason.length > 0 ? `reason: ${refund.reason}` : null,
      });
    }

    if (payment.reversedAt !== null) {
      entries.push({
        key: `${payment.id}:reversal`,
        kind: 'reversal',
        at: payment.reversedAt,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        // The funds being returned are the confirmed amount; a payment that
        // was never confirmed carries no money on a reversal.
        amount: payment.confirmed,
        detail:
          payment.reversalReason !== null && payment.reversalReason.length > 0
            ? `reason: ${payment.reversalReason}`
            : payment.confirmed === null
              ? 'reversed before confirmation — no funds moved'
              : null,
      });
    }

    if (payment.failedAt !== null) {
      entries.push({
        key: `${payment.id}:failure`,
        kind: 'failure',
        at: payment.failedAt,
        paymentId: payment.id,
        externalRef: payment.externalRef,
        amount: payment.requested,
        detail:
          payment.failureCode !== null && payment.failureCode.length > 0
            ? `failure code: ${payment.failureCode}`
            : null,
      });
    }
  }

  return entries.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1; // newest first
    const kindDelta = KIND_TIE_ORDER[a.kind] - KIND_TIE_ORDER[b.kind];
    if (kindDelta !== 0) return kindDelta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
