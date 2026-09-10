/**
 * `/v1/ledger/*` — the append-only GL read surface (issue #132).
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows, in the style of `routes/payments.ts`; every route here
 * requires the `ledger:read` vocabulary permission; the kernel's middleware
 * does authenticate → `can(principal, permission)` → audited denial (401/403)
 * BEFORE the handler runs.
 *
 * READ-ONLY BY CONTRACT (R3): no operation on /v1 mutates ledger truth —
 * this table mounts no write route and records no events. Journal rows
 * arrive only through the lanes' posting flows; the REFERENCE composition
 * derives the chart and the journal exactly where the posting flow seeds
 * them (repositories.EnsureConfirmationLedgerSeed / PostConfirmationEntry,
 * mirrored): the first confirmed payment in a currency seeds the per-currency
 * `cash-<CCY>` / `ar-<CCY>` asset pair, and every confirmed payment carries
 * exactly one balanced two-line entry (Dr cash, Cr AR) with the
 * `payment_confirmed:<paymentId>` journal ref as the idempotent replay key.
 * A persistence adapter swaps in the real ledger_accounts/ledger_entries rows
 * behind the same contract — that is the adapter seam, not this table.
 *
 * Line discipline (SPEC §17): amounts ride integer minor units (R10) as
 * magnitudes — `direction` (DEBIT|CREDIT) carries the sign; the direction
 * names are the ledger lane's PostingDirection (src/domain/ledger/accounts.ts).
 *
 * Deterministic order: accounts default to insertion (the seeding flow's
 * order, `id` tiebreak), entries to the append-only write order
 * (`postedAt`, then `entryId`, then `lineNo`) — every sort keeps those
 * tiebreaks so a page boundary can never shuffle lines within an entry.
 *
 * Org scoping: the payment aggregate carries no orgId (lane value) — see
 * runtime/resources.ts for the reference-store scoping note; multi-org
 * deployments enforce isolation in their persistence adapter.
 */
import { DomainError } from '../../../domain/shared/errors';
import type { Currency } from '../../../domain/shared/money';
import { uuidFromSeed } from '../../../domain/ledger/ids';
import type { Payment } from '../../../domain/payments/payment';
import { HTTP_QUERY_INVALID } from '../kernel/errors';
import type { RequestContext, RouteRecord } from '../kernel/types';
import { paginatedMeta, parsePagination, parseSorting } from '../pagination';
import type { ResourceRouteDeps } from '../runtime/resources';

// --- view projection (never a raw aggregate; everything JSON-safe) ---------------------

/** One chart-of-accounts view — the reference composition's stable id IS the code. */
export interface LedgerAccountView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'asset';
  readonly currency: Currency;
}

/** One journal LINE view — the line-grained read model /v1/ledger/entries serves. */
export interface LedgerEntryLineView {
  readonly entryId: string;
  readonly lineNo: 1 | 2;
  readonly accountCode: string;
  readonly accountKind: 'asset';
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amount: { readonly minor: number; readonly currency: Currency };
  readonly source: 'payments';
  readonly sourceRef: string | null;
  readonly journalRef: string;
  readonly postedAt: string;
  readonly reversalOf: string | null;
}

const cashAccountCode = (currency: Currency): string => `cash-${currency}`;
const arAccountCode = (currency: Currency): string => `ar-${currency}`;

/**
 * The chart of accounts, derived where the posting flow seeds it: one
 * cash/AR asset pair per currency a confirmation has landed in, in seed
 * order (cash first — EnsureConfirmationLedgerSeed's insert order).
 */
const chartOf = (payments: readonly Payment[]): LedgerAccountView[] => {
  const accounts: LedgerAccountView[] = [];
  const seen = new Set<string>();
  for (const payment of payments) {
    if (!payment.confirmedMinor || seen.has(payment.currency)) continue;
    seen.add(payment.currency);
    accounts.push({
      id: cashAccountCode(payment.currency),
      code: cashAccountCode(payment.currency),
      name: `Mobile Money Cash (${payment.currency})`,
      kind: 'asset',
      currency: payment.currency,
    });
    accounts.push({
      id: arAccountCode(payment.currency),
      code: arAccountCode(payment.currency),
      name: `Accounts Receivable (${payment.currency})`,
      kind: 'asset',
      currency: payment.currency,
    });
  }
  return accounts;
};

