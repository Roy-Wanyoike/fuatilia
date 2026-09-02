/**
 * Invoice aggregate — the receivables-lane half of the Invoice → Receivable
 * split (issue #1). An invoice is the *document*; the receivable (see
 * receivable.ts) is the *debt*. Corrections after issuance are credit notes
 * (adjustments lane) — never invoice edits.
 *
 * Lifecycle (docs/03-state-machines.md):
 *   Draft → Issued   (eTIMS-ready number reserved via injectable pure hook +
 *                     totals frozen)
 *   Issued → Sent    (delivery via channel)
 *   Issued → Voided  (never sent)
 *   Sent → Voided    (mistake; credit note preferred once payments exist)
 *
 * eTIMS numbering: `issueInvoice` takes the caller's next sequence number and
 * a pure formatter `(seq: number) => string` — the format hook is injectable;
 * full KRA eTIMS integration lands with issue #10. Everything here is pure:
 * no I/O, no Date.now(), time only via the injected Clock.
 */
import { DomainError, Money, type Clock, type Currency, type Uuid } from '../shared';
import {
  domainEvent,
  minorToNumber,
  type DomainEvent,
  type InvoiceEvent,
  type InvoiceIssuedPayload,
  type InvoiceSentPayload,
  type InvoiceVoidedPayload,
} from './events';

export type InvoiceStatus = 'draft' | 'issued' | 'sent' | 'voided';

export interface InvoiceLine {
  readonly description: string;
  readonly amount: Money;
}

export interface Invoice {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly status: InvoiceStatus;
  readonly currency: Currency;
  readonly lines: readonly InvoiceLine[];
  /** Sum of line amounts — frozen the moment the invoice is issued. */
  readonly total: Money;
  /** eTIMS-ready number, reserved at issuance; null while draft. */
  readonly invoiceNumber: string | null;
  readonly issuedAt: Date | null;
  readonly dueDate: Date;
  readonly sentAt: Date | null;
  readonly sentChannel: string | null;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly voidedBy: string | null;
  /**
   * Exactly-one guard (docs/05: invoiceId unique on Receivable): the id of the
   * single receivable this invoice has produced, or null. openReceivable /
   * draftReceivableFor own this slot.
   */
  readonly receivableId: Uuid | null;
}

export function createInvoice(args: {
  id: Uuid;
  customerId: Uuid;
  currency: Currency;
  dueDate: Date;
}): Invoice {
  return {
    id: args.id,
    customerId: args.customerId,
    status: 'draft',
    currency: args.currency,
    lines: [],
    total: Money.zero(args.currency),
    invoiceNumber: null,
    issuedAt: null,
    dueDate: args.dueDate,
    sentAt: null,
    sentChannel: null,
    voidedAt: null,
    voidReason: null,
    voidedBy: null,
    receivableId: null,
  };
}

/** Accumulate a line on a draft invoice and recompute the total. */
export function addInvoiceLine(invoice: Invoice, line: InvoiceLine): Invoice {
  if (invoice.status !== 'draft') {
    throw new DomainError(
      'INVOICE_LINES_FROZEN',
      `invoice ${invoice.id} is ${invoice.status} — totals are frozen; use a credit note`,
      { status: invoice.status },
    );
  }
  if (line.description.trim().length === 0 || !line.amount.isPositive()) {
    throw new DomainError(
      'INVOICE_LINE_INVALID',
      'a line needs a non-blank description and a positive amount',
    );
  }
  if (line.amount.currency !== invoice.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `line is ${line.amount.currency} but invoice is ${invoice.currency}`,
    );
  }
  return {
    ...invoice,
    lines: [...invoice.lines, { description: line.description.trim(), amount: line.amount }],
    total: invoice.total.add(line.amount),
  };
}

/**
 * Draft → Issued. Reserves the eTIMS-ready invoice number through the
 * injectable pure formatter and freezes totals (no further line edits).
 */
