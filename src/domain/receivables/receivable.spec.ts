import { describe, expect, it } from 'vitest';
import { DomainError, Money, type Clock, type Uuid, uuid } from '../shared';
import {
  addInvoiceLine,
  createInvoice,
  issueInvoice,
  markInvoiceSent,
  voidInvoice,
  type Invoice,
} from './invoice';
import {
  applyAllocation,
  balanceOf,
  draftReceivableFor,
  markOverdue,
  markUncollectible,
  openReceivable,
  voidReceivable,
  writeOff,
  type Receivable,
} from './receivable';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const INV = uid(1);
const INV_OTHER = uid(11);
const CUST = uid(2);
const REC = uid(3);
const REC_OTHER = uid(4);

const ISSUED_AT = '2025-01-15T09:00:00.000Z';
const DUE = '2025-03-01T00:00:00.000Z';
/** 9 full days past the due date. */
const NOW = '2025-03-10T09:00:00.000Z';
const clock: Clock = { now: () => new Date(NOW) };
const at = (iso: string): Clock => ({ now: () => new Date(iso) });
const reserveNumber = (seq: number): string => `INV-2025-${String(seq).padStart(5, '0')}`;

const TOTAL = Money.ofMinor(10_000, 'KES');
const PART = Money.ofMinor(4_000, 'KES');
const REST = Money.ofMinor(6_000, 'KES');

