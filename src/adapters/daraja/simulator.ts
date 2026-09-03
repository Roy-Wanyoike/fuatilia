/**
 * DarajaSimulator — a pure callback-replay harness (issue #25, F15).
 *
 * Replays Daraja callback fixtures through the payments domain intake and its
 * public transitions — ONLY public domain functions are used; the domain is
 * never modified. It models the channel properties that make Daraja hard
 * (review finding K1, SPEC M-Pesa/Daraja):
 *
 *   - at-least-once delivery: `replayEach` duplicates every callback N times
 *     (optionally `shuffledSchedule`d and delayed) — the intake funnel MUST
 *     stay idempotent under that;
 *   - out-of-order arrival: a schedule is plain data — deliver the
 *     confirmation before the validation, the failure before the success;
 *   - delayed retries: replay copies land at later `atMs` offsets;
 *   - gaps: simply omit a callback — the simulator surfaces what the world
 *     looks like when a callback never arrives.
 *
 * Delivery pipeline per physical callback (the idempotent-consumer pattern):
 *   parse (K1 boundary) → intake (R9 verdict) → [fresh only] result-code
 *   transitions → reconciliation match (C1) → allocation + payment-side
 *   reservations (R2). Duplicates stop right after intake: the E15 tripwire
 *   fires once per duplicate delivery and nothing downstream re-runs.
 *
 * Delivery-status ledger per physical callback:
 *   accepted      — parsed, created a payment, driven to its terminal-ish state
 *   duplicate     — R9 duplicate: E15 tripwire fired, nothing else re-ran
 *   acknowledged  — C2B validation parsed and gate-checked (no money state)
 *   observed      — B2C result parsed as outflow evidence (no inflow command)
 *   rejected      — dead-lettered at the K1 boundary or by a domain guard
 *
 * Pure: no network, no DB, no RNG (shuffle is seeded), no wall clock (the
 * Clock is injected and deterministic). All ids derive deterministically.
 */
import {
  DomainError,
  Money,
} from '../../domain/shared';
import type { Clock, Uuid } from '../../domain/shared';
import {
  intakePayment,
  awaitConfirmation,
  confirmPayment,
  failPayment,
  identifyPayment,
  recordAllocationReservation,
  matchDecision,
  recordMatch,
  uuidFromSeed,
} from '../../domain/payments';
import type { Payment, PaymentEvent, ReconciliationMatch } from '../../domain/payments';
import { executeAllocation } from '../../domain/allocation';
import type { Allocation } from '../../domain/allocation';
import { DARAJA_ERRORS } from './codes';
import { DEFAULT_DARAJA_REGISTRY } from './fixtures';
import type { DarajaFixture, DarajaFixtureRegistry } from './fixtures';
import { parseDarajaCallback } from './wire';
import type { ParsedCallback } from './wire';

export { createFixtureRegistry } from './fixtures';

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

export interface SimClockOptions {
  /** Epoch ms for the first Clock read (inclusive). */
  readonly startMs: number;
  /** Advance per Clock read; default 1000ms. Each domain call reads once. */
  readonly tickMs?: number;
}

/** Deterministic injecting clock — each read advances by tickMs. */
export const createSimClock = (options: SimClockOptions): Clock => {
  const { startMs, tickMs = 1_000 } = options;
  if (!Number.isSafeInteger(startMs)) {
    throw new DomainError(DARAJA_ERRORS.CLOCK_INVALID, `startMs must be a safe integer, got ${String(startMs)}`);
  }
  if (!Number.isSafeInteger(tickMs) || tickMs <= 0) {
    throw new DomainError(DARAJA_ERRORS.CLOCK_INVALID, `tickMs must be a positive integer, got ${String(tickMs)}`);
  }
  let reads = 0;
  return { now: () => new Date(startMs + reads++ * tickMs) };
};

// ---------------------------------------------------------------------------
// Result-code → outcome mapping (SPEC M-Pesa/Daraja: 0 completed, others fail)
// ---------------------------------------------------------------------------

export type StkOutcomeKind = 'completed' | 'abandoned' | 'failed';

export interface StkOutcome {
  readonly kind: StkOutcomeKind;
  /** Domain failureCode for non-zero codes (payment state `failed`). */
  readonly failureCode?: string;
}

/**
 * Observed Daraja STK ResultCodes. 0 → completed; 1/2/1032/1037 → abandoned
 * (user cancelled / timed out); ANY other non-zero code fails closed via the
 * default — an unknown code never maps to money (K1).
 */
