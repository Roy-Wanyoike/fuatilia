/**
 * PGResourceStore — the PostgreSQL implementation of the resource-lane
 * `ResourceStore` seam (issue #73), satisfying the EXACT interface of
 * `../../http/runtime/resources.ts` so `createHttpKernel({ resourceStore })`
 * mounts it untouched.
 *
 * THE BINDING CONSTRAINT (shared with PGAuthStore): the ResourceStore seam is
 * SYNCHRONOUS — `receivables(): readonly Receivable[]`, `saveCase(): void`,
 * `nextCaseSequence(orgId): number`. A direct async pg implementation cannot
 * satisfy it (a synchronous route handler needs the answer before any round
 * trip could complete). Where the file-backed store solved the same
 * constraint with sync fs + a journal, this adapter is a CACHE-FIRST
 * SYNCHRONOUS FACADE over the async pool:
 *
 *   - READS are served from an in-memory PROJECTION of the PostgreSQL rows
 *     (fresh copies, upsert-by-id semantics — identical contracts to the
 *     reference `InMemoryResourceStore`);
 *   - WRITES mutate the projection synchronously AND enqueue a write entry;
 *   - an async FLUSHER persists each enqueued batch in exactly ONE
 *     transaction (`client.withTx`), so PostgreSQL never holds a partial
 *     aggregate — a crashed batch leaves zero rows (server-side rollback);
 *   - `ensureReady()` boots: idempotent lane DDL, then the projection is
 *     reloaded from PostgreSQL (structurally — malformed rows are
 *     QUARANTINED, never fabricated, thrown, or allowed to poison boot);
 *   - `flush()` drains the queue (tests and graceful stop) and REJECTS if a
 *     batch could not be committed — fail-closed, never a silent success.
 *
 * Org scoping (resources.ts header note — THE ADAPTER IS WHERE MULTI-ORG
 * ISOLATION IS ENFORCED): `CollectionsCase` carries `orgId`; the
 * payments/receivables lane aggregates are org-less lane values. Options:
 *
 *   - `orgScope` SET (the multi-org deployment shape — one adapter per org):
 *     receivable/payment saves are written under that org; case saves carry
 *     their own orgId and are REFUSED (PG_ORG_SCOPE_MISMATCH, thrown
 *     synchronously from the seam's only error channel) unless they match;
 *     every read is filtered to the org; boot pre-reserves a case-sequence
 *     block for the org inside the boot transaction.
 *   - `orgScope` ABSENT (single-tenant / process-global): case and event
 *     saves take the org from the aggregate; receivable/payment saves are
 *     REFUSED with PG_ORG_SCOPE_REQUIRED — the adapter cannot honestly
 *     invent an org for an org-less lane value, and the platform schema
 *     (db/migrations/0001–0014) carries NOT NULL org_id on every row.
 *
 * Case sequences (case.ts: "the per-org counter lives with the adapter"):
 * hand-outs are synchronous from a per-org allocator seeded at boot from
 * BOTH the `case_sequences` counter and the stored cases (a fresh process
 * never re-issues a committed number). The counter itself advances ONLY
 * inside the flusher, via one server-side statement per org per batch —
 *   UPDATE case_sequences SET next = GREATEST(next + $block, $floor)
 *   WHERE org_id = $1 RETURNING next     (row initialized on first use)
 * — never an application read-modify-write; concurrent flushers serialize on
 * the row lock, and the DDL `uq_collections_cases_seq` is the tripwire.
 *
 * Write-order contract: the flusher persists batch entries in queue order,
 * so an aggregate must be saved AFTER the aggregates it references
 * (payment-with-allocations after its receivable; a case after its
 * receivables) — the same order the lanes' own flows produce. A reference to
 * a never-saved aggregate is a structured `PG_LANE_REFERENCE_MISSING`
 * rejection (checked in-transaction before any insert), never a fabricated
 * anchor and never a silent drop.
 *
 * Durability window (honesty note, expanded in the README): between a
 * synchronous save and its asynchronous flush commit the change lives only
 * in this process. A crash there loses exactly the un-flushed saves — never
 * a partial row, never a silent divergence: the boot reload re-establishes
 * PostgreSQL's last committed truth.
 */
import {
  CURRENCIES,
  Money,
  type Currency,
  type Uuid,
} from '../../../domain/shared';
import {
  CONFIRMED_FAMILY,
  isConfirmedFamily,
  unappliedMinorOf,
  type Payment,
  type PaymentAllocationRow,
  type PaymentChannel,
  type PaymentRefundRow,
  type PaymentState,
} from '../../../domain/payments/payment';
import type { Receivable, ReceivableState, ReceivableWriteOff } from '../../../domain/receivables/receivable';
import { CASE_ACTION_TYPES, type ActionSource, type CaseAction } from '../../../domain/collections/actions';
import {
  CASE_PRIORITIES,
  type CasePriority,
  type CaseStatus,
  type CaseTransitionRecord,
  type CollectionsCase,
} from '../../../domain/collections/case';
import type { StoredEvent } from '../../http/runtime/memory';
import type { ResourceStore } from '../../http/runtime/resources';
import { PGScopeError } from './authstore';
import type { PGClient, TxHandle } from './client';
import {
  asDate,
  asString,
  nullableDate,
  nullableString,
  requiredBoolean,
  requiredDate,
  requiredEnum,
  requiredJson,
  requiredMinorUnits,
  requiredSafePositiveInt,
  requiredString,
  requiredStringArray,
  revival,
  RowFormatError,
  type Revival,
  type Row,
} from './revive';
import {
  ALLOCATION_MAP,
  ANCHORS,
  CASE_LANE_STATE_MAP,
  CASE_MAP,
  CASE_SEQUENCE,
  CASE_SEQUENCE_BLOCK,
  LANE_EVENT_MAP,
  PAYMENT_MAP,
  QUARANTINE_COLUMNS,
  QUARANTINE_TABLE,
  RECEIVABLE_MAP,
  REFUND_MAP,
} from './schema-map';

// --- errors -------------------------------------------------------------------------

/**
 * A cross-lane reference the seam carries opaquely points at a row that does
 * not exist (a receivable an allocation targets, a receivable a case
 * covers). Thrown inside the flush transaction — the whole batch rolls back
 * and the failure is sticky until a `flush()` re-arms. Structured rejection
 * over fabrication (schema-map principle 5).
 */
export class PGReferenceError extends Error {
  readonly code: 'PG_LANE_REFERENCE_MISSING';
  readonly table: string;
  readonly missingId: string;

  constructor(table: string, missingId: string, orgId: string) {
    super(
      `PG_LANE_REFERENCE_MISSING: ${table} has no row for id ${missingId} in org ${orgId} — ` +
      'save the referenced aggregate first (the flusher persists batch entries in queue order)',
    );
    this.name = 'PGReferenceError';
    this.code = 'PG_LANE_REFERENCE_MISSING';
    this.table = table;
    this.missingId = missingId;
  }
}

// --- structural revival (PG row → domain row; mirrors ../replay.ts) -----------------

const asUuid = (value: string): Uuid => value as Uuid;

