/**
 * JournalEntry aggregate + posting functions — F11 (issue #18; K5/R4).
 *
 * The ledger is APPEND-ONLY (R3, K6, SPEC §17): a posted entry is never
 * mutated or deleted. Corrections are new REVERSING entries that reference the
 * original (`reversalOf`) and carry a reason; reversing an entry marks the
 * original REVERSED (a NEW immutable object — history keeps every version) and
 * returns the fresh, balanced reversal. Reversing a reversal is rejected.
 *
 * Idempotency (SPEC §17 "idempotency key"): the producing lane's sourceEventId
 * is the key. Posting the same sourceEventId again returns the ORIGINAL entry
 * verbatim with outcome 'already_posted' and NO events — a replay can never
 * double-post, mirroring R9 payment intake.
 *
 * Every entry satisfies SPEC §17: amount + currency + direction (lines),
 * account/context (lines), reference, source (sourceEventName/Id),
 * idempotency key (sourceEventId), timestamps (occurredAt + postedAt),
 * actor/system (actor), status (POSTED | REVERSED). Money is integer minor
 * units (bigint) — never floats.
 *
 * Pure functions only: aggregates are returned as frozen new objects; time
 * comes from the injected Clock.
 */
import { CURRENCIES, DomainError } from '../shared';
import type { Clock, Currency, Uuid } from '../shared';
import {
  accountBalanceMinor,
  assertBalanced,
  assertEntryId,
  toJournalLine,
} from './accounts';
import type { JournalLine, JournalLineInput, LedgerSourceEventName } from './accounts';
import { entryPostedEvent, entryReversedEvent } from './events';
import type { LedgerLaneEvent, MoneyMovementEvent } from './events';
import { isPostableEvent, POSTING_MATRIX } from './matrix';
import { uuidFromSeed } from './ids';

export type JournalEntryStatus = 'POSTED' | 'REVERSED';

/**
 * The append-only journal entry. `reversalOf` marks an entry that IS a
 * correcting entry; `reversedBy` marks an entry that HAS BEEN corrected.
 */
export interface JournalEntry {
  readonly entryId: Uuid;
  /** Multi-tenant scope — reconciliation (K5) and idempotency are per-org. */
  readonly orgId: string;
  /** ISO-8601 — when the source movement happened. */
  readonly occurredAt: string;
  /** ISO-8601 — when the ledger posted it (from the injected Clock). */
  readonly postedAt: string;
  /** Producing lane's event name — opaque to the ledger. */
  readonly sourceEventName: LedgerSourceEventName;
  /** Producing lane's event id — the idempotency key (SPEC §17). */
  readonly sourceEventId: Uuid;
  /** Human/external reference (invoice number, Daraja ref, ticket…). */
  readonly reference: string;
  /** Actor/system that caused the movement (SPEC §17). */
  readonly actor: string;
  readonly status: JournalEntryStatus;
  readonly lines: readonly JournalLine[];
  /** Set when this entry IS a reversing (correcting) entry. */
  readonly reversalOf?: Uuid;
  /** Required on reversing entries; documents WHY the correction exists. */
  readonly reason?: string;
  /** Set on the ORIGINAL once a reversing entry has corrected it. */
  readonly reversedBy?: Uuid;
}

/** A posted entry is immutable and its history is append-only. */
export type Ledger = readonly JournalEntry[];

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const assertIso = (value: string, field: string): void => {
  if (typeof value !== 'string' || !ISO_8601.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new DomainError(
      'LEDGER_OCCURRED_AT_INVALID',
      `${field} must be an ISO-8601 timestamp, got ${String(value)}`,
      { field, value: String(value) },
    );
  }
};

const assertNonBlank = (value: string, code: string, field: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new DomainError(code, `a journal entry requires a non-blank ${field}`);
  }
  return trimmed;
};

/** Movement magnitude → positive bigint minor units (never zero, never negative). */
const movementMinor = (amount: number | bigint): bigint => {
  if (typeof amount === 'number' && !Number.isSafeInteger(amount)) {
    throw new DomainError(
      'LEDGER_AMOUNT_NOT_INTEGER',
      `movement amount must be an integer minor unit, got ${String(amount)}`,
      { amountMinor: String(amount) },
    );
  }
  const minor = typeof amount === 'number' ? BigInt(amount) : amount;
  if (minor <= 0n) {
    throw new DomainError(
      'LEDGER_AMOUNT_INVALID',
      `movement amount must be positive (a negative movement is a different event, not a negative amount), got ${minor}`,
      { amountMinor: minor.toString() },
    );
  }
  return minor;
};

const assertCurrency = (currency: Currency): Currency => {
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new DomainError(
      'LEDGER_CURRENCY_INVALID',
      `unknown currency ${String(currency)} — supported: ${CURRENCIES.join(', ')}`,
      { currency: String(currency) },
    );
  }
  return currency;
};

