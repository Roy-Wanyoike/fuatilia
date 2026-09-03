/**
 * Daraja wire types + the K1 untrusted-input boundary (issue #25, F15).
 *
 * Everything in this file models what the Safaricom Daraja gateway actually
 * sends: JSON with string decimal amounts, YYYYMMDDHHmmss Kenyan-local (EAT,
 * UTC+3) timestamps and uppercase alphanumeric transaction ids. Channel input
 * is UNTRUSTED (review finding K1) — `parseDarajaCallback` is the only door
 * from the wire into the domain, it validates every money-relevant field, and
 * it never invents state: anything it cannot fully validate is rejected with a
 * stable `DARAJA_*` code so the transport can dead-letter it (SPEC §14).
 *
 * Pure: no I/O, no clock, no RNG. The parsed result is a typed callback whose
 * C2B/STK variants carry a ready-to-run `IntakeCommand` for the payments lane;
 * the B2C variant deliberately carries NO command — B2C results are OUTFLOWS
 * (payouts/refunds live in the adjustments/ledger lanes), and treating one as
 * an inflow would invent money.
 */
import { DomainError, Money } from '../../domain/shared';
import type { IntakeCommand } from '../../domain/payments';
import { DARAJA_ERRORS } from './codes';

/** The four callback families Daraja delivers, plus `malformed` for fixtures. */
export type DarajaCallbackKind =
  | 'c2b-validation'
  | 'c2b-confirmation'
  | 'stk-result'
  | 'b2c-result';

/** Which Daraja endpoint delivered a C2B notification (the wire shapes match). */
export type DarajaC2bEndpointKind = 'c2b-validation' | 'c2b-confirmation';

/**
 * C2B validation/confirmation notification (Pay Bill / Buy Goods).
 * Amounts are decimal STRINGS on the wire; TransTime is Kenyan local time.
 * Subscriber names are deliberately not modelled — fixtures carry no PII.
 */
export interface DarajaC2bPayload {
  readonly TransactionType: string; // 'Pay Bill' | 'Buy Goods'
  readonly TransID: string; // uppercase [A-Z0-9], 10 chars in production
  readonly TransTime: string; // 'YYYYMMDDHHmmss' (EAT, UTC+3)
  readonly TransAmount: string; // decimal string, e.g. '2500.00'
  readonly BusinessShortCode: string; // 5–7 digit paybill/till
  readonly BillRefNumber: string; // the account reference the payer typed
  readonly OrgAccountBalance: string; // decimal string
  readonly MSISDN: string; // payer phone, '2547XXXXXXXX' / '2541XXXXXXXX'
  readonly InvoiceNumber?: string; // optional, often empty
  readonly ThirdPartyTransID?: string;
}

/** One `CallbackMetadata.Item` entry. `Value` is absent for e.g. Balance. */
export interface DarajaStkMetadataItem {
  readonly Name: string;
  readonly Value?: string | number;
}

/** STK push (M-Pesa Express / Lipa na M-Pesa Online) result callback. */
export interface DarajaStkPayload {
  readonly Body: {
    readonly stkCallback: {
      readonly MerchantRequestID: string; // '29115-34620561-1'
      readonly CheckoutRequestID: string; // 'ws_CO_19122019102036805'
      readonly ResultCode: number; // 0 success; 1 user-cancel; 2 timeout/error; + edge codes
      readonly ResultDesc: string;
      readonly CallbackMetadata?: {
        readonly Item: readonly DarajaStkMetadataItem[];
      };
    };
  };
}

/** B2C (payout) result callback — an OUTFLOW shape, never an inflow payment. */
export interface DarajaB2cPayload {
  readonly ResultType: number; // 0 for B2C results
  readonly ResultCode: number; // 0 success; non-zero failure
  readonly ResultDesc: string;
  readonly OriginatorConversationID: string;
  readonly ConversationID: string;
  readonly TransactionID: string; // uppercase [A-Z0-9], 10 chars in production
  readonly ResultParameters?: {
    readonly ResultParameter: readonly DarajaStkMetadataItem[];
  }; // absent on failed payouts — no money moved
}

