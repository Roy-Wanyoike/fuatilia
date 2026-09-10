/**
 * The production sequence source (issue #129) — the local, outage-tolerant
 * half of the `sequenceSource` port defined by `src/domain/consent/etims.ts`.
 *
 * The domain port is SYNCHRONOUS (`(count: number) => number[]`) and pure I/O
 * lives outside the core; this adapter is the outside. It issues from LOCAL
 * stock — a stack of contiguous KRA-granted bands — so numbering survives
 * KRA outages:
 *
 *   refill()   (async, wiring-driven)  ── KRA VSDC ──▶ a contiguous band of
 *                                                      sequences is granted
 *                                                      (bandId, from, to) and
 *                                                      stacked on the local
 *                                                      checkpoint.
 *   reserve(count)  (sync, the port)   ── local only ─▶ sequences are carved
 *                                                      off the stack and
 *                                                      handed to the domain
 *                                                      formatter. NO network.
 *
 * GAP HANDLING (documented contract — the eTIMS rule is that `invcNo` is a
 * monotonic sequence, never an identifier):
 *   1. Contiguity is structural. Bands stack: every new band for a year must
 *      start exactly at the previous band's end + 1, and the first band of a
 *      year must start at 1. KRA grants that break gapless contiguity are
 *      REFUSED (ETIMS_VSDC_BAND_NONCONTIGUOUS), audited, never activated —
 *      a gap cannot be patched after the fact, so it is never allowed to
 *      open.
 *   2. Outages never create gaps. When the VSDC is unreachable the source
 *      keeps issuing from remaining stock; when stock runs dry it refuses
 *      (ETIMS_STOCK_EXHAUSTED) and queues a refill intent (audited) — it
 *      NEVER borrows from an ungranted range, skips ahead, or reuses
 *      numbers. The wiring retries refill(); numbering resumes exactly
 *      where it stopped when KRA returns.
 *   3. Lost responses are reconciled conservatively. If a refill's HTTP
 *      response is lost after KRA granted a band, the next refill expects
 *      `last.to + 1`; a replay of an already-held grantId is an idempotent
 *      no-op, a DIFFERENT (later) band is refused as non-contiguous — the
 *      hole must be reconciled with KRA out-of-band, not papered over with
 *      a jump.
 *   4. Year rollovers burn, never blend. Bands are year-scoped; when the
 *      clock year moves past the checkpoint's year, ALL remaining stock —
 *      the active band's tail AND any queued bands — is BURNED (one audited
 *      `burned` event per band, reason YEAR_ROLLOVER) and numbering for the
 *      new year resumes only after a new-year band is granted (from = 1).
 *      The year prefix of an issued number therefore always matches the
 *      year its sequence was granted under.
 *   5. Write-ahead reservation. The checkpoint is persisted BEFORE numbers
 *      are handed out — a crash between persist and hand-out can burn tail
 *      sequences but can never double-issue one. If the audit write then
 *      fails, the reservation is refused (ETIMS_AUDIT_WRITE_FAILED) and the
 *      range stays burned — monotonicity outranks completeness.
 *
 * Untrusted LOCAL state: the checkpoint is loaded through the same strict
 * lens as wire data — a structurally invalid checkpoint refuses every
 * reservation (ETIMS_CHECKPOINT_INVALID) until repaired. Fail-closed, never
 * guess.
 *
 * Exact decimal discipline: sequences and counts are safe integers end to
 * end; the only arithmetic is ±1 and range widths on integers < 2^53. No
 * float, no rounding, no coercion.
 *
 * Audit trail: every reservation, burn, band activation, refused grant and
 * queued refill intent is appended to the injected `ReservationAuditTrail`
 * with an ISO instant from the injected Clock. The audit write happens
 * BEFORE the numbers leave the source; an audit failure refuses the
 * reservation.
 */
import { DomainError, type Clock } from '../../domain/shared';
import { ETIMS_ERRORS } from './codes';
import { assertEtimsClock, type EtimsConfig } from './config';
import { createRequestIdMinter, type VsdcBandResult, type VsdcSequenceClient } from './client';
import { ETIMS_MAX_SEQUENCE } from './wire';

// --- ports ---------------------------------------------------------------------

/**
 * The durable local checkpoint. SYNCHRONOUS by contract: reservation is a
 * write-ahead operation — the new checkpoint must be durably committed
 * BEFORE the reserved numbers are handed to the caller. A production wiring
 * backs this with a transactional store (e.g. one UPDATE … RETURNING on the
 * counter row); the in-memory implementation in the specs is for tests only.
 */
