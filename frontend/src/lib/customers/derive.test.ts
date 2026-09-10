import { describe, expect, it } from 'vitest';
import type { CaseView, PaymentView, ReceivableView } from '@/lib/api/wire-types';
import {
  specPayment,
  syntheticPaymentFullyApplied,
} from '@/lib/api/fixtures/payments';
import {
  specReceivable,
  syntheticReceivableDeepAged,
  syntheticReceivableDueToday,
} from '@/lib/api/fixtures/receivables';
import {
  specCase,
  syntheticPromisedCase,
  syntheticPromisedCaseMissed,
} from '@/lib/api/fixtures/collections';
import {
  attributeCustomerCases,
  BUCKET_ORDER,
  deriveCustomerDirectory,
  summarizeCustomerPayments,
  summarizeCustomerReceivables,
} from './derive';

// =============================================================================
// Customer 360 derivations (issue #134) — pure-layer evidence.
// Every row below is a spec-derived fixture (lib/api/fixtures) or a
// schema-shaped spread variant; the derivations must use contract fields
// only and refuse to total mixed currencies (R10).
// =============================================================================

// Fixed "now": 2026-09-04T09:00:00Z == 12:00 Africa/Nairobi (UTC+3).
const NOW = new Date('2026-09-04T09:00:00.000Z');

const CUSTOMER = '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b';
const OTHER_CUSTOMER = '99990000-1111-4789-8a0b-1c2d3e4f5a6b';

const otherCustomerReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000003',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322104',
  customerId: OTHER_CUSTOMER,
};

const usdReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000004',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322105',
  currency: 'USD',
  original: { minor: 100000, currency: 'USD' },
  applied: { minor: 0, currency: 'USD' },
  balance: { minor: 100000, currency: 'USD' },
  state: 'open',
  overdue: false,
  dueDate: '2026-09-20T00:00:00.000Z',
  aging: { daysPastDue: 0, bucket: '0-30' },
};

const settledReceivable: ReceivableView = {
  ...specReceivable,
  id: 'aa0a0a0a-0000-4000-8000-000000000005',
  invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322106',
  original: { minor: 5000000, currency: 'KES' },
  applied: { minor: 5000000, currency: 'KES' },
  balance: { minor: 0, currency: 'KES' },
  state: 'settled',
  overdue: false,
  dueDate: '2026-07-01T00:00:00.000Z',
  settledAt: '2026-07-01T09:00:00.000Z',
  aging: null,
};

const unattributedPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000002',
  externalRef: 'SBK41XQ7RV',
  idempotencyKey: 'daraja-c2b-SBK41XQ7RV',
  customerId: null,
};

const usdPayment: PaymentView = {
  ...specPayment,
  id: 'bb0b0b0b-0000-4000-8000-000000000003',
  externalRef: 'SBK41XQ7VW',
  idempotencyKey: 'daraja-c2b-SBK41XQ7VW',
  currency: 'USD',
  requested: { minor: 25000, currency: 'USD' },
  confirmed: { minor: 25000, currency: 'USD' },
  unapplied: { minor: 0, currency: 'USD' },
  initiatedAt: '2026-09-05T10:00:00.000Z',
  confirmedAt: '2026-09-05T10:01:00.000Z',
};

/** A case over another customer's receivable — must never attribute. */
const foreignCase: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000004',
  caseNumber: 'CASE-000011',
  sequence: 11,
  receivableIds: [otherCustomerReceivable.id],
};

/** A resolved case over the customer's receivable — history still counts. */
const resolvedCase: CaseView = {
  ...specCase,
  id: 'dd0d0d0d-0000-4000-8000-000000000005',
  caseNumber: 'CASE-000012',
  sequence: 12,
  status: 'resolved',
  derivedStatus: 'resolved',
  closedAt: '2026-08-20T09:00:00.000Z',
  actions: [
    {
      id: 'ee0e0e0e0000000000000000000000d1',
      type: 'sms',
      scheduledFor: '2026-08-10T09:00:00.000Z',
      outcome: 'balance reminder delivered',
      completedAt: '2026-08-10T09:05:00.000Z',
      completedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      consentRef: 'consent-000123',
      source: 'automated',
      actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
      recordedAt: '2026-08-09T09:00:00.000Z',
    },
  ],
};

// ---------------------------------------------------------------------------
// deriveCustomerDirectory
// ---------------------------------------------------------------------------