/**
 * Merchant-side record of an STK push INITIATION (the trusted internal echo of
 * the E11 `payment.initiated` fact). Daraja failure results carry no amount, so
 * the adapter needs the merchant's own record of what it asked for.
 */
export interface StkInitiationRecord {
  readonly checkoutRequestId: string;
  readonly requestedMinor: bigint | number;
}

export interface ParseOptions {
  /** Which endpoint delivered a C2B notification (required for C2B payloads). */
  readonly c2bKind?: DarajaC2bEndpointKind;
  /** Merchant-side STK initiation records, keyed by CheckoutRequestID. */
  readonly stkRequested?: ReadonlyMap<string, StkInitiationRecord>;
}

export interface ParsedC2bCallback {
  readonly kind: DarajaC2bEndpointKind;
  readonly journeyKey: string;
  readonly command: IntakeCommand;
  readonly transId: string;
  readonly transTime: Date; // decoded from TransTime (EAT)
  readonly businessShortCode: string;
  readonly billRefNumber: string; // '' when absent (Buy Goods tills)
  readonly msisdn: string;
  readonly amountMinor: bigint;
}

export interface ParsedStkCallback {
  readonly kind: 'stk-result';
  readonly journeyKey: string;
  readonly command: IntakeCommand;
  readonly checkoutRequestId: string;
  readonly merchantRequestId: string;
  readonly resultCode: number;
  readonly success: boolean;
  readonly receiptNumber?: string; // MpesaReceiptNumber (success only)
  readonly paidMinor?: bigint; // CallbackMetadata Amount (success only)
  readonly transTime?: Date; // CallbackMetadata TransactionDate (success only)
  readonly msisdn?: string;
  readonly amountMinor: bigint; // the intake amount that backs `command`
}

export interface ParsedB2cResult {
  readonly kind: 'b2c-result';
  readonly journeyKey: string;
  readonly transactionId: string;
  readonly conversationId: string;
  readonly originatorConversationId: string;
  readonly resultCode: number;
  readonly success: boolean;
  readonly amountMinor?: bigint; // TransactionAmount, evidence only — NO command
}

export type ParsedCallback = ParsedC2bCallback | ParsedStkCallback | ParsedB2cResult;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/**
 * Safaricom transaction ids: uppercase [A-Z0-9]. Production C2B TransIDs and
 * M-Pesa receipt numbers are 10 chars (e.g. 'SBK41XQ7RT'); the long 22-char
 * 'SBK…' shape is accepted too (dispatcher-specified fixture form).
 */
const TRANS_ID_PATTERN = /^[A-Z0-9]{10,22}$/;
/** CheckoutRequestID: 'ws_CO_' + alphanumerics (17 digits in production). */
const CHECKOUT_ID_PATTERN = /^ws_CO_[A-Za-z0-9]{6,24}$/;
/** Paybill/till short codes: 5–7 digits. */
const SHORT_CODE_PATTERN = /^\d{5,7}$/;
/** Safaricom MSISDNs in international form: 254 7XX… / 254 1XX… (12 digits). */
const MSISDN_PATTERN = /^254[17]\d{8}$/;
/** Decimal money with at most 2 minor places — never floats, never 3+dp. */
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
/** Daraja timestamps: YYYYMMDDHHmmss. */
const TRANS_TIME_PATTERN = /^\d{14}$/;

/** Kenyan local time = EAT = UTC+3; Daraja reports TransTime in EAT. */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Exact wire-amount → minor units. Strings are the canonical wire form;
 * JSON numbers (STK metadata) are converted through their shortest
 * round-trip string so `1500.5` becomes exactly 150050 minor units and
 * `0.30000000000000004`-style junk is rejected, never rounded (R10).
 */
