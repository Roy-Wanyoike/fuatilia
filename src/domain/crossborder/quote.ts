/**
 * FX quotes — forward-looking offers with expiry (issue #48, SPEC §33).
 *
 * A quote is NOT a realized posting (that is the fx lane's job): a quote is a
 * deterministically computed OFFER — rate snapshot + fee breakdown + expiry —
 * that a transfer intent may lock in at authorization. Quotes are immutable
 * records: there is no edit, no extend, no re-rate in place — a requote calls
 * `quote` again and produces a NEW quote id.
 *
 * Rate table rows carry an effective window [effectiveFrom, effectiveTo]
 * (both INCLUSIVE; effectiveTo null = open-ended). Two rows for the same
 * source→destination pair may never overlap — not even touch — because two
 * rates effective at the same instant make a quote ambiguous. Rows for
 * DIFFERENT pairs may overlap freely.
 *
 * Money and rates:
 *  - amounts are bigint minor units; a rate is an exact RATIONAL — integer
 *    numerator/denominator in MAJOR units (1 source = numerator/denominator
 *    destination) — and conversion is pure bigint arithmetic with ONE
 *    banker's rounding (half-to-even) at the very last step. No floats ever
 *    touch the pipeline (R10).
 *  - the minor→minor ratio folds the scale gap between the two currencies
 *    into the rational, so UGX-style zero-decimal currencies stay exact.
 *  - fees come from ./fees.ts (flat + bps, ONE banker's rounding) and are
 *    charged ON TOP in the source currency: the sender is debited
 *    sourceAmount + fee, the recipient receives the full converted amount.
 *
 * The no-cent-created-or-destroyed audit (reconcileQuoteLegs) pins the three
 * identities every quote must satisfy:
 *   1. fee.flatMinor + fee.bpsMinor === fee.totalMinor
 *   2. sourceAmountMinor + fee.totalMinor === sourceDebitMinor
 *   3. destinationCreditMinor === convert(sourceAmountMinor)  (deterministic
 *      recomputation at the applied ratio)
 *
 * Expiry: a quote is usable STRICTLY BEFORE `expiresAt` (issuedAt + ttl).
 * At exactly expiresAt — and every instant after — it answers QUOTE_EXPIRED.
 * This mirrors the payment-links lane's boundary discipline (±1ms tested).
 *
 * Everything is a pure function: time only via the injected Clock; no I/O,
 * no RNG, no Date.now(). Errors carry stable SCREAMING_SNAKE codes.
 */
import { CURRENCIES, DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import { computeFeeBreakdown, divideBankers, toMinorUnits } from './fees';
import type { FeeBreakdown } from './fees';
import { uuidFromSeed } from './ids';
import { quoteIssuedEvent } from './events';
import type { CrossborderEvent } from './events';
import {
  assertAmountWithinCorridor,
  assertCorridorLive,
  resolveCorridor,
} from './corridor';
import type { Corridor } from './corridor';

/** Default minor-unit decimal digits per supported currency (UGX trades without cents). */
export const DEFAULT_MINOR_SCALES: Readonly<Record<Currency, number>> = Object.freeze({
  UGX: 0,
  KES: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
  TZS: 2,
});

/** Default quote time-to-live in seconds (overridable per call). */
export const DEFAULT_QUOTE_TTL_SECONDS = 120;

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

const assertRowUuid = (value: Uuid, field: string): Uuid => {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `${field} must be a canonical UUID, got ${String(value)}`,
      { field, value: String(value) },
    );
  }
  return value;
};

/** Date | ISO-8601 string → canonical ISO-8601 string; anything else is invalid. */
function normalizeInstant(input: Date | string, field: string): string {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) {
      throw new DomainError('RATE_TABLE_INVALID', `${field} is an invalid Date`, {
        field,
        value: String(input),
      });
    }
    return input.toISOString();
  }
  if (typeof input === 'string' && ISO_PATTERN.test(input) && !Number.isNaN(new Date(input).getTime())) {
    return input;
  }
  throw new DomainError(
    'RATE_TABLE_INVALID',
    `${field} must be ISO-8601 (e.g. 2026-03-01T09:00:00.000Z), got ${String(input)}`,
    { field, value: String(input) },
  );
}