export interface SequenceCheckpointStore {
  load(): SequenceCheckpoint | null;
  save(next: SequenceCheckpoint): void;
}

/** One granted band of sequences, inclusive on both ends. */
export interface SequenceBand {
  readonly bandId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Where the next issuance stands.
 *   - `year`  — the issuance year every stacked band was granted for (0 when
 *     no band is active);
 *   - `next`  — the next sequence to issue (0 when no band is active;
 *     `last.to + 1` when the stack is exactly drained — the zero-stock tail);
 *   - `bands` — the active band plus any granted queued bands in issuance
 *     order; an exactly-drained stack keeps its last band as a zero-stock
 *     tail until the successor grant is stacked.
 * With contiguity enforced, the stack is one gapless range: `bands[0]` holds
 * `next`, and `bands[i+1].from === bands[i].to + 1`.
 */
export interface SequenceCheckpoint {
  readonly year: number;
  readonly next: number;
  readonly bands: readonly SequenceBand[];
}

export const EMPTY_CHECKPOINT: SequenceCheckpoint = { year: 0, next: 0, bands: [] };

const BAND_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{5,63}$/;

const isSafeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Validate an UNTRUSTED checkpoint (it may come from a corrupted row, a
 * hand-edited file, a botched migration). Everything else in the source
 * relies on these invariants; anything less than fully valid refuses the
 * world instead of guessing.
 */
export const validateCheckpoint = (raw: unknown): SequenceCheckpoint => {
  if (raw === null || raw === undefined) return EMPTY_CHECKPOINT;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `checkpoint must be an object, got ${typeof raw}`);
  }
  const record = raw as Partial<SequenceCheckpoint>;
  const year = record.year;
  const next = record.next;
  const bands = record.bands;

  if (!Array.isArray(bands)) {
    throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `checkpoint bands must be an array, got ${typeof bands}`);
  }
  if (bands.length === 0) {
    if (year !== 0 || next !== 0) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `an empty band stack must carry year=0 next=0, got ${JSON.stringify({ year, next })}`,
      );
    }
    return EMPTY_CHECKPOINT;
  }

  if (!isSafeInt(year) || year < 1000 || year > 9999) {
    throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `checkpoint year must be a 4-digit year, got ${String(year)}`);
  }

  const validated: SequenceBand[] = bands.map((band, index) => {
    if (typeof band !== 'object' || band === null || Array.isArray(band)) {
      throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `bands[${index}] must be an object`);
    }
    const candidate = band as Partial<SequenceBand>;
    if (typeof candidate.bandId !== 'string' || !BAND_ID_PATTERN.test(candidate.bandId)) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `bands[${index}].bandId must be 6–64 grant-id characters, got ${String(candidate.bandId)}`,
      );
    }
    if (!isSafeInt(candidate.from) || candidate.from < 1 || candidate.from > ETIMS_MAX_SEQUENCE) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `bands[${index}].from must be an integer in [1, ${ETIMS_MAX_SEQUENCE}], got ${String(candidate.from)}`,
      );
    }
    if (!isSafeInt(candidate.to) || candidate.to < candidate.from || candidate.to > ETIMS_MAX_SEQUENCE) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `bands[${index}].to must be an integer in [${String(candidate.from)}, ${ETIMS_MAX_SEQUENCE}], got ${String(candidate.to)}`,
      );
    }
    return { bandId: candidate.bandId, from: candidate.from, to: candidate.to };
  });

  for (let i = 1; i < validated.length; i += 1) {
    const previous = validated[i - 1]!;
    const current = validated[i]!;
    if (current.from !== previous.to + 1) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `band stack must be contiguous: bands[${i}].from ${current.from} does not continue bands[${i - 1}].to ${previous.to}`,
      );
    }
  }

  // Issuance always draws from the ACTIVE band (bands[0]); the stack is
  // gapless, so `next` lives in [active.from, active.to + 1] — the +1 being
  // the exactly-drained zero-stock tail. A `next` inside a LATER band while
  // the active band still holds stock is structurally unreachable and
  // refused (it would skip the active band's remaining sequences).
  const active = validated[0]!;
  if (!isSafeInt(next) || next < active.from || next > active.to + 1) {
    throw new DomainError(
      ETIMS_ERRORS.CHECKPOINT_INVALID,
      `checkpoint next must fall within the active band [${active.from}, ${active.to + 1}], got ${String(next)}`,
    );
  }
  return { year, next, bands: validated };
};

