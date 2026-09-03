import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  assertAmountWithinCorridor,
  assertCorridorLive,
  registerCorridor,
  resolveCorridor,
  suspendCorridor,
  type Corridor,
} from './corridor';
import { computeFeeBreakdown } from './fees';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(801);

const T0 = '2026-03-01T09:00:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  orgId: ORG,
  sourceCurrency: 'KES' as const,
  destinationCurrency: 'TZS' as const,
  minAmountMinor: 10_000,
  maxAmountMinor: 10_000_000,
  rails: ['mpesa_ke_tz', 'bank_swift'],
  feeSchedule: { flatMinor: 50n, bps: 150 },
  ...overrides,
});

const registered = (overrides: Record<string, unknown> = {}): Corridor =>
  registerCorridor(baseInput(overrides), at(T0)).corridor;

// --- registration -------------------------------------------------------------

describe('registerCorridor', () => {
  it('registers an active corridor with resolved bounds, de-duplicated rails and a frozen record', () => {
    const { corridor } = registerCorridor(
      baseInput({ rails: ['bank_swift', 'mpesa_ke_tz', 'bank_swift'] }),
      at(T0),
    );
    expect(corridor.status).toBe('active');
    expect(corridor.minAmountMinor).toBe(10_000n);
    expect(corridor.maxAmountMinor).toBe(10_000_000n);
    expect(corridor.rails).toEqual(['bank_swift', 'mpesa_ke_tz']);
    expect(corridor.registeredAt).toBe(T0);
    expect(corridor.suspendedAt).toBeNull();
    expect(corridor.feeSchedule).toEqual({ flatMinor: 50n, bps: 150 });
    expect(Object.isFrozen(corridor)).toBe(true);
    expect(Object.isFrozen(corridor.rails)).toBe(true);
  });

  it('honors an explicit corridorId and derives a deterministic fallback otherwise', () => {
    const explicit = registered({ corridorId: uid(802) });
    expect(explicit.corridorId).toBe(uid(802));
    const a = registered();
    const b = registered();
    expect(a.corridorId).toBe(b.corridorId); // same logical input → same id
  });

  it('rejects invalid registrations (validation table)', () => {
    const table: readonly [Record<string, unknown>, string][] = [
      [{ corridorId: 'not-a-uuid' }, 'CORRIDOR_ID_MALFORMED'],
      [{ orgId: 'nope' }, 'CORRIDOR_ID_MALFORMED'],
      [{ sourceCurrency: 'XXX' }, 'CORRIDOR_CURRENCY_UNSUPPORTED'],
      [{ destinationCurrency: 'AED' }, 'CORRIDOR_CURRENCY_UNSUPPORTED'],
      [{ sourceCurrency: 'KES', destinationCurrency: 'KES' }, 'CORRIDOR_PAIR_INVALID'],
      [{ minAmountMinor: 0 }, 'CORRIDOR_BOUNDS_INVALID'],
      [{ minAmountMinor: -5 }, 'MONEY_NEGATIVE'],
      [{ maxAmountMinor: 1.5 }, 'MONEY_NOT_INTEGER'],
      [{ minAmountMinor: 20_000, maxAmountMinor: 10_000 }, 'CORRIDOR_BOUNDS_INVALID'],
      [{ rails: [] }, 'CORRIDOR_RAILS_REQUIRED'],
      [{ rails: ['MPESA!'] }, 'CORRIDOR_RAIL_INVALID'],
      [{ rails: ['ab'] }, 'CORRIDOR_RAIL_INVALID'],
      [{ rails: ['has space'] }, 'CORRIDOR_RAIL_INVALID'],
      [{ feeSchedule: { flatMinor: -1n } }, 'FEE_SCHEDULE_INVALID'],
      [{ feeSchedule: { bps: 10_001 } }, 'FEE_SCHEDULE_INVALID'],
    ];
    for (const [overrides, code] of table) {
      expectCode(() => registerCorridor(baseInput(overrides), at(T0)), code);
    }
  });

  it('emits crossborder.corridorRegistered in the repo envelope with narrow payload', () => {
    const { corridor, events } = registerCorridor(baseInput(), at(T0));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('crossborder.corridorRegistered');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(corridor.corridorId);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toEqual({
      corridorId: corridor.corridorId,
      orgId: ORG,
      sourceCurrency: 'KES',
      destinationCurrency: 'TZS',
      minAmountMinor: 10_000,
      maxAmountMinor: 10_000_000,
      rails: ['mpesa_ke_tz', 'bank_swift'],
      fee: { flatMinor: 50, bps: 150 },
      registeredAt: T0,
    });
  });
});

