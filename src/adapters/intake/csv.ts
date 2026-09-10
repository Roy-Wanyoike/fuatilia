/**
 * Bulk CSV invoice import (issue #87, RICE #5) — the strict, explicit door
 * into the EXISTING receivables intake functions (`createInvoice` →
 * `addInvoiceLine` → `issueInvoice` → `openReceivable`). Kenya-first fund
 * truth is KES + integer minor units; anything that cannot be fully
 * validated is refused as a TYPED VALUE — never half-imported, never thrown
 * away silently.
 *
 * Contracts (mirrors the issue's acceptance criteria):
 *   - explicit column config, NO auto-magic header guessing;
 *   - malformed headers → the whole batch refuses with the expected shape;
 *   - row errors AGGREGATE as values (every bad row reported, not first-fail);
 *   - all-or-nothing: the prepared aggregates are handed to the caller's
 *     transactional `commit` seam ONLY when every row validated — the
 *     adapter itself never persists;
 *   - duplicate batches are a no-op replay (same key + same content → the
 *     FIRST result; same key + different content → refused, R9 discipline);
 *   - KES-only: any other currency is an honest typed refusal (no FX lane is
 *     wired into receivables intake — R10 single-currency);
 *   - money: strict minor-unit parsing, thousands separators REFUSED
 *     (CSV money is written by machines, not humans), negative/zero/overflow
 *     refused, at most 2 fraction digits.
 */
import { DomainError, type Clock, type Uuid, uuid as uuidFrom } from '../../domain/shared';
import type { DomainEvent } from '../../domain/receivables/events';
import { Money } from '../../domain/shared/money';
import { addInvoiceLine, createInvoice, issueInvoice } from '../../domain/receivables/invoice';
import { openReceivable } from '../../domain/receivables/receivable';
import type { Invoice, InvoiceLine } from '../../domain/receivables/invoice';
import type { Receivable } from '../../domain/receivables/receivable';

// --- the column contract (explicit, no auto-magic) -----------------------------------

/**
 * Maps CSV header names to the semantic fields the importer needs. EVERY
 * column is required in the config; the FILE must carry exactly these
 * headers (order-insensitive, extra columns refused) — an explicit contract
 * beats a clever one for money.
 */
export interface CsvColumnConfig {
  readonly customerId: string;
  readonly invoiceNumber: string;
  readonly currency: string;
  readonly dueDate: string;
  readonly lineDescription: string;
  readonly lineAmount: string;
}

export const DEFAULT_CSV_COLUMNS: CsvColumnConfig = {
  customerId: 'customer_id',
  invoiceNumber: 'invoice_number',
  currency: 'currency',
  dueDate: 'due_date',
  lineDescription: 'line_description',
  lineAmount: 'line_amount',
};

// --- money parsing (strict, no floats) --------------------------------------------------

export type MoneyRefusal =
  | 'INTAKE_AMOUNT_EMPTY'
  | 'INTAKE_AMOUNT_SEPARATOR'
  | 'INTAKE_AMOUNT_NOT_NUMERIC'
  | 'INTAKE_AMOUNT_NEGATIVE'
  | 'INTAKE_AMOUNT_ZERO'
  | 'INTAKE_AMOUNT_PRECISION'
  | 'INTAKE_AMOUNT_OVERFLOW';

/**
 * Parse a CSV money string into integer minor units. Refuses: empty,
 * thousands separators (commas/underscores/spaces), non-numeric junk,
 * negatives, zeros, more than 2 fraction digits, and overflow beyond the
 * safe-integer minor space. NO float arithmetic anywhere.
 */
