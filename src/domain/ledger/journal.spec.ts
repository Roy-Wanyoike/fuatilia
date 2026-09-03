import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared';
import type { Clock, Uuid } from '../shared';
import { accountBalanceMinor, describeLine, isAccount, isPostingDirection, toJournalLine } from './accounts';
import type { Account, JournalLineInput } from './accounts';
import { arControlBalanceMinor, findPostedEntry, post, postEntry, reverseEntry } from './journal';
import type { JournalEntry } from './journal';
import { isPostableEvent } from './matrix';
import { MONEY_MOVEMENT_EVENT_NAMES } from './events';
import type { MoneyMovementEvent, MoneyMovementEventName } from './events';

const clock: Clock = { now: () => new Date('2025-09-02T08:00:00.000Z') };

/** Deterministic 36-char hex ids for table-driven tests. */
const uid = (tail: string): Uuid => `00000000-0000-4000-8000-${tail.padStart(12, '0')}` as Uuid;

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

const movement = (overrides: Partial<MoneyMovementEvent> = {}): MoneyMovementEvent => ({
  name: 'invoicing.invoiceIssued',
  sourceEventId: uid('a00000000001'),
  orgId: 'org-1',
  occurredAt: '2025-09-01T10:00:00.000Z',
  amountMinor: 125_000,
  currency: 'KES',
  reference: 'INV-0001',
  actor: 'invoicing-service',
  ...overrides,
});

/** Issue #18 row → (debit, credit) — the docs/05 posting matrix, verbatim. */
const MATRIX_ROWS: readonly (readonly [MoneyMovementEventName, Account, Account])[] = [
  ['invoicing.invoiceIssued', 'AR_CONTROL', 'REVENUE'],
  ['payments.paymentCompleted', 'CASH', 'AR_CONTROL'],
  ['adjustments.creditNoteApplied', 'REVENUE_CONTRA', 'AR_CONTROL'],
  ['adjustments.refundCompleted', 'SALES_REFUNDS', 'CASH'],
  ['receivables.writeOffApproved', 'BAD_DEBT_EXPENSE', 'AR_CONTROL'],
  ['receivables.lateFeeAssessed', 'AR_CONTROL', 'OTHER_INCOME'],
];

