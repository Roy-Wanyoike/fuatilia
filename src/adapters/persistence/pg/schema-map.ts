/**
 * The explicit lane-field ↔ column map for the PostgreSQL persistence
 * adapters (issue #73). This module is the SINGLE reviewed place where the
 * HTTP lane's aggregate fields meet the platform schema's columns
 * (db/migrations/0001–0014). The stores build their parameterized SQL column
 * lists from these maps — there is no second, drifting listing.
 *
 * Mapping principles (each deviation below is deliberate and reviewed):
 *
 *   1. Platform tables are the system of record wherever the lane aggregate
 *      carries the full column truth: users/roles/api_keys/sessions (0002),
 *      receivables (0004, with invoice/customer anchors), payments (0005,
 *      with allocations→0006 and refunds→0007), collections_cases (0009,
 *      with case_actions and the R8 link table).
 *   2. Adapter-owned lane tables (`fuatilia_lane_*` + `case_sequences`)
 *      exist ONLY where the platform schema has no honest home for a seam
 *      field — each carries a WHY in the map comments. They are created
 *      idempotently at boot (client.ensureLaneSchema) and never shadow a
 *      platform table.
 *   3. Anchor rows: the seam deals in opaque cross-lane ids. When a lane
 *      aggregate references an entity whose owning lane is not mounted
 *      (orgs, customers, invoices), the adapter registers an IDENTITY-ONLY
 *      anchor row so the composite-FK integrity of the platform schema can
 *      hold. Anchors never overwrite an existing row (ON CONFLICT DO
 *      NOTHING) and are marked so their provenance is self-describing.
 *   4. Money is bigint minor units end to end: the lane's `Money.amount`
 *      travels as a bigint column value, never a float (R10).
 *   5. Structured rejection over fabrication: when a write requires a row
 *      the seam cannot honestly create (e.g. an allocation against a
 *      receivable that was never saved), the write fails with the typed
 *      `PG_LANE_REFERENCE_MISSING` error — the platform FKs make the
 *      cross-lane linkage structurally true or structurally impossible.
 */

import type { ApiKey } from '../../../domain/auth/apikeys';
import type { RoleGrant } from '../../../domain/auth/assignments';
import type { Role } from '../../../domain/auth/roles';
import type { Session } from '../../../domain/auth/sessions';
import type { User } from '../../../domain/auth/user';
import type { StoredEvent } from '../../http/runtime/memory';
import type { Payment } from '../../../domain/payments/payment';
import type { Receivable } from '../../../domain/receivables/receivable';
import type { CollectionsCase } from '../../../domain/collections/case';

// --- the auth lane (migration 0002 + audit_events 0013) --------------------------

/**
 * User → `users` (0002). Every column maps from the aggregate except
 * `password_hash`: the auth-lane seam carries NO password credential (the
 * lane keeps hashes in a separate PasswordRecord the store never sees), but
 * the column is NOT NULL. The adapter persists the empty verifier `''` — a
 * verifier that matches nothing; the login lane owns that column's truth.
 */
export interface UserColumnMap {
  readonly table: 'users';
  readonly columns: {
    userId: 'id';
    orgId: 'org_id';
    email: 'email';
    username: 'username';
    displayName: 'display_name';
    status: 'status';
    suspendedAt: 'suspended_at';
    suspendedReason: 'suspended_reason';
    reactivatedAt: 'reactivated_at';
    deactivatedAt: 'deactivated_at';
    createdAt: 'created_at';
  };
}

/** Role → `roles` (0002). `permissions` maps to the text[] column verbatim. */
export interface RoleColumnMap {
  readonly table: 'roles';
  readonly columns: {
    roleId: 'id';
    orgId: 'org_id';
    name: 'name';
    permissions: 'permissions';
    createdAt: 'created_at';
  };
}

/**
 * RoleGrant → `fuatilia_lane_grants` (adapter-owned). WHY NOT
 * `role_assignments` (0002): that table is an append-only LEDGER of separate
 * grant/revoke FACT rows with a no-self-grant CHECK — a different fact model
 * from this seam, where `saveGrant` UPSERTS by grantId and revocation sets
 * fields ON the fact (assignments.ts), and where self-grants are legal lane
 * outcomes guarded only by the escalation guard (the canonical kernel seed
 * bootstraps the first admin by self-granting). Writing the seam's facts
 * there would either violate the CHECK or require splitting the aggregate
 * across fact rows — both break the "same contracts as the memory store"
 * requirement. The lane table keeps the seam's exact semantics; a future
 * ledger-backed projection can read from it.
 */