const assertScale = (scale: number | undefined, currency: Currency, field: string): number => {
  const resolved = scale ?? DEFAULT_MINOR_SCALES[currency];
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > 8) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `${field} must be an integer in [0, 8], got ${String(resolved)}`,
      { field, value: String(resolved) },
    );
  }
  return resolved;
};

// ---------------------------------------------------------------------------
// Rate rows — the corridor's rate table
// ---------------------------------------------------------------------------

export interface RateRowInput {
  readonly rowId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  /**
   * The quoted rate as an exact rational in MAJOR units:
   * 1 source = numerator/denominator destination (e.g. KES→TZS at 0.0742 is
   * numerator 742, denominator 10000). Never a float.
   */
  readonly numerator: bigint | number;
  readonly denominator: bigint | number;
  /** Inclusive window start — Date or ISO-8601 string. */
  readonly effectiveFrom: Date | string;
  /** Inclusive window end; null/undefined = open-ended. */
  readonly effectiveTo?: Date | string | null;
  /** Rate provenance, e.g. 'CBK', 'manual:treasury'. */
  readonly source: string;
  readonly scaleSource?: number;
  readonly scaleDest?: number;
}

export interface RateRow {
  readonly rowId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly scaleSource: number;
  readonly scaleDest: number;
  readonly source: string;
  /** ISO-8601, inclusive. */
  readonly effectiveFrom: string;
  /** ISO-8601 inclusive upper bound; null = open-ended. */
  readonly effectiveTo: string | null;
}

const asPositiveBigint = (value: bigint | number, field: string): bigint => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new DomainError(
        'RATE_TABLE_INVALID',
        `rate ${field} must be a positive safe integer, got ${String(value)}`,
        { field, value: String(value) },
      );
    }
    return BigInt(value);
  }
  if (value <= 0n) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `rate ${field} must be a positive integer, got ${value}`,
      { field, value: value.toString() },
    );
  }
  return value;
};

/**
 * Build one validated, frozen rate row. Shape refusals all answer
 * RATE_TABLE_INVALID (the message names the field): malformed ids, an
 * unsupported or same-currency pair, a non-positive numerator/denominator,
 * scales outside [0, 8], a blank provenance, malformed or inverted windows.
 */
export function rateRow(input: RateRowInput): RateRow {
  assertRowUuid(input.rowId, 'rowId');
  if (!isCurrency(input.sourceCurrency) || !isCurrency(input.destinationCurrency)) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `unsupported currency in pair ${String(input.sourceCurrency)}/${String(input.destinationCurrency)}`,
      { sourceCurrency: String(input.sourceCurrency), destinationCurrency: String(input.destinationCurrency) },
    );
  }
  if (input.sourceCurrency === input.destinationCurrency) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `a rate row must quote two distinct currencies, got ${input.sourceCurrency} against itself`,
    );
  }
  const numerator = asPositiveBigint(input.numerator, 'numerator');
  const denominator = asPositiveBigint(input.denominator, 'denominator');
  const scaleSource = assertScale(input.scaleSource, input.sourceCurrency, 'scaleSource');
  const scaleDest = assertScale(input.scaleDest, input.destinationCurrency, 'scaleDest');
  const source = input.source.trim();
  if (!source) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      'a rate source is required (provenance is part of the audit trail)',
    );
  }
  const effectiveFrom = normalizeInstant(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo =
    input.effectiveTo === undefined || input.effectiveTo === null
      ? null
      : normalizeInstant(input.effectiveTo, 'effectiveTo');
  if (effectiveTo !== null && effectiveTo < effectiveFrom) {
    throw new DomainError(
      'RATE_TABLE_INVALID',
      `effectiveTo (${effectiveTo}) cannot precede effectiveFrom (${effectiveFrom})`,
    );
  }
  return Object.freeze({
    rowId: input.rowId,
    sourceCurrency: input.sourceCurrency,
    destinationCurrency: input.destinationCurrency,
    numerator,
    denominator,
    scaleSource,
    scaleDest,
    source,
    effectiveFrom,
    effectiveTo,
  });
}