/**
 * Idempotency lookup: the entry already posted for (orgId, sourceEventId).
 * Pure — the caller supplies the append-only history (the "ledger store").
 */
export const findPostedEntry = (
  ledger: Ledger,
  orgId: string,
  sourceEventId: Uuid,
): JournalEntry | undefined => ledger.find((e) => e.orgId === orgId && e.sourceEventId === sourceEventId);

const sameLines = (a: readonly JournalLine[], b: readonly JournalLine[]): boolean =>
  a.length === b.length &&
  a.every(
    (line, i) =>
      b[i]!.account === line.account &&
      b[i]!.direction === line.direction &&
      b[i]!.amountMinor === line.amountMinor &&
      b[i]!.currency === line.currency,
  );

/**
 * A replayed sourceEventId must describe the SAME movement it described the
 * first time. Any drift means the "duplicate" is actually a different,
 * mutated event masquerading as a replay — refuse it loudly.
 */
export const assertSameMovement = (existing: JournalEntry, replay: MoneyMovementEvent): void => {
  const drift =
    existing.sourceEventName !== replay.name ||
    existing.occurredAt !== replay.occurredAt ||
    existing.lines.length !== 2 ||
    existing.lines[0]!.amountMinor !== movementMinor(replay.amountMinor) ||
    existing.lines[0]!.currency !== replay.currency;
  if (drift) {
    throw new DomainError(
      'LEDGER_IDEMPOTENCY_CONFLICT',
      `sourceEventId ${replay.sourceEventId} was already posted with different movement details — refusing to treat it as a replay`,
      { sourceEventId: replay.sourceEventId, entryId: existing.entryId },
    );
  }
};

const freezeEntry = (entry: JournalEntry): JournalEntry =>
  Object.freeze({ ...entry, lines: Object.freeze([...entry.lines]) as readonly JournalLine[] });

export interface PostOptions {
  /**
   * Entry id. Defaults to a deterministic id derived from (orgId,
   * sourceEventId) so the same logical movement always carries the same
   * entryId even before the store lookup runs.
   */
  readonly entryId?: Uuid;
}

export type PostResult =
  | {
      /** A new entry was posted (exactly one ledger.entryPosted event). */
      readonly outcome: 'posted';
      readonly entry: JournalEntry;
      readonly events: readonly LedgerLaneEvent[];
    }
  | {
      /** Replay: the original entry is returned UNCHANGED; nothing is emitted. */
      readonly outcome: 'already_posted';
      readonly entry: JournalEntry;
      readonly events: readonly LedgerLaneEvent[];
    };

/**
 * `post` — the posting matrix applied (THE core of F11).
 *
 * Maps a money-moving source event to exactly one balanced journal entry per
 * docs/05 (see ./matrix.ts for the table). Guards, in order:
 *   1. the event must have a matrix row → LEDGER_EVENT_NOT_POSTABLE;
 *   2. ids/refs/actor/occurredAt must be well-formed (LEDGER_* codes);
 *   3. amount must be a positive integer minor unit (LEDGER_AMOUNT_*),
 *      currency a known one (LEDGER_CURRENCY_INVALID);
 *   4. idempotency: a (orgId, sourceEventId) already in the ledger returns the
 *      original entry unchanged ('already_posted', zero events); a same-id
 *      event with different movement details is a conflict, not a replay
 *      (LEDGER_IDEMPOTENCY_CONFLICT).
 * The entry is balanced BY CONSTRUCTION from the matrix and proven balanced by
 * assertBalanced (defense in depth).
 */
