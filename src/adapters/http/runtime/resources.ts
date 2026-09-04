/**
 * In-memory resource runtime for the mounted fund-truth/collections routes
 * (issue #60) — COMPOSITION, not domain.
 *
 * This adapts the merged payments/receivables/collections lanes to the one
 * port the resource routes inject — the `ResourceStore`: the mutable
 * aggregate rows the routes act on (payments, receivables, collections
 * cases), the per-org controlled case sequence counter (case.ts: "the
 * per-org counter lives with the adapter"), and an append-only event log
 * (`record`) holding the lanes' facts in the same structural envelope the
 * auth store uses (`StoredEvent` — issue #55).
 *
 * Style, seam and discipline mirror `runtime/memory.ts` exactly:
 *   - getters return fresh copies; saves UPSERT by aggregate id (lane facts
 *     are immutable values — transitions replace the row);
 *   - deterministic, no I/O, no Date.now() (routes pass the kernel's clock);
 *   - a production deployment replaces this store with databases; the
 *     kernel/routes/middleware stay untouched (that is the adapter seam).
 *
 * Org scoping note: `CollectionsCase` carries `orgId` and is org-scoped by
 * the collections routes; the payments/receivables lane aggregates carry no
 * orgId (lane values, opaque cross-lane ids only), so the reference store is
 * process-global for them — multi-org deployments enforce isolation in their
 * persistence adapter, exactly where the store is swapped.
 */
import type { Payment } from '../../../domain/payments/payment';
import type { Receivable } from '../../../domain/receivables/receivable';
import type { CollectionsCase } from '../../../domain/collections/case';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import type { StoredEvent } from './memory';

/**
 * The mutable resource state the `/v1/payments|receivables|collections`
 * routes act on, plus the append-only lane-event log.
 */
export interface ResourceStore {
  receivables(): readonly Receivable[];
  payments(): readonly Payment[];
  cases(): readonly CollectionsCase[];
  saveReceivable(receivable: Receivable): void;
  savePayment(payment: Payment): void;
  saveCase(collectionsCase: CollectionsCase): void;
  /**
   * Next position in the org's controlled case sequence (case.ts:
   * CASE-000001…). Derived from the stored rows — max stored `sequence` for
   * the org plus 1, floored at 1 — so the counter survives replays without
   * extra state and can never hand out a used number.
   */
  nextCaseSequence(orgId: Uuid): number;
  /** Append-only lane-event log (domain facts; audited denials live in the auth store). */
  record(event: StoredEvent): void;
  events(): readonly StoredEvent[];
}

const upsert = <T>(items: T[], item: T, keyOf: (item: T) => string): void => {
  const key = keyOf(item);
  const index = items.findIndex((existing) => keyOf(existing) === key);
  if (index >= 0) items[index] = item;
  else items.push(item);
};

/** In-memory ResourceStore — deterministic, no I/O, test-seedable. */
export class InMemoryResourceStore implements ResourceStore {
  private readonly receivableRows: Receivable[] = [];
  private readonly paymentRows: Payment[] = [];
  private readonly caseRows: CollectionsCase[] = [];
  private readonly eventLog: StoredEvent[] = [];

  receivables(): readonly Receivable[] {
    return [...this.receivableRows];
  }

  payments(): readonly Payment[] {
    return [...this.paymentRows];
  }

  cases(): readonly CollectionsCase[] {
    return [...this.caseRows];
  }

  saveReceivable(receivable: Receivable): void {
    upsert(this.receivableRows, receivable, (r) => r.id);
  }

  savePayment(payment: Payment): void {
    upsert(this.paymentRows, payment, (p) => p.id);
  }

  saveCase(collectionsCase: CollectionsCase): void {
    upsert(this.caseRows, collectionsCase, (c) => c.id);
  }

  nextCaseSequence(orgId: Uuid): number {
    return (
      this.caseRows.reduce((max, c) => (c.orgId === orgId && c.sequence > max ? c.sequence : max), 0) + 1
    );
  }

  record(event: StoredEvent): void {
    this.eventLog.push(event);
  }

  events(): readonly StoredEvent[] {
    return [...this.eventLog];
  }
}

/**
 * Normalize any lane event into the structural `StoredEvent` envelope. The
 * payments lane stamps `occurredAt` as a Date; the receivables/collections
 * lanes (and the auth lane) stamp ISO-8601 strings — the log stores strings.
 */
export const toStoredEvent = (
  event: { readonly name: string; readonly version: 1; readonly aggregateId: string; readonly payload: unknown; readonly occurredAt: Date | string },
): StoredEvent => ({
  name: event.name,
  version: event.version,
  aggregateId: event.aggregateId,
  payload: event.payload,
  occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
});

/**
 * The deps every resource route table takes (the kernel's injected ports —
 * the same shape `authRoutes` takes, with the resource store beside the auth
 * store). `clock`/`idGen` are the KERNEL's ports, so handler time and ids
 * stay deterministic and injectable.
 */
export interface ResourceRouteDeps {
  readonly store: ResourceStore;
  readonly clock: Clock;
  readonly idGen: () => string;
}