export const minorFromWireAmount = (raw: string | number): bigint => {
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    throw new DomainError(DARAJA_ERRORS.AMOUNT_MALFORMED, `wire amount ${String(raw)} is not finite`);
  }
  const text = (typeof raw === 'number' ? String(raw) : raw).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new DomainError(
      DARAJA_ERRORS.AMOUNT_MALFORMED,
      `wire amount "${text}" is not a decimal with at most 2 minor places`,
      { value: text },
    );
  }
  const whole = BigInt(match[1]!);
  const frac = (match[2] ?? '').padEnd(2, '0');
  return whole * 100n + BigInt(frac === '' ? '0' : frac);
};

/** 'YYYYMMDDHHmmss' (EAT) → Date. Calendar-invalid fields are rejected. */
export const transTimeToDate = (raw: string): Date => {
  if (!TRANS_TIME_PATTERN.test(raw)) {
    throw new DomainError(
      DARAJA_ERRORS.TRANS_TIME_MALFORMED,
      `TransTime "${raw}" must be YYYYMMDDHHmmss (EAT)`,
      { value: raw },
    );
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  const hour = Number(raw.slice(8, 10));
  const minute = Number(raw.slice(10, 12));
  const second = Number(raw.slice(12, 14));
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new DomainError(
      DARAJA_ERRORS.TRANS_TIME_MALFORMED,
      `TransTime "${raw}" has an out-of-range field`,
      { value: raw },
    );
  }
  // The wire fields are EAT wall-clock fields; encode them as UTC fields and
  // verify Date did not silently roll any component over (Feb 30 → Mar 2,
  // Apr 31 → May 1) — the K1 boundary never rewrites when money moved.
  const encoded = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const rolled =
    encoded.getUTCFullYear() !== year ||
    encoded.getUTCMonth() !== month - 1 ||
    encoded.getUTCDate() !== day ||
    encoded.getUTCHours() !== hour ||
    encoded.getUTCMinutes() !== minute ||
    encoded.getUTCSeconds() !== second;
  if (rolled) {
    throw new DomainError(
      DARAJA_ERRORS.TRANS_TIME_MALFORMED,
      `TransTime "${raw}" is not a real calendar instant`,
      { value: raw },
    );
  }
  return new Date(encoded.getTime() - EAT_OFFSET_MS);
};

const assertTransId = (raw: unknown, field: string): string => {
  const value = nonEmptyString(raw);
  if (value === undefined) {
    throw new DomainError(DARAJA_ERRORS.TRANS_ID_REQUIRED, `${field} is required`);
  }
  const trimmed = value.trim();
  if (!TRANS_ID_PATTERN.test(trimmed)) {
    throw new DomainError(
      DARAJA_ERRORS.TRANS_ID_MALFORMED,
      `${field} "${trimmed}" must be uppercase [A-Z0-9] (10–22 chars)`,
      { field, value: trimmed },
    );
  }
  return trimmed;
};

const assertMsisdn = (raw: unknown): string => {
  const value = nonEmptyString(raw);
  if (value === undefined || !MSISDN_PATTERN.test(value.trim())) {
    throw new DomainError(
      DARAJA_ERRORS.MSISDN_MALFORMED,
      `MSISDN "${String(value)}" must be a Safaricom number in 2547XXXXXXXX / 2541XXXXXXXX form`,
      { value: String(value) },
    );
  }
  return value.trim();
};

const assertResultCode = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new DomainError(
      DARAJA_ERRORS.RESULT_CODE_INVALID,
      `ResultCode ${String(raw)} must be a non-negative integer`,
      { value: String(raw) },
    );
  }
  return raw;
};

/**
 * BillRefNumber normalization: the account reference a payer typed at the
 * paybill prompt is free text — trim it and split on the separators Kenyan
 * payers actually use ('/', ',') so one transfer can declare several invoice
 * refs. Empty pieces are dropped; the result feeds `declaredRefs`.
 */
export const billRefToDeclaredRefs = (raw: string): readonly string[] =>
  raw
    .split(/[/,]/)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');

/**
 * Duck-type the payload family from its shape. Malformed payloads that match
 * no family are 'unrecognized' (dead-lettered by the transport).
 */
