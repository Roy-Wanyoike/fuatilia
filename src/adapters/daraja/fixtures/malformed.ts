/**
 * Malformed / foreign payload fixtures (F15) — the K1 untrusted-input table.
 *
 * Each row is wire-shaped junk a hostile or buggy gateway could send, paired
 * with the stable DARAJA_* code the parser must reject it with. The conformance
 * suite dead-letters every one of these and proves NONE of them reaches the
 * domain (no Payment, no event).
 */
import type { DarajaFixture } from './fixture';

export const MALFORMED_FIXTURES: readonly DarajaFixture[] = [
  {
    id: 'malformed.not-an-object',
    family: 'malformed',
    note: 'raw string body — matches no callback family',
    payload: '"payment received, promise"',
    expectRejection: 'DARAJA_PAYLOAD_UNRECOGNIZED',
  },
  {
    id: 'malformed.empty-object',
    family: 'malformed',
    note: 'empty JSON object — no family markers at all',
    payload: {},
    expectRejection: 'DARAJA_PAYLOAD_UNRECOGNIZED',
  },
  {
    id: 'malformed.foreign-gateway-payload',
    family: 'malformed',
    note: 'Stripe-shaped payload — foreign gateway must never parse as Daraja',
    payload: {
      id: 'evt_1NcQzR2eZvKYlo2C',
      type: 'payment_intent.succeeded',
      data: { object: { amount: 2500, currency: 'kes' } },
    },
    expectRejection: 'DARAJA_PAYLOAD_UNRECOGNIZED',
  },
  {
    id: 'malformed.c2b-missing-amount',
    family: 'malformed',
    note: 'C2B shape but TransAmount missing',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '20250912143015',
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_AMOUNT_REQUIRED',
  },
  {
    id: 'malformed.c2b-amount-three-decimals',
    family: 'malformed',
    note: 'TransAmount with 3 minor places — never silently rounded (R10)',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '20250912143015',
      TransAmount: '2500.005',
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_AMOUNT_MALFORMED',
  },
  {
    id: 'malformed.c2b-amount-float-junk',
    family: 'malformed',
    note: '0.30000000000000004-style float junk as a JSON number',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '20250912143015',
      TransAmount: 0.30000000000000004,
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_AMOUNT_MALFORMED',
  },
  {
    id: 'malformed.c2b-transid-lowercase',
    family: 'malformed',
    note: 'TransID in lowercase — Daraja ids are uppercase [A-Z0-9]',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'sbk41xq7rt',
      TransTime: '20250912143015',
      TransAmount: '2500.00',
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_TRANS_ID_MALFORMED',
  },
  {
    id: 'malformed.c2b-msisdn-local-form',
    family: 'malformed',
    note: 'local 07… MSISDN — only international 2547/2541 form accepted',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '20250912143015',
      TransAmount: '2500.00',
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '0712345678',
    },
    expectRejection: 'DARAJA_MSISDN_MALFORMED',
  },
  {
    id: 'malformed.c2b-transtime-zoned-string',
    family: 'malformed',
    note: 'ISO zoned string instead of YYYYMMDDHHmmss',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '2025-09-12T14:30:15+03:00',
      TransAmount: '2500.00',
      BusinessShortCode: '412873',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_TRANS_TIME_MALFORMED',
  },
  {
    id: 'malformed.c2b-shortcode-alphabetic',
    family: 'malformed',
    note: 'BusinessShortCode must be 5–7 digits',
    payload: {
      TransactionType: 'Pay Bill',
      TransID: 'SBK41XQ7RT',
      TransTime: '20250912143015',
      TransAmount: '2500.00',
      BusinessShortCode: 'PAYBILL',
      BillRefNumber: 'INV-1042',
      OrgAccountBalance: '489230.00',
      MSISDN: '254712345678',
    },
    expectRejection: 'DARAJA_SHORT_CODE_MALFORMED',
  },
  {
    id: 'malformed.stk-checkout-id-shape',
    family: 'malformed',
    note: 'CheckoutRequestID missing the ws_CO_ prefix',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: '58234-11940372-1',
          CheckoutRequestID: 'CO-12092025143105741',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
        },
      },
    },
    expectRejection: 'DARAJA_CHECKOUT_REQUEST_ID_MALFORMED',
  },
  {
    id: 'malformed.stk-negative-result-code',
    family: 'malformed',
    note: 'negative ResultCode — codes are non-negative integers',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: '58234-11940372-1',
          CheckoutRequestID: 'ws_CO_12092025143105741',
          ResultCode: -1,
          ResultDesc: 'impossible code',
        },
      },
    },
    expectRejection: 'DARAJA_RESULT_CODE_INVALID',
  },
  {
    id: 'malformed.stk-success-without-metadata',
    family: 'malformed',
    note: 'ResultCode 0 but no CallbackMetadata — a success MUST carry the receipt',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: '58234-11940372-1',
          CheckoutRequestID: 'ws_CO_12092025143105741',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
        },
      },
    },
    expectRejection: 'DARAJA_STK_METADATA_MALFORMED',
  },
  {
    id: 'malformed.stk-metadata-item-not-object',
    family: 'malformed',
    note: 'CallbackMetadata.Item entries must be Name/Value objects',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: '58234-11940372-1',
          CheckoutRequestID: 'ws_CO_12092025143105741',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: { Item: ['Amount', 2500] },
        },
      },
    },
    expectRejection: 'DARAJA_STK_METADATA_MALFORMED',
  },
  {
    id: 'malformed.stk-no-amount-known',
    family: 'malformed',
    note: 'failure result with no metadata AND no initiation record — the amount is unknowable',
    payload: {
      Body: {
        stkCallback: {
          MerchantRequestID: '58234-11940999-2',
          CheckoutRequestID: 'ws_CO_12092025144000202',
          ResultCode: 1,
          ResultDesc: 'Request cancelled by user',
        },
      },
    },
    expectRejection: 'DARAJA_STK_AMOUNT_UNKNOWN',
  },
  {
    id: 'malformed.b2c-bad-result-parameters',
    family: 'malformed',
    note: 'B2C shape but ResultParameters is not the ResultParameter array',
    payload: {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      OriginatorConversationID: '58234-7714364-1',
      ConversationID: 'AG_12092025143_119403721',
      TransactionID: 'RKT81KZ9QF',
      ResultParameters: { ResultParameter: 'nope' },
    },
    expectRejection: 'DARAJA_B2C_RESULT_MALFORMED',
  },
] as const;
