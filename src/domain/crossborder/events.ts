/**
 * Cross-border lane events (issue #48, SPEC §33).
 *
 * Naming per docs/04-event-catalog.md — `<context>.<aggregate><PastTenseVerb>`:
 *
 *   crossborder.corridorRegistered    a corridor was configured (fact-recorded,
 *                                     never silently edited)
 *   crossborder.corridorSuspended     a corridor was withdrawn from use
 *   crossborder.quoteIssued           an FX quote (rate snapshot + fee
 *                                     breakdown + expiry) was offered
 *   crossborder.intentAuthorized      an intent locked the quoted rate + fees
 *   crossborder.intentSubmitted       an intent was dispatched to a rail under
 *                                     an idempotency key
 *   crossborder.intentSettled         both legs landed (source debit,
 *                                     destination credit)
 *   crossborder.intentCancelled       withdrawn before settlement
 *   crossborder.intentFailed          the rail refused / reversed the transfer
 *   crossborder.intentReplayObserved  a duplicate submit arrived with a used
 *                                     idempotency key (R9-style tripwire)
 *
 * Envelope mirrors the promises lane: plain objects
 * `{ name, version, aggregateId, occurredAt, payload }` — version stays 1
 * until a breaking payload change. Payloads are narrow, serializable and
 * id-only: dates travel as ISO-8601 strings, monetary values as safe-integer
 * minor-unit numbers guarded against precision loss, rates as exact
 * "numerator/denominator" ratio strings (never floats), and cross-lane ids as
 * opaque Uuids so consumers (payments, ledger, intelligence) never import
 * this lane.
 *
 * Deliberately NOT cataloged here (see README "Deviations"): there is no
 * `crossborder.intentDrafted` / `crossborder.intentQuoted` /
 * `crossborder.intentExpired` — drafting and quoting are pre-authorization
 * posture (issuance is already observable via `crossborder.quoteIssued`) and
 * expiry is a time-driven state flip visible on the aggregate, mirroring the
 * collections-lane precedent for uncataloged transitions.
 */
import { DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import type { FeeBreakdown } from './fees';
import type { AppliedRate } from './quote';

export interface DomainEvent<TName extends string, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, taken from the injected Clock — never Date.now(). */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Pure event factory — the only way this module builds events. */
export function domainEvent<TName extends string, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): DomainEvent<TName, TPayload> {
  return {
    name,
    version: 1,
    aggregateId,
    occurredAt: clock.now().toISOString(),
    payload,
  };
}

/** Minor units (bigint) → JSON-safe number. Refuses silent precision loss. */
export function minorToNumber(amountMinor: bigint): number {
  const asNumber = Number(amountMinor);
  if (!Number.isSafeInteger(asNumber)) {
    throw new DomainError(
      'EVENT_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${amountMinor} exceeds the safe-integer range for event payloads`,
    );
  }
  return asNumber;
}

// ---------------------------------------------------------------------------
// shared payload fragments
// ---------------------------------------------------------------------------

export interface FeeSchedulePayload {
  readonly flatMinor: number;
  readonly bps: number;
}

export interface FeeBreakdownPayload {
  readonly flatMinor: number;
  readonly bpsMinor: number;
  readonly totalMinor: number;
  readonly bps: number;
}

export function feeBreakdownPayload(fee: FeeBreakdown): FeeBreakdownPayload {
  return {
    flatMinor: minorToNumber(fee.flatMinor),
    bpsMinor: minorToNumber(fee.bpsMinor),
    totalMinor: minorToNumber(fee.totalMinor),
    bps: fee.bps,
  };
}

export interface AppliedRatePayload {
  readonly rowId: Uuid;
  /** Rate provenance (who quoted this rate?). */
  readonly source: string;
  /** Quoted ratio in major units, exact: "numerator/denominator". */
  readonly ratio: string;
  /** Exact minor→minor ratio applied BEFORE the single rounding. */
  readonly appliedRatio: string;
  /** ISO-8601 — inclusive window the row was effective in. */
  readonly effectiveFrom: string;
  /** ISO-8601 inclusive upper bound; null = open-ended. */
  readonly effectiveTo: string | null;
}

export function appliedRatePayload(rate: AppliedRate): AppliedRatePayload {
  return {
    rowId: rate.rowId,
    source: rate.source,
    ratio: `${rate.numerator}/${rate.denominator}`,
    appliedRatio: `${rate.appliedNumerator}/${rate.appliedDenominator}`,
    effectiveFrom: rate.effectiveFrom,
    effectiveTo: rate.effectiveTo,
  };
}

// ---------------------------------------------------------------------------
// corridor.* payloads
// ---------------------------------------------------------------------------

export interface CorridorRegisteredPayload {
  readonly corridorId: Uuid;
  readonly orgId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly minAmountMinor: number;
  readonly maxAmountMinor: number;
  readonly rails: readonly string[];
  readonly fee: FeeSchedulePayload;
  /** ISO-8601 */
  readonly registeredAt: string;
}

export interface CorridorSuspendedPayload {
  readonly corridorId: Uuid;
  readonly orgId: Uuid;
  readonly reason: string;
  /** ISO-8601 */
  readonly suspendedAt: string;
}

// ---------------------------------------------------------------------------
// quote.* payloads
// ---------------------------------------------------------------------------

