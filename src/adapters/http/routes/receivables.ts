/**
 * `/v1/receivables/*` — the receivable read model over the receivables lane
 * (issue #60).
 *
 * The route registration is a TABLE of `{ method, pattern, permission,
 * handler }` rows, in the style of `routes/auth.ts`: every route here
 * requires the `receivables:read` vocabulary permission; the kernel's
 * middleware does authenticate → `can(principal, permission)` → audited
 * denial (401/403) BEFORE the handler runs.
 *
 * Read-model discipline (issue scope: "aging / receivable read-model
 * routes"): receivable rows arrive in the ResourceStore through the
 * invoicing flow / persistence adapters — this table mounts NO write route
 * and records no events. Handlers are wire→lane adapters ONLY: they look up
 * the aggregate (`HTTP_RECEIVABLE_NOT_FOUND`), call the lane's PURE aging +
 * balance math (`daysPastDue`/`agingBucket`/`balanceOf` — never re-implement
 * it), and project serializable views. The lane's refusal to age a settled
 * receivable (`AGING_NOT_APPLICABLE` — nothing left to age) is adapted into
 * the view as `aging: null`, never thrown past the kernel.
 *
 * Org scoping: the receivable aggregate carries no orgId (lane value), so
 * the reference store is process-global; multi-org deployments enforce
 * isolation in their persistence adapter (see runtime/resources.ts).
 */
import { DomainError } from '../../../domain/shared/errors';
import type { Clock } from '../../../domain/shared/ids';
import { Money, type Currency } from '../../../domain/shared/money';
import { agingBucket, daysPastDue } from '../../../domain/receivables/aging';
import { balanceOf, type Receivable } from '../../../domain/receivables/receivable';
import { HTTP_QUERY_INVALID, HTTP_RECEIVABLE_NOT_FOUND } from '../kernel/errors';
import type { RequestContext, RouteRecord } from '../kernel/types';
import { paginatedMeta, parsePagination, parseSorting } from '../pagination';
import type { ResourceRouteDeps } from '../runtime/resources';

// --- view projection (never a raw aggregate; everything JSON-safe) ---------------------

const jsonMoney = (amount: Money): { minor: number; currency: Currency } => ({
  minor: Number(amount.amount),
  currency: amount.currency,
});

/**
 * Aging projection: the lane refuses to age settled receivables
 * (`AGING_NOT_APPLICABLE`) — a read model answers `aging: null` for them
 * instead of surfacing a refusal for a question nobody asked.
 */
const agingOf = (receivable: Receivable, clock: Clock): { daysPastDue: number; bucket: string } | null => {
  try {
    return { daysPastDue: daysPastDue(receivable, clock), bucket: agingBucket(receivable, clock) };
  } catch (error) {
    if (error instanceof DomainError && error.code === 'AGING_NOT_APPLICABLE') return null;
    throw error;
  }
};

const isoOrNull = (at: Date | null): string | null => (at === null ? null : at.toISOString());

export const receivableView = (receivable: Receivable, clock: Clock) => ({
  id: receivable.id,
  invoiceId: receivable.invoiceId,
  customerId: receivable.customerId,
  currency: receivable.currency,
  original: jsonMoney(receivable.original),
  applied: jsonMoney(receivable.applied),
  balance: jsonMoney(balanceOf(receivable)), // R1: original − applied, the lane's own math
  state: receivable.state,
  overdue: receivable.overdue,
  openedAt: isoOrNull(receivable.openedAt),
  dueDate: receivable.dueDate.toISOString(),
  settledAt: isoOrNull(receivable.settledAt),
  voidedAt: isoOrNull(receivable.voidedAt),
  writeOff:
    receivable.writeOff === null
      ? null
      : {
          reason: receivable.writeOff.reason,
          approvedBy: receivable.writeOff.approvedBy,
          writtenOffAt: receivable.writeOff.writtenOffAt.toISOString(),
        },
  uncollectibleReason: receivable.uncollectibleReason,
  uncollectibleAt: isoOrNull(receivable.uncollectibleAt),
  recoveredAt: isoOrNull(receivable.recoveredAt),
  aging: agingOf(receivable, clock),
});

// --- list helpers ------------------------------------------------------------------------

/** The sortable fields the receivable list exposes (arbitrary sort strings are how you scan a DB). */
const SORTABLE = ['id', 'state', 'dueDate'] as const;

const compareViews =
  (field: string, order: 'asc' | 'desc') =>
  (a: Record<string, unknown>, b: Record<string, unknown>): number => {
    // Views are flat JSON (dates already ISO strings) — lexicographic compare
    // is deterministic; the whitelist guarantees the field exists.
    const cmp = String(a[field]).localeCompare(String(b[field]));
    return order === 'asc' ? cmp : -cmp;
  };

/**
 * The opaque reference cursor is the offset into the deterministically
 * ordered list (opaque to the client; a persistence adapter swaps in its
 * own keyset cursor behind the same query contract).
 */
const decodeCursor = (cursor: string): number => {
  const offset = Number(cursor);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new DomainError(HTTP_QUERY_INVALID, `query parameter 'cursor' is not a valid page cursor`);
  }
  return offset;
};

// --- the route table ---------------------------------------------------------------------

/** Receivables are read-only this wave: both routes require `receivables:read`. */
export const RECEIVABLES_READ_PERMISSION = 'receivables:read' as const;

export function receivablesRoutes(deps: ResourceRouteDeps): RouteRecord[] {
  const { store, clock } = deps;

  const getReceivableRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/receivables/:receivableId',
    permission: RECEIVABLES_READ_PERMISSION,
    handler: (ctx: RequestContext) => {
      const receivable = store.receivables().find((r) => r.id === ctx.params['receivableId']);
      if (!receivable) {
        throw new DomainError(HTTP_RECEIVABLE_NOT_FOUND, `receivable ${ctx.params['receivableId']} does not exist`);
      }
      return { status: 200, data: { receivable: receivableView(receivable, clock) } };
    },
  };

  const listReceivablesRoute: RouteRecord = {
    method: 'GET',
    pattern: '/v1/receivables',
    permission: RECEIVABLES_READ_PERMISSION,
    handler: (ctx: RequestContext) => {
      const { limit, cursor } = parsePagination(ctx.query);
      const { field, order } = parseSorting(ctx.query, SORTABLE);
      const offset = cursor === null ? 0 : decodeCursor(cursor);
      const views = store
        .receivables()
        .map((receivable) => receivableView(receivable, clock) as unknown as Record<string, unknown>);
      const ordered = field === null ? views : [...views].sort(compareViews(field, order));
      const page = ordered.slice(offset, offset + limit);
      return {
        status: 200,
        data: { receivables: page },
        meta: paginatedMeta(offset + limit < ordered.length ? String(offset + limit) : null, ordered.length),
      };
    },
  };

  return [getReceivableRoute, listReceivablesRoute];
}