const asCurrency = (value: string): Currency => {
  if (!(CURRENCIES as readonly string[]).includes(value)) {
    throw new RowFormatError(`field 'currency' value '${value}' is not a lane currency`);
  }
  return value as Currency;
};

const RECEIVABLE_STATES: readonly ReceivableState[] = [
  'draft', 'open', 'partially_paid', 'settled', 'written_off', 'recovered', 'uncollectible', 'voided',
];
const PAYMENT_STATES: readonly PaymentState[] = [
  'initiated', 'pending_confirmation', 'confirmed', 'partially_allocated', 'allocated', 'unapplied',
  'failed', 'reversed', 'partially_refunded', 'refunded',
];
const PAYMENT_CHANNELS: readonly PaymentChannel[] = ['c2b', 'stk'];
const CASE_STATUS_VALUES: readonly CaseStatus[] = ['open', 'in_progress', 'resolved', 'closed_inactive'];
const ACTION_SOURCES: readonly ActionSource[] = ['automated', 'manual'];

const moneyOf = (minor: bigint, currency: Currency): Money => Money.ofMinor(minor, currency);

const reviveWriteOff = (row: Row): ReceivableWriteOff | null => {
  const reason = nullableString(row, 'writeOffReason');
  const approvedBy = nullableString(row, 'writeOffApprovedBy');
  const writtenOffAt = nullableDate(row, 'writeOffAt');
  if (reason === null && approvedBy === null && writtenOffAt === null) return null;
  if (reason === null || approvedBy === null || writtenOffAt === null) {
    throw new RowFormatError("field 'writeOff' must carry reason, approver and instant together");
  }
  return { reason, approvedBy, writtenOffAt };
};

const reviveReceivable = (row: Row): Revival<Receivable> =>
  revival(() => {
    const currency = asCurrency(requiredString(row, 'currency'));
    return {
      id: asUuid(requiredString(row, 'id')),
      invoiceId: asUuid(requiredString(row, 'invoiceId')),
      customerId: asUuid(requiredString(row, 'customerId')),
      currency,
      original: moneyOf(requiredMinorUnits(row, 'originalMinor'), currency),
      applied: moneyOf(requiredMinorUnits(row, 'appliedMinor'), currency),
      state: requiredEnum(row, 'state', RECEIVABLE_STATES),
      overdue: requiredBoolean(row, 'overdue'),
      openedAt: nullableDate(row, 'openedAt'),
      dueDate: requiredDate(row, 'dueDate'),
      settledAt: nullableDate(row, 'settledAt'),
      voidedAt: nullableDate(row, 'voidedAt'),
      writeOff: reviveWriteOff(row),
      uncollectibleReason: nullableString(row, 'uncollectibleReason'),
      uncollectibleAt: nullableDate(row, 'uncollectibleAt'),
      recoveredAt: nullableDate(row, 'recoveredAt'),
    };
  });

const reviveAllocationRow = (row: Row, currency: Currency): Revival<PaymentAllocationRow> =>
  revival(() => ({
    id: asUuid(requiredString(row, 'id')),
    paymentId: asUuid(requiredString(row, 'paymentId')),
    receivableId: asUuid(requiredString(row, 'receivableId')),
    amount: moneyOf(requiredMinorUnits(row, 'amountMinor'), currency),
    recordedAt: requiredDate(row, 'recordedAt'),
  }));

const reviveRefundRow = (row: Row, currency: Currency): Revival<PaymentRefundRow> =>
  revival(() => ({
    id: asUuid(requiredString(row, 'id')),
    paymentId: asUuid(requiredString(row, 'paymentId')),
    amount: moneyOf(requiredMinorUnits(row, 'amountMinor'), currency),
    reason: requiredString(row, 'reason'),
    recordedAt: requiredDate(row, 'recordedAt'),
  }));

/**
 * A payment revives with its reservation rows. `confirmedMinor` follows the
 * platform shape CHECK (0005): present exactly for the confirmed family and
 * `reversed` — a DDL-legal row that breaks the lane's own rule is the
 * canonical quarantine case.
 */
const revivePayment = (
  row: Row,
  allocationRows: readonly Row[],
  refundRows: readonly Row[],
): Revival<Payment> => {
  const currency = asCurrency(requiredString(row, 'currency'));
  const allocations: PaymentAllocationRow[] = [];
  for (const allocationRow of allocationRows) {
    const revived = reviveAllocationRow(allocationRow, currency);
    if (!revived.ok) return { ok: false as const, reason: revived.reason }; // propagate the row's quarantine reason
    allocations.push(revived.row);
  }
  const refunds: PaymentRefundRow[] = [];
  for (const refundRow of refundRows) {
    const revived = reviveRefundRow(refundRow, currency);
    if (!revived.ok) return { ok: false as const, reason: revived.reason };
    refunds.push(revived.row);
  }
  return revival(() => {
    const state = requiredEnum(row, 'state', PAYMENT_STATES);
    const confirmedRaw = row['confirmedMinor'];
    const confirmedMinor =
      confirmedRaw === null || confirmedRaw === undefined
        ? null
        : moneyOf(requiredMinorUnits(row, 'confirmedMinor'), currency);
    const carriesConfirmed = (CONFIRMED_FAMILY as readonly string[]).includes(state) || state === 'reversed';
    if (carriesConfirmed && confirmedMinor === null) {
      throw new RowFormatError(`state '${state}' must carry a confirmed amount`);
    }
    if (!carriesConfirmed && confirmedMinor !== null) {
      throw new RowFormatError(`state '${state}' cannot carry a confirmed amount`);
    }
    const customerId = nullableString(row, 'customerId');
    const initiatedAt = requiredDate(row, 'initiatedAt');
    const confirmedAt = nullableDate(row, 'confirmedAt');
    const failedAt = nullableDate(row, 'failedAt');
    const failureCode = nullableString(row, 'failureCode');
    const reversedAt = nullableDate(row, 'reversedAt');
    const reversalReason = nullableString(row, 'reversalReason');
    return {
      id: asUuid(requiredString(row, 'id')),
      channel: requiredEnum(row, 'channel', PAYMENT_CHANNELS),
      externalRef: requiredString(row, 'externalRef'),
      idempotencyKey: requiredString(row, 'idempotencyKey'),
      ...(customerId === null ? {} : { customerId: asUuid(customerId) }),
      state,
      currency,
      requestedMinor: moneyOf(requiredMinorUnits(row, 'requestedMinor'), currency),
      declaredRefs: requiredStringArray(row, 'declaredRefs'),
      ...(confirmedMinor === null ? {} : { confirmedMinor }),
      initiatedAt,
      ...(confirmedAt === null ? {} : { confirmedAt }),
      ...(failedAt === null ? {} : { failedAt }),
      ...(failureCode === null ? {} : { failureCode }),
      ...(reversedAt === null ? {} : { reversedAt }),
      ...(reversalReason === null ? {} : { reversalReason }),
      allocations,
      refunds,
    };
  });
};

// --- case lane state (the adapter-owned projection of the lane's logs) ---------------

const jsonArray = (value: unknown, key: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new RowFormatError(`field '${key}' must be a jsonb array`);
  return value;
};

