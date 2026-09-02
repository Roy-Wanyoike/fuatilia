/**
 * CreditNote + CreditNoteApplication — review finding C3 (was a name-only stub
 * in v1), invariant R7 (docs/07).
 *
 * First-class aggregate with its own lifecycle (docs/03):
 *   [*] → Draft → Issued → PartiallyApplied → FullyApplied → [*]
 *                     ↘ Voided (never applied)          ↗ (remaining via credit balance)
 *
 * Guards: Σ applications ≤ note total (R7 — CREDIT_NOTE_OVER_APPLIED); partial
 * applications supported; drafts cannot be applied; voiding only while zero
 * applications. Unapplied note value may be routed (with consent) into the
 * customer credit balance (C4 wiring) — consumption from either path is
 * reflected in the state machine, and unappliedOf(note) is always derivable.
 *
 * Pure functions only — new objects, never mutated in place (R3 spirit).
 */
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import type {
  AdjustmentEvent,
  CreditBalanceAppliedPayload,
  CreditNoteAppliedPayload,
  CreditNoteIssuedPayload,
} from './events';
import { creditBalanceAppliedEvent, creditNoteAppliedEvent, creditNoteIssuedEvent } from './events';
import type { CreditBalanceMovement } from './credit-balance';

export type CreditNoteState = 'draft' | 'issued' | 'partially_applied' | 'fully_applied' | 'voided';

export interface CreditNoteApplication {
  readonly id: Uuid;
  readonly creditNoteId: Uuid;
  readonly receivableId: Uuid;
  /** > 0; Σ per note ≤ totalMinor (R7). */
  readonly amount: Money;
  readonly appliedAt: Date;
}

/** One consented routing of unapplied note value into the customer credit balance. */
export interface CreditBalanceRouting {
  /** Same id as the CreditBalanceMovement appended to the customer's log. */
  readonly movementId: Uuid;
  readonly amount: Money;
  readonly occurredAt: Date;
}

export interface CreditNote {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly invoiceId?: Uuid;
  readonly reason: string;
  /** > 0, frozen at draft (docs/05). */
  readonly total: Money;
  readonly state: CreditNoteState;
  readonly issuedAt?: Date;
  readonly voidedAt?: Date;
  readonly applications: readonly CreditNoteApplication[];
  readonly creditBalanceRoutings: readonly CreditBalanceRouting[];
}

export interface DraftCreditNoteInput {
  readonly id: Uuid;
  readonly customerId: Uuid;
  readonly invoiceId?: Uuid;
  readonly reason: string;
  readonly total: Money;
}

/** Σ applications against the note (derived, never stored-mutated). */
export const appliedOf = (note: CreditNote): Money =>
  note.applications.reduce(
    (acc, application) => acc.add(application.amount),
    Money.zero(note.total.currency),
  );

/** Σ consented routings into the customer credit balance (derived). */
export const creditedOf = (note: CreditNote): Money =>
  note.creditBalanceRoutings.reduce(
    (acc, routing) => acc.add(routing.amount),
    Money.zero(note.total.currency),
  );

/** Value still available for application or consented routing. */
export const unappliedOf = (note: CreditNote): Money =>
  note.total.subtract(appliedOf(note).add(creditedOf(note)));

export interface DraftCreditNote {
  readonly note: CreditNote;
}

/** Enter the machine at Draft (docs/05: totalMinor > 0). */
export const draftCreditNote = (input: DraftCreditNoteInput): DraftCreditNote => {
  if (!input.reason.trim()) {
    throw new DomainError('CREDIT_NOTE_REASON_REQUIRED', 'a credit note requires a reason');
  }
  if (!input.total.isPositive()) {
    throw new DomainError('CREDIT_NOTE_TOTAL_INVALID', 'credit note total must be positive');
  }
  return {
    note: {
      id: input.id,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      reason: input.reason,
      total: input.total,
      state: 'draft',
      applications: [],
      creditBalanceRoutings: [],
    },
  };
};

export interface CreditNoteIssued {
  readonly note: CreditNote;
  readonly event: AdjustmentEvent<'adjustment.creditNoteIssued', CreditNoteIssuedPayload>;
}

/** Draft → Issued (approval) — emits E19 adjustment.creditNoteIssued. */
export const issueCreditNote = (note: CreditNote, clock: Clock): CreditNoteIssued => {
  if (note.state !== 'draft') {
    throw new DomainError(
      'CREDIT_NOTE_INVALID_TRANSITION',
      `cannot issue a credit note in state '${note.state}' (expected 'draft')`,
      { creditNoteId: note.id, state: note.state },
    );
  }
  return {
    note: { ...note, state: 'issued', issuedAt: clock.now() },
    event: creditNoteIssuedEvent(
      { creditNoteId: note.id, customerId: note.customerId, totalMinor: note.total.amount },
      clock,
    ),
  };
};

export interface CreditNoteApplied {
  readonly note: CreditNote;
  readonly application: CreditNoteApplication;
  readonly event: AdjustmentEvent<'adjustment.creditNoteApplied', CreditNoteAppliedPayload>;
}

/**
 * Apply (part of) the note against a receivable. Issued/PartiallyApplied only —
 * a draft cannot be applied. R7: Σ applications must never exceed the note
 * total → CREDIT_NOTE_OVER_APPLIED. Emits E20 adjustment.creditNoteApplied.
 */