// --- suspension ----------------------------------------------------------------

describe('suspendCorridor', () => {
  it('flips active → suspended, stamps suspendedAt and emits the fact', () => {
    const corridor = registered();
    const { corridor: suspended, events } = suspendCorridor(corridor, 'rate renegotiation', at(T0));
    expect(suspended.status).toBe('suspended');
    expect(suspended.suspendedAt).toBe(T0);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.name).toBe('crossborder.corridorSuspended');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(corridor.corridorId);
    expect(event.payload).toEqual({
      corridorId: corridor.corridorId,
      orgId: ORG,
      reason: 'rate renegotiation',
      suspendedAt: T0,
    });
  });

  it('requires an explicit reason', () => {
    const corridor = registered();
    expectCode(() => suspendCorridor(corridor, '   ', at(T0)), 'CORRIDOR_REASON_REQUIRED');
    expectCode(() => suspendCorridor(corridor, '', at(T0)), 'CORRIDOR_REASON_REQUIRED');
  });

  it('refuses double suspension and never mutates the original record', () => {
    const corridor = registered();
    const { corridor: once } = suspendCorridor(corridor, 'first', at(T0));
    expectCode(() => suspendCorridor(once, 'second', at(T0)), 'CORRIDOR_ALREADY_SUSPENDED');
    // no-mutation pin: the original active record is untouched
    expect(corridor.status).toBe('active');
    expect(corridor.suspendedAt).toBeNull();
    expect(once.suspendedAt).toBe(T0);
  });
});

// --- resolution & gates ---------------------------------------------------------

describe('resolveCorridor / assertCorridorLive / assertAmountWithinCorridor', () => {
  it('resolves by id and answers CORRIDOR_UNKNOWN for unregistered ids', () => {
    const corridors = [registered()];
    expect(resolveCorridor(corridors, corridors[0]!.corridorId).orgId).toBe(ORG);
    expectCode(() => resolveCorridor(corridors, uid(999)), 'CORRIDOR_UNKNOWN');
  });

  it('admits active corridors and refuses suspended ones', () => {
    const corridor = registered();
    expect(() => assertCorridorLive(corridor)).not.toThrow();
    const { corridor: suspended } = suspendCorridor(corridor, 'risk hold', at(T0));
    expectCode(() => assertCorridorLive(suspended), 'CORRIDOR_SUSPENDED');
  });

  it('enforces the inclusive amount bounds (validation table)', () => {
    const corridor = registered(); // bounds [10_000, 10_000_000]
    const ok: readonly (bigint | number)[] = [10_000n, 10_000_000n, 500_000];
    for (const amount of ok) {
      expect(assertAmountWithinCorridor(corridor, amount)).toBe(BigInt(amount));
    }
    const bad: readonly [bigint | number, string][] = [
      [9_999n, 'AMOUNT_OUT_OF_BOUNDS'],
      [10_000_001n, 'AMOUNT_OUT_OF_BOUNDS'],
      [0n, 'AMOUNT_OUT_OF_BOUNDS'],
      [-1n, 'MONEY_NEGATIVE'],
      [10.5, 'MONEY_NOT_INTEGER'],
    ];
    for (const [amount, code] of bad) {
      expectCode(() => assertAmountWithinCorridor(corridor, amount), code);
    }
  });

  it('keeps the fee schedule usable from the corridor record', () => {
    const corridor = registered();
    const fee = computeFeeBreakdown(corridor.feeSchedule, 1_000_000n);
    expect(fee.totalMinor).toBe(15_050n); // 50 flat + (1_000_000 × 150 bps / 10_000 = 15_000)
  });
});
