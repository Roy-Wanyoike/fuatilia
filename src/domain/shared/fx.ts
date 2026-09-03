/**
 * FX — multi-currency kernel slice (issue #9): exact rate snapshots, exact
 * minor-unit conversion, and realized gain/loss postings.
 *
 * Decision context: review finding H2 (docs/06-review-findings.md) —
 * "Money in minor units everywhere; allocation and matching are
 * single-currency; FX needs explicit realized gain/loss postings" — and
 * invariant R10 (docs/07-invariants.md): all arithmetic single-currency;
 * cross-currency settlement requires an explicit FX posting with realized
 * gain/loss. SPEC §32–33: currencies and scales are configuration carried by
 * the snapshot, never hard-coded market assumptions.
 *
 * Rules this module guarantees:
 *  - Floats are BANNED from FX math (same discipline as money.ts). A rate is
 *    a RATIONAL — integer numerator/denominator — and conversion is pure
 *    bigint arithmetic with ONE banker's rounding (half-to-even) at the very
 *    last step. KES/USD conversions are therefore exact up to that single
 *    rounding, never subject to binary floating-point drift.
 *  - A FxRateSnapshot is an immutable, validated record. Every conversion
 *    returns an applied-rate reference back to the snapshot (the audit trail
 *    R10 postings need).
 *  - R10 gate, end to end: a cross-currency settlement attempted without an
 *    FX snapshot reference is refused with FX_SNAPSHOT_REQUIRED; a snapshot
 *    that does not bridge the requested currency pair is refused with
 *    FX_SNAPSHOT_PAIR_MISMATCH. Single-currency paths never enter this
 *    module — they stay on money.ts (a same-currency call here throws
 *    FX_SAME_CURRENCY).
 *  - Realized gain/loss is data-in/data-out: this module imports nothing from
 *    the ledger, allocation, or receivables lanes. The
 *    `fx.realizedGainLossPosted` event is a plain typed shape (opaque ids,
 *    bigint minor units) any lane can wrap into an envelope. Catalog
 *    integration (docs/04) is a deliberate, additive catalog change.
 */
import { DomainError } from './errors';
import type { Clock, Uuid } from './ids';
import { CURRENCIES, type Currency } from './money';

/** Stable, machine-readable FX failure codes (adapter mapping, R10 tests). */
export const FX_ERRORS = Object.freeze({
  /** FX machinery invoked on a single-currency pair — a modelling bug. */
  SAME_CURRENCY: 'FX_SAME_CURRENCY',
  /** Rate numerator/denominator must form a positive rational. */
  RATE_NOT_POSITIVE: 'FX_RATE_NOT_POSITIVE',
  /** Minor-unit scale must be an integer in [0, 8]. */
  SCALE_INVALID: 'FX_SCALE_INVALID',
  /** Rate provenance is mandatory (who quoted this rate?). */
  SOURCE_REQUIRED: 'FX_SOURCE_REQUIRED',
  /** observedAt must be ISO-8601 (or a valid Date). */
  OBSERVED_AT_INVALID: 'FX_OBSERVED_AT_INVALID',
  /** Snapshot/org/settlement ids must be canonical UUIDs. */
  ID_MALFORMED: 'FX_ID_MALFORMED',
  /** R10: cross-currency settlement without an FX snapshot reference. */
  SNAPSHOT_REQUIRED: 'FX_SNAPSHOT_REQUIRED',
  /** Snapshot exists but does not bridge the requested currency pair. */
  SNAPSHOT_PAIR_MISMATCH: 'FX_SNAPSHOT_PAIR_MISMATCH',
  /** Correct pair, wrong conversion direction for that pair. */
  DIRECTION_MISMATCH: 'FX_DIRECTION_MISMATCH',
  /** A currency outside the supported CURRENCIES set (money.ts). */
  CURRENCY_UNSUPPORTED: 'FX_CURRENCY_UNSUPPORTED',
} as const);