export interface QuoteIssuedPayload {
  readonly quoteId: Uuid;
  readonly orgId: Uuid;
  readonly corridorId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly sourceAmountMinor: number;
  readonly fee: FeeBreakdownPayload;
  /** sourceAmountMinor + fee.totalMinor — what the sender is debited. */
  readonly sourceDebitMinor: number;
  /** The converted amount the recipient receives (full amount; fees on top). */
  readonly destinationCreditMinor: number;
  readonly rate: AppliedRatePayload;
  /** ISO-8601 */
  readonly issuedAt: string;
  /** ISO-8601 — usable strictly before this instant (QUOTE_EXPIRED after). */
  readonly expiresAt: string;
  readonly ttlSeconds: number;
}

// ---------------------------------------------------------------------------
// intent.* payloads
// ---------------------------------------------------------------------------

export interface IntentAuthorizedPayload {
  readonly intentId: Uuid;
  readonly orgId: Uuid;
  readonly corridorId: Uuid;
  readonly quoteId: Uuid;
  readonly sourceAmountMinor: number;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  /** The fee breakdown frozen into the intent — never recomputed afterwards. */
  readonly fee: FeeBreakdownPayload;
  readonly sourceDebitMinor: number;
  readonly destinationCreditMinor: number;
  readonly rate: AppliedRatePayload;
  readonly authorizedBy: string;
  /** ISO-8601 */
  readonly authorizedAt: string;
}

export interface IntentSubmittedPayload {
  readonly intentId: Uuid;
  readonly orgId: Uuid;
  readonly corridorId: Uuid;
  readonly quoteId: Uuid;
  readonly rail: string;
  /** Opaque client-supplied idempotency key (R9/C5 scope: unique per intent). */
  readonly idempotencyKey: string;
  readonly sourceDebitMinor: number;
  readonly destinationCreditMinor: number;
  /** ISO-8601 */
  readonly submittedAt: string;
}

export interface IntentSettledPayload {
  readonly intentId: Uuid;
  readonly corridorId: Uuid;
  readonly quoteId: Uuid;
  readonly sourceCurrency: Currency;
  readonly destinationCurrency: Currency;
  readonly sourceDebitMinor: number;
  readonly destinationCreditMinor: number;
  /** Opaque rail settlement reference; null when the rail gave none. */
  readonly settlementRef: string | null;
  /** ISO-8601 */
  readonly settledAt: string;
}

export interface IntentCancelledPayload {
  readonly intentId: Uuid;
  readonly corridorId: Uuid;
  readonly reason: string;
  readonly actorId: string;
  /** ISO-8601 */
  readonly cancelledAt: string;
}

export interface IntentFailedPayload {
  readonly intentId: Uuid;
  readonly corridorId: Uuid;
  readonly reason: string;
  /** ISO-8601 */
  readonly failedAt: string;
}

/** R9-style tripwire: a submit arrived with an idempotency key that was used. */
export interface IntentReplayObservedPayload {
  readonly intentId: Uuid;
  readonly idempotencyKey: string;
  readonly quoteId: Uuid;
  /** ISO-8601 */
  readonly seenAt: string;
}

export type CrossborderEvent =
  | DomainEvent<'crossborder.corridorRegistered', CorridorRegisteredPayload>
  | DomainEvent<'crossborder.corridorSuspended', CorridorSuspendedPayload>
  | DomainEvent<'crossborder.quoteIssued', QuoteIssuedPayload>
  | DomainEvent<'crossborder.intentAuthorized', IntentAuthorizedPayload>
  | DomainEvent<'crossborder.intentSubmitted', IntentSubmittedPayload>
  | DomainEvent<'crossborder.intentSettled', IntentSettledPayload>
  | DomainEvent<'crossborder.intentCancelled', IntentCancelledPayload>
  | DomainEvent<'crossborder.intentFailed', IntentFailedPayload>
  | DomainEvent<'crossborder.intentReplayObserved', IntentReplayObservedPayload>;

// ---------------------------------------------------------------------------
// factories
// ---------------------------------------------------------------------------

export function corridorRegisteredEvent(
  args: CorridorRegisteredPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.corridorRegistered', args.corridorId, args, clock);
}

export function corridorSuspendedEvent(
  args: CorridorSuspendedPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.corridorSuspended', args.corridorId, args, clock);
}

export function quoteIssuedEvent(args: QuoteIssuedPayload, clock: Clock): CrossborderEvent {
  return domainEvent('crossborder.quoteIssued', args.quoteId, args, clock);
}

export function intentAuthorizedEvent(
  args: IntentAuthorizedPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.intentAuthorized', args.intentId, args, clock);
}

export function intentSubmittedEvent(
  args: IntentSubmittedPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.intentSubmitted', args.intentId, args, clock);
}

export function intentSettledEvent(args: IntentSettledPayload, clock: Clock): CrossborderEvent {
  return domainEvent('crossborder.intentSettled', args.intentId, args, clock);
}

export function intentCancelledEvent(
  args: IntentCancelledPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.intentCancelled', args.intentId, args, clock);
}

export function intentFailedEvent(args: IntentFailedPayload, clock: Clock): CrossborderEvent {
  return domainEvent('crossborder.intentFailed', args.intentId, args, clock);
}

export function intentReplayObservedEvent(
  args: IntentReplayObservedPayload,
  clock: Clock,
): CrossborderEvent {
  return domainEvent('crossborder.intentReplayObserved', args.intentId, args, clock);
}