const reviveCaseHistory = (value: unknown): CaseTransitionRecord[] =>
  jsonArray(value, 'history').map((entry, index): CaseTransitionRecord => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RowFormatError(`history[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const at = asDate(record['at']);
    if (at === null) throw new RowFormatError(`history[${index}].at must be an ISO instant`);
    const from = record['from'];
    const to = record['to'];
    if (typeof from !== 'string' || !(CASE_STATUS_VALUES as readonly string[]).includes(from)) {
      throw new RowFormatError(`history[${index}].from must be a case status`);
    }
    if (typeof to !== 'string' || !(CASE_STATUS_VALUES as readonly string[]).includes(to)) {
      throw new RowFormatError(`history[${index}].to must be a case status`);
    }
    const reason = record['reason'];
    const actorId = record['actorId'];
    if (typeof reason !== 'string' || typeof actorId !== 'string') {
      throw new RowFormatError(`history[${index}] must carry reason and actorId strings`);
    }
    return { from: from as CaseStatus, to: to as CaseStatus, reason, actorId, at };
  });

const isCasePriority = (candidate: unknown): candidate is CasePriority =>
  typeof candidate === 'string' && (CASE_PRIORITIES as readonly string[]).includes(candidate);

const reviveCasePriorityChanges = (value: unknown): CollectionsCase['priorityChanges'] =>
  jsonArray(value, 'priorityChanges').map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RowFormatError(`priorityChanges[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const at = asDate(record['at']);
    if (at === null) throw new RowFormatError(`priorityChanges[${index}].at must be an ISO instant`);
    const from = record['from'];
    const to = record['to'];
    if (!isCasePriority(from) || !isCasePriority(to)) {
      throw new RowFormatError(`priorityChanges[${index}] must carry case priorities`);
    }
    const reason = record['reason'];
    const actorId = record['actorId'];
    if (typeof reason !== 'string' || typeof actorId !== 'string') {
      throw new RowFormatError(`priorityChanges[${index}] must carry reason and actorId strings`);
    }
    return { from, to, reason, actorId, at };
  });

const reviveCaseActions = (value: unknown): CaseAction[] =>
  jsonArray(value, 'actions').map((entry, index): CaseAction => {
    if (typeof entry !== 'object' || entry === null) {
      throw new RowFormatError(`actions[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const instant = (key: string): Date => {
      const parsed = asDate(record[key]);
      if (parsed === null) throw new RowFormatError(`actions[${index}].${key} must be an ISO instant`);
      return parsed;
    };
    const optionalInstant = (key: string): Date | null => {
      const raw = record[key];
      if (raw === null || raw === undefined) return null;
      return instant(key);
    };
    const text = (key: string): string => {
      const raw = asString(record[key]);
      if (raw === null) throw new RowFormatError(`actions[${index}].${key} must be a string`);
      return raw;
    };
    const optionalText = (key: string): string | null => {
      const raw = record[key];
      if (raw === null || raw === undefined) return null;
      return text(key);
    };
    const type = text('type');
    if (!(CASE_ACTION_TYPES as readonly string[]).includes(type)) {
      throw new RowFormatError(`actions[${index}].type must be a case action type`);
    }
    const source = text('source');
    if (!(ACTION_SOURCES as readonly string[]).includes(source)) {
      throw new RowFormatError(`actions[${index}].source must be an action source`);
    }
    return {
      id: text('id'),
      type: type as CaseAction['type'],
      scheduledFor: instant('scheduledFor'),
      outcome: optionalText('outcome'),
      completedAt: optionalInstant('completedAt'),
      completedBy: optionalText('completedBy'),
      consentRef: optionalText('consentRef'),
      source: source as ActionSource,
      actorId: text('actorId'),
      recordedAt: instant('recordedAt'),
    };
  });

const reviveUuidArray = (value: unknown, key: string): Uuid[] =>
  jsonArray(value, key).map((entry, index): Uuid => {
    const raw = asString(entry);
    if (raw === null) throw new RowFormatError(`${key}[${index}] must be a uuid string`);
    return asUuid(raw);
  });

interface CaseLaneStateRow {
  readonly openedBy: string;
  readonly closedBy: string | null;
  readonly receivableIds: Uuid[];
  readonly history: CaseTransitionRecord[];
  readonly priorityChanges: CollectionsCase['priorityChanges'];
  readonly actions: CaseAction[];
}

const reviveLaneState = (row: Row): Revival<CaseLaneStateRow> =>
  revival(() => ({
    openedBy: requiredString(row, 'openedBy'),
    closedBy: nullableString(row, 'closedBy'),
    receivableIds: reviveUuidArray(requiredJson(row, 'receivableIds'), 'receivableIds'),
    history: reviveCaseHistory(requiredJson(row, 'history')),
    priorityChanges: reviveCasePriorityChanges(requiredJson(row, 'priorityChanges')),
    actions: reviveCaseActions(requiredJson(row, 'actions')),
  }));

const reviveCase = (row: Row, laneState: CaseLaneStateRow): Revival<CollectionsCase> =>
  revival(() => ({
    id: asUuid(requiredString(row, 'id')),
    caseNumber: requiredString(row, 'caseNumber'),
    sequence: requiredSafePositiveInt(row, 'sequence'),
    orgId: asUuid(requiredString(row, 'orgId')),
    receivableIds: laneState.receivableIds,
    collectorId: asUuid(requiredString(row, 'collectorId')),
    priority: requiredEnum(row, 'priority', CASE_PRIORITIES),
    status: requiredEnum(row, 'status', CASE_STATUS_VALUES),
    openedAt: requiredDate(row, 'openedAt'),
    openedBy: laneState.openedBy,
    closedAt: nullableDate(row, 'closedAt'),
    closedBy: laneState.closedBy,
    actions: laneState.actions,
    history: laneState.history,
    priorityChanges: laneState.priorityChanges,
  }));

const reviveLaneEvent = (row: Row): Revival<StoredEvent> =>
  revival(() => {
    const version = requiredSafePositiveInt(row, 'version');
    if (version !== 1) {
      throw new RowFormatError("field 'version' must be 1 — the seam's envelope constant");
    }
    return {
      name: requiredString(row, 'name'),
      version: 1 as const,
      aggregateId: requiredString(row, 'aggregateId'),
      payload: requiredJson(row, 'payload'),
      occurredAt: requiredDate(row, 'occurredAt').toISOString(),
    };
  });

// --- the boot report + the write queue ----------------------------------------------

/**
 * The boot report (mirrors ../replay.ts' LoadReport): `scanned` = rows read
 * from PostgreSQL, `applied` = rows revived into the projection,
 * `quarantined` = rows written to `fuatilia_lane_quarantine` and skipped.
 */
export interface PGLoadReport {
  readonly scanned: number;
  readonly applied: number;
  readonly quarantined: number;
}

/** One enqueued mutation — persisted by the flusher, in queue order. */
type ResourceLaneEntry =
  | { readonly kind: 'receivable'; readonly orgId: Uuid; readonly row: Receivable }
  | { readonly kind: 'payment'; readonly orgId: Uuid; readonly row: Payment }
  | { readonly kind: 'case'; readonly row: CollectionsCase }
  | { readonly kind: 'event'; readonly orgId: Uuid | null; readonly row: StoredEvent }
  | { readonly kind: 'sequence'; readonly orgId: Uuid; readonly floor: number };

/** Per-org case-sequence allocator state (see the module header). */
interface SequenceAllocator {
  /** The next number this process hands out. */
  next: number;
  /** High-water mark handed out or saved by this process (reservation floor). */
  floor: number;
}

export interface PGResourceStoreOptions {
  /**
   * Fixed org scope: when set, this instance is a PER-ORG adapter — every
   * read is filtered to the org, receivable/payment saves are written under
   * it, case saves must carry it (PG_ORG_SCOPE_MISMATCH otherwise), and boot
   * pre-reserves a case-sequence block for the org. Absent: single-tenant
   * process-global semantics for cases/events; org-less lane-value saves
   * (receivables/payments) are refused with PG_ORG_SCOPE_REQUIRED.
   */
  readonly orgScope?: Uuid;
}

/** The org an event belongs to, derived defensively from `payload.orgId`. */
const orgFromPayload = (payload: unknown): Uuid | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as { readonly orgId?: unknown }).orgId;
  return typeof candidate === 'string' && candidate !== '' ? (candidate as Uuid) : null;
};

const iso = (value: Date | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toISOString();

export class PGResourceStore implements ResourceStore {
  private readonly client: PGClient;
  private readonly orgScope: Uuid | null;

  /** Projections keyed by org, then aggregate id (composite-keyed: two orgs
   *  each carry their own row set; reads are org-filtered). */
  private readonly receivableRows = new Map<string, Map<string, Receivable>>();
  private readonly paymentRows = new Map<string, Map<string, Payment>>();
  private readonly caseRows = new Map<string, Map<string, CollectionsCase>>();
  private readonly eventLog: StoredEvent[] = [];

  /** case_sequences.next per org as read at boot (absent = no row yet). */
  private readonly bootCounters = new Map<string, number>();
  private readonly allocators = new Map<string, SequenceAllocator>();

  /** The write queue: mutations accepted but not yet committed to PostgreSQL. */
  private queue: ResourceLaneEntry[] = [];
  /** Serialized drain operations (never interleave batches). */
  private chain: Promise<void> = Promise.resolve();
  private pumping = false;
  /** First failed batch — sticky: `save*` throws until a `flush()` re-arms. */
  private failure: { readonly error: unknown } | null = null;
  /** Boot guard: mutations before a completed ensureReady() are a programming error. */
  private booted = false;

  constructor(client: PGClient, options: PGResourceStoreOptions = {}) {
    this.client = client;
    this.orgScope = options.orgScope ?? null;
  }

  // --- boot / durability ----------------------------------------------------------------

  /**
   * Boot (or re-boot): run the adapter's idempotent lane DDL, then reload
   * the projection from PostgreSQL inside ONE transaction; rows that fail
   * structural revival are QUARANTINED (visible, counted, skipped — never
   * thrown, never allowed to poison the boot). A scoped store also reserves
   * its first case-sequence block inside the boot transaction. Pending
   * writes (a re-boot over a live instance) are flushed first so the reload
   * never rolls back over uncommitted work.
   */
  async ensureReady(): Promise<PGLoadReport> {
    if (this.booted && this.queue.length > 0) await this.flush();
    await this.client.ensureLaneSchema();
    const report = await this.runExclusive(async () => {
      return this.client.withTx(async (tx) => this.loadIntoProjection(tx));
    });
    this.booted = true;
    return report;
  }

  /**
   * The durability barrier: every mutation accepted so far is COMMITTED to
   * PostgreSQL when this resolves. An explicit flush re-arms a previously
   * failed drain (the caller asked for the retry); the rejection is the
   * scrubbed store error (or the structured lane rejection).
   */
  async flush(): Promise<void> {
    this.assertBooted();
    this.failure = null;
    this.scheduleDrain();
    await this.chain;
    const failure = this.drainFailure();
    if (failure !== null) throw failure.error;
  }

  /** Drain, then end the shared client (graceful stop; flush failures propagate). */
  async close(): Promise<void> {
    if (this.booted) await this.flush();
    await this.client.close();
  }

  /** Writes accepted but not yet committed (introspection for tests/graceful stop). */
  pendingWrites(): number {
    return this.queue.length;
  }

  // --- the ResourceStore seam (synchronous reads, enqueued writes) -----------------------

  receivables(): readonly Receivable[] {
    return this.orgValues(this.receivableRows);
  }

  payments(): readonly Payment[] {
    return this.orgValues(this.paymentRows);
  }

  cases(): readonly CollectionsCase[] {
    return this.orgValues(this.caseRows);
  }

  // Every save* checks writability BEFORE touching the projection: a save
  // refused by the sticky failure mutates NOTHING and enqueues NOTHING —
  // the projection never diverges from what the flusher will persist.
  saveReceivable(receivable: Receivable): void {
    this.assertWritable();
    const orgId = this.requireLaneValueOrg('saveReceivable');
    this.orgMap(this.receivableRows, orgId).set(receivable.id, receivable);
    this.enqueue({ kind: 'receivable', orgId, row: receivable });
  }

  savePayment(payment: Payment): void {
    this.assertWritable();
    const orgId = this.requireLaneValueOrg('savePayment');
    this.orgMap(this.paymentRows, orgId).set(payment.id, payment);
    this.enqueue({ kind: 'payment', orgId, row: payment });
  }

  saveCase(collectionsCase: CollectionsCase): void {
    this.assertWritable();
    this.assertInScope(collectionsCase.orgId);
    const allocator = this.allocatorFor(collectionsCase.orgId);
    allocator.floor = Math.max(allocator.floor, collectionsCase.sequence);
    allocator.next = Math.max(allocator.next, collectionsCase.sequence + 1);
    this.orgMap(this.caseRows, collectionsCase.orgId).set(collectionsCase.id, collectionsCase);
    this.enqueue({ kind: 'case', row: collectionsCase });
  }

  /**
   * Next position in the org's controlled case sequence — the SYNCHRONOUS
   * half of the allocator: a unique, strictly increasing number handed out
   * from the per-org in-memory cursor seeded at boot (case_sequences counter
   * ∪ stored case sequences — a fresh process never re-issues a committed
   * number). The counter row itself advances asynchronously in the flusher
   * (one UPDATE … RETURNING, never read-modify-write); every hand-out
   * enqueues its reservation floor.
   */
  nextCaseSequence(orgId: Uuid): number {
    this.assertWritable();
    this.assertInScope(orgId);
    const allocator = this.allocatorFor(orgId);
    const sequence = allocator.next;
    allocator.next = sequence + 1;
    allocator.floor = Math.max(allocator.floor, sequence);
    this.enqueue({ kind: 'sequence', orgId, floor: allocator.floor });
    return sequence;
  }

  /**
   * Append one event to the durable lane-event log (`fuatilia_lane_events`,
   * outbox-shaped). Audited DENIALS do not come through here — they land in
   * the auth store's audit_events chain, exactly as today.
   */
  record(event: StoredEvent): void {
    this.assertWritable();
    if (event.payload === undefined) {
      throw new Error('PGResourceStore.record: the event payload must be a JSON value (not undefined)');
    }
    const orgId = orgFromPayload(event.payload);
    if (orgId !== null) this.assertInScope(orgId);
    this.eventLog.push(event);
    this.enqueue({ kind: 'event', orgId, row: event });
  }

  events(): readonly StoredEvent[] {
    return [...this.eventLog];
  }

  // --- internals: queue discipline ---------------------------------------------------

  private enqueue(entry: ResourceLaneEntry): void {
    this.assertWritable();
    this.queue.push(entry);
    this.scheduleDrain();
  }

  /** Kick the drain loop (coalesced — the loop picks up everything queued). */
  private scheduleDrain(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.chain = this.chain
      .then(() => this.drainLoop())
      .finally(() => {
        this.pumping = false;
        // A save that raced the loop's empty-queue exit must not sit forever:
        // re-arm when work arrived during the closing window.
        if (this.queue.length > 0) this.scheduleDrain();
      });
  }

  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0 && this.failure === null) {
      const batch = this.queue;
      this.queue = [];
      try {
        await this.writeBatch(batch);
      } catch (error: unknown) {
        // All-or-nothing: the transaction rolled back, PostgreSQL holds
        // NOTHING from this batch. Restore it at the queue head (order
        // preserved), fail closed — save* throws until a flush() re-arms.
        this.queue = [...batch, ...this.queue];
        this.failure = { error };
      }
    }
  }

  /** Read the sticky failure through a method call: defeats the control-flow
   *  narrowing that would otherwise type the post-await check as `never`. */
  private drainFailure(): { readonly error: unknown } | null {
    return this.failure;
  }

  /** Serialize an exclusive operation after all pending drains. */
  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.chain.then(op, op);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private assertBooted(): void {
    if (!this.booted) {
      throw new Error('PGResourceStore is not ready — call ensureReady() before the first use (boot loads the projection from PostgreSQL)');
    }
  }

  private assertWritable(): void {
    this.assertBooted();
    if (this.failure !== null) {
      throw this.failure.error;
    }
  }

  private assertInScope(orgId: Uuid): void {
    if (this.orgScope !== null && this.orgScope !== orgId) {
      throw new PGScopeError(
        'PG_ORG_SCOPE_MISMATCH',
        `this store is scoped to org ${this.orgScope}; refusing a write for org ${orgId} — multi-org isolation is enforced at the adapter`,
      );
    }
  }

  /** Org-less lane values (receivables/payments) require an explicit scope. */
  private requireLaneValueOrg(operation: string): Uuid {
    if (this.orgScope === null) {
      throw new PGScopeError(
        'PG_ORG_SCOPE_REQUIRED',
        `${operation}: the ResourceStore lane value carries no org — a multi-org deployment runs this adapter scoped per org (resources.ts header note); the adapter refuses to invent an org_id for a NOT NULL org-scoped row`,
      );
    }
    return this.orgScope;
  }

  private orgMap<T>(rows: Map<string, Map<string, T>>, orgId: Uuid): Map<string, T> {
    const existing = rows.get(orgId);
    if (existing !== undefined) return existing;
    const created = new Map<string, T>();
    rows.set(orgId, created);
    return created;
  }

  private orgValues<T>(rows: Map<string, Map<string, T>>): readonly T[] {
    if (this.orgScope !== null) {
      return [...(rows.get(this.orgScope)?.values() ?? [])];
    }
    const all: T[] = [];
    for (const orgRows of rows.values()) all.push(...orgRows.values());
    return all;
  }

  // --- internals: the allocator -------------------------------------------------------

  /**
   * The per-org allocator, seeded lazily from the boot counter and the
   * stored cases' high-water mark: reserved-through = max(counter − 1, max
   * stored sequence, high-water this process already handed out).
   */
  private allocatorFor(orgId: Uuid): SequenceAllocator {
    const existing = this.allocators.get(orgId);
    if (existing !== undefined) return existing;
    const counterNext = this.bootCounters.get(orgId);
    let highWater = counterNext === undefined ? 0 : counterNext - 1;
    for (const stored of this.orgMap(this.caseRows, orgId).values()) {
      if (stored.sequence > highWater) highWater = stored.sequence;
    }
    const created: SequenceAllocator = { next: highWater + 1, floor: highWater };
    this.allocators.set(orgId, created);
    return created;
  }

  // --- internals: boot load ------------------------------------------------------------

  private async loadIntoProjection(tx: TxHandle): Promise<PGLoadReport> {
    let scanned = 0;
    let applied = 0;
    let quarantined = 0;
    const scopeParam = this.orgScope;
    const scopeClause = '($1::uuid IS NULL OR org_id = $1::uuid)';

    const receivables = await tx.query(
      'resourcestore.load_receivables',
      `SELECT id::text AS id, org_id::text AS "orgId", invoice_id::text AS "invoiceId",
              customer_id::text AS "customerId", currency, original_minor AS "originalMinor",
              applied_minor AS "appliedMinor", state::text AS state, overdue,
              opened_at AS "openedAt", due_date AS "dueDate", settled_at AS "settledAt",
              voided_at AS "voidedAt", write_off_reason AS "writeOffReason",
              write_off_approved_by AS "writeOffApprovedBy", write_off_at AS "writeOffAt",
              uncollectible_reason AS "uncollectibleReason",
              uncollectible_at AS "uncollectibleAt", recovered_at AS "recoveredAt"
         FROM ${RECEIVABLE_MAP.table}
        WHERE ${scopeClause}`,
      [scopeParam],
    );
    for (const raw of receivables.rows) {
      scanned += 1;
      const result = reviveReceivable(raw);
      if (result.ok) {
        this.orgMap(this.receivableRows, String(raw['orgId']) as Uuid).set(result.row.id, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, RECEIVABLE_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    const payments = await tx.query(
      'resourcestore.load_payments',
      `SELECT id::text AS id, org_id::text AS "orgId", customer_id::text AS "customerId",
              channel::text AS channel, external_ref AS "externalRef",
              idempotency_key AS "idempotencyKey", state::text AS state, currency,
              requested_minor AS "requestedMinor", confirmed_minor AS "confirmedMinor",
              declared_refs AS "declaredRefs", initiated_at AS "initiatedAt",
              confirmed_at AS "confirmedAt", failed_at AS "failedAt",
              failure_code AS "failureCode", reversed_at AS "reversedAt",
              reversal_reason AS "reversalReason"
         FROM ${PAYMENT_MAP.table}
        WHERE ${scopeClause}`,
      [scopeParam],
    );
    for (const raw of payments.rows) {
      scanned += 1;
      const orgId = String(raw['orgId']) as Uuid;
      const paymentId = String(raw['id']);
      const allocations = await tx.query(
        'resourcestore.load_allocations',
        `SELECT id::text AS id, source_payment_id::text AS "paymentId",
                receivable_id::text AS "receivableId", amount_minor AS "amountMinor",
                allocated_at AS "recordedAt"
           FROM ${ALLOCATION_MAP.table}
          WHERE org_id = $1::uuid AND source_type = 'payment' AND source_payment_id = $2::uuid
          ORDER BY sequence_no`,
        [orgId, paymentId],
      );
      const refunds = await tx.query(
        'resourcestore.load_refunds',
        `SELECT id::text AS id, payment_id::text AS "paymentId", reason,
                total_minor AS "amountMinor", created_at AS "recordedAt"
           FROM ${REFUND_MAP.table}
          WHERE org_id = $1::uuid AND payment_id = $2::uuid
          ORDER BY created_at, id`,
        [orgId, paymentId],
      );
      const result = revivePayment(raw, allocations.rows, refunds.rows);
      if (result.ok) {
        this.orgMap(this.paymentRows, orgId).set(result.row.id, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, PAYMENT_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    const cases = await tx.query(
      'resourcestore.load_cases',
      `SELECT id::text AS id, org_id::text AS "orgId", case_number AS "caseNumber",
              priority::text AS priority, status::text AS status,
              owner_id::text AS "collectorId", opened_at AS "openedAt",
              closed_at AS "closedAt", sequence_no AS sequence
         FROM ${CASE_MAP.table}
        WHERE ${scopeClause}`,
      [scopeParam],
    );
    for (const raw of cases.rows) {
      scanned += 1;
      const orgId = String(raw['orgId']) as Uuid;
      const laneStateRows = await tx.query(
        'resourcestore.load_case_lane_state',
        `SELECT opened_by AS "openedBy", closed_by AS "closedBy",
                receivable_ids AS "receivableIds", history,
                priority_changes AS "priorityChanges", actions
           FROM ${CASE_LANE_STATE_MAP.table}
          WHERE org_id = $1::uuid AND case_id = $2::uuid`,
        [orgId, String(raw['id'])],
      );
      // The lane state row is the adapter's authoritative projection of the
      // lane's logs; a case row without it was written by something else, and
      // reconstructing openedBy/history/actions would be fabrication.
      const laneStateRaw = laneStateRows.rows[0];
      if (laneStateRaw === undefined) {
        await this.quarantine(
          tx, CASE_MAP.table, raw,
          'no adapter lane-state row exists for this case (fuatilia_case_lane_state) — the adapter cannot reconstruct openedBy/history/actions without fabricating them',
        );
        quarantined += 1;
        continue;
      }
      const laneState = reviveLaneState(laneStateRaw);
      if (!laneState.ok) {
        await this.quarantine(tx, CASE_LANE_STATE_MAP.table, laneStateRaw, laneState.reason);
        quarantined += 1;
        continue;
      }
      const result = reviveCase(raw, laneState.row);
      if (result.ok) {
        this.orgMap(this.caseRows, orgId).set(result.row.id, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, CASE_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    // The counter rows seed the allocators (never re-issue a committed number).
    const counters = await tx.query(
      'resourcestore.load_case_sequences',
      `SELECT org_id::text AS "orgId", next FROM ${CASE_SEQUENCE.table}
        WHERE ${scopeClause}`,
      [scopeParam],
    );
    for (const row of counters.rows) {
      this.bootCounters.set(String(row['orgId']) as Uuid, Number(row['next']));
    }

    // A scoped store pre-reserves its block INSIDE the boot transaction: the
    // process owns [floor+1, floor+block] before it can hand anything out, so
    // two processes booting against the same org diverge safely.
    if (this.orgScope !== null) {
      const allocator = this.allocatorFor(this.orgScope);
      await this.reserveCaseSequence(tx, this.orgScope, allocator.floor);
      const reserved = await tx.query(
        'resourcestore.boot_reserved',
        `SELECT next FROM ${CASE_SEQUENCE.table} WHERE org_id = $1::uuid`,
        [this.orgScope],
      );
      const next = reserved.rows[0]?.next;
      if (next !== undefined) {
        // Reservation high-water mark only — the cursor keeps its own
        // position inside the freshly reserved block (a fresh org hands out
        // 1, not block+1; see reserveCaseSequence).
        allocator.floor = Math.max(allocator.floor, Number(next) - 1);
      }
    }

    const events = await tx.query(
      'resourcestore.load_events',
      `SELECT event_type AS name, version, aggregate_id AS "aggregateId", payload,
              occurred_at AS "occurredAt"
         FROM ${LANE_EVENT_MAP.table}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid OR org_id IS NULL)
        ORDER BY seq`,
      [scopeParam],
    );
    for (const raw of events.rows) {
      scanned += 1;
      const result = reviveLaneEvent(raw);
      if (result.ok) {
        this.eventLog.push(result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, LANE_EVENT_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    return { scanned, applied, quarantined };
  }

  /** Make a rejected row VISIBLE (the quarantine taxonomy: data loss is never silent). */
  private async quarantine(tx: TxHandle, table: string, raw: Row, reason: string): Promise<void> {
    const rowKey = JSON.stringify({
      id: raw['id'] ?? raw['aggregateId'] ?? null,
      orgId: raw['orgId'] ?? null,
    });
    await tx.query(
      'resourcestore.quarantine',
      `INSERT INTO ${QUARANTINE_TABLE} (${QUARANTINE_COLUMNS.tableName}, ${QUARANTINE_COLUMNS.rowKey}, ${QUARANTINE_COLUMNS.reason}, ${QUARANTINE_COLUMNS.raw})
       VALUES ($1, $2::jsonb, $3, $4::jsonb)`,
      [table, rowKey, reason, JSON.stringify(raw, (_key, value: unknown) => (value instanceof Date ? value.toISOString() : value))],
    );
  }

  // --- internals: the flush batch (ONE transaction) ------------------------------------

  private async writeBatch(batch: readonly ResourceLaneEntry[]): Promise<void> {
    await this.client.withTx(async (tx) => {
      // Coalesce the batch's sequence reservations per org (idempotent and
      // monotone — running the max floor once per org is equivalent to
      // running every entry, and keeps the batch to one advance per org).
      const floors = new Map<string, number>();
      for (const entry of batch) {
        if (entry.kind !== 'sequence') continue;
        const existing = floors.get(entry.orgId);
        floors.set(entry.orgId, Math.max(existing ?? 0, entry.floor));
      }
      for (const [orgId, floor] of floors) {
        await this.reserveCaseSequence(tx, orgId as Uuid, floor);
      }
      for (const entry of batch) {
        switch (entry.kind) {
          case 'receivable':
            await writeReceivable(tx, entry.orgId, entry.row);
            break;
          case 'payment':
            await writePayment(tx, entry.orgId, entry.row);
            break;
          case 'case':
            await writeCase(tx, entry.row);
            break;
          case 'event':
            await appendLaneEvent(tx, entry.orgId, entry.row);
            break;
          case 'sequence':
            break; // coalesced above
        }
      }
    });
  }

  /**
   * The ONLY case-sequence advance primitive. Two server-side statements per
   * org per batch, no application read-modify-write:
   *   1. initialize the row on first use (idempotent — concurrent creators
   *      serialize on the primary key);
   *   2. one UPDATE whose `next = GREATEST(next + block, floor + block)` is
   *      computed under the row lock — it can only move FORWARD, it always
   *      lands past every number this process handed out, and RETURNING
   *      feeds the allocator's reservation high-water mark.
   */
  private async reserveCaseSequence(tx: TxHandle, orgId: Uuid, floor: number): Promise<void> {
    const freshNext = floor + CASE_SEQUENCE_BLOCK;
    await ensureOrgAnchor(tx, orgId);
    await tx.query(
      'resourcestore.case_sequence_init',
      `INSERT INTO ${CASE_SEQUENCE.table} (org_id, next)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId, freshNext],
    );
    const reserved = await tx.query(
      'resourcestore.case_sequence_advance',
      `UPDATE ${CASE_SEQUENCE.table}
          SET next = GREATEST(next + $2::bigint, $3::bigint)
        WHERE org_id = $1::uuid
        RETURNING next`,
      [orgId, CASE_SEQUENCE_BLOCK, freshNext],
    );
    const next = reserved.rows[0]?.next;
    if (next !== undefined) {
      // RETURNING is the reservation high-water mark: every number through
      // next-1 now belongs to this process (or is burned) — no other process
      // will ever hand them out. The hand-out CURSOR itself never jumps:
      // numbers this process has not handed out yet stay inside its own
      // reserved block, so a fresh org's first sequence is 1, not block+1.
      const allocator = this.allocatorFor(orgId);
      allocator.floor = Math.max(allocator.floor, Number(next) - 1);
    }
  }
}

