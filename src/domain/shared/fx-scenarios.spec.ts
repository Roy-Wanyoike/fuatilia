/**
 * FX cross-currency settlement scenarios (issue #9) — the R10 story told
 * end-to-end with PLAIN DATA STRUCTURES only:
 *
 *   invoice USD  →  payment KES (via an FX snapshot)  →  realized gain/loss posted
 *
 * Everything here lives inside the shared kernel: the tiny settlement harness
 * below is the shape an allocation/receivable hook would take, but it imports
 * nothing from other lanes (only ./fx, ./money, ./errors, ./ids). Money stays
 * in integer minor units at every step; the ONLY place a rounding happens is
 * the single banker's rounding inside `convert`.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  FX_ERRORS,
  FX_REALIZED_GAIN_LOSS_EVENT,
  convert,
  fxRateSnapshot,
  postRealizedGainLoss,
  requireFxSnapshot,
} from './fx';
import type { FxRateSnapshot } from './fx';
import type { Clock, Uuid } from './ids';
import { uuid } from './ids';
import { Money } from './money';
import type { Currency } from './money';

// ---------------------------------------------------------------------------
// Plain domain structures — no lane types, no classes from other modules
// ---------------------------------------------------------------------------

interface PlainReceivable {
  readonly receivableId: Uuid;
  readonly currency: Currency;
  readonly originalMinor: bigint;
  readonly balanceMinor: bigint;
}

interface PlainPayment {
  readonly paymentId: Uuid;
  readonly currency: Currency;
  readonly confirmedMinor: bigint;
}

interface SettlementOutcome {
  readonly receivable: PlainReceivable;
  /** Amount applied to the receivable, in ITS currency (single-currency ledger math). */
  readonly appliedMinor: bigint;
  /** Funds that could not be applied (over-settlement), in the receivable's currency. */
  readonly unappliedMinor: bigint;
  /** `fx.realizedGainLossPosted` envelopes produced by the settlement. */
  readonly fxEvents: readonly unknown[];
}

const clock: Clock = { now: () => new Date('2025-09-02T09:30:00.000Z') };

const ORG_ID = uuid('5b3f1a2c-9d4e-4f6a-8b7c-1e2d3f4a5b6c');
const SNAPSHOT_ID = uuid('a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d');
const RECEIVABLE_ID = uuid('c3d4e5f6-a7b8-4c5d-8e9f-0a1b2c3d4e5f');
const PAYMENT_ID = uuid('d4e5f6a7-b8c9-4d5e-8f9a-0b1c2d3e4f5a');

/** 1 USD = 129.754 KES, quoted by CBK on 2025-09-01. */
const cbkUsdKes: FxRateSnapshot = fxRateSnapshot({
  orgId: ORG_ID,
  snapshotId: SNAPSHOT_ID,
  baseCurrency: 'USD',
  quoteCurrency: 'KES',
  numerator: 129754n,
  denominator: 1000n,
  source: 'CBK',
  observedAt: '2025-09-01T12:00:00.000Z',
});

const openReceivable = (currency: Currency, originalMinor: bigint): PlainReceivable => ({
  receivableId: RECEIVABLE_ID,
  currency,
  originalMinor,
  balanceMinor: originalMinor,
});

/**
 * The settlement hook — exactly the shape the allocation lane plugs in.
 *
 * R10 in one function: same-currency settlements never touch FX (they apply
 * with plain Money arithmetic); a cross-currency settlement is refused unless
 * it carries an FX snapshot reference, and when it proceeds, the converted
 * amount settles the receivable while the realized gain/loss is posted as a
 * typed event.
 */
