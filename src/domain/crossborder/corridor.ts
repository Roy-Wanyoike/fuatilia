/**
 * Corridor — org-scoped cross-border configuration (issue #48, SPEC §33).
 *
 * A corridor declares HOW money can move between two currencies:
 *
 *   source currency → destination currency (never the same currency — R10:
 *   cross-currency movement is the whole point; same-currency transfers stay
 *   on the payment products),
 *   [minAmountMinor, maxAmountMinor] bounds in SOURCE currency minor units,
 *   the allowed rails (e.g. 'mpesa_ke_tz', 'bank_swift'),
 *   the per-corridor fee schedule (flat + bps — see ./fees.ts).
 *
 * Rules this module guarantees:
 *  - Corridor mutation is FACT-RECORDED, never silently edited: registration
 *    emits `crossborder.corridorRegistered`, suspension emits
 *    `crossborder.corridorSuspended`. There is no "update" — a changed
 *    corridor is a NEW registration and the old one is suspended (the lane
 *    keeps no edit path; append-only discipline, R3 spirit).
 *  - Money is bigint minor units; the bounds are validated so the corridor
 *    can never authorize a zero or negative transfer, and min can never
 *    exceed max.
 *  - Currency pairs must be two distinct supported currencies (CURRENCIES in
 *    shared/money.ts) — CURRENCY_MISMATCH-class errors downstream guard the
 *    same discipline at intent time.
 *  - Rails are opaque lowercase slugs; the lane never dereferences them.
 *  - Fresh immutable copies everywhere — a registered corridor is frozen and
 *    suspension produces a NEW frozen record, never an in-place edit.
 *
 * Everything is a pure function: no I/O, no RNG, no Date.now() — time only
 * via the injected Clock. Errors are DomainError with stable
 * SCREAMING_SNAKE codes (CORRIDOR_* / AMOUNT_*).
 */