export interface GrantColumnMap {
  readonly table: 'fuatilia_lane_grants';
  readonly columns: {
    grantId: 'grant_id';
    orgId: 'org_id';
    userId: 'user_id';
    roleId: 'role_id';
    resourceId: 'resource_id';
    grantedBy: 'granted_by';
    grantedAt: 'granted_at';
    revokedAt: 'revoked_at';
    revokedBy: 'revoked_by';
    revokedReason: 'revoked_reason';
    createdAt: 'created_at';
  };
}

/**
 * ApiKey → `api_keys` (0002). The raw secret NEVER maps anywhere: the row
 * holds `secret_hash` (the SecretCodec's output) and the visible 8-char
 * `prefix` only — the schema has no plaintext column by design and the
 * adapter spec asserts its absence (SPEC §34).
 */
export interface ApiKeyColumnMap {
  readonly table: 'api_keys';
  readonly columns: {
    keyId: 'key_id';
    orgId: 'org_id';
    name: 'name';
    createdBy: 'created_by';
    prefix: 'prefix';
    secretHash: 'secret_hash';
    scopes: 'scopes';
    expiresAt: 'expires_at';
    status: 'status';
    createdAt: 'created_at';
    lastUsedAt: 'last_used_at';
    revokedAt: 'revoked_at';
    revokedBy: 'revoked_by';
    revokedReason: 'revoked_reason';
  };
}

/** Session → `sessions` (0002). status ⇔ ended_at shape is a DB CHECK. */
export interface SessionColumnMap {
  readonly table: 'sessions';
  readonly columns: {
    sessionId: 'session_id';
    orgId: 'org_id';
    userId: 'user_id';
    idleTimeoutMs: 'idle_timeout_ms';
    absoluteTimeoutMs: 'absolute_timeout_ms';
    status: 'status';
    createdAt: 'created_at';
    lastSeenAt: 'last_seen_at';
    endedAt: 'ended_at';
    endedReason: 'ended_reason';
  };
}

/**
 * StoredEvent (auth) → `audit_events` (0013) — the issue's prescribed home
 * for audited denials and every other auth-lane fact. The envelope maps:
 * name→action, aggregateId→resource_id, payload→payload (jsonb), occurredAt
 * →occurred_at; `version` is the constant 1 (the seam's type says so) and is
 * not stored separately. The adapter computes the tamper-evident chain the
 * schema requires (prev_hash/hash over the row, sha256) and derives org from
 * `payload.orgId` when the payload carries one (NULL otherwise — the seam's
 * envelope is org-less; NULL-org events chain on their own NULL-org branch).
 * The actor columns carry the store's own identity ('system'/'auth-store'):
 * the acting principal lives inside the payload, as the lane recorded it.
 */
export interface AuthEventColumnMap {
  readonly table: 'audit_events';
  readonly columns: {
    name: 'action';
    aggregateId: 'resource_id';
    payload: 'payload';
    occurredAt: 'occurred_at';
    orgId: 'org_id';
  };
  readonly resource: 'auth';
  readonly actorType: 'system';
  readonly actorId: 'auth-store';
}

// --- the resource lane (migrations 0004/0005/0006/0007/0009) ----------------------

/**
 * Receivable → `receivables` (0004). The frozen-fields trigger guarantees
 * invoice/customer/currency/original/dueDate never change after creation —
 * exactly the lane's own "frozen at open" discipline, so the upsert's UPDATE
 * arm only touches mutable state. The receivable's invoice + customer get
 * identity-only anchor rows (see ANCHORS below).
 */
export interface ReceivableColumnMap {
  readonly table: 'receivables';
  readonly columns: {
    id: 'id';
    orgId: 'org_id';
    invoiceId: 'invoice_id';
    customerId: 'customer_id';
    currency: 'currency';
    originalMinor: 'original_minor';
    appliedMinor: 'applied_minor';
    state: 'state';
    overdue: 'overdue';
    openedAt: 'opened_at';
    dueDate: 'due_date';
    settledAt: 'settled_at';
    voidedAt: 'voided_at';
    writeOffReason: 'write_off_reason';
    writeOffApprovedBy: 'write_off_approved_by';
    writeOffAt: 'write_off_at';
    uncollectibleReason: 'uncollectible_reason';
    uncollectibleAt: 'uncollectible_at';
    recoveredAt: 'recovered_at';
  };
}