/** Which way a conversion runs across the snapshot's quoted pair. */
export type FxDirection = 'base_to_quote' | 'quote_to_base';

/** Canonical UUID — same shape the event envelope enforces. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** ISO-8601 — same shape the event envelope enforces. */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const assertUuidShape = (value: Uuid, field: string): Uuid => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError(FX_ERRORS.ID_MALFORMED, `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value;
};

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

/**
 * Default minor-unit scale (decimal digits) per currency. UGX trades without
 * cents; every other supported currency is quoted to 2. This is a convenience
 * default only — the authoritative scale always travels ON the snapshot
 * (SPEC §32: no hard-coded market assumptions in core logic).
 */
export const DEFAULT_MINOR_SCALE: Readonly<Record<Currency, number>> = Object.freeze({
  UGX: 0,
  KES: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
  TZS: 2,
});

// ---------------------------------------------------------------------------
// FxRateSnapshot — the immutable rate record
// ---------------------------------------------------------------------------

/** Constructor input for {@link fxRateSnapshot}. */
export interface FxRateSnapshotInput {
  /** Owning org — snapshots are per-org configuration, never global truth. */
  readonly orgId: Uuid;
  readonly baseCurrency: Currency;
  readonly quoteCurrency: Currency;
  /**
   * The quoted rate as an exact rational in MAJOR units:
   * 1 base = numerator/denominator quote (e.g. KES 129.754 per USD is
   * numerator 129754, denominator 1000). Never a float.
   */
  readonly numerator: bigint | number;
  readonly denominator: bigint | number;
  /** Minor-unit decimal digits of the base currency (default per DEFAULT_MINOR_SCALE). */
  readonly scaleBase?: number;
  /** Minor-unit decimal digits of the quote currency (default per DEFAULT_MINOR_SCALE). */
  readonly scaleQuote?: number;
  /** Rate provenance, e.g. 'CBK', 'manual:ops', 'daraja'. */
  readonly source: string;
  /** When the rate was observed — Date or ISO-8601 string; stored as ISO-8601. */
  readonly observedAt: Date | string;
  /** Unique id of this snapshot (the reference FX postings carry). */
  readonly snapshotId: Uuid;
}

/**
 * The frozen, validated FX rate record. A snapshot quotes exactly one pair,
 * in one direction: 1 base = numerator/denominator quote. The inverse leg is
 * computed exactly by `convert` with direction 'quote_to_base' — snapshots
 * are never duplicated to express the reverse rate.
 */
export interface FxRateSnapshot {
  readonly snapshotId: Uuid;
  readonly orgId: Uuid;
  readonly baseCurrency: Currency;
  readonly quoteCurrency: Currency;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly scaleBase: number;
  readonly scaleQuote: number;
  readonly source: string;
  /** ISO-8601. */
  readonly observedAt: string;
}

const assertScale = (scale: number, field: string): number => {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 8) {
    throw new DomainError(FX_ERRORS.SCALE_INVALID, `${field} must be an integer in [0, 8], got ${String(scale)}`, {
      field,
      scale,
    });
  }
  return scale;
};

const asBigint = (value: bigint | number, code: string, message: string): bigint => {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new DomainError(code, message, { value: String(value) });
  }
  const v = typeof value === 'number' ? BigInt(value) : value;
  if (v <= 0n) {
    throw new DomainError(code, message, { value: String(value) });
  }
  return v;
};

const normalizeObservedAt = (input: Date | string): string => {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new DomainError(FX_ERRORS.OBSERVED_AT_INVALID, 'observedAt is an invalid Date', {
        observedAt: String(input),
      });
    }
    return input.toISOString();
  }
  if (typeof input === 'string' && ISO_PATTERN.test(input) && !Number.isNaN(new Date(input).getTime())) {
    return input;
  }
  throw new DomainError(
    FX_ERRORS.OBSERVED_AT_INVALID,
    `observedAt must be ISO-8601 (e.g. 2025-09-02T08:00:00.000Z), got ${String(input)}`,
    { observedAt: String(input) },
  );
};

/**
 * Build a validated, frozen FxRateSnapshot. Rejects (stable codes):
 * malformed ids (FX_ID_MALFORMED), a base equal to the quote (FX_SAME_CURRENCY),
 * non-positive numerator/denominator (FX_RATE_NOT_POSITIVE), scales outside
 * [0, 8] (FX_SCALE_INVALID), an empty source (FX_SOURCE_REQUIRED) and a bad
 * observedAt (FX_OBSERVED_AT_INVALID).
 */
export const fxRateSnapshot = (input: FxRateSnapshotInput): FxRateSnapshot => {
  assertUuidShape(input.snapshotId, 'snapshotId');
  assertUuidShape(input.orgId, 'orgId');
  if (!isCurrency(input.baseCurrency) || !isCurrency(input.quoteCurrency)) {
    throw new DomainError(
      FX_ERRORS.CURRENCY_UNSUPPORTED,
      `unsupported currency in pair ${String(input.baseCurrency)}/${String(input.quoteCurrency)}`,
      { baseCurrency: String(input.baseCurrency), quoteCurrency: String(input.quoteCurrency) },
    );
  }
  if (input.baseCurrency === input.quoteCurrency) {
    throw new DomainError(
      FX_ERRORS.SAME_CURRENCY,
      `a snapshot must quote two distinct currencies, got ${input.baseCurrency} against itself`,
    );
  }
  const numerator = asBigint(input.numerator, FX_ERRORS.RATE_NOT_POSITIVE, 'rate numerator must be a positive integer');
  const denominator = asBigint(
    input.denominator,
    FX_ERRORS.RATE_NOT_POSITIVE,
    'rate denominator must be a positive integer',
  );
  const scaleBase = assertScale(input.scaleBase ?? DEFAULT_MINOR_SCALE[input.baseCurrency], 'scaleBase');
  const scaleQuote = assertScale(input.scaleQuote ?? DEFAULT_MINOR_SCALE[input.quoteCurrency], 'scaleQuote');
  const source = input.source.trim();
  if (source === '') {
    throw new DomainError(FX_ERRORS.SOURCE_REQUIRED, 'a rate source is required (provenance is part of the audit trail)');
  }
  return Object.freeze({
    snapshotId: input.snapshotId,
    orgId: input.orgId,
    baseCurrency: input.baseCurrency,
    quoteCurrency: input.quoteCurrency,
    numerator,
    denominator,
    scaleBase,
    scaleQuote,
    source,
    observedAt: normalizeObservedAt(input.observedAt),
  });
};

/** Exact quoted rate for display/audit — never a float ("129754/1000"). */
export const rateRatio = (snapshot: FxRateSnapshot): string =>
  `${snapshot.numerator}/${snapshot.denominator}`;

// ---------------------------------------------------------------------------
// Exact conversion
// ---------------------------------------------------------------------------

/** The applied-rate reference every conversion returns (R10 audit trail). */
export interface FxAppliedRate {
  readonly snapshotId: Uuid;
  readonly source: string;
  /** ISO-8601. */
  readonly observedAt: string;
  readonly baseCurrency: Currency;
  readonly quoteCurrency: Currency;
  /** Quoted rate, exact rational major units: 1 base = numerator/denominator quote. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly scaleBase: number;
  readonly scaleQuote: number;
  /**
   * The exact minor→minor rational actually applied BEFORE the single
   * banker's rounding: 1 minor unit of `from` = appliedNumerator /
   * appliedDenominator minor units of `to`.
   */
  readonly appliedNumerator: bigint;
  readonly appliedDenominator: bigint;
}

/** The result of one exact conversion. */
export interface FxConversion {
  readonly from: Currency;
  readonly to: Currency;
  readonly direction: FxDirection;
  readonly inputAmountMinor: bigint;
  /** Converted minor units — rounded ONCE, banker's (half-to-even). */
  readonly amountMinor: bigint;
  /** The applied-rate reference (snapshot provenance + exact ratio used). */
  readonly rate: FxAppliedRate;
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * Round the exact non-negative rational p/q to the nearest integer with
 * banker's rounding (exact halves go to the even neighbour). This is the ONLY
 * rounding in the entire FX pipeline.
 */
const divideBankers = (p: bigint, q: bigint): bigint => {
  const whole = p / q;
  const remainder = p % q;
  const twice = remainder * 2n;
  if (twice > q) return whole + 1n;
  if (twice < q) return whole;
  return whole % 2n === 0n ? whole : whole + 1n;
};

/** Minor units in, bigint out — floats and negatives are modelling bugs. */
const toMinorUnits = (amount: bigint | number, field: string): bigint => {
  if (typeof amount === 'number') {
    if (!Number.isSafeInteger(amount)) {
      throw new DomainError('MONEY_NOT_INTEGER', `${field} must be an integer minor unit, got ${amount}`);
    }
    const v = BigInt(amount);
    if (v < 0n) {
      throw new DomainError('MONEY_NEGATIVE', `${field} cannot be negative, got ${amount}`);
    }
    return v;
  }
  if (amount < 0n) {
    throw new DomainError('MONEY_NEGATIVE', `${field} cannot be negative, got ${amount}`);
  }
  return amount;
};

/**
 * The exact minor→minor rational for one direction of the snapshot's pair.
 *
 * A snapshot quotes 1 base (major) = num/den quote (major). In minor units,
 * 1 base-minor = (num/den) × 10^(scaleQuote − scaleBase) quote-minor — the
 * scale gap is folded into the rational so the pipeline stays exact:
 * 'base_to_quote' → (num × 10^k)/den or num/(den × 10^−k);
 * 'quote_to_base' is the exact inverse with the mirrored scale gap.
 */
const appliedRatio = (
  snapshot: FxRateSnapshot,
  direction: FxDirection,
): { num: bigint; den: bigint } => {
  const [num0, den0] =
    direction === 'base_to_quote'
      ? [snapshot.numerator, snapshot.denominator]
      : [snapshot.denominator, snapshot.numerator];
  const scaleGap =
    direction === 'base_to_quote'
      ? snapshot.scaleQuote - snapshot.scaleBase
      : snapshot.scaleBase - snapshot.scaleQuote;
  return scaleGap >= 0
    ? { num: num0 * pow10(scaleGap), den: den0 }
    : { num: num0, den: den0 * pow10(-scaleGap) };
};

/**
 * Exact minor-unit conversion across a snapshot's pair.
 *
 * - amount must be a non-negative integer (MONEY_NOT_INTEGER / MONEY_NEGATIVE).
 * - from = to is a modelling bug → FX_SAME_CURRENCY (single-currency paths
 *   never convert; they stay on money.ts arithmetic).
 * - direction must agree with (from, to) and the snapshot's pair:
 *   right pair but wrong direction → FX_DIRECTION_MISMATCH; a snapshot that
 *   does not bridge the pair at all → FX_SNAPSHOT_PAIR_MISMATCH.
 * - a missing snapshot → FX_SNAPSHOT_REQUIRED (defense in depth; the R10 gate
 *   for untyped callers).
 *
 * The returned `rate` references the snapshot (id, source, observedAt) plus
 * the exact applied ratio — the reference every FX posting must carry.
 */
export const convert = (
  amountMinor: bigint | number,
  from: Currency,
  to: Currency,
  snapshot: FxRateSnapshot | null | undefined,
  direction: FxDirection,
): FxConversion => {
  const amount = toMinorUnits(amountMinor, 'amountMinor');
  if (from === to) {
    throw new DomainError(FX_ERRORS.SAME_CURRENCY, `FX conversion invoked for a single currency (${from}) — use Money arithmetic`);
  }
  if (snapshot === null || snapshot === undefined) {
    throw new DomainError(
      FX_ERRORS.SNAPSHOT_REQUIRED,
      `cross-currency conversion ${from}→${to} requires an FX snapshot reference (R10)`,
      { from, to },
    );
  }
  const pairIsBaseToQuote = from === snapshot.baseCurrency && to === snapshot.quoteCurrency;
  const pairIsQuoteToBase = from === snapshot.quoteCurrency && to === snapshot.baseCurrency;
  if (!pairIsBaseToQuote && !pairIsQuoteToBase) {
    throw new DomainError(
      FX_ERRORS.SNAPSHOT_PAIR_MISMATCH,
      `snapshot ${snapshot.snapshotId} quotes ${snapshot.baseCurrency}/${snapshot.quoteCurrency}, which does not bridge ${from}→${to}`,
      { from, to, snapshotId: snapshot.snapshotId },
    );
  }
  const expectedDirection: FxDirection = pairIsBaseToQuote ? 'base_to_quote' : 'quote_to_base';
  if (direction !== expectedDirection) {
    throw new DomainError(
      FX_ERRORS.DIRECTION_MISMATCH,
      `direction '${direction}' contradicts ${from}→${to} on snapshot ${snapshot.snapshotId}; expected '${expectedDirection}'`,
      { from, to, direction, expectedDirection, snapshotId: snapshot.snapshotId },
    );
  }
  const { num, den } = appliedRatio(snapshot, direction);
  const converted = divideBankers(amount * num, den);
  return Object.freeze({
    from,
    to,
    direction,
    inputAmountMinor: amount,
    amountMinor: converted,
    rate: Object.freeze({
      snapshotId: snapshot.snapshotId,
      source: snapshot.source,
      observedAt: snapshot.observedAt,
      baseCurrency: snapshot.baseCurrency,
      quoteCurrency: snapshot.quoteCurrency,
      numerator: snapshot.numerator,
      denominator: snapshot.denominator,
      scaleBase: snapshot.scaleBase,
      scaleQuote: snapshot.scaleQuote,
      appliedNumerator: num,
      appliedDenominator: den,
    }),
  });
};

// ---------------------------------------------------------------------------
// R10 gate — the hook allocation/settlement lanes must call
// ---------------------------------------------------------------------------

/**
 * R10 gate: return the snapshot that authorizes a cross-currency settlement
 * of `from` → `to`, or throw a stable DomainError:
 *
 * - from === to            → FX_SAME_CURRENCY (single-currency paths never
 *                            enter FX; they are untouched by this module)
 * - snapshot missing       → FX_SNAPSHOT_REQUIRED (the R10 rejection)
 * - snapshot does not
 *   bridge the pair        → FX_SNAPSHOT_PAIR_MISMATCH
 *
 * Allocation and settlement hooks call this before any cross-currency
 * posting; single-currency flows simply never call it.
 */
export const requireFxSnapshot = (
  from: Currency,
  to: Currency,
  snapshot?: FxRateSnapshot | null,
): FxRateSnapshot => {
  if (from === to) {
    throw new DomainError(
      FX_ERRORS.SAME_CURRENCY,
      `FX gate invoked for a single currency (${from}) — single-currency settlement needs no snapshot`,
    );
  }
  if (snapshot === null || snapshot === undefined) {
    throw new DomainError(
      FX_ERRORS.SNAPSHOT_REQUIRED,
      `cross-currency settlement ${from}→${to} requires an FX snapshot reference (R10)`,
      { from, to },
    );
  }
  const bridges =
    (snapshot.baseCurrency === from && snapshot.quoteCurrency === to) ||
    (snapshot.baseCurrency === to && snapshot.quoteCurrency === from);
  if (!bridges) {
    throw new DomainError(
      FX_ERRORS.SNAPSHOT_PAIR_MISMATCH,
      `snapshot ${snapshot.snapshotId} quotes ${snapshot.baseCurrency}/${snapshot.quoteCurrency}, which does not bridge ${from}→${to}`,
      { from, to, snapshotId: snapshot.snapshotId },
    );
  }
  return snapshot;
};

// ---------------------------------------------------------------------------
// Realized gain/loss postings
// ---------------------------------------------------------------------------

export type FxGainLossDirection = 'gain' | 'loss';

/** The realized gain/loss posting itself (non-negative magnitude + direction). */
export interface RealizedGainLoss {
  readonly direction: FxGainLossDirection;
  /** Non-negative magnitude, in the receivable's currency minor units. */
  readonly amountMinor: bigint;
  /** The currency the gain/loss is measured in (the receivable's currency). */
  readonly currency: Currency;
}

/** `fx.realizedGainLossPosted` — typed event name (not yet in the docs/04 catalog). */
export const FX_REALIZED_GAIN_LOSS_EVENT = 'fx.realizedGainLossPosted' as const;

/** Payload of `fx.realizedGainLossPosted`. Opaque ids, bigint minor units. */
export interface FxRealizedGainLossPostedPayload {
  readonly receivableId: Uuid;
  /** The settling payment, when one exists (credit-balance settlements pass null). */
  readonly paymentId: Uuid | null;
  readonly direction: FxGainLossDirection;
  /** Gain/loss magnitude, non-negative, receivable-currency minor units. */
  readonly amountMinor: bigint;
  /** Audit trail: the two sides compared, in receivable-currency minor units. */
  readonly carryingAmountMinor: bigint;
  readonly settlementConvertedMinor: bigint;
  /** Audit trail: the raw settlement, in settlement-currency minor units. */
  readonly settlementAmountMinor: bigint;
  readonly receivableCurrency: Currency;
  readonly settlementCurrency: Currency;
  /** The snapshot that authorized + measured this settlement (R10). */
  readonly snapshotId: Uuid;
}

/**
 * Interim envelope for `fx.realizedGainLossPosted` — the wave-1/2 lane shape
 * ({ name, version, aggregateId, payload, occurredAt }). Minor units travel
 * as bigints here; the unified events catalog serializes them to safe-integer
 * numbers at its boundary (`minorUnits`).
 */
export interface FxRealizedGainLossEvent {
  readonly name: typeof FX_REALIZED_GAIN_LOSS_EVENT;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, derived from the injected Clock. */
  readonly occurredAt: string;
  readonly payload: FxRealizedGainLossPostedPayload;
}

/** Input for {@link postRealizedGainLoss}. */
export interface FxRealizedGainLossInput {
  readonly receivableId: Uuid;
  readonly paymentId?: Uuid | null;
  /**
   * The receivable's base-currency carrying amount for the portion being
   * settled (receivable-currency minor units).
   */
  readonly carryingAmountMinor: bigint | number;
  readonly receivableCurrency: Currency;
  /** The amount actually received, in settlement-currency minor units. */
  readonly settlementAmountMinor: bigint | number;
  readonly settlementCurrency: Currency;
  /**
   * The FX snapshot authorizing this cross-currency settlement (R10).
   * Omitted/null on a cross-currency settlement is refused with
   * FX_SNAPSHOT_REQUIRED.
   */
  readonly snapshot?: FxRateSnapshot | null;
  readonly clock: Clock;
  /** Event aggregate id; defaults to the receivable. */
  readonly aggregateId?: Uuid;
}

/** The full cross-currency settlement outcome: FX posting + gain/loss event. */
export interface FxSettlementPosting {
  readonly receivableId: Uuid;
  readonly carryingAmountMinor: bigint;
  readonly settlementAmountMinor: bigint;
  /** Settlement converted to the receivable's currency (banker's-rounded once). */
  readonly settlementConvertedMinor: bigint;
  readonly receivableCurrency: Currency;
  readonly settlementCurrency: Currency;
  /** The FX posting itself — exact conversion + applied rate reference. */
  readonly conversion: FxConversion;
  /** Realized gain/loss — null on an exact wash (nothing to post). */
  readonly realizedGainLoss: RealizedGainLoss | null;
  /** `fx.realizedGainLossPosted` — null on an exact wash. */
  readonly event: FxRealizedGainLossEvent | null;
}

/**
 * Settle a receivable in a different currency and post the realized
 * gain/loss (H2/R10).
 *
 * Pipeline: gate on the snapshot (requireFxSnapshot) → convert the settlement
 * into the receivable's currency EXACTLY (single banker's rounding) →
 * compare against the base-currency carrying amount → emit
 * `fx.realizedGainLossPosted` with direction gain|loss when the two differ.
 * An exact wash (converted == carrying) posts the FX conversion but no
 * gain/loss event — there is nothing realized to post.
 *
 * Refusals (stable codes): FX_SAME_CURRENCY (same-currency settlement is not
 * an FX event), FX_SNAPSHOT_REQUIRED (cross-currency without a snapshot
 * reference — the R10 rejection), FX_SNAPSHOT_PAIR_MISMATCH, MONEY_NEGATIVE /
 * MONEY_NOT_INTEGER (bad amounts), FX_ID_MALFORMED (bad ids).
 */
export const postRealizedGainLoss = (input: FxRealizedGainLossInput): FxSettlementPosting => {
  const {
    receivableId,
    paymentId = null,
    carryingAmountMinor,
    receivableCurrency,
    settlementAmountMinor,
    settlementCurrency,
    snapshot,
    clock,
    aggregateId,
  } = input;

  assertUuidShape(receivableId, 'receivableId');
  if (paymentId !== null) assertUuidShape(paymentId, 'paymentId');
  if (aggregateId !== undefined) assertUuidShape(aggregateId, 'aggregateId');
  const carrying = toMinorUnits(carryingAmountMinor, 'carryingAmountMinor');
  const settlement = toMinorUnits(settlementAmountMinor, 'settlementAmountMinor');
  if (receivableCurrency === settlementCurrency) {
    throw new DomainError(
      FX_ERRORS.SAME_CURRENCY,
      `settlement currency ${settlementCurrency} equals the receivable currency — single-currency settlement needs no FX posting`,
    );
  }

  const authoritative = requireFxSnapshot(settlementCurrency, receivableCurrency, snapshot);
  const direction: FxDirection =
    authoritative.baseCurrency === settlementCurrency ? 'base_to_quote' : 'quote_to_base';
  const conversion = convert(settlement, settlementCurrency, receivableCurrency, authoritative, direction);
  const converted = conversion.amountMinor;

  if (converted === carrying) {
    return Object.freeze({
      receivableId,
      carryingAmountMinor: carrying,
      settlementAmountMinor: settlement,
      settlementConvertedMinor: converted,
      receivableCurrency,
      settlementCurrency,
      conversion,
      realizedGainLoss: null,
      event: null,
    });
  }

  const gainLoss: RealizedGainLoss = Object.freeze({
    direction: converted > carrying ? 'gain' : 'loss',
    amountMinor: converted > carrying ? converted - carrying : carrying - converted,
    currency: receivableCurrency,
  });

  const event: FxRealizedGainLossEvent = Object.freeze({
    name: FX_REALIZED_GAIN_LOSS_EVENT,
    version: 1,
    aggregateId: aggregateId ?? receivableId,
    occurredAt: clock.now().toISOString(),
    payload: Object.freeze({
      receivableId,
      paymentId,
      direction: gainLoss.direction,
      amountMinor: gainLoss.amountMinor,
      carryingAmountMinor: carrying,
      settlementConvertedMinor: converted,
      settlementAmountMinor: settlement,
      receivableCurrency,
      settlementCurrency,
      snapshotId: authoritative.snapshotId,
    }),
  });

  return Object.freeze({
    receivableId,
    carryingAmountMinor: carrying,
    settlementAmountMinor: settlement,
    settlementConvertedMinor: converted,
    receivableCurrency,
    settlementCurrency,
    conversion,
    realizedGainLoss: gainLoss,
    event,
  });
};
