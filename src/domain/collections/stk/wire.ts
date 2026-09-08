/**
 * The STK-push wire port + the result-callback boundary (RICE #2).
 *
 * The DOMAIN owns the port; the ADAPTER owns the wire. Safaricom Daraja's
 * M-Pesa Express client (the Go team's lane) implements `StkPushWire` at the
 * edge and translates the raw `stkCallback` JSON through the existing
 * conformance layer (`src/adapters/daraja/wire.ts` — `parseDarajaCallback`)
 * before handing this lane a validated `StkPushResultCallback`. The lane
 * never performs I/O, never sees the transport, and mirrors the conformance
 * fixtures' semantics (ResultCode 0 = success with CallbackMetadata;
 * non-zero = cancelled/timeout/failed with NO amount).
 *
 * Idempotency (R9) lives in two deterministic keys:
 *
 *   - `stkpush:<actionId>`          — the INITIATION key. Retrying a push
 *     (transport timeout, deploy crash) reuses it so the wire can collapse
 *     duplicates into one prompt;
 *   - `daraja:stk:<checkoutRequestId>` — the PAYMENT journey key. It matches
 *     the existing Daraja conformance convention exactly
 *     (`src/adapters/daraja/wire.ts` builds the same key), so a callback that
 *     traveled through the real parser and one built here land on the SAME
 *     payment through `intakePayment`.
 *
 * Pure: no I/O, no clock, no RNG. The port is synchronous-pure in the domain
 * core (the comms-lane `MessagingProvider` precedent): adapters wrap their
 * async I/O and surface the outcome through this same value shape.
 */
import { DomainError } from '../../shared';

// --- the initiation port -------------------------------------------------------------

/** One STK push initiation command — exactly what the rail needs, nothing more. */
export interface StkPushInitiationCommand {
  readonly actionId: string;
  readonly orgId: string;
  readonly customerId: string;
  /** KES minor units — integer (R10). Never a float, never a decimal string. */
  readonly amountMinor: bigint;
  /**
   * Payer MSISDN in Daraja wire form: `2547XXXXXXXX` / `2541XXXXXXXX`
   * (the normalized E.164 value with the `+` stripped — see `toDarajaMsisdn`).
   */
  readonly msisdn: string;
  /** Account reference the customer sees on the prompt (invoice/receivable ref). */
  readonly accountReference: string;
  readonly transactionDesc: string;
  /** R9 — retry-safe initiation key: `stkpush:<actionId>`. */
  readonly idempotencyKey: string;
}

export type StkPushInitiationOutcome =
  | {
      readonly status: 'accepted';
      readonly merchantRequestId: string;
      readonly checkoutRequestId: string;
      /** Human-facing confirmation the rail returned, when it does. */
      readonly customerMessage: string | null;
    }
  | {
      readonly status: 'rejected';
      /** Machine-readable rejection from the rail/adapter. */
      readonly failureReason: string;
    };

/**
 * The wire port. INJECTED — the domain core never imports a transport. The
 * Go Daraja client ships the production adapter; tests use the deterministic
 * fake (`fakeStkWire` in the specs). Adapters must be at-least-once safe:
 * the command carries the R9 initiation key for exactly that.
 */
export interface StkPushWire {
  /** Adapter identity (audit/diagnostics only). */
  readonly name: string;
  initiate(cmd: StkPushInitiationCommand): StkPushInitiationOutcome;
}

// --- the result callback (post-conformance, validated) --------------------------------

/**
 * The merchant-relevant slice of an STK result callback, AFTER the daraja
 * conformance layer has validated the raw payload. Mirrors the fixtures:
 * success (ResultCode 0) carries the metadata evidence; failure carries none
 * — the merchant's initiation record is what says what was asked for (E11).
 */
export interface StkPushResultCallbackInput {
  readonly checkoutRequestId: string;
  readonly merchantRequestId: string;
  /** Daraja ResultCode: 0 success; 1/1032 user-cancel; 2/1037 timeout; else failed. */
  readonly resultCode: number;
  readonly resultDesc: string;
  /** MpesaReceiptNumber — success only. */
  readonly receiptNumber?: string;
  /** CallbackMetadata Amount in minor units — success only (evidence). */
  readonly paidMinor?: bigint | number;
  /** Payer MSISDN in Daraja wire form, when the metadata carried it. */
  readonly msisdn?: string;
}

