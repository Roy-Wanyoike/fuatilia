/**
 * Accounting mapper tests (issue #87): QuickBooks + Zoho Books fixtures map
 * into the REAL intake functions; extra fields tolerated; missing required
 * fields refused; payments only intaked with a Daraja-shaped M-Pesa
 * reference. No network, no fund-truth bypass.
 */
import { describe, expect, it } from 'vitest';
import { mapAccountingPayment, mapQuickBooksInvoice, mapZohoInvoice } from './accounting';
import { intakePayment } from '../../domain/payments/intake';
import { Money } from '../../domain/shared/money';

const CUSTOMER = '00000000-0000-4000-8000-000000000002';
const t0 = new Date('2026-09-08T09:00:00Z');
const clock = { now: () => t0 };

const qbInvoice = {
  // extra fields tolerated:
  realmId: '123146096291789',
  syncToken: '0',
  MetaData: { CreateTime: '2026-09-01T10:00:00Z' },
  DocNumber: 'QB-1042',
  CustomerRef: { value: CUSTOMER, name: 'Mama Njeri Traders' },
  CurrencyRef: { value: 'KES' },
  DueDate: '2026-10-01',
  Line: [
    { DetailType: 'SalesItemLine', Description: 'Consulting September', Amount: 2500.0 },
    { DetailType: 'SubTotalLine', Amount: 2500.0 }, // tolerated non-item line
  ],
};

const zohoInvoice = {
  // extra fields tolerated:
  created_time: '2026-09-01T10:00:00Z',
  status: 'sent',
  invoice_number: 'ZB-2077',
  customer_id: CUSTOMER,
  currency_code: 'KES',
  due_date: '2026-10-01',
  line_items: [{ name: 'Consulting', description: 'Consulting September', rate: 1500.0, quantity: 2 }],
};

describe('mapQuickBooksInvoice', () => {
  it('maps through the REAL intake functions: issued invoice + open receivable', () => {
    const { prepared, refusal } = mapQuickBooksInvoice(qbInvoice, 'seed-1', clock);
    expect(refusal).toBeNull();
    expect(prepared).not.toBeNull();
    if (prepared) {
      expect(prepared.invoice.invoiceNumber).toBe('QB-1042');
      expect(prepared.invoice.status).toBe('issued');
      expect(prepared.invoice.total.amount).toBe(2_500_00n);
      expect(prepared.receivable.state).toBe('open');
      expect(prepared.receivable.original.amount).toBe(2_500_00n);
      expect(prepared.events).toHaveLength(2);
      expect(prepared.source).toBe('quickbooks');
    }
  });

  it.each([
    ['missing customer', { ...qbInvoice, CustomerRef: undefined }, 'INTAKE_QB_CUSTOMER_REQUIRED'],
    ['non-KES refused honestly', { ...qbInvoice, CurrencyRef: { value: 'USD' } }, 'INTAKE_QB_CURRENCY_REFUSED'],
    ['bad due date', { ...qbInvoice, DueDate: 'not-a-date' }, 'INTAKE_QB_DATE_INVALID'],
    ['no item lines', { ...qbInvoice, Line: [{ DetailType: 'SubTotalLine', Amount: 1 }] }, 'INTAKE_QB_LINES_REQUIRED'],
    ['non-2dp amount', { ...qbInvoice, Line: [{ DetailType: 'SalesItemLine', Description: 'x', Amount: 1.234 }] }, 'INTAKE_QB_AMOUNT_INVALID'],
  ])('%s → typed refusal', (_name, payload, code) => {
    const { prepared, refusal } = mapQuickBooksInvoice(payload, 'seed-1', clock);
    expect(prepared).toBeNull();
    expect(refusal?.code).toBe(code);
  });
});

describe('mapZohoInvoice', () => {
  it('maps rate × quantity exactly in minor units', () => {
    const { prepared, refusal } = mapZohoInvoice(zohoInvoice, 'seed-2', clock);
    expect(refusal).toBeNull();
    expect(prepared?.invoice.total.amount).toBe(3_000_00n); // 1500.00 × 2
    expect(prepared?.receivable.state).toBe('open');
  });

  it.each([
    ['missing customer', { ...zohoInvoice, customer_id: undefined }, 'INTAKE_ZB_CUSTOMER_REQUIRED'],
    ['non-KES refused honestly', { ...zohoInvoice, currency_code: 'EUR' }, 'INTAKE_ZB_CURRENCY_REFUSED'],
    ['bad rate', { ...zohoInvoice, line_items: [{ name: 'x', rate: 'free' }] }, 'INTAKE_ZB_AMOUNT_INVALID'],
  ])('%s → typed refusal', (_name, payload, code) => {
    const { prepared, refusal } = mapZohoInvoice(payload, 'seed-2', clock);
    expect(prepared).toBeNull();
    expect(refusal?.code).toBe(code);
  });
});

describe('mapAccountingPayment — the honest channel rule', () => {
  const darajaShaped = {
    payment_number: 'PAY-1',
    amount: 2500.0,
    customer_id: CUSTOMER,
    invoice_number: 'QB-1042',
    mpesaTransactionId: 'SBK81KZ9QF',
  };

  it('intakes through the REAL payments funnel when a Daraja-shaped ref is present', () => {
    const result = mapAccountingPayment(darajaShaped, 'quickbooks', { clock });
    expect(result.kind).toBe('intaked');
    if (result.kind === 'intaked') {
      expect(result.duplicate).toBe(false);
      expect(result.events?.some((e) => e.name === 'payment.initiated')).toBe(true);
    }
  });

  it('a LIVE callback for the same transaction dedupes under R9', () => {
    // The live M-Pesa callback flows through the same intake core with the
    // SAME idempotency key convention → the SAME payment. The dedupe
    // universe is process-local (the intake core's own contract): the
    // caller passes what it already knows.
    const known = intakePayment(
      {
        channel: 'c2b',
        externalRef: 'SBK81KZ9QF',
        idempotencyKey: 'accounting:quickbooks:SBK81KZ9QF',
        amount: Money.ofMinor(250_000n, 'KES'),
      },
      { clock },
    );
    const second = mapAccountingPayment(darajaShaped, 'quickbooks', { clock, existing: [known.payment] });
    expect(second.kind).toBe('intaked');
    if (second.kind === 'intaked') {
      expect(second.duplicate).toBe(true);
      expect(second.paymentId).toBe(known.payment.id);
    }
  });

  it('refuses payments WITHOUT a Daraja-shaped reference — no invented channel truth', () => {
    const result = mapAccountingPayment({ payment_number: 'PAY-2', amount: 100.0 }, 'zohobooks', { clock });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') {
      expect(result.code).toBe('INTAKE_PAY_CHANNEL_UNKNOWN');
      expect(result.detail).toContain('inventing channel truth');
    }
  });

  it('refuses malformed amounts', () => {
    const result = mapAccountingPayment({ payment_number: 'PAY-3', amount: 12.345, mpesaTransactionId: 'SBK81KZ9QF' }, 'quickbooks', { clock });
    expect(result.kind).toBe('refused');
    if (result.kind === 'refused') expect(result.code).toBe('INTAKE_PAY_AMOUNT_INVALID');
  });
});
