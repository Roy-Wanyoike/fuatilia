/**
 * Typed chart of accounts + journal lines — F11 (issue #18, K5/R4).
 *
 * The chart is CLOSED on purpose: the posting matrix (./matrix.ts) can only
 * reference these seven accounts, and the GL reconciliation job (K5) can only
 * reconcile a control account that exists here. Adding an account is a
 * deliberate, reviewed change — never a string typed by an adapter.
 *
 * Money rules (SPEC §17): integer minor units (bigint), never floats; a line
 * amount is a MAGNITUDE — direction (DEBIT|CREDIT) carries the sign, so a
 * negative amount is always a modelling bug and is rejected.
 */
import { DomainError } from '../shared';
import type { Currency, Uuid } from '../shared';

/**
 * The Fuatilia chart of accounts (issue #18).
 *
 *  - AR_CONTROL        — the control account the GL reconciliation job (K5)
 *                        checks against Σ(open receivable balances).
 *  - CASH              — money at the PSP (M-Pesa float / bank).
 *  - REVENUE           — earned income (invoice issuance).
 *  - REVENUE_CONTRA    — contra-revenue (credit notes reduce revenue).
 *  - SALES_REFUNDS     — refund expense (money returned to customers).
 *  - BAD_DEBT_EXPENSE  — write-offs.
 *  - OTHER_INCOME      — fee income (late fees).
 */
export const ACCOUNTS = Object.freeze([
  'AR_CONTROL',
  'CASH',
  'REVENUE',
  'REVENUE_CONTRA',
  'SALES_REFUNDS',
  'BAD_DEBT_EXPENSE',
  'OTHER_INCOME',
] as const);

export type Account = (typeof ACCOUNTS)[number];

export const isAccount = (value: unknown): value is Account =>
  typeof value === 'string' && (ACCOUNTS as readonly string[]).includes(value);

/** Double-entry direction. Amounts are magnitudes; the direction carries the sign. */
export type PostingDirection = 'DEBIT' | 'CREDIT';

export const DIRECTIONS = Object.freeze(['DEBIT', 'CREDIT'] as const);

export const isPostingDirection = (value: unknown): value is PostingDirection =>
  value === 'DEBIT' || value === 'CREDIT';

/**
 * One journal line — the smallest auditable money movement (SPEC §17):
 * account/context, direction, amount, currency, all present, all explicit.
 */
export interface JournalLine {
  readonly account: Account;
  readonly direction: PostingDirection;
  /** ≥ 0 magnitude in integer minor units. The sign lives in `direction`. */
  readonly amountMinor: bigint;
  readonly currency: Currency;
}

/**
 * A JournalEntry references the source movement by the producing lane's event
 * (opaque name + id) — the ledger never imports another lane's types.
 */
export type LedgerSourceEventName = string;

export interface JournalLineInput {
  readonly account: Account;
  readonly direction: PostingDirection;
  readonly amountMinor: number | bigint;
  readonly currency: Currency;
}

/**
 * Validate one journal line: known account, known direction, integer minor
 * units ≥ 0. Zero-amount lines are refused — every posted movement moves.
 */
export const toJournalLine = (input: JournalLineInput): JournalLine => {
  if (!isAccount(input.account)) {
    throw new DomainError(
      'LEDGER_ACCOUNT_UNKNOWN',
      `unknown account ${String(input.account)} — see the typed chart of accounts`,
      { account: String(input.account) },
    );
  }
  if (!isPostingDirection(input.direction)) {
    throw new DomainError(
      'LEDGER_DIRECTION_INVALID',
      `direction must be 'DEBIT' or 'CREDIT', got ${String(input.direction)}`,
      { direction: String(input.direction) },
    );
  }
  const amount =
    typeof input.amountMinor === 'number'
      ? ((): bigint => {
          if (!Number.isSafeInteger(input.amountMinor)) {
            throw new DomainError(
              'LEDGER_AMOUNT_NOT_INTEGER',
              `line amount must be an integer minor unit, got ${String(input.amountMinor)}`,
              { amountMinor: String(input.amountMinor) },
            );
          }
          return BigInt(input.amountMinor);
        })()
      : input.amountMinor;
  if (amount < 0n) {
    throw new DomainError(
      'LEDGER_AMOUNT_NEGATIVE',
      `line amount is a magnitude — encode the sign in 'direction', got ${amount}`,
      { amountMinor: amount.toString() },
    );
  }
  if (amount === 0n) {
    throw new DomainError('LEDGER_AMOUNT_ZERO', 'a journal line must carry a non-zero amount');
  }
  return { account: input.account, direction: input.direction, amountMinor: amount, currency: input.currency };
};