// --- anchors (identity-only rows so composite FKs hold; ON CONFLICT DO NOTHING) ------

const ensureOrgAnchor = async (tx: TxHandle, orgId: string): Promise<void> => {
  await tx.query(
    'resourcestore.anchor_org',
    `INSERT INTO ${ANCHORS.orgs.table} (id, name, slug) VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `${ANCHORS.orgs.namePrefix}${orgId}`, `${ANCHORS.orgs.slugPrefix}${orgId}`],
  );
};

const ensureCustomerAnchor = async (tx: TxHandle, orgId: string, customerId: string): Promise<void> => {
  await tx.query(
    'resourcestore.anchor_customer',
    `INSERT INTO ${ANCHORS.customers.table} (id, org_id, display_name, email)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [customerId, orgId, `${ANCHORS.customers.displayNamePrefix}${customerId}`,
      `${ANCHORS.customers.emailPrefix}${customerId}@${ANCHORS.customers.emailDomain}`],
  );
};

const ensureInvoiceAnchor = async (
  tx: TxHandle,
  orgId: string,
  invoiceId: string,
  customerId: string,
  currency: string,
  totalMinor: bigint,
  dueDate: Date,
): Promise<void> => {
  await tx.query(
    'resourcestore.anchor_invoice',
    `INSERT INTO ${ANCHORS.invoices.table} (id, org_id, customer_id, status, currency, total_minor, due_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::bigint, $7)
     ON CONFLICT (id) DO NOTHING`,
    [invoiceId, orgId, customerId, ANCHORS.invoices.status, currency, totalMinor, iso(dueDate)],
  );
};