describe('posting matrix — every row posts exactly one balanced entry (K5/R4)', () => {
  it.each(MATRIX_ROWS)('%s → Dr %s / Cr %s', (name, debit, credit) => {
    const result = post(movement({ name }), [], clock);
    expect(result.outcome).toBe('posted');
    expect(result.entry.lines).toHaveLength(2);
    const [dr, cr] = result.entry.lines;
    expect(dr).toEqual({ account: debit, direction: 'DEBIT', amountMinor: 125_000n, currency: 'KES' });
    expect(cr).toEqual({ account: credit, direction: 'CREDIT', amountMinor: 125_000n, currency: 'KES' });
    // SPEC §17: every movement carries the full audit payload
    expect(result.entry.status).toBe('POSTED');
    expect(result.entry.orgId).toBe('org-1');
    expect(result.entry.occurredAt).toBe('2025-09-01T10:00:00.000Z');
    expect(result.entry.postedAt).toBe('2025-09-02T08:00:00.000Z');
    expect(result.entry.sourceEventName).toBe(name);
    expect(result.entry.sourceEventId).toBe(uid('a00000000001'));
    expect(result.entry.reference).toBe('INV-0001');
    expect(result.entry.actor).toBe('invoicing-service');
    expect(result.entry.reversalOf).toBeUndefined();
  });

  it('emits exactly one ledger.entryPosted event per posting (R4)', () => {
    const { entry, events } = post(movement({ name: 'payments.paymentCompleted', amountMinor: 42_500 }), [], clock);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('ledger.entryPosted');
    expect(events[0]!.version).toBe(1);
    expect(events[0]!.aggregateId).toBe(entry.entryId);
    const posted = events[0]!;
    if (posted.name !== 'ledger.entryPosted') throw new Error(`unexpected event ${posted.name}`);
    expect(posted.payload).toMatchObject({
      orgId: 'org-1',
      sourceEventName: 'payments.paymentCompleted',
      sourceEventId: uid('a00000000001'),
      amountMinor: 42_500,
      currency: 'KES',
      status: 'POSTED',
      reversalOf: null,
    });
  });

  it('rejects every event with no matrix row (LEDGER_EVENT_NOT_POSTABLE)', () => {
    expectCode(() => post(movement({ name: 'allocation.executed' as MoneyMovementEventName }), [], clock), 'LEDGER_EVENT_NOT_POSTABLE');
    expectCode(() => post(movement({ name: 'payments.paymentFailed' as MoneyMovementEventName }), [], clock), 'LEDGER_EVENT_NOT_POSTABLE');
    expectCode(() => post(movement({ name: 'reconciliation.paymentMatched' as MoneyMovementEventName }), [], clock), 'LEDGER_EVENT_NOT_POSTABLE');
    expect(isPostableEvent('invoicing.invoiceIssued')).toBe(true);
    expect(isPostableEvent('allocation.executed')).toBe(false);
    expect(MONEY_MOVEMENT_EVENT_NAMES).toHaveLength(6);
  });

  it('rejects malformed movement input with stable codes', () => {
    const cases: readonly (readonly [string, Partial<MoneyMovementEvent>])[] = [
      ['blank orgId', { orgId: '  ' }],
      ['blank reference', { reference: '' }],
      ['blank actor', { actor: ' ' }],
      ['non-ISO occurredAt', { occurredAt: 'yesterday' }],
      ['zero amount', { amountMinor: 0 }],
      ['negative amount', { amountMinor: -125_000 }],
      ['fractional amount', { amountMinor: 125.5 }],
      ['unsafe-integer amount', { amountMinor: 2 ** 53 }],
      ['unknown currency', { currency: 'XYZ' as 'KES' }],
    ];
    const codes = [
      'LEDGER_ORG_REQUIRED',
      'LEDGER_REFERENCE_REQUIRED',
      'LEDGER_ACTOR_REQUIRED',
      'LEDGER_OCCURRED_AT_INVALID',
      'LEDGER_AMOUNT_INVALID',
      'LEDGER_AMOUNT_INVALID',
      'LEDGER_AMOUNT_NOT_INTEGER',
      'LEDGER_AMOUNT_NOT_INTEGER',
      'LEDGER_CURRENCY_INVALID',
    ] as const;
    cases.forEach(([label, override], i) => {
      expectCode(() => post(movement(override), [], clock), codes[i]!);
      void label;
    });
    expectCode(() => post(movement({ sourceEventId: 'not-a-uuid' as Uuid }), [], clock), 'LEDGER_ID_INVALID');
  });

  it('accepts bigint minor units and derives a deterministic entryId per (org, sourceEventId)', () => {
    const a = post(movement({ amountMinor: 125_000n }), [], clock);
    const b = post(movement({ amountMinor: 125_000n }), [], clock);
    expect(b.entry.entryId).toBe(a.entry.entryId); // same logical movement ⇒ same id
  });
});

describe('idempotency — a replay never double-posts (SPEC §17, R9 spirit)', () => {
  it('returns the ORIGINAL entry unchanged on the same sourceEventId, with zero events', () => {
    const first = post(movement(), [], clock);
    expect(first.outcome).toBe('posted');
    const replay = post(movement(), [first.entry], clock);
    expect(replay.outcome).toBe('already_posted');
    expect(replay.entry).toBe(first.entry); // the very same object — untouched
    expect(replay.events).toHaveLength(0);
    expect(findPostedEntry([first.entry], 'org-1', uid('a00000000001'))).toBe(first.entry);
    expect(findPostedEntry([first.entry], 'org-2', uid('a00000000001'))).toBeUndefined();
  });

  it('scopes idempotency by org: the same event id under another org posts its own entry', () => {
    const first = post(movement(), [], clock);
    const other = post(movement({ orgId: 'org-2' }), [first.entry], clock);
    expect(other.outcome).toBe('posted');
    expect(other.entry.orgId).toBe('org-2');
  });

  it('refuses a mutated "replay" that reuses a posted sourceEventId (LEDGER_IDEMPOTENCY_CONFLICT)', () => {
    const first = post(movement(), [], clock);
    expectCode(() => post(movement({ amountMinor: 999 }), [first.entry], clock), 'LEDGER_IDEMPOTENCY_CONFLICT');
    expectCode(() => post(movement({ currency: 'USD' }), [first.entry], clock), 'LEDGER_IDEMPOTENCY_CONFLICT');
    expectCode(() => post(movement({ occurredAt: '2025-09-01T11:00:00.000Z' }), [first.entry], clock), 'LEDGER_IDEMPOTENCY_CONFLICT');
  });
});

