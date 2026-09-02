import { describe, expect, it } from 'vitest';
import { DomainError, Money } from '../shared';
import type { Clock, Uuid } from '../shared';
import {
  appliedOf,
  applyCreditNote,
  applyExcessToCreditBalance,
  creditedOf,
  draftCreditNote,
  issueCreditNote,
  unappliedOf,
  voidCreditNote,
} from './credit-note';
import type { CreditNote } from './credit-note';
import { appendMovement, availableOf, openCreditBalance } from './credit-balance';

const clock: Clock = { now: () => new Date('2025-06-01T09:30:00.000Z') };

/** Deterministic 36-char hex ids for table-driven tests. */
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

const customerId = uid('e0000000001');
const receivableId = uid('10000000001');

const noteOf = (totalMinor = 10_000): CreditNote =>
  issueCreditNote(
    draftCreditNote({
      id: uid('d0000000001'),
      customerId,
      reason: 'damaged goods',
      total: Money.ofMinor(totalMinor, 'KES'),
    }).note,
    clock,
  ).note;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

describe('CreditNote lifecycle (C3)', () => {
  it('issues a draft and emits adjustment.creditNoteIssued', () => {
    const draft = draftCreditNote({
      id: uid('d0000000001'),
      customerId,
      invoiceId: uid('f0000000001'),
      reason: 'damaged goods',
      total: Money.ofMinor(10_000, 'KES'),
    }).note;
    expect(draft.state).toBe('draft');

    const { note, event } = issueCreditNote(draft, clock);
    expect(note.state).toBe('issued');
    expect(note.issuedAt).toEqual(new Date('2025-06-01T09:30:00.000Z'));
    expect(event.name).toBe('adjustment.creditNoteIssued');
    expect(event.aggregateId).toBe(note.id);
    expect(event.payload).toEqual({
      creditNoteId: note.id,
      customerId,
      totalMinor: 10_000n,
    });
  });

  it('refuses a draft with a zero total (docs/05: totalMinor > 0; negatives are impossible via Money)', () => {
    expectCode(
      () =>
        draftCreditNote({
          id: uid('d0000000001'),
          customerId,
          reason: 'damaged goods',
          total: Money.ofMinor(0, 'KES'),
        }),
      'CREDIT_NOTE_TOTAL_INVALID',
    );
  });

  it('refuses a draft without a reason', () => {
    expectCode(
      () =>
        draftCreditNote({
          id: uid('d0000000001'),
          customerId,
          reason: ' ',
          total: Money.ofMinor(10_000, 'KES'),
        }),
      'CREDIT_NOTE_REASON_REQUIRED',
    );
  });

  it.each(['issued', 'partially_applied', 'fully_applied', 'voided'] as const)(
    'refuses re-issuing a note already in state %s',
    (state) => {
      const issued = noteOf();
      const target: CreditNote =
        state === 'issued'
          ? issued
          : state === 'partially_applied'
            ? applyCreditNote(issued, receivableId, Money.ofMinor(2_000, 'KES'), clock, uid('aa000000001')).note
            : state === 'fully_applied'
              ? applyCreditNote(issued, receivableId, Money.ofMinor(10_000, 'KES'), clock, uid('aa000000001')).note
              : voidCreditNote(issued, clock);
      expectCode(() => issueCreditNote(target, clock), 'CREDIT_NOTE_INVALID_TRANSITION');
    },
  );
});