/**
 * Validate a whole rate table: every row must be well-formed (rateRow) and,
 * per source→destination pair, the effective windows must never overlap —
 * two rows for the same pair that share ANY instant (including a shared
 * boundary instant, since windows are inclusive) are refused with
 * RATE_TABLE_OVERLAP. Rows for different pairs may overlap freely.
 */
export function validateRateTable(rows: readonly RateRowInput[]): readonly RateRow[] {
  const built = rows.map((row) => rateRow(row));
  const byPair = new Map<string, RateRow[]>();
  for (const row of built) {
    const key = `${row.sourceCurrency}->${row.destinationCurrency}`;
    const bucket = byPair.get(key);
    if (bucket) bucket.push(row);
    else byPair.set(key, [row]);
  }
  for (const [pair, pairRows] of byPair) {
    const sorted = [...pairRows].sort(
      (a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom) || a.rowId.localeCompare(b.rowId),
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const next = sorted[i]!;
      const overlaps =
        prev.effectiveTo === null /* open-ended swallows everything later */ ||
        next.effectiveFrom <= prev.effectiveTo;
      if (overlaps) {
        throw new DomainError(
          'RATE_TABLE_OVERLAP',
          `rate rows ${prev.rowId} and ${next.rowId} overlap for pair ${pair} ` +
            `(windows [${prev.effectiveFrom}, ${prev.effectiveTo ?? '∞'}) and ` +
            `[${next.effectiveFrom}, ${next.effectiveTo ?? '∞'}))`,
          { pair, rowA: prev.rowId, rowB: next.rowId },
        );
      }
    }
  }
  return built;
}

const toMillis = (iso: string): number => new Date(iso).getTime();

/**
 * Find the ONE row effective for the pair at `now`:
 *  - the pair has no rows at all → RATE_TABLE_PAIR_MISMATCH;
 *  - rows exist but none covers `now` → RATE_TABLE_NO_ACTIVE_ROW;
 *  - more than one row covers `now` → RATE_TABLE_OVERLAP (the caller skipped
 *    validateRateTable; ambiguity is refused, never silently resolved).
 * Window boundaries are inclusive on both ends.
 */
export function findActiveRateRow(
  rows: readonly RateRow[],
  sourceCurrency: Currency,
  destinationCurrency: Currency,
  now: Date,
): RateRow {
  const t = now.getTime();
  const pairRows = rows.filter(
    (r) => r.sourceCurrency === sourceCurrency && r.destinationCurrency === destinationCurrency,
  );
  if (pairRows.length === 0) {
    throw new DomainError(
      'RATE_TABLE_PAIR_MISMATCH',
      `rate table has no row for pair ${sourceCurrency}→${destinationCurrency}`,
      { sourceCurrency, destinationCurrency },
    );
  }
  const active = pairRows.filter(
    (r) =>
      toMillis(r.effectiveFrom) <= t && (r.effectiveTo === null || t <= toMillis(r.effectiveTo)),
  );
  if (active.length === 0) {
    throw new DomainError(
      'RATE_TABLE_NO_ACTIVE_ROW',
      `no ${sourceCurrency}→${destinationCurrency} rate row is effective at ${now.toISOString()}`,
      { sourceCurrency, destinationCurrency, at: now.toISOString() },
    );
  }
  if (active.length > 1) {
    throw new DomainError(
      'RATE_TABLE_OVERLAP',
      `${active.length} rows are effective at once for ${sourceCurrency}→${destinationCurrency} — the table is ambiguous`,
      { sourceCurrency, destinationCurrency, rows: active.map((r) => r.rowId) },
    );
  }
  return active[0]!;
}

// ---------------------------------------------------------------------------
// Exact conversion — ONE banker's rounding
// ---------------------------------------------------------------------------

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * The exact minor→minor rational for a row's source→destination direction.
 * A row quotes 1 source (major) = num/den destination (major), so
 * 1 source-minor = (num/den) × 10^(scaleDest − scaleSource) destination-minor
 * — the scale gap is folded into the rational so the pipeline stays exact.
 */
export function appliedRatio(row: RateRow): { num: bigint; den: bigint } {
  const gap = row.scaleDest - row.scaleSource;
  return gap >= 0
    ? { num: row.numerator * pow10(gap), den: row.denominator }
    : { num: row.numerator, den: row.denominator * pow10(-gap) };
}