export const DARAJA_STK_OUTCOMES: readonly { readonly code: number; readonly outcome: StkOutcome }[] = [
  { code: 0, outcome: { kind: 'completed' } },
  { code: 1, outcome: { kind: 'abandoned', failureCode: 'STK_USER_CANCELLED' } },
  { code: 2, outcome: { kind: 'abandoned', failureCode: 'STK_TIMEOUT' } },
  { code: 1032, outcome: { kind: 'abandoned', failureCode: 'STK_CANCELLED_BY_USER' } },
  { code: 1037, outcome: { kind: 'abandoned', failureCode: 'STK_UNREACHABLE' } },
];

/** Map a wire ResultCode to the domain outcome (safe default: failed). */
export const resultCodeOutcome = (resultCode: number): StkOutcome => {
  const known = DARAJA_STK_OUTCOMES.find((entry) => entry.code === resultCode);
  if (known) return known.outcome;
  return { kind: 'failed', failureCode: `STK_RESULT_${resultCode}` };
};

// ---------------------------------------------------------------------------
// World — the merchant-side context a callback needs to be processable
// ---------------------------------------------------------------------------

export interface SimulatorInvoice {
  /** Stable key; the receivable id derives deterministically from it. */
  readonly key: string;
  readonly invoiceNumber: string;
  /** Outstanding balance in KES minor units (integer). */
  readonly balanceMinor: number | bigint;
  /** Due date as epoch ms (plain data keeps scenarios JSON-serializable). */
  readonly dueDateMs: number;
}

export interface StkInitiation {
  readonly checkoutRequestId: string;
  /** What the merchant asked for (E11) in KES minor units (integer). */
  readonly requestedMinor: number | bigint;
}

export interface SimulatorWorld {
  readonly invoices?: readonly SimulatorInvoice[];
  readonly stkInitiations?: readonly StkInitiation[];
  /** Unmatched confirmed money parks on this customer (C4 unapplied). */
  readonly defaultCustomerId?: string;
}

export interface ResolvedInvoice {
  readonly receivableId: Uuid;
  readonly invoiceNumber: string;
  readonly balanceMinor: Money;
  readonly dueDate: Date;
}

export interface ResolvedWorld {
  readonly invoices: readonly ResolvedInvoice[];
  readonly initiationByCheckoutId: ReadonlyMap<string, { readonly checkoutRequestId: string; readonly requestedMinor: bigint }>;
  readonly defaultCustomerId?: Uuid;
}

const asPositiveMinor = (value: number | bigint, what: string): bigint => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, `${what} must be a safe integer, got ${String(value)}`);
  }
  const minor = typeof value === 'bigint' ? value : BigInt(value);
  if (minor <= 0n) {
    throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, `${what} must be positive, got ${String(value)}`);
  }
  return minor;
};