/**
 * Double-entry balance check for a set of lines (all one currency):
 *   Σ(DEBIT amounts) === Σ(CREDIT amounts)
 * Unbalanced input throws LEDGER_ENTRY_UNBALANCED — a stable error code, per
 * the posting contract. Currency mixing throws CURRENCY_MISMATCH (R10).
 */
export const assertBalanced = (lines: readonly JournalLine[]): void => {
  if (lines.length === 0) {
    throw new DomainError('LEDGER_ENTRY_EMPTY', 'a journal entry requires at least one line');
  }
  const currency = lines[0]!.currency;
  let debits = 0n;
  let credits = 0n;
  for (const line of lines) {
    if (line.currency !== currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        `journal lines must be single-currency: ${line.currency} vs ${currency} (R10)`,
      );
    }
    if (line.direction === 'DEBIT') debits += line.amountMinor;
    else credits += line.amountMinor;
  }
  if (debits !== credits) {
    throw new DomainError(
      'LEDGER_ENTRY_UNBALANCED',
      `unbalanced journal entry: debits ${debits} != credits ${credits} ${currency}`,
      { debitsMinor: debits.toString(), creditsMinor: credits.toString(), currency },
    );
  }
  const distinctAccounts = new Set(lines.map((line) => line.account));
  if (distinctAccounts.size < 2) {
    throw new DomainError(
      'LEDGER_ENTRY_SELF_CANCELING',
      'a journal entry must touch at least two distinct accounts — a balanced single-account entry nets to zero and moves nothing',
      { accounts: [...distinctAccounts].sort() },
    );
  }
};

/**
 * Net balance of one account over a set of entries, in minor units:
 * Σ(DEBIT lines) − Σ(CREDIT lines). Debit-normal accounts (assets such as
 * AR_CONTROL) come out positive. The K5 job derives the GL control balance
 * with this helper; reversed entries self-cancel because a reversal flips
 * the original's lines (append-only math — nothing is ever edited).
 */
export const accountBalanceMinor = (
  entries: readonly { readonly lines: readonly JournalLine[] }[],
  account: Account,
): bigint =>
  entries.reduce(
    (net, entry) =>
      entry.lines.reduce(
        (lineNet, line) =>
          line.account !== account
            ? lineNet
            : lineNet + (line.direction === 'DEBIT' ? line.amountMinor : -line.amountMinor),
        net,
      ),
    0n,
  );

/** Compact audit label for a line, e.g. "Dr AR_CONTROL 125_00 KES". */
export const describeLine = (line: JournalLine): string => {
  const whole = line.amountMinor / 100n;
  const cents = line.amountMinor % 100n;
  return `${line.direction === 'DEBIT' ? 'Dr' : 'Cr'} ${line.account} ${whole}.${cents
    .toString()
    .padStart(2, '0')} ${line.currency}`;
};

/** Guard for caller-supplied entry ids (canonical UUID shape, stable code). */
export const assertEntryId = (value: Uuid, field: string): Uuid => {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    throw new DomainError('LEDGER_ID_INVALID', `${field} must be a canonical UUID, got ${String(value)}`, {
      field,
      value: String(value),
    });
  }
  return value;
};