export const classifyDarajaPayload = (
  payload: unknown,
): 'c2b' | 'stk' | 'b2c' | 'unrecognized' => {
  if (!isRecord(payload)) return 'unrecognized';
  const body = payload['Body'];
  if (isRecord(body) && isRecord(body['stkCallback'])) return 'stk';
  if (payload['ConversationID'] !== undefined && payload['ResultType'] !== undefined) return 'b2c';
  if (
    payload['TransID'] !== undefined ||
    payload['TransAmount'] !== undefined ||
    payload['TransTime'] !== undefined
  ) {
    return 'c2b';
  }
  return 'unrecognized';
};

const parseC2b = (payload: Record<string, unknown>, kind: DarajaC2bEndpointKind): ParsedC2bCallback => {
  const transId = assertTransId(payload['TransID'], 'TransID');

  const transTimeRaw = nonEmptyString(payload['TransTime']);
  if (transTimeRaw === undefined) {
    throw new DomainError(DARAJA_ERRORS.TRANS_TIME_MALFORMED, 'TransTime is required');
  }
  const transTime = transTimeToDate(transTimeRaw);

  const amountRaw = payload['TransAmount'];
  if (amountRaw === undefined || amountRaw === null || amountRaw === '') {
    throw new DomainError(DARAJA_ERRORS.AMOUNT_REQUIRED, 'TransAmount is required');
  }
  if (typeof amountRaw !== 'string' && typeof amountRaw !== 'number') {
    throw new DomainError(DARAJA_ERRORS.AMOUNT_MALFORMED, 'TransAmount must be a decimal string or number');
  }
  const amountMinor = minorFromWireAmount(amountRaw);

  const shortCode = nonEmptyString(payload['BusinessShortCode']);
  if (shortCode === undefined || !SHORT_CODE_PATTERN.test(shortCode.trim())) {
    throw new DomainError(
      DARAJA_ERRORS.SHORT_CODE_MALFORMED,
      `BusinessShortCode "${String(payload['BusinessShortCode'])}" must be 5–7 digits`,
    );
  }

  const msisdn = assertMsisdn(payload['MSISDN']);

  const billRefRaw = payload['BillRefNumber'];
  if (billRefRaw !== undefined && typeof billRefRaw !== 'string' && typeof billRefRaw !== 'number') {
    throw new DomainError(DARAJA_ERRORS.BILL_REF_MALFORMED, 'BillRefNumber must be a string or number');
  }
  const billRefNumber = billRefRaw === undefined || billRefRaw === null ? '' : String(billRefRaw).trim();

  const declaredRefs: string[] = [...billRefToDeclaredRefs(billRefNumber)];
  const invoiceNumber = nonEmptyString(payload['InvoiceNumber']);
  if (invoiceNumber !== undefined) {
    const ref = invoiceNumber.trim();
    if (!declaredRefs.includes(ref)) declaredRefs.push(ref);
  }

  const orgBalance = payload['OrgAccountBalance'];
  if (orgBalance !== undefined && orgBalance !== null && orgBalance !== '') {
    if (typeof orgBalance !== 'string' && typeof orgBalance !== 'number') {
      throw new DomainError(DARAJA_ERRORS.AMOUNT_MALFORMED, 'OrgAccountBalance must be a decimal');
    }
    minorFromWireAmount(orgBalance); // validate only — evidence, not intake money
  }

  return {
    kind,
    journeyKey: `c2b:${transId}`,
    transId,
    transTime,
    businessShortCode: shortCode.trim(),
    billRefNumber,
    msisdn,
    amountMinor,
    command: {
      channel: 'c2b',
      externalRef: transId,
      idempotencyKey: `daraja:c2b:${transId}`,
      amount: Money.ofMinor(amountMinor, 'KES'),
      declaredRefs,
    },
  };
};

const metadataItemsToMap = (items: readonly DarajaStkMetadataItem[]): Map<string, string | number> => {
  const map = new Map<string, string | number>();
  for (const item of items) {
    // isRecord rejects arrays and nulls too — a Name/Value pair is the only
    // accepted shape (K1: anything looser lets wire junk into money fields).
    if (!isRecord(item)) {
      throw new DomainError(DARAJA_ERRORS.STK_METADATA_MALFORMED, 'CallbackMetadata items must be objects');
    }
    const name = item['Name'];
    const value = item['Value'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new DomainError(DARAJA_ERRORS.STK_METADATA_MALFORMED, 'every metadata item needs a Name');
    }
    if (value !== undefined) map.set(name, value);
  }
  return map;
};

