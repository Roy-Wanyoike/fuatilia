/**
 * Ledger lane events — F11 (issue #18).
 *
 * The lane OWNS three `ledger.*` facts (additive to the 27-event catalog,
 * docs/04 — same additive pattern the late-fee hook used):
 *
 *   ledger.entryPosted                 — a balanced journal entry hit the ledger (R4)
 *   ledger.entryReversed               — a posted entry was corrected by a reversing entry (R3/K6)
 *   ledger.reconciliationDriftDetected — the daily K5 job found sub-ledger ≠ GL (drift)
 *   ledger.reconciliationMatched       — the daily K5 job closed clean (zero drift)
 *
 * Envelope style follows the wave-1/2 lanes: `{ name, version, aggregateId,
 * occurredAt, payload }`, version 1, occurredAt an ISO-8601 string derived
 * from the injected Clock. Payloads are narrow and JSON-serializable: ids as
 * `Uuid`, minor units as SAFE-INTEGER NUMBERS (never bigint, never floats —
 * the local `minorUnits` guard refuses silent precision loss), timestamps as
 * ISO-8601 strings.
 *
 * Cross-lane inputs travel as opaque ids / event names only — the ledger
 * never imports another lane's types.
 */
import { DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import type { LedgerSourceEventName } from './accounts';

export type LedgerEventName =
  | 'ledger.entryPosted'
  | 'ledger.entryReversed'
  | 'ledger.reconciliationDriftDetected'
  | 'ledger.reconciliationMatched';

export interface LedgerEvent<TName extends LedgerEventName, TPayload> {
  readonly name: TName;
  readonly version: 1;
  readonly aggregateId: Uuid;
  /** ISO-8601, from the injected Clock — never Date.now() inside the core. */
  readonly occurredAt: string;
  readonly payload: TPayload;
}

/** Money → JSON-safe minor units. Refuses silent precision loss (no floats). */
export function minorUnits(amount: number | bigint): number {
  const value = typeof amount === 'bigint' ? Number(amount) : amount;
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(
      'LEDGER_AMOUNT_NOT_SAFE_INTEGER',
      `amount ${String(amount)} exceeds the safe-integer range for event payloads`,
      { amount: String(amount) },
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// ledger.entryPosted (R4 — every money movement lands as a journal entry)
// ---------------------------------------------------------------------------

export interface EntryPostedPayload {
  readonly entryId: Uuid;
  readonly orgId: string;
  /** Producing lane's event name — opaque to the ledger (e.g. 'invoicing.invoiceIssued'). */
  readonly sourceEventName: LedgerSourceEventName;
  readonly sourceEventId: Uuid;
  /** Movement magnitude in minor units (both lines carry ± this amount). */
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: 'POSTED' | 'REVERSED';
  /** Set when this entry is itself a correcting (reversing) entry. */
  readonly reversalOf: Uuid | null;
}

export type EntryPostedEvent = LedgerEvent<'ledger.entryPosted', EntryPostedPayload>;

// ---------------------------------------------------------------------------
// ledger.entryReversed (R3/K6 — corrections are reversing entries, never edits)
// ---------------------------------------------------------------------------

export interface EntryReversedPayload {
  /** The ORIGINAL entry that was corrected (its status is now REVERSED). */
  readonly entryId: Uuid;
  /** The new, balanced reversing entry. */
  readonly reversalEntryId: Uuid;
  readonly reason: string;
  readonly actor: string;
  /** ISO-8601, from the injected Clock. */
  readonly reversedAt: string;
}

export type EntryReversedEvent = LedgerEvent<'ledger.entryReversed', EntryReversedPayload>;

// ---------------------------------------------------------------------------
// ledger.reconciliationDriftDetected (K5 — sub-ledger ≠ GL control account)
// ---------------------------------------------------------------------------

export interface ReconciliationDriftDetectedPayload {
  readonly jobId: Uuid;
  /** The job's date parameter, 'YYYY-MM-DD' — the reconciliation run date. */
  readonly runDate: string;
  readonly orgId: string;
  readonly currency: string;
  /** Σ(open receivable balances) — the sub-ledger side. */
  readonly subLedgerBalanceMinor: number;
  /** AR_CONTROL net balance derived from the posted entries — the GL side. */
  readonly glBalanceMinor: number;
  /** subLedgerBalanceMinor − glBalanceMinor (signed; non-zero by definition). */
  readonly driftMinor: number;
  readonly openReceivableCount: number;
  readonly postedEntryCount: number;
}

export type ReconciliationDriftDetectedEvent = LedgerEvent<
  'ledger.reconciliationDriftDetected',
  ReconciliationDriftDetectedPayload
>;

// ---------------------------------------------------------------------------
// ledger.reconciliationMatched (K5 — zero-drift close, the positive signal)
// ---------------------------------------------------------------------------

export interface ReconciliationMatchedPayload {
  readonly jobId: Uuid;
  readonly runDate: string;
  readonly orgId: string;
  readonly currency: string;
  /** The agreed balance in minor units (sub-ledger === GL). */
  readonly balanceMinor: number;
  readonly openReceivableCount: number;
  readonly postedEntryCount: number;
}

export type ReconciliationMatchedEvent = LedgerEvent<
  'ledger.reconciliationMatched',
  ReconciliationMatchedPayload
>;

/** The ledger lane's own event union. */
export type LedgerLaneEvent =
  | EntryPostedEvent
  | EntryReversedEvent
  | ReconciliationDriftDetectedEvent
  | ReconciliationMatchedEvent;

// ---------------------------------------------------------------------------
// Money-movement input events (the posting matrix keys on these)
// ---------------------------------------------------------------------------

/**
 * The six money-moving event names the posting matrix (docs/05, issue #18)
 * maps to journal entries. These are OTHER lanes' events, referenced by name
 * only (opaque) — adding a producer means extending this union AND the matrix
 * together, which keeps R4 ("every money-moving state change posts") explicit
 * and reviewed.
 *
 * Issue #18 row → source event name:
 *   invoiceIssued      → invoicing.invoiceIssued
 *   paymentCompleted   → payments.paymentCompleted
 *   creditNoteApplied  → adjustments.creditNoteApplied
 *   refundCompleted    → adjustments.refundCompleted
 *   writeOffApproved   → receivables.writeOffApproved
 *   lateFeeAssessed    → receivables.lateFeeAssessed
 */
export type MoneyMovementEventName =
  | 'invoicing.invoiceIssued'
  | 'payments.paymentCompleted'
  | 'adjustments.creditNoteApplied'
  | 'adjustments.refundCompleted'
  | 'receivables.writeOffApproved'
  | 'receivables.lateFeeAssessed';

export const MONEY_MOVEMENT_EVENT_NAMES = Object.freeze([
  'invoicing.invoiceIssued',
  'payments.paymentCompleted',
  'adjustments.creditNoteApplied',
  'adjustments.refundCompleted',
  'receivables.writeOffApproved',
  'receivables.lateFeeAssessed',
] as const satisfies readonly MoneyMovementEventName[]);

/**
 * The narrow slice of a producing lane's event the ledger posts against:
 * name + id (the idempotency key), the org/currency scope, the movement
 * amount, an audit reference and the acting actor/system (SPEC §17).
 * Everything else about the source event is invisible to the ledger.
 */
export interface MoneyMovementEvent {
  readonly name: MoneyMovementEventName;
  /** Idempotency key — re-posting the same sourceEventId never double-posts. */
  readonly sourceEventId: Uuid;
  readonly orgId: string;
  /** ISO-8601, when the movement happened (the source event's occurredAt). */
  readonly occurredAt: string;
  readonly amountMinor: number | bigint;
  readonly currency: Currency;
  /** Human/external reference (invoice number, Daraja ref, ticket…). */
  readonly reference: string;
  /** Actor/system that caused the movement (SPEC §17 "actor/system"). */
  readonly actor: string;
}

const emit = <TName extends LedgerEventName, TPayload>(
  name: TName,
  aggregateId: Uuid,
  payload: TPayload,
  clock: Clock,
): LedgerEvent<TName, TPayload> => ({
  name,
  version: 1,
  aggregateId,
  occurredAt: clock.now().toISOString(),
  payload,
});

export const entryPostedEvent = (
  args: {
    entryId: Uuid;
    orgId: string;
    sourceEventName: LedgerSourceEventName;
    sourceEventId: Uuid;
    amountMinor: number | bigint;
    currency: string;
    status: 'POSTED' | 'REVERSED';
    reversalOf?: Uuid;
  },
  clock: Clock,
): EntryPostedEvent =>
  emit(
    'ledger.entryPosted',
    args.entryId,
    {
      entryId: args.entryId,
      orgId: args.orgId,
      sourceEventName: args.sourceEventName,
      sourceEventId: args.sourceEventId,
      amountMinor: minorUnits(args.amountMinor),
      currency: args.currency,
      status: args.status,
      reversalOf: args.reversalOf ?? null,
    },
    clock,
  );

export const entryReversedEvent = (
  args: { entryId: Uuid; reversalEntryId: Uuid; reason: string; actor: string },
  clock: Clock,
): EntryReversedEvent =>
  emit(
    'ledger.entryReversed',
    args.entryId,
    {
      entryId: args.entryId,
      reversalEntryId: args.reversalEntryId,
      reason: args.reason,
      actor: args.actor,
      reversedAt: clock.now().toISOString(),
    },
    clock,
  );

export const reconciliationDriftDetectedEvent = (
  payload: ReconciliationDriftDetectedPayload,
  clock: Clock,
): ReconciliationDriftDetectedEvent =>
  emit('ledger.reconciliationDriftDetected', payload.jobId, payload, clock);

export const reconciliationMatchedEvent = (
  payload: ReconciliationMatchedPayload,
  clock: Clock,
): ReconciliationMatchedEvent =>
  emit('ledger.reconciliationMatched', payload.jobId, payload, clock);
