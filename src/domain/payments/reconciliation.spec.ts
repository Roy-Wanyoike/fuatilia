import { describe, expect, it } from 'vitest';
import { DomainError, Money, uuid } from '../shared';
import type { Clock, Uuid } from '../shared';
import { intakePayment } from './intake';
import { awaitConfirmation, confirmPayment, failPayment } from './payment';
import type { Payment } from './payment';
import {
  matchDecision,
  recordMatch,
  reverseMatch,
  type MatchConfidence,
  type OpenInvoiceRef,
  type ReconciliationMatch,
} from './reconciliation';

const T0 = Date.UTC(2025, 2, 15, 8, 0, 0);
let tick = 0;
const clock: Clock = { now: () => new Date(T0 + tick++ * 1_000) };

const expectCode = (act: () => unknown, code: string): void => {
  try {
    act();
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`expected DomainError ${code}, but nothing was thrown`);
};

const rid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

const confirmed = (over: {
  externalRef: string;
  idempotencyKey: string;
  declaredRefs?: string[];
  paymentId?: Uuid;
  amountMinor?: bigint;
}): Payment => {
  const { payment } = intakePayment(
    {
      channel: 'c2b',
      externalRef: over.externalRef,
      idempotencyKey: over.idempotencyKey,
      amount: Money.ofMinor(over.amountMinor ?? 300_000, 'KES'),
      declaredRefs: over.declaredRefs,
      paymentId: over.paymentId,
    },
    { clock },
  );
  const amount = Money.ofMinor(over.amountMinor ?? 300_000, 'KES');
  return confirmPayment(awaitConfirmation(payment).payment, amount, clock).payment;
};

const initiated = (): Payment =>
  intakePayment(
    {
      channel: 'c2b',
      externalRef: 'NOPE0001',
      idempotencyKey: 'idem-unconfirmed',
      amount: Money.ofMinor(1_000, 'KES'),
      paymentId: rid(11),
    },
    { clock },
  ).payment;

// Three open invoices for one customer — the wave-1 reconciliation universe.
const invoices: OpenInvoiceRef[] = [
  { receivableId: rid(61), invoiceNumber: 'INV-2024-001', dueDate: new Date(Date.UTC(2025, 3, 10)) },
  { receivableId: rid(62), invoiceNumber: 'INV-2024-002', dueDate: new Date(Date.UTC(2025, 2, 1)) },
  { receivableId: rid(63), invoiceNumber: 'INV-2024-003', dueDate: new Date(Date.UTC(2025, 5, 30)) },
];

const THREE_REFS = ['INV-2024-001', 'INV-2024-002', 'INV-2024-003'];

describe('ReconciliationMatch — the only target is paymentId (R5, C1)', () => {
  it('recordMatch stores declaredRefs and emits reconciliation.paymentMatched (E16)', () => {
    const payment = confirmed({ externalRef: 'QJK44PL9XW', idempotencyKey: 'bulk-1', declaredRefs: THREE_REFS, paymentId: rid(60) });
    const { match, events } = recordMatch(payment, THREE_REFS, 'auto', clock);
    expect(match.id).toBeDefined();
    expect(match.paymentId).toBe(payment.id);
    expect(match.declaredRefs).toEqual(THREE_REFS);
    expect(match.confidence).toBe('auto');
    expect(match.matchedAt).toBeInstanceOf(Date);
    expect(match.reversedAt).toBeUndefined();
    // C1: the match carries NO receivable/invoice target whatsoever.
    expect(Object.keys(match).sort()).toEqual(['confidence', 'declaredRefs', 'id', 'matchedAt', 'paymentId']);
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt?.name).toBe('reconciliation.paymentMatched');
    if (evt?.name !== 'reconciliation.paymentMatched') throw new Error('unexpected event');
    expect(evt.version).toBe(1);
    expect(evt.aggregateId).toBe(match.id);
    expect(evt.payload).toMatchObject({
      matchId: match.id,
      paymentId: payment.id,
      declaredRefs: THREE_REFS,
      confidence: 'auto',
    });
  });

  it('matching applies only to confirmed money', () => {
    expectCode(() => recordMatch(initiated(), THREE_REFS, 'manual', clock), 'PAYMENT_NOT_CONFIRMED');
  });

  it('terminal payments cannot be matched', () => {
    const failed = failPayment(initiated(), 'CX103', clock).payment;
    expectCode(() => recordMatch(failed, ['INV-1'], 'auto', clock), 'PAYMENT_TERMINAL');
  });

  const invalidRows: { name: string; refs: string[]; confidence?: MatchConfidence; code: string }[] = [
    { name: 'no refs at all', refs: [], code: 'MATCH_REFS_REQUIRED' },
    { name: 'a blank ref', refs: ['INV-1', '   '], code: 'MATCH_REF_BLANK' },
    { name: 'unknown confidence', refs: ['INV-1'], confidence: 'semi' as MatchConfidence, code: 'MATCH_CONFIDENCE_INVALID' },
  ];
  it.each(invalidRows)('recordMatch rejects $name ($code)', ({ refs, confidence, code }) => {
    const payment = confirmed({ externalRef: 'QK1', idempotencyKey: 'k-inv', paymentId: rid(13) });
    expectCode(() => recordMatch(payment, refs, confidence ?? 'auto', clock), code);
  });
});