/** The structured pre-check: the referenced receivable row must exist. */
const assertReceivableExists = async (tx: TxHandle, orgId: string, receivableId: string): Promise<void> => {
  const found = await tx.query(
    'resourcestore.reference_receivable',
    `SELECT 1 FROM ${RECEIVABLE_MAP.table} WHERE org_id = $1::uuid AND id = $2::uuid`,
    [orgId, receivableId],
  );
  if (found.rows.length === 0) {
    throw new PGReferenceError(RECEIVABLE_MAP.table, receivableId, orgId);
  }
};

// --- batch write statements (queue order; every conflict target is org-composite) ------

const writeReceivable = async (tx: TxHandle, orgId: Uuid, receivable: Receivable): Promise<void> => {
  await ensureOrgAnchor(tx, orgId);
  await ensureCustomerAnchor(tx, orgId, receivable.customerId);
  await ensureInvoiceAnchor(
    tx, orgId, receivable.invoiceId, receivable.customerId, receivable.currency,
    receivable.original.amount, receivable.dueDate,
  );
  await tx.query(
    'resourcestore.save_receivable',
    `INSERT INTO ${RECEIVABLE_MAP.table} (id, org_id, invoice_id, customer_id, currency,
          original_minor, applied_minor, state, overdue, opened_at, due_date, settled_at, voided_at,
          write_off_reason, write_off_approved_by, write_off_at, uncollectible_reason,
          uncollectible_at, recovered_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::bigint, $7::bigint,
          $8::receivable_state, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (org_id, id) DO UPDATE SET
          applied_minor = EXCLUDED.applied_minor, state = EXCLUDED.state, overdue = EXCLUDED.overdue,
          opened_at = EXCLUDED.opened_at, settled_at = EXCLUDED.settled_at, voided_at = EXCLUDED.voided_at,
          write_off_reason = EXCLUDED.write_off_reason, write_off_approved_by = EXCLUDED.write_off_approved_by,
          write_off_at = EXCLUDED.write_off_at, uncollectible_reason = EXCLUDED.uncollectible_reason,
          uncollectible_at = EXCLUDED.uncollectible_at, recovered_at = EXCLUDED.recovered_at`,
    [receivable.id, orgId, receivable.invoiceId, receivable.customerId, receivable.currency,
      receivable.original.amount, receivable.applied.amount, receivable.state, receivable.overdue,
      iso(receivable.openedAt), iso(receivable.dueDate), iso(receivable.settledAt), iso(receivable.voidedAt),
      receivable.writeOff?.reason ?? null, receivable.writeOff?.approvedBy ?? null,
      iso(receivable.writeOff?.writtenOffAt ?? null), receivable.uncollectibleReason,
      iso(receivable.uncollectibleAt), iso(receivable.recoveredAt)],
  );
};