export interface StkPushResultCallback {
  readonly checkoutRequestId: string;
  readonly merchantRequestId: string;
  readonly resultCode: number;
  readonly resultDesc: string;
  /** Derived, never trusted: `resultCode === 0`. */
  readonly success: boolean;
  readonly receiptNumber?: string;
  readonly paidMinor?: bigint;
  readonly msisdn?: string;
}

/** Daraja CheckoutRequestID: 'ws_CO_' + alphanumerics (conformance mirror). */
const CHECKOUT_ID_PATTERN = /^ws_CO_[A-Za-z0-9]{6,24}$/;
/** Daraja transaction ids / M-Pesa receipts: uppercase [A-Z0-9], 10–22 chars. */
const TRANS_ID_PATTERN = /^[A-Z0-9]{10,22}$/;
/** Payer MSISDN in Daraja wire form (conformance mirror). */
const MSISDN_PATTERN = /^254[17]\d{8}$/;

const requireNonBlank = (raw: unknown, field: string): string => {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DomainError('STK_CALLBACK_INVALID', `${field} is required (non-blank)`);
  }
  return raw.trim();
};

/**
 * Validate one result callback at the lane boundary. `success` is DERIVED
 * from the result code, never accepted as a flag (K1: less trusted input).
 * Anything less than fully valid throws STK_CALLBACK_INVALID so the
 * transport dead-letters it — the lane never invents state from junk.
 */
export const assertStkResultCallback = (raw: StkPushResultCallbackInput): StkPushResultCallback => {
  if (raw === null || typeof raw !== 'object') {
    throw new DomainError('STK_CALLBACK_INVALID', 'callback must be an object');
  }
  const checkoutRequestId = requireNonBlank(raw.checkoutRequestId, 'checkoutRequestId');
  if (!CHECKOUT_ID_PATTERN.test(checkoutRequestId)) {
    throw new DomainError(
      'STK_CALLBACK_INVALID',
      `checkoutRequestId "${checkoutRequestId}" must match ws_CO_<alphanumerics>`,
      { value: checkoutRequestId },
    );
  }
  const merchantRequestId = requireNonBlank(raw.merchantRequestId, 'merchantRequestId');
  const resultDesc = requireNonBlank(raw.resultDesc, 'resultDesc');
  if (typeof raw.resultCode !== 'number' || !Number.isSafeInteger(raw.resultCode) || raw.resultCode < 0) {
    throw new DomainError(
      'STK_CALLBACK_INVALID',
      `resultCode ${String(raw.resultCode)} must be a non-negative safe integer`,
      { value: String(raw.resultCode) },
    );
  }
  const success = raw.resultCode === 0;

  let receiptNumber: string | undefined;
  if (raw.receiptNumber !== undefined) {
    const receipt = requireNonBlank(raw.receiptNumber, 'receiptNumber');
    if (!TRANS_ID_PATTERN.test(receipt)) {
      throw new DomainError(
        'STK_CALLBACK_INVALID',
        `receiptNumber "${receipt}" must be uppercase [A-Z0-9] (10–22 chars)`,
        { value: receipt },
      );
    }
    receiptNumber = receipt;
  }

  let paidMinor: bigint | undefined;
  if (raw.paidMinor !== undefined) {
    const { value, ok } = (() => {
      if (typeof raw.paidMinor === 'bigint') return { value: raw.paidMinor, ok: raw.paidMinor > 0n };
      if (typeof raw.paidMinor === 'number' && Number.isSafeInteger(raw.paidMinor) && raw.paidMinor > 0) {
        return { value: BigInt(raw.paidMinor), ok: true };
      }
      return { value: 0n, ok: false };
    })();
    if (!ok) {
      throw new DomainError(
        'STK_CALLBACK_INVALID',
        `paidMinor ${String(raw.paidMinor)} must be a positive integer (minor units, R10)`,
      );
    }
    paidMinor = value;
  }

  let msisdn: string | undefined;
  if (raw.msisdn !== undefined) {
    const value = requireNonBlank(raw.msisdn, 'msisdn');
    if (!MSISDN_PATTERN.test(value)) {
      throw new DomainError(
        'STK_CALLBACK_INVALID',
        `msisdn "${value}" must be a Safaricom number in 2547XXXXXXXX / 2541XXXXXXXX form`,
        { value },
      );
    }
    msisdn = value;
  }

  if (success) {
    if (paidMinor === undefined) {
      throw new DomainError(
        'STK_CALLBACK_INVALID',
        'a successful STK result carries the CallbackMetadata Amount (paidMinor)',
      );
    }
    if (receiptNumber === undefined) {
      throw new DomainError(
        'STK_CALLBACK_INVALID',
        'a successful STK result carries an MpesaReceiptNumber',
      );
    }
  }

  return {
    checkoutRequestId,
    merchantRequestId,
    resultCode: raw.resultCode,
    resultDesc,
    success,
    ...(receiptNumber !== undefined ? { receiptNumber } : {}),
    ...(paidMinor !== undefined ? { paidMinor } : {}),
    ...(msisdn !== undefined ? { msisdn } : {}),
  };
};

