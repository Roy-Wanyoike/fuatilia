/**
 * Stable error codes for the Daraja adapter lane (issue #25, F15).
 *
 * Every failure this lane raises carries a machine-readable, stable
 * SCREAMING_SNAKE code with the `DARAJA_` prefix, so the transport layer can
 * map it to API responses / dead-letter queues without string matching.
 *
 * Families:
 *  - FIXTURE_*  — fixture-registry misuse (unknown id, duplicate id, invalid row)
 *  - PAYLOAD_* / field codes — the K1 untrusted-input boundary: a callback that
 *    fails structural validation is dead-lettered, never processed
 *  - DELIVERY_* / SEED / CLOCK / TIMEOUT_POLICY / WORLD — simulator misuse
 *  - SCENARIO_* — conformance-harness misuse (unknown scenario fixture/check)
 *  - C2B_KIND_REQUIRED — caller error: a C2B payload arrived without the
 *    delivering-endpoint hint (the payload is recognized; the CALL is wrong,
 *    so it deliberately does not piggyback on PAYLOAD_UNRECOGNIZED)
 */
export const DARAJA_ERRORS = {
  FIXTURE_NOT_FOUND: 'DARAJA_FIXTURE_NOT_FOUND',
  FIXTURE_DUPLICATE_ID: 'DARAJA_FIXTURE_DUPLICATE_ID',
  FIXTURE_INVALID: 'DARAJA_FIXTURE_INVALID',
  PAYLOAD_UNRECOGNIZED: 'DARAJA_PAYLOAD_UNRECOGNIZED',
  C2B_KIND_REQUIRED: 'DARAJA_C2B_KIND_REQUIRED',
  WORLD_INVALID: 'DARAJA_WORLD_INVALID',
  TRANS_ID_REQUIRED: 'DARAJA_TRANS_ID_REQUIRED',
  TRANS_ID_MALFORMED: 'DARAJA_TRANS_ID_MALFORMED',
  TRANS_TIME_MALFORMED: 'DARAJA_TRANS_TIME_MALFORMED',
  AMOUNT_REQUIRED: 'DARAJA_AMOUNT_REQUIRED',
  AMOUNT_MALFORMED: 'DARAJA_AMOUNT_MALFORMED',
  SHORT_CODE_MALFORMED: 'DARAJA_SHORT_CODE_MALFORMED',
  MSISDN_MALFORMED: 'DARAJA_MSISDN_MALFORMED',
  BILL_REF_MALFORMED: 'DARAJA_BILL_REF_MALFORMED',
  CHECKOUT_REQUEST_ID_REQUIRED: 'DARAJA_CHECKOUT_REQUEST_ID_REQUIRED',
  CHECKOUT_REQUEST_ID_MALFORMED: 'DARAJA_CHECKOUT_REQUEST_ID_MALFORMED',
  RESULT_CODE_INVALID: 'DARAJA_RESULT_CODE_INVALID',
  STK_METADATA_MALFORMED: 'DARAJA_STK_METADATA_MALFORMED',
  STK_AMOUNT_UNKNOWN: 'DARAJA_STK_AMOUNT_UNKNOWN',
  B2C_RESULT_MALFORMED: 'DARAJA_B2C_RESULT_MALFORMED',
  DELIVERY_INVALID: 'DARAJA_DELIVERY_INVALID',
  SEED_INVALID: 'DARAJA_SEED_INVALID',
  CLOCK_INVALID: 'DARAJA_CLOCK_INVALID',
  TIMEOUT_POLICY_INVALID: 'DARAJA_TIMEOUT_POLICY_INVALID',
  SCENARIO_INVALID: 'DARAJA_SCENARIO_INVALID',
  SCENARIO_CHECK_UNKNOWN: 'DARAJA_SCENARIO_CHECK_UNKNOWN',
} as const;

export type DarajaErrorCode = (typeof DARAJA_ERRORS)[keyof typeof DARAJA_ERRORS];