describe('reverseMatch — append-only reversal (R3)', () => {
  it('returns a NEW match carrying the reversal; the original is never edited', () => {
    const payment = confirmed({ externalRef: 'QK2', idempotencyKey: 'k-rev', paymentId: rid(14) });
    const { match } = recordMatch(payment, ['INV-2024-001'], 'manual', clock);
    const { match: reversed, events } = reverseMatch(match, 'matched wrong customer', clock);
    expect(reversed).not.toBe(match);
    expect(reversed.reversedAt).toBeInstanceOf(Date);
    expect(reversed.reversalReason).toBe('matched wrong customer');
    expect(match.reversedAt).toBeUndefined();
    expect(match.reversalReason).toBeUndefined();
    expect(reversed.paymentId).toBe(match.paymentId);
    expect(events.map((e) => e.name)).toEqual(['reconciliation.matchReversed']);
    const evt = events[0];
    if (evt?.name !== 'reconciliation.matchReversed') throw new Error('unexpected event');
    expect(evt.payload).toMatchObject({ matchId: match.id, reason: 'matched wrong customer' });
  });

  it('double reversal is rejected; a reason is required', () => {
    const payment = confirmed({ externalRef: 'QK3', idempotencyKey: 'k-rev2', paymentId: rid(15) });
    const { match } = recordMatch(payment, ['INV-2024-002'], 'auto', clock);
    const { match: reversed } = reverseMatch(match, 'wrong payment', clock);
    expectCode(() => reverseMatch(reversed, 'again', clock), 'MATCH_ALREADY_REVERSED');
    expectCode(() => reverseMatch(match, '  ', clock), 'REVERSAL_REASON_REQUIRED');
  });
});