/** Exact minor→minor conversion at an explicit rational — ONE banker's rounding. */
export function convertWithRatio(amountMinor: bigint, num: bigint, den: bigint): bigint {
  return divideBankers(amountMinor * num, den);
}

/** Convert across a row's pair — the single conversion rounding of a quote. */
export function convertAcrossCorridor(amountMinor: bigint | number, row: RateRow): bigint {
  const amount = toMinorUnits(amountMinor, 'amountMinor');
  const { num, den } = appliedRatio(row);
  return convertWithRatio(amount, num, den);
}

// ---------------------------------------------------------------------------
// The quote — an immutable, auditable offer
// ---------------------------------------------------------------------------

/** The applied-rate reference every quote (and every settled intent) carries. */
export interface AppliedRate {
  readonly rowId: Uuid;
  readonly source: string;
  /** Quoted ratio in major units: 1 source = numerator/denominator destination. */
  readonly numerator: bigint;
  readonly denominator: bigint;
  /** Exact minor→minor ratio applied BEFORE the single rounding. */
  readonly appliedNumerator: bigint;
  readonly appliedDenominator: bigint;
  readonly scaleSource: number;
  readonly scaleDest: number;
  /** ISO-8601 inclusive window the row was effective in. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export interface FxQuote {
  readonly quoteId: Uuid;
  readonly orgId: Uuid;
  readonly corridorId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly sourceAmountMinor: bigint;
  /** Fee breakdown in SOURCE currency (fees are charged on top). */
  readonly fee: FeeBreakdown;
  /** sourceAmountMinor + fee.totalMinor — the sender's debit. */
  readonly sourceDebitMinor: bigint;
  /** The converted amount the recipient receives. */
  readonly destinationCreditMinor: bigint;
  /** The frozen rate reference (rate audit for R10 postings downstream). */
  readonly rate: AppliedRate;
  /** ISO-8601 */
  readonly issuedAt: string;
  /** ISO-8601 — usable strictly before this instant. */
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export interface QuoteOptions {
  /** Time-to-live in seconds (>= 1); defaults to DEFAULT_QUOTE_TTL_SECONDS. */
  readonly ttlSeconds?: number;
  /** Caller-supplied quote id (preferred); deterministic fallback otherwise. */
  readonly quoteId?: Uuid;
}

export interface QuoteResult {
  readonly quote: FxQuote;
  readonly events: readonly CrossborderEvent[];
}

/**
 * Issue a quote for a corridor amount. Order of refusals:
 *   CORRIDOR_UNKNOWN → CORRIDOR_SUSPENDED → MONEY_NOT_INTEGER / MONEY_NEGATIVE
 *   → AMOUNT_OUT_OF_BOUNDS → QUOTE_TTL_INVALID → RATE_TABLE_INVALID /
 *   RATE_TABLE_OVERLAP → RATE_TABLE_PAIR_MISMATCH / RATE_TABLE_NO_ACTIVE_ROW.
 * Exactly one event: `crossborder.quoteIssued`.
 */
export function quote(
  corridors: readonly Corridor[],
  corridorId: Uuid,
  amountMinor: bigint | number,
  rateTable: readonly RateRowInput[],
  clock: Clock,
  options: QuoteOptions = {},
): QuoteResult {
  const corridor = resolveCorridor(corridors, corridorId);
  assertCorridorLive(corridor);
  const amount = toMinorUnits(amountMinor, 'sourceAmountMinor');
  assertAmountWithinCorridor(corridor, amount);

  const ttlSeconds = options.ttlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new DomainError(
      'QUOTE_TTL_INVALID',
      `ttlSeconds must be a positive safe integer, got ${String(ttlSeconds)}`,
      { ttlSeconds: String(ttlSeconds) },
    );
  }

  const rows = validateRateTable(rateTable);
  const now = clock.now();
  const row = findActiveRateRow(rows, corridor.sourceCurrency, corridor.destinationCurrency, now);

  const fee = computeFeeBreakdown(corridor.feeSchedule, amount);
  const { num, den } = appliedRatio(row);
  const destinationCreditMinor = convertWithRatio(amount, num, den);
  const sourceDebitMinor = amount + fee.totalMinor;

  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
  const quoteId = options.quoteId ?? uuidFromSeed(`quote:${corridorId}:${amount}:${issuedAt}`);