describe('explicit-lines posting (postEntry) — unbalanced input is rejected', () => {
  const base = {
    orgId: 'org-1',
    occurredAt: '2025-09-01T10:00:00.000Z',
    sourceEventName: 'payments.paymentCompleted',
    sourceEventId: uid('b00000000001'),
    reference: 'SBX123XY91',
    actor: 'payments-service',
  };

  it('posts a balanced compound entry (multi-line, single currency)', () => {
    const lines: JournalLineInput[] = [
      { account: 'AR_CONTROL', direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
      { account: 'REVENUE', direction: 'CREDIT', amountMinor: 60, currency: 'KES' },
      { account: 'AR_CONTROL', direction: 'CREDIT', amountMinor: 40, currency: 'KES' },
    ];
    const result = postEntry({ ...base, lines }, [], clock);
    expect(result.outcome).toBe('posted');
    expect(result.entry.lines).toHaveLength(3);
  });

  it('rejects unbalanced, empty, mixed-currency, self-canceling and malformed lines', () => {
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
              { account: 'AR_CONTROL', direction: 'CREDIT', amountMinor: 90, currency: 'KES' },
            ],
          },
          [],
          clock,
        ),
      'LEDGER_ENTRY_UNBALANCED',
    );
    expectCode(() => postEntry({ ...base, lines: [] }, [], clock), 'LEDGER_ENTRY_EMPTY');
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
              { account: 'REVENUE', direction: 'CREDIT', amountMinor: 100, currency: 'USD' },
            ],
          },
          [],
          clock,
        ),
      'CURRENCY_MISMATCH',
    );
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
              { account: 'CASH', direction: 'CREDIT', amountMinor: 100, currency: 'KES' },
            ],
          },
          [],
          clock,
        ),
      'LEDGER_ENTRY_SELF_CANCELING',
    );
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'MOON' as Account, direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
              { account: 'REVENUE', direction: 'CREDIT', amountMinor: 100, currency: 'KES' },
            ],
          },
          [],
          clock,
        ),
      'LEDGER_ACCOUNT_UNKNOWN',
    );
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'SIDEWAYS' as 'DEBIT', amountMinor: 100, currency: 'KES' },
              { account: 'REVENUE', direction: 'CREDIT', amountMinor: 100, currency: 'KES' },
            ],
          },
          [],
          clock,
        ),
      'LEDGER_DIRECTION_INVALID',
    );
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'DEBIT', amountMinor: 0, currency: 'KES' },
              { account: 'REVENUE', direction: 'CREDIT', amountMinor: 0, currency: 'KES' },
            ],
          },
          [],
          clock,
        ),
      'LEDGER_AMOUNT_ZERO',
    );
    expectCode(() => postEntry({ ...base, sourceEventName: ' ', lines: [] }, [], clock), 'LEDGER_SOURCE_EVENT_REQUIRED');
  });

  it('is idempotent on (orgId, sourceEventId): same lines replay, different lines conflict', () => {
    const lines: JournalLineInput[] = [
      { account: 'CASH', direction: 'DEBIT', amountMinor: 100, currency: 'KES' },
      { account: 'AR_CONTROL', direction: 'CREDIT', amountMinor: 100, currency: 'KES' },
    ];
    const first = postEntry({ ...base, lines }, [], clock);
    expect(first.outcome).toBe('posted');
    const replay = postEntry({ ...base, lines }, [first.entry], clock);
    expect(replay.outcome).toBe('already_posted');
    expect(replay.entry).toBe(first.entry);
    expectCode(
      () =>
        postEntry(
          {
            ...base,
            lines: [
              { account: 'CASH', direction: 'DEBIT', amountMinor: 101, currency: 'KES' },
              { account: 'AR_CONTROL', direction: 'CREDIT', amountMinor: 101, currency: 'KES' },
            ],
          },
          [first.entry],
          clock,
        ),
      'LEDGER_IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('append-only reversals (R3/K6)', () => {
  const postedInvoice = (): JournalEntry => post(movement({ amountMinor: 100_000 }), [], clock).entry;

  it('appends a balanced reversing entry and re-emits the original as REVERSED (no in-place edit)', () => {
    const original = postedInvoice();
    const before = original; // alias — must stay untouched
    const result = reverseEntry(original, { reason: 'invoice voided after eTIMS re-issue', actor: 'ops-admin' }, clock);

    // the reversal is a NEW posted entry with swapped lines
    expect(result.reversal.status).toBe('POSTED');
    expect(result.reversal.reversalOf).toBe(original.entryId);
    expect(result.reversal.reason).toBe('invoice voided after eTIMS re-issue');
    expect(result.reversal.actor).toBe('ops-admin');
    expect(result.reversal.reference).toBe(original.reference); // defaults to the original's
    expect(result.reversal.lines).toEqual([
      { account: 'AR_CONTROL', direction: 'CREDIT', amountMinor: 100_000n, currency: 'KES' },
      { account: 'REVENUE', direction: 'DEBIT', amountMinor: 100_000n, currency: 'KES' },
    ]);

    // the original is re-emitted as a NEW frozen object — the input never mutates
    expect(result.original).not.toBe(original);
    expect(result.original.status).toBe('REVERSED');
    expect(result.original.reversedBy).toBe(result.reversal.entryId);
    expect(original.status).toBe('POSTED');
    expect(original.reversedBy).toBeUndefined();
    expect(before).toBe(original);

    // append-only: both versions are frozen
    expect(Object.isFrozen(result.original)).toBe(true);
    expect(Object.isFrozen(result.reversal)).toBe(true);
    expect(Object.isFrozen(result.reversal.lines)).toBe(true);

    // exactly two facts: the reversal posting + the correction event
    expect(result.events.map((e) => e.name)).toEqual(['ledger.entryPosted', 'ledger.entryReversed']);
    const reversedEvent = result.events[1]!;
    if (reversedEvent.name !== 'ledger.entryReversed') throw new Error(`unexpected event ${reversedEvent.name}`);
    expect(reversedEvent.payload).toMatchObject({
      entryId: original.entryId,
      reversalEntryId: result.reversal.entryId,
      reason: 'invoice voided after eTIMS re-issue',
      actor: 'ops-admin',
      reversedAt: '2025-09-02T08:00:00.000Z',
    });
  });

  it('nets original + reversal to exactly zero on every account (the R3 math)', () => {
    const original = postedInvoice();
    const { original: marked, reversal } = reverseEntry(original, { reason: 'voided', actor: 'ops' }, clock);
    const both: JournalEntry[] = [marked, reversal];
    expect(arControlBalanceMinor(both)).toBe(0n);
    expect(accountBalanceMinor(both, 'REVENUE')).toBe(0n);
  });

  it('rejects blank reason, blank actor, already-reversed entries and reversing a reversal', () => {
    const original = postedInvoice();

    expectCode(() => reverseEntry(original, { reason: '  ', actor: 'ops' }, clock), 'REVERSAL_REASON_REQUIRED');
    expectCode(() => reverseEntry(original, { reason: 'voided', actor: '' }, clock), 'LEDGER_ACTOR_REQUIRED');

    // K6: reversing a reversal is rejected — correct the original instead
    const firstPass = reverseEntry(original, { reason: 'voided', actor: 'ops' }, clock);
    expectCode(
      () => reverseEntry(firstPass.reversal, { reason: 'undo the undo', actor: 'ops' }, clock),
      'LEDGER_REVERSAL_OF_REVERSAL',
    );
    // and the already-reversed original cannot be reversed twice
    expectCode(
      () => reverseEntry(firstPass.original, { reason: 'double correction', actor: 'ops' }, clock),
      'LEDGER_ENTRY_NOT_REVERSIBLE',
    );
  });

  it('keeps a reversed pair reconciled: payment reversed ⇒ AR returns to the invoice balance (K5)', () => {
    const invoice = post(movement({ amountMinor: 100_000 }), [], clock).entry;
    const payment = post(
      movement({ name: 'payments.paymentCompleted', amountMinor: 100_000, sourceEventId: uid('a00000000002') }),
      [invoice],
      clock,
    ).entry;
    expect(arControlBalanceMinor([invoice, payment])).toBe(0n); // settled

    const { original: markedPayment, reversal } = reverseEntry(payment, { reason: 'Daraja reversal', actor: 'daraja-c2b' }, clock);
    // the reversed payment cancels itself; the invoice's receivable is open again
    expect(arControlBalanceMinor([invoice, markedPayment, reversal])).toBe(100_000n);
  });

  it('allows an explicit reference override on the reversal', () => {
    const original = postedInvoice();
    const { reversal } = reverseEntry(original, { reason: 'voided', actor: 'ops', reference: 'TICKET-77' }, clock);
    expect(reversal.reference).toBe('TICKET-77');
  });
});

describe('derived balances', () => {
  it('computes debit-normal account balances over mixed entries', () => {
    const invoice = post(movement({ amountMinor: 500_000 }), [], clock).entry;
    const payment = post(
      movement({ name: 'payments.paymentCompleted', amountMinor: 200_000, sourceEventId: uid('a00000000002') }),
      [invoice],
      clock,
    ).entry;
    const writeOff = post(
      movement({ name: 'receivables.writeOffApproved', amountMinor: 50_000, sourceEventId: uid('a00000000003') }),
      [invoice, payment],
      clock,
    ).entry;
    expect(arControlBalanceMinor([invoice, payment, writeOff])).toBe(250_000n);
    // REVENUE is credit-normal: its debit-normal math is negative by design
    expect(accountBalanceMinor([invoice, payment, writeOff], 'REVENUE')).toBe(-500_000n);
    expect(accountBalanceMinor([invoice, payment, writeOff], 'BAD_DEBT_EXPENSE')).toBe(50_000n);
    expect(accountBalanceMinor([invoice, payment, writeOff], 'CASH')).toBe(200_000n);
  });

  it('describeLine renders an audit label', () => {
    expect(describeLine({ account: 'AR_CONTROL', direction: 'DEBIT', amountMinor: 125_000n, currency: 'KES' })).toBe(
      'Dr AR_CONTROL 1250.00 KES',
    );
  });
});

describe('chart of accounts is closed and typed', () => {
  it('recognizes exactly the seven accounts and two directions', () => {
    expect(isAccount('AR_CONTROL')).toBe(true);
    expect(isAccount('ar_control')).toBe(false);
    expect(isAccount('MOON')).toBe(false);
    expect(isPostingDirection('DEBIT')).toBe(true);
    expect(isPostingDirection('debit')).toBe(false);
  });

  it('validates a single line (magnitude, integer, non-zero)', () => {
    expect(toJournalLine({ account: 'CASH', direction: 'DEBIT', amountMinor: 5n, currency: 'KES' })).toEqual({
      account: 'CASH',
      direction: 'DEBIT',
      amountMinor: 5n,
      currency: 'KES',
    });
    expectCode(() => toJournalLine({ account: 'CASH', direction: 'DEBIT', amountMinor: -1, currency: 'KES' }), 'LEDGER_AMOUNT_NEGATIVE');
    expectCode(() => toJournalLine({ account: 'CASH', direction: 'DEBIT', amountMinor: 1.5, currency: 'KES' }), 'LEDGER_AMOUNT_NOT_INTEGER');
  });
});
