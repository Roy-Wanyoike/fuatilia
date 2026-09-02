import { describe, expect, it } from 'vitest';
import { DomainError, Money, type Clock, type Uuid, uuid } from '../shared';
import { addInvoiceLine, createInvoice, issueInvoice } from './invoice';
import {
  accrueLateFee,
  validateLateFeePolicy,
  type LateFee,
  type LateFeePolicy,
  type LateFeeReceivableLike,
} from './late-fee';
import { markOverdue, openReceivable, writeOff, type Receivable } from './receivable';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const REC = uid(3);
const INV = uid(1);
const CUST = uid(2);

const DUE = '2025-03-01T00:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const PERCENT_POLICY: LateFeePolicy = { kind: 'percent', percentBps: 333, graceDays: 5 };
const FLAT_POLICY: LateFeePolicy = { kind: 'flat', flatMinor: 500, graceDays: 5 };

/** 15 days past due → beyond the 5-day grace window. */
const NOW = '2025-03-16T00:00:00.000Z';
const clock = at(NOW);

const owing = (overrides: Partial<LateFeeReceivableLike> = {}): LateFeeReceivableLike => ({
  id: REC,
  currency: 'KES',
  dueDate: new Date(DUE),
  overdue: true,
  original: Money.ofMinor(123_457, 'KES'),
  applied: Money.zero('KES'),
  state: 'open',
  ...overrides,
});

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

// --- policy validation ------------------------------------------------------

describe('validateLateFeePolicy', () => {
  const invalid: [string, LateFeePolicy, string][] = [
    ['kind is neither flat nor percent', { kind: 'linear' as unknown as LateFeePolicy['kind'], percentBps: 100, graceDays: 5 }, 'LATE_FEE_POLICY_KIND_INVALID'],
    ['both flat and percent supplied', { kind: 'flat', flatMinor: 500, percentBps: 100, graceDays: 5 }, 'LATE_FEE_POLICY_FLAT_AND_PERCENT'],
    ["kind 'flat' without flatMinor", { kind: 'flat', graceDays: 5 }, 'LATE_FEE_POLICY_FLAT_REQUIRED'],
    ["kind 'percent' without percentBps", { kind: 'percent', graceDays: 5 }, 'LATE_FEE_POLICY_PERCENT_REQUIRED'],
    ['negative flatMinor', { kind: 'flat', flatMinor: -500, graceDays: 5 }, 'LATE_FEE_POLICY_FLAT_INVALID'],
    ['non-integer flatMinor', { kind: 'flat', flatMinor: 10.5, graceDays: 5 }, 'LATE_FEE_POLICY_FLAT_INVALID'],
    ['negative percentBps', { kind: 'percent', percentBps: -333, graceDays: 5 }, 'LATE_FEE_POLICY_BPS_INVALID'],
    ['non-integer percentBps', { kind: 'percent', percentBps: 33.3, graceDays: 5 }, 'LATE_FEE_POLICY_BPS_INVALID'],
    ['negative capMinor', { kind: 'flat', flatMinor: 500, capMinor: -1, graceDays: 5 }, 'LATE_FEE_POLICY_CAP_INVALID'],
    ['non-integer capMinor', { kind: 'percent', percentBps: 333, capMinor: 1.5, graceDays: 5 }, 'LATE_FEE_POLICY_CAP_INVALID'],
    ['negative graceDays', { kind: 'flat', flatMinor: 500, graceDays: -1 }, 'LATE_FEE_POLICY_GRACE_INVALID'],
    ['non-integer graceDays', { kind: 'flat', flatMinor: 500, graceDays: 1.5 }, 'LATE_FEE_POLICY_GRACE_INVALID'],
  ];
  it.each(invalid)('refuses a policy when %s', (_why, policy, code) => {
    expectCode(() => validateLateFeePolicy(policy), code);
  });

  it('accepts the boundaries and resolves to canonical bigint minor units', () => {
    const flat = validateLateFeePolicy({ kind: 'flat', flatMinor: 0, capMinor: 0, graceDays: 0 });
    expect(flat).toEqual({ kind: 'flat', flatMinor: 0n, percentBps: null, capMinor: 0n, graceDays: 0 });
    const percent = validateLateFeePolicy({ kind: 'percent', percentBps: 0, graceDays: 0 });
    expect(percent).toEqual({ kind: 'percent', flatMinor: null, percentBps: 0, capMinor: null, graceDays: 0 });
  });
});

// --- eligibility ------------------------------------------------------------

