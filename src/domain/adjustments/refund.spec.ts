import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  allocateRefundFunds,
  approveRefund,
  completeRefund,
  failRefund,
  rejectRefund,
  requestRefund,
  startRefundProcessing,
} from './refund';
import type { Refund, RefundState } from './refund';

const clock: Clock = { now: () => new Date('2025-06-01T09:30:00.000Z') };

/** Deterministic 36-char hex ids for table-driven tests. */
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const paymentId = uid('a0000000001');
/** Caller-computed R6 ceiling: confirmed − allocated − refunded-so-far. */
const ceiling = Money.ofMinor(100_000, 'KES');

const request = (amountMinor = 40_000): Refund =>
  requestRefund(
    {
      id: uid('b0000000001'),
      paymentId,
      amount: Money.ofMinor(amountMinor, 'KES'),
      reason: 'duplicate payment',
      requestedBy: 'ops-1',
    },
    ceiling,
    clock,
  ).refund;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

/** Build a refund in any machine state via the legal path only. */
const refundIn = (state: RefundState): Refund => {
  const requested = request();
  switch (state) {
    case 'requested':
      return requested;
    case 'approved':
      return approveRefund(requested);
    case 'rejected':
      return rejectRefund(requested, 'policy: outside refund window');
    case 'processing':
      return startRefundProcessing(approveRefund(requested), 'B2C-1');
    case 'completed':
      return completeRefund(startRefundProcessing(approveRefund(requested), 'B2C-1'), clock).refund;
    case 'failed':
      return failRefund(startRefundProcessing(approveRefund(requested), 'B2C-1'), 'B2C timeout');
  }
};

describe('Refund (C2, R6)', () => {
  it('requests a refund referencing the source payment and emits adjustment.refundRequested', () => {
    const { refund, event } = requestRefund(
      {
        id: uid('b0000000001'),
        paymentId,
        amount: Money.ofMinor(40_000, 'KES'),
        reason: 'duplicate payment',
        requestedBy: 'ops-1',
      },
      ceiling,
      clock,
    );
    expect(refund.state).toBe('requested');
    expect(refund.total.amount).toBe(40_000n);
    expect(refund.paymentId).toBe(paymentId); // C2: outflow traceable to source payment
    expect(event.name).toBe('adjustment.refundRequested');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(refund.id);
    expect(event.payload).toEqual({
      refundId: refund.id,
      paymentId,
      totalMinor: 40_000n,
      reason: 'duplicate payment',
    });
    expect(event.occurredAt).toBe('2025-06-01T09:30:00.000Z'); // from the injected Clock
  });

  it('accepts a refund exactly at the ceiling (boundary is inclusive)', () => {
    const refund = request(100_000);
    expect(refund.total.amount).toBe(100_000n);
    expect(refund.state).toBe('requested');
  });

  it.each([
    ['over the R6 ceiling', Money.ofMinor(100_001, 'KES'), 'reason', 'ops-1', 'REFUND_EXCEEDS_CEILING'],
    ['zero amount', Money.ofMinor(0, 'KES'), 'reason', 'ops-1', 'REFUND_AMOUNT_INVALID'],
    ['empty reason', Money.ofMinor(1_000, 'KES'), '   ', 'ops-1', 'REFUND_REASON_REQUIRED'],
    ['empty requester', Money.ofMinor(1_000, 'KES'), 'reason', '', 'REFUND_REQUESTER_REQUIRED'],
    ['cross-currency amount', Money.ofMinor(1_000, 'USD'), 'reason', 'ops-1', 'CURRENCY_MISMATCH'],
  ])('rejects %s with %s', (_label, amount, reason, requestedBy, code) => {
    expectCode(
      () =>
        requestRefund(
          { id: uid('b0000000001'), paymentId, amount, reason, requestedBy },
          ceiling,
          clock,
        ),
      code,
    );
  });

  it('walks the legal path requested → approved → processing → completed and emits refundCompleted', () => {
    const approved = approveRefund(request());
    expect(approved.state).toBe('approved');

    const processing = startRefundProcessing(approved, 'B2C-77');
    expect(processing.state).toBe('processing');
    expect(processing.externalRef).toBe('B2C-77'); // Daraja B2C ref recorded

    const { refund, event } = completeRefund(processing, clock);
    expect(refund.state).toBe('completed');
    expect(event.name).toBe('adjustment.refundCompleted');
    expect(event.aggregateId).toBe(refund.id);
    expect(event.payload).toEqual({ refundId: refund.id, completedAt: '2025-06-01T09:30:00.000Z' });
  });

  it('rejects from requested with a policy reason', () => {
    const rejected = rejectRefund(request(), 'policy: outside refund window');
    expect(rejected.state).toBe('rejected');
    expect(rejected.rejectedReason).toBe('policy: outside refund window');
  });

  it('retries failed → processing with a NEW external ref', () => {
    const failed = refundIn('failed');
    expect(failed.state).toBe('failed');
    const retried = startRefundProcessing(failed, 'B2C-2');
    expect(retried.state).toBe('processing');
    expect(retried.externalRef).toBe('B2C-2'); // new ref replaces the failed one
  });

  it('refuses a retry that reuses the previous external ref', () => {
    expectCode(() => startRefundProcessing(refundIn('failed'), 'B2C-1'), 'REFUND_EXTERNAL_REF_REUSED');
  });

  it('refuses an empty B2C ref', () => {
    expectCode(() => startRefundProcessing(refundIn('approved'), ' '), 'REFUND_EXTERNAL_REF_REQUIRED');
  });

  it.each([
    ['approveRefund', (r: Refund) => approveRefund(r), ['approved', 'rejected', 'processing', 'completed', 'failed']],
    ['rejectRefund', (r: Refund) => rejectRefund(r), ['approved', 'rejected', 'processing', 'completed', 'failed']],
    [
      'startRefundProcessing',
      (r: Refund) => startRefundProcessing(r, 'B2C-9'),
      ['requested', 'rejected', 'processing', 'completed'],
    ],
    [
      'completeRefund',
      (r: Refund) => completeRefund(r, clock).refund,
      ['requested', 'approved', 'rejected', 'completed', 'failed'],
    ],
    ['failRefund', (r: Refund) => failRefund(r), ['requested', 'approved', 'rejected', 'completed', 'failed']],
  ] as const)('%s throws REFUND_INVALID_TRANSITION from every non-entry state', (_name, act, fromStates) => {
    for (const state of fromStates) {
      expectCode(() => act(refundIn(state)), 'REFUND_INVALID_TRANSITION');
    }
  });

  it('never mutates the refund in place (append-only spirit, R3)', () => {
    const requested = request();
    const approved = approveRefund(requested);
    expect(requested.state).toBe('requested');
    expect(approved.id).toBe(requested.id);
    expect(approved).not.toBe(requested);
  });
});