/** The payment row, then its append-only reservation rows (allocations →
 *  0006 under the docs/05 replay key, refunds → 0007 upserted by (org, id)). */
const writePayment = async (tx: TxHandle, orgId: Uuid, payment: Payment): Promise<void> => {
  const carriesConfirmed = (CONFIRMED_FAMILY as readonly string[]).includes(payment.state) || payment.state === 'reversed';
  if (carriesConfirmed && payment.confirmedMinor === undefined) {
    throw new Error(`payment ${payment.id} is '${payment.state}' but carries no confirmedMinor — the lane's transitions never produce this`);
  }
  const unapplied = isConfirmedFamily(payment) ? unappliedMinorOf(payment).amount : null;
  await ensureOrgAnchor(tx, orgId);
  if (payment.customerId !== undefined) await ensureCustomerAnchor(tx, orgId, payment.customerId);
  await tx.query(
    'resourcestore.save_payment',
    `INSERT INTO ${PAYMENT_MAP.table} (id, org_id, customer_id, channel, external_ref,
          idempotency_key, state, currency, requested_minor, confirmed_minor, unapplied_minor,
          declared_refs, initiated_at, confirmed_at, failed_at, failure_code, reversed_at, reversal_reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::payment_channel, $5, $6, $7::payment_state, $8,
          $9::bigint, $10::bigint, $11::bigint, $12::text[], $13, $14, $15, $16, $17, $18)
     ON CONFLICT (org_id, id) DO UPDATE SET
          customer_id = EXCLUDED.customer_id, state = EXCLUDED.state,
          confirmed_minor = EXCLUDED.confirmed_minor, unapplied_minor = EXCLUDED.unapplied_minor,
          declared_refs = EXCLUDED.declared_refs, confirmed_at = EXCLUDED.confirmed_at,
          failed_at = EXCLUDED.failed_at, failure_code = EXCLUDED.failure_code,
          reversed_at = EXCLUDED.reversed_at, reversal_reason = EXCLUDED.reversal_reason`,
    [payment.id, orgId, payment.customerId ?? null, payment.channel, payment.externalRef,
      payment.idempotencyKey, payment.state, payment.currency, payment.requestedMinor.amount,
      payment.confirmedMinor === undefined ? null : payment.confirmedMinor.amount, unapplied,
      [...payment.declaredRefs], iso(payment.initiatedAt), iso(payment.confirmedAt ?? null),
      iso(payment.failedAt ?? null), payment.failureCode ?? null, iso(payment.reversedAt ?? null),
      payment.reversalReason ?? null],
  );
  for (const [index, allocation] of payment.allocations.entries()) {
    await assertReceivableExists(tx, orgId, allocation.receivableId);
    // sequence_no is the allocation's position in the append-only array —
    // deterministic, so replaying the aggregate lands on the same replay key
    // and the conflict arm is a no-op (docs/05 idempotent replay).
    await tx.query(
      'resourcestore.save_allocation',
      `INSERT INTO ${ALLOCATION_MAP.table} (id, org_id, source_type, source_payment_id, source_id,
            receivable_id, amount_minor, currency, strategy, sequence_no, allocated_at)
       VALUES ($1::uuid, $2::uuid, 'payment', $3::uuid, $3::uuid, $4::uuid, $5::bigint, $6,
            'explicit', $7::bigint, $8)
       ON CONFLICT (org_id, source_type, source_id, sequence_no) DO NOTHING`,
      [allocation.id, orgId, payment.id, allocation.receivableId, allocation.amount.amount,
        allocation.amount.currency, index + 1, iso(allocation.recordedAt)],
    );
  }
  for (const refund of payment.refunds) {
    await tx.query(
      'resourcestore.save_refund',
      `INSERT INTO ${REFUND_MAP.table} (id, org_id, payment_id, requested_by, reason, state,
            total_minor, currency)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'requested', $6::bigint, $7)
       ON CONFLICT (org_id, id) DO UPDATE SET
            reason = EXCLUDED.reason, total_minor = EXCLUDED.total_minor`,
      [refund.id, orgId, refund.paymentId, 'payment-lane', refund.reason,
        refund.amount.amount, refund.amount.currency, iso(refund.recordedAt)],
    );
  }
};