describe('deriveCustomerDirectory', () => {
  it('groups distinct customerIds across receivables and payments', () => {
    const entries = deriveCustomerDirectory({
      receivables: [specReceivable, otherCustomerReceivable],
      payments: [specPayment, unattributedPayment],
    });

    expect(entries).toHaveLength(2);
    const ours = entries.find((e) => e.customerId === CUSTOMER);
    expect(ours).toBeDefined();
    expect(ours!.receivableCount).toBe(1);
    expect(ours!.outstanding).toEqual({
      count: 1,
      total: { minor: 7500000, currency: 'KES' },
      mixedCurrency: false,
    });
    expect(ours!.overdueCount).toBe(1);
    // Payment initiatedAt (2026-09-04) beats the receivable openedAt (2026-08-01).
    expect(ours!.lastActivityAt).toBe('2026-09-04T10:00:00.000Z');

    const theirs = entries.find((e) => e.customerId === OTHER_CUSTOMER);
    expect(theirs).toBeDefined();
    expect(theirs!.outstanding).toEqual({
      count: 1,
      total: { minor: 7500000, currency: 'KES' },
      mixedCurrency: false,
    });
  });

  it('includes payments-only customers and never mints customers from null customerId', () => {
    const entries = deriveCustomerDirectory({
      receivables: [],
      payments: [specPayment, unattributedPayment],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.customerId).toBe(CUSTOMER);
    expect(entries[0]!.receivableCount).toBe(0);
    expect(entries[0]!.outstanding.count).toBe(0);
    expect(entries[0]!.outstanding.total).toBeNull();
    expect(entries[0]!.lastActivityAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('sorts newest activity first, nulls last, with an id tie-break', () => {
    const draftOnly: ReceivableView = {
      ...specReceivable,
      id: 'aa0a0a0a-0000-4000-8000-000000000006',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322107',
      customerId: '22220000-3333-4789-8a0b-1c2d3e4f5a6b',
      state: 'draft',
      openedAt: null,
      aging: null,
      overdue: false,
    };
    // Two customers sharing an instant → id ascending between them.
    const tieA: ReceivableView = {
      ...specReceivable,
      id: 'aa0a0a0a-0000-4000-8000-000000000007',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322108',
      customerId: '55550000-6666-4789-8a0b-1c2d3e4f5a6b',
      openedAt: '2026-09-02T08:00:00.000Z',
      overdue: false,
    };
    const tieB: ReceivableView = {
      ...specReceivable,
      id: 'aa0a0a0a-0000-4000-8000-000000000008',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-655443322109',
      customerId: '44440000-6666-4789-8a0b-1c2d3e4f5a6b',
      openedAt: '2026-09-02T08:00:00.000Z',
      overdue: false,
    };

    const entries = deriveCustomerDirectory({
      receivables: [draftOnly, tieA, tieB, specReceivable],
      payments: [specPayment],
    });

    expect(entries.map((e) => e.customerId)).toEqual([
      CUSTOMER, // 2026-09-04 — the payment's initiatedAt is the newest activity
      '44440000-6666-4789-8a0b-1c2d3e4f5a6b', // tied 2026-09-02, id ascending
      '55550000-6666-4789-8a0b-1c2d3e4f5a6b',
      '22220000-3333-4789-8a0b-1c2d3e4f5a6b', // no dated activity → last
    ]);
  });

  it('refuses mixed-currency outstanding totals (R10) with count preserved', () => {
    const entries = deriveCustomerDirectory({
      receivables: [specReceivable, usdReceivable],
      payments: [],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.outstanding.count).toBe(2);
    expect(entries[0]!.outstanding.total).toBeNull();
    expect(entries[0]!.outstanding.mixedCurrency).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// summarizeCustomerReceivables
// ---------------------------------------------------------------------------

describe('summarizeCustomerReceivables', () => {
  it('keeps only the customer rows, sorted due-date ascending', () => {
    const summary = summarizeCustomerReceivables({
      customerId: CUSTOMER,
      receivables: [otherCustomerReceivable, specReceivable, usdReceivable],
    });

    // specReceivable due 2026-08-15, usdReceivable due 2026-09-20; the other
    // customer's row must not appear.
    expect(summary.receivables.map((r) => r.id)).toEqual([
      specReceivable.id,
      usdReceivable.id,
    ]);
  });

  it('derives outstanding, overdue buckets and terminal counts', () => {
    const summary = summarizeCustomerReceivables({
      customerId: CUSTOMER,
      receivables: [specReceivable, syntheticReceivableDueToday, syntheticReceivableDeepAged, settledReceivable],
    });

    expect(summary.outstanding.count).toBe(3);
    expect(summary.outstanding.total).toEqual({ minor: 22500000, currency: 'KES' });
    expect(summary.overdue.count).toBe(2);
    expect(summary.overdue.total).toEqual({ minor: 15000000, currency: 'KES' });
    expect(summary.overdue.buckets).toEqual({ '0-30': 1, '31-60': 0, '61-90': 0, '90+': 1 });
    expect(summary.overdue.worstBucket).toBe('90+');
    expect(summary.terminalCount).toBe(1); // the settled row
  });

  it('totals each aging bucket over outstanding rows only and skips settled money', () => {
    const summary = summarizeCustomerReceivables({
      customerId: CUSTOMER,
      receivables: [specReceivable, syntheticReceivableDeepAged, settledReceivable],
    });

    expect(summary.agingBuckets['0-30']).toEqual({
      count: 1,
      total: { minor: 7500000, currency: 'KES' },
      mixedCurrency: false,
    });
    expect(summary.agingBuckets['90+']).toEqual({
      count: 1,
      total: { minor: 7500000, currency: 'KES' },
      mixedCurrency: false,
    });
    expect(summary.agingBuckets['31-60']).toEqual({
      count: 0,
      total: null,
      mixedCurrency: false,
    });
  });

  it('refuses mixed-currency bucket totals (R10) per bucket', () => {
    const summary = summarizeCustomerReceivables({
      customerId: CUSTOMER,
      receivables: [specReceivable, usdReceivable],
    });

    // Both rows land in 0-30 with different currencies → count-only (R10).
    expect(summary.agingBuckets['0-30'].count).toBe(2);
    expect(summary.agingBuckets['0-30'].total).toBeNull();
    expect(summary.agingBuckets['0-30'].mixedCurrency).toBe(true);
    // Only specReceivable is overdue (USD row is not), and it totals alone.
    expect(summary.overdue.count).toBe(1);
    expect(summary.overdue.total).toEqual({ minor: 7500000, currency: 'KES' });
    expect(summary.overdue.worstBucket).toBe('0-30');
  });

  it('exposes the contract bucket order', () => {
    expect(BUCKET_ORDER).toEqual(['0-30', '31-60', '61-90', '90+']);
  });
});

// ---------------------------------------------------------------------------
// summarizeCustomerPayments
// ---------------------------------------------------------------------------

describe('summarizeCustomerPayments', () => {
  it('keeps only attributable rows, newest initiated first', () => {
    const summary = summarizeCustomerPayments({
      customerId: CUSTOMER,
      payments: [usdPayment, specPayment, unattributedPayment],
    });

    expect(summary.payments.map((p) => p.id)).toEqual([usdPayment.id, specPayment.id]);
  });

  it('totals confirmed cash and held-on-account unapplied cash', () => {
    const summary = summarizeCustomerPayments({
      customerId: CUSTOMER,
      payments: [specPayment, syntheticPaymentFullyApplied, unattributedPayment],
    });

    expect(summary.confirmed).toEqual({
      count: 2,
      total: { minor: 1500000, currency: 'KES' },
      mixedCurrency: false,
    });
    // syntheticPaymentFullyApplied is fully allocated → only specPayment holds cash.
    expect(summary.heldOnAccount).toEqual({
      count: 1,
      total: { minor: 750000, currency: 'KES' },
      mixedCurrency: false,
    });
  });

  it('flattens the allocation ledger with payment linkage, newest recorded first', () => {
    const newerAllocation: PaymentView = {
      ...syntheticPaymentFullyApplied,
      id: 'bb0b0b0b-0000-4000-8000-000000000009',
      externalRef: 'SBK41XQ7VX',
      idempotencyKey: 'daraja-c2b-SBK41XQ7VX',
      allocations: [
        {
          id: 'cc0c0c0c-0000-4000-8000-000000000009',
          receivableId: specReceivable.id,
          amount: { minor: 100000, currency: 'KES' },
          recordedAt: '2026-09-06T11:00:00.000Z',
        },
      ],
    };
    const summary = summarizeCustomerPayments({
      customerId: CUSTOMER,
      payments: [specPayment, syntheticPaymentFullyApplied, newerAllocation],
    });

    expect(summary.allocations).toHaveLength(2);
    expect(summary.allocations[0]!.key).toBe(
      'bb0b0b0b-0000-4000-8000-000000000009:allocation:cc0c0c0c-0000-4000-8000-000000000009',
    );
    expect(summary.allocations[0]!.externalRef).toBe('SBK41XQ7VX');
    expect(summary.allocations[0]!.receivableId).toBe(specReceivable.id);
    expect(summary.allocations[0]!.amount).toEqual({ minor: 100000, currency: 'KES' });
    expect(summary.allocations[1]!.externalRef).toBe('SBK41XQ7RU');
  });

  it('refuses mixed-currency confirmed totals (R10)', () => {
    const summary = summarizeCustomerPayments({
      customerId: CUSTOMER,
      payments: [specPayment, usdPayment],
    });

    expect(summary.confirmed.count).toBe(2);
    expect(summary.confirmed.total).toBeNull();
    expect(summary.confirmed.mixedCurrency).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// attributeCustomerCases
// ---------------------------------------------------------------------------

describe('attributeCustomerCases', () => {
  it('attributes cases through receivableIds only and excludes foreign cases', () => {
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable, otherCustomerReceivable],
        cases: [specCase, foreignCase],
      },
      NOW,
    );

    expect(summary.cases.map((c) => c.id)).toEqual([specCase.id]);
    expect(summary.openCaseCount).toBe(1);
  });

  it('sorts cases opened newest first', () => {
    const newer: CaseView = {
      ...specCase,
      id: 'dd0d0d0d-0000-4000-8000-000000000006',
      caseNumber: 'CASE-000013',
      sequence: 13,
      openedAt: '2026-09-03T08:00:00.000Z',
    };
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable],
        cases: [specCase, newer],
      },
      NOW,
    );

    expect(summary.cases.map((c) => c.caseNumber)).toEqual(['CASE-000013', 'CASE-000007']);
  });

  it('derives promises from live promised cases with due-now and missed posture', () => {
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable],
        cases: [syntheticPromisedCase, syntheticPromisedCaseMissed, specCase],
      },
      NOW,
    );

    // syntheticPromisedCase's pending action is scheduled 2026-09-04T17:00
    // (today Nairobi) → due-now; the missed one is 2026-09-01 — also
    // on-or-before today, and its older instant sorts FIRST (most urgent).
    expect(summary.promises).toHaveLength(2);
    expect(summary.promises[0]!.caseNumber).toBe('CASE-000009');
    expect(summary.promises[0]!.dueNow).toBe(true);
    expect(summary.promises[0]!.missed).toBe(true);
    expect(summary.promises[0]!.nextActionAt).toBe('2026-09-01T09:00:00.000Z');
    expect(summary.promises[1]!.caseNumber).toBe('CASE-000008');
    expect(summary.promises[1]!.dueNow).toBe(true);
    expect(summary.promises[1]!.missed).toBe(false);
    // specCase is live but waiting — never promised.
  });

  it('ignores completed actions when finding the next follow-up', () => {
    const completedOnly: CaseView = {
      ...specCase,
      id: 'dd0d0d0d-0000-4000-8000-000000000007',
      caseNumber: 'CASE-000014',
      sequence: 14,
      derivedStatus: 'promised',
      actions: [
        {
          id: 'ee0e0e0e0000000000000000000000e1',
          type: 'call',
          scheduledFor: '2026-09-01T09:00:00.000Z',
          outcome: 'promised to pay Friday',
          completedAt: '2026-09-01T09:20:00.000Z',
          completedBy: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          consentRef: null,
          source: 'manual',
          actorId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
          recordedAt: '2026-08-31T09:00:00.000Z',
        },
      ],
    };
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable],
        cases: [completedOnly],
      },
      NOW,
    );

    expect(summary.promises).toHaveLength(1);
    expect(summary.promises[0]!.nextActionAt).toBeNull();
    expect(summary.promises[0]!.dueNow).toBe(false);
    expect(summary.promises[0]!.missed).toBe(false);
  });

  it('keeps resolved cases out of openCaseCount but their actions in the comms timeline', () => {
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable],
        cases: [resolvedCase, specCase],
      },
      NOW,
    );

    expect(summary.openCaseCount).toBe(1);
    expect(summary.comms).toHaveLength(1);
    expect(summary.comms[0]!.caseNumber).toBe('CASE-000012');
    expect(summary.comms[0]!.type).toBe('sms');
    expect(summary.comms[0]!.source).toBe('automated');
    expect(summary.comms[0]!.outcome).toBe('balance reminder delivered');
    expect(summary.comms[0]!.consentRef).toBe('consent-000123');
    expect(summary.comms[0]!.completedAt).toBe('2026-08-10T09:05:00.000Z');
  });

  it('sorts the comms timeline newest-scheduled first with a key tie-break', () => {
    const summary = attributeCustomerCases(
      {
        customerId: CUSTOMER,
        receivables: [specReceivable],
        cases: [syntheticPromisedCase, syntheticPromisedCaseMissed],
      },
      NOW,
    );

    expect(summary.comms.map((entry) => entry.scheduledFor)).toEqual([
      '2026-09-04T17:00:00.000Z', // promised pending follow-up
      '2026-09-04T09:00:00.000Z', // promised completed call
      '2026-09-01T09:00:00.000Z', // missed field visit
    ]);
  });

  it('attributes nothing when the customer has no receivables to link through', () => {
    const summary = attributeCustomerCases(
      {
        customerId: 'unknown-customer',
        receivables: [specReceivable],
        cases: [specCase, resolvedCase],
      },
      NOW,
    );

    expect(summary.cases).toEqual([]);
    expect(summary.openCaseCount).toBe(0);
    expect(summary.promises).toEqual([]);
    expect(summary.comms).toEqual([]);
  });
});