// --- audit trail -----------------------------------------------------------------

/** ISO-8601 instant (from the injected Clock) + a closed event vocabulary. */
export type ReservationAuditEvent =
  | {
      readonly kind: 'band-registered';
      readonly at: string;
      readonly requestId: string;
      readonly bandId: string;
      readonly year: number;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly kind: 'band-register-failed';
      readonly at: string;
      readonly requestId: string;
      readonly code: string;
      readonly retryable: boolean;
      readonly requestedCount: number;
    }
  | {
      readonly kind: 'reserved';
      readonly at: string;
      readonly bandId: string;
      readonly from: number;
      readonly to: number;
      readonly count: number;
    }
  | {
      readonly kind: 'burned';
      readonly at: string;
      readonly bandId: string;
      readonly from: number;
      readonly to: number;
      readonly count: number;
      readonly reason: 'YEAR_ROLLOVER';
    }
  | {
      readonly kind: 'refill-queued';
      readonly at: string;
      readonly requestedCount: number;
      readonly reason: 'STOCK_EXHAUSTED' | 'YEAR_ROLLOVER';
    };

/** The append-only reservation evidence trail (injected; durable in production). */
export interface ReservationAuditTrail {
  append(event: ReservationAuditEvent): void;
}

// --- the source --------------------------------------------------------------------

/** Read-only observability over the source's state (drives the refill loop). */
export interface SourceStats {
  readonly bandId: string;
  /** The active stack's issuance year (0 when no band is active). */
  readonly year: number;
  /** The clock's current year. */
  readonly clockYear: number;
  readonly stockRemaining: number;
  readonly lowWatermark: number;
  /** True when the stock is below the watermark OR the year has rolled. */
  readonly needsRefill: boolean;
}

export type RefillOutcome =
  | { readonly ok: true; readonly outcome: 'already-stocked' }
  | {
      readonly ok: true;
      readonly outcome: 'band-activated' | 'already-active';
      readonly bandId: string;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly ok: false;
      readonly outcome: 'refused';
      readonly code: string;
      readonly retryable: boolean;
      readonly resultCd: string | null;
    };

export interface KraSequenceSourceDeps {
  readonly config: EtimsConfig;
  readonly client: VsdcSequenceClient;
  readonly store: SequenceCheckpointStore;
  readonly audit: ReservationAuditTrail;
  readonly clock: Clock;
}

/**
 * The source object: the port function `(count) => number[]` itself (drop-in
 * for the domain's `createNumberingService`), plus the async `refill()` the
 * wiring drives and the `stats()` view the refill loop polls.
 */
export type KraSequenceSource = ((count: number) => number[]) & {
  refill(): Promise<RefillOutcome>;
  stats(): SourceStats;
};