import { CURRENCIES, DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import { toMinorUnits, validateFeeSchedule } from './fees';
import type { FeeSchedule, FeeScheduleInput } from './fees';
import { uuidFromSeed } from './ids';
import { corridorRegisteredEvent, corridorSuspendedEvent, minorToNumber } from './events';
import type { CrossborderEvent } from './events';

/** Rails are lowercase slug identifiers, e.g. 'mpesa_ke_tz', 'bank_swift'. */
export const RAIL_PATTERN = /^[a-z0-9_]{3,40}$/;

export type CorridorStatus = 'active' | 'suspended';

export interface CorridorInput {
  /** Caller-supplied (preferred); deterministic fallback otherwise. */
  readonly corridorId?: Uuid;
  readonly orgId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  /** Source-currency minor units; inclusive lower bound, >= 1. */
  readonly minAmountMinor: bigint | number;
  /** Source-currency minor units; inclusive upper bound, >= min. */
  readonly maxAmountMinor: bigint | number;
  readonly rails: readonly string[];
  readonly feeSchedule: FeeScheduleInput;
}

export interface Corridor {
  readonly corridorId: Uuid;
  readonly orgId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly minAmountMinor: bigint;
  readonly maxAmountMinor: bigint;
  readonly rails: readonly string[];
  readonly feeSchedule: FeeSchedule;
  readonly status: CorridorStatus;
  /** ISO-8601 */
  readonly registeredAt: string;
  /** ISO-8601; null while active. */
  readonly suspendedAt: string | null;
}

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Canonical-UUID shape gate for lane ids (mirrors shared/fx.ts discipline). */
export function assertUuidShape(value: Uuid, field: string, code: string): Uuid {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new DomainError(code, `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value;
}

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value);

/**
 * Register a corridor. Rejects (stable codes): malformed ids
 * (CORRIDOR_ID_MALFORMED), unsupported currencies
 * (CORRIDOR_CURRENCY_UNSUPPORTED), a same-currency pair (CORRIDOR_PAIR_INVALID),
 * bounds that are zero/negative or min > max (CORRIDOR_BOUNDS_INVALID), an
 * empty rail list (CORRIDOR_RAILS_REQUIRED), malformed rails
 * (CORRIDOR_RAIL_INVALID) and an invalid fee schedule (FEE_SCHEDULE_INVALID).
 * Duplicate rails are de-duplicated, not refused.
 */
export function registerCorridor(
  input: CorridorInput,
  clock: Clock,
): { corridor: Corridor; events: readonly CrossborderEvent[] } {
  const corridorId = input.corridorId ?? uuidFromSeed(`corridor:${input.orgId}:${input.sourceCurrency}->${input.destinationCurrency}`);
  assertUuidShape(corridorId, 'corridorId', 'CORRIDOR_ID_MALFORMED');
  assertUuidShape(input.orgId, 'orgId', 'CORRIDOR_ID_MALFORMED');

  if (!isCurrency(input.sourceCurrency) || !isCurrency(input.destinationCurrency)) {
    throw new DomainError(
      'CORRIDOR_CURRENCY_UNSUPPORTED',
      `unsupported currency in pair ${String(input.sourceCurrency)}/${String(input.destinationCurrency)}`,
      { sourceCurrency: String(input.sourceCurrency), destinationCurrency: String(input.destinationCurrency) },
    );
  }
  if (input.sourceCurrency === input.destinationCurrency) {
    throw new DomainError(
      'CORRIDOR_PAIR_INVALID',
      `a corridor must move between two distinct currencies, got ${input.sourceCurrency} against itself`,
    );
  }

  const minAmountMinor = toMinorUnits(input.minAmountMinor, 'minAmountMinor');
  const maxAmountMinor = toMinorUnits(input.maxAmountMinor, 'maxAmountMinor');
  if (minAmountMinor < 1n) {
    throw new DomainError(
      'CORRIDOR_BOUNDS_INVALID',
      `minAmountMinor must be >= 1, got ${minAmountMinor}`,
      { minAmountMinor: minAmountMinor.toString() },
    );
  }
  if (minAmountMinor > maxAmountMinor) {
    throw new DomainError(
      'CORRIDOR_BOUNDS_INVALID',
      `minAmountMinor (${minAmountMinor}) cannot exceed maxAmountMinor (${maxAmountMinor})`,
      { minAmountMinor: minAmountMinor.toString(), maxAmountMinor: maxAmountMinor.toString() },
    );
  }

  const rails: string[] = [];
  for (const rail of input.rails) {
    if (typeof rail !== 'string' || !RAIL_PATTERN.test(rail)) {
      throw new DomainError(
        'CORRIDOR_RAIL_INVALID',
        `rail must match ${RAIL_PATTERN.toString()}, got ${String(rail)}`,
        { rail: String(rail) },
      );
    }
    if (!rails.includes(rail)) rails.push(rail);
  }
  if (rails.length === 0) {
    throw new DomainError('CORRIDOR_RAILS_REQUIRED', 'a corridor must declare at least one rail');
  }

  const feeSchedule = validateFeeSchedule(input.feeSchedule);
  const registeredAt = clock.now().toISOString();

  const corridor: Corridor = Object.freeze({
    corridorId,
    orgId: input.orgId,
    sourceCurrency: input.sourceCurrency,
    destinationCurrency: input.destinationCurrency,
    minAmountMinor,
    maxAmountMinor,
    rails: Object.freeze([...rails]),
    feeSchedule,
    status: 'active',
    registeredAt,
    suspendedAt: null,
  });
  return {
    corridor,
    events: [
      corridorRegisteredEvent(
        {
          corridorId: corridor.corridorId,
          orgId: corridor.orgId,
          sourceCurrency: corridor.sourceCurrency,
          destinationCurrency: corridor.destinationCurrency,
          minAmountMinor: minorToNumber(corridor.minAmountMinor),
          maxAmountMinor: minorToNumber(corridor.maxAmountMinor),
          rails: [...corridor.rails],
          fee: { flatMinor: minorToNumber(corridor.feeSchedule.flatMinor), bps: corridor.feeSchedule.bps },
          registeredAt,
        },
        clock,
      ),
    ],
  };
}

/**
 * Suspend a corridor (active → suspended). Requires an explicit reason
 * (CORRIDOR_REASON_REQUIRED); suspending an already-suspended corridor is
 * refused (CORRIDOR_ALREADY_SUSPENDED) — the first suspension is the fact,
 * repeats would be silent noise. Emits `crossborder.corridorSuspended`.
 */
export function suspendCorridor(
  corridor: Corridor,
  reason: string,
  clock: Clock,
): { corridor: Corridor; events: readonly CrossborderEvent[] } {
  const why = reason.trim();
  if (!why) {
    throw new DomainError(
      'CORRIDOR_REASON_REQUIRED',
      'suspending a corridor requires an explicit reason (R3)',
    );
  }
  if (corridor.status !== 'active') {
    throw new DomainError(
      'CORRIDOR_ALREADY_SUSPENDED',
      `corridor ${corridor.corridorId} is already suspended (at ${corridor.suspendedAt ?? 'unknown'})`,
    );
  }
  const suspendedAt = clock.now().toISOString();
  const next: Corridor = Object.freeze({ ...corridor, status: 'suspended', suspendedAt });
  return {
    corridor: next,
    events: [
      corridorSuspendedEvent(
        { corridorId: corridor.corridorId, orgId: corridor.orgId, reason: why, suspendedAt },
        clock,
      ),
    ],
  };
}

/** Resolve a corridor by id from the caller's registry — unknown → CORRIDOR_UNKNOWN. */
export function resolveCorridor(corridors: readonly Corridor[], corridorId: Uuid): Corridor {
  const corridor = corridors.find((c) => c.corridorId === corridorId);
  if (!corridor) {
    throw new DomainError('CORRIDOR_UNKNOWN', `no corridor registered with id ${corridorId}`, {
      corridorId,
    });
  }
  return corridor;
}

/** A suspended corridor is not quotable / not draftable → CORRIDOR_SUSPENDED. */
export function assertCorridorLive(corridor: Corridor): void {
  if (corridor.status !== 'active') {
    throw new DomainError(
      'CORRIDOR_SUSPENDED',
      `corridor ${corridor.corridorId} (${corridor.sourceCurrency}→${corridor.destinationCurrency}) is suspended`,
      { corridorId: corridor.corridorId },
    );
  }
}

/** Amount must sit inside the corridor's inclusive [min, max] bounds. */
export function assertAmountWithinCorridor(corridor: Corridor, amountMinor: bigint | number): bigint {
  const amount = toMinorUnits(amountMinor, 'sourceAmountMinor');
  if (amount < corridor.minAmountMinor || amount > corridor.maxAmountMinor) {
    throw new DomainError(
      'AMOUNT_OUT_OF_BOUNDS',
      `amount ${amount} is outside corridor ${corridor.corridorId} bounds [${corridor.minAmountMinor}, ${corridor.maxAmountMinor}]`,
      {
        corridorId: corridor.corridorId,
        amountMinor: amount.toString(),
        minAmountMinor: corridor.minAmountMinor.toString(),
        maxAmountMinor: corridor.maxAmountMinor.toString(),
      },
    );
  }
  return amount;
}