const draftInvoice = (id: Uuid = INV): Invoice => {
  let inv = createInvoice({ id, customerId: CUST, currency: 'KES', dueDate: new Date(DUE) });
  inv = addInvoiceLine(inv, { description: 'Consulting — January', amount: TOTAL });
  return inv;
};
const issuedInvoice = (id: Uuid = INV): Invoice =>
  issueInvoice(draftInvoice(id), { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
const sentInvoice = (id: Uuid = INV): Invoice =>
  markInvoiceSent(issuedInvoice(id), 'email', at(ISSUED_AT)).invoice;
const voidedInvoice = (id: Uuid = INV): Invoice =>
  voidInvoice(
    issuedInvoice(id),
    { reason: 'raised twice by mistake', actorId: 'ops-01' },
    at(ISSUED_AT),
  ).invoice;

const writeOffArgs = { reason: 'debtor insolvent — board minute 2025/031', approvedBy: 'fin-ops-01' };

// --- state builders (one per docs/03 node) ----------------------------------

const draftRec = (): Receivable => draftReceivableFor(draftInvoice(), REC).receivable;
const openRec = (): Receivable => openReceivable(issuedInvoice(), REC, clock).receivable;
const partialRec = (): Receivable => applyAllocation(openRec(), PART, clock).receivable;
const settledRec = (): Receivable => applyAllocation(openRec(), TOTAL, clock).receivable;
const overdueOpenRec = (): Receivable => markOverdue(openRec(), clock).receivable;
const overduePartialRec = (): Receivable => markOverdue(partialRec(), clock).receivable;
const writtenOffRec = (): Receivable => writeOff(overdueOpenRec(), writeOffArgs, clock).receivable;
const recoveredRec = (): Receivable =>
  applyAllocation(writtenOffRec(), REST, clock).receivable; // balance was 10_000
const uncollectibleRec = (): Receivable =>
  markUncollectible(overdueOpenRec(), { reason: 'verdict: no recoverable assets' }, clock).receivable;
const voidedRec = (): Receivable => voidReceivable(openRec(), clock).receivable;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- tests ------------------------------------------------------------------

describe('Receivable lifecycle (issue #1 — docs/03 state machine)', () => {
  describe('draftReceivableFor — `[*] --> Draft: invoice drafted`', () => {
    it('pairs a draft receivable with a draft invoice and takes the exactly-one slot', () => {
      const invoice = draftInvoice();
      const { invoice: linked, receivable } = draftReceivableFor(invoice, REC);
      expect(receivable.state).toBe('draft');
      expect(receivable.original.equals(TOTAL)).toBe(true);
      expect(receivable.applied.isZero()).toBe(true);
      expect(balanceOf(receivable).equals(TOTAL)).toBe(true);
      expect(linked.receivableId).toBe(REC);
      expect(receivable.openedAt).toBeNull();
    });

    it.each([
      ['issued', () => issuedInvoice()],
      ['sent', () => sentInvoice()],
      ['voided', () => voidedInvoice()],
    ])('refuses to pair with a non-draft (%s) invoice', (_status, build) => {
      expectCode(() => draftReceivableFor(build(), REC), 'INVOICE_NOT_DRAFT');
    });

    it('refuses a second receivable for the same invoice (exactly-one guard)', () => {
      const first = draftReceivableFor(draftInvoice(), REC);
      expectCode(() => draftReceivableFor(first.invoice, REC_OTHER), 'RECEIVABLE_ALREADY_OPEN');
    });
  });

  describe('openReceivable — `Draft --> Open: invoice issued`', () => {
    it('opens from an issued invoice (create mode) and links exactly one receivable', () => {
      const { invoice, receivable, event } = openReceivable(issuedInvoice(), REC, clock);
      expect(receivable.state).toBe('open');
      expect(receivable.openedAt).toEqual(new Date(NOW));
      expect(receivable.overdue).toBe(false);
      expect(invoice.receivableId).toBe(REC);
      // E05 receivable.opened
      expect(event.name).toBe('receivable.opened');
      expect(event.version).toBe(1);
      expect(event.aggregateId).toBe(REC);
      expect(event.occurredAt).toBe(NOW);
      expect(Object.keys(event.payload).sort()).toEqual([
        'dueDate',
        'invoiceId',
        'originalMinor',
        'receivableId',
      ]);
      expect(event.payload).toMatchObject({
        receivableId: REC,
        invoiceId: INV,
        originalMinor: 10_000,
        dueDate: DUE,
      });
    });

    it('transitions a paired draft receivable Draft → Open after issuance', () => {
      const paired = draftReceivableFor(draftInvoice(), REC);
      const issued = issueInvoice(paired.invoice, { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
      const { invoice, receivable, event } = openReceivable(issued, REC, clock, paired.receivable);
      expect(receivable.id).toBe(REC);
      expect(receivable.state).toBe('open');
      expect(receivable.openedAt).toEqual(new Date(NOW));
      expect(invoice.receivableId).toBe(REC);
      expect(event.name).toBe('receivable.opened');
    });

    it.each([
      ['draft', () => draftInvoice()],
      ['sent', () => sentInvoice()],
      ['voided', () => voidedInvoice()],
    ])('refuses to open from a %s invoice', (_status, build) => {
      expectCode(() => openReceivable(build(), REC, clock), 'INVOICE_NOT_ISSUED');
    });

    it('guards double-open: a linked invoice cannot open another receivable', () => {
      const { invoice: linked } = openReceivable(issuedInvoice(), REC, clock);
      expectCode(() => openReceivable(linked, REC_OTHER, clock), 'RECEIVABLE_ALREADY_OPEN');
    });

    it('guards double-open: an already-open receivable cannot be re-opened', () => {
      const paired = draftReceivableFor(draftInvoice(), REC);
      const issued = issueInvoice(paired.invoice, { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
      const { receivable: opened } = openReceivable(issued, REC, clock, paired.receivable);
      expectCode(
        () => openReceivable(issued, REC, clock, opened),
        'RECEIVABLE_ALREADY_OPEN',
      );
    });

    it('rejects a draft receivable paired with a different invoice', () => {
      const paired = draftReceivableFor(draftInvoice(INV), REC);
      const otherIssued = issueInvoice(draftInvoice(INV_OTHER), { sequenceNo: 2, reserveNumber }, at(ISSUED_AT)).invoice;
      expectCode(
        () => openReceivable(otherIssued, REC, clock, paired.receivable),
        'RECEIVABLE_INVOICE_MISMATCH',
      );
    });

    it('rejects a stale draft whose totals no longer match the issued invoice', () => {
      // pairing froze nothing on the INVOICE side — but lines may still grow
      // while the invoice is draft; opening must catch the divergence.
      const paired = draftReceivableFor(draftInvoice(), REC); // draft original = 10_000
      let amended = draftInvoice(); // fresh, unlinked, same id
      amended = addInvoiceLine(amended, {
        description: 'extra scope',
        amount: Money.ofMinor(5_000, 'KES'),
      });
      const issued = issueInvoice(amended, { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
      expectCode(
        () => openReceivable(issued, REC, clock, paired.receivable),
        'RECEIVABLE_INVOICE_MISMATCH',
      );
    });

    it('refuses to open a receivable for a zero-total invoice (no debt, no receivable)', () => {
      const empty = createInvoice({ id: INV, customerId: CUST, currency: 'KES', dueDate: new Date(DUE) });
      const issued = issueInvoice(empty, { sequenceNo: 1, reserveNumber }, at(ISSUED_AT)).invoice;
      expectCode(() => openReceivable(issued, REC, clock), 'INVOICE_TOTAL_ZERO');
    });
  });

  describe('applyAllocation — the receivable side of R1', () => {
    it('partial allocation moves Open → PartiallyPaid and emits receivable.partiallySettled', () => {
      const { receivable, event } = applyAllocation(openRec(), PART, clock);
      expect(receivable.state).toBe('partially_paid');
      expect(receivable.applied.amount).toBe(4_000n);
      expect(balanceOf(receivable).amount).toBe(6_000n);
      expect(event.name).toBe('receivable.partiallySettled');
      expect(Object.keys(event.payload).sort()).toEqual(['amountMinor', 'receivableId', 'remainingMinor']);
      expect(event.payload).toMatchObject({ receivableId: REC, amountMinor: 4_000, remainingMinor: 6_000 });
    });

    it('a full allocation settles directly from Open and emits receivable.settled', () => {
      const { receivable, event } = applyAllocation(openRec(), TOTAL, clock);
      expect(receivable.state).toBe('settled');
      expect(receivable.settledAt).toEqual(new Date(NOW));
      expect(balanceOf(receivable).isZero()).toBe(true);
      expect(event.name).toBe('receivable.settled');
      expect(Object.keys(event.payload).sort()).toEqual(['receivableId', 'settledAt']);
      expect(event.payload).toMatchObject({ receivableId: REC, settledAt: NOW });
    });

    it('settles the remainder from PartiallyPaid', () => {
      const { receivable, event } = applyAllocation(partialRec(), REST, clock);
      expect(receivable.state).toBe('settled');
      expect(receivable.applied.amount).toBe(10_000n);
      expect(event.name).toBe('receivable.settled');
    });

    it('a second partial allocation stays PartiallyPaid and reports the remaining balance', () => {
      const once = applyAllocation(openRec(), Money.ofMinor(1_500, 'KES'), clock).receivable;
      const { receivable, event } = applyAllocation(once, Money.ofMinor(2_500, 'KES'), clock);
      expect(receivable.state).toBe('partially_paid');
      expect(balanceOf(receivable).amount).toBe(6_000n);
      expect(event.payload).toMatchObject({ amountMinor: 2_500, remainingMinor: 6_000 });
    });

    it('an overdue receivable can still settle (Overdue → Settled) and the flag clears', () => {
      const { receivable, event } = applyAllocation(overdueOpenRec(), TOTAL, clock);
      expect(receivable.state).toBe('settled');
      expect(receivable.overdue).toBe(false);
      expect(event.name).toBe('receivable.settled');
    });

    it('an allocation on a written-off receivable records recovery (WrittenOff → Recovered)', () => {
      const { receivable, event } = applyAllocation(writtenOffRec(), REST, clock);
      expect(receivable.state).toBe('recovered');
      expect(receivable.recoveredAt).toEqual(new Date(NOW));
      expect(receivable.applied.amount).toBe(6_000n);
      expect(balanceOf(receivable).amount).toBe(4_000n);
      // the H1 audit record survives recovery
      expect(receivable.writeOff).toEqual({ ...writeOffArgs, writtenOffAt: new Date(NOW) });
      expect(event.name).toBe('receivable.recovered');
      expect(Object.keys(event.payload).sort()).toEqual(['amountMinor', 'receivableId']);
      expect(event.payload).toMatchObject({ receivableId: REC, amountMinor: 6_000 });
    });

    it('recovered is terminal — no further allocations', () => {
      expectCode(() => applyAllocation(recoveredRec(), Money.ofMinor(1, 'KES'), clock), 'INVALID_RECEIVABLE_TRANSITION');
    });

    it.each([
      ['exceeding the balance', () => applyAllocation(openRec(), Money.ofMinor(10_001, 'KES'), clock), 'ALLOCATION_EXCEEDS_BALANCE'],
      ['zero amount', () => applyAllocation(openRec(), Money.zero('KES'), clock), 'ALLOCATION_AMOUNT_INVALID'],
      ['cross-currency amount', () => applyAllocation(openRec(), Money.ofMinor(1_000, 'USD'), clock), 'CURRENCY_MISMATCH'],
      ['exceeding a written-off balance', () => applyAllocation(writtenOffRec(), Money.ofMinor(10_001, 'KES'), clock), 'ALLOCATION_EXCEEDS_BALANCE'],
    ])('rejects %s', (_case, attempt, code) => {
      expectCode(attempt, code);
    });

    it.each([
      ['draft', () => draftRec()],
      ['settled', () => settledRec()],
      ['uncollectible', () => uncollectibleRec()],
      ['voided', () => voidedRec()],
    ])('refuses allocations from %s', (_state, build) => {
      expectCode(() => applyAllocation(build(), PART, clock), 'INVALID_RECEIVABLE_TRANSITION');
    });

    it('keeps the R1 invariant across a chain: applied + balance = original, never negative, settled ⇔ balance 0', () => {
      let rec = openRec();
      expect(balanceOf(rec).equals(TOTAL)).toBe(true);
      for (const slice of [1_500, 3_500, 5_000]) {
        rec = applyAllocation(rec, Money.ofMinor(slice, 'KES'), clock).receivable;
        expect(rec.applied.add(balanceOf(rec)).equals(rec.original)).toBe(true);
        expect(balanceOf(rec).amount >= 0n).toBe(true);
      }
      expect(rec.state).toBe('settled');
      expect(balanceOf(rec).isZero()).toBe(true);
    });
  });

  describe('markOverdue — stored flag (derivable, cached for query speed)', () => {
    it('flags an open receivable past due and emits receivable.overdue with daysLate + bucket', () => {
      const { receivable, event } = markOverdue(openRec(), clock);
      expect(receivable.overdue).toBe(true);
      expect(receivable.state).toBe('open');
      expect(event.name).toBe('receivable.overdue');
      expect(Object.keys(event.payload).sort()).toEqual(['agingBucket', 'daysLate', 'receivableId']);
      expect(event.payload).toMatchObject({ receivableId: REC, daysLate: 9, agingBucket: '0-30' });
    });

    it('flags a partially-paid receivable too', () => {
      const { receivable, event } = markOverdue(partialRec(), clock);
      expect(receivable.overdue).toBe(true);
      expect(receivable.state).toBe('partially_paid');
      expect(event.payload).toMatchObject({ daysLate: 9 });
    });

    it.each([
      ['draft', () => draftRec()],
      ['settled', () => settledRec()],
      ['written_off', () => writtenOffRec()],
      ['recovered', () => recoveredRec()],
      ['uncollectible', () => uncollectibleRec()],
      ['voided', () => voidedRec()],
    ])('refuses overdue from %s', (_state, build) => {
      expectCode(() => markOverdue(build(), clock), 'INVALID_RECEIVABLE_TRANSITION');
    });

    it('refuses double-marking (schedulers must surface bugs, not re-emit)', () => {
      expectCode(() => markOverdue(overdueOpenRec(), clock), 'OVERDUE_ALREADY_MARKED');
    });

    it('refuses while the due date has not passed (today and future)', () => {
      expectCode(() => markOverdue(openRec(), at(DUE)), 'RECEIVABLE_NOT_DUE');
      expectCode(() => markOverdue(openRec(), at('2025-02-01T00:00:00.000Z')), 'RECEIVABLE_NOT_DUE');
    });
  });

  describe('writeOff — H1: an approved decision with an owner, never a deletion', () => {
    it('writes off an overdue open receivable with reason + approver and emits receivable.writtenOff', () => {
      const { receivable, event } = writeOff(overdueOpenRec(), writeOffArgs, clock);
      expect(receivable.state).toBe('written_off');
      expect(receivable.writeOff).toEqual({ ...writeOffArgs, writtenOffAt: new Date(NOW) });
      // the debt record survives — write-off changes state, never deletes
      expect(receivable.original.equals(TOTAL)).toBe(true);
      expect(receivable.applied.isZero()).toBe(true);
      expect(receivable.overdue).toBe(true);
      expect(event.name).toBe('receivable.writtenOff');
      expect(Object.keys(event.payload).sort()).toEqual(['approvedBy', 'reason', 'receivableId']);
      expect(event.payload).toMatchObject({
        receivableId: REC,
        reason: writeOffArgs.reason,
        approvedBy: writeOffArgs.approvedBy,
      });
    });

    it('writes off an overdue partially-paid receivable, preserving what was paid', () => {
      const { receivable } = writeOff(overduePartialRec(), writeOffArgs, clock);
      expect(receivable.state).toBe('written_off');
      expect(receivable.applied.amount).toBe(4_000n);
      expect(balanceOf(receivable).amount).toBe(6_000n);
    });

    it.each([
      ['open', () => openRec()],
      ['partially_paid', () => partialRec()],
    ])('refuses write-off from a %s receivable that is not overdue (docs/03: via Overdue only)', (_state, build) => {
      expectCode(() => writeOff(build(), writeOffArgs, clock), 'WRITE_OFF_REQUIRES_OVERDUE');
    });

    it.each([
      ['draft', () => draftRec()],
      ['settled', () => settledRec()],
      ['recovered', () => recoveredRec()],
      ['uncollectible', () => uncollectibleRec()],
      ['voided', () => voidedRec()],
    ])('refuses write-off from %s', (_state, build) => {
      expectCode(() => writeOff(build(), writeOffArgs, clock), 'INVALID_RECEIVABLE_TRANSITION');
    });

    it('requires both a reason and an approver', () => {
      const rec = overdueOpenRec();
      expectCode(() => writeOff(rec, { reason: '   ', approvedBy: 'fin-ops-01' }, clock), 'WRITE_OFF_REASON_REQUIRED');
      expectCode(() => writeOff(rec, { reason: 'insolvent', approvedBy: '' }, clock), 'WRITE_OFF_APPROVER_REQUIRED');
    });
  });

  describe('markUncollectible — collections verdict (Overdue → Uncollectible)', () => {
    const verdict = { reason: 'collections verdict: debtor deceased, no estate' };

    it('records the verdict with a reason on an overdue receivable', () => {
      const { receivable } = markUncollectible(overdueOpenRec(), verdict, clock);
      expect(receivable.state).toBe('uncollectible');
      expect(receivable.uncollectibleReason).toBe(verdict.reason);
      expect(receivable.uncollectibleAt).toEqual(new Date(NOW));
      expect(receivable.original.equals(TOTAL)).toBe(true);
    });

    it('refuses a verdict from live receivables that are not overdue', () => {
      expectCode(() => markUncollectible(openRec(), verdict, clock), 'UNCOLLECTIBLE_REQUIRES_OVERDUE');
      expectCode(() => markUncollectible(partialRec(), verdict, clock), 'UNCOLLECTIBLE_REQUIRES_OVERDUE');
    });

    it.each([
      ['draft', () => draftRec()],
      ['settled', () => settledRec()],
      ['written_off', () => writtenOffRec()],
      ['recovered', () => recoveredRec()],
      ['voided', () => voidedRec()],
    ])('refuses a verdict from %s', (_state, build) => {
      expectCode(() => markUncollectible(build(), verdict, clock), 'INVALID_RECEIVABLE_TRANSITION');
    });

    it('refuses a blank verdict reason', () => {
      expectCode(() => markUncollectible(overdueOpenRec(), { reason: ' ' }, clock), 'UNCOLLECTIBLE_REASON_REQUIRED');
    });
  });

  describe('voidReceivable — `Open --> Voided: invoice voided before payment`', () => {
    it('voids an untouched open receivable, even an overdue one, and clears the flag', () => {
      const { receivable } = voidReceivable(overdueOpenRec(), clock);
      expect(receivable.state).toBe('voided');
      expect(receivable.voidedAt).toEqual(new Date(NOW));
      expect(receivable.overdue).toBe(false);
      expect(receivable.applied.isZero()).toBe(true);
    });

    it('refuses to void once funds are applied (void only when appliedMinor === 0)', () => {
      expectCode(() => voidReceivable(partialRec(), clock), 'RECEIVABLE_VOID_REQUIRES_ZERO_APPLIED');
      expectCode(() => voidReceivable(overduePartialRec(), clock), 'RECEIVABLE_VOID_REQUIRES_ZERO_APPLIED');
    });

    it.each([
      ['draft', () => draftRec()],
      ['settled', () => settledRec()],
      ['written_off', () => writtenOffRec()],
      ['recovered', () => recoveredRec()],
      ['uncollectible', () => uncollectibleRec()],
      ['voided', () => voidedRec()],
    ])('refuses to void from %s', (_state, build) => {
      expectCode(() => voidReceivable(build(), clock), 'INVALID_RECEIVABLE_TRANSITION');
    });
  });

  describe('event envelope', () => {
    it('every receivable event is a plain { name, version, aggregateId, occurredAt, payload }', () => {
      const events = [
        openReceivable(issuedInvoice(), REC, clock).event,
        applyAllocation(openRec(), PART, clock).event,
        applyAllocation(openRec(), TOTAL, clock).event,
        markOverdue(openRec(), clock).event,
        writeOff(overdueOpenRec(), writeOffArgs, clock).event,
        applyAllocation(writtenOffRec(), REST, clock).event,
      ];
      for (const event of events) {
        expect(Object.keys(event).sort()).toEqual([
          'aggregateId',
          'name',
          'occurredAt',
          'payload',
          'version',
        ]);
        expect(event.version).toBe(1);
        expect(event.aggregateId).toBe(REC);
        expect(event.occurredAt).toBe(NOW);
      }
    });
  });
});
