import { describe, expect, it } from 'vitest';
import { DomainError } from './errors';
import {
  DEFAULT_MINOR_SCALE,
  FX_ERRORS,
  FX_REALIZED_GAIN_LOSS_EVENT,
  convert,
  fxRateSnapshot,
  postRealizedGainLoss,
  rateRatio,
  requireFxSnapshot,
} from './fx';
import type { FxRateSnapshot, FxRateSnapshotInput } from './fx';
import type { Clock, Uuid } from './ids';
import { uuid } from './ids';

// ---------------------------------------------------------------------------
// Fixtures — canonical UUIDs, fixed clock, real-shaped rates
// ---------------------------------------------------------------------------

const ORG_ID = uuid('5b3f1a2c-9d4e-4f6a-8b7c-1e2d3f4a5b6c');
const SNAPSHOT_ID = uuid('a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d');
const OTHER_SNAPSHOT_ID = uuid('b2c3d4e5-f6a7-4b5c-9d0e-1f2a3b4c5d6e');
const RECEIVABLE_ID = uuid('c3d4e5f6-a7b8-4c5d-8e9f-0a1b2c3d4e5f');
const PAYMENT_ID = uuid('d4e5f6a7-b8c9-4d5e-8f9a-0b1c2d3e4f5a');
const AGGREGATE_ID = uuid('e5f6a7b8-c9d0-4e5f-8a9b-0c1d2e3f4a5b');

const fixedClock: Clock = { now: () => new Date('2025-09-02T08:00:00.000Z') };

/** 1 USD = 129.754 KES — exact rational, CBK-style indicative rate. */
const usdKesSnapshot: FxRateSnapshot = fxRateSnapshot({
  orgId: ORG_ID,
  snapshotId: SNAPSHOT_ID,
  baseCurrency: 'USD',
  quoteCurrency: 'KES',
  numerator: 129754n,
  denominator: 1000n,
  source: 'CBK',
  observedAt: '2025-09-01T12:00:00.000Z',
});

/** 1 USD = 3,795 UGX — UGX carries no minor units (scale 0). */
const usdUgxSnapshot: FxRateSnapshot = fxRateSnapshot({
  orgId: ORG_ID,
  snapshotId: OTHER_SNAPSHOT_ID,
  baseCurrency: 'USD',
  quoteCurrency: 'UGX',
  numerator: 3795n,
  denominator: 1n,
  source: 'manual:ops',
  observedAt: new Date('2025-09-01T12:00:00.000Z'),
});

const snapshot = (over: Partial<FxRateSnapshotInput>): FxRateSnapshot =>
  fxRateSnapshot({
    orgId: ORG_ID,
    snapshotId: SNAPSHOT_ID,
    baseCurrency: 'USD',
    quoteCurrency: 'KES',
    numerator: 129754n,
    denominator: 1000n,
    source: 'CBK',
    observedAt: '2025-09-01T12:00:00.000Z',
    ...over,
  });

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
// Snapshot — construction, validation, immutability
// ---------------------------------------------------------------------------