export const parseAmountMinor = (raw: string): { minor: bigint | null; refusal: MoneyRefusal | null } => {
  const s = raw.trim();
  if (s === '') return { minor: null, refusal: 'INTAKE_AMOUNT_EMPTY' };
  if (/[, _]/.test(s)) return { minor: null, refusal: 'INTAKE_AMOUNT_SEPARATOR' };
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const intPart = body.split('.')[0] ?? '';
  const fracPart = body.includes('.') ? body.slice(body.indexOf('.') + 1) : '';
  if (intPart === '' && fracPart === '') return { minor: null, refusal: 'INTAKE_AMOUNT_NOT_NUMERIC' };
  let whole = 0n;
  for (const c of intPart) {
    if (c < '0' || c > '9') return { minor: null, refusal: 'INTAKE_AMOUNT_NOT_NUMERIC' };
    whole = whole * 10n + BigInt(c.charCodeAt(0) - 48);
  }
  if (fracPart.length > 2) return { minor: null, refusal: 'INTAKE_AMOUNT_PRECISION' };
  let frac = 0n;
  for (const c of fracPart) {
    if (c < '0' || c > '9') return { minor: null, refusal: 'INTAKE_AMOUNT_NOT_NUMERIC' };
    frac = frac * 10n + BigInt(c.charCodeAt(0) - 48);
  }
  if (fracPart.length === 1) frac *= 10n;
  const minor = whole * 100n + frac;
  if (negative && minor !== 0n) return { minor: null, refusal: 'INTAKE_AMOUNT_NEGATIVE' };
  if (minor === 0n) return { minor: null, refusal: 'INTAKE_AMOUNT_ZERO' };
  if (minor > 9_000_000_000_000_000_000n) return { minor: null, refusal: 'INTAKE_AMOUNT_OVERFLOW' };
  return { minor, refusal: null };
};

/** ISO date (YYYY-MM-DD) parse for the due date — nothing else is accepted. */
export const parseDueDate = (raw: string): { date: Date | null; refusal: 'INTAKE_DATE_INVALID' | null } => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (m === null) return { date: null, refusal: 'INTAKE_DATE_INVALID' };
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw.trim()) {
    return { date: null, refusal: 'INTAKE_DATE_INVALID' };
  }
  return { date, refusal: null };
};

// --- the CSV reader (RFC-4180 subset: quotes, escaped quotes, CRLF) ---------------------

export const parseCsvRows = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
};

// --- the batch engine -------------------------------------------------------------------

export interface PreparedInvoiceBatch {
  readonly invoice: Invoice;
  readonly receivable: Receivable;
  readonly events: readonly DomainEvent<string, unknown>[];
}

export interface RowRefusal {
  readonly line: number;
  readonly code: string;
  readonly detail: string;
}

export interface CommitInvoiceBatch {
  (
    prepared: readonly PreparedInvoiceBatch[],
    meta: { readonly batchKey: string; readonly orgId: Uuid },
  ): void | Promise<void>;
}

export type ImportCsvResult =
  | {
      readonly kind: 'imported';
      readonly batchKey: string;
      readonly count: number;
      readonly prepared: readonly PreparedInvoiceBatch[];
    }
  | {
      readonly kind: 'row_errors';
      readonly batchKey: string;
      readonly errors: readonly RowRefusal[];
    }
  | {
      readonly kind: 'header_invalid';
      readonly batchKey: string;
      readonly expected: readonly string[];
      readonly got: readonly string[];
    }
  | {
      readonly kind: 'currency_refused';
      readonly batchKey: string;
      readonly lines: readonly { readonly line: number; readonly currency: string }[];
    }
  | {
      readonly kind: 'duplicate_replay';
      readonly batchKey: string;
      readonly firstResult: ImportCsvResult;
    }
  | {
      readonly kind: 'duplicate_key_content_mismatch';
      readonly batchKey: string;
      readonly contentHash: string;
      readonly recordedHash: string;
    };

/** The durable record of imported batches (R9 for imports). */
export interface ImportBatchStore {
  /** Claim (batchKey → contentHash) unless present; returns the recorded state when lost. */
  claim(key: string, contentHash: string): { won: boolean; recordedHash: string | null; recordedResult: ImportCsvResult | null };
  /** The winner records its result for no-op replays. */
  record(key: string, contentHash: string, result: ImportCsvResult): void;
}

