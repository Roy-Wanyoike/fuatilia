/**
 * Bank-feed normalization + statement discipline (issue #117, RICE #6):
 * three documented feed shapes → one BankFeedEntry, then the statement-level
 * R9 door into the EXISTING payments intake + match core.
 *
 * Honesty rules:
 *   - money arrives as decimal strings (feeds are machine-written) parsed to
 *     BigInt minor units; NO float arithmetic anywhere;
 *   - KES-only: any other currency is an honest typed refusal (R10);
 *   - a statement's identity is its CHECKSUM (stable canonical serialization)
 *     — replaying a statement returns the FIRST result;
 *   - duplicate references WITHIN one statement are refused;
 *   - entries are SORTED by (valueDate, reference) before intake — out-of-
 *     order feeds never change truth;
 *   - the adapter NEVER force-matches: extraction produces candidate tokens,
 *     the core's matchDecision decides, ambiguous stays honestly unmatched.
 */
import { DomainError, type Clock, type Uuid, uuid as uuidFrom } from '../../domain/shared';
import { Money } from '../../domain/shared/money';
import { intakePayment } from '../../domain/payments/intake';
import { awaitConfirmation, confirmPayment, type Payment } from '../../domain/payments/payment';
import { matchDecision, recordMatch, type MatchConfidence, type OpenInvoiceRef } from '../../domain/payments/reconciliation';
import type { PaymentEvent } from '../../domain/payments/events';

// --- normalized entry ------------------------------------------------------------------

export interface BankFeedEntry {
  readonly reference: string;
  readonly amountMinor: bigint;
  readonly valueDate: Date;
  readonly narrative: string;
  readonly counterparty: string;
}

export type FeedRefusal =
  | 'BANKFEED_AMOUNT_MISSING'
  | 'BANKFEED_AMOUNT_SEPARATOR'
  | 'BANKFEED_AMOUNT_NOT_NUMERIC'
  | 'BANKFEED_AMOUNT_NEGATIVE'
  | 'BANKFEED_AMOUNT_ZERO'
  | 'BANKFEED_AMOUNT_PRECISION'
  | 'BANKFEED_AMOUNT_OVERFLOW'
  | 'BANKFEED_REFERENCE_REQUIRED'
  | 'BANKFEED_DATE_INVALID'
  | 'BANKFEED_CURRENCY_REFUSED';

export interface NormalizedFeed {
  readonly entry: BankFeedEntry | null;
  readonly refusal: FeedRefusal | null;
}

/** Strict decimal-string → minor units (the CSV lane's discipline, bank-flavored). */
const parseMinor = (raw: unknown): { minor: bigint | null; refusal: FeedRefusal | null } => {
  if (raw === undefined || raw === null) return { minor: null, refusal: 'BANKFEED_AMOUNT_MISSING' };
  const s = String(raw).trim();
  if (s === '') return { minor: null, refusal: 'BANKFEED_AMOUNT_MISSING' };
  if (/[, _]/.test(s)) return { minor: null, refusal: 'BANKFEED_AMOUNT_SEPARATOR' };
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  let whole = 0n;
  for (const c of intPart) {
    if (c < '0' || c > '9') return { minor: null, refusal: 'BANKFEED_AMOUNT_NOT_NUMERIC' };
    whole = whole * 10n + BigInt(c.charCodeAt(0) - 48);
  }
  if (fracPart.length > 2) return { minor: null, refusal: 'BANKFEED_AMOUNT_PRECISION' };
  let frac = 0n;
  for (const c of fracPart) {
    if (c < '0' || c > '9') return { minor: null, refusal: 'BANKFEED_AMOUNT_NOT_NUMERIC' };
    frac = frac * 10n + BigInt(c.charCodeAt(0) - 48);
  }
  if (fracPart.length === 1) frac *= 10n;
  const minor = whole * 100n + frac;
  if (negative && minor !== 0n) return { minor: null, refusal: 'BANKFEED_AMOUNT_NEGATIVE' };
  if (minor === 0n) return { minor: null, refusal: 'BANKFEED_AMOUNT_ZERO' };
  if (minor > 9_000_000_000_000_000_000n) return { minor: null, refusal: 'BANKFEED_AMOUNT_OVERFLOW' };
  return { minor, refusal: null };
};