/**
 * Payment → `payments` (0005). All identity fields map 1:1. `unapplied_minor`
 * is the platform's maintained derivation — the adapter writes the lane's own
 * ceiling math (unappliedMinorOf) for confirmed-family states and NULL
 * otherwise, so the stored value and the lane's derivation can never drift.
 */
export interface PaymentColumnMap {
  readonly table: 'payments';
  readonly columns: {
    id: 'id';
    orgId: 'org_id';
    customerId: 'customer_id';
    channel: 'channel';
    externalRef: 'external_ref';
    idempotencyKey: 'idempotency_key';
    state: 'state';
    currency: 'currency';
    requestedMinor: 'requested_minor';
    confirmedMinor: 'confirmed_minor';
    unappliedMinor: 'unapplied_minor';
    declaredRefs: 'declared_refs';
    initiatedAt: 'initiated_at';
    confirmedAt: 'confirmed_at';
    failedAt: 'failed_at';
    failureCode: 'failure_code';
    reversedAt: 'reversed_at';
    reversalReason: 'reversal_reason';
  };
}

/**
 * Payment.allocations → `allocations` (0006), source_type='payment'. The
 * lane's reservation rows carry no sequenceNo — the adapter assigns
 * per-(org, source) `sequence_no = MAX+1` inside the write transaction,
 * which is the idempotent-replay key the schema indexes. `strategy` is
 * 'explicit' (the lane's reservations are caller-directed postings; the
 * strategy engine is unmounted). The target receivable must exist — a
 * missing one is a structured `PG_LANE_REFERENCE_MISSING` rejection, never
 * a fabricated row.
 */
export interface AllocationColumnMap {
  readonly table: 'allocations';
  readonly columns: {
    id: 'id';
    orgId: 'org_id';
    sourcePaymentId: 'source_payment_id';
    receivableId: 'receivable_id';
    amountMinor: 'amount_minor';
    currency: 'currency';
    strategy: 'strategy';
    allocatedAt: 'allocated_at';
  };
  readonly sourceType: 'payment';
  readonly strategy: 'explicit';
}

/**
 * Payment.refunds → `refunds` (0007), state='requested'. The lane's
 * reservation rows carry no requester — `requested_by` records the system
 * actor 'payment-lane' (the adjustments lane's Refund aggregate owns the
 * human identity). R6's COMMIT-time ceiling then holds for the reservation
 * exactly as the lane's recordRefundReservation enforced it.
 */
export interface RefundColumnMap {
  readonly table: 'refunds';
  readonly columns: {
    id: 'id';
    orgId: 'org_id';
    paymentId: 'payment_id';
    reason: 'reason';
    totalMinor: 'total_minor';
    currency: 'currency';
    recordedAt: 'created_at';
  };
  readonly state: 'requested';
  readonly requestedBy: 'payment-lane';
}

/**
 * CollectionsCase → `collections_cases` (0009) + the R8 link table + the
 * append-only `case_actions` + the adapter-owned projection below. The
 * case's `receivableIds` live in BOTH places: the link table carries the
 * composite-FK integrity and the R8 one-open-case guarantee (the DDL face of
 * CASE_ALREADY_OPEN), while the lane projection keeps the array's exact
 * order (the link table has no position column).
 */
export interface CaseColumnMap {
  readonly table: 'collections_cases';
  readonly columns: {
    id: 'id';
    orgId: 'org_id';
    caseNumber: 'case_number';
    priority: 'priority';
    status: 'status';
    ownerId: 'owner_id';
    openedAt: 'opened_at';
    closedAt: 'closed_at';
    closedReason: 'closed_reason';
    sequenceNo: 'sequence_no';
  };
  readonly linkTable: 'collections_case_receivables';
  readonly actionsTable: 'case_actions';
}

