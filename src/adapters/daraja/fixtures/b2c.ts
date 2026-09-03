/**
 * B2C (payout) result fixtures (F15) — the OUTFLOW shape.
 *
 * B2C results are evidence that money LEFT the merchant account (refunds and
 * payouts live in the adjustments/ledger lanes). They are parsed for evidence
 * but deliberately carry NO intake command — treating one as an inflow would
 * invent money. The simulator records them as `observed` and the conformance
 * suite proves they never create a Payment.
 */
import type { DarajaB2cPayload } from '../wire';
import type { DarajaFixture } from './fixture';

const PAYOUT_SUCCESS: DarajaB2cPayload = {
  ResultType: 0,
  ResultCode: 0,
  ResultDesc: 'The service request is processed successfully.',
  OriginatorConversationID: '58234-7714364-1',
  ConversationID: 'AG_12092025143_119403721',
  TransactionID: 'RKT81KZ9QF',
  ResultParameters: {
    ResultParameter: [
      { Name: 'TransactionAmount', Value: 1500 },
      { Name: 'TransactionReceipt', Value: 'RKT81KZ9QF' },
      { Name: 'ReceiverPartyPublicName', Value: '254712345678 - Jane Doe Test' }, // synthetic
      { Name: 'TransactionCompletedDateTime', Value: '12.09.2025 14:31:05' },
    ],
  },
};

const PAYOUT_FAILED: DarajaB2cPayload = {
  ResultType: 0,
  ResultCode: 2001,
  ResultDesc: 'Invalid initiator name or password',
  OriginatorConversationID: '58240-7714999-2',
  ConversationID: 'AG_12092025144_119404992',
  TransactionID: 'RKT95GH2PV',
};

export const B2C_FIXTURES: readonly DarajaFixture[] = [
  {
    id: 'b2c.payout-success',
    family: 'b2c-result',
    note: 'B2C payout completed — KES 1500.00 left the account (outflow evidence)',
    payload: PAYOUT_SUCCESS,
  },
  {
    id: 'b2c.payout-failed',
    family: 'b2c-result',
    note: 'B2C payout rejected — invalid initiator, no money moved',
    payload: PAYOUT_FAILED,
  },
] as const;