export const applyCreditNote = (
  note: CreditNote,
  receivableId: Uuid,
  amount: Money,
  clock: Clock,
  applicationId: Uuid,
): CreditNoteApplied => {
  if (note.state !== 'issued' && note.state !== 'partially_applied') {
    throw new DomainError(
      'CREDIT_NOTE_NOT_APPLICABLE',
      `cannot apply a credit note in state '${note.state}' — drafts cannot be applied, and fully_applied/voided notes have nothing left`,
      { creditNoteId: note.id, state: note.state },
    );
  }
  if (!amount.isPositive()) {
    throw new DomainError('CREDIT_NOTE_AMOUNT_INVALID', 'applied amount must be positive');
  }
  if (amount.currency !== note.total.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `application ${amount.toString()} does not match note currency ${note.total.currency}`,
    );
  }
  const newApplied = appliedOf(note).add(amount);
  if (newApplied.compareTo(note.total) > 0) {
    throw new DomainError(
      'CREDIT_NOTE_OVER_APPLIED',
      `applications would total ${newApplied.toString()}, exceeding note total ${note.total.toString()} (R7)`,
      {
        creditNoteId: note.id,
        noteTotalMinor: note.total.amount,
        alreadyAppliedMinor: appliedOf(note).amount,
        requestedMinor: amount.amount,
      },
    );
  }
  const application: CreditNoteApplication = {
    id: applicationId,
    creditNoteId: note.id,
    receivableId,
    amount,
    appliedAt: clock.now(),
  };
  const remaining = unappliedOf(note).subtract(amount);
  return {
    note: {
      ...note,
      applications: [...note.applications, application],
      state: remaining.isZero() ? 'fully_applied' : 'partially_applied',
    },
    application,
    event: creditNoteAppliedEvent(
      { applicationId, creditNoteId: note.id, receivableId, amountMinor: amount.amount },
      clock,
    ),
  };
};

/**
 * Issued → Voided (docs/03: "never applied"). Anything other than an issued,
 * application-free note throws — voiding is blocked once applications exist.
 */
export const voidCreditNote = (note: CreditNote, clock: Clock): CreditNote => {
  if (note.state !== 'issued') {
    throw new DomainError(
      'CREDIT_NOTE_INVALID_TRANSITION',
      `cannot void a credit note in state '${note.state}' — only issued notes with zero applications can be voided (docs/03)`,
      { creditNoteId: note.id, state: note.state },
    );
  }
  if (note.applications.length > 0) {
    throw new DomainError(
      'CREDIT_NOTE_HAS_APPLICATIONS',
      'a credit note with applications cannot be voided (defensive guard — issued notes cannot carry applications)',
      { creditNoteId: note.id },
    );
  }
  return { ...note, state: 'voided', voidedAt: clock.now() };
};

export interface CreditNoteExcessRouted {
  readonly note: CreditNote;
  /** Append to the customer's CustomerCreditBalance log via appendMovement (C4). */
  readonly movement: CreditBalanceMovement;
  readonly event: AdjustmentEvent<'adjustment.creditBalanceApplied', CreditBalanceAppliedPayload>;
}

/**
 * Consented routing of unapplied note value into the customer credit balance
 * (R7: "excess requires consent and lands in CustomerCreditBalance"). When the
 * last of the unapplied value is routed, the note becomes fully_applied
 * (docs/03: PartiallyApplied → FullyApplied via credit balance).
 */
export const applyExcessToCreditBalance = (
  note: CreditNote,
  amount: Money,
  consent: boolean,
  clock: Clock,
  movementId: Uuid,
): CreditNoteExcessRouted => {
  if (consent !== true) {
    throw new DomainError(
      'CONSENT_REQUIRED',
      'routing credit-note excess to the customer credit balance requires explicit consent (R7 / DPA 2019)',
      { creditNoteId: note.id },
    );
  }
  if (note.state === 'draft' || note.state === 'voided') {
    throw new DomainError(
      'CREDIT_NOTE_NOT_APPLICABLE',
      `cannot route excess from a credit note in state '${note.state}' — drafts cannot be applied, voided notes are dead`,
      { creditNoteId: note.id, state: note.state },
    );
  }
  // No explicit gate for 'fully_applied': by construction it has zero unapplied
  // value, so the check below reports the more precise CREDIT_NOTE_NO_UNAPPLIED_VALUE.
  if (!amount.isPositive()) {
    throw new DomainError('CREDIT_NOTE_AMOUNT_INVALID', 'routed amount must be positive');
  }
  if (amount.currency !== note.total.currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `routing ${amount.toString()} does not match note currency ${note.total.currency}`,
    );
  }
  const unapplied = unappliedOf(note);
  if (unapplied.isZero()) {
    throw new DomainError(
      'CREDIT_NOTE_NO_UNAPPLIED_VALUE',
      `note ${note.id} has no unapplied value left to route to credit balance`,
      { creditNoteId: note.id },
    );
  }
  if (amount.compareTo(unapplied) > 0) {
    throw new DomainError(
      'CREDIT_NOTE_EXCESS_EXCEEDS_UNAPPLIED',
      `routed ${amount.toString()} exceeds unapplied ${unapplied.toString()}`,
      {
        creditNoteId: note.id,
        unappliedMinor: unapplied.amount,
        requestedMinor: amount.amount,
      },
    );
  }
  const occurredAt = clock.now();
  const remaining = unapplied.subtract(amount);
  const updated: CreditNote = {
    ...note,
    creditBalanceRoutings: [...note.creditBalanceRoutings, { movementId, amount, occurredAt }],
    state: remaining.isZero() ? 'fully_applied' : 'partially_applied',
  };
  const movement: CreditBalanceMovement = {
    id: movementId,
    customerId: note.customerId,
    kind: 'credit_note_excess',
    direction: 'increase',
    amount,
    currency: amount.currency,
    sourceId: note.id,
    occurredAt,
  };
  return {
    note: updated,
    movement,
    event: creditBalanceAppliedEvent(
      { customerId: note.customerId, amountMinor: amount.amount, receivableId: null },
      clock,
    ),
  };
};