/**
 * CollectionsCase.openedBy / actions / history / priorityChanges /
 * receivableIds (ordered) → `fuatilia_case_lane_state` (adapter-owned). WHY:
 * the platform case table has no columns for the lane's audit logs or the
 * opener identity, and `case_actions` is the case's human timeline
 * (append-only, DDL-guarded — `completeAction`'s outcome stamp cannot be
 * UPDATEd into it by design), so folding the lane's evolving logs into it
 * would forge audit entries or lose completions. The projection stores the
 * lane's append-only logs (actions included — the authoritative copy, from
 * which completions revive) as jsonb arrays keyed by (org, case); it is a
 * faithful projection of logs that only ever grow.
 */
export interface CaseLaneStateColumnMap {
  readonly table: 'fuatilia_case_lane_state';
  readonly columns: {
    orgId: 'org_id';
    caseId: 'case_id';
    openedBy: 'opened_by';
    closedBy: 'closed_by';
    receivableIds: 'receivable_ids';
    history: 'history';
    priorityChanges: 'priority_changes';
    actions: 'actions';
  };
}

/**
 * StoredEvent (resource lane) → `fuatilia_lane_events` (adapter-owned,
 * outbox-shaped). WHY NOT `outbox_events` (0013): that table demands a NOT
 * NULL org_id FK, and the lane's structural envelope is org-less. The lane
 * log keeps the outbox shape (event uuid, type, version, payload jsonb,
 * status) with a nullable org derived defensively from `payload.orgId`, plus
 * an IDENTITY seq that gives the append order the interface's `events()`
 * promises. Audited DENIALS do not come through here — they land in the
 * auth store's audit_events chain, as today.
 */
export interface LaneEventColumnMap {
  readonly table: 'fuatilia_lane_events';
  readonly columns: {
    name: 'event_type';
    version: 'version';
    aggregateId: 'aggregate_id';
    payload: 'payload';
    occurredAt: 'occurred_at';
    orgId: 'org_id';
  };
  readonly status: 'pending';
}

/**
 * nextCaseSequence(orgId) → `case_sequences` (adapter-owned — the issue's
 * own prescription; the platform schema has no per-org case counter). The
 * counter advances ONLY via
 *   UPDATE case_sequences SET next = next + $block WHERE org_id = $1
 *   RETURNING next
 * — never read-modify-write. The allocator reserves a BLOCK per org (hi-lo)
 * so the synchronous seam interface can hand out numbers without awaiting a
 * round trip; the first hand-out for an org is optimistic (max stored
 * sequence + 1, exactly the interface's documented derivation) and the
 * asynchronous reservation aligns past it. Uniqueness per org is DDL-enforced
 * twice over: uq_collections_cases_seq, and the counter's own advancement.
 */
export interface CaseSequenceMap {
  readonly table: 'case_sequences';
  readonly columns: {
    orgId: 'org_id';
    next: 'next';
  };
}

/** The per-org reservation block size of the case-sequence allocator. */
export const CASE_SEQUENCE_BLOCK = 64;

// --- anchor rows -----------------------------------------------------------------

/**
 * Anchor rows the adapter registers so composite FKs hold for ids the seam
 * carries opaquely. Every anchor INSERT is `ON CONFLICT DO NOTHING` — an
 * existing row (written by its owning lane) always wins, never gets
 * clobbered. The deterministic markers make anchor provenance visible:
 *   - org:      slug = `org-<uuid>`, name = `org <uuid>`
 *   - customer: display_name = `lane customer <uuid>`, and a NON-ROUTABLE
 *               email `unregistered-<uuid>@lane.invalid` (RFC 2606 reserved
 *               TLD) to satisfy the reachability CHECK without inventing
 *               contact data. msisdn stays NULL.
 *   - invoice:  status stays 'draft' (issuance is the unmounted invoicing
 *               lane's fact), invoice_number NULL, total = the receivable's
 *               frozen original, due_date = the receivable's.
 */
export const ANCHORS = {
  orgs: { table: 'orgs', namePrefix: 'org ', slugPrefix: 'org-' },
  customers: {
    table: 'customers',
    displayNamePrefix: 'lane customer ',
    emailDomain: 'lane.invalid',
    emailPrefix: 'unregistered-',
  },
  invoices: { table: 'invoices', status: 'draft' },
} as const;

// --- the lane tables the adapter owns (created idempotently at boot) --------------

