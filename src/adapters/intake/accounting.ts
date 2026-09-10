/**
 * External accounting pull mappers (issue #87, RICE #5) — READ-ONLY pure
 * mappings from QuickBooks / Zoho Books invoice + payment JSON shapes into
 * the EXISTING receivables/payments intake functions. No fund-truth bypass,
 * no network (transport injected; tests use fakes).
 *
 * Honesty rules:
 *   - unmapped/extra fields are tolerated; missing REQUIRED fields are
 *     typed refusals, never guesses;
 *   - an accounting payment maps into the real payments funnel ONLY when the
 *     record carries an explicit Daraja-shaped M-Pesa transaction reference
 *     in OUR documented contract field (`mpesaTransactionId`), so a later
 *     live callback dedupes under R9; anything else is REFUSED rather than
 *     inventing channel truth (an ERP payment record is not M-Pesa money).
 *   - KES-only: non-KES documents refused (no FX lane wired into intake).
 */
import { DomainError, type Clock, type Uuid, uuid as uuidFrom } from '../../domain/shared';
import type { DomainEvent } from '../../domain/receivables/events';
import type { PaymentEvent } from '../../domain/payments/events';
import { Money } from '../../domain/shared/money';
import { addInvoiceLine, createInvoice, issueInvoice } from '../../domain/receivables/invoice';
import { openReceivable } from '../../domain/receivables/receivable';
import { intakePayment } from '../../domain/payments/intake';
import type { Invoice, InvoiceLine } from '../../domain/receivables/invoice';

const KES = 'KES';

/** M-Pesa transaction id shape (Daraja conformance mirror: uppercase [A-Z0-9], 10–22). */
const MPESA_REF = /^[A-Z0-9]{10,22}$/;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const str = (record: Record<string, unknown> | null, field: string): string | null => {
  const v = record?.[field];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

const minorFromNumber = (value: unknown): bigint | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Accounting APIs send DECIMAL amounts as numbers — the ONE place a
    // float exists on the wire. Convert through the exact string form; a
    // value that does not round-trip to ≤2dp is refused.
    const s = value.toString();
    if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
    const neg = s.startsWith('-');
    const [intPartRaw, fracPart = ''] = (neg ? s.slice(1) : s).split('.');
  const intPart = intPartRaw ?? '0';
    const frac = (fracPart + '00').slice(0, 2);
    const minor = BigInt(intPart) * 100n + BigInt(frac);
    if (minor === 0n) return null;
    return neg ? null : minor; // negative amounts are refused upstream of this helper
  }
  return null;
};

export interface AccountingInvoicePrepared {
  readonly invoice: Invoice;
  readonly receivable: ReturnType<typeof openReceivable>['receivable'];
  readonly events: readonly DomainEvent<string, unknown>[];
  readonly source: 'quickbooks' | 'zohobooks';
  readonly externalRef: string;
}

export type AccountingInvoiceRefusal = {
  readonly source: 'quickbooks' | 'zohobooks';
  readonly externalRef: string;
  readonly code: string;
  readonly detail: string;
};

export type AccountingInvoiceResult =
  | { readonly kind: 'prepared'; readonly invoices: readonly AccountingInvoicePrepared[] }
  | { readonly kind: 'refusals'; readonly refusals: readonly AccountingInvoiceRefusal[] };

/**
 * Map one QuickBooks invoice JSON to the intake functions. Documented
 * fields: DocNumber, CustomerRef.value, CurrencyRef.value, DueDate,
 * Line[].{Description, Amount} (SalesItemLine only). Everything else is
 * tolerated noise.
 */
