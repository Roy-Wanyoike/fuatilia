import { describe, expect, it } from 'vitest';
import { specPayment, syntheticPaymentFullyApplied } from '@/lib/api/fixtures/payments';
import { specReceivable } from '@/lib/api/fixtures/receivables';
import type { PaymentView, ReceivableView } from '@/lib/api/wire-types';
import { derivePortalBalance } from '@/lib/portal/derive';

// =============================================================================
// PORTAL BALANCE DERIVATION (issue #86): outstanding / overdue / held on
// account over the two mounted read models. Exact integer minor-unit sums
// via lib/money.ts; mixed-currency books REFUSE to be totaled (R10).
// =============================================================================

/** Settled variant — carries no outstanding balance. */
const settledReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000003',
  state: 'settled',
  overdue: false,
  balance: { minor: 0, currency: 'KES' },
  settledAt: '2026-09-01T00:00:00.000Z',
  aging: null,
};

/** USD variant — mixed-currency book (R10 refusal path). */
const usdReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000004',
  currency: 'USD',
  original: { minor: 10000, currency: 'USD' },
  applied: { minor: 0, currency: 'USD' },
  balance: { minor: 10000, currency: 'USD' },
};

/** Payment with confirmed funds still unapplied — "held on account". */
const heldPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000002',
  unapplied: { minor: 12500, currency: 'KES' },
};

/** Payment fully applied — not held. */
const appliedPayment: PaymentView = syntheticPaymentFullyApplied;

describe('derivePortalBalance', () => {
  it('derives outstanding, overdue and held-on-account from the read models', () => {
    const summary = derivePortalBalance({
      receivables: [specReceivable, settledReceivable], // spec row: open money, overdue
      payments: [heldPayment, appliedPayment],
    });

    // Outstanding: only the partially_paid spec row (settled excluded).
    expect(summary.outstanding.count).toBe(1);
    expect(summary.outstanding.total).toEqual({ minor: 7500000, currency: 'KES' });
    expect(summary.outstanding.mixedCurrency).toBe(false);

    // Overdue: the same row is flagged overdue by the lane.
    expect(summary.overdue.count).toBe(1);
    expect(summary.overdue.total).toEqual({ minor: 7500000, currency: 'KES' });

    // Held on account: confirmed unapplied cash only (applied payment excluded).
    expect(summary.heldOnAccount.count).toBe(1);
    expect(summary.heldOnAccount.total).toEqual({ minor: 12500, currency: 'KES' });
  });

  it('sums exact integer minor units across many rows', () => {
    const rows: ReceivableView[] = [
      { ...specReceivable, balance: { minor: 12500000, currency: 'KES' } },
      { ...specReceivable, id: 'aa0a0a0a-0000-4000-8000-000000000005', balance: { minor: 750000, currency: 'KES' } },
      { ...specReceivable, id: 'aa0a0a0a-0000-4000-8000-000000000006', balance: { minor: 1, currency: 'KES' } },
    ];
    const summary = derivePortalBalance({ receivables: rows, payments: [] });
    expect(summary.outstanding.count).toBe(3);
    expect(summary.outstanding.total).toEqual({ minor: 13250001, currency: 'KES' });
  });

  it('refuses to total a mixed-currency book (R10) and says why', () => {
    const summary = derivePortalBalance({
      receivables: [specReceivable, usdReceivable],
      payments: [],
    });
    expect(summary.outstanding.count).toBe(2);
    expect(summary.outstanding.total).toBeNull();
    expect(summary.outstanding.mixedCurrency).toBe(true);
  });

  it('keeps counts while refusing sums beyond the exact integer range', () => {
    const hugeMinor = Number.MAX_SAFE_INTEGER; // one row already at the ceiling
    const summary = derivePortalBalance({
      receivables: [
        { ...specReceivable, balance: { minor: hugeMinor, currency: 'KES' } },
        { ...specReceivable, id: 'aa0a0a0a-0000-4000-8000-000000000007', balance: { minor: hugeMinor, currency: 'KES' } },
      ],
      payments: [],
    });
    expect(summary.outstanding.count).toBe(2);
    expect(summary.outstanding.total).toBeNull();
    expect(summary.outstanding.mixedCurrency).toBe(false);
  });

  it('renders zero-money books as real empty states (no rows / rows but nothing outstanding)', () => {
    const noRows = derivePortalBalance({ receivables: [], payments: [] });
    expect(noRows.outstanding).toEqual({ count: 0, total: null, mixedCurrency: false });
    expect(noRows.overdue).toEqual({ count: 0, total: null, mixedCurrency: false });
    expect(noRows.heldOnAccount).toEqual({ count: 0, total: null, mixedCurrency: false });

    const settledOnly = derivePortalBalance({ receivables: [settledReceivable], payments: [appliedPayment] });
    // Source rows exist, but nothing is outstanding — a subset-empty state.
    expect(settledOnly.outstanding.count).toBe(0);
    expect(settledOnly.outstanding.total).toBeNull(); // no contributing rows to sum
    expect(settledOnly.heldOnAccount.count).toBe(0);
  });

  it('never counts unconfirmed payments as held on account', () => {
    const initiated: PaymentView = {
      ...specPayment,
      state: 'initiated',
      confirmed: null,
      unapplied: { minor: 0, currency: 'KES' },
      confirmedAt: null,
    };
    const summary = derivePortalBalance({ receivables: [], payments: [initiated] });
    expect(summary.heldOnAccount.count).toBe(0);
  });
});