describe('RefundAllocation rows (C2)', () => {
  const refund = request(); // 40_000 KES

  it('maps rows onto the refund when they sum EXACTLY to the total', () => {
    const rows = allocateRefundFunds(
      refund,
      [
        { id: uid('c0000000001'), source: 'confirmed_funds', amount: Money.ofMinor(25_000, 'KES') },
        { id: uid('c0000000002'), source: 'credit_balance', amount: Money.ofMinor(15_000, 'KES') },
      ],
      true, // explicit consent for the credit_balance source
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.refundId === refund.id)).toBe(true);
    const sum = rows.reduce((acc, row) => acc.add(row.amount), Money.zero('KES'));
    expect(sum.equals(refund.total)).toBe(true);
  });

  it('accepts confirmed_funds-only splits without consent', () => {
    const rows = allocateRefundFunds(refund, [
      { id: uid('c0000000001'), source: 'confirmed_funds', amount: Money.ofMinor(40_000, 'KES') },
    ]);
    expect(rows[0]!.source).toBe('confirmed_funds');
  });

  it.each([
    [
      'rows that sum to less than the total',
      [
        { id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(25_000, 'KES') },
        { id: uid('c0000000002'), source: 'confirmed_funds' as const, amount: Money.ofMinor(14_999, 'KES') },
      ],
      undefined,
      'REFUND_ALLOCATION_SUM_MISMATCH',
    ],
    [
      'rows that sum to more than the total',
      [
        { id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(25_000, 'KES') },
        { id: uid('c0000000002'), source: 'confirmed_funds' as const, amount: Money.ofMinor(15_001, 'KES') },
      ],
      undefined,
      'REFUND_ALLOCATION_SUM_MISMATCH',
    ],
    [
      'a zero-amount row',
      [{ id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(0, 'KES') }],
      undefined,
      'REFUND_ALLOCATION_AMOUNT_INVALID',
    ],
    [
      'a duplicate row id',
      [
        { id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(20_000, 'KES') },
        { id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(20_000, 'KES') },
      ],
      undefined,
      'REFUND_ALLOCATION_ID_DUPLICATE',
    ],
    [
      'credit_balance source without explicit consent',
      [{ id: uid('c0000000001'), source: 'credit_balance' as const, amount: Money.ofMinor(40_000, 'KES') }],
      undefined,
      'CONSENT_REQUIRED',
    ],
    [
      'credit_balance source with consent=false',
      [{ id: uid('c0000000001'), source: 'credit_balance' as const, amount: Money.ofMinor(40_000, 'KES') }],
      false,
      'CONSENT_REQUIRED',
    ],
    [
      'a cross-currency row',
      [{ id: uid('c0000000001'), source: 'confirmed_funds' as const, amount: Money.ofMinor(40_000, 'USD') }],
      undefined,
      'CURRENCY_MISMATCH',
    ],
  ])('refuses %s with %s', (_label, rows, consent, code) => {
    expectCode(() => allocateRefundFunds(refund, rows, consent), code);
  });

  it('refuses empty allocation rows', () => {
    expectCode(() => allocateRefundFunds(refund, []), 'REFUND_ALLOCATION_EMPTY');
  });
});
