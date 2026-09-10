/**
 * The production sequence source (issue #129) — the local, outage-tolerant
 * half of the `sequenceSource` port defined by `src/domain/consent/etims.ts`.
 *
 * The domain port is SYNCHRONOUS (`(count: number) => number[]`) and pure I/O
 * lives outside the core; this adapter is the outside. It works from a LOCAL
 * band of pre-granted sequences, so numbering survives KRA outages:
 *
 *   refill()   (async, wiring-driven)  ── KRA VSDC ──▶ a contiguous band of
 *                                                      sequences is granted
 *                                                      (bandId, from, to) and
 *                                                      persisted as the
 *                                                      checkpoint.
 *   reserve(count)  (sync, the port)   ── local only ─▶ sequences are carved
 *                                                      off the checkpoint and
 *                                                      handed to the domain
 *                                                      formatter. NO network.
 *
 * GAP HANDLING (documented contract — the eTIMS rule is that `invcNo` is a
 * monotonic sequence, never an identifier):
 *   1. Contiguity is structural. A new band for a year is accepted ONLY when
 *      it starts exactly at the previous band's end + 1; the first band of a
 *      year must start at 1. KRA grants that break gapless contiguity are
 *      REFUSED (ETIMS_VSDC_BAND_NONCONTIGUOUS), audited, never activated.
 *   2. Outages never create gaps. When the VSDC is unreachable the source
 *      keeps issuing from remaining stock; when stock runs dry it refuses
 *      (ETIMS_STOCK_EXHAUSTED) and queues a refill intent (audited) — it
 *      NEVER borrows from an ungranted range, skips ahead, or reuses numbers.
 *      The wiring retries refill(); the queued intent is served when KRA
 *      returns, and numbering continues exactly where it stopped.
 *   3. Lost responses are reconciled conservatively. If a refill's HTTP
 *      response is lost after KRA granted a band, the next refill expects
 *      `bandEnd + 1`; a replay of the SAME grantId is an idempotent no-op, a
 *      DIFFERENT (later) band is refused as non-contiguous — the hole must be
 *      reconciled with KRA out-of-band, not papered over with a jump.
 *   4. Year rollovers burn, never blend. Bands are year-scoped; when the
 *      clock year moves past the active band's year the remaining stock is
 *      BURNED (audited with reason YEAR_ROLLOVER) and numbering for the new
 *      year resumes only after a new-year band is granted (from = 1). The
 *      year prefix of an issued number therefore always matches the band the
 *      sequence was granted under.
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
import {
  createRequestIdMinter,
  type VsdcSequenceClient,
  type VsdcBandResult,
} from './client';
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

/**
 * Where the next issuance stands. `bandId: ''` means "no active band" (then
 * `year` is 0 and `next === bandEnd === 0`). Otherwise:
 *   - `year`    — the issuance year the band was granted for;
 *   - `next`    — the next sequence to issue (inclusive);
 *   - `bandEnd` — one PAST the band's last sequence (exclusive).
 */
export interface SequenceCheckpoint {
  readonly bandId: string;
  readonly year: number;
  readonly next: number;
  readonly bandEnd: number;
}

export const EMPTY_CHECKPOINT: SequenceCheckpoint = { bandId: '', year: 0, next: 0, bandEnd: 0 };