export const mapQuickBooksInvoice = (
  payload: unknown,
  derivationKey: string,
  clock: Clock,
): { prepared: AccountingInvoicePrepared | null; refusal: AccountingInvoiceRefusal | null } => {
  const record = asRecord(payload);
  const externalRef = str(record, 'DocNumber') ?? '(missing DocNumber)';
  const refuse = (code: string, detail: string): { prepared: null; refusal: AccountingInvoiceRefusal } => ({
    prepared: null,
    refusal: { source: 'quickbooks', externalRef, code, detail },
  });
  if (record === null) return refuse('INTAKE_QB_PAYLOAD_INVALID', 'payload is not an object');

  const customerRefRecord = asRecord(record['CustomerRef']);
  const customerId = customerRefRecord === null ? null : str(customerRefRecord, 'value');
  const currencyRefRecord = asRecord(record['CurrencyRef']);
  const currency = (currencyRefRecord === null ? null : str(currencyRefRecord, 'value'))?.toUpperCase() ?? KES;
  const dueDateRaw = str(record, 'DueDate');
  const lines = Array.isArray(record['Line']) ? record['Line'] : null;

  if (customerId === null || customerId === undefined) return refuse('INTAKE_QB_CUSTOMER_REQUIRED', 'CustomerRef.value is required');
  if (currency !== KES) return refuse('INTAKE_QB_CURRENCY_REFUSED', `currency ${currency} refused — intake is KES-only (no FX lane wired)`);
  if (dueDateRaw === null || parseIsoDate(dueDateRaw) === null) return refuse('INTAKE_QB_DATE_INVALID', 'DueDate must be an ISO date');
  if (lines === null || lines.length === 0) return refuse('INTAKE_QB_LINES_REQUIRED', 'Line[] with at least one SalesItemLine is required');

  try {
    let invoice = createInvoice({ id: derivedUuid(derivationKey, externalRef, 'inv'), customerId: uuidFrom(customerId), currency: KES, dueDate: parseIsoDate(dueDateRaw) as Date });
    for (const rawLine of lines) {
      const line = asRecord(rawLine);
      if (line === null || line['Amount'] === undefined) continue; // tolerated non-item lines
      if (str(line, 'DetailType') !== 'SalesItemLine') continue;
      const minor = minorFromNumber(line['Amount']);
      if (minor === null) return refuse('INTAKE_QB_AMOUNT_INVALID', `Line Amount ${String(line['Amount'])} is not a positive ≤2dp number`);
      const lineItem: InvoiceLine = { description: str(line, 'Description') ?? '(no description)', amount: Money.ofMinor(minor, KES) };
      invoice = addInvoiceLine(invoice, lineItem);
    }
    if (invoice.lines.length === 0) return refuse('INTAKE_QB_LINES_REQUIRED', 'no SalesItemLine survived mapping');
    const issued = issueInvoice(invoice, { sequenceNo: 1, reserveNumber: () => externalRef }, clock);
    const opened = openReceivable(issued.invoice, derivedUuid(derivationKey, externalRef, 'recv'), clock);
    return {
      prepared: {
        invoice: opened.invoice,
        receivable: opened.receivable,
        events: [issued.event, opened.event],
        source: 'quickbooks',
        externalRef,
      },
      refusal: null,
    };
  } catch (error: unknown) {
    const code = error instanceof DomainError ? error.code : 'INTAKE_QB_MAPPING_FAILED';
    return refuse(code, error instanceof Error ? error.message : String(error));
  }
};

/**
 * Map one Zoho Books invoice JSON. Documented fields: invoice_number,
 * customer_id, currency_code, due_date, line_items[].{name|description,
 * rate, quantity}. Totals are recomputed from lines — the adapter never
 * trusts a precomputed total (rate × quantity must be exact in minor units).
 */
export const mapZohoInvoice = (
  payload: unknown,
  derivationKey: string,
  clock: Clock,
): { prepared: AccountingInvoicePrepared | null; refusal: AccountingInvoiceRefusal | null } => {
  const record = asRecord(payload);
  const externalRef = str(record, 'invoice_number') ?? '(missing invoice_number)';
  const refuse = (code: string, detail: string): { prepared: null; refusal: AccountingInvoiceRefusal } => ({
    prepared: null,
    refusal: { source: 'zohobooks', externalRef, code, detail },
  });
  if (record === null) return refuse('INTAKE_ZB_PAYLOAD_INVALID', 'payload is not an object');

  const customerId = str(record, 'customer_id');
  const currency = str(record, 'currency_code')?.toUpperCase() ?? KES;
  const dueDateRaw = str(record, 'due_date');
  const lineItems = Array.isArray(record['line_items']) ? record['line_items'] : null;

  if (customerId === null || customerId === undefined) return refuse('INTAKE_ZB_CUSTOMER_REQUIRED', 'customer_id is required');
  if (currency !== KES) return refuse('INTAKE_ZB_CURRENCY_REFUSED', `currency ${currency} refused — intake is KES-only (no FX lane wired)`);
  if (dueDateRaw === null || parseIsoDate(dueDateRaw) === null) return refuse('INTAKE_ZB_DATE_INVALID', 'due_date must be an ISO date');
  if (lineItems === null || lineItems.length === 0) return refuse('INTAKE_ZB_LINES_REQUIRED', 'line_items[] is required');

  try {
    let invoice = createInvoice({ id: derivedUuid(derivationKey, externalRef, 'inv'), customerId: uuidFrom(customerId), currency: KES, dueDate: parseIsoDate(dueDateRaw) as Date });
    for (const rawLine of lineItems) {
      const line = asRecord(rawLine);
      if (line === null) continue;
      const rate = minorFromNumber(line['rate']);
      if (rate === null) return refuse('INTAKE_ZB_AMOUNT_INVALID', `line rate ${String(line['rate'])} is not a positive ≤2dp number`);
      const quantityRaw = line['quantity'] ?? 1;
      const quantity = typeof quantityRaw === 'number' && Number.isInteger(quantityRaw) && quantityRaw > 0 ? BigInt(quantityRaw) : 1n;
      const minor = rate * quantity;
      const lineItem: InvoiceLine = {
        description: str(line, 'description') ?? str(line, 'name') ?? '(no description)',
        amount: Money.ofMinor(minor, KES),
      };
      invoice = addInvoiceLine(invoice, lineItem);
    }
    if (invoice.lines.length === 0) return refuse('INTAKE_ZB_LINES_REQUIRED', 'no line_items survived mapping');
    const issued = issueInvoice(invoice, { sequenceNo: 1, reserveNumber: () => externalRef }, clock);
    const opened = openReceivable(issued.invoice, derivedUuid(derivationKey, externalRef, 'recv'), clock);
    return {
      prepared: {
        invoice: opened.invoice,
        receivable: opened.receivable,
        events: [issued.event, opened.event],
        source: 'zohobooks',
        externalRef,
      },
      refusal: null,
    };
  } catch (error: unknown) {
    const code = error instanceof DomainError ? error.code : 'INTAKE_ZB_MAPPING_FAILED';
    return refuse(code, error instanceof Error ? error.message : String(error));
  }
};