describe('accrueLateFee — eligibility', () => {
  it('refuses a receivable that is neither flagged overdue nor past due', () => {
    expectCode(
      () => accrueLateFee(owing({ overdue: false }), PERCENT_POLICY, { periodKey: '2025-03', clock: at('2025-02-20T00:00:00.000Z') }),
      'LATE_FEE_NOT_OVERDUE',
    );
  });

  it('accrues on the past-due date alone (flag not yet set — flag OR past-due)', () => {
    const result = accrueLateFee(
      owing({ overdue: false }),
      PERCENT_POLICY,
      { periodKey: '2025-03', clock }, // 15 days past due, flag still false
    );
    expect(result.outcome).toBe('accrued');
    expect(result.fee.amount.amount).toBe(4111n);
  });

  it.each([
    ['exactly at the grace boundary (5 full days)', '2025-03-06T00:00:00.000Z'],
    ['still inside grace one millisecond before day 6', '2025-03-06T23:59:59.999Z'],
  ])('refuses while %s', (_why, now) => {
    expectCode(
      () => accrueLateFee(owing(), PERCENT_POLICY, { periodKey: '2025-03', clock: at(now) }),
      'LATE_FEE_WITHIN_GRACE',
    );
  });

  it('accrues on the first day after the grace window (graceDays + 1)', () => {
    const result = accrueLateFee(owing(), PERCENT_POLICY, {
      periodKey: '2025-03',
      clock: at('2025-03-07T00:00:00.000Z'),
    });
    expect(result.outcome).toBe('accrued');
    expect(result.fee.daysLate).toBe(6);
  });

  it('respects the grace window even when the stored overdue flag is already set', () => {
    expectCode(
      () => accrueLateFee(owing({ overdue: true }), PERCENT_POLICY, { periodKey: '2025-03', clock: at('2025-03-03T00:00:00.000Z') }),
      'LATE_FEE_WITHIN_GRACE',
    );
  });

  it.each([
    ['settled', 'settled'],
    ['written off', 'written_off'],
    ['voided', 'voided'],
  ])('refuses a %s debt (not a live receivable)', (_why, state) => {
    expectCode(
      () => accrueLateFee(owing({ state }), PERCENT_POLICY, { periodKey: '2025-03', clock }),
      'LATE_FEE_RECEIVABLE_NOT_LIVE',
    );
  });

  it('refuses a fully applied (zero-balance) receivable', () => {
    expectCode(
      () => accrueLateFee(owing({ applied: Money.ofMinor(123_457, 'KES') }), PERCENT_POLICY, { periodKey: '2025-03', clock }),
      'LATE_FEE_ZERO_BALANCE',
    );
  });

  it('requires a non-blank periodKey', () => {
    expectCode(() => accrueLateFee(owing(), PERCENT_POLICY, { periodKey: '   ', clock }), 'LATE_FEE_PERIOD_KEY_REQUIRED');
  });
});

// --- amount computation -----------------------------------------------------

describe('accrueLateFee — amount computation', () => {
  it('charges the flat amount verbatim', () => {
    const result = accrueLateFee(owing(), FLAT_POLICY, { periodKey: '2025-03', clock });
    expect(result.fee.amount.amount).toBe(500n);
    expect(result.fee.amount.currency).toBe('KES');
  });

  it.each([
    [123_457, 4111], // 123457 × 333 / 10000 = 4111.1181 → 4111 (round DOWN)
    [9_999, 332], //    9999 × 333 / 10000 = 332.9667 → 332
    [10_001, 333], //   10001 × 333 / 10000 = 333.0333 → 333
    [1, 0], //          rounds down to nothing — a legal zero fee
  ])('percent bps=333 on balance %d minor rounds DOWN to %d', (balanceMinor, expected) => {
    const result = accrueLateFee(owing({ original: Money.ofMinor(balanceMinor, 'KES') }), PERCENT_POLICY, {
      periodKey: '2025-03',
      clock,
    });
    expect(result.fee.amount.amount).toBe(BigInt(expected));
    expect(result.outcome).toBe('accrued');
  });

  it.each([
    ['caps a percent fee at capMinor', PERCENT_POLICY, 1_000, 1_000], // uncapped would be 4111
    ['caps a flat fee at capMinor', FLAT_POLICY, 100, 100],
    ['keeps a fee below the cap unchanged', FLAT_POLICY, 1_000, 500],
    ['reduces a fee to zero when the cap is 0', FLAT_POLICY, 0, 0],
  ] as const)('%s', (_why, policy, capMinor, expected) => {
    const result = accrueLateFee(owing(), { ...policy, capMinor }, { periodKey: '2025-03', clock });
    expect(result.fee.amount.amount).toBe(BigInt(expected));
  });
});

// --- idempotency (H4 core) --------------------------------------------------