const settle = (
  receivable: PlainReceivable,
  payment: PlainPayment,
  snapshot?: FxRateSnapshot | null,
): SettlementOutcome => {
  if (payment.currency === receivable.currency) {
    // Single-currency path — untouched by the FX kernel. Money arithmetic only.
    const balance = Money.ofMinor(receivable.balanceMinor, receivable.currency);
    const payment_ = Money.ofMinor(payment.confirmedMinor, payment.currency);
    const applied = payment_.compareTo(balance) > 0 ? balance : payment_;
    return {
      receivable: { ...receivable, balanceMinor: balance.subtract(applied).amount },
      appliedMinor: applied.amount,
      unappliedMinor: payment_.subtract(applied).amount,
      fxEvents: [],
    };
  }

  // Cross-currency path — R10 gate first: no snapshot reference → refused.
  requireFxSnapshot(payment.currency, receivable.currency, snapshot);

  const carrying = receivable.balanceMinor; // base-currency carrying amount of the portion being settled
  const posting = postRealizedGainLoss({
    receivableId: receivable.receivableId,
    paymentId: payment.paymentId,
    carryingAmountMinor: carrying,
    receivableCurrency: receivable.currency,
    settlementAmountMinor: payment.confirmedMinor,
    settlementCurrency: payment.currency,
    snapshot,
    clock,
  });

  // The converted settlement applies to the receivable (capped at the balance);
  // any surplus stays unapplied rather than over-setting the receivable.
  const converted = posting.settlementConvertedMinor;
  const applied = converted > carrying ? carrying : converted;
  return {
    receivable: { ...receivable, balanceMinor: carrying - applied },
    appliedMinor: applied,
    unappliedMinor: converted - applied,
    fxEvents: posting.event === null ? [] : [posting.event],
  };
};

const expectCode = (run: () => unknown, code: string): void => {
  try {
    run();
    expect.fail(`expected DomainError ${code}`);
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
  }
};

// ---------------------------------------------------------------------------
// The 3-step scenario: invoice USD → payment KES via snapshot → gain posted
// ---------------------------------------------------------------------------

describe('FX scenario — invoice USD, payment KES, realized gain posted', () => {
  it('walks the 3-step cross-currency settlement end to end', () => {
    // Step 1 — invoice issued: receivable opened in USD for $1,000.00.
    const invoice = openReceivable('USD', 100000n);
    expect(invoice.balanceMinor).toBe(100000n);

    // Step 2 — a KES payment of KES 130,000.00 arrives for the USD invoice.
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 13000000n };

    // R10: the settlement attempt WITHOUT a snapshot reference is refused…
    expectCode(() => settle(invoice, payment, null), FX_ERRORS.SNAPSHOT_REQUIRED);
    expectCode(() => settle(invoice, payment), FX_ERRORS.SNAPSHOT_REQUIRED);
    // …and the refused attempt leaves the receivable untouched (append-only world).
    expect(invoice.balanceMinor).toBe(100000n);

    // Step 3 — the settlement carries the CBK snapshot: it proceeds, converts
    // exactly (KES 130,000.00 → $1,001.90), settles the receivable and posts
    // the realized gain of $1.90.
    const outcome = settle(invoice, payment, cbkUsdKes);
    expect(outcome.receivable.balanceMinor).toBe(0n);
    expect(outcome.appliedMinor).toBe(100000n);
    expect(outcome.unappliedMinor).toBe(190n); // surplus is unapplied, never silently consumed
    expect(outcome.fxEvents).toHaveLength(1);

    const event = outcome.fxEvents[0] as {
      name: typeof FX_REALIZED_GAIN_LOSS_EVENT;
      version: 1;
      payload: { direction: string; amountMinor: bigint; snapshotId: Uuid; settlementConvertedMinor: bigint };
    };
    expect(event.name).toBe('fx.realizedGainLossPosted');
    expect(event.version).toBe(1);
    expect(event.payload.direction).toBe('gain');
    expect(event.payload.amountMinor).toBe(190n);
    expect(event.payload.settlementConvertedMinor).toBe(100190n);
    expect(event.payload.snapshotId).toBe(SNAPSHOT_ID);
  });

  it('posts a LOSS and leaves the receivable partially settled when the rate moves against us', () => {
    const invoice = openReceivable('USD', 100000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 12800000n };

    const outcome = settle(invoice, payment, cbkUsdKes);
    // KES 128,000.00 converts to $986.48 — short of the $1,000.00 carrying amount.
    expect(outcome.receivable.balanceMinor).toBe(1352n);
    expect(outcome.appliedMinor).toBe(98648n);
    expect(outcome.unappliedMinor).toBe(0n);
    expect(outcome.fxEvents).toHaveLength(1);

    const event = outcome.fxEvents[0] as { payload: { direction: string; amountMinor: bigint } };
    expect(event.payload.direction).toBe('loss');
    expect(event.payload.amountMinor).toBe(1352n);
  });

  it('posts NO gain/loss event when the settlement converts to an exact wash', () => {
    const invoice = openReceivable('USD', 100000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 12975400n };

    const outcome = settle(invoice, payment, cbkUsdKes);
    expect(outcome.receivable.balanceMinor).toBe(0n);
    expect(outcome.appliedMinor).toBe(100000n);
    expect(outcome.fxEvents).toHaveLength(0);
  });

  it('keeps every step float-free: the applied rate reference is the exact rational', () => {
    const conversion = convert(13000000n, 'KES', 'USD', cbkUsdKes, 'quote_to_base');
    expect(conversion.rate.appliedNumerator).toBe(1000n);
    expect(conversion.rate.appliedDenominator).toBe(129754n);
    expect(conversion.amountMinor).toBe(100190n);
    expect(Object.isFrozen(cbkUsdKes)).toBe(true);
    expect(Object.isFrozen(conversion)).toBe(true);
  });

  it('refuses a snapshot that does not bridge the settlement pair', () => {
    const invoice = openReceivable('USD', 100000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'TZS', confirmedMinor: 1000000n };
    expectCode(() => settle(invoice, payment, cbkUsdKes), FX_ERRORS.SNAPSHOT_PAIR_MISMATCH);
  });
});

