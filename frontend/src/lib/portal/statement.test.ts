import { describe, expect, it } from 'vitest';
import { specPayment } from '@/lib/api/fixtures/payments';
import type { PaymentView } from '@/lib/api/wire-types';
import { deriveStatement } from '@/lib/portal/statement';

// =============================================================================
// STATEMENT TIMELINE DERIVATION (issue #86): every entry is a transcript of
// contract fields — confirmations, allocations, refunds, reversals,
// failures — sorted newest-first with a deterministic tie-break. Money is
// integer minor units passed through untouched.
// =============================================================================

/** Payment with the full lifecycle: confirmation → allocation → refund. */
const fullyTraveledPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000010',
  externalRef: 'SBK41XQ7RZ',
  state: 'partially_allocated',
  confirmed: { minor: 750000, currency: 'KES' },
  unapplied: { minor: 0, currency: 'KES' },
  allocations: [
    {
      id: 'cc0c0c0c-0000-4000-8000-000000000010',
      receivableId: '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
      amount: { minor: 500000, currency: 'KES' },
      recordedAt: '2026-09-05T09:00:00.000Z',
    },
  ],
  refunds: [
    {
      id: 'dd0d0d0d-0000-4000-8000-000000000010',
      amount: { minor: 100000, currency: 'KES' },
      reason: 'duplicate payment',
      recordedAt: '2026-09-06T09:00:00.000Z',
    },
  ],
};

/** Failure: STK push never confirmed. */
const failedPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000011',
  externalRef: 'SBK41XQ7S0',
  state: 'failed',
  confirmed: null,
  unapplied: { minor: 0, currency: 'KES' },
  requested: { minor: 250000, currency: 'KES' },
  confirmedAt: null,
  failedAt: '2026-09-04T18:30:00.000Z',
  failureCode: 'MPESA_REQUEST_CANCELLED',
};

/** Reversal of confirmed money. */
const reversedPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000012',
  externalRef: 'SBK41XQ7S1',
  state: 'reversed',
  reversedAt: '2026-09-07T08:00:00.000Z',
  reversalReason: 'bank reversal',
};

/** Reversal of a payment that was never confirmed — no funds moved. */
const reversedUnconfirmedPayment: PaymentView = {
  ...failedPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000013',
  externalRef: 'SBK41XQ7S2',
  state: 'reversed',
  failedAt: null,
  failureCode: null,
  reversedAt: '2026-09-08T08:00:00.000Z',
  reversalReason: 'erroneous intake',
};

describe('deriveStatement', () => {
  it('transcribes confirmations, allocations and refunds as separate entries', () => {
    const entries = deriveStatement([fullyTraveledPayment]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'refund', // 2026-09-06 newest
      'allocation', // 2026-09-05
      'confirmation', // 2026-09-04 (spec confirmedAt)
    ]);

    const refund = entries[0]!;
    const allocation = entries[1]!;
    const confirmation = entries[2]!;
    // Money passes through in integer minor units, untouched.
    expect(refund.amount).toEqual({ minor: 100000, currency: 'KES' });
    expect(refund.detail).toBe('reason: duplicate payment');
    expect(allocation.amount).toEqual({ minor: 500000, currency: 'KES' });
    expect(allocation.detail).toBe('applied to receivable 6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4');
    expect(confirmation.amount).toEqual({ minor: 750000, currency: 'KES' });
    expect(confirmation.at).toBe('2026-09-04T10:01:30.000Z');
    // Every entry keeps the payment reference for the payer.
    for (const entry of entries) {
      expect(entry.externalRef).toBe('SBK41XQ7RZ');
      expect(entry.paymentId).toBe('bb0b0b0b-0000-4000-8000-000000000010');
    }
  });

  it('derives failure entries with the attempted amount and the failure code', () => {
    const entries = deriveStatement([failedPayment]);
    expect(entries).toHaveLength(1);
    const failure = entries[0]!;
    expect(failure.kind).toBe('failure');
    expect(failure.amount).toEqual({ minor: 250000, currency: 'KES' });
    expect(failure.detail).toBe('failure code: MPESA_REQUEST_CANCELLED');
    expect(failure.at).toBe('2026-09-04T18:30:00.000Z');
  });

  it('derives reversal entries with the confirmed funds being returned', () => {
    const entries = deriveStatement([reversedPayment]);
    // The confirmed payment also carries its confirmation entry; the
    // reversal rides alongside it.
    expect(entries.map((entry) => entry.kind)).toEqual(['reversal', 'confirmation']);
    const reversal = entries[0]!;
    expect(reversal.amount).toEqual({ minor: 750000, currency: 'KES' });
    expect(reversal.detail).toBe('reason: bank reversal');
  });

  it('states explicitly when a reversal moved no funds (never confirmed)', () => {
    const entries = deriveStatement([reversedUnconfirmedPayment]);
    const reversal = entries[0]!;
    expect(reversal.kind).toBe('reversal');
    expect(reversal.amount).toBeNull();
    expect(reversal.detail).toBe('reason: erroneous intake');
  });

  it('sorts across payments newest-first with a deterministic tie-break', () => {
    const entries = deriveStatement([failedPayment, reversedPayment, fullyTraveledPayment]);
    // reversedPayment carries a confirmation too (same instant as the
    // fully-traveled one — resolved by the deterministic key tie-break).
    expect(entries.map((entry) => entry.at)).toEqual([
      '2026-09-07T08:00:00.000Z',
      '2026-09-06T09:00:00.000Z',
      '2026-09-05T09:00:00.000Z',
      '2026-09-04T18:30:00.000Z',
      '2026-09-04T10:01:30.000Z',
      '2026-09-04T10:01:30.000Z',
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'reversal',
      'refund',
      'allocation',
      'failure',
      'confirmation', // specPayment ('8d9e…' sorts before 'bb0b…')
      'confirmation',
    ]);
    // Same instant → kind tie-order (confirmation < allocation < refund …).
    // Refunds are cleared so this fixture isolates the tie-break itself
    // (fullyTraveledPayment's 2026-09-06 refund is ordered newest-first in
    // the assertions above).
    const sameInstant = deriveStatement([
      {
        ...fullyTraveledPayment,
        refunds: [],
        allocations: [
          {
            id: 'cc0c0c0c-0000-4000-8000-000000000011',
            receivableId: '6b8c9d0e-1f2a-4b3c-8d4e-5f60718293a4',
            amount: { minor: 1, currency: 'KES' },
            recordedAt: '2026-09-04T10:01:30.000Z',
          },
        ],
      },
    ]);
    expect(sameInstant.map((entry) => entry.kind)).toEqual(['confirmation', 'allocation']);
  });

  it('keys every entry uniquely for stable list rendering', () => {
    const entries = deriveStatement([fullyTraveledPayment, failedPayment, reversedPayment]);
    const keys = new Set(entries.map((entry) => entry.key));
    expect(keys.size).toBe(entries.length);
  });

  it('returns an empty timeline for an empty payment read model', () => {
    expect(deriveStatement([])).toEqual([]);
  });

  it('omits the confirmation entry while a payment is still unconfirmed', () => {
    const initiated: PaymentView = {
      ...specPayment,
      state: 'initiated',
      confirmed: null,
      confirmedAt: null,
    };
    expect(deriveStatement([initiated])).toEqual([]);
  });
});