// --- deterministic key + encoding helpers ---------------------------------------------

/** R9 initiation key — retrying the same action collapses onto one prompt. */
export const initiationIdempotencyKey = (actionId: string): string => `stkpush:${actionId}`;

/**
 * R9 payment journey key — byte-identical to the existing Daraja conformance
 * convention (`src/adapters/daraja/wire.ts`), so a callback that entered
 * through the real parser and one delivered through this lane's boundary
 * reconcile onto the SAME payment in `intakePayment`.
 */
export const paymentIdempotencyKey = (checkoutRequestId: string): string =>
  `daraja:stk:${checkoutRequestId}`;

/**
 * Normalized E.164 (+254…) → Daraja wire form (254…). Stripping the `+` is a
 * wire-encoding step, NOT normalization — the 07/254 handling itself is
 * reused from the ussd lane (`normalizeMsisdn`); this only re-encodes its
 * output for the rail and refuses anything that is not a Safaricom MSISDN.
 */
export const toDarajaMsisdn = (normalized: string): string => {
  const wire = normalized.startsWith('+') ? normalized.slice(1) : normalized;
  if (!MSISDN_PATTERN.test(wire)) {
    throw new DomainError(
      'STK_MSISDN_INVALID',
      `msisdn "${normalized}" does not encode to Daraja wire form 2547XXXXXXXX / 2541XXXXXXXX`,
      { value: normalized },
    );
  }
  return wire;
};

// --- the deterministic test double -------------------------------------------------------

export interface SimulatedStkWire extends StkPushWire {
  /** Every dispatched command, in order — lets tests assert the wire. */
  readonly dispatched: readonly StkPushInitiationCommand[];
}

/**
 * Deterministic simulator for the injected port (the `simulatedProvider`
 * precedent in the comms lane): outcomes are consumed from the injected
 * script in order, over-dispatching throws STK_WIRE_SCRIPT_EXHAUSTED so
 * fixture bugs surface. The rail echo mirrors the daraja STK conformance
 * fixtures — `ws_CO_<digits>` checkout ids, `58234-<digits>-1` merchant ids
 * — and is fully deterministic (counter-derived, never random). NO network.
 */
export const simulatedStkWire = (
  script: readonly StkPushInitiationOutcome[],
  name = 'simulated-daraja',
): SimulatedStkWire => {
  if (script.length === 0) {
    throw new DomainError('STK_WIRE_SCRIPT_EMPTY', 'simulated wire needs at least one outcome');
  }
  const dispatched: StkPushInitiationCommand[] = [];
  let dispatchCount = 0;
  return {
    name,
    get dispatched() {
      return dispatched;
    },
    initiate(cmd: StkPushInitiationCommand): StkPushInitiationOutcome {
      const outcome = script[dispatchCount];
      if (outcome === undefined) {
        throw new DomainError(
          'STK_WIRE_SCRIPT_EXHAUSTED',
          `simulated wire script has ${script.length} outcome(s) but initiation #${dispatchCount + 1} was requested`,
          { scriptLength: script.length, dispatchNo: dispatchCount + 1 },
        );
      }
      dispatchCount += 1;
      dispatched.push(cmd);
      if (outcome.status === 'accepted') {
        // Deterministic echo in the conformance-fixture shape.
        const n = dispatchCount;
        return {
          status: 'accepted',
          merchantRequestId: `58234-1194${String(10000 + n)}-1`,
          checkoutRequestId: `ws_CO_1209202514${String(100000 + n)}`,
          customerMessage: 'A payment request has been sent to the customer',
        };
      }
      return outcome;
    },
  };
};