export const createKraSequenceSource = (deps: KraSequenceSourceDeps): KraSequenceSource => {
  const { config, client, store, audit, clock } = deps;
  // The request-id minter is constructed lazily on first refill: a broken
  // clock must refuse on the paths that read it (reserve/refill/stats), not
  // at wiring construction. Once built, its counter is shared by every later
  // refill of this source, so concurrent refills never share an id.
  let mintRequestId: (() => string) | null = null;

  const loadCheckpoint = (): SequenceCheckpoint => validateCheckpoint(store.load());

  const stockOf = (checkpoint: SequenceCheckpoint): number => {
    if (checkpoint.bands.length === 0) return 0;
    const last = checkpoint.bands[checkpoint.bands.length - 1]!;
    return last.to - checkpoint.next + 1;
  };

  const appendOrThrow = (event: ReservationAuditEvent, context: string): void => {
    try {
      audit.append(event);
    } catch (error: unknown) {
      throw new DomainError(
        ETIMS_ERRORS.AUDIT_WRITE_FAILED,
        `${context}: the reservation audit trail refused the entry (${
          error instanceof Error ? error.message : String(error)
        }) — the reservation is refused and its sequences stay burned`,
        { eventKind: event.kind },
      );
    }
  };

  const assertClockYear = (): { now: Date; year: number } => {
    const now = assertEtimsClock(clock);
    const year = now.getUTCFullYear(); // UTC — same year basis as the domain formatter
    if (year < 1000 || year > 9999) {
      throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `clock year must be a 4-digit year, got ${year}`, { year });
    }
    return { now, year };
  };

  /**
   * Burn ALL stale-year stock (the active band's tail plus every queued
   * band): one write-ahead save, one audited `burned` event per band. Used
   * by reserve() and refill() alike — no path may silently drop a band.
   */
  const burnStaleYear = (checkpoint: SequenceCheckpoint, now: Date, year: number): SequenceCheckpoint => {
    const burned: SequenceBand[] = [];
    let cursor = checkpoint.next;
    for (const band of checkpoint.bands) {
      const from = Math.max(cursor, band.from);
      if (from <= band.to) {
        burned.push({ bandId: band.bandId, from, to: band.to });
      }
      cursor = band.to + 1; // queued bands are fully unconsumed
    }
    store.save(EMPTY_CHECKPOINT); // write-ahead: the burn is durable before anything else
    for (const band of burned) {
      appendOrThrow(
        {
          kind: 'burned',
          at: now.toISOString(),
          bandId: band.bandId,
          from: band.from,
          to: band.to,
          count: band.to - band.from + 1,
          reason: 'YEAR_ROLLOVER',
        },
        `burning ${band.to - band.from + 1} stale-${checkpoint.year} sequence(s) on ${band.bandId}`,
      );
    }
    return EMPTY_CHECKPOINT;
  };

  const reserve = (count: number): number[] => {
    if (!Number.isInteger(count) || count < 1) {
      // Same code string as the domain port — one coherent vocabulary.
      throw new DomainError(ETIMS_ERRORS.COUNT_INVALID, `count must be a positive integer, got ${count}`, { count });
    }
    if (count > config.maxReservation) {
      throw new DomainError(
        ETIMS_ERRORS.COUNT_TOO_LARGE,
        `count ${count} exceeds the configured maximum reservation ${config.maxReservation}`,
        { count, maxReservation: config.maxReservation },
      );
    }
    const { now, year } = assertClockYear();
    let checkpoint = loadCheckpoint();

    if (checkpoint.year !== 0 && checkpoint.year !== year) {
      checkpoint = burnStaleYear(checkpoint, now, year);
    }

    if (checkpoint.bands.length === 0 || checkpoint.year !== year) {
      appendOrThrow(
        { kind: 'refill-queued', at: now.toISOString(), requestedCount: count, reason: 'YEAR_ROLLOVER' },
        'no active band for the clock year',
      );
      throw new DomainError(
        ETIMS_ERRORS.YEAR_ROLLOVER,
        `no sequence band is active for ${year} — a new-year band must be granted via refill() before numbering resumes`,
        { clockYear: year, bandYear: checkpoint.year },
      );
    }

    const stock = stockOf(checkpoint);
    if (stock < count) {
      // Fail-closed outage gap handling: queue the intent, never borrow.
      appendOrThrow(
        { kind: 'refill-queued', at: now.toISOString(), requestedCount: count, reason: 'STOCK_EXHAUSTED' },
        `stock ${stock} below requested ${count}`,
      );
      throw new DomainError(
        ETIMS_ERRORS.STOCK_EXHAUSTED,
        `band stack has ${stock} sequence(s) left, ${count} requested — a refill intent is queued; retry after refill() succeeds`,
        { stock, count },
      );
    }

    const activeBand = checkpoint.bands[0]!;
    const from = checkpoint.next;
    const to = from + (count - 1);
    const newNext = to + 1;
    const remaining = checkpoint.bands.filter((band) => band.to >= newNext);
    // An exactly-drained stack keeps its last band as a zero-stock tail
    // (next = last.to + 1): the tail is what keeps a post-drain refusal a
    // STOCK_EXHAUSTED (never a spurious YEAR_ROLLOVER) and carries `afterSeq`
    // for the successor grant. The successor's stacking compacts it away.
    const consumed: SequenceCheckpoint =
      remaining.length > 0
        ? { year: checkpoint.year, next: newNext, bands: remaining }
        : { year: checkpoint.year, next: newNext, bands: [checkpoint.bands[checkpoint.bands.length - 1]!] };
    store.save(consumed); // write-ahead: persist BEFORE handing numbers out
    appendOrThrow(
      { kind: 'reserved', at: now.toISOString(), bandId: activeBand.bandId, from, to, count },
      `reserving [${from}, ${to}]`,
    );
    return Array.from({ length: count }, (_, i) => from + i);
  };

  const refill = async (): Promise<RefillOutcome> => {
    const { now, year } = assertClockYear();
    let checkpoint = loadCheckpoint();

    // A wiring may call refill() straight through a year boundary — burn the
    // stale stock here too, so no band is ever dropped without evidence.
    // (A zero-stock stale shell burns empty: the drop itself is the evidence.)
    if (checkpoint.year !== 0 && checkpoint.year !== year) {
      checkpoint = burnStaleYear(checkpoint, now, year);
    }

    const stock = stockOf(checkpoint);
    const yearAligned = checkpoint.year === year && checkpoint.bands.length > 0;
    // Config contract: the low watermark is the stock level at or BELOW which
    // the wiring refills — so `already-stocked` requires strictly more stock.
    if (yearAligned && stock > config.lowWatermark) {
      return { ok: true, outcome: 'already-stocked' };
    }

    const lastBand = checkpoint.bands.length > 0 ? checkpoint.bands[checkpoint.bands.length - 1]! : null;
    const expectedFrom = yearAligned && lastBand !== null ? lastBand.to + 1 : 1;
    const requestId = (mintRequestId ??= createRequestIdMinter(clock))();
    const result: VsdcBandResult = await client.registerSequenceBand({
      year,
      count: config.bandSize,
      afterSeq: expectedFrom - 1,
      requestId,
    });

    if (!result.ok) {
      appendOrThrow(
        {
          kind: 'band-register-failed',
          at: now.toISOString(),
          requestId,
          code: result.code,
          retryable: result.retryable,
          requestedCount: config.bandSize,
        },
        `band registration refused (${result.code})`,
      );
      return {
        ok: false,
        outcome: 'refused',
        code: result.code,
        retryable: result.retryable,
        resultCd: result.resultCd,
      };
    }

    const grant = result.grant;

    // Idempotent replay: KRA re-answered with a band we already hold.
    if (yearAligned && checkpoint.bands.some((band) => band.bandId === grant.grantId)) {
      return { ok: true, outcome: 'already-active', bandId: grant.grantId, from: grant.from, to: grant.to };
    }

    // Gapless contiguity: refusing a non-contiguous grant is the only
    // gap-avoidance that cannot be patched after the fact.
    if (grant.from !== expectedFrom) {
      appendOrThrow(
        {
          kind: 'band-register-failed',
          at: now.toISOString(),
          requestId,
          code: ETIMS_ERRORS.VSDC_BAND_NONCONTIGUOUS,
          retryable: false,
          requestedCount: config.bandSize,
        },
        `grant [${grant.from}, ${grant.to}] breaks gapless contiguity (expected from=${expectedFrom})`,
      );
      return {
        ok: false,
        outcome: 'refused',
        code: ETIMS_ERRORS.VSDC_BAND_NONCONTIGUOUS,
        retryable: false,
        resultCd: result.resultCd,
      };
    }

    const newBand: SequenceBand = { bandId: grant.grantId, from: grant.from, to: grant.to };
    // Stacking keeps every band that still carries stock and compacts
    // exactly-drained zero-stock tails away: the successor grant's contiguity
    // (from === last.to + 1) now anchors the stream, and the tail's issuance
    // evidence lives in the audit trail's `reserved` events.
    const stockBearing = checkpoint.bands.filter((band) => band.to >= checkpoint.next);
    const activated: SequenceCheckpoint =
      yearAligned && lastBand !== null
        ? { year, next: checkpoint.next, bands: [...stockBearing, newBand] }
        : { year, next: grant.from, bands: [newBand] };
    store.save(activated); // write-ahead: the band exists locally before anyone can draw from it
    appendOrThrow(
      {
        kind: 'band-registered',
        at: now.toISOString(),
        requestId,
        bandId: grant.grantId,
        year,
        from: grant.from,
        to: grant.to,
      },
      `activating band ${grant.grantId}`,
    );
    return { ok: true, outcome: 'band-activated', bandId: grant.grantId, from: grant.from, to: grant.to };
  };

  const stats = (): SourceStats => {
    const { now, year } = assertClockYear();
    const checkpoint = loadCheckpoint();
    const stock = stockOf(checkpoint);
    const yearAligned = checkpoint.year === year && checkpoint.bands.length > 0;
    return {
      bandId: checkpoint.bands.length > 0 ? checkpoint.bands[0]!.bandId : '',
      year: checkpoint.year,
      clockYear: year,
      stockRemaining: stock,
      lowWatermark: config.lowWatermark,
      needsRefill: !yearAligned || stock <= config.lowWatermark,
    };
  };

  return Object.assign(reserve, { refill, stats });
};