/** Validate + resolve the plain-data world; misuse → DARAJA_WORLD_INVALID. */
export const resolveWorld = (world: SimulatorWorld): ResolvedWorld => {
  const invoices: ResolvedInvoice[] = (world.invoices ?? []).map((invoice) => {
    if (typeof invoice.key !== 'string' || invoice.key.trim() === '') {
      throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, 'invoice key is required');
    }
    if (typeof invoice.invoiceNumber !== 'string' || invoice.invoiceNumber.trim() === '') {
      throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, `invoice ${invoice.key} needs an invoiceNumber`);
    }
    if (!Number.isSafeInteger(invoice.dueDateMs)) {
      throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, `invoice ${invoice.key} dueDateMs must be an integer`);
    }
    return {
      receivableId: uuidFromSeed(`receivable:${invoice.key}`),
      invoiceNumber: invoice.invoiceNumber,
      balanceMinor: Money.ofMinor(
        asPositiveMinor(invoice.balanceMinor, `invoice ${invoice.key} balanceMinor`),
        'KES',
      ),
      dueDate: new Date(invoice.dueDateMs),
    };
  });
  const seenReceivables = new Set<string>();
  const keysByReceivableId = new Map((world.invoices ?? []).map((invoice) => [
    uuidFromSeed(`receivable:${invoice.key as string}`),
    invoice.key,
  ] as const));
  for (const invoice of invoices) {
    if (seenReceivables.has(invoice.receivableId)) {
      throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, `invoice key "${keysByReceivableId.get(invoice.receivableId) ?? '?'}" appears twice`);
    }
    seenReceivables.add(invoice.receivableId);
  }

  const initiationByCheckoutId = new Map<string, { readonly checkoutRequestId: string; readonly requestedMinor: bigint }>();
  for (const initiation of world.stkInitiations ?? []) {
    if (typeof initiation.checkoutRequestId !== 'string' || initiation.checkoutRequestId.trim() === '') {
      throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, 'stk initiation needs a checkoutRequestId');
    }
    if (initiationByCheckoutId.has(initiation.checkoutRequestId)) {
      throw new DomainError(
        DARAJA_ERRORS.WORLD_INVALID,
        `stk initiation ${initiation.checkoutRequestId} registered twice`,
      );
    }
    initiationByCheckoutId.set(
      initiation.checkoutRequestId,
      {
        checkoutRequestId: initiation.checkoutRequestId,
        requestedMinor: asPositiveMinor(initiation.requestedMinor, `stk initiation ${initiation.checkoutRequestId} requestedMinor`),
      },
    );
  }

  const { defaultCustomerId } = world;
  if (defaultCustomerId !== undefined && (typeof defaultCustomerId !== 'string' || defaultCustomerId.trim() === '')) {
    throw new DomainError(DARAJA_ERRORS.WORLD_INVALID, 'defaultCustomerId must be a non-empty string');
  }
  return {
    invoices,
    initiationByCheckoutId,
    defaultCustomerId:
      defaultCustomerId === undefined ? undefined : uuidFromSeed(`customer:${defaultCustomerId}`),
  };
};

// ---------------------------------------------------------------------------
// Schedules — plain data describing the simulated transport
// ---------------------------------------------------------------------------

export interface Delivery {
  /** Arrival offset from the simulation start, in ms. */
  readonly atMs: number;
  /** Which fixture arrives. */
  readonly fixtureId: string;
}

const isValidDelivery = (delivery: unknown): delivery is Delivery =>
  typeof delivery === 'object' &&
  delivery !== null &&
  typeof (delivery as Delivery).fixtureId === 'string' &&
  (delivery as Delivery).fixtureId.trim() !== '' &&
  Number.isSafeInteger((delivery as Delivery).atMs) &&
  (delivery as Delivery).atMs >= 0;

const assertSchedule = (schedule: readonly Delivery[]): void => {
  if (!Array.isArray(schedule) || !schedule.every(isValidDelivery)) {
    throw new DomainError(
      DARAJA_ERRORS.DELIVERY_INVALID,
      'schedule must be an array of { atMs >= 0, fixtureId } deliveries',
    );
  }
};

/**
 * At-least-once replay: deliver every callback `times` times, copies spaced
 * `gapMs` apart (delayed retries). First-arrival order is preserved.
 */
export const replayEach = (schedule: readonly Delivery[], times: number, gapMs = 1_000): readonly Delivery[] => {
  assertSchedule(schedule);
  if (!Number.isSafeInteger(times) || times < 1) {
    throw new DomainError(DARAJA_ERRORS.DELIVERY_INVALID, `times must be an integer >= 1, got ${String(times)}`);
  }
  if (!Number.isSafeInteger(gapMs) || gapMs < 0) {
    throw new DomainError(DARAJA_ERRORS.DELIVERY_INVALID, `gapMs must be an integer >= 0, got ${String(gapMs)}`);
  }
  const out: Delivery[] = [];
  for (const delivery of schedule) {
    for (let copy = 0; copy < times; copy += 1) {
      out.push({ atMs: delivery.atMs + copy * gapMs, fixtureId: delivery.fixtureId });
    }
  }
  return out;
};

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Deterministic shuffle (seeded Fisher-Yates) — out-of-order arrival. */
export const shuffledSchedule = (schedule: readonly Delivery[], seed: number): readonly Delivery[] => {
  assertSchedule(schedule);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new DomainError(DARAJA_ERRORS.SEED_INVALID, `seed must be a non-negative safe integer, got ${String(seed)}`);
  }
  const out = [...schedule];
  const random = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/** Normalized, wire-serializable record of one domain event. */
export interface RecordedEvent {
  readonly lane: 'payments' | 'allocation';
  readonly name: string;
  readonly version: 1;
  readonly aggregateId: string;
  readonly occurredAt: string; // ISO — payments emit Dates, allocation emits strings
  readonly payload: unknown;
}