export const inMemoryImportBatchStore = (): ImportBatchStore => {
  const entries = new Map<string, { hash: string; result: ImportCsvResult }>();
  return {
    claim(key, contentHash) {
      const prior = entries.get(key);
      if (prior === undefined) return { won: true, recordedHash: null, recordedResult: null };
      return { won: false, recordedHash: prior.hash, recordedResult: prior.result };
    },
    record(key, contentHash, result) {
      entries.set(key, { hash: contentHash, result });
    },
  };
};

/** Stable content hash (FNV-1a over the canonical form) — detects key reuse with different content. */
export const batchContentHash = (batchKey: string, orgId: string, csv: string): string => {
  let h = 0x811c9dc5;
  const input = `${batchKey}\u0000${orgId}\u0000${csv}`;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

/** Deterministic UUID derivation for a batch row (36 hex chars, no RNG). */
const hex36 = (seed: string): string => {
  const h = batchContentHash(seed, 'row', 'derivation');
  const reversed = h.split('').reverse().join('');
  return (h + reversed + h + reversed).slice(0, 32).padEnd(32, '0');
};

const rowUuid = (batchKey: string, line: number, salt: string): Uuid => {
  const hex = hex36(`${batchKey}|${line}|${salt}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Uuid;
};

export interface ImportCsvInvoicesArgs {
  readonly batchKey: string;
  readonly orgId: Uuid;
  readonly csv: string;
  readonly columns?: CsvColumnConfig;
  readonly store: ImportBatchStore;
  readonly clock: Clock;
  /**
   * The caller's transactional seam — invoked ONLY when every row validated.
   * The adapter never persists by itself; production binds a PostgreSQL tx.
   */
  readonly commit?: CommitInvoiceBatch;
}

/**
 * Import a CSV invoice batch. EVERY refusal is a value; the ONLY throws are
 * caller bugs (broken clock, blank batch key, a store that lies).
 */
export const importCsvInvoices = async (args: ImportCsvInvoicesArgs): Promise<ImportCsvResult> => {
  if (args.batchKey.trim() === '') {
    throw new DomainError('INTAKE_BATCH_KEY_REQUIRED', 'batchKey is required for import idempotency');
  }
  const columns = args.columns ?? DEFAULT_CSV_COLUMNS;
  const expected: readonly string[] = Object.values(columns);
  const contentHash = batchContentHash(args.batchKey, args.orgId, args.csv);

  // R9 batch idempotency: replay is a no-op with the FIRST result; same key
  // with DIFFERENT content is a caller bug worth refusing loudly.
  const claim = args.store.claim(args.batchKey, contentHash);
  if (!claim.won) {
    if (claim.recordedHash !== contentHash) {
      return { kind: 'duplicate_key_content_mismatch', batchKey: args.batchKey, contentHash, recordedHash: claim.recordedHash ?? '' };
    }
    if (claim.recordedResult !== null) {
      return { kind: 'duplicate_replay', batchKey: args.batchKey, firstResult: claim.recordedResult };
    }
  }

  const rows = parseCsvRows(args.csv);
  if (rows.length === 0) {
    const empty: ImportCsvResult = { kind: 'header_invalid', batchKey: args.batchKey, expected, got: [] };
    args.store.record(args.batchKey, contentHash, empty);
    return empty;
  }
  const headerRow = rows[0];
  if (headerRow === undefined) {
    const empty: ImportCsvResult = { kind: 'header_invalid', batchKey: args.batchKey, expected, got: [] };
    args.store.record(args.batchKey, contentHash, empty);
    return empty;
  }
  const header = headerRow.map((h) => h.trim());
  const missing = expected.filter((name) => !header.includes(name));
  if (missing.length > 0 || header.length !== expected.length) {
    const invalid: ImportCsvResult = { kind: 'header_invalid', batchKey: args.batchKey, expected, got: header };
    args.store.record(args.batchKey, contentHash, invalid);
    return invalid;
  }

  const idx = (name: string) => header.indexOf(name);
  const errors: RowRefusal[] = [];
  const currencyOffenders: { line: number; currency: string }[] = [];
  const prepared: PreparedInvoiceBatch[] = [];

  for (let r = 1; r < rows.length; r += 1) {
    const line = r + 1; // 1-based file line (header is line 1)
    const cells = rows[r] ?? [];
    const get = (name: string) => cells[idx(name)]?.trim() ?? '';

    const customerId = get(columns.customerId);
    if (customerId === '') {
      errors.push({ line, code: 'INTAKE_CUSTOMER_REQUIRED', detail: 'customer_id is required' });
      continue;
    }
    const currency = get(columns.currency).toUpperCase();
    if (currency !== 'KES') {
      // honest refusal: no FX lane is wired into receivables intake (R10)
      currencyOffenders.push({ line, currency: currency === '' ? '(empty)' : currency });
      continue;
    }
    const amount = parseAmountMinor(get(columns.lineAmount));
    if (amount.refusal !== null) {
      errors.push({ line, code: amount.refusal, detail: `line_amount "${get(columns.lineAmount)}" refused` });
      continue;
    }
    const due = parseDueDate(get(columns.dueDate));
    if (due.refusal !== null) {
      errors.push({ line, code: due.refusal, detail: `due_date "${get(columns.dueDate)}" is not YYYY-MM-DD` });
      continue;
    }
    const description = get(columns.lineDescription);
    if (description === '') {
      errors.push({ line, code: 'INTAKE_DESCRIPTION_REQUIRED', detail: 'line_description is required' });
      continue;
    }

    try {
      // The REAL domain functions do the validating — the adapter composes.
      let invoice = createInvoice({
        id: rowUuid(args.batchKey, line, 'invoice'),
        customerId: uuidFrom(customerId),
        currency: 'KES',
        dueDate: due.date as Date,
      });
      const lineItem: InvoiceLine = { description, amount: Money.ofMinor(amount.minor as bigint, 'KES') };
      invoice = addInvoiceLine(invoice, lineItem);
      const sequenceNo = r; // batch-local sequence; the org's counter is the caller's concern
      const issued = issueInvoice(
        invoice,
        { sequenceNo, reserveNumber: (seq) => get(columns.invoiceNumber) || `BATCH-${args.batchKey}-${String(seq)}` },
        args.clock,
      );
      const opened = openReceivable(issued.invoice, rowUuid(args.batchKey, line, 'receivable'), args.clock);
      prepared.push({
        invoice: opened.invoice,
        receivable: opened.receivable,
        events: [issued.event, opened.event],
      });
    } catch (error: unknown) {
      const code = error instanceof DomainError ? error.code : 'INTAKE_ROW_INVALID';
      const detail = error instanceof Error ? error.message : String(error);
      errors.push({ line, code, detail });
    }
  }

  if (currencyOffenders.length > 0) {
    const refused: ImportCsvResult = { kind: 'currency_refused', batchKey: args.batchKey, lines: currencyOffenders };
    args.store.record(args.batchKey, contentHash, refused);
    return refused;
  }
  if (errors.length > 0) {
    const failed: ImportCsvResult = { kind: 'row_errors', batchKey: args.batchKey, errors };
    args.store.record(args.batchKey, contentHash, failed);
    return failed;
  }

  if (args.commit !== undefined) {
    await args.commit(prepared, { batchKey: args.batchKey, orgId: args.orgId });
  }
  const imported: ImportCsvResult = {
    kind: 'imported',
    batchKey: args.batchKey,
    count: prepared.length,
    prepared,
  };
  args.store.record(args.batchKey, contentHash, imported);
  return imported;
};
