import { describe, expect, it } from 'vitest';
import { DomainError, Money, type Clock, type Uuid, uuid } from '../shared';
import {
  addInvoiceLine,
  createInvoice,
  issueInvoice,
  markInvoiceSent,
  voidInvoice,
  type Invoice,
} from './invoice';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const INV = uid(1);
const CUST = uid(2);

const ISSUED_AT = '2025-01-15T09:00:00.000Z';
const DUE = '2025-03-01T00:00:00.000Z';
const NOW = '2025-02-10T09:00:00.000Z';
const clock: Clock = { now: () => new Date(NOW) };
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const reserveNumber = (seq: number): string => `INV-2025-${String(seq).padStart(5, '0')}`;

const LINE_A = Money.ofMinor(7_500, 'KES');
const LINE_B = Money.ofMinor(2_500, 'KES');

const draftInvoice = (): Invoice => {
  let inv = createInvoice({ id: INV, customerId: CUST, currency: 'KES', dueDate: new Date(DUE) });
  inv = addInvoiceLine(inv, { description: 'Consulting — January', amount: LINE_A });
  inv = addInvoiceLine(inv, { description: 'Consulting — February', amount: LINE_B });
  return inv;
};
const issuedInvoice = (): Invoice =>
  issueInvoice(draftInvoice(), { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
const sentInvoice = (): Invoice => markInvoiceSent(issuedInvoice(), 'email', clock).invoice;
const voidedInvoice = (): Invoice =>
  voidInvoice(issuedInvoice(), { reason: 'raised twice by mistake', actorId: 'ops-01' }, clock)
    .invoice;

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

describe('Invoice aggregate (issue #1)', () => {
  it('starts as an unnumbered, unlinked draft with a zero total', () => {
    const inv = createInvoice({ id: INV, customerId: CUST, currency: 'KES', dueDate: new Date(DUE) });
    expect(inv.status).toBe('draft');
    expect(inv.invoiceNumber).toBeNull();
    expect(inv.receivableId).toBeNull();
    expect(inv.total.isZero()).toBe(true);
  });

  it('accumulates lines and recomputes the total while draft', () => {
    const inv = draftInvoice();
    expect(inv.lines).toHaveLength(2);
    expect(inv.total.amount).toBe(10_000n);
  });

  it.each([
    ['issued', () => issuedInvoice()],
    ['sent', () => sentInvoice()],
    ['voided', () => voidedInvoice()],
  ])('freezes totals once the invoice is %s', (_status, build) => {
    expectCode(
      () => addInvoiceLine(build(), { description: 'late line', amount: LINE_A }),
      'INVOICE_LINES_FROZEN',
    );
  });

  it('rejects blank descriptions, non-positive amounts and cross-currency lines', () => {
    const inv = draftInvoice();
    expectCode(
      () => addInvoiceLine(inv, { description: '   ', amount: LINE_A }),
      'INVOICE_LINE_INVALID',
    );
    expectCode(
      () => addInvoiceLine(inv, { description: 'zero line', amount: Money.zero('KES') }),
      'INVOICE_LINE_INVALID',
    );
    expectCode(
      () => addInvoiceLine(inv, { description: 'usd line', amount: Money.ofMinor(100, 'USD') }),
      'CURRENCY_MISMATCH',
    );
  });

  it('issues from draft: reserves the eTIMS-ready number and freezes totals', () => {
    const { invoice, event } = issueInvoice(draftInvoice(), { sequenceNo: 42, reserveNumber }, clock);
    expect(invoice.status).toBe('issued');
    expect(invoice.invoiceNumber).toBe('INV-2025-00042');
    expect(invoice.issuedAt).toEqual(new Date(NOW));
    // totals frozen — same total as the draft, and lines can no longer change
    expect(invoice.total.amount).toBe(10_000n);
    expectCode(
      () => addInvoiceLine(invoice, { description: 'x', amount: LINE_A }),
      'INVOICE_LINES_FROZEN',
    );
    // E02 invoicing.invoiceIssued
    expect(event.name).toBe('invoicing.invoiceIssued');
    expect(Object.keys(event.payload).sort()).toEqual([
      'currency',
      'customerId',
      'dueDate',
      'invoiceId',
      'totalMinor',
    ]);
    expect(event.payload).toMatchObject({
      invoiceId: INV,
      customerId: CUST,
      totalMinor: 10_000,
      currency: 'KES',
      dueDate: DUE,
    });
  });

  it.each([
    ['issued → issued', () => issuedInvoice(), 'INVOICE_ALREADY_ISSUED'],
    ['sent → issued', () => sentInvoice(), 'INVALID_INVOICE_TRANSITION'],
    ['voided → issued', () => voidedInvoice(), 'INVALID_INVOICE_TRANSITION'],
  ])('refuses to issue from %s', (_edge, build, code) => {
    expectCode(() => issueInvoice(build(), { sequenceNo: 2, reserveNumber }, clock), code);
  });

  it('validates the sequence number and the reserved number', () => {
    const inv = draftInvoice();
    expectCode(() => issueInvoice(inv, { sequenceNo: 0, reserveNumber }, clock), 'INVOICE_SEQUENCE_INVALID');
    expectCode(() => issueInvoice(inv, { sequenceNo: -3, reserveNumber }, clock), 'INVOICE_SEQUENCE_INVALID');
    expectCode(() => issueInvoice(inv, { sequenceNo: 2.5, reserveNumber }, clock), 'INVOICE_SEQUENCE_INVALID');
    expectCode(() => issueInvoice(inv, { sequenceNo: 1, reserveNumber: () => '   ' }, clock), 'INVOICE_NUMBER_INVALID');
    expectCode(() => issueInvoice(inv, { sequenceNo: 1, reserveNumber: () => '' }, clock), 'INVOICE_NUMBER_INVALID');
  });

  it('records delivery on Issued → Sent (E03 invoicing.invoiceSent)', () => {
    const { invoice, event } = markInvoiceSent(issuedInvoice(), ' whatsapp ', clock);
    expect(invoice.status).toBe('sent');
    expect(invoice.sentChannel).toBe('whatsapp');
    expect(invoice.sentAt).toEqual(new Date(NOW));
    expect(event.name).toBe('invoicing.invoiceSent');
    expect(Object.keys(event.payload).sort()).toEqual(['channel', 'invoiceId', 'sentAt']);
    expect(event.payload).toMatchObject({ invoiceId: INV, channel: 'whatsapp', sentAt: NOW });
  });

  it.each([
    ['draft → sent', () => draftInvoice()],
    ['sent → sent', () => sentInvoice()],
    ['voided → sent', () => voidedInvoice()],
  ])('refuses to mark sent from %s', (_edge, build) => {
    expectCode(() => markInvoiceSent(build(), 'email', clock), 'INVOICE_NOT_ISSUED');
  });

  it('rejects a blank delivery channel', () => {
    expectCode(() => markInvoiceSent(issuedInvoice(), '   ', clock), 'INVOICE_CHANNEL_INVALID');
  });

  it('voids an issued invoice as a recorded decision (E04 invoicing.invoiceVoided)', () => {
    const { invoice, event } = voidInvoice(
      issuedInvoice(),
      { reason: ' wrong customer ', actorId: ' ops-01 ' },
      clock,
    );
    expect(invoice.status).toBe('voided');
    expect(invoice.voidReason).toBe('wrong customer');
    expect(invoice.voidedBy).toBe('ops-01');
    expect(invoice.voidedAt).toEqual(new Date(NOW));
    expect(event.name).toBe('invoicing.invoiceVoided');
    expect(Object.keys(event.payload).sort()).toEqual(['actorId', 'invoiceId', 'reason']);
    expect(event.payload).toMatchObject({ invoiceId: INV, reason: 'wrong customer', actorId: 'ops-01' });
  });

  it('also voids a sent invoice (mistake path)', () => {
    const { invoice } = voidInvoice(
      sentInvoice(),
      { reason: 'delivered to wrong msisdn', actorId: 'ops-02' },
      clock,
    );
    expect(invoice.status).toBe('voided');
  });

  it.each([
    ['draft → voided', () => draftInvoice()],
    ['voided → voided', () => voidedInvoice()],
  ])('refuses to void from %s', (_edge, build) => {
    expectCode(
      () => voidInvoice(build(), { reason: 'nope', actorId: 'ops-01' }, clock),
      'INVALID_INVOICE_TRANSITION',
    );
  });

  it('requires a reason and an actor to void (audit, E04 payload)', () => {
    const inv = issuedInvoice();
    expectCode(() => voidInvoice(inv, { reason: '   ', actorId: 'ops-01' }, clock), 'INVOICE_VOID_REASON_REQUIRED');
    expectCode(() => voidInvoice(inv, { reason: 'duplicate', actorId: '  ' }, clock), 'INVOICE_VOID_ACTOR_REQUIRED');
  });
});