describe('matchDecision — exact first, then fuzzy, else unapplied', () => {
  it('exact externalRef→invoiceNumber wins and beats fuzzy declaredRefs', () => {
    const payment = confirmed({
      externalRef: 'INV-2024-002',
      idempotencyKey: 'k-exact',
      declaredRefs: ['0099'],
      paymentId: rid(16),
    });
    const decision = matchDecision(payment, invoices);
    expect(decision.decision).toBe('matched');
    if (decision.decision !== 'matched') throw new Error('unreachable');
    expect(decision.basis).toBe('exact');
    expect(decision.candidates).toHaveLength(1);
    expect(decision.candidates[0]?.receivableId).toBe(rid(62));
    expect(decision.candidates[0]?.invoiceNumber).toBe('INV-2024-002');
  });

  it('fuzzy declaredRefs match returns ALL matching invoices, earliest due first', () => {
    const payment = confirmed({
      externalRef: 'QJK44PL9XW',
      idempotencyKey: 'k-fuzzy',
      declaredRefs: THREE_REFS,
      paymentId: rid(17),
    });
    const decision = matchDecision(payment, invoices);
    expect(decision.decision).toBe('matched');
    if (decision.decision !== 'matched') throw new Error('unreachable');
    expect(decision.basis).toBe('fuzzy');
    expect(decision.candidates.map((c) => c.receivableId)).toEqual([rid(62), rid(61), rid(63)]);
    expect(decision.candidates.map((c) => c.invoiceNumber)).toEqual([
      'INV-2024-002',
      'INV-2024-001',
      'INV-2024-003',
    ]);
  });

  it('payer-typed partial refs still match (suffix, ≥3 significant chars)', () => {
    const payment = confirmed({
      externalRef: 'ZZZ01',
      idempotencyKey: 'k-partial',
      declaredRefs: ['2024-003'],
      paymentId: rid(18),
    });
    const decision = matchDecision(payment, invoices);
    expect(decision).toMatchObject({ decision: 'matched', basis: 'fuzzy' });
    if (decision.decision !== 'matched') throw new Error('unreachable');
    expect(decision.candidates.map((c) => c.receivableId)).toEqual([rid(63)]);
  });

  it('tiny trivial refs never fuzzy-match (min-length guard)', () => {
    const payment = confirmed({
      externalRef: 'ZZZ02',
      idempotencyKey: 'k-tiny',
      declaredRefs: ['12'],
      paymentId: rid(19),
    });
    expect(matchDecision(payment, invoices)).toEqual({
      decision: 'unapplied',
      paymentId: payment.id,
    });
  });

  it('nothing explains the payment → unapplied (the money parks, it is never dropped)', () => {
    const payment = confirmed({ externalRef: 'MYSTERY9', idempotencyKey: 'k-none', paymentId: rid(20) });
    expect(matchDecision(payment, invoices)).toEqual({
      decision: 'unapplied',
      paymentId: payment.id,
    });
  });

  it('the decision is advisory only — no amounts, no allocation fields (wave 2 allocates)', () => {
    const payment = confirmed({
      externalRef: 'QJK44PL9XW',
      idempotencyKey: 'k-adv',
      declaredRefs: THREE_REFS,
      paymentId: rid(21),
    });
    const decision = matchDecision(payment, invoices);
    expect(Object.keys(decision).sort()).toEqual(['basis', 'candidates', 'decision', 'paymentId']);
    if (decision.decision !== 'matched') throw new Error('unreachable');
    expect(decision.candidates.every((c) => !('amountMinor' in c) && !('amount' in c))).toBe(true);
  });

  it('refuses to decide on unconfirmed or terminal payments', () => {
    expectCode(() => matchDecision(initiated(), invoices), 'PAYMENT_NOT_CONFIRMED');
    const failed = failPayment(initiated(), 'CX103', clock).payment;
    expectCode(() => matchDecision(failed, invoices), 'PAYMENT_TERMINAL');
  });
});

describe('SCENARIO (mandatory): one payment + three invoices is cleanly representable', () => {
  it('a single C2B payment covers three invoices via declaredRefs; the match targets only the payment (R5/C1)', () => {
    // 1. One paybill payment of KES 3,000.00 arrives, payer types all three invoice refs.
    const payment = confirmed({
      externalRef: 'QJK44PL9XW',
      idempotencyKey: 'paybill-bulk-1',
      declaredRefs: THREE_REFS,
      paymentId: rid(23),
    });
    expect(payment.declaredRefs).toHaveLength(3);

    // 2. The pure decision explains the payment with all three open invoices.
    const decision = matchDecision(payment, invoices);
    expect(decision.decision).toBe('matched');
    if (decision.decision !== 'matched') throw new Error('unreachable');
    expect(decision.candidates).toHaveLength(3);

    // 3. The durable match points at the payment — and at nothing else.
    const { match } = recordMatch(payment, THREE_REFS, 'auto', clock, rid(24));
    expect(match.paymentId).toBe(payment.id);
    expect(Object.keys(match)).not.toContain('receivableId');
    expect(Object.keys(match)).not.toContain('invoiceId');
    expect(Object.keys(match)).not.toContain('invoiceNumber');
    expect(match.declaredRefs).toEqual(THREE_REFS);

    // 4. Nothing was allocated: the payment still holds all its money unapplied.
    expect(payment.state).toBe('confirmed');
    expect(payment.allocations).toHaveLength(0);

    // 5. A reversal appends state; history is preserved (R3).
    const { match: reversed } = reverseMatch(match, 'payer mis-typed refs', clock);
    expect(reversed.reversedAt).toBeDefined();
    expect(reversed.declaredRefs).toEqual(THREE_REFS);
    expect(match.reversedAt).toBeUndefined();
    expect(match.reversalReason).toBeUndefined();
  });

  it('the same scenario works through the manual confidence path', () => {
    const payment = confirmed({
      externalRef: 'QJK44PL9XW',
      idempotencyKey: 'paybill-bulk-2',
      declaredRefs: THREE_REFS,
      paymentId: rid(25),
    });
    const { match, events } = recordMatch(payment, THREE_REFS, 'manual', clock);
    expect(match.confidence).toBe('manual');
    expect(events.map((e) => e.name)).toEqual(['reconciliation.paymentMatched']);
    const matches: ReconciliationMatch[] = [match];
    expect(matches).toHaveLength(1);
  });
});
