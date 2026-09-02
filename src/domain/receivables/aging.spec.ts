import { describe, expect, it } from 'vitest';
import { DomainError, Money, type Clock, type Uuid, uuid } from '../shared';
import { agingBucket, daysPastDue } from './aging';
import { applyAllocation, openReceivable, markOverdue, writeOff } from './receivable';
import { addInvoiceLine, createInvoice, issueInvoice, type Invoice } from './invoice';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const INV = uid(1);
const CUST = uid(2);
const REC = uid(3);

const ISSUED_AT = '2025-01-15T09:00:00.000Z';
const DUE = '2025-03-01T00:00:00.000Z'; // aging day 0
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const day = (n: number, time = '00:00:00.000'): string => {
  const d = new Date(new Date(DUE).getTime() + n * 86_400_000);
  return d.toISOString().replace(/T\d{2}:\d{2}:\d{2}\.\d{3}/, `T${time}`);
};

const invoice = (): Invoice => {
  let inv = createInvoice({ id: INV, customerId: CUST, currency: 'KES', dueDate: new Date(DUE) });
  inv = addInvoiceLine(inv, { description: 'Consulting — January', amount: Money.ofMinor(10_000, 'KES') });
  return issueInvoice(inv, { sequenceNo: 1, reserveNumber: (s) => `INV-${s}` }, at(ISSUED_AT)).invoice;
};

const openRec = () => openReceivable(invoice(), REC, at(ISSUED_AT)).receivable;
const settledRec = () => applyAllocation(openRec(), Money.ofMinor(10_000, 'KES'), at(ISSUED_AT)).receivable;
const writtenOffAt = (iso: string) =>
  writeOff(
    markOverdue(openRec(), at(iso)).receivable,
    { reason: 'insolvent', approvedBy: 'fin-ops-01' },
    at(iso),
  ).receivable;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- tests ------------------------------------------------------------------

describe('aging buckets (0-30 / 31-60 / 61-90 / 90+ days past dueDate)', () => {
  it.each([
    [-28, '0-30'], // before the due date — current, never negative
    [0, '0-30'], // due date today
    [1, '0-30'],
    [30, '0-30'],
    [31, '31-60'],
    [60, '31-60'],
    [61, '61-90'],
    [90, '61-90'],
    [91, '90+'],
    [365, '90+'],
  ])('day %+d past due → %s', (days, expected) => {
    expect(agingBucket(openRec(), at(day(days)))).toBe(expected);
  });

  it('floors partial days: half a day late is still day 0', () => {
    expect(daysPastDue(openRec(), at(day(0, '12:00:00.000')))).toBe(0);
    expect(agingBucket(openRec(), at(day(0, '12:00:00.000')))).toBe('0-30');
    expect(daysPastDue(openRec(), at(day(30, '23:59:59.999')))).toBe(30);
    expect(agingBucket(openRec(), at(day(30, '23:59:59.999')))).toBe('0-30');
  });

  it('refuses to age a settled receivable — nothing left to collect', () => {
    expectCode(() => agingBucket(settledRec(), at(day(45))), 'AGING_NOT_APPLICABLE');
  });

  it('still ages decided receivables — reporting needs their history', () => {
    expect(agingBucket(writtenOffAt(day(95)), at(day(95)))).toBe('90+');
  });
});
