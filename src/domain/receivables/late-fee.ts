/**
 * Late fee accrual (issue #7, review finding H4 — "Late fees missing, common
 * in Kenyan B2B terms").
 *
 * A `LateFeePolicy` describes HOW a customer is penalized for paying late:
 *   - flat:    a fixed minor-unit amount per accrual period
 *   - percent: basis points of the outstanding balance per accrual period
 * both optionally capped, both behind a grace window measured in whole days
 * past the due date.
 *
 * H4 core requirement — IDEMPOTENCE per (receivableId, periodKey): accrual
 * jobs re-run daily and must never double-charge. The caller passes the
 * periodKeys (or full fee rows) already accrued for the receivable; a re-run
 * for a charged period returns outcome 'already_accrued' with the SAME fee
 * (verbatim when the original row is supplied) and NO events.
 *
 * Posting matrix (docs/05): Late fee accrued → Debit AR control / Credit Fee
 * income. The hook travels on both the fee row and the event payload so the
 * ledger module can post without re-deriving it.
 *
 * Everything is a pure function: no I/O, no Date.now(), time only via the
 * injected Clock. Errors are DomainError with stable SCREAMING_SNAKE codes.
 *
 * Event note: `receivable.lateFeeAccrued` is an ADDITION to the 27-event
 * catalog (docs/04) — same envelope, additive by design.
 */
import { DomainError, Money, type Clock, type Currency, type Uuid } from '../shared';
import { domainEvent, minorToNumber, type DomainEvent } from './events';

export type LateFeePolicyKind = 'flat' | 'percent';

/**
 * The accrual policy. `kind` picks the formula; `flatMinor` and `percentBps`
 * are mutually exclusive (validated). Amounts are minor units (cents).
 */
export interface LateFeePolicy {
  readonly kind: LateFeePolicyKind;
  /** kind 'flat' only — fee per accrual period, minor units, integer ≥ 0. */
  readonly flatMinor?: number | bigint;
  /**
   * kind 'percent' only — basis points of the outstanding balance, integer ≥ 0.
   * 150 bps = 1.5 %; 333 bps = 3.33 %. The computed fee is rounded DOWN to the
   * cent (bigint floor division — no floats anywhere near the ledger).
   */
  readonly percentBps?: number;
  /** Per-accrual ceiling in minor units, integer ≥ 0. Optional. */
  readonly capMinor?: number | bigint;
  /**
   * Whole free days after the due date, integer ≥ 0. A fee accrues on the
   * first full day AFTER the grace window: daysLate > graceDays.
   */
  readonly graceDays: number;
}

/** Policy with every optional field resolved + validated (bigint canonical). */
export interface ResolvedLateFeePolicy {
  readonly kind: LateFeePolicyKind;
  readonly flatMinor: bigint | null;
  readonly percentBps: number | null;
  readonly capMinor: bigint | null;
  readonly graceDays: number;
}

/**
 * The slice of a Receivable accrual needs. The real `Receivable` aggregate
 * (./receivable.ts) satisfies this structurally; tests and callers may pass a
 * narrow stand-in. Balance = original − applied (R1 receivable side).
 */
export interface LateFeeReceivableLike {
  readonly id: Uuid;
  readonly currency: Currency;
  readonly dueDate: Date;
  /** Stored overdue flag (docs/03) — eligibility is flag OR past-due date. */
  readonly overdue: boolean;
  readonly original: Money;
  readonly applied: Money;
  /**
   * Optional live-state guard. When present, only 'open' | 'partially_paid'
   * receivables may accrue (never settled / written_off / voided debts). The
   * full Receivable aggregate always carries its state, so flag-based
   * eligibility alone can never charge a conceded debt.
   */
  readonly state?: string;
}

/** docs/05 posting matrix row: Late fee accrued → AR control (Dr) / Fee income (Cr). */
export interface LateFeePosting {
  readonly debit: 'ar_control';
  readonly credit: 'fee_income';
}

/** An accrued late fee — one append-only row per (receivableId, periodKey). */
export interface LateFee {
  readonly receivableId: Uuid;
  /** Caller-defined accrual period (e.g. '2025-08' or '2025-W34'). Idempotency scope. */
  readonly periodKey: string;
  readonly amount: Money;
  readonly currency: Currency;
  readonly policyKind: LateFeePolicyKind;
  readonly percentBps: number | null;
  readonly flatMinor: bigint | null;
  readonly capMinor: bigint | null;
  /** Outstanding balance the fee was computed on (before this fee). */
  readonly balanceMinor: bigint;
  readonly daysLate: number;
  readonly graceDays: number;
  readonly accruedAt: Date;
  readonly posting: LateFeePosting;
}