export type DeliveryStatus = 'accepted' | 'duplicate' | 'acknowledged' | 'observed' | 'rejected';
export interface DeliveryOutcome {
  readonly atMs: number;
  readonly fixtureId: string;
  readonly status: DeliveryStatus;
  /** e.g. 'c2b:SBK41XQ7RT', 'stk:ws_CO_…' — set when the payload parsed. */
  readonly journeyKey?: string;
  /** Stable code when rejected (DARAJA_* boundary code or a domain code). */
  readonly code?: string;
  readonly detail?: string;
}

export interface SimulationRun {
  readonly payments: readonly Payment[];
  readonly matches: readonly ReconciliationMatch[];
  readonly allocations: readonly Allocation[];
  readonly events: readonly RecordedEvent[];
  readonly deliveries: readonly DeliveryOutcome[];
  /** Deliveries rejected at the K1 boundary or by a domain guard. */
  readonly rejections: readonly DeliveryOutcome[];
  /** payments.duplicateCallbackObserved count — one per duplicate delivery. */
  readonly tripwires: number;
  readonly summary: {
    readonly deliveries: number;
    readonly accepted: number;
    readonly duplicates: number;
    readonly acknowledged: number;
    readonly observed: number;
    readonly rejected: number;
  };
}

export interface SimulateOptions {
  readonly clock: SimClockOptions;
  /** Defaults to the built-in registry. */
  readonly registry?: DarajaFixtureRegistry;
}

const KES = 'KES' as const;

const asRecorded = (
  lane: RecordedEvent['lane'],
  event: {
    readonly name: string;
    readonly version: 1;
    readonly aggregateId: string;
    readonly occurredAt: Date | string;
    readonly payload: unknown;
  },
): RecordedEvent => ({
  lane,
  name: event.name,
  version: event.version,
  aggregateId: event.aggregateId,
  occurredAt:
    event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
  payload: event.payload,
});

const asRecordedPayment = (event: PaymentEvent): RecordedEvent =>
  asRecorded('payments', event);

/** Which parsed kind each fixture family may produce (registry consistency). */
const familyMatchesKind = (fixture: DarajaFixture, parsed: ParsedCallback): boolean =>
  (fixture.family === 'c2b-validation' && parsed.kind === 'c2b-validation') ||
  (fixture.family === 'c2b-confirmation' && parsed.kind === 'c2b-confirmation') ||
  (fixture.family === 'stk-result' && parsed.kind === 'stk-result') ||
  (fixture.family === 'b2c-result' && parsed.kind === 'b2c-result');

const parseOptionsFor = (fixture: DarajaFixture, world: ResolvedWorld): Parameters<typeof parseDarajaCallback>[1] => {
  if (fixture.family === 'c2b-validation' || fixture.family === 'c2b-confirmation') {
    return { c2bKind: fixture.family };
  }
  if (fixture.family === 'stk-result') {
    return { stkRequested: world.initiationByCheckoutId };
  }
  return {};
};

/**
 * Result-code transitions for one fresh payment (0 → completed; non-zero →
 * failed/abandoned). Returns the settled payment and its new events. Throws
 * DomainError on illegal transitions (e.g. a stale failure arriving after the
 * success was already processed) — the caller dead-letters that callback.
 */
const driveResultCode = (
  payment: Payment,
  fixture: DarajaFixture,
  parsed: ParsedCallback,
  clock: Clock,
): { payment: Payment; events: readonly RecordedEvent[] } => {
  const pending = awaitConfirmation(payment).payment;
  if (parsed.kind === 'c2b-confirmation') {
    const landed = Money.ofMinor(parsed.amountMinor, KES);
    const confirmed = confirmPayment(pending, landed, clock);
    return { payment: confirmed.payment, events: confirmed.events.map(asRecordedPayment) };
  }
  if (parsed.kind === 'stk-result') {
    const outcome = resultCodeOutcome(parsed.resultCode);
    if (outcome.kind === 'completed') {
      const landed = Money.ofMinor(parsed.paidMinor ?? parsed.amountMinor, KES);
      const confirmed = confirmPayment(pending, landed, clock);
      return { payment: confirmed.payment, events: confirmed.events.map(asRecordedPayment) };
    }
    const failed = failPayment(pending, outcome.failureCode ?? 'STK_FAILED', clock);
    return { payment: failed.payment, events: failed.events.map(asRecordedPayment) };
  }
  throw new DomainError(
    DARAJA_ERRORS.FIXTURE_INVALID,
    `fixture ${fixture.id} parsed to kind ${parsed.kind} — no result-code transition`,
  );
};