/** Adapter-owned table names (kept as consts for the DDL + registry). */
const GRANT_MAP_TABLE = 'fuatilia_lane_grants';
const CASE_LANE_STATE_TABLE = 'fuatilia_case_lane_state';
const LANE_EVENTS_TABLE = 'fuatilia_lane_events';
const CASE_SEQUENCES_TABLE = 'case_sequences';
export const QUARANTINE_TABLE = 'fuatilia_lane_quarantine';

export const LANE_TABLES = {
  grants: GRANT_MAP_TABLE,
  caseLaneState: CASE_LANE_STATE_TABLE,
  laneEvents: LANE_EVENTS_TABLE,
  caseSequences: CASE_SEQUENCES_TABLE,
  quarantine: QUARANTINE_TABLE,
} as const;

/**
 * The adapter-owned lane tables, in dependency-safe order. Every statement
 * is IF NOT EXISTS — boot on an initialized cluster is a no-op, and a
 * crashed boot simply re-runs.
 */
export const LANE_SCHEMA_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS case_sequences (
       org_id     uuid PRIMARY KEY REFERENCES orgs(id),
       next       bigint      NOT NULL CHECK (next >= 1),
       updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS ${GRANT_MAP_TABLE} (
       grant_id       uuid PRIMARY KEY,
       org_id         uuid        NOT NULL REFERENCES orgs(id),
       user_id        uuid        NOT NULL,
       role_id        uuid        NOT NULL,
       resource_id    uuid,
       granted_by     uuid        NOT NULL,
       granted_at     timestamptz NOT NULL,
       revoked_at     timestamptz,
       revoked_by     uuid,
       revoked_reason text,
       created_at     timestamptz NOT NULL DEFAULT now(),
       updated_at     timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_lane_grants_org_id
       ON ${GRANT_MAP_TABLE} (org_id, grant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_lane_grants_user
       ON ${GRANT_MAP_TABLE} (org_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS ${CASE_LANE_STATE_TABLE} (
       org_id           uuid NOT NULL,
       case_id          uuid NOT NULL,
       opened_by        text        NOT NULL,
       closed_by        text,
       receivable_ids   jsonb       NOT NULL DEFAULT '[]'::jsonb,
       history          jsonb       NOT NULL DEFAULT '[]'::jsonb,
       priority_changes jsonb       NOT NULL DEFAULT '[]'::jsonb,
       actions          jsonb       NOT NULL DEFAULT '[]'::jsonb,
       PRIMARY KEY (org_id, case_id)
   )`,
  // Boot-time migration for clusters where an earlier adapter version created
  // the table without the actions projection (CREATE TABLE IF NOT EXISTS alone
  // would leave the old shape in place).
  `ALTER TABLE ${CASE_LANE_STATE_TABLE} ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `CREATE TABLE IF NOT EXISTS ${LANE_EVENTS_TABLE} (
       seq          bigint GENERATED ALWAYS AS IDENTITY,
       event_id     uuid        NOT NULL DEFAULT gen_random_uuid(),
       org_id       uuid,
       event_type   text        NOT NULL,
       version      integer     NOT NULL DEFAULT 1,
       aggregate_id text        NOT NULL,
       payload      jsonb       NOT NULL,
       status       text        NOT NULL DEFAULT 'pending',
       occurred_at  timestamptz NOT NULL,
       created_at   timestamptz NOT NULL DEFAULT now(),
       CONSTRAINT pk_lane_events PRIMARY KEY (seq),
       CONSTRAINT ck_lane_events_version CHECK (version >= 1),
       CONSTRAINT ck_lane_events_status CHECK (status IN ('pending', 'published', 'poisoned'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_lane_events_org ON ${LANE_EVENTS_TABLE} (org_id, seq)`,
  `CREATE TABLE IF NOT EXISTS ${QUARANTINE_TABLE} (
       seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       table_name     text        NOT NULL,
       row_key        jsonb       NOT NULL,
       reason         text        NOT NULL,
       raw            jsonb       NOT NULL,
       quarantined_at timestamptz NOT NULL DEFAULT now()
   )`,
];

export const QUARANTINE_COLUMNS = {
  tableName: 'table_name',
  rowKey: 'row_key',
  reason: 'reason',
  raw: 'raw',
} as const;

// --- typed map values (the stores iterate these; single source of truth) ----------

export const USER_MAP: UserColumnMap = {
  table: 'users',
  columns: {
    userId: 'id',
    orgId: 'org_id',
    email: 'email',
    username: 'username',
    displayName: 'display_name',
    status: 'status',
    suspendedAt: 'suspended_at',
    suspendedReason: 'suspended_reason',
    reactivatedAt: 'reactivated_at',
    deactivatedAt: 'deactivated_at',
    createdAt: 'created_at',
  },
};

export const ROLE_MAP: RoleColumnMap = {
  table: 'roles',
  columns: { roleId: 'id', orgId: 'org_id', name: 'name', permissions: 'permissions', createdAt: 'created_at' },
};

export const GRANT_MAP: GrantColumnMap = {
  table: GRANT_MAP_TABLE,
  columns: {
    grantId: 'grant_id',
    orgId: 'org_id',
    userId: 'user_id',
    roleId: 'role_id',
    resourceId: 'resource_id',
    grantedBy: 'granted_by',
    grantedAt: 'granted_at',
    revokedAt: 'revoked_at',
    revokedBy: 'revoked_by',
    revokedReason: 'revoked_reason',
    createdAt: 'created_at',
  },
};

export const API_KEY_MAP: ApiKeyColumnMap = {
  table: 'api_keys',
  columns: {
    keyId: 'key_id',
    orgId: 'org_id',
    name: 'name',
    createdBy: 'created_by',
    prefix: 'prefix',
    secretHash: 'secret_hash',
    scopes: 'scopes',
    expiresAt: 'expires_at',
    status: 'status',
    createdAt: 'created_at',
    lastUsedAt: 'last_used_at',
    revokedAt: 'revoked_at',
    revokedBy: 'revoked_by',
    revokedReason: 'revoked_reason',
  },
};

export const SESSION_MAP: SessionColumnMap = {
  table: 'sessions',
  columns: {
    sessionId: 'session_id',
    orgId: 'org_id',
    userId: 'user_id',
    idleTimeoutMs: 'idle_timeout_ms',
    absoluteTimeoutMs: 'absolute_timeout_ms',
    status: 'status',
    createdAt: 'created_at',
    lastSeenAt: 'last_seen_at',
    endedAt: 'ended_at',
    endedReason: 'ended_reason',
  },
};

export const AUTH_EVENT_MAP: AuthEventColumnMap = {
  table: 'audit_events',
  columns: {
    name: 'action',
    aggregateId: 'resource_id',
    payload: 'payload',
    occurredAt: 'occurred_at',
    orgId: 'org_id',
  },
  resource: 'auth',
  actorType: 'system',
  actorId: 'auth-store',
};

export const RECEIVABLE_MAP: ReceivableColumnMap = {
  table: 'receivables',
  columns: {
    id: 'id',
    orgId: 'org_id',
    invoiceId: 'invoice_id',
    customerId: 'customer_id',
    currency: 'currency',
    originalMinor: 'original_minor',
    appliedMinor: 'applied_minor',
    state: 'state',
    overdue: 'overdue',
    openedAt: 'opened_at',
    dueDate: 'due_date',
    settledAt: 'settled_at',
    voidedAt: 'voided_at',
    writeOffReason: 'write_off_reason',
    writeOffApprovedBy: 'write_off_approved_by',
    writeOffAt: 'write_off_at',
    uncollectibleReason: 'uncollectible_reason',
    uncollectibleAt: 'uncollectible_at',
    recoveredAt: 'recovered_at',
  },
};

export const PAYMENT_MAP: PaymentColumnMap = {
  table: 'payments',
  columns: {
    id: 'id',
    orgId: 'org_id',
    customerId: 'customer_id',
    channel: 'channel',
    externalRef: 'external_ref',
    idempotencyKey: 'idempotency_key',
    state: 'state',
    currency: 'currency',
    requestedMinor: 'requested_minor',
    confirmedMinor: 'confirmed_minor',
    unappliedMinor: 'unapplied_minor',
    declaredRefs: 'declared_refs',
    initiatedAt: 'initiated_at',
    confirmedAt: 'confirmed_at',
    failedAt: 'failed_at',
    failureCode: 'failure_code',
    reversedAt: 'reversed_at',
    reversalReason: 'reversal_reason',
  },
};

export const ALLOCATION_MAP: AllocationColumnMap = {
  table: 'allocations',
  columns: {
    id: 'id',
    orgId: 'org_id',
    sourcePaymentId: 'source_payment_id',
    receivableId: 'receivable_id',
    amountMinor: 'amount_minor',
    currency: 'currency',
    strategy: 'strategy',
    allocatedAt: 'allocated_at',
  },
  sourceType: 'payment',
  strategy: 'explicit',
};

export const REFUND_MAP: RefundColumnMap = {
  table: 'refunds',
  columns: {
    id: 'id',
    orgId: 'org_id',
    paymentId: 'payment_id',
    reason: 'reason',
    totalMinor: 'total_minor',
    currency: 'currency',
    recordedAt: 'created_at',
  },
  state: 'requested',
  requestedBy: 'payment-lane',
};

export const CASE_MAP: CaseColumnMap = {
  table: 'collections_cases',
  columns: {
    id: 'id',
    orgId: 'org_id',
    caseNumber: 'case_number',
    priority: 'priority',
    status: 'status',
    ownerId: 'owner_id',
    openedAt: 'opened_at',
    closedAt: 'closed_at',
    closedReason: 'closed_reason',
    sequenceNo: 'sequence_no',
  },
  linkTable: 'collections_case_receivables',
  actionsTable: 'case_actions',
};

export const CASE_LANE_STATE_MAP: CaseLaneStateColumnMap = {
  table: CASE_LANE_STATE_TABLE,
  columns: {
    orgId: 'org_id',
    caseId: 'case_id',
    openedBy: 'opened_by',
    closedBy: 'closed_by',
    receivableIds: 'receivable_ids',
    history: 'history',
    priorityChanges: 'priority_changes',
    actions: 'actions',
  },
};

export const LANE_EVENT_MAP: LaneEventColumnMap = {
  table: LANE_EVENTS_TABLE,
  columns: {
    name: 'event_type',
    version: 'version',
    aggregateId: 'aggregate_id',
    payload: 'payload',
    occurredAt: 'occurred_at',
    orgId: 'org_id',
  },
  status: 'pending',
};

export const CASE_SEQUENCE: CaseSequenceMap = {
  table: CASE_SEQUENCES_TABLE,
  columns: { orgId: 'org_id', next: 'next' },
};

// --- seam mapping registry (the README table + documentation anchor) --------------

/** Aggregate → lane table, the seam-mapping table the README mirrors. */
export const SEAM_MAPPING = {
  'AuthStore.users': USER_MAP.table,
  'AuthStore.roles': ROLE_MAP.table,
  'AuthStore.grants': GRANT_MAP.table,
  'AuthStore.keys': API_KEY_MAP.table,
  'AuthStore.sessions': SESSION_MAP.table,
  'AuthStore.record/events': AUTH_EVENT_MAP.table,
  'ResourceStore.receivables': RECEIVABLE_MAP.table,
  'ResourceStore.payments': PAYMENT_MAP.table,
  'ResourceStore.payments.allocations': ALLOCATION_MAP.table,
  'ResourceStore.payments.refunds': REFUND_MAP.table,
  'ResourceStore.cases': CASE_MAP.table,
  'ResourceStore.cases.laneState': CASE_LANE_STATE_MAP.table,
  'ResourceStore.record/events': LANE_EVENT_MAP.table,
  'ResourceStore.nextCaseSequence': CASE_SEQUENCE.table,
} as const;

/** Structural compile-time proof that every map lines up with its aggregate. */
export type MappedUser = User & { readonly __table: typeof USER_MAP.table };
export type MappedRole = Role & { readonly __table: typeof ROLE_MAP.table };
export type MappedGrant = RoleGrant & { readonly __table: typeof GRANT_MAP.table };
export type MappedApiKey = ApiKey & { readonly __table: typeof API_KEY_MAP.table };
export type MappedSession = Session & { readonly __table: typeof SESSION_MAP.table };
export type MappedAuthEvent = StoredEvent & { readonly __table: typeof AUTH_EVENT_MAP.table };
export type MappedReceivable = Receivable & { readonly __table: typeof RECEIVABLE_MAP.table };
export type MappedPayment = Payment & { readonly __table: typeof PAYMENT_MAP.table };
export type MappedCase = CollectionsCase & { readonly __table: typeof CASE_MAP.table };