export interface AccountingPaymentResult {
  readonly kind: 'intaked' | 'refused';
  readonly externalRef: string;
  readonly paymentId?: Uuid;
  readonly duplicate?: boolean;
  readonly events?: readonly PaymentEvent[];
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Map one accounting payment JSON into the REAL payments intake. The record
 * MUST carry `mpesaTransactionId` (Daraja-shaped) in our documented contract
 * field — a live M-Pesa callback for the same transaction then dedupes under
 * R9. Accounting payments WITHOUT a Daraja-shaped reference are refused
 * honestly: importing them would invent channel truth and create a payment
 * a bank/daraja callback can never reconcile against.
 */
export const mapAccountingPayment = (
  payload: unknown,
  source: 'quickbooks' | 'zohobooks',
  ctx: { readonly clock: Clock; readonly existing?: readonly import('../../domain/payments/payment').Payment[] },
): AccountingPaymentResult => {
  const record = asRecord(payload);
  const externalRef = str(record, 'payment_number') ?? str(record, 'DocNumber') ?? str(record, 'payment_id') ?? '(unidentified)';
  const refuse = (code: string, detail: string): AccountingPaymentResult => ({
    kind: 'refused',
    externalRef,
    code,
    detail,
  });
  if (record === null) return refuse('INTAKE_PAY_PAYLOAD_INVALID', 'payload is not an object');

  const amountMinor = minorFromNumber(record['amount']);
  if (amountMinor === null) return refuse('INTAKE_PAY_AMOUNT_INVALID', `amount ${String(record['amount'])} is not a positive ≤2dp number`);

  const mpesaRef = str(record, 'mpesaTransactionId');
  if (mpesaRef === null || !MPESA_REF.test(mpesaRef)) {
    return refuse(
      'INTAKE_PAY_CHANNEL_UNKNOWN',
      `payment ${externalRef} carries no Daraja-shaped mpesaTransactionId — refusing rather than inventing channel truth`,
    );
  }

  const customerId = str(record, 'customer_id') ?? (typeof record['CustomerRef'] === 'string' ? (record['CustomerRef'] as string) : null);
  const invoiceNumber = str(record, 'invoice_number');
  const declaredRefs = invoiceNumber !== null ? [invoiceNumber] : undefined;
  const result = intakePayment(
    {
      channel: 'c2b',
      externalRef: mpesaRef,
      idempotencyKey: `accounting:${source}:${mpesaRef}`,
      amount: Money.ofMinor(amountMinor, KES),
      ...(customerId !== null ? { customerId: uuidFrom(customerId) } : {}),
      ...(declaredRefs !== undefined ? { declaredRefs } : {}),
    },
    ctx,
  );
  return {
    kind: 'intaked',
    externalRef,
    paymentId: result.payment.id,
    duplicate: result.duplicate,
    events: result.events,
  };
};

// --- helpers ---------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const parseIsoDate = (raw: string): Date | null => {
  if (!ISO_DATE.test(raw)) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hex36 = (seed: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const base = h.toString(16).padStart(8, '0');
  const reversed = base.split('').reverse().join('');
  return (base + reversed + base + reversed).slice(0, 32);
};

const derivedUuid = (derivationKey: string, externalRef: string, salt: string): Uuid => {
  const hex = hex36(`${derivationKey}|${externalRef}|${salt}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Uuid;
};