export const post = (
  event: MoneyMovementEvent,
  ledger: Ledger,
  clock: Clock,
  options?: PostOptions,
): PostResult => {
  if (!isPostableEvent(event.name)) {
    throw new DomainError(
      'LEDGER_EVENT_NOT_POSTABLE',
      `event "${String(event.name)}" has no posting-matrix row — either it moves no money (e.g. allocation.executed is memo-only) or the matrix is missing a reviewed row`,
      { sourceEventName: String(event.name) },
    );
  }
  assertEntryId(event.sourceEventId, 'sourceEventId');
  const orgId = assertNonBlank(event.orgId, 'LEDGER_ORG_REQUIRED', 'orgId');
  const reference = assertNonBlank(event.reference, 'LEDGER_REFERENCE_REQUIRED', 'reference');
  const actor = assertNonBlank(event.actor, 'LEDGER_ACTOR_REQUIRED', 'actor');
  assertIso(event.occurredAt, 'occurredAt');
  const amountMinor = movementMinor(event.amountMinor);
  const currency = assertCurrency(event.currency);

  // Idempotency (SPEC §17 / R9 spirit) — before anything is built or emitted.
  const existing = findPostedEntry(ledger, orgId, event.sourceEventId);
  if (existing) {
    assertSameMovement(existing, event);
    return { outcome: 'already_posted', entry: existing, events: [] };
  }

  // The matrix builds the balanced Dr/Cr pair.
  const row = POSTING_MATRIX[event.name];
  const lines: readonly JournalLine[] = [
    toJournalLine({ account: row.debit, direction: 'DEBIT', amountMinor, currency }),
    toJournalLine({ account: row.credit, direction: 'CREDIT', amountMinor, currency }),
  ];
  assertBalanced(lines);

  const entry = freezeEntry({
    entryId: options?.entryId ?? uuidFromSeed(`ledger.entry:${orgId}:${event.sourceEventId}`),
    orgId,
    occurredAt: event.occurredAt,
    postedAt: clock.now().toISOString(),
    sourceEventName: event.name,
    sourceEventId: event.sourceEventId,
    reference,
    actor,
    status: 'POSTED',
    lines,
  });
  return {
    outcome: 'posted',
    entry,
    events: [
      entryPostedEvent(
        {
          entryId: entry.entryId,
          orgId: entry.orgId,
          sourceEventName: entry.sourceEventName,
          sourceEventId: entry.sourceEventId,
          amountMinor: entry.lines[0]!.amountMinor,
          currency: entry.lines[0]!.currency,
          status: entry.status,
        },
        clock,
      ),
    ],
  };
};

// ---------------------------------------------------------------------------
// Generic posting path (explicit lines) — for adapters and historical replay
// ---------------------------------------------------------------------------

export interface PostEntryInput {
  readonly entryId?: Uuid;
  readonly orgId: string;
  /** ISO-8601 — when the movement happened. */
  readonly occurredAt: string;
  /** Producing event name — opaque; no matrix lookup happens on this path. */
  readonly sourceEventName: LedgerSourceEventName;
  readonly sourceEventId: Uuid;
  readonly reference: string;
  readonly actor: string;
  /** Explicit lines — MUST balance (LEDGER_ENTRY_UNBALANCED otherwise). */
  readonly lines: readonly JournalLineInput[];
}

/**
 * Post an entry from EXPLICIT lines (the general journal path — the matrix is
 * a special case of this). This is where unbalanced input is rejected with
 * LEDGER_ENTRY_UNBALANCED: the domain never accepts a Dr/Cr mismatch, whatever
 * the caller claims. Corrections do NOT go through here — use `reverseEntry`,
 * which is the only way to create an entry carrying `reversalOf` (K6 guards
 * stay non-bypassable).
 */
export const postEntry = (
  input: PostEntryInput,
  ledger: Ledger,
  clock: Clock,
): PostResult => {
  assertEntryId(input.sourceEventId, 'sourceEventId');
  const orgId = assertNonBlank(input.orgId, 'LEDGER_ORG_REQUIRED', 'orgId');
  const reference = assertNonBlank(input.reference, 'LEDGER_REFERENCE_REQUIRED', 'reference');
  const actor = assertNonBlank(input.actor, 'LEDGER_ACTOR_REQUIRED', 'actor');
  assertIso(input.occurredAt, 'occurredAt');
  if (!input.sourceEventName.trim()) {
    throw new DomainError('LEDGER_SOURCE_EVENT_REQUIRED', 'a journal entry requires a sourceEventName');
  }
  const lines = input.lines.map(toJournalLine);
  assertBalanced(lines);

  const existing = findPostedEntry(ledger, orgId, input.sourceEventId);
  if (existing) {
    const replayIsSame =
      existing.sourceEventName === input.sourceEventName &&
      existing.occurredAt === input.occurredAt &&
      sameLines(existing.lines, lines);
    if (!replayIsSame) {
      throw new DomainError(
        'LEDGER_IDEMPOTENCY_CONFLICT',
        `sourceEventId ${input.sourceEventId} was already posted with different lines — refusing to treat it as a replay`,
        { sourceEventId: input.sourceEventId, entryId: existing.entryId },
      );
    }
    return { outcome: 'already_posted', entry: existing, events: [] };
  }

  const entry = freezeEntry({
    entryId: input.entryId ?? uuidFromSeed(`ledger.entry:${orgId}:${input.sourceEventId}`),
    orgId,
    occurredAt: input.occurredAt,
    postedAt: clock.now().toISOString(),
    sourceEventName: input.sourceEventName,
    sourceEventId: input.sourceEventId,
    reference,
    actor,
    status: 'POSTED',
    lines,
  });
  return {
    outcome: 'posted',
    entry,
    events: [
      entryPostedEvent(
        {
          entryId: entry.entryId,
          orgId: entry.orgId,
          sourceEventName: entry.sourceEventName,
          sourceEventId: entry.sourceEventId,
          amountMinor: entry.lines[0]!.amountMinor,
          currency: entry.lines[0]!.currency,
          status: entry.status,
        },
        clock,
      ),
    ],
  };
};

