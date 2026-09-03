/**
 * TransferIntent — the cross-border movement lifecycle (issue #48, SPEC §33).
 *
 * Lifecycle (table-driven — see INTENT_TRANSITIONS; terminal states are
 * empty rows, nothing re-opens them):
 *
 *   drafted   → quoted | cancelled
 *   quoted    → authorized | cancelled | expired
 *   authorized → submitted | cancelled | expired
 *   submitted  → settled | failed | cancelled
 *   settled | cancelled | expired | failed → (terminal)
 *
 * Every state change goes through a dedicated function that carries its own
 * checks and events:
 *
 *   draftIntent     corridor-resolved, live, bounds-checked, currency-exact;
 *                   no event (pre-authorization posture — the dispatch event
 *                   catalog has no intentDrafted; see README deviations)
 *   attachQuote     freezes a quote (amounts, fee breakdown, applied rate,
 *                   expiry) into the intent; drafted → quoted
 *   authorizeIntent re-checks the frozen quote is still live, stamps the
 *                   actor; emits `crossborder.intentAuthorized`
 *   submitIntent    dispatches to a rail under an idempotency key; emits
 *                   `crossborder.intentSubmitted`; duplicate submits REPLAY
 *                   (R9/C5) — see below
 *   settleIntent    records realized legs against the FROZEN quote; emits
 *                   `crossborder.intentSettled`
 *   cancelIntent    withdrawn with reason + actor; `crossborder.intentCancelled`
 *   failIntent      the rail refused/reversed post-submit; `crossborder.intentFailed`
 *   expireIfDue     time-driven quoted/authorized → expired once the frozen
 *                   quote's expiry instant is reached (no event — the
 *                   catalog has no intentExpired; the flip is visible on the
 *                   aggregate, mirroring the collections-lane precedent)
 *
 * Idempotent submit (R9/C5 precedent — unique(intentId, idempotencyKey)):
 *  - a RETRY with the same key and the SAME payload replays to the SAME
 *    outcome: the original submission record is returned with duplicate=true
 *    and the tripwire `crossborder.intentReplayObserved` — observed, never
 *    re-processed;
 *  - a CONFLICTING second submit with the same key (different rail, quote or
 *    amounts) is tampering: refused with INTENT_DUPLICATE_SUBMIT;
 *  - the same key under a DIFFERENT intentId is a different scope and
 *    proceeds normally (the key is unique per intent).
 *
 * Quote frozen at authorization: once the quote is attached, its fee
 * breakdown and rate are IMMUTABLE data on the intent. settleIntent refuses
 * (FEE_SCHEDULE_CHANGED) when the corridor's CURRENT fee schedule no longer
 * reproduces the frozen breakdown — fee changes after authorization are
 * never silently absorbed — and refuses realized legs (INTENT_SETTLEMENT_MISMATCH)
 * that do not reconcile with the frozen amounts: no cent is created or
 * destroyed anywhere (R1/R2).
 *
 * NO fund-truth writes: this lane never allocates or settles receivables; it
 * produces facts other lanes may consume later via events. Everything is a
 * pure function: time only via the injected Clock; no I/O, no RNG, no
 * Date.now(); fresh immutable copies — nothing is mutated in place.
 */