export function issueInvoice(
  invoice: Invoice,
  args: { sequenceNo: number; reserveNumber: (seq: number) => string },
  clock: Clock,
): { invoice: Invoice; event: DomainEvent<'invoicing.invoiceIssued', InvoiceIssuedPayload> } {
  if (invoice.status === 'issued') {
    throw new DomainError(
      'INVOICE_ALREADY_ISSUED',
      `invoice ${invoice.id} is already issued as ${invoice.invoiceNumber}`,
    );
  }
  if (invoice.status !== 'draft') {
    throw new DomainError(
      'INVALID_INVOICE_TRANSITION',
      `cannot issue from ${invoice.status}`,
      { from: invoice.status, to: 'issued' },
    );
  }
  if (!Number.isSafeInteger(args.sequenceNo) || args.sequenceNo < 1) {
    throw new DomainError(
      'INVOICE_SEQUENCE_INVALID',
      `sequenceNo must be a safe integer ≥ 1, got ${args.sequenceNo}`,
    );
  }
  const reserved = args.reserveNumber(args.sequenceNo);
  const invoiceNumber = reserved.trim();
  if (invoiceNumber.length === 0) {
    throw new DomainError(
      'INVOICE_NUMBER_INVALID',
      'reserveNumber returned a blank invoice number',
    );
  }
  const issued: Invoice = {
    ...invoice,
    status: 'issued',
    invoiceNumber,
    issuedAt: clock.now(),
  };
  const event = domainEvent(
    'invoicing.invoiceIssued',
    invoice.id,
    {
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      totalMinor: minorToNumber(invoice.total),
      currency: invoice.currency,
      dueDate: invoice.dueDate.toISOString(),
    },
    clock,
  );
  return { invoice: issued, event };
}

/** Issued → Sent — records the delivery channel (collections engagement signal). */
export function markInvoiceSent(
  invoice: Invoice,
  channel: string,
  clock: Clock,
): { invoice: Invoice; event: DomainEvent<'invoicing.invoiceSent', InvoiceSentPayload> } {
  const deliveredVia = channel.trim();
  if (deliveredVia.length === 0) {
    throw new DomainError('INVOICE_CHANNEL_INVALID', 'delivery channel must be non-blank');
  }
  if (invoice.status !== 'issued') {
    throw new DomainError(
      'INVOICE_NOT_ISSUED',
      `cannot mark sent from ${invoice.status}`,
      { from: invoice.status, to: 'sent' },
    );
  }
  const sent: Invoice = {
    ...invoice,
    status: 'sent',
    sentAt: clock.now(),
    sentChannel: deliveredVia,
  };
  const event = domainEvent(
    'invoicing.invoiceSent',
    invoice.id,
    { invoiceId: invoice.id, channel: deliveredVia, sentAt: sent.sentAt!.toISOString() },
    clock,
  );
  return { invoice: sent, event };
}

/**
 * Issued → Voided (never sent) or Sent → Voided (mistake). A decision with a
 * reason and an actor — recorded, never erased. Drafts are not voided (they
 * are simply never issued); voided invoices are terminal.
 */
export function voidInvoice(
  invoice: Invoice,
  args: { reason: string; actorId: string },
  clock: Clock,
): { invoice: Invoice; event: DomainEvent<'invoicing.invoiceVoided', InvoiceVoidedPayload> } {
  const reason = args.reason.trim();
  const actorId = args.actorId.trim();
  if (reason.length === 0) {
    throw new DomainError('INVOICE_VOID_REASON_REQUIRED', 'voiding an invoice requires a reason');
  }
  if (actorId.length === 0) {
    throw new DomainError('INVOICE_VOID_ACTOR_REQUIRED', 'voiding an invoice requires an actor');
  }
  if (invoice.status !== 'issued' && invoice.status !== 'sent') {
    throw new DomainError(
      'INVALID_INVOICE_TRANSITION',
      `cannot void from ${invoice.status}`,
      { from: invoice.status, to: 'voided' },
    );
  }
  const voided: Invoice = {
    ...invoice,
    status: 'voided',
    voidedAt: clock.now(),
    voidReason: reason,
    voidedBy: actorId,
  };
  const event = domainEvent(
    'invoicing.invoiceVoided',
    invoice.id,
    { invoiceId: invoice.id, reason, actorId },
    clock,
  );
  return { invoice: voided, event };
}
