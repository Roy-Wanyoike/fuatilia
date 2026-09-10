/**
 * Bank-feed reconciliation tests (issue #117): three feed shapes into the
 * REAL intake + match core; statement idempotency (checksum, replay,
 * out-of-order, duplicate refs); confidence honesty; no cent created or
 * destroyed. Deterministic fixtures only — no network.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BANK_CSV_COLUMNS,
  entryChecksum,
  extractCandidateRefs,
  importStatement,
  inMemoryStatementStore,
  normalizeBankCsvRow,
  normalizeMt940LiteEntry,
  normalizePesaLinkEntry,
  statementChecksum,
  type BankFeedEntry,
  type StatementEntryOutcome,
} from './feeds';

const ORG = '00000000-0000-4000-8000-000000000001';
const CUSTOMER = '00000000-0000-4000-8000-000000000002';
const t0 = new Date('2026-09-08T09:00:00Z');
const clock = { now: () => t0 };

const openInvoices = [
  { receivableId: '00000000-0000-4000-8000-0000000000a1', invoiceNumber: 'INV-2077', dueDate: new Date('2026-09-01T00:00:00Z') },
  { receivableId: '00000000-0000-4000-8000-0000000000a2', invoiceNumber: 'INV-3105', dueDate: new Date('2026-08-15T00:00:00Z') },
] as const;

const pesaLinkEntry = (reference: string, amount: string, narrative: string) => ({
  transactionId: reference,
  amount,
  valueDate: '2026-09-07',
  narration: narrative,
  senderName: 'Kilimanjaro Distributors Ltd',
  currency: 'KES',
});

describe('feed normalization — three shapes', () => {
  it('PesaLink JSON normalizes with strict money', () => {
    const { entry, refusal } = normalizePesaLinkEntry(pesaLinkEntry('PLK99177X', '1500.00', 'INV-2077 payment'));
    expect(refusal).toBeNull();
    expect(entry?.amountMinor).toBe(150_000n);
    expect(entry?.reference).toBe('PLK99177X');
    expect(entry?.counterparty).toBe('Kilimanjaro Distributors Ltd');
  });

  it('MT940-lite JSON normalizes', () => {
    const { entry, refusal } = normalizeMt940LiteEntry({
      reference: 'MT940-0001',
      amountMinor: '980.50',
      valueDate: '2026-09-06',
      narrative: 'wire INV-3105',
      counterparty: 'Acme School',
    });
    expect(refusal).toBeNull();
    expect(entry?.amountMinor).toBe(98_050n);
  });

  it('bank CSV rows normalize via config columns', () => {
    const { entry, refusal } = normalizeBankCsvRow(
      { reference: 'CSV-77', amount: '2500', value_date: '2026-09-05', narrative: 'loan repayment INV-2077', counterparty: 'X' },
      DEFAULT_BANK_CSV_COLUMNS,
    );
    expect(refusal).toBeNull();
    expect(entry?.amountMinor).toBe(250_000n);
  });

  it.each([
    ['missing reference', { amount: '10.00', valueDate: '2026-09-07' }, 'BANKFEED_REFERENCE_REQUIRED'],
    ['negative amount', { transactionId: 'PL1', amount: '-5.00', valueDate: '2026-09-07' }, 'BANKFEED_AMOUNT_NEGATIVE'],
    ['zero amount', { transactionId: 'PL1', amount: '0.00', valueDate: '2026-09-07' }, 'BANKFEED_AMOUNT_ZERO'],
    ['thousands separator', { transactionId: 'PL1', amount: '1,500.00', valueDate: '2026-09-07' }, 'BANKFEED_AMOUNT_SEPARATOR'],
    ['3-dp precision', { transactionId: 'PL1', amount: '1.234', valueDate: '2026-09-07' }, 'BANKFEED_AMOUNT_PRECISION'],
    ['bad date', { transactionId: 'PL1', amount: '10.00', valueDate: '07/09/2026' }, 'BANKFEED_DATE_INVALID'],
    ['non-KES refused honestly', { transactionId: 'PL1', amount: '10.00', valueDate: '2026-09-07', currency: 'USD' }, 'BANKFEED_CURRENCY_REFUSED'],
  ] as const)('PesaLink %s', (_name, payload, code) => {
    expect(normalizePesaLinkEntry(payload).refusal).toBe(code);
  });
});

describe('reference extraction', () => {
  it('extracts invoice-like tokens, drops years and dedupes', () => {
    expect(extractCandidateRefs('payment for INV-2077 / INV-3105 school fees 2026')).toEqual(['INV-2077', 'INV-3105']);
    expect(extractCandidateRefs('no refs here 12 a')).toEqual([]);
  });
});

describe('importStatement — the R9 door into intake + match core', () => {
  const entry1 = (): BankFeedEntry => ({
    reference: 'PLK99177X',
    amountMinor: 150_000n,
    valueDate: new Date('2026-09-07T00:00:00Z'),
    narrative: 'payment for INV-2077',
    counterparty: 'Kilimanjaro',
  });
  const entry2 = (): BankFeedEntry => ({
    reference: 'PLK99178Y',
    amountMinor: 98_050n,
    valueDate: new Date('2026-09-06T00:00:00Z'),
    narrative: 'fees balance INV-3105',
    counterparty: 'Acme School',
  });
  const entries = (): BankFeedEntry[] => [entry1(), entry2()];

  it('intakes through the REAL core, confirms, and MATCHES via the payer-typed refs (R5/C1)', () => {
    const result = importStatement({
      statementId: 'STMT-1',
      orgId: ORG as never,
      entries: entries(),
      openInvoices: openInvoices as never,
      store: inMemoryStatementStore(),
      clock,
    });
    expect(result.kind).toBe('imported');
    if (result.kind !== 'imported') return void 0;
    expect(result.statement.count).toBe(2);
    expect(result.statement.totalMinor).toBe(248_050n); // no cent created or destroyed
    // sorted by valueDate: INV-3105 (09-06) lands BEFORE INV-2077 (09-07)
    const byRef = new Map(result.statement.entries.map((e) => [e.reference, e]));
    const first = byRef.get('PLK99177X') as StatementEntryOutcome;
    expect(first.matchBasis).toBe('fuzzy'); // INV-2077 in the narrative → declaredRefs
    expect(first.confidence).toBe('auto');
    expect(first.matchedReceivableIds).toContain(openInvoices[0].receivableId);
    expect(first.events.some((e) => e.name === 'payment.confirmed')).toBe(true);
    expect(first.events.some((e) => e.name === 'reconciliation.paymentMatched')).toBe(true);
  });

  it('is IDEMPOTENT: replaying the same statement returns the FIRST result (no double money)', () => {
    const store = inMemoryStatementStore();
    const args = { statementId: 'STMT-2', orgId: ORG as never, entries: entries(), openInvoices: openInvoices as never, store, clock };
    const first = importStatement(args);
    const replay = importStatement(args);
    expect(first.kind).toBe('imported');
    expect(replay.kind).toBe('duplicate_replay');
    if (first.kind !== 'imported' || replay.kind !== 'duplicate_replay') throw new Error('fixture');
    expect(replay.first).toEqual(first.statement);
    expect(replay.first.totalMinor).toBe(248_050n);
  });

  it('OUT-OF-ORDER entries produce the same truth (sorted by valueDate then reference)', () => {
    const store = inMemoryStatementStore();
    const shuffled = [entry2(), entry1()];
    const a = importStatement({ statementId: 'STMT-A', orgId: ORG as never, entries: entries(), openInvoices: openInvoices as never, store, clock });
    const b = importStatement({ statementId: 'STMT-B', orgId: ORG as never, entries: shuffled, openInvoices: openInvoices as never, store, clock });
    if (a.kind !== 'imported' || b.kind !== 'imported') throw new Error('fixture');
    expect(b.statement.entries.map((e) => e.reference)).toEqual(a.statement.entries.map((e) => e.reference));
    expect(b.statement.totalMinor).toBe(a.statement.totalMinor);
  });

  it('DUPLICATE references within a statement are refused', () => {
    const result = importStatement({
      statementId: 'STMT-3',
      orgId: ORG as never,
      entries: [entry1(), entry1()],
      openInvoices: openInvoices as never,
      store: inMemoryStatementStore(),
      clock,
    });
    expect(result.kind).toBe('duplicate_references');
  });

  it('a checksum CHANGE with the same statement id is a tampering refusal', () => {
    const store = inMemoryStatementStore();
    const base = { statementId: 'STMT-4', orgId: ORG as never, openInvoices: openInvoices as never, store, clock };
    importStatement({ ...base, entries: entries() });
    const changed = importStatement({ ...base, entries: [entry1()] });
    expect(changed.kind).toBe('checksum_mismatch');
  });

  it('checksums are STABLE and order-insensitive per entry (canonical serialization)', () => {
    const entry = entry1();
    expect(entryChecksum(entry1())).toBe(entryChecksum(entry1()));
    expect(statementChecksum([entry1(), entry2()])).toBe(statementChecksum([entry1(), entry2()]));
    expect(statementChecksum([entry1(), entry2()])).not.toBe(statementChecksum([entry2(), entry1()]));
  });
});