const parseStk = (
  payload: Record<string, unknown>,
  stkRequested: ReadonlyMap<string, StkInitiationRecord>,
): ParsedStkCallback => {
  const callback = (payload['Body'] as Record<string, unknown>)['stkCallback'];
  if (!isRecord(callback)) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'Body.stkCallback must be an object');
  }

  const merchantRequestId = nonEmptyString(callback['MerchantRequestID']);
  if (merchantRequestId === undefined) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'MerchantRequestID is required');
  }

  const checkoutRaw = nonEmptyString(callback['CheckoutRequestID']);
  if (checkoutRaw === undefined) {
    throw new DomainError(DARAJA_ERRORS.CHECKOUT_REQUEST_ID_REQUIRED, 'CheckoutRequestID is required');
  }
  const checkoutRequestId = checkoutRaw.trim();
  if (!CHECKOUT_ID_PATTERN.test(checkoutRequestId)) {
    throw new DomainError(
      DARAJA_ERRORS.CHECKOUT_REQUEST_ID_MALFORMED,
      `CheckoutRequestID "${checkoutRequestId}" must match ws_CO_<alphanumerics>`,
      { value: checkoutRequestId },
    );
  }

  const resultCode = assertResultCode(callback['ResultCode']);
  if (nonEmptyString(callback['ResultDesc']) === undefined) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'ResultDesc is required');
  }
  const success = resultCode === 0;

  let paidMinor: bigint | undefined;
  let receiptNumber: string | undefined;
  let transTime: Date | undefined;
  let msisdn: string | undefined;

  const metadata = callback['CallbackMetadata'];
  if (metadata !== undefined) {
    if (
      !isRecord(metadata) ||
      !Array.isArray((metadata as { Item?: unknown })['Item'])
    ) {
      throw new DomainError(DARAJA_ERRORS.STK_METADATA_MALFORMED, 'CallbackMetadata.Item must be an array');
    }
    const items = metadataItemsToMap((metadata as { Item: readonly DarajaStkMetadataItem[] })['Item']);
    if (success) {
      const amount = items.get('Amount');
      if (amount === undefined) {
        throw new DomainError(DARAJA_ERRORS.STK_METADATA_MALFORMED, 'a successful STK result carries an Amount item');
      }
      if (typeof amount !== 'number' && typeof amount !== 'string') {
        throw new DomainError(DARAJA_ERRORS.STK_METADATA_MALFORMED, 'metadata Amount must be a number or string');
      }
      paidMinor = minorFromWireAmount(amount);
      const receipt = items.get('MpesaReceiptNumber');
      if (receipt === undefined || !TRANS_ID_PATTERN.test(String(receipt))) {
        throw new DomainError(
          DARAJA_ERRORS.STK_METADATA_MALFORMED,
          'a successful STK result carries an MpesaReceiptNumber (uppercase [A-Z0-9], 10–22 chars)',
        );
      }
      receiptNumber = String(receipt);
      const when = items.get('TransactionDate');
      if (when !== undefined) transTime = transTimeToDate(String(when));
      const phone = items.get('PhoneNumber');
      if (phone !== undefined) msisdn = assertMsisdn(String(phone));
    }
  } else if (success) {
    throw new DomainError(
      DARAJA_ERRORS.STK_METADATA_MALFORMED,
      'a successful STK result must carry CallbackMetadata',
    );
  }

  // Intake amount: the merchant's own initiation record (E11) when known —
  // failure results carry NO amount on the wire — else the paid amount.
  const initiation = stkRequested.get(checkoutRequestId);
  const intakeMinor =
    initiation !== undefined
      ? BigInt(initiation.requestedMinor)
      : (paidMinor ?? (() => {
          throw new DomainError(
            DARAJA_ERRORS.STK_AMOUNT_UNKNOWN,
            `no initiation record and no callback amount for ${checkoutRequestId} — the merchant must know what it asked for (E11)`,
            { checkoutRequestId },
          );
        })());

  return {
    kind: 'stk-result',
    journeyKey: `stk:${checkoutRequestId}`,
    checkoutRequestId,
    merchantRequestId,
    resultCode,
    success,
    receiptNumber,
    paidMinor,
    transTime,
    msisdn,
    amountMinor: intakeMinor,
    command: {
      channel: 'stk',
      externalRef: receiptNumber ?? checkoutRequestId,
      idempotencyKey: `daraja:stk:${checkoutRequestId}`,
      amount: Money.ofMinor(intakeMinor, 'KES'),
      declaredRefs: [], // the STK result callback carries no account reference
    },
  };
};