  const rate: AppliedRate = Object.freeze({
    rowId: row.rowId,
    source: row.source,
    numerator: row.numerator,
    denominator: row.denominator,
    appliedNumerator: num,
    appliedDenominator: den,
    scaleSource: row.scaleSource,
    scaleDest: row.scaleDest,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
  });

  const fxQuote: FxQuote = Object.freeze({
    quoteId,
    orgId: corridor.orgId,
    corridorId: corridor.corridorId,
    sourceCurrency: corridor.sourceCurrency,
    destinationCurrency: corridor.destinationCurrency,
    sourceAmountMinor: amount,
    fee,
    sourceDebitMinor,
    destinationCreditMinor,
    rate,
    issuedAt,
    expiresAt,
    ttlSeconds,
  });

  return {
    quote: fxQuote,
    events: [
      quoteIssuedEvent(
        {
          quoteId,
          orgId: corridor.orgId,
          corridorId: corridor.corridorId,
          sourceCurrency: corridor.sourceCurrency,
          destinationCurrency: corridor.destinationCurrency,
          sourceAmountMinor: Number(amount),
          fee: {
            flatMinor: Number(fee.flatMinor),
            bpsMinor: Number(fee.bpsMinor),
            totalMinor: Number(fee.totalMinor),
            bps: fee.bps,
          },
          sourceDebitMinor: Number(sourceDebitMinor),
          destinationCreditMinor: Number(destinationCreditMinor),
          rate: {
            rowId: rate.rowId,
            source: rate.source,
            ratio: `${rate.numerator}/${rate.denominator}`,
            appliedRatio: `${rate.appliedNumerator}/${rate.appliedDenominator}`,
            effectiveFrom: rate.effectiveFrom,
            effectiveTo: rate.effectiveTo,
          },
          issuedAt,
          expiresAt,
          ttlSeconds,
        },
        clock,
      ),
    ],
  };
}

/** Expiry is inclusive-expired: usable strictly BEFORE expiresAt (±1ms tested). */
export function isQuoteExpired(quote: { readonly expiresAt: string }, now: Date): boolean {
  return now.getTime() >= toMillis(quote.expiresAt);
}

/** Gate for every quote consumer — expired quotes answer QUOTE_EXPIRED. */
export function assertQuoteUsable(
  quote: { readonly quoteId: Uuid; readonly expiresAt: string },
  now: Date,
): void {
  if (isQuoteExpired(quote, now)) {
    throw new DomainError(
      'QUOTE_EXPIRED',
      `quote ${quote.quoteId} expired at ${quote.expiresAt} (now ${now.toISOString()})`,
      { quoteId: quote.quoteId, expiresAt: quote.expiresAt },
    );
  }
}

/**
 * The no-cent-created-or-destroyed audit for a quote (R1/R2). Verifies all
 * three ledger identities — fee components sum to the total, source debit is
 * exactly amount + fee, destination credit is exactly the single-rounding
 * conversion of the source amount at the frozen rate. Returns the failed
 * identities as human-readable problems; an empty list means reconciled.
 */
export function reconcileQuoteLegs(
  fxQuote: FxQuote,
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const { fee } = fxQuote;
  if (fee.flatMinor + fee.bpsMinor !== fee.totalMinor) {
    problems.push(
      `fee components ${fee.flatMinor} + ${fee.bpsMinor} do not sum to total ${fee.totalMinor}`,
    );
  }
  if (fxQuote.sourceAmountMinor + fee.totalMinor !== fxQuote.sourceDebitMinor) {
    problems.push(
      `source debit ${fxQuote.sourceDebitMinor} ≠ amount ${fxQuote.sourceAmountMinor} + fee ${fee.totalMinor}`,
    );
  }
  const recomputed = convertWithRatio(
    fxQuote.sourceAmountMinor,
    fxQuote.rate.appliedNumerator,
    fxQuote.rate.appliedDenominator,
  );
  if (recomputed !== fxQuote.destinationCreditMinor) {
    problems.push(
      `destination credit ${fxQuote.destinationCreditMinor} ≠ recomputed conversion ${recomputed}`,
    );
  }
  return { ok: problems.length === 0, problems };
}