// ---------------------------------------------------------------------------
// Single-currency paths stay untouched
// ---------------------------------------------------------------------------

describe('FX scenario — single-currency settlements never enter the FX kernel', () => {
  it('applies a KES payment to a KES receivable with plain Money arithmetic and no FX events', () => {
    const invoice = openReceivable('KES', 50000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 30000n };

    const outcome = settle(invoice, payment, cbkUsdKes);
    expect(outcome.receivable.balanceMinor).toBe(20000n);
    expect(outcome.appliedMinor).toBe(30000n);
    expect(outcome.unappliedMinor).toBe(0n);
    expect(outcome.fxEvents).toHaveLength(0);
  });

  it('parks over-payment as unapplied instead of over-settling (R2 spirit)', () => {
    const invoice = openReceivable('KES', 50000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 60000n };

    const outcome = settle(invoice, payment);
    expect(outcome.receivable.balanceMinor).toBe(0n);
    expect(outcome.unappliedMinor).toBe(10000n);
    expect(outcome.fxEvents).toHaveLength(0);
  });

  it('Money still refuses cross-currency arithmetic in the ledger (CURRENCY_MISMATCH)', () => {
    expect(() =>
      Money.ofMinor(100000n, 'USD').add(Money.ofMinor(30000n, 'KES')),
    ).toThrow(DomainError);
    try {
      Money.ofMinor(100000n, 'USD').add(Money.ofMinor(30000n, 'KES'));
      expect.fail('expected CURRENCY_MISMATCH');
    } catch (err) {
      expect((err as DomainError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

// ---------------------------------------------------------------------------
// Balance integrity across the whole cross-currency flow
// ---------------------------------------------------------------------------

describe('FX scenario — balance integrity across currencies', () => {
  it('never destroys a cent: applied + unapplied + remaining balance reconcile', () => {
    const invoice = openReceivable('USD', 100000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 13000000n };

    const outcome = settle(invoice, payment, cbkUsdKes);
    const totalUsdMinor =
      outcome.appliedMinor + outcome.unappliedMinor + outcome.receivable.balanceMinor;
    // $1,001.90 arrived as value; $1,000.00 applied, $1.90 unapplied, $0 balance.
    expect(totalUsdMinor).toBe(100190n);
    expect(outcome.receivable.balanceMinor).toBeGreaterThanOrEqual(0n);
  });

  it('is deterministic: replaying the same settlement yields the same outcome', () => {
    const invoice = openReceivable('USD', 100000n);
    const payment: PlainPayment = { paymentId: PAYMENT_ID, currency: 'KES', confirmedMinor: 12800000n };

    const first = settle(invoice, payment, cbkUsdKes);
    const second = settle(invoice, payment, cbkUsdKes);
    expect(second.appliedMinor).toBe(first.appliedMinor);
    expect(second.receivable.balanceMinor).toBe(first.receivable.balanceMinor);
    expect(second.fxEvents).toHaveLength(first.fxEvents.length);
  });
});
