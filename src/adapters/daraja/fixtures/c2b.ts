/**
 * C2B callback fixtures (issue #25, F15) — Pay Bill / Buy Goods notifications.
 *
 * Daraja delivers the SAME notification body to the validation endpoint and
 * then to the confirmation endpoint for one transaction, so each journey below
 * is one payload const reused by a validation row and a confirmation row (the
 * endpoints differ, the wire facts do not).
 *
 * All values are SYNTHETIC Kenyan-realistic data: invented paybill/till short
 * codes, SBK…-shaped TransIDs, 2547…/2541… test MSISDNs, KES decimal-string
 * amounts. No real PII anywhere (K3).
 */
import type { DarajaC2bPayload } from '../wire';
import type { DarajaFixture } from './fixture';

const PAYBILL_SINGLE: DarajaC2bPayload = {
  TransactionType: 'Pay Bill',
  TransID: 'SBK41XQ7RT',
  TransTime: '20250912143015', // EAT wall clock — 11:30:15 UTC
  TransAmount: '2500.00',
  BusinessShortCode: '412873',
  BillRefNumber: 'INV-1042',
  OrgAccountBalance: '489230.00',
  MSISDN: '254712345678',
};

const PAYBILL_MULTI_REF: DarajaC2bPayload = {
  TransactionType: 'Pay Bill',
  TransID: 'SBC52JP4NM',
  TransTime: '20250918091544',
  TransAmount: '15000.00',
  BusinessShortCode: '412873',
  BillRefNumber: 'INV-2077/INV-2078', // one transfer explaining two invoices
  OrgAccountBalance: '1204510.50',
  MSISDN: '254722000111',
};

const BUY_GOODS_TILL: DarajaC2bPayload = {
  TransactionType: 'Buy Goods',
  TransID: 'SBJ73CD8WT',
  TransTime: '20251001172030',
  TransAmount: '980.50',
  BusinessShortCode: '987654',
  BillRefNumber: '', // tills routinely send a blank account reference
  OrgAccountBalance: '31500.00',
  MSISDN: '254113456789',
  InvoiceNumber: 'TILL-88412', // optional field some integrators populate
};

const PAYBILL_NO_REF: DarajaC2bPayload = {
  TransactionType: 'Pay Bill',
  TransID: 'SBA84EF6YL',
  TransTime: '20251005074510',
  TransAmount: '4200.00',
  BusinessShortCode: '412873',
  BillRefNumber: '', // payer typed nothing — unidentified money
  OrgAccountBalance: '523809.00',
  MSISDN: '254712345678',
};

const TAMPERED_AMOUNT: DarajaC2bPayload = {
  TransactionType: 'Pay Bill',
  TransID: 'SBK41XQ7RT', // SAME journey as PAYBILL_SINGLE…
  TransTime: '20250912143015',
  TransAmount: '3500.00', // …but different money — tampering, not a retry
  BusinessShortCode: '412873',
  BillRefNumber: 'INV-1042',
  OrgAccountBalance: '491730.00',
  MSISDN: '254712345678',
};

export const C2B_FIXTURES: readonly DarajaFixture[] = [
  {
    id: 'c2b.validation.paybill-single-invoice',
    family: 'c2b-validation',
    note: 'Pay Bill validation — payer cites INV-1042, KES 2500.00',
    payload: PAYBILL_SINGLE,
  },
  {
    id: 'c2b.confirmation.paybill-single-invoice',
    family: 'c2b-confirmation',
    note: 'Pay Bill confirmation — the money fact for journey SBK41XQ7RT',
    payload: PAYBILL_SINGLE,
  },
  {
    id: 'c2b.validation.paybill-multi-ref',
    family: 'c2b-validation',
    note: 'Pay Bill validation — BillRefNumber cites TWO invoice refs',
    payload: PAYBILL_MULTI_REF,
  },
  {
    id: 'c2b.confirmation.paybill-multi-ref',
    family: 'c2b-confirmation',
    note: 'Pay Bill confirmation — one transfer, two declared refs (C1 shape)',
    payload: PAYBILL_MULTI_REF,
  },
  {
    id: 'c2b.confirmation.buygoods-till',
    family: 'c2b-confirmation',
    note: 'Buy Goods confirmation — blank BillRefNumber, InvoiceNumber set',
    payload: BUY_GOODS_TILL,
  },
  {
    id: 'c2b.confirmation.paybill-no-ref',
    family: 'c2b-confirmation',
    note: 'Pay Bill confirmation — no account reference at all (unapplied money)',
    payload: PAYBILL_NO_REF,
  },
  {
    id: 'c2b.confirmation.tampered-amount',
    family: 'c2b-confirmation',
    note: 'Replay of journey SBK41XQ7RT carrying different money — K1 tampering',
    payload: TAMPERED_AMOUNT,
    tampered: true,
    expectRejection: 'DUPLICATE_AMOUNT_MISMATCH', // thrown by payments intake (R9/K1)
  },
] as const;