import { CURRENCIES, DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import { computeFeeBreakdown, toMinorUnits } from './fees';
import type { FeeBreakdown } from './fees';
import { uuidFromSeed } from './ids';
import {
  assertAmountWithinCorridor,
  assertCorridorLive,
  assertUuidShape,
  resolveCorridor,
} from './corridor';
import type { Corridor } from './corridor';
import { assertQuoteUsable } from './quote';
import type { AppliedRate, FxQuote } from './quote';
import {
  intentAuthorizedEvent,
  intentCancelledEvent,
  intentFailedEvent,
  intentReplayObservedEvent,
  intentSettledEvent,
  intentSubmittedEvent,
  minorToNumber,
  feeBreakdownPayload,
  appliedRatePayload,
} from './events';
import type { CrossborderEvent } from './events';

// --- lifecycle ---------------------------------------------------------------

export type IntentStatus =
  | 'drafted'
  | 'quoted'
  | 'authorized'
  | 'submitted'
  | 'settled'
  | 'cancelled'
  | 'expired'
  | 'failed';

/**
 * The legal-transition table, in one place so the lifecycle and the code
 * cannot drift. Rows are `from`, entries are the legal `to` states.
 * Deliberately NOT legal:
 *  - skipping `quoted` (an intent must freeze a quote before authorization);
 *  - submitting from anything but `authorized` (the quote gate lives there);
 *  - expiry out of `drafted` (no quote → no expiry clock) or out of
 *    `submitted` (an in-flight transfer settles, fails or is cancelled —
 *    its rate is already locked);
 *  - any transition out of a terminal state (settled/cancelled/expired/failed).
 */
export const INTENT_TRANSITIONS: Readonly<Record<IntentStatus, readonly IntentStatus[]>> = {
  drafted: ['quoted', 'cancelled'],
  quoted: ['authorized', 'cancelled', 'expired'],
  authorized: ['submitted', 'cancelled', 'expired'],
  submitted: ['settled', 'failed', 'cancelled'],
  settled: [],
  cancelled: [],
  expired: [],
  failed: [],
};

const canTransition = (from: IntentStatus, to: IntentStatus): boolean =>
  (INTENT_TRANSITIONS[from] ?? []).includes(to);

// --- aggregate ---------------------------------------------------------------

/** The quote data frozen into the intent at attach — immutable from then on. */
export interface FrozenQuote {
  readonly quoteId: Uuid;
  readonly fee: FeeBreakdown;
  readonly sourceDebitMinor: bigint;
  readonly destinationCreditMinor: bigint;
  readonly rate: AppliedRate;
  /** ISO-8601 */
  readonly issuedAt: string;
  /** ISO-8601 — the expiry that gates quoted/authorized → expired. */
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

export interface TransferIntent {
  readonly intentId: Uuid;
  readonly orgId: Uuid;
  readonly corridorId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly sourceAmountMinor: bigint;
  readonly status: IntentStatus;
  /** Frozen at attach (drafted → quoted); null only while drafted. */
  readonly quote: FrozenQuote | null;
  /** Rail frozen at submit; null before. */
  readonly rail: string | null;
  readonly authorizedBy: string | null;
  /** ISO-8601 stamps — null until the transition happens. */
  readonly createdAt: string;
  readonly quotedAt: string | null;
  readonly authorizedAt: string | null;
  readonly submittedAt: string | null;
  readonly settledAt: string | null;
  readonly cancelledAt: string | null;
  readonly failedAt: string | null;
  readonly expiredAt: string | null;
  /** Opaque rail settlement reference, stamped at settlement. */
  readonly settlementRef: string | null;
}

const freezeIntent = (intent: TransferIntent): TransferIntent => Object.freeze(intent);

// --- draft ---------------------------------------------------------------------

export interface DraftIntentCommand {
  readonly orgId: Uuid;
  /** Must match the corridor exactly — CURRENCY_MISMATCH otherwise. */
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly sourceAmountMinor: bigint | number;
  /** Caller-supplied (preferred); deterministic fallback otherwise. */
  readonly intentId?: Uuid;
}

export interface DraftIntentResult {
  readonly intent: TransferIntent;
  /** Drafting is pre-authorization posture — no event (see module doc). */
  readonly events: readonly CrossborderEvent[];
}

/**
 * Draft a transfer intent against a corridor. Refusals, in order:
 * CORRIDOR_UNKNOWN → CORRIDOR_SUSPENDED → CURRENCY_UNSUPPORTED →
 * CURRENCY_MISMATCH → MONEY_NOT_INTEGER / MONEY_NEGATIVE →
 * AMOUNT_OUT_OF_BOUNDS.
 */
export function draftIntent(
  corridors: readonly Corridor[],
  corridorId: Uuid,
  cmd: DraftIntentCommand,
  clock: Clock,
): DraftIntentResult {
  const corridor = resolveCorridor(corridors, corridorId);
  assertCorridorLive(corridor);
  assertUuidShape(cmd.orgId, 'orgId', 'INTENT_ID_MALFORMED');
  assertUuidShape(corridorId, 'corridorId', 'INTENT_ID_MALFORMED');

  if (
    !(CURRENCIES as readonly string[]).includes(cmd.sourceCurrency) ||
    !(CURRENCIES as readonly string[]).includes(cmd.destinationCurrency)
  ) {
    throw new DomainError(
      'CURRENCY_UNSUPPORTED',
      `unsupported currency in pair ${String(cmd.sourceCurrency)}/${String(cmd.destinationCurrency)}`,
      { sourceCurrency: String(cmd.sourceCurrency), destinationCurrency: String(cmd.destinationCurrency) },
    );
  }
  if (cmd.sourceCurrency !== corridor.sourceCurrency || cmd.destinationCurrency !== corridor.destinationCurrency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `intent pair ${cmd.sourceCurrency}/${cmd.destinationCurrency} does not match corridor pair ` +
        `${corridor.sourceCurrency}/${corridor.destinationCurrency}`,
      { sourceCurrency: cmd.sourceCurrency, destinationCurrency: cmd.destinationCurrency },
    );
  }
  const amount = assertAmountWithinCorridor(corridor, cmd.sourceAmountMinor);

  const intentId = cmd.intentId ?? uuidFromSeed(`intent:${cmd.orgId}:${corridorId}:${amount}`);
  const intent: TransferIntent = freezeIntent({
    intentId,
    orgId: cmd.orgId,
    corridorId,
    sourceCurrency: cmd.sourceCurrency,
    destinationCurrency: cmd.destinationCurrency,
    sourceAmountMinor: amount,
    status: 'drafted',
    quote: null,
    rail: null,
    authorizedBy: null,
    createdAt: clock.now().toISOString(),
    quotedAt: null,
    authorizedAt: null,
    submittedAt: null,
    settledAt: null,
    cancelledAt: null,
    failedAt: null,
    expiredAt: null,
    settlementRef: null,
  });
  return { intent, events: [] };
}

// --- quote attach ------------------------------------------------------------

const toMillis = (iso: string): number => new Date(iso).getTime();

function frozenQuoteOf(quote: FxQuote): FrozenQuote {
  return Object.freeze({
    quoteId: quote.quoteId,
    fee: quote.fee,
    sourceDebitMinor: quote.sourceDebitMinor,
    destinationCreditMinor: quote.destinationCreditMinor,
    rate: quote.rate,
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    ttlSeconds: quote.ttlSeconds,
  });
}

export interface AttachQuoteResult {
  readonly intent: TransferIntent;
  /** Issuance is already observable via `crossborder.quoteIssued`. */
  readonly events: readonly CrossborderEvent[];
}

/**
 * Freeze a quote into a drafted intent (drafted → quoted). The quote must
 * belong to the same org + corridor, carry the same pair and amount, and
 * still be live (QUOTE_EXPIRED at the boundary instant). Refusals:
 * INTENT_STATE_INVALID (wrong status / re-attach), QUOTE_ORG_MISMATCH,
 * QUOTE_CORRIDOR_MISMATCH, QUOTE_AMOUNT_MISMATCH, CURRENCY_MISMATCH,
 * QUOTE_EXPIRED.
 */
export function attachQuote(intent: TransferIntent, quote: FxQuote, clock: Clock): AttachQuoteResult {
  if (intent.status !== 'drafted') {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot attach a quote to an intent in status ${intent.status}; only drafted intents accept quotes`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  if (quote.orgId !== intent.orgId) {
    throw new DomainError(
      'QUOTE_ORG_MISMATCH',
      `quote ${quote.quoteId} belongs to org ${quote.orgId}, intent to ${intent.orgId}`,
    );
  }
  if (quote.corridorId !== intent.corridorId) {
    throw new DomainError(
      'QUOTE_CORRIDOR_MISMATCH',
      `quote ${quote.quoteId} was issued against corridor ${quote.corridorId}, intent targets ${intent.corridorId}`,
      { quoteId: quote.quoteId, corridorId: intent.corridorId },
    );
  }
  if (quote.sourceAmountMinor !== intent.sourceAmountMinor) {
    throw new DomainError(
      'QUOTE_AMOUNT_MISMATCH',
      `quote ${quote.quoteId} covers ${quote.sourceAmountMinor}, intent moves ${intent.sourceAmountMinor}`,
      { quoteId: quote.quoteId },
    );
  }
  if (quote.sourceCurrency !== intent.sourceCurrency || quote.destinationCurrency !== intent.destinationCurrency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `quote pair ${quote.sourceCurrency}/${quote.destinationCurrency} does not match intent pair ` +
        `${intent.sourceCurrency}/${intent.destinationCurrency}`,
    );
  }
  assertQuoteUsable(quote, clock.now());

  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'quoted',
    quote: frozenQuoteOf(quote),
    quotedAt: clock.now().toISOString(),
  });
  return { intent: next, events: [] };
}

// --- authorize -----------------------------------------------------------------

export interface AuthorizeIntentResult {
  readonly intent: TransferIntent;
  readonly events: readonly CrossborderEvent[];
}

/**
 * Authorize a quoted intent (quoted → authorized): the frozen quote must
 * still be live at the authorization instant (QUOTE_EXPIRED at the boundary),
 * and the actor is mandatory (INTENT_ACTOR_REQUIRED). Emits
 * `crossborder.intentAuthorized` carrying the FROZEN fee breakdown and rate —
 * the audit proof that what was authorized is what settles.
 */
export function authorizeIntent(
  intent: TransferIntent,
  cmd: { readonly authorizedBy: string },
  clock: Clock,
): AuthorizeIntentResult {
  if (intent.status !== 'quoted') {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot authorize an intent in status ${intent.status}; only quoted intents can be authorized`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  const actor = cmd.authorizedBy.trim();
  if (!actor) {
    throw new DomainError(
      'INTENT_ACTOR_REQUIRED',
      'authorizing a transfer intent requires an explicit actor (R3)',
    );
  }
  if (!intent.quote) {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `intent ${intent.intentId} has no frozen quote — authorization is impossible`,
      { intentId: intent.intentId },
    );
  }
  assertQuoteUsable(intent.quote, clock.now());

  const now = clock.now().toISOString();
  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'authorized',
    authorizedBy: actor,
    authorizedAt: now,
  });
  const quote = intent.quote;
  return {
    intent: next,
    events: [
      intentAuthorizedEvent(
        {
          intentId: intent.intentId,
          orgId: intent.orgId,
          corridorId: intent.corridorId,
          quoteId: quote.quoteId,
          sourceAmountMinor: minorToNumber(intent.sourceAmountMinor),
          sourceCurrency: intent.sourceCurrency,
          destinationCurrency: intent.destinationCurrency,
          fee: feeBreakdownPayload(quote.fee),
          sourceDebitMinor: minorToNumber(quote.sourceDebitMinor),
          destinationCreditMinor: minorToNumber(quote.destinationCreditMinor),
          rate: appliedRatePayload(quote.rate),
          authorizedBy: actor,
          authorizedAt: now,
        },
        clock,
      ),
    ],
  };
}