describe('FxRateSnapshot', () => {
  it('builds a frozen record with an exact rational rate and ISO observedAt', () => {
    expect(usdKesSnapshot.numerator).toBe(129754n);
    expect(usdKesSnapshot.denominator).toBe(1000n);
    expect(rateRatio(usdKesSnapshot)).toBe('129754/1000');
    expect(usdKesSnapshot.scaleBase).toBe(2);
    expect(usdKesSnapshot.scaleQuote).toBe(2);
    expect(usdKesSnapshot.observedAt).toBe('2025-09-01T12:00:00.000Z');
    expect(Object.isFrozen(usdKesSnapshot)).toBe(true);
  });

  it('defaults minor-unit scales per currency (UGX trades at scale 0)', () => {
    expect(DEFAULT_MINOR_SCALE.UGX).toBe(0);
    expect(usdUgxSnapshot.scaleQuote).toBe(0);
    expect(usdUgxSnapshot.scaleBase).toBe(2);
    expect(snapshot({ scaleQuote: 3 }).scaleQuote).toBe(3);
  });

  it('normalizes a Date observedAt to ISO-8601', () => {
    expect(usdUgxSnapshot.observedAt).toBe('2025-09-01T12:00:00.000Z');
  });

  it('is immutable — mutations are refused', () => {
    expect(() => {
      (usdKesSnapshot as { numerator: bigint }).numerator = 1n;
    }).toThrow(TypeError);
    expect(() => {
      // ESM runs in strict mode: writing to a frozen record throws.
      (usdKesSnapshot as unknown as Record<string, unknown>).source = 'tampered';
    }).toThrow(TypeError);
  });

  it('rejects a base quoted against itself', () => {
    expectCode(() => snapshot({ quoteCurrency: 'USD' }), FX_ERRORS.SAME_CURRENCY);
  });

  it('rejects non-positive rate numerators and denominators', () => {
    expectCode(() => snapshot({ numerator: 0n }), FX_ERRORS.RATE_NOT_POSITIVE);
    expectCode(() => snapshot({ denominator: 0n }), FX_ERRORS.RATE_NOT_POSITIVE);
    expectCode(() => snapshot({ numerator: -5n }), FX_ERRORS.RATE_NOT_POSITIVE);
    expectCode(() => snapshot({ denominator: 0.5 }), FX_ERRORS.RATE_NOT_POSITIVE);
  });

  it('rejects out-of-range scales, empty sources, bad observedAt and malformed ids', () => {
    expectCode(() => snapshot({ scaleBase: -1 }), FX_ERRORS.SCALE_INVALID);
    expectCode(() => snapshot({ scaleQuote: 9 }), FX_ERRORS.SCALE_INVALID);
    expectCode(() => snapshot({ scaleQuote: 1.5 }), FX_ERRORS.SCALE_INVALID);
    expectCode(() => snapshot({ source: '   ' }), FX_ERRORS.SOURCE_REQUIRED);
    expectCode(() => snapshot({ observedAt: '2025-09-01 noon' }), FX_ERRORS.OBSERVED_AT_INVALID);
    expectCode(() => snapshot({ observedAt: new Date('not-a-date') }), FX_ERRORS.OBSERVED_AT_INVALID);
    expectCode(
      () => snapshot({ snapshotId: 'not-a-uuid' as FxRateSnapshotInput['snapshotId'] }),
      FX_ERRORS.ID_MALFORMED,
    );
    expectCode(
      () => snapshot({ orgId: '0b8f6c1e-4a2d-4c3b-9e5f' as FxRateSnapshotInput['orgId'] }),
      FX_ERRORS.ID_MALFORMED,
    );
  });

  it('rejects currencies outside the supported CURRENCIES set', () => {
    expectCode(
      () =>
        snapshot({
          baseCurrency: 'ZAR' as FxRateSnapshotInput['baseCurrency'],
          quoteCurrency: 'KES',
        }),
      FX_ERRORS.CURRENCY_UNSUPPORTED,
    );
  });
});

// ---------------------------------------------------------------------------
// convert — exact minor-unit conversion table
// ---------------------------------------------------------------------------