/**
 * Post-confirmation wiring: reconciliation match (C1 — the match points at
 * the Payment) + allocation through the public engine + payment-side
 * reservation rows (R2). Unmatched money parks unapplied on the customer (C4).
 */
const settleConfirmed = (
  payment: Payment,
  world: ResolvedWorld,
  state: {
    clock: Clock;
    payments: Payment[];
    matches: ReconciliationMatch[];
    allocations: Allocation[];
    events: RecordedEvent[];
  },
): void => {
  if (!payment.confirmedMinor) return;
  const decision = matchDecision(payment, world.invoices);
  if (decision.decision !== 'matched') {
    if (world.defaultCustomerId !== undefined) {
      const parked = identifyPayment(payment, world.defaultCustomerId).payment;
      replacePayment(state, payment, parked);
    }
    return;
  }
  const refs =
    payment.declaredRefs.length > 0 ? payment.declaredRefs : [payment.externalRef];
  const matched = recordMatch(payment, refs, 'auto', state.clock);
  state.matches.push(matched.match);
  state.events.push(...matched.events.map(asRecordedPayment));

  const balances = new Map(world.invoices.map((invoice) => [invoice.receivableId, invoice] as const));
  const receivables = decision.candidates.map((candidate) => ({
    receivableId: candidate.receivableId,
    currency: KES,
    balanceMinor: balances.get(candidate.receivableId)!.balanceMinor,
    dueDate: candidate.dueDate,
  }));
  const execution = executeAllocation({
    source: { sourceType: 'payment', sourceId: payment.id, currency: KES, available: payment.confirmedMinor },
    receivables,
    strategy: 'fifo',
    clock: state.clock,
  });
  state.allocations.push(...execution.allocations);
  state.events.push(...execution.events.map((event) => asRecorded('allocation', event)));

  let current = payment;
  for (const row of execution.allocations) {
    current = recordAllocationReservation(
      current,
      { receivableId: row.receivableId, amount: row.amountMinor, allocationId: row.id },
      state.clock,
    ).payment;
  }
  replacePayment(state, payment, current);
};

const replacePayment = (state: { payments: Payment[] }, before: Payment, after: Payment): void => {
  const index = state.payments.indexOf(before);
  if (index >= 0) state.payments[index] = after;
};

/**
 * Run one delivery through the domain. Throws only on HARNESS misuse (unknown
 * fixture id, invalid world/clock); every per-delivery rejection is captured
 * in the outcome ledger (the transport would dead-letter it — K1/SPEC §14).
 */