// --- submit ---------------------------------------------------------------------

export interface SubmissionRecord {
  readonly intentId: Uuid;
  readonly idempotencyKey: string;
  readonly rail: string;
  readonly quoteId: Uuid;
  readonly sourceDebitMinor: bigint;
  readonly destinationCreditMinor: bigint;
  /** ISO-8601 */
  readonly submittedAt: string;
}

export interface SubmitCommand {
  /** unique(intentId, idempotencyKey) — R9/C5. */
  readonly idempotencyKey: string;
  /** Must be one of the corridor's rails; frozen onto the intent. */
  readonly rail: string;
}

export interface SubmitContext {
  readonly clock: Clock;
  readonly corridor: Corridor;
  /** Prior submissions for idempotency (unique(intentId, idempotencyKey)). */
  readonly submissions?: readonly SubmissionRecord[];
}

export interface SubmitResult {
  readonly intent: TransferIntent; // unchanged on duplicates
  readonly submission: SubmissionRecord; // the original on duplicates
  readonly duplicate: boolean;
  readonly events: readonly CrossborderEvent[];
}

/**
 * Submit an authorized intent to a rail. Refusals, in order:
 * INTENT_IDEMPOTENCY_KEY_REQUIRED (blank key) → replay handling →
 * INTENT_STATE_INVALID → CORRIDOR_SUSPENDED → INTENT_RAIL_INVALID →
 * QUOTE_EXPIRED.
 *
 * Idempotency (R9/C5): a used key replays the ORIGINAL outcome (duplicate=true
 * + `crossborder.intentReplayObserved`) when the retry is identical; a
 * conflicting payload under the same key is refused INTENT_DUPLICATE_SUBMIT.
 */