const parseValueDate = (raw: unknown): Date | null => {
  if (typeof raw !== 'string') return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw.trim());
  if (iso === null) return null;
  const date = new Date(`${iso[1]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;

const readString = (record: Record<string, unknown>, fields: readonly string[]): string => {
  for (const field of fields) {
    const v = record[field];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return '';
};

const readCurrency = (record: Record<string, unknown>): string => {
  for (const field of ['currency', 'currencyCode', 'CurrencyRef']) {
    const v = record[field];
    if (typeof v === 'string' && v.trim() !== '') return v.trim().toUpperCase();
    const nested = asRecord(v);
    if (nested !== null && typeof nested['value'] === 'string') return (nested['value'] as string).toUpperCase();
  }
  return 'KES';
};

/** PesaLink-style credit notification JSON (documented shape, extras tolerated). */
export const normalizePesaLinkEntry = (payload: unknown): NormalizedFeed => {
  const record = asRecord(payload);
  if (record === null) return { entry: null, refusal: 'BANKFEED_REFERENCE_REQUIRED' };
  const currency = readCurrency(record);
  if (currency !== 'KES') return { entry: null, refusal: 'BANKFEED_CURRENCY_REFUSED' };
  const reference = readString(record, ['transactionId', 'reference', 'transRef']);
  if (reference === '') return { entry: null, refusal: 'BANKFEED_REFERENCE_REQUIRED' };
  const amount = parseMinor(record['amount'] ?? record['amountMinor']);
  if (amount.refusal !== null) return { entry: null, refusal: amount.refusal };
  const valueDate = parseValueDate(record['valueDate'] ?? record['transactionDate']);
  if (valueDate === null) return { entry: null, refusal: 'BANKFEED_DATE_INVALID' };
  return {
    entry: {
      reference,
      amountMinor: amount.minor as bigint,
      valueDate,
      narrative: readString(record, ['narration', 'narrative', 'remarks']),
      counterparty: readString(record, ['senderName', 'counterparty', 'remitterName']),
    },
    refusal: null,
  };
};

/** MT940-lite JSON (documented shape, extras tolerated). */
export const normalizeMt940LiteEntry = (payload: unknown): NormalizedFeed => {
  const record = asRecord(payload);
  if (record === null) return { entry: null, refusal: 'BANKFEED_REFERENCE_REQUIRED' };
  const currency = readCurrency(record);
  if (currency !== 'KES') return { entry: null, refusal: 'BANKFEED_CURRENCY_REFUSED' };
  const reference = readString(record, ['reference', 'bankReference', 'firmReference']);
  if (reference === '') return { entry: null, refusal: 'BANKFEED_REFERENCE_REQUIRED' };
  const amount = parseMinor(record['amountMinor'] ?? record['amount']);
  if (amount.refusal !== null) return { entry: null, refusal: amount.refusal };
  const valueDate = parseValueDate(record['valueDate'] ?? record['date']);
  if (valueDate === null) return { entry: null, refusal: 'BANKFEED_DATE_INVALID' };
  return {
    entry: {
      reference,
      amountMinor: amount.minor as bigint,
      valueDate,
      narrative: readString(record, ['narrative', 'description', 'postingText']),
      counterparty: readString(record, ['counterparty', 'accountName']),
    },
    refusal: null,
  };
};

/** Generic bank CSV statement — config-driven columns (like the intake lane). */
export interface BankCsvColumns {
  readonly reference: string;
  readonly amount: string;
  readonly valueDate: string;
  readonly narrative: string;
  readonly counterparty: string;
  readonly currency?: string;
}

export const DEFAULT_BANK_CSV_COLUMNS: BankCsvColumns = {
  reference: 'reference',
  amount: 'amount',
  valueDate: 'value_date',
  narrative: 'narrative',
  counterparty: 'counterparty',
};

export const normalizeBankCsvRow = (
  cells: Readonly<Record<string, string>>,
  columns: BankCsvColumns = DEFAULT_BANK_CSV_COLUMNS,
): NormalizedFeed => {
  if (columns.currency !== undefined) {
    const currency = (cells[columns.currency] ?? 'KES').trim().toUpperCase();
    if (currency !== 'KES') return { entry: null, refusal: 'BANKFEED_CURRENCY_REFUSED' };
  }
  const reference = (cells[columns.reference] ?? '').trim();
  if (reference === '') return { entry: null, refusal: 'BANKFEED_REFERENCE_REQUIRED' };
  const amount = parseMinor(cells[columns.amount]);
  if (amount.refusal !== null) return { entry: null, refusal: amount.refusal };
  const valueDate = parseValueDate(cells[columns.valueDate] ?? '');
  if (valueDate === null) return { entry: null, refusal: 'BANKFEED_DATE_INVALID' };
  return {
    entry: {
      reference,
      amountMinor: amount.minor as bigint,
      valueDate,
      narrative: (cells[columns.narrative] ?? '').trim(),
      counterparty: (cells[columns.counterparty] ?? '').trim(),
    },
    refusal: null,
  };
};

// --- checksum ---------------------------------------------------------------------------

/** FNV-1a over the canonical entry form — order-of-fields independent. */
export const entryChecksum = (entry: BankFeedEntry): string => {
  const canonical = [entry.reference, entry.amountMinor.toString(), entry.valueDate.toISOString().slice(0, 10), entry.narrative, entry.counterparty].join('\u0000');
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
};

export const statementChecksum = (entries: readonly BankFeedEntry[]): string => {
  const joined = entries.map(entryChecksum).join('|');
  const counterparty = String(entries.length);
  return entryChecksum({ reference: 'STMT', amountMinor: 0n, valueDate: new Date(0), narrative: joined, counterparty });
};

// --- statement import (the R9 door) -------------------------------------------------------

export interface StatementEntryOutcome {
  readonly reference: string;
  readonly paymentId: Uuid;
  readonly duplicate: boolean;
  readonly matchBasis: 'exact' | 'fuzzy' | 'unmatched';
  readonly confidence: MatchConfidence | null;
  readonly matchedReceivableIds: readonly Uuid[];
  readonly events: readonly PaymentEvent[];
}

export interface ImportedStatement {
  readonly statementId: string;
  readonly checksum: string;
  readonly count: number;
  readonly entries: readonly StatementEntryOutcome[];
  /** Σ intake amounts in minor units — the no-cent invariant support. */
  readonly totalMinor: bigint;
}

export interface StatementRefusal {
  readonly kind: 'duplicate_reference';
  readonly reference: string;
}

export type StatementImportResult =
  | { readonly kind: 'imported'; readonly statement: ImportedStatement }
  | { readonly kind: 'row_errors'; readonly refusals: readonly { readonly index: number; readonly refusal: FeedRefusal }[] }
  | { readonly kind: 'duplicate_references'; readonly references: readonly string[] }
  | { readonly kind: 'duplicate_replay'; readonly first: ImportedStatement }
  | { readonly kind: 'checksum_mismatch'; readonly statementId: string; readonly recorded: string; readonly got: string };

export interface StatementStore {
  claim(statementId: string, checksum: string): { won: boolean; recordedChecksum: string | null; recordedResult: ImportedStatement | null };
  record(statementId: string, checksum: string, result: ImportedStatement): void;
}

export const inMemoryStatementStore = (): StatementStore => {
  const entries = new Map<string, { checksum: string; result: ImportedStatement }>();
  return {
    claim(statementId, checksum) {
      const prior = entries.get(statementId);
      if (prior === undefined) return { won: true, recordedChecksum: null, recordedResult: null };
      return { won: false, recordedChecksum: prior.checksum, recordedResult: prior.result };
    },
    record(statementId, checksum, result) {
      entries.set(statementId, { checksum, result });
    },
  };
};

/**
 * Candidate reference tokens from a narrative — invoice-number-like runs
 * ([A-Za-z0-9][A-Za-z0-9/_-]{2,}) with separators squashed later by the
 * match core's own normalizeRef. Order preserves the narrative (first
 * mention wins ties).
 */
export const extractCandidateRefs = (narrative: string): readonly string[] => {
  // invoice-number-like: at least one digit, >= 3 significant chars — words
  // like 'payment' or 'for' are noise, never references
  const matches = narrative.match(/[A-Za-z0-9][A-Za-z0-9/_-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const raw of matches) {
    const token = raw.replace(/^[-_/]+|[-_/]+$/g, '');
    if (token.length >= 3 && /\d/.test(token) && !/^\d{4}$/.test(token) && !out.includes(token)) out.push(token);
  }
  return out;
};

export type MatchHint = 'matched' | 'unmatched';

/**
 * Confidence HINT (observability/UX only — the CORE decides and the adapter
 * reports): the core's basis (exact vs fuzzy over normalized refs) is the
 * confidence story; the adapter never force-matches. Amount/date-window
 * hints would need invoice amounts, which OpenInvoiceRef deliberately does
 * not carry (amounts are the allocation engine's business, R1/R2).
 */
export const confidenceHint = (decision: ReturnType<typeof matchDecision>): MatchHint =>
  decision.decision === 'matched' ? 'matched' : 'unmatched';

export interface ImportStatementArgs {
  readonly statementId: string;
  readonly orgId: Uuid;
  readonly customerId?: Uuid;
  readonly entries: readonly BankFeedEntry[];
  readonly openInvoices: readonly OpenInvoiceRef[];
  readonly store: StatementStore;
  readonly clock: Clock;
}

/**
 * Import one bank statement: idempotent by (statementId, checksum), sorted
 * deterministically, each entry through the REAL intake → confirmation →
 * match core. The statement IS the confirmation evidence (money in the
 * account), so the funnel runs awaitConfirmation → confirmPayment with the
 * entry's amount — using the EXISTING transitions, no truth bypass.
 */
export const importStatement = (args: ImportStatementArgs): StatementImportResult => {
  if (args.statementId.trim() === '') {
    throw new DomainError('BANKFEED_STATEMENT_ID_REQUIRED', 'statementId is required for import idempotency');
  }
  const checksum = statementChecksum(args.entries);
  const claim = args.store.claim(args.statementId, checksum);
  if (!claim.won) {
    if (claim.recordedChecksum !== checksum) {
      return { kind: 'checksum_mismatch', statementId: args.statementId, recorded: claim.recordedChecksum ?? '', got: checksum };
    }
    if (claim.recordedResult !== null) {
      return { kind: 'duplicate_replay', first: claim.recordedResult };
    }
  }

  // duplicate references WITHIN one statement are refused
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const entry of args.entries) {
    if (seen.has(entry.reference)) dupes.push(entry.reference);
    seen.add(entry.reference);
  }
  if (dupes.length > 0) {
    return { kind: 'duplicate_references', references: [...new Set(dupes)] };
  }

  // deterministic order — out-of-order feeds never change truth
  const ordered = [...args.entries].sort(
    (a, b) => a.valueDate.getTime() - b.valueDate.getTime() || (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0),
  );

  const outcomes: StatementEntryOutcome[] = [];
  let totalMinor = 0n;
  const known: Payment[] = [];
  for (const entry of ordered) {
    const intake = intakePayment(
      {
        channel: 'c2b',
        externalRef: entry.reference,
        idempotencyKey: `bankfeed:${args.statementId}:${entry.reference}`,
        amount: Money.ofMinor(entry.amountMinor, 'KES'),
        ...(args.customerId !== undefined ? { customerId: args.customerId } : {}),
        declaredRefs: extractCandidateRefs(`${entry.narrative} ${entry.counterparty}`),
      },
      { clock: args.clock, existing: known },
    );
    known.push(intake.payment);

    // the statement proves the money — the EXISTING confirmation transitions
    const pending = awaitConfirmation(intake.payment);
    const confirmedResult = confirmPayment(pending.payment, Money.ofMinor(entry.amountMinor, 'KES'), args.clock);
    const confirmed = confirmedResult.payment;
    const confirmEvents: readonly PaymentEvent[] = confirmedResult.events;
    known.splice(known.indexOf(intake.payment), 1, confirmed);

    // the CORE decides; the adapter reports and, when the core matched,
    // records the match through the core (R5/C1 — the match points at the
    // payment and keeps the payer-typed reference)
    const decision = matchDecision(confirmed, args.openInvoices);
    let matchBasis: 'exact' | 'fuzzy' | 'unmatched' = 'unmatched';
    let matchedReceivableIds: readonly Uuid[] = [];
    let matchEvents: readonly PaymentEvent[] = [];
    if (decision.decision === 'matched') {
      matchBasis = decision.basis;
      matchedReceivableIds = decision.candidates.map((c) => c.receivableId);
      if (!intake.duplicate) {
        const recorded = recordMatch(confirmed, confirmed.declaredRefs, 'auto', args.clock);
        matchEvents = recorded.events;
      }
    }
    outcomes.push({
      reference: entry.reference,
      paymentId: confirmed.id,
      duplicate: intake.duplicate,
      matchBasis,
      confidence: confidenceHint(decision) === 'matched' ? ('auto' as const) : null,
      matchedReceivableIds,
      events: [...intake.events, ...confirmEvents, ...matchEvents],
    });
    totalMinor += entry.amountMinor;
  }

  const statement: ImportedStatement = {
    statementId: args.statementId,
    checksum,
    count: outcomes.length,
    entries: outcomes,
    totalMinor,
  };
  args.store.record(args.statementId, checksum, statement);
  return { kind: 'imported', statement };
};