export interface LateFeeAccruedPayload {
  readonly receivableId: Uuid;
  readonly periodKey: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly policyKind: LateFeePolicyKind;
  readonly percentBps: number | null;
  readonly flatMinor: number | null;
  readonly balanceMinor: number;
  readonly daysLate: number;
  readonly graceDays: number;
  readonly posting: LateFeePosting;
}

export type LateFeeEvent = DomainEvent<'receivable.lateFeeAccrued', LateFeeAccruedPayload>;

export interface LateFeeAccrualOptions {
  readonly clock: Clock;
  /** Caller-defined accrual period key — the idempotency scope. */
  readonly periodKey: string;
  /**
   * Bare periodKeys already charged for this receivable (e.g. read from a
   * unique index). A match short-circuits to outcome 'already_accrued' with no
   * events — never a second charge. On this path the returned fee is
   * recomputed from the CURRENT state while the receivable remains chargeable;
   * once it is no longer chargeable the marker carries a zero amount. Callers
   * needing the historically exact fee should pass `previouslyAccruedFees`.
   */
  readonly previouslyAccruedPeriodKeys?: readonly string[];
  /**
   * Full previously posted fee rows. A periodKey match returns the ORIGINAL
   * fee object verbatim (historically exact even if the balance has since
   * changed) and emits nothing. Takes precedence over the bare keys.
   */
  readonly previouslyAccruedFees?: readonly LateFee[];
}

export interface LateFeeAccrual {
  /**
   * 'accrued' — a new fee was charged this call (exactly one event).
   * 'already_accrued' — this (receivableId, periodKey) was charged before;
   * the same fee is returned / marked and NOTHING is emitted (H4).
   */
  readonly outcome: 'accrued' | 'already_accrued';
  readonly fee: LateFee;
  readonly events: readonly LateFeeEvent[];
}

const DAY_MS = 86_400_000;

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const nonNegativeMinor = (value: number | bigint, code: string, label: string): bigint => {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DomainError(code, `${label} must be a non-negative safe integer, got ${value}`);
    }
    return BigInt(value);
  }
  if (value < 0n) {
    throw new DomainError(code, `${label} must be non-negative, got ${value}`);
  }
  return value;
};

const nonNegativeInt = (value: number, code: string, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(code, `${label} must be a non-negative safe integer, got ${value}`);
  }
  return value;
};

/**
 * Validate a late fee policy and resolve it to canonical bigint minor units.
 * Throws (stable codes):
 *   LATE_FEE_POLICY_KIND_INVALID     — kind is neither 'flat' nor 'percent'
 *   LATE_FEE_POLICY_FLAT_AND_PERCENT — both flatMinor and percentBps supplied
 *   LATE_FEE_POLICY_FLAT_REQUIRED    — kind 'flat' without flatMinor
 *   LATE_FEE_POLICY_PERCENT_REQUIRED — kind 'percent' without percentBps
 *   LATE_FEE_POLICY_FLAT_INVALID     — flatMinor negative / non-integer
 *   LATE_FEE_POLICY_BPS_INVALID      — percentBps negative / non-integer
 *   LATE_FEE_POLICY_CAP_INVALID      — capMinor negative / non-integer
 *   LATE_FEE_POLICY_GRACE_INVALID    — graceDays negative / non-integer
 */