export function submitIntent(
  intent: TransferIntent,
  cmd: SubmitCommand,
  ctx: SubmitContext,
): SubmitResult {
  const idempotencyKey = cmd.idempotencyKey.trim();
  if (!idempotencyKey) {
    throw new DomainError(
      'INTENT_IDEMPOTENCY_KEY_REQUIRED',
      'idempotencyKey is required for submission (R9)',
    );
  }

  // R9/C5: a retry with a used key is the SAME logical submit — replay the
  // original outcome and observe (never re-process) the duplicate.
  const prior = (ctx.submissions ?? []).find(
    (s) => s.intentId === intent.intentId && s.idempotencyKey === idempotencyKey,
  );
  if (prior) {
    const quote = intent.quote;
    const identical =
      prior.rail === cmd.rail &&
      quote !== null &&
      prior.quoteId === quote.quoteId &&
      prior.sourceDebitMinor === quote.sourceDebitMinor &&
      prior.destinationCreditMinor === quote.destinationCreditMinor;
    if (!identical) {
      throw new DomainError(
        'INTENT_DUPLICATE_SUBMIT',
        `idempotency key "${idempotencyKey}" was already used for intent ${intent.intentId} ` +
          'with a different payload — conflicting submits are refused',
        { intentId: intent.intentId, idempotencyKey },
      );
    }
    return {
      intent,
      submission: prior,
      duplicate: true,
      events: [
        intentReplayObservedEvent(
          {
            intentId: intent.intentId,
            idempotencyKey,
            quoteId: prior.quoteId,
            seenAt: ctx.clock.now().toISOString(),
          },
          ctx.clock,
        ),
      ],
    };
  }

  if (intent.status !== 'authorized') {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot submit an intent in status ${intent.status}; only authorized intents can be submitted`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  assertCorridorLive(ctx.corridor);
  const rail = cmd.rail.trim();
  if (!ctx.corridor.rails.includes(rail)) {
    throw new DomainError(
      'INTENT_RAIL_INVALID',
      `rail "${rail}" is not allowed on corridor ${ctx.corridor.corridorId} (allowed: ${ctx.corridor.rails.join(', ')})`,
      { corridorId: ctx.corridor.corridorId, rail },
    );
  }
  if (!intent.quote) {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `intent ${intent.intentId} has no frozen quote — submission is impossible`,
      { intentId: intent.intentId },
    );
  }
  assertQuoteUsable(intent.quote, ctx.clock.now());

  const quote = intent.quote;
  const submittedAt = ctx.clock.now().toISOString();
  const submission: SubmissionRecord = Object.freeze({
    intentId: intent.intentId,
    idempotencyKey,
    rail,
    quoteId: quote.quoteId,
    sourceDebitMinor: quote.sourceDebitMinor,
    destinationCreditMinor: quote.destinationCreditMinor,
    submittedAt,
  });
  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'submitted',
    rail,
    submittedAt,
  });
  return {
    intent: next,
    submission,
    duplicate: false,
    events: [
      intentSubmittedEvent(
        {
          intentId: intent.intentId,
          orgId: intent.orgId,
          corridorId: intent.corridorId,
          quoteId: quote.quoteId,
          rail,
          idempotencyKey,
          sourceDebitMinor: minorToNumber(quote.sourceDebitMinor),
          destinationCreditMinor: minorToNumber(quote.destinationCreditMinor),
          submittedAt,
        },
        ctx.clock,
      ),
    ],
  };
}

// --- settle ---------------------------------------------------------------------

export interface SettleContext {
  readonly clock: Clock;
  /**
   * When supplied, the corridor's CURRENT fee schedule must still reproduce
   * the frozen breakdown — a fee change after authorization is refused
   * (FEE_SCHEDULE_CHANGED), never silently absorbed.
   */
  readonly corridor?: Corridor;
  /** Realized legs reported by the rail; must reconcile with the frozen quote. */
  readonly realizedSourceDebitMinor?: bigint | number;
  readonly realizedDestinationCreditMinor?: bigint | number;
  /** Opaque rail settlement reference. */
  readonly settlementRef?: string;
}

export interface SettleResult {
  readonly intent: TransferIntent;
  readonly events: readonly CrossborderEvent[];
}

/**
 * Settle a submitted intent (submitted → settled). The settled legs are the
 * FROZEN quote's legs; caller-reported realized amounts must match them
 * exactly (INTENT_SETTLEMENT_MISMATCH — no cent created or destroyed, R1/R2),
 * and a corridor whose fee schedule drifted since authorization is refused
 * (FEE_SCHEDULE_CHANGED). Emits `crossborder.intentSettled` referencing the
 * quote used (rate audit for downstream FX postings).
 */
export function settleIntent(intent: TransferIntent, ctx: SettleContext): SettleResult {
  if (intent.status !== 'submitted') {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot settle an intent in status ${intent.status}; only submitted intents settle`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  const quote = intent.quote;
  if (!quote) {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `intent ${intent.intentId} has no frozen quote — settlement is impossible`,
      { intentId: intent.intentId },
    );
  }

  if (ctx.corridor) {
    const current = computeFeeBreakdown(ctx.corridor.feeSchedule, intent.sourceAmountMinor);
    const frozen = quote.fee;
    const drifted =
      current.flatMinor !== frozen.flatMinor ||
      current.bpsMinor !== frozen.bpsMinor ||
      current.totalMinor !== frozen.totalMinor ||
      current.bps !== frozen.bps;
    if (drifted) {
      throw new DomainError(
        'FEE_SCHEDULE_CHANGED',
        `corridor ${ctx.corridor.corridorId} fee schedule changed since authorization ` +
          `(frozen total ${frozen.totalMinor}, current ${current.totalMinor}) — the frozen quote governs; requote to move at new fees`,
        { intentId: intent.intentId, corridorId: ctx.corridor.corridorId },
      );
    }
  }

  if (ctx.realizedSourceDebitMinor !== undefined) {
    const realized = toMinorUnits(ctx.realizedSourceDebitMinor, 'realizedSourceDebitMinor');
    if (realized !== quote.sourceDebitMinor) {
      throw new DomainError(
        'INTENT_SETTLEMENT_MISMATCH',
        `realized source debit ${realized} does not reconcile with the frozen quote (${quote.sourceDebitMinor})`,
        { intentId: intent.intentId },
      );
    }
  }
  if (ctx.realizedDestinationCreditMinor !== undefined) {
    const realized = toMinorUnits(ctx.realizedDestinationCreditMinor, 'realizedDestinationCreditMinor');
    if (realized !== quote.destinationCreditMinor) {
      throw new DomainError(
        'INTENT_SETTLEMENT_MISMATCH',
        `realized destination credit ${realized} does not reconcile with the frozen quote (${quote.destinationCreditMinor})`,
        { intentId: intent.intentId },
      );
    }
  }

  const settledAt = ctx.clock.now().toISOString();
  const settlementRef = ctx.settlementRef ?? null;
  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'settled',
    settledAt,
    settlementRef,
  });
  return {
    intent: next,
    events: [
      intentSettledEvent(
        {
          intentId: intent.intentId,
          corridorId: intent.corridorId,
          quoteId: quote.quoteId,
          sourceCurrency: intent.sourceCurrency,
          destinationCurrency: intent.destinationCurrency,
          sourceDebitMinor: minorToNumber(quote.sourceDebitMinor),
          destinationCreditMinor: minorToNumber(quote.destinationCreditMinor),
          settlementRef,
          settledAt,
        },
        ctx.clock,
      ),
    ],
  };
}