describe('CreditNote applications (C3, R7)', () => {
  it('supports partial then full application with derived state transitions', () => {
    const issued = noteOf(10_000);

    const first = applyCreditNote(issued, receivableId, Money.ofMinor(4_000, 'KES'), clock, uid('aa000000001'));
    expect(first.note.state).toBe('partially_applied');
    expect(appliedOf(first.note).amount).toBe(4_000n);
    expect(unappliedOf(first.note).amount).toBe(6_000n);
    expect(first.event.name).toBe('adjustment.creditNoteApplied');
    expect(first.event.payload).toEqual({
      applicationId: uid('aa000000001'),
      creditNoteId: first.note.id,
      receivableId,
      amountMinor: 4_000n,
    });

    const second = applyCreditNote(
      first.note,
      receivableId,
      Money.ofMinor(6_000, 'KES'),
      clock,
      uid('aa000000002'),
    );
    expect(second.note.state).toBe('fully_applied');
    expect(appliedOf(second.note).equals(second.note.total)).toBe(true);
    expect(unappliedOf(second.note).isZero()).toBe(true);
    expect(second.note.applications).toHaveLength(2);
  });

  it('blocks over-application (R7: Σ applications ≤ note total)', () => {
    const issued = noteOf(10_000);
    const partial = applyCreditNote(issued, receivableId, Money.ofMinor(6_000, 'KES'), clock, uid('aa000000001'));
    expectCode(
      () => applyCreditNote(partial.note, receivableId, Money.ofMinor(5_000, 'KES'), clock, uid('aa000000002')),
      'CREDIT_NOTE_OVER_APPLIED',
    );
  });

  it.each(['draft', 'voided', 'fully_applied'] as const)(
    'refuses applying a note in state %s',
    (state) => {
      const issued = noteOf();
      const target: CreditNote =
        state === 'draft'
          ? draftCreditNote({ id: uid('d0000000001'), customerId, reason: 'x', total: Money.ofMinor(10_000, 'KES') }).note
          : state === 'voided'
            ? voidCreditNote(issued, clock)
            : applyCreditNote(issued, receivableId, Money.ofMinor(10_000, 'KES'), clock, uid('aa000000001')).note;
      expectCode(
        () => applyCreditNote(target, receivableId, Money.ofMinor(1_000, 'KES'), clock, uid('aa000000002')),
        'CREDIT_NOTE_NOT_APPLICABLE',
      );
    },
  );

  it.each([
    ['zero amount', Money.ofMinor(0, 'KES'), 'CREDIT_NOTE_AMOUNT_INVALID'],
    ['cross-currency amount', Money.ofMinor(1_000, 'USD'), 'CURRENCY_MISMATCH'],
  ])('refuses %s (%s)', (_label, amount, code) => {
    expectCode(
      () => applyCreditNote(noteOf(), receivableId, amount, clock, uid('aa000000001')),
      code,
    );
  });

  it('never mutates the note in place when applying (R3 spirit)', () => {
    const issued = noteOf();
    const { note } = applyCreditNote(issued, receivableId, Money.ofMinor(1_000, 'KES'), clock, uid('aa000000001'));
    expect(issued.state).toBe('issued');
    expect(issued.applications).toHaveLength(0);
    expect(note.applications).toHaveLength(1);
  });
});

describe('CreditNote voiding (C3)', () => {
  it('voids an issued note with zero applications and stamps voidedAt', () => {
    const voided = voidCreditNote(noteOf(), clock);
    expect(voided.state).toBe('voided');
    expect(voided.voidedAt).toEqual(new Date('2025-06-01T09:30:00.000Z'));
  });

  it.each(['draft', 'partially_applied', 'fully_applied', 'voided'] as const)(
    'refuses voiding a note in state %s (only Issued → Voided exists, docs/03)',
    (state) => {
      const issued = noteOf();
      const target: CreditNote =
        state === 'draft'
          ? draftCreditNote({ id: uid('d0000000001'), customerId, reason: 'x', total: Money.ofMinor(10_000, 'KES') }).note
          : state === 'partially_applied'
            ? applyCreditNote(issued, receivableId, Money.ofMinor(2_000, 'KES'), clock, uid('aa000000001')).note
            : state === 'fully_applied'
              ? applyCreditNote(issued, receivableId, Money.ofMinor(10_000, 'KES'), clock, uid('aa000000001')).note
              : voidCreditNote(issued, clock);
      expectCode(() => voidCreditNote(target, clock), 'CREDIT_NOTE_INVALID_TRANSITION');
    },
  );

  it('defensively blocks voiding when applications exist on a hand-crafted issued note', () => {
    // Unreachable via the API (apply moves state); guards persistence-layer corruption.
    const issued = noteOf();
    const corrupt: CreditNote = {
      ...issued,
      applications: [
        { id: uid('aa000000001'), creditNoteId: issued.id, receivableId, amount: Money.ofMinor(1_000, 'KES'), appliedAt: clock.now() },
      ],
    };
    expectCode(() => voidCreditNote(corrupt, clock), 'CREDIT_NOTE_HAS_APPLICATIONS');
  });
});