const BAND_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{5,63}$/;

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
  const bandId = record.bandId;
  const year = record.year;
  const next = record.next;
  const bandEnd = record.bandEnd;
  const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

  if (bandId === '') {
    // The empty checkpoint must be exactly empty — no half-initialized rows.
    if (year !== 0 || next !== 0 || bandEnd !== 0) {
      throw new DomainError(
        ETIMS_ERRORS.CHECKPOINT_INVALID,
        `empty checkpoint must carry year=0 next=0 bandEnd=0, got ${JSON.stringify({ year, next, bandEnd })}`,
      );
    }
    return EMPTY_CHECKPOINT;
  }
  if (typeof bandId !== 'string' || !BAND_ID_PATTERN.test(bandId)) {
    throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `checkpoint bandId must be 6–64 grant-id characters, got ${String(bandId)}`);
  }
  if (!int(year) || year < 1000 || year > 9999) {
    throw new DomainError(ETIMS_ERRORS.CHECKPOINT_INVALID, `checkpoint year must be a 4-digit year, got ${String(year)}`);
  }
  if (!int(bandEnd) || bandEnd < 1 || bandEnd > ETIMS_MAX_SEQUENCE + 1) {
    throw new DomainError(
      ETIMS_ERRORS.CHECKPOINT_INVALID,
      `checkpoint bandEnd must be an integer in [1, ${ETIMS_MAX_SEQUENCE + 1}], got ${String(bandEnd)}`,
    );
  }
  if (!int(next) || next < 1 || next > bandEnd) {
    throw new DomainError(
      ETIMS_ERRORS.CHECKPOINT_INVALID,
      `checkpoint next must be an integer in [1, ${bandEnd}], got ${String(next)}`,
    );
  }
  return { bandId, year, next, bandEnd };
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
  /** The active band's issuance year (0 when no band is active). */
  readonly year: number;
  /** The clock's current year. */
  readonly clockYear: number;
  readonly stockRemaining: number;
  readonly lowWatermark: number;
  /** True when the stock is at/below the watermark OR the year has rolled. */
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
  const mintRequestId = createRequestIdMinter(clock);

  const stockOf = (checkpoint: SequenceCheckpoint): number =>
    checkpoint.bandId === '' ? 0 : checkpoint.bandEnd - checkpoint.next;

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

  const loadCheckpoint = (): SequenceCheckpoint => validateCheckpoint(store.load());

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
    const now = assertEtimsClock(clock);
    const year = now.getUTCFullYear(); // UTC — same year basis as the domain formatter
    if (year < 1000 || year > 9999) {
      throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `clock year must be a 4-digit year, got ${year}`, { year });
    }

    let checkpoint = loadCheckpoint();

    // Year rollover: burn any remaining stale-year stock before refusing —
    // the burned sequences can never leak into a new-year number.
    if (checkpoint.bandId !== '' && checkpoint.year !== year && checkpoint.next < checkpoint.bandEnd) {
      const burnedFrom = checkpoint.next;
      const burnedTo = checkpoint.bandEnd - 1;
      const burnedCount = burnedTo - burnedFrom + 1;
      const burned: SequenceCheckpoint = { ...checkpoint, next: checkpoint.bandEnd };
      store.save(burned); // write-ahead: the burn is durable before anything else happens
      checkpoint = burned;
      appendOrThrow(
        {
          kind: 'burned',
          at: now.toISOString(),
          bandId: checkpoint.bandId,
          from: burnedFrom,
          to: burnedTo,
          count: burnedCount,
          reason: 'YEAR_ROLLOVER',
        },
        `burning ${burnedCount} stale-${checkpoint.year} sequence(s)`,
      );
    }

    if (checkpoint.bandId === '' || checkpoint.year !== year) {
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
        `band ${checkpoint.bandId} has ${stock} sequence(s) left, ${count} requested — a refill intent is queued; retry after refill() succeeds`,
        { stock, count, bandId: checkpoint.bandId },
      );
    }

    const from = checkpoint.next;
    const to = from + (count - 1);
    const consumed: SequenceCheckpoint = { ...checkpoint, next: to + 1 };
    store.save(consumed); // write-ahead: persist BEFORE handing numbers out
    appendOrThrow(
      { kind: 'reserved', at: now.toISOString(), bandId: checkpoint.bandId, from, to, count },
      `reserving [${from}, ${to}]`,
    );
    return Array.from({ length: count }, (_, i) => from + i);
  };

  const refill = async (): Promise<RefillOutcome> => {
    const now = assertEtimsClock(clock);
    const year = now.getUTCFullYear();
    if (year < 1000 || year > 9999) {
      throw new DomainError(ETIMS_ERRORS.CLOCK_INVALID, `clock year must be a 4-digit year, got ${year}`, { year });
    }
    const checkpoint = loadCheckpoint();
    const stock = stockOf(checkpoint);

    if (checkpoint.bandId !== '' && checkpoint.year === year && stock >= config.lowWatermark) {
      return { ok: true, outcome: 'already-stocked' };
    }

    const sameYearBandActive = checkpoint.bandId !== '' && checkpoint.year === year;
    const expectedFrom = sameYearBandActive ? checkpoint.bandEnd + 1 : 1;
    const requestId = mintRequestId();
    const request = { year, count: config.bandSize, afterSeq: expectedFrom - 1, requestId };

    const result: VsdcBandResult = await client.registerSequenceBand(request);
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
      return { ok: false, outcome: 'refused', code: result.code, retryable: result.retryable, resultCd: result.resultCd };
    }

    const grant = result.grant;

    // Idempotent replay: KRA re-answered with the band we already hold.
    if (sameYearBandActive && grant.grantId === checkpoint.bandId) {
      return { ok: true, outcome: 'already-active', bandId: grant.grantId, from: grant.from, to: grant.to };
    }

    // Gapless contiguity: the only gap-avoidance that cannot be patched after
    // the fact is refusing to ever activate a non-contiguous band.
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

    const activated: SequenceCheckpoint = { bandId: grant.grantId, year, next: grant.from, bandEnd: grant.to + 1 };
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
    const now = assertEtimsClock(clock);
    const clockYear = now.getUTCFullYear();
    const checkpoint = loadCheckpoint();
    const stock = stockOf(checkpoint);
    const yearAligned = checkpoint.bandId !== '' && checkpoint.year === clockYear;
    return {
      bandId: checkpoint.bandId,
      year: checkpoint.year,
      clockYear,
      stockRemaining: stock,
      lowWatermark: config.lowWatermark,
      needsRefill: !yearAligned || stock < config.lowWatermark,
    };
  };

  return Object.assign(reserve, { refill, stats });
};