describe('convert — exact conversion table', () => {
  interface Row {
    readonly name: string;
    readonly amountMinor: bigint;
    readonly from: 'USD' | 'KES' | 'UGX';
    readonly to: 'USD' | 'KES' | 'UGX';
    readonly snapshot: FxRateSnapshot;
    readonly direction: 'base_to_quote' | 'quote_to_base';
    readonly expected: bigint;
  }

  const rows: readonly Row[] = [
    {
      name: '$100.00 → KES at 129.754 is exact (1297540 minor = KES 12,975.40)',
      amountMinor: 10000n,
      from: 'USD',
      to: 'KES',
      snapshot: usdKesSnapshot,
      direction: 'base_to_quote',
      expected: 1297540n,
    },
    {
      name: 'KES 12,975.40 → USD round-trips exactly to $100.00',
      amountMinor: 1297540n,
      from: 'KES',
      to: 'USD',
      snapshot: usdKesSnapshot,
      direction: 'quote_to_base',
      expected: 10000n,
    },
    {
      name: '$1,000,000.01 → KES stays exact where 64-bit floats would drift',
      amountMinor: 100000001n,
      from: 'USD',
      to: 'KES',
      snapshot: usdKesSnapshot,
      direction: 'base_to_quote',
      expected: 12975400130n,
    },
    {
      name: '$10.00 → UGX folds the 2-digit scale gap into the rational',
      amountMinor: 1000n,
      from: 'USD',
      to: 'UGX',
      snapshot: usdUgxSnapshot,
      direction: 'base_to_quote',
      expected: 37950n,
    },
    {
      name: 'UGX 37,950 → USD folds the mirrored scale gap',
      amountMinor: 37950n,
      from: 'UGX',
      to: 'USD',
      snapshot: usdUgxSnapshot,
      direction: 'quote_to_base',
      expected: 1000n,
    },
    {
      name: 'zero converts to zero',
      amountMinor: 0n,
      from: 'USD',
      to: 'KES',
      snapshot: usdKesSnapshot,
      direction: 'base_to_quote',
      expected: 0n,
    },
  ];

  it.each(rows)('$name', ({ amountMinor, from, to, snapshot: snap, direction, expected }) => {
    const result = convert(amountMinor, from, to, snap, direction);
    expect(result.amountMinor).toBe(expected);
    expect(result.inputAmountMinor).toBe(amountMinor);
    expect(result.from).toBe(from);
    expect(result.to).toBe(to);
    expect(result.direction).toBe(direction);
  });

  it('rounds exactly once — at the very last step (bigints throughout before it)', () => {
    const result = convert(10000n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote');
    expect(result.rate.appliedNumerator).toBe(129754n);
    expect(result.rate.appliedDenominator).toBe(1000n);
    expect(result.amountMinor % 1n).toBe(0n);
  });

  it('carries the applied-rate reference back to the snapshot (R10 audit trail)', () => {
    const { rate } = convert(100n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote');
    expect(rate.snapshotId).toBe(SNAPSHOT_ID);
    expect(rate.source).toBe('CBK');
    expect(rate.observedAt).toBe('2025-09-01T12:00:00.000Z');
    expect(rate.baseCurrency).toBe('USD');
    expect(rate.quoteCurrency).toBe('KES');
    expect(rate.numerator).toBe(129754n);
    expect(rate.denominator).toBe(1000n);
  });

  it('returns a frozen result and frozen rate reference', () => {
    const result = convert(1n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rate)).toBe(true);
  });
});

describe('convert — banker’s rounding (half-to-even) at the last step', () => {
  interface Row {
    readonly amountMinor: bigint;
    readonly expected: bigint;
  }

  // A 1:2 rate makes every odd amount land on an exact .5 — the tie cases.
  const halfRate = snapshot({ baseCurrency: 'USD', quoteCurrency: 'KES', numerator: 1n, denominator: 2n });
  const round = (amount: bigint): bigint =>
    convert(amount, 'USD', 'KES', halfRate, 'base_to_quote').amountMinor;

  it.each<Row>([
    { amountMinor: 1n, expected: 0n }, // 0.5 → 0 (even)
    { amountMinor: 3n, expected: 2n }, // 1.5 → 2 (even)
    { amountMinor: 5n, expected: 2n }, // 2.5 → 2 (even)
    { amountMinor: 7n, expected: 4n }, // 3.5 → 4 (even)
    { amountMinor: 9n, expected: 4n }, // 4.5 → 4 (even)
    { amountMinor: 11n, expected: 6n }, // 5.5 → 6 (even)
    { amountMinor: 13n, expected: 6n }, // 6.5 → 6 (even)
    { amountMinor: 15n, expected: 8n }, // 7.5 → 8 (even)
    { amountMinor: 17n, expected: 8n }, // 8.5 → 8 (even)
    { amountMinor: 19n, expected: 10n }, // 9.5 → 10 (even)
  ])('$amountMinor minor at 1:2 → $expected (ties to even)', ({ amountMinor, expected }) => {
    expect(round(amountMinor)).toBe(expected);
  });

  it('rounds sub-half down and over-half up', () => {
    // $0.04 at 129.754 → 519.016 KES-minor → 519 (sub-half rounds down).
    expect(convert(4n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote').amountMinor).toBe(519n);
    // $0.02 at 129.754 → 259.508 KES-minor → 260 (over-half rounds up).
    expect(convert(2n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote').amountMinor).toBe(260n);
  });

  it('breaks ties to even on the whole part too (499.5 → 500, 500.5 → 500)', () => {
    // 64877 × 1000 / 129754 = 500 exactly at the halfway point of the ratio.
    expect(convert(64877n, 'KES', 'USD', usdKesSnapshot, 'quote_to_base').amountMinor).toBe(500n);
  });
});

describe('convert — refusals', () => {
  it('refuses same-currency conversion (single-currency paths never enter FX)', () => {
    expectCode(() => convert(100n, 'KES', 'KES', usdKesSnapshot, 'base_to_quote'), FX_ERRORS.SAME_CURRENCY);
  });

  it('refuses a missing snapshot reference (R10)', () => {
    expectCode(() => convert(100n, 'USD', 'KES', null, 'base_to_quote'), FX_ERRORS.SNAPSHOT_REQUIRED);
    expectCode(() => convert(100n, 'USD', 'KES', undefined, 'base_to_quote'), FX_ERRORS.SNAPSHOT_REQUIRED);
  });

  it('refuses a snapshot that does not bridge the requested pair', () => {
    expectCode(() => convert(100n, 'GBP', 'KES', usdKesSnapshot, 'base_to_quote'), FX_ERRORS.SNAPSHOT_PAIR_MISMATCH);
    expectCode(() => convert(100n, 'USD', 'UGX', usdKesSnapshot, 'base_to_quote'), FX_ERRORS.SNAPSHOT_PAIR_MISMATCH);
  });

  it('refuses a direction that contradicts the pair', () => {
    expectCode(
      () => convert(100n, 'USD', 'KES', usdKesSnapshot, 'quote_to_base'),
      FX_ERRORS.DIRECTION_MISMATCH,
    );
    expectCode(
      () => convert(100n, 'KES', 'USD', usdKesSnapshot, 'base_to_quote'),
      FX_ERRORS.DIRECTION_MISMATCH,
    );
  });

  it('refuses non-integer and negative amounts (money discipline holds in FX)', () => {
    expectCode(() => convert(1.5, 'USD', 'KES', usdKesSnapshot, 'base_to_quote'), 'MONEY_NOT_INTEGER');
    expectCode(() => convert(-1n, 'USD', 'KES', usdKesSnapshot, 'base_to_quote'), 'MONEY_NEGATIVE');
    expectCode(() => convert(-100, 'KES', 'USD', usdKesSnapshot, 'quote_to_base'), 'MONEY_NEGATIVE');
  });
});

// ---------------------------------------------------------------------------
// requireFxSnapshot — the R10 gate
// ---------------------------------------------------------------------------

describe('requireFxSnapshot — R10 gate', () => {
  it('authorizes both directions of a bridging snapshot', () => {
    expect(requireFxSnapshot('USD', 'KES', usdKesSnapshot).snapshotId).toBe(SNAPSHOT_ID);
    expect(requireFxSnapshot('KES', 'USD', usdKesSnapshot).snapshotId).toBe(SNAPSHOT_ID);
  });

  it('rejects a cross-currency settlement without a snapshot reference', () => {
    expectCode(() => requireFxSnapshot('USD', 'KES', null), FX_ERRORS.SNAPSHOT_REQUIRED);
    expectCode(() => requireFxSnapshot('KES', 'USD', undefined), FX_ERRORS.SNAPSHOT_REQUIRED);
  });

  it('rejects a snapshot that does not bridge the pair', () => {
    expectCode(() => requireFxSnapshot('GBP', 'KES', usdKesSnapshot), FX_ERRORS.SNAPSHOT_PAIR_MISMATCH);
  });

  it('rejects single-currency paths that try to enter the gate', () => {
    expectCode(() => requireFxSnapshot('KES', 'KES', usdKesSnapshot), FX_ERRORS.SAME_CURRENCY);
    expectCode(() => requireFxSnapshot('KES', 'KES', null), FX_ERRORS.SAME_CURRENCY);
  });
});

// ---------------------------------------------------------------------------
// postRealizedGainLoss — gain, loss, wash, refusals
// ---------------------------------------------------------------------------

describe('postRealizedGainLoss', () => {
  it('posts a realized GAIN when the converted settlement exceeds the carrying amount', () => {
    // Receivable $1,000.00 settled by KES 130,000.00 → $1,001.90 → gain $1.90.
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      paymentId: PAYMENT_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 13000000n,
      settlementCurrency: 'KES',
      snapshot: usdKesSnapshot,
      clock: fixedClock,
    });
    expect(posting.realizedGainLoss).toEqual({
      direction: 'gain',
      amountMinor: 190n,
      currency: 'USD',
    });
    expect(posting.settlementConvertedMinor).toBe(100190n);
    expect(posting.conversion.rate.snapshotId).toBe(SNAPSHOT_ID);
  });

  it('posts a realized LOSS when the converted settlement falls short', () => {
    // KES 128,000.00 → $986.48 vs carrying $1,000.00 → loss $13.52.
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      paymentId: PAYMENT_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 12800000n,
      settlementCurrency: 'KES',
      snapshot: usdKesSnapshot,
      clock: fixedClock,
    });
    expect(posting.realizedGainLoss).toEqual({
      direction: 'loss',
      amountMinor: 1352n,
      currency: 'USD',
    });
    expect(posting.settlementConvertedMinor).toBe(98648n);
  });

  it('emits fx.realizedGainLossPosted with direction, magnitude and full audit trail', () => {
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      paymentId: PAYMENT_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 13000000n,
      settlementCurrency: 'KES',
      snapshot: usdKesSnapshot,
      clock: fixedClock,
    });
    expect(posting.event).not.toBeNull();
    const event = posting.event!;
    expect(event.name).toBe(FX_REALIZED_GAIN_LOSS_EVENT);
    expect(event.name).toBe('fx.realizedGainLossPosted');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(RECEIVABLE_ID);
    expect(event.occurredAt).toBe('2025-09-02T08:00:00.000Z');
    expect(event.payload).toEqual({
      receivableId: RECEIVABLE_ID,
      paymentId: PAYMENT_ID,
      direction: 'gain',
      amountMinor: 190n,
      carryingAmountMinor: 100000n,
      settlementConvertedMinor: 100190n,
      settlementAmountMinor: 13000000n,
      receivableCurrency: 'USD',
      settlementCurrency: 'KES',
      snapshotId: SNAPSHOT_ID,
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it('posts no gain/loss event on an exact wash (converted == carrying)', () => {
    // KES 129,754.00 converts exactly to $1,000.00.
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 12975400n,
      settlementCurrency: 'KES',
      snapshot: usdKesSnapshot,
      clock: fixedClock,
    });
    expect(posting.realizedGainLoss).toBeNull();
    expect(posting.event).toBeNull();
    expect(posting.settlementConvertedMinor).toBe(100000n);
    // The FX conversion itself is still posted with its rate reference.
    expect(posting.conversion.rate.snapshotId).toBe(SNAPSHOT_ID);
  });

  it('accepts a snapshot quoted in either direction and picks the right leg', () => {
    // The same market rate quoted the other way: 1 KES = 1000/129754 USD.
    const kesUsd = snapshot({
      snapshotId: OTHER_SNAPSHOT_ID,
      baseCurrency: 'KES',
      quoteCurrency: 'USD',
      numerator: 1000n,
      denominator: 129754n,
    });
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 13000000n,
      settlementCurrency: 'KES',
      snapshot: kesUsd,
      clock: fixedClock,
    });
    expect(posting.conversion.direction).toBe('base_to_quote');
    expect(posting.settlementConvertedMinor).toBe(100190n);
  });

  it('rejects a cross-currency settlement without an FX snapshot reference (R10)', () => {
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          snapshot: null,
          clock: fixedClock,
        }),
      FX_ERRORS.SNAPSHOT_REQUIRED,
    );
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          clock: fixedClock,
        }),
      FX_ERRORS.SNAPSHOT_REQUIRED,
    );
  });

  it('rejects a snapshot that does not bridge the settlement pair', () => {
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          snapshot: usdUgxSnapshot,
          clock: fixedClock,
        }),
      FX_ERRORS.SNAPSHOT_PAIR_MISMATCH,
    );
  });

  it('rejects a single-currency settlement routed through the FX poster', () => {
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'KES',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          clock: fixedClock,
        }),
      FX_ERRORS.SAME_CURRENCY,
    );
  });

  it('rejects negative and non-integer amounts', () => {
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: -1n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          snapshot: usdKesSnapshot,
          clock: fixedClock,
        }),
      'MONEY_NEGATIVE',
    );
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000.5,
          settlementCurrency: 'KES',
          snapshot: usdKesSnapshot,
          clock: fixedClock,
        }),
      'MONEY_NOT_INTEGER',
    );
  });

  it('rejects malformed ids', () => {
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: 'garbage' as unknown as Uuid,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          snapshot: usdKesSnapshot,
          clock: fixedClock,
        }),
      FX_ERRORS.ID_MALFORMED,
    );
    expectCode(
      () =>
        postRealizedGainLoss({
          receivableId: RECEIVABLE_ID,
          paymentId: 'also-garbage' as unknown as Uuid,
          carryingAmountMinor: 100000n,
          receivableCurrency: 'USD',
          settlementAmountMinor: 13000000n,
          settlementCurrency: 'KES',
          snapshot: usdKesSnapshot,
          clock: fixedClock,
        }),
      FX_ERRORS.ID_MALFORMED,
    );
  });

  it('honours an explicit aggregateId and a null paymentId', () => {
    const posting = postRealizedGainLoss({
      receivableId: RECEIVABLE_ID,
      carryingAmountMinor: 100000n,
      receivableCurrency: 'USD',
      settlementAmountMinor: 13000000n,
      settlementCurrency: 'KES',
      snapshot: usdKesSnapshot,
      clock: fixedClock,
      aggregateId: AGGREGATE_ID,
    });
    expect(posting.event?.aggregateId).toBe(AGGREGATE_ID);
    expect(posting.event?.payload.paymentId).toBeNull();
  });
});
