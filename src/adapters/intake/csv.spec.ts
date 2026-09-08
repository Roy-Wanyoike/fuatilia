/**
 * CSV import tests (issue #87): header refusals, row-error aggregation as
 * values, the strict money matrix, all-or-nothing commit, batch idempotency
 * (no-op replay + different-content refusal), and KES-only enforcement.
 */
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared';
import {
  batchContentHash,
  DEFAULT_CSV_COLUMNS,
  importCsvInvoices,
  inMemoryImportBatchStore,
  parseAmountMinor,
  parseCsvRows,
  parseDueDate,
} from './csv';

const ORG = '00000000-0000-4000-8000-000000000001' as unknown as import('../../domain/shared').Uuid;
const CUSTOMER = '00000000-0000-4000-8000-000000000002' as unknown as import('../../domain/shared').Uuid;
const t0 = new Date('2026-09-08T09:00:00Z');
const clock = { now: () => t0 };

const csv = (rows: string[]): string =>
  ['customer_id,invoice_number,currency,due_date,line_description,line_amount', ...rows].join('\n');

const goodRow = (n: number): string =>
  `${CUSTOMER},INV-100${n},KES,2026-10-01,Consulting September,2500.00`;

const commitJournal = () => {
  const commits: { count: number; batchKey: string }[] = [];
  return {
    commit: (prepared: readonly unknown[], meta: { batchKey: string }) => {
      commits.push({ count: prepared.length, batchKey: meta.batchKey });
    },
    commits,
  };
};

describe('parseAmountMinor (strict money matrix)', () => {
  it.each([
    ['2500.00', 250_000n, null],
    ['2500', 250_000n, null],
    ['2500.5', 250_050n, null],
    ['0.01', 1n, null],
    ['9999999999999999.99', 999_999_999_999_999_999n, null],
  ])('accepts %s → %s', (raw, minor) => {
    expect(parseAmountMinor(raw)).toEqual({ minor, refusal: null });
  });
  it.each([
    ['', 'INTAKE_AMOUNT_EMPTY'],
    ['1,000.00', 'INTAKE_AMOUNT_SEPARATOR'],
    ['1 000', 'INTAKE_AMOUNT_SEPARATOR'],
    ['1_000', 'INTAKE_AMOUNT_SEPARATOR'],
    ['abc', 'INTAKE_AMOUNT_NOT_NUMERIC'],
    ['12.3.4', 'INTAKE_AMOUNT_PRECISION'],
    ['-1.00', 'INTAKE_AMOUNT_NEGATIVE'],
    ['0.00', 'INTAKE_AMOUNT_ZERO'],
    ['0', 'INTAKE_AMOUNT_ZERO'],
    ['1.234', 'INTAKE_AMOUNT_PRECISION'],
    ['99999999999999999999.00', 'INTAKE_AMOUNT_OVERFLOW'],
  ])('refuses %s with %s', (raw, code) => {
    expect(parseAmountMinor(raw)).toEqual({ minor: null, refusal: code });
  });
});

