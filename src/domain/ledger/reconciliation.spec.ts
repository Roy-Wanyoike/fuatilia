import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import { post, reverseEntry } from './journal';
import type { JournalEntry } from './journal';
import { dailyReconciliationJob, runReconciliationJob } from './reconciliation';
import type { OpenReceivableBalance, ReconciliationDrift, ReconciliationOk } from './reconciliation';
import type { MoneyMovementEvent, MoneyMovementEventName } from './events';

const clock: Clock = { now: () => new Date('2025-09-02T06:00:00.000Z') };

const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

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

let seq = 0;
const movement = (overrides: Partial<MoneyMovementEvent> = {}): MoneyMovementEvent => {
  seq += 1;
  return {
    name: 'invoicing.invoiceIssued',
    sourceEventId: uid(`e${seq.toString().padStart(11, '0')}`),
    orgId: 'org-1',
    occurredAt: '2025-09-01T10:00:00.000Z',
    amountMinor: 100_000,
    currency: 'KES',
    reference: `REF-${seq}`,
    actor: 'test-driver',
    ...overrides,
  };
};

const postAll = (...events: MoneyMovementEvent[]): JournalEntry[] => {
  const ledger: JournalEntry[] = [];
  for (const event of events) {
    const result = post(event, ledger, clock);
    if (result.outcome === 'posted') ledger.push(result.entry);
  }
  return ledger;
};

const balance = (receivableId: string, balanceMinor: number, currency: Currency = 'KES'): OpenReceivableBalance => ({
  receivableId: uid(receivableId),
  orgId: 'org-1',
  currency,
  balanceMinor,
});

/**
 * A realistic day for org-1 (KES):
 *   invoice 500_000 (Dr AR) + payment 200_000 (Cr AR) + write-off 50_000 (Cr AR)
 *   ⇒ AR_CONTROL = 250_000, open receivables 200_000 + 50_000.
 */
const dayLedger = (): JournalEntry[] =>
  postAll(
    movement({ amountMinor: 500_000 }),
    movement({ name: 'payments.paymentCompleted' as MoneyMovementEventName, amountMinor: 200_000 }),
    movement({ name: 'receivables.writeOffApproved' as MoneyMovementEventName, amountMinor: 50_000 }),
  );

const openBalances = (): OpenReceivableBalance[] => [balance('100000000001', 200_000), balance('100000000002', 50_000)];