/**
 * The journal, derived where the posting flow writes it: exactly one
 * balanced two-line entry per confirmed payment. The entryId is a pure
 * function of the replay key (uuidFromSeed over the journal ref — the
 * ledger lane's deterministic-id discipline, src/domain/ledger/ids.ts), so
 * re-reading the same truth yields the same entry id, and the confirmation
 * replay can never double-post (R9's ledger face).
 */
const journalOf = (payments: readonly Payment[]): LedgerEntryLineView[] => {
  const lines: LedgerEntryLineView[] = [];
  for (const payment of payments) {
    if (!payment.confirmedMinor) continue;
    const amount = payment.confirmedMinor.amount;
    const currency = payment.confirmedMinor.currency;
    const journalRef = `payment_confirmed:${payment.id}`;
    const entryId = uuidFromSeed(`ledger.entry:payments:${payment.id}`);
    const postedAt = payment.confirmedAt ? payment.confirmedAt.toISOString() : payment.initiatedAt.toISOString();
    lines.push({
      entryId,
      lineNo: 1,
      accountCode: cashAccountCode(currency),
      accountKind: 'asset',
      direction: 'DEBIT',
      amount: { minor: Number(amount), currency },
      source: 'payments',
      sourceRef: payment.externalRef,
      journalRef,
      postedAt,
      reversalOf: null,
    });
    lines.push({
      entryId,
      lineNo: 2,
      accountCode: arAccountCode(currency),
      accountKind: 'asset',
      direction: 'CREDIT',
      amount: { minor: Number(amount), currency },
      source: 'payments',
      sourceRef: payment.externalRef,
      journalRef,
      postedAt,
      reversalOf: null,
    });
  }
  return lines;
};

// --- ordering (deterministic; the tiebreaks ride every sort) ----------------------------

const compareBy = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const orderLines = (
  lines: readonly LedgerEntryLineView[],
  field: string | null,
  order: 'asc' | 'desc',
): LedgerEntryLineView[] => {
  const sorted = [...lines];
  const direction = order === 'asc' ? 1 : -1;
  const numeric = (field: string, line: LedgerEntryLineView): number | string => {
    if (field === 'id') return line.entryId;
    if (field === 'postedAt') return line.postedAt;
    return line.source;
  };
  if (field !== null) {
    sorted.sort((a, b) => {
      const av = numeric(field, a);
      const bv = numeric(field, b);
      if (av !== bv) return (av < bv ? -1 : 1) * direction;
      return compareBy(a.entryId, b.entryId) || a.lineNo - b.lineNo;
    });
    return sorted;
  }
  // default: the append-only write order — postedAt, entryId, lineNo
  sorted.sort(
    (a, b) =>
      compareBy(a.postedAt, b.postedAt) * direction ||
      compareBy(a.entryId, b.entryId) ||
      a.lineNo - b.lineNo,
  );
  return sorted;
};

const orderAccounts = (
  accounts: readonly LedgerAccountView[],
  field: string | null,
  order: 'asc' | 'desc',
): LedgerAccountView[] => {
  const sorted = [...accounts];
  const direction = order === 'asc' ? 1 : -1;
  if (field === null) return sorted; // insertion (seeding) order
  sorted.sort((a, b) => {
    const av = String(a[field as keyof LedgerAccountView]);
    const bv = String(b[field as keyof LedgerAccountView]);
    if (av !== bv) return (av < bv ? -1 : 1) * direction;
    return compareBy(a.id, b.id); // the unique id is the tiebreak
  });
  return sorted;
};

// --- the route table ----------------------------------------------------------------------

const SORTABLE_ACCOUNTS = ['id', 'code', 'kind', 'currency'] as const;
const SORTABLE_ENTRIES = ['id', 'postedAt', 'source'] as const;

/** The opaque reference cursor is the offset into the deterministic order. */
const decodeCursor = (cursor: string): number => {
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' is not a valid page cursor`);
  }
  return offset;
};

export function ledgerRoutes(deps: ResourceRouteDeps): RouteRecord[] {
  const accountsRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/ledger/accounts',
    permission: 'ledger:read',
    handler: (ctx) => {
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE_ACCOUNTS);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const ordered = orderAccounts(chartOf(deps.store.payments()), field, order);
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { accounts: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  const entriesRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/ledger/entries',
    permission: 'ledger:read',
    handler: (ctx) => {
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE_ENTRIES);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const ordered = orderLines(journalOf(deps.store.payments()), field, order);
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { entries: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  return [accountsRoute, entriesRoute];
}