export function validateLateFeePolicy(policy: LateFeePolicy): ResolvedLateFeePolicy {
  if (policy.kind !== 'flat' && policy.kind !== 'percent') {
    throw new DomainError(
      'LATE_FEE_POLICY_KIND_INVALID',
      `late fee policy kind must be 'flat' or 'percent', got ${String(policy.kind)}`,
    );
  }
  const hasFlat = isPresent(policy.flatMinor);
  const hasPercent = isPresent(policy.percentBps);
  if (hasFlat && hasPercent) {
    throw new DomainError(
      'LATE_FEE_POLICY_FLAT_AND_PERCENT',
      'a late fee policy is flat OR percent — both formulas supplied',
    );
  }
  let flatMinor: bigint | null = null;
  let percentBps: number | null = null;
  if (policy.kind === 'flat') {
    if (!hasFlat) {
      throw new DomainError(
        'LATE_FEE_POLICY_FLAT_REQUIRED',
        "a 'flat' late fee policy requires flatMinor",
      );
    }
    flatMinor = nonNegativeMinor(
      policy.flatMinor as number | bigint,
      'LATE_FEE_POLICY_FLAT_INVALID',
      'flatMinor',
    );
  } else {
    if (!hasPercent) {
      throw new DomainError(
        'LATE_FEE_POLICY_PERCENT_REQUIRED',
        "a 'percent' late fee policy requires percentBps",
      );
    }
    percentBps = nonNegativeInt(
      policy.percentBps as number,
      'LATE_FEE_POLICY_BPS_INVALID',
      'percentBps',
    );
  }
  const capMinor = isPresent(policy.capMinor)
    ? nonNegativeMinor(policy.capMinor as number | bigint, 'LATE_FEE_POLICY_CAP_INVALID', 'capMinor')
    : null;
  const graceDays = nonNegativeInt(policy.graceDays, 'LATE_FEE_POLICY_GRACE_INVALID', 'graceDays');
  return { kind: policy.kind, flatMinor, percentBps, capMinor, graceDays };
}

/** Whole floored days past the due date, clamped at 0 (same semantics as aging.ts). */
export const wholeDaysLate = (dueDate: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - dueDate.getTime()) / DAY_MS));

/** Fee amount for a balance: flat, or balance × bps / 10000 floored to the cent, then capped. */
const feeAmountOf = (resolved: ResolvedLateFeePolicy, balanceMinor: bigint): bigint => {
  const uncapped =
    resolved.kind === 'flat'
      ? (resolved.flatMinor as bigint)
      : // bigint floor division — both operands non-negative, so truncation IS floor.
        (balanceMinor * BigInt(resolved.percentBps as number)) / 10_000n;
  if (resolved.capMinor !== null && uncapped > resolved.capMinor) {
    return resolved.capMinor;
  }
  return uncapped;
};

const feePosting: LateFeePosting = { debit: 'ar_control', credit: 'fee_income' };

const buildFeeRow = (
  receivable: LateFeeReceivableLike,
  resolved: ResolvedLateFeePolicy,
  periodKey: string,
  amountMinor: bigint,
  balanceMinor: bigint,
  daysLate: number,
  clock: Clock,
): LateFee => ({
  receivableId: receivable.id,
  periodKey,
  amount: Money.ofMinor(amountMinor, receivable.currency),
  currency: receivable.currency,
  policyKind: resolved.kind,
  percentBps: resolved.percentBps,
  flatMinor: resolved.flatMinor,
  capMinor: resolved.capMinor,
  balanceMinor,
  daysLate,
  graceDays: resolved.graceDays,
  accruedAt: clock.now(),
  posting: feePosting,
});

/**
 * Accrue a late fee for one (receivable, periodKey) — H4.
 *
 * Eligibility (in order; every refusal is a stable DomainError):
 *   1. idempotency: periodKey already accrued → 'already_accrued' marker,
 *      zero events, never a double charge;
 *   2. live debt: when a state is supplied, only open | partially_paid
 *      (LATE_FEE_RECEIVABLE_NOT_LIVE);
 *   3. overdue: stored flag true OR clock strictly past the due date
 *      (LATE_FEE_NOT_OVERDUE);
 *   4. grace: daysLate (whole floored days) must EXCEED graceDays
 *      (LATE_FEE_WITHIN_GRACE);
 *   5. balance: original − applied > 0 (LATE_FEE_ZERO_BALANCE).
 *
 * Amount: flat flatMinor, or balance × percentBps / 10000 rounded DOWN to the
 * cent via bigint floor division (e.g. bps 333 on 123457 minor → 4111), then
 * clamped to capMinor when present. A zero fee is legal (flat 0, cap 0, or a
 * percent that rounds to nothing) and still marks the period as charged.
 */