const writeCase = async (tx: TxHandle, collectionsCase: CollectionsCase): Promise<void> => {
  const orgId = collectionsCase.orgId;
  await ensureOrgAnchor(tx, orgId);
  await tx.query(
    'resourcestore.save_case',
    `INSERT INTO ${CASE_MAP.table} (id, org_id, case_number, priority, status, owner_id,
          opened_at, closed_at, closed_reason, sequence_no)
     VALUES ($1::uuid, $2::uuid, $3, $4::case_priority, $5::case_status, $6::uuid, $7, $8, NULL, $9::bigint)
     ON CONFLICT (org_id, id) DO UPDATE SET
          priority = EXCLUDED.priority, status = EXCLUDED.status,
          owner_id = EXCLUDED.owner_id, closed_at = EXCLUDED.closed_at`,
    [collectionsCase.id, orgId, collectionsCase.caseNumber, collectionsCase.priority,
      collectionsCase.status, collectionsCase.collectorId, iso(collectionsCase.openedAt),
      iso(collectionsCase.closedAt), collectionsCase.sequence],
  );
  // The lane state projection is the authoritative copy of the lane's logs
  // (action completions revive from here — case_actions is append-only by DDL
  // and could never carry the stamp).
  await tx.query(
    'resourcestore.save_case_lane_state',
    `INSERT INTO ${CASE_LANE_STATE_MAP.table} (org_id, case_id, opened_by, closed_by,
          receivable_ids, history, priority_changes, actions)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb)
     ON CONFLICT (org_id, case_id) DO UPDATE SET
          opened_by = EXCLUDED.opened_by, closed_by = EXCLUDED.closed_by,
          receivable_ids = EXCLUDED.receivable_ids, history = EXCLUDED.history,
          priority_changes = EXCLUDED.priority_changes, actions = EXCLUDED.actions`,
    [orgId, collectionsCase.id, collectionsCase.openedBy, collectionsCase.closedBy,
      JSON.stringify([...collectionsCase.receivableIds]),
      JSON.stringify(collectionsCase.history.map((entry) => ({ ...entry, at: entry.at.toISOString() }))),
      JSON.stringify(collectionsCase.priorityChanges.map((entry) => ({ ...entry, at: entry.at.toISOString() }))),
      JSON.stringify(collectionsCase.actions.map((entry) => ({
        ...entry,
        scheduledFor: entry.scheduledFor.toISOString(),
        recordedAt: entry.recordedAt.toISOString(),
        completedAt: entry.completedAt === null ? null : entry.completedAt.toISOString(),
      })))],
  );
  // The R8 link rows: composite-FK integrity + the one-open-case tripwire.
  for (const receivableId of collectionsCase.receivableIds) {
    await assertReceivableExists(tx, orgId, receivableId);
    await tx.query(
      'resourcestore.save_case_link',
      `INSERT INTO ${CASE_MAP.linkTable} (org_id, case_id, receivable_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid)
       ON CONFLICT (org_id, case_id, receivable_id) DO NOTHING`,
      [orgId, collectionsCase.id, receivableId],
    );
  }
  // The platform's human timeline: the action's INITIAL record, appended
  // exactly once (sequence_no = the entry's position in the lane's
  // append-only log; the completion stamp evolves only in the lane state —
  // the DDL forbids UPDATE here by design).
  for (const [index, action] of collectionsCase.actions.entries()) {
    await tx.query(
      'resourcestore.save_case_action',
      `INSERT INTO ${CASE_MAP.actionsTable} (id, org_id, case_id, actor_id, action, detail,
            performed_at, sequence_no)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8::bigint)
       ON CONFLICT (org_id, case_id, sequence_no) DO NOTHING`,
      [action.id, orgId, collectionsCase.id, action.actorId, action.type,
        JSON.stringify({
          ...action,
          scheduledFor: action.scheduledFor.toISOString(),
          recordedAt: action.recordedAt.toISOString(),
          completedAt: action.completedAt === null ? null : action.completedAt.toISOString(),
        }),
        iso(action.recordedAt), index + 1],
    );
  }
};

const appendLaneEvent = async (tx: TxHandle, orgId: Uuid | null, event: StoredEvent): Promise<void> => {
  await tx.query(
    'resourcestore.record_event',
    `INSERT INTO ${LANE_EVENT_MAP.table} (org_id, event_type, version, aggregate_id, payload,
          status, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)`,
    [orgId, event.name, event.version, event.aggregateId, JSON.stringify(event.payload),
      LANE_EVENT_MAP.status, event.occurredAt],
  );
};
