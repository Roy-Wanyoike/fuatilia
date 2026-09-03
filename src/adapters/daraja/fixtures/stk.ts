/**
 * STK push (M-Pesa Express / Lipa na M-Pesa Online) result fixtures (F15).
 *
 * ResultCode semantics exercised by the conformance matrix (SPEC M-Pesa/Daraja):
 *   0    — success; carries CallbackMetadata (Amount, MpesaReceiptNumber,
 *          TransactionDate, PhoneNumber)
 *   1    — request cancelled by user → abandoned
 *   2    — timeout / processing error → abandoned
 *   1032 — request cancelled by user (observed sandbox variant) → abandoned
 *   1037 — DS timeout: user cannot be reached → abandoned
 *   1001 — system error (unmapped edge code) → failed by the safe default
 *
 * Failure results carry NO CallbackMetadata and therefore NO amount — the
 * merchant's initiation record (world) is what the adapter needs to know what
 * was asked for (E11).
 *
 * All values are SYNTHETIC (invented ids, test MSISDNs). No real PII.
 */
import type { DarajaStkPayload } from '../wire';
import type { DarajaFixture } from './fixture';

const SUCCESS: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58234-11940372-1',
      CheckoutRequestID: 'ws_CO_12092025143105741',
      ResultCode: 0,
      ResultDesc: 'The service request is processed successfully.',
      CallbackMetadata: {
        Item: [
          { Name: 'Amount', Value: 2500 },
          { Name: 'MpesaReceiptNumber', Value: 'SBK81KZ9QF' },
          { Name: 'Balance' }, // Value intentionally absent on some items
          { Name: 'TransactionDate', Value: '20250912143105' },
          { Name: 'PhoneNumber', Value: 254712345678 },
        ],
      },
    },
  },
};

const CANCELLED: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58235-11940999-2',
      CheckoutRequestID: 'ws_CO_12092025144000202',
      ResultCode: 1,
      ResultDesc: 'Request cancelled by user',
    },
  },
};

const TIMEOUT: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58236-11941005-3',
      CheckoutRequestID: 'ws_CO_12092025145530103',
      ResultCode: 2,
      ResultDesc: 'The initiator request timed out',
    },
  },
};

const CANCELLED_1032: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58237-11941120-4',
      CheckoutRequestID: 'ws_CO_12092025151022104',
      ResultCode: 1032,
      ResultDesc: 'Request cancelled by user',
    },
  },
};

const DS_TIMEOUT_1037: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58238-11941244-5',
      CheckoutRequestID: 'ws_CO_12092025152140505',
      ResultCode: 1037,
      ResultDesc: 'DS timeout: user cannot be reached',
    },
  },
};

const SYSTEM_ERROR_1001: DarajaStkPayload = {
  Body: {
    stkCallback: {
      MerchantRequestID: '58239-11941388-6',
      CheckoutRequestID: 'ws_CO_12092025153309906',
      ResultCode: 1001,
      ResultDesc: 'System error while processing the request',
    },
  },
};

export const STK_FIXTURES: readonly DarajaFixture[] = [
  {
    id: 'stk.success.metadata-complete',
    family: 'stk-result',
    note: 'STK push paid — KES 2500.00 with receipt SBK81KZ9QF (ResultCode 0)',
    payload: SUCCESS,
  },
  {
    id: 'stk.cancelled-by-user.code-1',
    family: 'stk-result',
    note: 'STK push abandoned — user cancelled at the prompt (ResultCode 1)',
    payload: CANCELLED,
  },
  {
    id: 'stk.timeout.code-2',
    family: 'stk-result',
    note: 'STK push abandoned — processing timeout (ResultCode 2)',
    payload: TIMEOUT,
  },
  {
    id: 'stk.cancelled-by-user.code-1032',
    family: 'stk-result',
    note: 'STK push abandoned — user-cancelled sandbox variant (ResultCode 1032)',
    payload: CANCELLED_1032,
  },
  {
    id: 'stk.unreachable.code-1037',
    family: 'stk-result',
    note: 'STK push abandoned — DS timeout, user cannot be reached (ResultCode 1037)',
    payload: DS_TIMEOUT_1037,
  },
  {
    id: 'stk.system-error.code-1001',
    family: 'stk-result',
    note: 'STK push failed — unmapped edge code 1001 (safe default: failed)',
    payload: SYSTEM_ERROR_1001,
  },
] as const;