export function accrueLateFee(
  receivable: LateFeeReceivableLike,
  policy: LateFeePolicy,
  options: LateFeeAccrualOptions,
): LateFeeAccrual {
  const resolved = validateLateFeePolicy(policy);

  const periodKey = options.periodKey.trim();
  if (periodKey.length === 0) {
    throw new DomainError(
      'LATE_FEE_PERIOD_KEY_REQUIRED',
      'a late fee accrual requires a non-blank periodKey (idempotency scope)',
    );
  }

  const postedFees = options.previouslyAccruedFees ?? [];
  const postedKeys = options.previouslyAccruedPeriodKeys ?? [];
  const verbatim = postedFees.find((fee) => fee.periodKey === periodKey);
  const alreadyCharged = verbatim !== undefined || postedKeys.includes(periodKey);

  /** Is anything still chargeable here? Returns the balance when yes. */
  const chargeableBalance = (): Money | null => {
    if (
      receivable.state !== undefined &&
      receivable.state !== 'open' &&
      receivable.state !== 'partially_paid'
    ) {
      return null;
    }
    const now = options.clock.now();
    if (!receivable.overdue && now.getTime() <= receivable.dueDate.getTime()) return null;
    if (wholeDaysLate(receivable.dueDate, now) <= resolved.graceDays) return null;
    try {
      const balance = receivable.original.subtract(receivable.applied);
      return balance.isZero() ? null : balance;
    } catch {
      return null; // corrupt input (applied > original): safe no-charge marker
    }
  };

  // H4: a re-run for an already-charged period NEVER charges again — it
  // returns the same fee (verbatim row when supplied) or a marker, no events.
  if (alreadyCharged) {
    if (verbatim) {
      return { outcome: 'already_accrued', fee: verbatim, events: [] };
    }
    const now = options.clock.now();
    const daysLate = wholeDaysLate(receivable.dueDate, now);
    const balance = chargeableBalance();
    const marker = buildFeeRow(
      receivable,
      resolved,
      periodKey,
      balance === null ? 0n : feeAmountOf(resolved, balance.amount),
      balance === null ? 0n : balance.amount,
      daysLate,
      options.clock,
    );
    return { outcome: 'already_accrued', fee: marker, events: [] };
  }

  if (
    receivable.state !== undefined &&
    receivable.state !== 'open' &&
    receivable.state !== 'partially_paid'
  ) {
    throw new DomainError(
      'LATE_FEE_RECEIVABLE_NOT_LIVE',
      `late fees accrue on live debts only (open | partially_paid), got ${String(receivable.state)}`,
      { receivableId: receivable.id, state: receivable.state },
    );
  }

  const now = options.clock.now();
  if (!receivable.overdue && now.getTime() <= receivable.dueDate.getTime()) {
    throw new DomainError(
      'LATE_FEE_NOT_OVERDUE',
      `receivable ${receivable.id} is not overdue — no fee accrues`,
      { receivableId: receivable.id },
    );
  }

  const daysLate = wholeDaysLate(receivable.dueDate, now);
  if (daysLate <= resolved.graceDays) {
    throw new DomainError(
      'LATE_FEE_WITHIN_GRACE',
      `receivable ${receivable.id} is ${daysLate} day(s) late — inside the ${resolved.graceDays}-day grace window`,
      { receivableId: receivable.id, daysLate, graceDays: resolved.graceDays },
    );
  }

  const balance = receivable.original.subtract(receivable.applied);
  if (balance.isZero()) {
    throw new DomainError(
      'LATE_FEE_ZERO_BALANCE',
      `receivable ${receivable.id} has no outstanding balance to fee`,
      { receivableId: receivable.id },
    );
  }

  const fee = buildFeeRow(
    receivable,
    resolved,
    periodKey,
    feeAmountOf(resolved, balance.amount),
    balance.amount,
    daysLate,
    options.clock,
  );
  const event = domainEvent(
    'receivable.lateFeeAccrued',
    receivable.id,
    {
      receivableId: receivable.id,
      periodKey,
      amountMinor: minorToNumber(fee.amount),
      currency: receivable.currency,
      policyKind: resolved.kind,
      percentBps: resolved.percentBps,
      flatMinor:
        resolved.flatMinor === null
          ? null
          : minorToNumber(Money.ofMinor(resolved.flatMinor, receivable.currency)),
      balanceMinor: minorToNumber(balance),
      daysLate,
      graceDays: resolved.graceDays,
      posting: fee.posting,
    },
    options.clock,
  );
  return { outcome: 'accrued', fee, events: [event] };
}