describe('accrueLateFee — idempotency per (receivableId, periodKey)', () => {
  it('never double-charges: re-running the same period returns already_accrued with no events', () => {
    const first = accrueLateFee(owing(), PERCENT_POLICY, { periodKey: '2025-03', clock });
    expect(first.outcome).toBe('accrued');
    expect(first.events).toHaveLength(1);

    const second = accrueLateFee(owing(), PERCENT_POLICY, {
      periodKey: '2025-03',
      clock,
      previouslyAccruedPeriodKeys: ['2025-03'],
    });
    expect(second.outcome).toBe('already_accrued');
    expect(second.events).toHaveLength(0);
    expect(second.fee.amount.amount).toBe(first.fee.amount.amount);
  });

  it('returns the SAME fee object verbatim when the posted row is supplied — even if the balance changed', () => {
    const first = accrueLateFee(owing(), PERCENT_POLICY, { periodKey: '2025-03', clock });
    // A payment lands between the two accrual runs:
    const paidDown = owing({ applied: Money.ofMinor(100_000, 'KES') });
    const second = accrueLateFee(paidDown, PERCENT_POLICY, {
      periodKey: '2025-03',
      clock,
      previouslyAccruedFees: [first.fee],
    });
    expect(second.outcome).toBe('already_accrued');
    expect(second.fee).toBe(first.fee); // historically exact, not recomputed
    expect(second.events).toHaveLength(0);
  });

  it('stays safe on a keys-only re-run after the receivable settled (marker, no throw, no charge)', () => {
    const settled = owing({ applied: Money.ofMinor(123_457, 'KES'), state: 'settled', overdue: false });
    const marker = accrueLateFee(settled, PERCENT_POLICY, {
      periodKey: '2025-03',
      clock,
      previouslyAccruedPeriodKeys: ['2025-03'],
    });
    expect(marker.outcome).toBe('already_accrued');
    expect(marker.fee.amount.isZero()).toBe(true);
    expect(marker.events).toHaveLength(0);
  });

  it('accrues again for a DIFFERENT periodKey (period-scoped, not one-fee-forever)', () => {
    const march = accrueLateFee(owing(), PERCENT_POLICY, {
      periodKey: '2025-03',
      clock,
      previouslyAccruedPeriodKeys: ['2025-02'],
    });
    expect(march.outcome).toBe('accrued');
    expect(march.events).toHaveLength(1);
  });
});

// --- event + posting hook ---------------------------------------------------

describe('accrueLateFee — event and posting-matrix hook', () => {
  it('emits receivable.lateFeeAccrued in the wave-1 envelope', () => {
    const { fee, events } = accrueLateFee(owing(), PERCENT_POLICY, { periodKey: '2025-03', clock });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('receivable.lateFeeAccrued');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(REC);
    expect(event.occurredAt).toBe(NOW);
    expect(event.payload).toEqual({
      receivableId: REC,
      periodKey: '2025-03',
      amountMinor: 4111,
      currency: 'KES',
      policyKind: 'percent',
      percentBps: 333,
      flatMinor: null,
      balanceMinor: 123_457,
      daysLate: 15,
      graceDays: 5,
      posting: { debit: 'ar_control', credit: 'fee_income' },
    });
    expect(fee.posting).toEqual({ debit: 'ar_control', credit: 'fee_income' });
    expect(fee.accruedAt).toEqual(new Date(NOW));
  });

  it('accepts the real Receivable aggregate and charges its live balance', () => {
    const due = new Date('2025-01-10T00:00:00.000Z');
    let invoice = createInvoice({ id: INV, customerId: CUST, currency: 'KES', dueDate: due });
    invoice = addInvoiceLine(invoice, { description: 'Consulting — January', amount: Money.ofMinor(10_000, 'KES') });
    const issued = issueInvoice(invoice, { sequenceNo: 1, reserveNumber: (seq) => `INV-${seq}` }, at('2025-01-05T00:00:00.000Z')).invoice;
    const opened: Receivable = openReceivable(issued, REC, at('2025-01-05T00:00:00.000Z')).receivable;
    const flagged: Receivable = markOverdue(opened, at('2025-01-25T00:00:00.000Z')).receivable;

    const accrued = accrueLateFee(
      flagged,
      { kind: 'percent', percentBps: 150, graceDays: 0 },
      { periodKey: '2025-01', clock: at('2025-01-25T00:00:00.000Z') },
    );
    expect(accrued.outcome).toBe('accrued');
    expect(accrued.fee.amount.amount).toBe(150n); // 10000 × 150 / 10000
    expect(accrued.fee.daysLate).toBe(15);

    // A written-off debt is conceded — never feeable, even while flagged overdue:
    const dead = writeOff(flagged, { reason: 'debtor insolvent', approvedBy: 'fin-ops-01' }, at('2025-01-26T00:00:00.000Z')).receivable;
    expectCode(
      () => accrueLateFee(dead, { kind: 'percent', percentBps: 150, graceDays: 0 }, { periodKey: '2025-02', clock: at('2025-01-27T00:00:00.000Z') }),
      'LATE_FEE_RECEIVABLE_NOT_LIVE',
    );
  });

  it('exposes the fee row as an append-only record carrying the idempotency scope', () => {
    const { fee }: { fee: LateFee } = accrueLateFee(owing(), FLAT_POLICY, { periodKey: '2025-03', clock });
    expect(fee.receivableId).toBe(REC);
    expect(fee.periodKey).toBe('2025-03');
    expect(fee.policyKind).toBe('flat');
    expect(fee.flatMinor).toBe(500n);
    expect(fee.percentBps).toBeNull();
    expect(fee.balanceMinor).toBe(123_457n);
  });
});