describe('parseCsvRows + parseDueDate', () => {
  it('handles quotes, escaped quotes and CRLF', () => {
    const rows = parseCsvRows('a,b\r\n"say ""hi""",x\n"multi, comma",y');
    expect(rows).toEqual([
      ['a', 'b'],
      ['say "hi"', 'x'],
      ['multi, comma', 'y'],
    ]);
  });
  it('refuses non-ISO dates', () => {
    expect(parseDueDate('01/10/2026').refusal).toBe('INTAKE_DATE_INVALID');
    expect(parseDueDate('2026-13-01').refusal).toBe('INTAKE_DATE_INVALID');
    expect(parseDueDate('2026-10-01').date?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('importCsvInvoices — headers and rows', () => {
  it('refuses malformed headers with the expected shape', async () => {
    const result = await importCsvInvoices({
      batchKey: 'b-1',
      orgId: ORG,
      csv: 'customer,amount\nx,1.00',
      store: inMemoryImportBatchStore(),
      clock,
    });
    expect(result.kind).toBe('header_invalid');
    if (result.kind === 'header_invalid') {
      expect(result.expected).toEqual([...Object.values(DEFAULT_CSV_COLUMNS)]);
      expect(result.got).toEqual(['customer', 'amount']);
    }
  });

  it('imports clean rows through the REAL domain functions and commits all-or-nothing', async () => {
    const { commit, commits } = commitJournal();
    const result = await importCsvInvoices({
      batchKey: 'b-2',
      orgId: ORG,
      csv: csv([goodRow(1), goodRow(2), goodRow(3)]),
      store: inMemoryImportBatchStore(),
      clock,
      commit,
    });
    expect(result.kind).toBe('imported');
    if (result.kind === 'imported') {
      expect(result.count).toBe(3);
      expect(result.prepared[0]?.invoice.invoiceNumber).toBe('INV-1001');
      expect(result.prepared[0]?.receivable.state).toBe('open');
      expect(result.prepared[0]?.receivable.original.amount).toBe(250_000n);
      expect(result.prepared[0]?.events).toHaveLength(2);
    }
    expect(commits).toEqual([{ count: 3, batchKey: 'b-2' }]); // ONE commit, all rows
  });

  it('aggregates EVERY bad row as a typed refusal value — nothing commits', async () => {
    const { commit, commits } = commitJournal();
    const result = await importCsvInvoices({
      batchKey: 'b-3',
      orgId: ORG,
      csv: csv([
        goodRow(1),
        `${CUSTOMER},INV-1002,KES,2026-10-01,Consulting,"1,500.00"`, // separator
        `${CUSTOMER},INV-1003,KES,2026-10-01,Consulting,-5.00`, // negative
        `${CUSTOMER},INV-1004,KES,2026-10-01,Consulting,0.00`, // zero
        `${CUSTOMER},INV-1005,KES,2026-10-01,,25.00`, // missing description
        `,INV-1006,KES,2026-10-01,Consulting,25.00`, // missing customer
        `${CUSTOMER},INV-1007,KES,01/10/2026,Consulting,25.00`, // bad date
        `${CUSTOMER},INV-1008,KES,2026-10-01,Consulting,1.234`, // precision
      ]),
      store: inMemoryImportBatchStore(),
      clock,
      commit,
    });
    expect(result.kind).toBe('row_errors');
    if (result.kind === 'row_errors') {
      const codes = result.errors.map((e) => e.code);
      expect(codes).toEqual([
        'INTAKE_AMOUNT_SEPARATOR',
        'INTAKE_AMOUNT_NEGATIVE',
        'INTAKE_AMOUNT_ZERO',
        'INTAKE_DESCRIPTION_REQUIRED',
        'INTAKE_CUSTOMER_REQUIRED',
        'INTAKE_DATE_INVALID',
        'INTAKE_AMOUNT_PRECISION',
      ]);
      expect(result.errors.map((e) => e.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    }
    expect(commits).toEqual([]); // all-or-nothing: nothing committed
  });

  it('refuses non-KES rows honestly (no FX lane wired into intake)', async () => {
    const result = await importCsvInvoices({
      batchKey: 'b-4',
      orgId: ORG,
      csv: csv([`${CUSTOMER},INV-2001,USD,2026-10-01,Consulting,100.00`, `${CUSTOMER},INV-2002,,2026-10-01,Consulting,100.00`]),
      store: inMemoryImportBatchStore(),
      clock,
    });
    expect(result.kind).toBe('currency_refused');
    if (result.kind === 'currency_refused') {
      expect(result.lines).toEqual([
        { line: 2, currency: 'USD' },
        { line: 3, currency: '(empty)' },
      ]);
    }
  });
});

describe('importCsvInvoices — batch idempotency (R9 for imports)', () => {
  it('re-import of the same batch is a NO-OP returning the first result', async () => {
    const { commit, commits } = commitJournal();
    const store = inMemoryImportBatchStore();
    const args = { batchKey: 'b-5', orgId: ORG, csv: csv([goodRow(1)]), store, clock, commit };
    const first = await importCsvInvoices(args);
    const second = await importCsvInvoices(args);
    expect(first.kind).toBe('imported');
    expect(second.kind).toBe('duplicate_replay');
    if (second.kind === 'duplicate_replay') {
      expect(second.firstResult).toEqual(first);
    }
    expect(commits).toHaveLength(1); // the commit seam ran ONCE
  });

  it('same key + DIFFERENT content is refused (content hash mismatch)', async () => {
    const store = inMemoryImportBatchStore();
    const base = { batchKey: 'b-6', orgId: ORG, store, clock };
    await importCsvInvoices({ ...base, csv: csv([goodRow(1)]) });
    const clash = await importCsvInvoices({ ...base, csv: csv([goodRow(2)]) });
    expect(clash.kind).toBe('duplicate_key_content_mismatch');
    if (clash.kind === 'duplicate_key_content_mismatch') {
      expect(clash.recordedHash).toBe(batchContentHash('b-6', ORG, csv([goodRow(1)])));
      expect(clash.contentHash).not.toBe(clash.recordedHash);
    }
  });

  it('refuses a blank batch key as a caller bug (throws)', async () => {
    try {
      await importCsvInvoices({ batchKey: '  ', orgId: ORG, csv: csv([goodRow(1)]), store: inMemoryImportBatchStore(), clock });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe('INTAKE_BATCH_KEY_REQUIRED');
    }
  });

  it('row errors also record — replaying a failed batch replays the refusal (no double counting)', async () => {
    const store = inMemoryImportBatchStore();
    const args = { batchKey: 'b-7', orgId: ORG, csv: csv([`${CUSTOMER},INV-3001,KES,2026-10-01,Consulting,-1.00`]), store, clock };
    const first = await importCsvInvoices(args);
    const replay = await importCsvInvoices(args);
    expect(first.kind).toBe('row_errors');
    expect(replay.kind).toBe('duplicate_replay');
  });
});