describe('applyExcessToCreditBalance (C3 → C4, R7)', () => {
  it('routes part of the unapplied value with consent and emits creditBalanceApplied', () => {
    const issued = noteOf(10_000);
    const { note, movement, event } = applyExcessToCreditBalance(
      issued,
      Money.ofMinor(3_000, 'KES'),
      true,
      clock,
      uid('cc000000001'),
    );
    expect(note.state).toBe('partially_applied');
    expect(creditedOf(note).amount).toBe(3_000n);
    expect(unappliedOf(note).amount).toBe(7_000n);
    expect(movement.kind).toBe('credit_note_excess');
    expect(movement.direction).toBe('increase');
    expect(movement.sourceId).toBe(note.id);
    expect(movement.amount.amount).toBe(3_000n);
    expect(event.name).toBe('adjustment.creditBalanceApplied');
    expect(event.aggregateId).toBe(customerId);
    expect(event.payload).toEqual({ customerId, amountMinor: 3_000n, receivableId: null });
  });

  it('routes the remainder and closes the note as fully_applied (docs/03)', () => {
    const issued = noteOf(10_000);
    const partial = applyExcessToCreditBalance(issued, Money.ofMinor(3_000, 'KES'), true, clock, uid('cc000000001'));
    const final = applyExcessToCreditBalance(partial.note, Money.ofMinor(7_000, 'KES'), true, clock, uid('cc000000002'));
    expect(final.note.state).toBe('fully_applied');
    expect(unappliedOf(final.note).isZero()).toBe(true);
  });

  it('lands the routed movement on the customer credit balance (C3+C4 wiring)', () => {
    const issued = noteOf(10_000);
    const { movement } = applyExcessToCreditBalance(issued, Money.ofMinor(4_000, 'KES'), true, clock, uid('cc000000001'));
    const balance = appendMovement(openCreditBalance(customerId, 'KES'), movement);
    expect(balance.movements).toHaveLength(1);
    // available recomputed from the log, never mutated
    expect(availableOf(balance).amount).toBe(4_000n);
  });

  it.each([
    ['routing without consent', Money.ofMinor(1_000, 'KES'), false, 'issued', 'CONSENT_REQUIRED'],
    ['routing more than unapplied', Money.ofMinor(11_000, 'KES'), true, 'issued', 'CREDIT_NOTE_EXCESS_EXCEEDS_UNAPPLIED'],
    ['routing from a draft', Money.ofMinor(1_000, 'KES'), true, 'draft', 'CREDIT_NOTE_NOT_APPLICABLE'],
    ['routing from a voided note', Money.ofMinor(1_000, 'KES'), true, 'voided', 'CREDIT_NOTE_NOT_APPLICABLE'],
  ])('refuses %s with %s', (_label, amount, consent, state, code) => {
    const issued = noteOf(10_000);
    const target: CreditNote =
      state === 'draft'
        ? draftCreditNote({ id: uid('d0000000001'), customerId, reason: 'x', total: Money.ofMinor(10_000, 'KES') }).note
        : state === 'voided'
          ? voidCreditNote(issued, clock)
          : issued;
    expectCode(() => applyExcessToCreditBalance(target, amount, consent, clock, uid('cc000000001')), code);
  });

  it('refuses routing when nothing is left unapplied', () => {
    const issued = noteOf(10_000);
    const drained = applyExcessToCreditBalance(issued, Money.ofMinor(10_000, 'KES'), true, clock, uid('cc000000001'));
    expectCode(
      () => applyExcessToCreditBalance(drained.note, Money.ofMinor(1_000, 'KES'), true, clock, uid('cc000000002')),
      'CREDIT_NOTE_NO_UNAPPLIED_VALUE',
    );
  });

  it('treats applications and routings as one combined ceiling (R7)', () => {
    const issued = noteOf(10_000);
    const applied = applyCreditNote(issued, receivableId, Money.ofMinor(6_000, 'KES'), clock, uid('aa000000001'));
    expectCode(
      () => applyExcessToCreditBalance(applied.note, Money.ofMinor(5_000, 'KES'), true, clock, uid('cc000000001')),
      'CREDIT_NOTE_EXCESS_EXCEEDS_UNAPPLIED',
    );
  });
});