describe('daily sub-ledger ↔ GL reconciliation job (K5, R4)', () => {
  it('returns ok when Σ(open receivable balances) equals the AR_CONTROL balance', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(job, { openReceivableBalances: openBalances(), postedEntries: dayLedger() }, clock);
    expect(result.outcome).toBe('ok');
    const ok = result as ReconciliationOk;
    expect(ok.subLedgerBalanceMinor).toBe(250_000n);
    expect(ok.glBalanceMinor).toBe(250_000n);
    expect(ok.driftMinor).toBe(0n);
    expect(ok.openReceivableCount).toBe(2);
    expect(ok.postedEntryCount).toBe(3);
    expect(ok.event.name).toBe('ledger.reconciliationMatched');
    expect(ok.event.payload).toEqual({
      jobId: job.jobId,
      runDate: '2025-09-01',
      orgId: 'org-1',
      currency: 'KES',
      balanceMinor: 250_000,
      openReceivableCount: 2,
      postedEntryCount: 3,
    });
  });

  it('is ok with an empty book: no entries, no receivables, zero balance', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(job, { openReceivableBalances: [], postedEntries: [] }, clock);
    expect(result.outcome).toBe('ok');
    expect((result as ReconciliationOk).glBalanceMinor).toBe(0n);
  });

  it('returns a typed ReconciliationDrift exception result (never a throw) on drift', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(
      job,
      { openReceivableBalances: [balance('100000000001', 240_000)], postedEntries: dayLedger() },
      clock,
    );
    expect(result.outcome).toBe('drift');
    const drift = result as ReconciliationDrift;
    expect(drift.subLedgerBalanceMinor).toBe(240_000n);
    expect(drift.glBalanceMinor).toBe(250_000n);
    expect(drift.driftMinor).toBe(-10_000n); // signed: sub-ledger is SHORT of the GL
    expect(drift.event.name).toBe('ledger.reconciliationDriftDetected');
    expect(drift.event.payload).toMatchObject({
      jobId: job.jobId,
      runDate: '2025-09-01',
      orgId: 'org-1',
      currency: 'KES',
      subLedgerBalanceMinor: 240_000,
      glBalanceMinor: 250_000,
      driftMinor: -10_000,
    });
  });

  it('detects drift in the other direction too (sub-ledger ahead of GL)', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(
      job,
      // an entry is missing from the GL extract: balances say 250_000, GL shows 200_000
      {
        openReceivableBalances: openBalances(),
        postedEntries: postAll(movement({ amountMinor: 500_000 }), movement({ name: 'payments.paymentCompleted' as MoneyMovementEventName, amountMinor: 300_000 })),
      },
      clock,
    );
    expect(result.outcome).toBe('drift');
    expect((result as ReconciliationDrift).driftMinor).toBe(50_000n);
  });

  it('reversed entries self-cancel: reversing a payment restores the receivable (R3 + K5 together)', () => {
    const invoice = postAll(movement({ amountMinor: 100_000 }))[0]!;
    const payment = postAll(movement({ name: 'payments.paymentCompleted' as MoneyMovementEventName, amountMinor: 100_000 }))[0]!;
    const { original: markedPayment, reversal } = reverseEntry(payment, { reason: 'Daraja reversal', actor: 'daraja' }, clock);
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(
      job,
      {
        openReceivableBalances: [balance('100000000009', 100_000)],
        postedEntries: [invoice, markedPayment, reversal],
      },
      clock,
    );
    expect(result.outcome).toBe('ok'); // reversal math cancels — no special-casing anywhere
    expect((result as ReconciliationOk).glBalanceMinor).toBe(100_000n);
  });

  it('reconciles per currency: other-currency balances and entries are out of scope, not errors', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const result = runReconciliationJob(
      job,
      {
        openReceivableBalances: [...openBalances(), balance('100000000003', 70_000, 'USD')],
        postedEntries: [...dayLedger(), ...postAll(movement({ amountMinor: 90_000, currency: 'USD' }))],
      },
      clock,
    );
    expect(result.outcome).toBe('ok');
    expect((result as ReconciliationOk).subLedgerBalanceMinor).toBe(250_000n);
    expect((result as ReconciliationOk).openReceivableCount).toBe(2);
    expect((result as ReconciliationOk).postedEntryCount).toBe(3);
    // and the USD run agrees on its own slice
    const usd = runReconciliationJob(
      dailyReconciliationJob('org-1', 'USD', '2025-09-01'),
      {
        openReceivableBalances: [balance('100000000003', 90_000, 'USD')],
        postedEntries: postAll(movement({ amountMinor: 90_000, currency: 'USD' })),
      },
      clock,
    );
    expect(usd.outcome).toBe('ok');
  });

  it('rejects cross-tenant inputs loudly (LEDGER_RECON_SCOPE_MISMATCH)', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    expectCode(
      () =>
        runReconciliationJob(
          job,
          { openReceivableBalances: [{ ...balance('100000000001', 100_000), orgId: 'org-2' }], postedEntries: [] },
          clock,
        ),
      'LEDGER_RECON_SCOPE_MISMATCH',
    );
    expectCode(
      () =>
        runReconciliationJob(
          job,
          { openReceivableBalances: [], postedEntries: postAll(movement({ orgId: 'org-2' })) },
          clock,
        ),
      'LEDGER_RECON_SCOPE_MISMATCH',
    );
  });

  it('rejects duplicate receivable rows and negative balances', () => {
    const job = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    expectCode(
      () =>
        runReconciliationJob(
          job,
          { openReceivableBalances: [balance('100000000001', 100_000), balance('100000000001', 100_000)], postedEntries: [] },
          clock,
        ),
      'LEDGER_RECON_DUPLICATE_RECEIVABLE',
    );
    expectCode(
      () =>
        runReconciliationJob(
          job,
          { openReceivableBalances: [balance('100000000001', -1)], postedEntries: [] },
          clock,
        ),
      'LEDGER_RECON_BALANCE_INVALID',
    );
  });

  it('is deterministic: same job spec ⇒ same jobId, same result; the date is part of the key', () => {
    const a = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    const b = dailyReconciliationJob('org-1', 'KES', '2025-09-01');
    expect(a).toEqual(b);
    expect(dailyReconciliationJob('org-1', 'KES', '2025-09-02').jobId).not.toBe(a.jobId);
    expect(dailyReconciliationJob('org-2', 'KES', '2025-09-01').jobId).not.toBe(a.jobId);
    expect(dailyReconciliationJob('org-1', 'USD', '2025-09-01').jobId).not.toBe(a.jobId);

    const inputs = { openReceivableBalances: openBalances(), postedEntries: dayLedger() };
    const run1 = runReconciliationJob(a, inputs, clock);
    const run2 = runReconciliationJob(b, inputs, clock);
    expect(run1).toEqual(run2); // identical objects — event timestamps included (fixed clock)
  });

  it('validates the job spec (date shape, org, ids)', () => {
    expectCode(() => dailyReconciliationJob('org-1', 'KES', '2025-9-1'), 'LEDGER_RECON_DATE_INVALID');
    expectCode(() => dailyReconciliationJob('org-1', 'KES', '2025-13-40'), 'LEDGER_RECON_DATE_INVALID');
    expectCode(() => dailyReconciliationJob('org-1', 'KES', 'not-a-date'), 'LEDGER_RECON_DATE_INVALID');
    expectCode(() => dailyReconciliationJob('  ', 'KES', '2025-09-01'), 'LEDGER_ORG_REQUIRED');
    expectCode(
      () =>
        runReconciliationJob(
          { jobId: 'nope' as Uuid, orgId: 'org-1', currency: 'KES', runDate: '2025-09-01' },
          { openReceivableBalances: [], postedEntries: [] },
          clock,
        ),
      'LEDGER_ID_INVALID',
    );
  });
});