const parseB2c = (payload: Record<string, unknown>): ParsedB2cResult => {
  if (payload['ResultType'] !== 0) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'B2C results carry ResultType 0');
  }
  if (nonEmptyString(payload['ResultDesc']) === undefined) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'ResultDesc is required');
  }
  const conversationId = nonEmptyString(payload['ConversationID']);
  const originatorConversationId = nonEmptyString(payload['OriginatorConversationID']);
  if (conversationId === undefined || originatorConversationId === undefined) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'B2C results carry both conversation ids');
  }

  const transactionId = assertTransId(payload['TransactionID'], 'TransactionID');
  const resultCode = assertResultCode(payload['ResultCode']);

  const parameters = payload['ResultParameters'];
  let amountMinor: bigint | undefined;
  if (parameters !== undefined) {
    const isShaped =
      isRecord(parameters) && Array.isArray((parameters as { ResultParameter?: unknown })['ResultParameter']);
    if (!isShaped) {
      throw new DomainError(DARAJA_ERRORS.B2C_RESULT_MALFORMED, 'ResultParameters.ResultParameter must be an array');
    }
    const items = metadataItemsToMap(
      (parameters as { ResultParameter: readonly DarajaStkMetadataItem[] })['ResultParameter'],
    );
    const amount = items.get('TransactionAmount');
    if (amount !== undefined) {
      if (typeof amount !== 'number' && typeof amount !== 'string') {
        throw new DomainError(DARAJA_ERRORS.B2C_RESULT_MALFORMED, 'TransactionAmount must be a number or string');
      }
      amountMinor = minorFromWireAmount(amount);
    }
  }

  return {
    kind: 'b2c-result',
    journeyKey: `b2c:${transactionId}`,
    transactionId,
    conversationId,
    originatorConversationId,
    resultCode,
    success: resultCode === 0,
    amountMinor,
  };
};

/**
 * The single door from the wire into the domain. Validates the payload family,
 * every money-relevant field, and returns a typed callback. Anything less than
 * fully valid throws a `DARAJA_*` DomainError — the transport dead-letters it,
 * it never reaches the domain (K1, SPEC §14).
 */
export const parseDarajaCallback = (payload: unknown, options: ParseOptions = {}): ParsedCallback => {
  const family = classifyDarajaPayload(payload);
  if (family === 'unrecognized') {
    throw new DomainError(
      DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED,
      'payload matches no Daraja callback family (C2B notification, STK result, B2C result)',
    );
  }
  if (!isRecord(payload)) {
    throw new DomainError(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'payload must be an object');
  }
  if (family === 'stk') return parseStk(payload, options.stkRequested ?? new Map());
  if (family === 'b2c') return parseB2c(payload);
  const c2bKind = options.c2bKind;
  if (c2bKind === undefined) {
    // The PAYLOAD is a recognized C2B notification — the CALL is broken (the
    // endpoint hint was not supplied), so this is caller misuse, not K1 junk,
    // and deliberately does not piggyback on PAYLOAD_UNRECOGNIZED.
    throw new DomainError(
      DARAJA_ERRORS.C2B_KIND_REQUIRED,
      'C2B payloads require the delivering endpoint kind (c2b-validation | c2b-confirmation)',
    );
  }
  return parseC2b(payload, c2bKind);
};