// --- cancel / fail / expire ------------------------------------------------------

function assertReason(reason: string, op: string): string {
  const why = reason.trim();
  if (!why) {
    throw new DomainError(
      'INTENT_REASON_REQUIRED',
      `${op} an intent requires an explicit reason (R3)`,
    );
  }
  return why;
}

function assertActor(actorId: string, op: string): string {
  const actor = actorId.trim();
  if (!actor) {
    throw new DomainError(
      'INTENT_ACTOR_REQUIRED',
      `${op} an intent requires an explicit actor (R3)`,
    );
  }
  return actor;
}

export interface CancelIntentResult {
  readonly intent: TransferIntent;
  readonly events: readonly CrossborderEvent[];
}

/** Withdraw an intent (any non-terminal, non-settled state → cancelled). */
export function cancelIntent(
  intent: TransferIntent,
  cmd: { readonly reason: string; readonly actorId: string },
  clock: Clock,
): CancelIntentResult {
  if (!canTransition(intent.status, 'cancelled')) {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot cancel an intent in status ${intent.status}`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  const reason = assertReason(cmd.reason, 'cancelling');
  const actorId = assertActor(cmd.actorId, 'cancelling');
  const cancelledAt = clock.now().toISOString();
  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'cancelled',
    cancelledAt,
  });
  return {
    intent: next,
    events: [
      intentCancelledEvent(
        {
          intentId: intent.intentId,
          corridorId: intent.corridorId,
          reason,
          actorId,
          cancelledAt,
        },
        clock,
      ),
    ],
  };
}

/**
 * Record a rail failure (submitted → failed). Failure is a post-submit rail
 * outcome; before submit, refusals are cancellations, not failures.
 */
export function failIntent(
  intent: TransferIntent,
  cmd: { readonly reason: string },
  clock: Clock,
): CancelIntentResult {
  if (!canTransition(intent.status, 'failed')) {
    throw new DomainError(
      'INTENT_STATE_INVALID',
      `cannot fail an intent in status ${intent.status}; only submitted intents can fail at the rail`,
      { intentId: intent.intentId, status: intent.status },
    );
  }
  const reason = assertReason(cmd.reason, 'failing');
  const failedAt = clock.now().toISOString();
  const next: TransferIntent = freezeIntent({
    ...intent,
    status: 'failed',
    failedAt,
  });
  return {
    intent: next,
    events: [
      intentFailedEvent(
        { intentId: intent.intentId, corridorId: intent.corridorId, reason, failedAt },
        clock,
      ),
    ],
  };
}

export interface ExpireIntentResult {
  readonly intent: TransferIntent;
  /** Expiry is a silent state flip — the catalog has no intentExpired. */
  readonly events: readonly CrossborderEvent[];
}

/**
 * Time-driven expiry: a quoted or authorized intent whose frozen quote's
 * expiry instant has been reached (inclusive — usable strictly before)
 * flips to `expired`. Idempotent: not due, drafted (no quote to expire) or
 * already submitted/terminal → unchanged, no events.
 */
export function expireIfDue(intent: TransferIntent, clock: Clock): ExpireIntentResult {
  const quote = intent.quote;
  if (!quote) return { intent, events: [] };
  if (!canTransition(intent.status, 'expired')) return { intent, events: [] };
  const now = clock.now();
  if (now.getTime() < toMillis(quote.expiresAt)) return { intent, events: [] };
  return {
    intent: freezeIntent({ ...intent, status: 'expired', expiredAt: now.toISOString() }),
    events: [],
  };
}