// ---------------------------------------------------------------------------
// Reversals — R3/K6: corrections are new entries, never edits
// ---------------------------------------------------------------------------

export interface ReverseEntryInput {
  readonly entryId?: Uuid;
  /** REQUIRED — an audit trail without a reason fails reviews (R3). */
  readonly reason: string;
  readonly actor: string;
  /** Defaults to the original entry's reference (same movement, corrected). */
  readonly reference?: string;
}

export interface ReversalResult {
  /** NEW immutable version of the original: status REVERSED + reversedBy. */
  readonly original: JournalEntry;
  /** The fresh, balanced reversing entry (status POSTED, reversalOf set). */
  readonly reversal: JournalEntry;
  /** [ledger.entryPosted (the reversal), ledger.entryReversed (the correction)]. */
  readonly events: readonly LedgerLaneEvent[];
}

/**
 * Correct a posted entry by APPENDING a reversing entry with swapped lines and
 * a reason (R3/K6). Guards:
 *   - blank reason            → REVERSAL_REASON_REQUIRED;
 *   - blank actor             → LEDGER_ACTOR_REQUIRED;
 *   - target IS a reversal    → LEDGER_REVERSAL_OF_REVERSAL (reversing a
 *                               reversal is rejected — correct the ORIGINAL
 *                               again instead);
 *   - target already reversed → LEDGER_ENTRY_NOT_REVERSIBLE.
 * The original is returned as a NEW frozen object (status REVERSED,
 * reversedBy → the reversal); nothing in the input is mutated. Net effect of
 * original + reversal on every account is exactly zero.
 */
export const reverseEntry = (
  original: JournalEntry,
  input: ReverseEntryInput,
  clock: Clock,
): ReversalResult => {
  const reason = assertNonBlank(input.reason, 'REVERSAL_REASON_REQUIRED', 'reversal reason');
  const actor = assertNonBlank(input.actor, 'LEDGER_ACTOR_REQUIRED', 'actor');
  if (original.reversalOf !== undefined) {
    throw new DomainError(
      'LEDGER_REVERSAL_OF_REVERSAL',
      `entry ${original.entryId} is itself a reversal of ${original.reversalOf} — reversals are never reversed; correct the original entry instead (K6)`,
      { entryId: original.entryId, reversalOf: original.reversalOf },
    );
  }
  if (original.status !== 'POSTED') {
    throw new DomainError(
      'LEDGER_ENTRY_NOT_REVERSIBLE',
      `entry ${original.entryId} is ${original.status} and has already been reversed by ${String(original.reversedBy)}`,
      { entryId: original.entryId, status: original.status, reversedBy: original.reversedBy },
    );
  }

  const reversalId = input.entryId ?? uuidFromSeed(`ledger.reversal:${original.entryId}`);
  const lines: readonly JournalLine[] = original.lines.map((line) =>
    line.direction === 'DEBIT'
      ? { ...line, direction: 'CREDIT' as const }
      : { ...line, direction: 'DEBIT' as const },
  );
  assertBalanced(lines); // the flipped original balances by construction — proven, not assumed

  const reversal = freezeEntry({
    entryId: reversalId,
    orgId: original.orgId,
    occurredAt: clock.now().toISOString(),
    postedAt: clock.now().toISOString(),
    sourceEventName: 'ledger.entryReversed',
    sourceEventId: reversalId,
    reference: input.reference?.trim() || original.reference,
    actor,
    status: 'POSTED',
    lines,
    reversalOf: original.entryId,
    reason,
  });

  const markedOriginal = freezeEntry({
    ...original,
    status: 'REVERSED',
    reversedBy: reversal.entryId,
  });

  return {
    original: markedOriginal,
    reversal,
    events: [
      entryPostedEvent(
        {
          entryId: reversal.entryId,
          orgId: reversal.orgId,
          sourceEventName: reversal.sourceEventName,
          sourceEventId: reversal.sourceEventId,
          amountMinor: reversal.lines[0]!.amountMinor,
          currency: reversal.lines[0]!.currency,
          status: reversal.status,
          reversalOf: reversal.reversalOf,
        },
        clock,
      ),
      entryReversedEvent(
        {
          entryId: original.entryId,
          reversalEntryId: reversal.entryId,
          reason,
          actor,
        },
        clock,
      ),
    ],
  };
};

// ---------------------------------------------------------------------------
// Derived balances — the GL side of the K5 job
// ---------------------------------------------------------------------------

/** Net AR_CONTROL balance over the given entries (Σ Dr − Σ Cr), minor units. */
export const arControlBalanceMinor = (entries: Ledger): bigint =>
  accountBalanceMinor(entries, 'AR_CONTROL');