const processDelivery = (
  delivery: Delivery,
  world: ResolvedWorld,
  state: {
    clock: Clock;
    registry: DarajaFixtureRegistry;
    payments: Payment[];
    matches: ReconciliationMatch[];
    allocations: Allocation[];
    events: RecordedEvent[];
    outcomes: DeliveryOutcome[];
  },
): void => {
  const { registry, outcomes } = state;
  const outcome = (partial: Omit<DeliveryOutcome, 'atMs' | 'fixtureId'>): void => {
    outcomes.push({ atMs: delivery.atMs, fixtureId: delivery.fixtureId, ...partial });
  };
  const reject = (code: string, detail: string, journeyKey?: string): void => {
    outcome({ status: 'rejected', code, detail, journeyKey });
  };

  const fixture = registry.get(delivery.fixtureId); // misuse → DARAJA_FIXTURE_NOT_FOUND

  // 1. K1 boundary: nothing unvalidated ever reaches the domain.
  let parsed: ParsedCallback;
  try {
    parsed = parseDarajaCallback(fixture.payload, parseOptionsFor(fixture, world));
  } catch (error) {
    if (error instanceof DomainError) {
      reject(error.code, error.message);
      return;
    }
    throw error;
  }

  if (!familyMatchesKind(fixture, parsed)) {
    reject(
      DARAJA_ERRORS.FIXTURE_INVALID,
      `fixture ${fixture.id} declares family ${fixture.family} but its payload parses as ${parsed.kind}`,
      parsed.journeyKey,
    );
    return;
  }

  // 2. C2B validation is a pre-acceptance gate: parse it (untrusted!), then
  //    acknowledge. It carries no money semantics — the confirmation callback
  //    is the money fact — so it does NOT go through intake (documented in the
  //    lane README; keeps the E15 tripwire a meaningful ops signal).
  if (fixture.family === 'c2b-validation') {
    outcome({ status: 'acknowledged', journeyKey: parsed.journeyKey });
    return;
  }

  // 3. B2C results are OUTFLOWS — parsed for evidence, never an intake command.
  if (fixture.family === 'b2c-result') {
    outcome({ status: 'observed', journeyKey: parsed.journeyKey });
    return;
  }

  // 4. Intake — the ONE creation funnel (C5). R9 verdict first.
  const command = 'command' in parsed ? parsed.command : undefined;
  if (!command) {
    reject(DARAJA_ERRORS.PAYLOAD_UNRECOGNIZED, 'parsed callback carries no intake command', parsed.journeyKey);
    return;
  }
  let result: ReturnType<typeof intakePayment>;
  try {
    result = intakePayment(command, { clock: state.clock, existing: state.payments });
  } catch (error) {
    if (error instanceof DomainError) {
      reject(error.code, error.message, parsed.journeyKey); // e.g. DUPLICATE_AMOUNT_MISMATCH (tampering)
      return;
    }
    throw error;
  }

  if (result.duplicate) {
    // R9: the tripwire fires ONCE per duplicate delivery; downstream steps
    // (confirm / match / allocate) are gated on the fresh verdict and never
    // re-run — exactly-once processing under at-least-once delivery.
    state.events.push(...result.events.map(asRecordedPayment));
    outcome({ status: 'duplicate', journeyKey: parsed.journeyKey });
    return;
  }

  state.payments.push(result.payment);
  state.events.push(...result.events.map(asRecordedPayment));

  // 5. Result-code transitions.
  try {
    const driven = driveResultCode(result.payment, fixture, parsed, state.clock);
    replacePayment(state, result.payment, driven.payment);
    state.events.push(...driven.events);

    // 6. Reconciliation + allocation on the freshly confirmed payment.
    settleConfirmed(driven.payment, world, state);
  } catch (error) {
    if (error instanceof DomainError) {
      // e.g. a stale failure delivered after success (out-of-order arrival):
      // the transition guard dead-letters the callback, the money stands.
      reject(error.code, error.message, parsed.journeyKey);
      return;
    }
    throw error;
  }

  outcome({ status: 'accepted', journeyKey: parsed.journeyKey });
};

/**
 * Replay a delivery schedule through the domain and return everything that
 * happened: payments, matches, allocations, the full event stream, and a
 * per-delivery outcome ledger.
 */
export const simulate = (
  schedule: readonly Delivery[],
  worldInput: SimulatorWorld,
  options: SimulateOptions,
): SimulationRun => {
  assertSchedule(schedule);
  const world = resolveWorld(worldInput);
  const registry = options.registry ?? DEFAULT_DARAJA_REGISTRY;
  const clock = createSimClock(options.clock);

  // Stable arrival order: by atMs, ties broken by schedule position — the
  // simulator never reorders what the transport delivered.
  const ordered = schedule
    .map((delivery, index) => ({ delivery, index }))
    .sort((a, b) => a.delivery.atMs - b.delivery.atMs || a.index - b.index)
    .map((entry) => entry.delivery);

  const state = {
    clock,
    registry,
    payments: [] as Payment[],
    matches: [] as ReconciliationMatch[],
    allocations: [] as Allocation[],
    events: [] as RecordedEvent[],
    outcomes: [] as DeliveryOutcome[],
  };
  for (const delivery of ordered) processDelivery(delivery, world, state);

  const outcomes = state.outcomes;
  const count = (status: DeliveryStatus): number => outcomes.filter((o) => o.status === status).length;
  return {
    payments: state.payments,
    matches: state.matches,
    allocations: state.allocations,
    events: state.events,
    deliveries: outcomes,
    rejections: outcomes.filter((o) => o.status === 'rejected'),
    tripwires: state.events.filter((event) => event.name === 'payments.duplicateCallbackObserved').length,
    summary: {
      deliveries: outcomes.length,
      accepted: count('accepted'),
      duplicates: count('duplicate'),
      acknowledged: count('acknowledged'),
      observed: count('observed'),
      rejected: count('rejected'),
    },
  };
};
