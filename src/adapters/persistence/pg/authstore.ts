/**
 * PGAuthStore — the PostgreSQL implementation of the auth-lane `AuthStore`
 * seam (issue #73), satisfying the EXACT interface of
 * `../../http/runtime/memory.ts` so `createHttpKernel({ store })` mounts it
 * untouched.
 *
 * THE BINDING CONSTRAINT (the design's reason to exist): the AuthStore seam
 * is SYNCHRONOUS — `users(): readonly User[]`, `saveUser(): void`. A direct
 * async pg implementation cannot satisfy it; the first session (a
 * synchronous route handler) would need the answer before any round trip
 * could complete. The file-backed store (../filestore.ts) solved the same
 * constraint with sync fs + a journal; this adapter solves it with a
 * CACHE-FIRST SYNCHRONOUS FACADE over the async pool:
 *
 *   - READS are served from an in-memory PROJECTION of the PostgreSQL rows
 *     (fresh copies, upsert-by-id semantics — identical contracts to the
 *     reference `InMemoryAuthStore`);
 *   - WRITES mutate the projection synchronously AND enqueue a write entry;
 *   - an async FLUSHER persists each enqueued batch in exactly ONE
 *     transaction (`client.withTx`), so PostgreSQL never holds a partial
 *     aggregate — a crashed batch leaves zero rows (server-side rollback);
 *   - `ensureReady()` boots: idempotent lane DDL, then the projection is
 *     reloaded from PostgreSQL. Mutating before a completed boot throws
 *     (fail-loud — blind writes would collide with durable state);
 *   - `flush()` drains the queue (tests and graceful stop) and REJECTS if a
 *     batch could not be committed — fail-closed, never a silent success.
 *
 * Durability window (honesty note, expanded in the README): between a
 * synchronous save and its asynchronous flush commit the change lives only
 * in this process. A crash there loses exactly the un-flushed saves — never
 * a partial row, never a silent divergence: the boot reload re-establishes
 * PostgreSQL's last committed truth.
 *
 * Table discipline comes from `schema-map.ts` (the single reviewed mapping):
 * users/roles/api_keys/sessions are platform tables (0002), events land on
 * the tamper-evident `audit_events` chain (0013 — audited denials included,
 * exactly as today), grants keep the seam's upsert-by-grantId semantics on
 * the adapter-owned `fuatilia_lane_grants`.
 *
 * Org scoping: every statement carries the row's `org_id` and conflicts are
 * inferred on the COMPOSITE (org_id, id) indexes, so a cross-org id
 * collision is a structural failure (PK/index violation), never a silent
 * overwrite. An optional fixed `orgScope` turns this instance into a
 * per-org adapter: reads are filtered to the org, writes outside it are
 * refused — the adapter is exactly where multi-org isolation is enforced
 * (see runtime/resources.ts' header note and isolation.spec.ts).
 *
 * Secret discipline (SPEC §34): rows already hold HASHED secrets upstream
 * (the injected `codec` port); the adapter stores exactly what the rows
 * hold (`secret_hash`) and never adds plaintext — specs assert its absence.
 */
import { createHash } from 'node:crypto';
import type { ApiKey } from '../../../domain/auth/apikeys';
import type { RoleGrant } from '../../../domain/auth/assignments';
import type { Permission, Role } from '../../../domain/auth/roles';
import type { Session } from '../../../domain/auth/sessions';
import type { SecretCodec, User } from '../../../domain/auth/user';
import type { Uuid } from '../../../domain/shared/ids';
import { sha256Codec, type AuthStore, type StoredEvent } from '../../http/runtime/memory';
import type { PGClient, TxHandle } from './client';
import { nullableDate, nullableString, requiredDate, requiredEnum, requiredString,
  requiredStringArray, revival, RowFormatError, type Revival, type Row } from './revive';
import {
  API_KEY_MAP,
  ANCHORS,
  AUTH_EVENT_MAP,
  GRANT_MAP,
  LANE_TABLES,
  QUARANTINE_COLUMNS,
  QUARANTINE_TABLE,
  ROLE_MAP,
  SESSION_MAP,
  USER_MAP,
} from './schema-map';

// --- errors -------------------------------------------------------------------------

/**
 * A sync-seam refusal that is NOT a PostgreSQL failure: an org-scope
 * violation. Thrown synchronously from `save*` (the interface's only error
 * channel) — nothing was mutated, nothing was enqueued.
 */
export class PGScopeError extends Error {
  readonly code: 'PG_ORG_SCOPE_MISMATCH' | 'PG_ORG_SCOPE_REQUIRED';

  constructor(code: PGScopeError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'PGScopeError';
    this.code = code;
  }
}

// --- structural revival (PG row → domain row; mirrors ../replay.ts) -----------------
// The shared accessors live in ./revive.ts; the auth-lane revivers are here,
// beside the column maps they read.

/** Re-attach the domain's opaque brands at the single SQL→row boundary. */
const asUuid = (value: string): Uuid => value as Uuid;
const asEmail = (value: string): User['email'] => value as User['email'];
const asUsername = (value: string): User['username'] => value as User['username'];
const asPermissions = (value: string[]): Permission[] => value as Permission[];

const USER_STATUSES = ['active', 'suspended', 'deactivated'] as const;
const KEY_STATUSES = ['active', 'revoked'] as const;
const SESSION_STATUSES = ['active', 'ended', 'expired', 'revoked'] as const;

const reviveUser = (row: Row): Revival<User> => revival(() => ({
  userId: asUuid(requiredString(row, 'userId')),
  orgId: asUuid(requiredString(row, 'orgId')),
  email: asEmail(requiredString(row, 'email')),
  username: asUsername(requiredString(row, 'username')),
  displayName: requiredString(row, 'displayName'),
  status: requiredEnum(row, 'status', USER_STATUSES),
  createdAt: requiredDate(row, 'createdAt'),
  suspendedAt: nullableDate(row, 'suspendedAt'),
  suspendedReason: nullableString(row, 'suspendedReason'),
  reactivatedAt: nullableDate(row, 'reactivatedAt'),
  deactivatedAt: nullableDate(row, 'deactivatedAt'),
}));

const reviveRole = (row: Row): Revival<Role> => revival(() => ({
  roleId: asUuid(requiredString(row, 'roleId')),
  orgId: asUuid(requiredString(row, 'orgId')),
  name: requiredString(row, 'name'),
  permissions: Object.freeze(asPermissions(requiredStringArray(row, 'permissions'))),
  createdAt: requiredDate(row, 'createdAt'),
}));

const reviveGrant = (row: Row): Revival<RoleGrant> => revival(() => ({
  grantId: asUuid(requiredString(row, 'grantId')),
  orgId: asUuid(requiredString(row, 'orgId')),
  userId: asUuid(requiredString(row, 'userId')),
  roleId: asUuid(requiredString(row, 'roleId')),
  resourceId: nullableString(row, 'resourceId') === null ? null : asUuid(requiredString(row, 'resourceId')),
  grantedBy: asUuid(requiredString(row, 'grantedBy')),
  grantedAt: requiredDate(row, 'grantedAt'),
  revokedAt: nullableDate(row, 'revokedAt'),
  revokedBy: nullableString(row, 'revokedBy') === null ? null : asUuid(requiredString(row, 'revokedBy')),
  revokedReason: nullableString(row, 'revokedReason'),
}));

const reviveKey = (row: Row): Revival<ApiKey> => revival(() => ({
  keyId: asUuid(requiredString(row, 'keyId')),
  orgId: asUuid(requiredString(row, 'orgId')),
  name: requiredString(row, 'name'),
  createdBy: asUuid(requiredString(row, 'createdBy')),
  prefix: requiredString(row, 'prefix'),
  secretHash: requiredString(row, 'secretHash'),
  scopes: asPermissions(requiredStringArray(row, 'scopes')),
  expiresAt: nullableDate(row, 'expiresAt'),
  status: requiredEnum(row, 'status', KEY_STATUSES),
  createdAt: requiredDate(row, 'createdAt'),
  lastUsedAt: nullableDate(row, 'lastUsedAt'),
  revokedAt: nullableDate(row, 'revokedAt'),
  revokedBy: nullableString(row, 'revokedBy') === null ? null : asUuid(requiredString(row, 'revokedBy')),
  revokedReason: nullableString(row, 'revokedReason'),
}));

const reviveSession = (row: Row): Revival<Session> => revival(() => {
  const idleTimeoutMs = Number(row['idleTimeoutMs']);
  const absoluteTimeoutMs = Number(row['absoluteTimeoutMs']);
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new RowFormatError("field 'idleTimeoutMs' must be a safe positive integer");
  }
  if (!Number.isSafeInteger(absoluteTimeoutMs) || absoluteTimeoutMs <= 0) {
    throw new RowFormatError("field 'absoluteTimeoutMs' must be a safe positive integer");
  }
  return {
    sessionId: asUuid(requiredString(row, 'sessionId')),
    userId: asUuid(requiredString(row, 'userId')),
    orgId: asUuid(requiredString(row, 'orgId')),
    idleTimeoutMs,
    absoluteTimeoutMs,
    status: requiredEnum(row, 'status', SESSION_STATUSES),
    createdAt: requiredDate(row, 'createdAt'),
    lastSeenAt: requiredDate(row, 'lastSeenAt'),
    endedAt: nullableDate(row, 'endedAt'),
    endedReason: nullableString(row, 'endedReason'),
  };
});

/**
 * An auth event revives from the chain row: action→name, resource_id→
 * aggregateId, payload jsonb→payload, occurred_at→ISO. `resource_id` is
 * NULLABLE in the DDL (0013) but REQUIRED by the envelope — a NULL row is
 * the canonical "passes DDL, fails the lane" quarantine case.
 */
const reviveAuthEvent = (row: Row): Revival<StoredEvent> => revival(() => {
  const occurredAt = requiredDate(row, 'occurredAt');
  const payload = row['payload'];
  if (typeof payload !== 'object' || payload === null) {
    throw new RowFormatError("field 'payload' must be a jsonb object");
  }
  return {
    name: requiredString(row, 'name'),
    version: 1 as const,
    aggregateId: requiredString(row, 'aggregateId'),
    payload,
    occurredAt: occurredAt.toISOString(),
  };
});

// --- the boot report ------------------------------------------------------------------

/**
 * The boot report (mirrors ../replay.ts' LoadReport): `scanned` = rows read
 * from PostgreSQL, `applied` = rows revived into the projection,
 * `quarantined` = rows written to `fuatilia_lane_quarantine` and skipped.
 * The same bytes always reduce to the same state (deterministic revival).
 */
export interface PGLoadReport {
  readonly scanned: number;
  readonly applied: number;
  readonly quarantined: number;
}

// --- the write queue -----------------------------------------------------------------

/** One enqueued mutation — persisted by the flusher, in queue order. */
type AuthLaneEntry =
  | { readonly kind: 'user'; readonly row: User }
  | { readonly kind: 'role'; readonly row: Role }
  | { readonly kind: 'grant'; readonly row: RoleGrant }
  | { readonly kind: 'key'; readonly row: ApiKey }
  | { readonly kind: 'session'; readonly row: Session }
  | { readonly kind: 'event'; readonly row: StoredEvent };

/**
 * Canonical JSON: recursively key-sorted serialization. The hash chain is
 * computed over THIS form, so a verifier reading the payload back from the
 * jsonb column (PostgreSQL re-renders jsonb text its own way) recomputes
 * the identical hash from the identical STRUCTURE.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

// --- the store ------------------------------------------------------------------------

export interface PGAuthStoreOptions {
  /** Secret codec (default: the reference SHA-256 codec). Rows hold its output. */
  readonly codec?: SecretCodec;
  /**
   * Fixed org scope: when set, this instance is a PER-ORG adapter — reads
   * are filtered to the org and writes for any other org are refused
   * (PG_ORG_SCOPE_MISMATCH). Absent: process-global multi-tenant semantics,
   * exactly like the reference store.
   */
  readonly orgScope?: Uuid;
}

export class PGAuthStore implements AuthStore {
  readonly codec: SecretCodec;
  private readonly client: PGClient;
  private readonly orgScope: Uuid | null;

  private readonly userRows = new Map<string, User>();
  private readonly roleRows = new Map<string, Role>();
  private readonly grantRows = new Map<string, RoleGrant>();
  private readonly keyRows = new Map<string, ApiKey>();
  private readonly sessionRows = new Map<string, Session>();
  private eventLog: StoredEvent[] = [];

  /** The write queue: mutations accepted but not yet committed to PostgreSQL. */
  private queue: AuthLaneEntry[] = [];
  /** Serialized drain operations (never interleave batches). */
  private chain: Promise<void> = Promise.resolve();
  private pumping = false;
  /** First failed batch — sticky: `save*` throws until a `flush()` re-arms. */
  private failure: { readonly error: unknown } | null = null;
  /** Boot guard: mutations before a completed ensureReady() are a programming error. */
  private booted = false;

  constructor(client: PGClient, options: PGAuthStoreOptions = {}) {
    this.client = client;
    this.codec = options.codec ?? sha256Codec;
    this.orgScope = options.orgScope ?? null;
  }

  // --- boot / durability ----------------------------------------------------------------

  /**
   * Boot (or re-boot): run the adapter's idempotent lane DDL, then reload
   * the projection from PostgreSQL inside ONE transaction; rows that fail
   * structural revival are QUARANTINED (visible, counted, skipped — never
   * thrown, never allowed to poison the boot). Pending writes (a re-boot
   * over a live instance) are flushed first so the reload never rolls back
   * over uncommitted work.
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
   * scrubbed store error. Drains never run between boot attempts.
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

  // --- the AuthStore seam (synchronous reads, enqueued writes) ---------------------------

  users(): readonly User[] {
    return [...this.userRows.values()].filter((user) => this.inScope(user.orgId));
  }

  roles(): readonly Role[] {
    return [...this.roleRows.values()].filter((role) => this.inScope(role.orgId));
  }

  grants(): readonly RoleGrant[] {
    return [...this.grantRows.values()].filter((grant) => this.inScope(grant.orgId));
  }

  keys(): readonly ApiKey[] {
    return [...this.keyRows.values()].filter((key) => this.inScope(key.orgId));
  }

  sessions(): readonly Session[] {
    return [...this.sessionRows.values()].filter((session) => this.inScope(session.orgId));
  }

  events(): readonly StoredEvent[] {
    return [...this.eventLog];
  }

  // Every save* checks writability BEFORE touching the projection: a save
  // refused by the sticky failure mutates NOTHING and enqueues NOTHING —
  // the projection never diverges from what the flusher will persist.
  saveUser(user: User): void {
    this.assertWritable();
    this.assertInScope(user.orgId);
    this.userRows.set(user.userId, user);
    this.enqueue({ kind: 'user', row: user });
  }

  saveRole(role: Role): void {
    this.assertWritable();
    this.assertInScope(role.orgId);
    this.roleRows.set(role.roleId, role);
    this.enqueue({ kind: 'role', row: role });
  }

  saveGrant(grant: RoleGrant): void {
    this.assertWritable();
    this.assertInScope(grant.orgId);
    this.grantRows.set(grant.grantId, grant);
    this.enqueue({ kind: 'grant', row: grant });
  }

  saveKey(key: ApiKey): void {
    this.assertWritable();
    this.assertInScope(key.orgId);
    this.keyRows.set(key.keyId, key);
    this.enqueue({ kind: 'key', row: key });
  }

  saveSession(session: Session): void {
    this.assertWritable();
    this.assertInScope(session.orgId);
    this.sessionRows.set(session.sessionId, session);
    this.enqueue({ kind: 'session', row: session });
  }

  /**
   * Append one event to the tamper-evident `audit_events` chain (audited
   * denials included, exactly as today). The org comes from `payload.orgId`
   * when the payload carries one; org-less events chain on their own
   * NULL-org branch (audit_events.org_id carries no FK — no anchor needed).
   */
  record(event: StoredEvent): void {
    this.assertWritable();
    const orgId = orgFromPayload(event.payload);
    if (orgId !== null) this.assertInScope(orgId);
    this.eventLog.push(event);
    this.enqueue({ kind: 'event', row: event });
  }

  // --- internals: queue discipline ---------------------------------------------------

  private enqueue(entry: AuthLaneEntry): void {
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
      throw new Error('PGAuthStore is not ready — call ensureReady() before the first use (boot loads the projection from PostgreSQL)');
    }
  }

  private assertWritable(): void {
    this.assertBooted();
    if (this.failure !== null) {
      throw this.failure.error;
    }
  }

  private inScope(orgId: Uuid): boolean {
    return this.orgScope === null || this.orgScope === orgId;
  }

  private assertInScope(orgId: Uuid): void {
    if (this.orgScope !== null && this.orgScope !== orgId) {
      throw new PGScopeError(
        'PG_ORG_SCOPE_MISMATCH',
        `this store is scoped to org ${this.orgScope}; refusing a write for org ${orgId} — multi-org isolation is enforced at the adapter`,
      );
    }
  }

  // --- internals: boot load ------------------------------------------------------------

  private async loadIntoProjection(tx: TxHandle): Promise<PGLoadReport> {
    let scanned = 0;
    let applied = 0;
    let quarantined = 0;
    const scopeParam = this.orgScope;

    const users = await tx.query(
      'authstore.load_users',
      `SELECT id::text AS "userId", org_id::text AS "orgId", email, username, display_name AS "displayName",
              status::text AS status, created_at AS "createdAt", suspended_at AS "suspendedAt",
              suspended_reason AS "suspendedReason", reactivated_at AS "reactivatedAt",
              deactivated_at AS "deactivatedAt"
         FROM ${USER_MAP.table}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)`,
      [scopeParam],
    );
    for (const raw of users.rows) {
      scanned += 1;
      const result = reviveUser(raw);
      if (result.ok) {
        this.userRows.set(result.row.userId, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, USER_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    const roles = await tx.query(
      'authstore.load_roles',
      `SELECT id::text AS "roleId", org_id::text AS "orgId", name, permissions, created_at AS "createdAt"
         FROM ${ROLE_MAP.table}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)`,
      [scopeParam],
    );
    for (const raw of roles.rows) {
      scanned += 1;
      const result = reviveRole(raw);
      if (result.ok) {
        this.roleRows.set(result.row.roleId, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, ROLE_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    const grants = await tx.query(
      'authstore.load_grants',
      `SELECT grant_id::text AS "grantId", org_id::text AS "orgId", user_id::text AS "userId",
              role_id::text AS "roleId", resource_id::text AS "resourceId", granted_by::text AS "grantedBy",
              granted_at AS "grantedAt", revoked_at AS "revokedAt", revoked_by::text AS "revokedBy",
              revoked_reason AS "revokedReason"
         FROM ${LANE_TABLES.grants}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)`,
      [scopeParam],
    );
    for (const raw of grants.rows) {
      scanned += 1;
      const result = reviveGrant(raw);
      if (result.ok) {
        this.grantRows.set(result.row.grantId, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, LANE_TABLES.grants, raw, result.reason);
        quarantined += 1;
      }
    }

    const keys = await tx.query(
      'authstore.load_keys',
      `SELECT key_id::text AS "keyId", org_id::text AS "orgId", name, created_by::text AS "createdBy",
              prefix, secret_hash AS "secretHash", scopes, expires_at AS "expiresAt", status::text AS status,
              created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt",
              revoked_by::text AS "revokedBy", revoked_reason AS "revokedReason"
         FROM ${API_KEY_MAP.table}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)`,
      [scopeParam],
    );
    for (const raw of keys.rows) {
      scanned += 1;
      const result = reviveKey(raw);
      if (result.ok) {
        this.keyRows.set(result.row.keyId, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, API_KEY_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    const sessions = await tx.query(
      'authstore.load_sessions',
      `SELECT session_id::text AS "sessionId", org_id::text AS "orgId", user_id::text AS "userId",
              idle_timeout_ms AS "idleTimeoutMs", absolute_timeout_ms AS "absoluteTimeoutMs",
              status::text AS status, created_at AS "createdAt", last_seen_at AS "lastSeenAt",
              ended_at AS "endedAt", ended_reason AS "endedReason"
         FROM ${SESSION_MAP.table}
        WHERE ($1::uuid IS NULL OR org_id = $1::uuid)`,
      [scopeParam],
    );
    for (const raw of sessions.rows) {
      scanned += 1;
      const result = reviveSession(raw);
      if (result.ok) {
        this.sessionRows.set(result.row.sessionId, result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, SESSION_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    // The auth lane's events: only rows the lane itself wrote (resource='auth');
    // org-less rows are the lane's structural facts and belong to every scope.
    const events = await tx.query(
      'authstore.load_events',
      `SELECT action AS name, resource_id AS "aggregateId", payload, occurred_at AS "occurredAt"
         FROM ${AUTH_EVENT_MAP.table}
        WHERE resource = $2
          AND ($1::uuid IS NULL OR org_id = $1::uuid OR org_id IS NULL)
        ORDER BY occurred_at, org_id NULLS LAST, seq`,
      [scopeParam, AUTH_EVENT_MAP.resource],
    );
    for (const raw of events.rows) {
      scanned += 1;
      const result = reviveAuthEvent(raw);
      if (result.ok) {
        this.eventLog.push(result.row);
        applied += 1;
      } else {
        await this.quarantine(tx, AUTH_EVENT_MAP.table, raw, result.reason);
        quarantined += 1;
      }
    }

    return { scanned, applied, quarantined };
  }

  /** Make a rejected row VISIBLE (the quarantine taxonomy: data loss is never silent). */
  private async quarantine(tx: TxHandle, table: string, raw: Row, reason: string): Promise<void> {
    const rowKey = JSON.stringify({
      id: raw['userId'] ?? raw['roleId'] ?? raw['grantId'] ?? raw['keyId'] ?? raw['sessionId'] ?? raw['aggregateId'] ?? null,
      orgId: raw['orgId'] ?? null,
    });
    await tx.query(
      'authstore.quarantine',
      `INSERT INTO ${QUARANTINE_TABLE} (${QUARANTINE_COLUMNS.tableName}, ${QUARANTINE_COLUMNS.rowKey}, ${QUARANTINE_COLUMNS.reason}, ${QUARANTINE_COLUMNS.raw})
       VALUES ($1, $2::jsonb, $3, $4::jsonb)`,
      [table, rowKey, reason, JSON.stringify(raw, (_key, value: unknown) => (value instanceof Date ? value.toISOString() : value))],
    );
  }

  // --- internals: the flush batch (ONE transaction) ------------------------------------

  private async writeBatch(batch: readonly AuthLaneEntry[]): Promise<void> {
    await this.client.withTx(async (tx) => {
      for (const entry of batch) {
        switch (entry.kind) {
          case 'user':
            await writeUser(tx, entry.row);
            break;
          case 'role':
            await writeRole(tx, entry.row);
            break;
          case 'grant':
            await writeGrant(tx, entry.row);
            break;
          case 'key':
            await writeKey(tx, entry.row);
            break;
          case 'session':
            await writeSession(tx, entry.row);
            break;
          case 'event':
            await appendAuthEvent(tx, entry.row);
            break;
        }
      }
    });
  }
}

// --- org derivation ----------------------------------------------------------------

/** The org an event belongs to, derived defensively from `payload.orgId`. */
export const orgFromPayload = (payload: unknown): Uuid | null => {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = (payload as { readonly orgId?: unknown }).orgId;
  return typeof candidate === 'string' && candidate !== '' ? (candidate as Uuid) : null;
};

// --- batch write statements (queue order; every conflict target is org-composite) ----

const iso = (value: Date | null | undefined): string | null =>
  value === null || value === undefined ? null : value.toISOString();

/**
 * The org anchor: an identity-only orgs row so the composite FKs hold for
 * ids the seam carries opaquely. ON CONFLICT DO NOTHING — a real org row
 * (its owning lane's truth) always wins, never gets clobbered.
 */
const ensureOrgAnchor = async (tx: TxHandle, orgId: string): Promise<void> => {
  await tx.query(
    'authstore.anchor_org',
    `INSERT INTO ${ANCHORS.orgs.table} (id, name, slug) VALUES ($1::uuid, $2, $3)
     ON CONFLICT (id) DO NOTHING`,
    [orgId, `${ANCHORS.orgs.namePrefix}${orgId}`, `${ANCHORS.orgs.slugPrefix}${orgId}`],
  );
};

const writeUser = async (tx: TxHandle, user: User): Promise<void> => {
  await ensureOrgAnchor(tx, user.orgId);
  await tx.query(
    'authstore.save_user',
    `INSERT INTO ${USER_MAP.table} (id, org_id, email, username, display_name, status, password_hash,
          suspended_at, suspended_reason, reactivated_at, deactivated_at, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::user_status, '', $7, $8, $9, $10, $11)
     ON CONFLICT (org_id, id) DO UPDATE SET
          email = EXCLUDED.email, username = EXCLUDED.username,
          display_name = EXCLUDED.display_name, status = EXCLUDED.status,
          suspended_at = EXCLUDED.suspended_at, suspended_reason = EXCLUDED.suspended_reason,
          reactivated_at = EXCLUDED.reactivated_at, deactivated_at = EXCLUDED.deactivated_at`,
    [user.userId, user.orgId, user.email, user.username, user.displayName, user.status,
      iso(user.suspendedAt), user.suspendedReason, iso(user.reactivatedAt), iso(user.deactivatedAt),
      iso(user.createdAt)],
  );
};

const writeRole = async (tx: TxHandle, role: Role): Promise<void> => {
  await ensureOrgAnchor(tx, role.orgId);
  await tx.query(
    'authstore.save_role',
    `INSERT INTO ${ROLE_MAP.table} (id, org_id, name, permissions, created_at)
     VALUES ($1::uuid, $2::uuid, $3, $4::text[], $5)
     ON CONFLICT (org_id, id) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions`,
    [role.roleId, role.orgId, role.name, [...role.permissions], iso(role.createdAt)],
  );
};

const writeGrant = async (tx: TxHandle, grant: RoleGrant): Promise<void> => {
  await ensureOrgAnchor(tx, grant.orgId);
  await tx.query(
    'authstore.save_grant',
    `INSERT INTO ${LANE_TABLES.grants} (grant_id, org_id, user_id, role_id, resource_id,
          granted_by, granted_at, revoked_at, revoked_by, revoked_reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, $8, $9::uuid, $10)
     ON CONFLICT (org_id, grant_id) DO UPDATE SET
          user_id = EXCLUDED.user_id, role_id = EXCLUDED.role_id, resource_id = EXCLUDED.resource_id,
          granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at,
          revoked_at = EXCLUDED.revoked_at, revoked_by = EXCLUDED.revoked_by,
          revoked_reason = EXCLUDED.revoked_reason`,
    [grant.grantId, grant.orgId, grant.userId, grant.roleId, grant.resourceId,
      grant.grantedBy, iso(grant.grantedAt), iso(grant.revokedAt),
      grant.revokedBy, grant.revokedReason],
  );
};

const writeKey = async (tx: TxHandle, key: ApiKey): Promise<void> => {
  await ensureOrgAnchor(tx, key.orgId);
  // The row holds ONLY the codec's hash + the visible prefix — no plaintext
  // column exists, and none is fabricated (SPEC §34).
  await tx.query(
    'authstore.save_key',
    `INSERT INTO ${API_KEY_MAP.table} (key_id, org_id, name, created_by, prefix, secret_hash, scopes,
          expires_at, status, created_at, last_used_at, revoked_at, revoked_by, revoked_reason)
     VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, $7::text[], $8, $9::api_key_status, $10, $11, $12, $13::uuid, $14)
     ON CONFLICT (org_id, key_id) DO UPDATE SET
          name = EXCLUDED.name, scopes = EXCLUDED.scopes, expires_at = EXCLUDED.expires_at,
          status = EXCLUDED.status, last_used_at = EXCLUDED.last_used_at,
          revoked_at = EXCLUDED.revoked_at, revoked_by = EXCLUDED.revoked_by,
          revoked_reason = EXCLUDED.revoked_reason`,
    [key.keyId, key.orgId, key.name, key.createdBy, key.prefix, key.secretHash, [...key.scopes],
      iso(key.expiresAt), key.status, iso(key.createdAt), iso(key.lastUsedAt),
      iso(key.revokedAt), key.revokedBy, key.revokedReason],
  );
};

const writeSession = async (tx: TxHandle, session: Session): Promise<void> => {
  await ensureOrgAnchor(tx, session.orgId);
  await tx.query(
    'authstore.save_session',
    `INSERT INTO ${SESSION_MAP.table} (session_id, org_id, user_id, idle_timeout_ms, absolute_timeout_ms,
          status, created_at, last_seen_at, ended_at, ended_reason)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::session_status, $7, $8, $9, $10)
     ON CONFLICT (org_id, session_id) DO UPDATE SET
          user_id = EXCLUDED.user_id, idle_timeout_ms = EXCLUDED.idle_timeout_ms,
          absolute_timeout_ms = EXCLUDED.absolute_timeout_ms, status = EXCLUDED.status,
          last_seen_at = EXCLUDED.last_seen_at, ended_at = EXCLUDED.ended_at,
          ended_reason = EXCLUDED.ended_reason`,
    [session.sessionId, session.orgId, session.userId, session.idleTimeoutMs,
      session.absoluteTimeoutMs, session.status, iso(session.createdAt),
      iso(session.lastSeenAt), iso(session.endedAt), session.endedReason],
  );
};

/**
 * Append one StoredEvent to the audit chain. The per-org branch's
 * (seq, prev_hash, hash) is computed under a per-org advisory TRANSACTION
 * lock — concurrent recorders serialize, the chain stays continuous (that
 * continuity IS the tamper evidence, SPEC §37). The hash is over the
 * canonical JSON form (see canonicalJson) so verification recomputes
 * identically from the jsonb read-back.
 */
const appendAuthEvent = async (tx: TxHandle, event: StoredEvent): Promise<void> => {
  const orgId = orgFromPayload(event.payload);
  await tx.query(
    'authstore.chain_lock',
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [orgId ?? 'null-org-branch'],
  );
  const prev = await tx.query(
    'authstore.chain_prev',
    `SELECT seq, hash FROM ${AUTH_EVENT_MAP.table}
      WHERE org_id IS NOT DISTINCT FROM $1::uuid
      ORDER BY seq DESC LIMIT 1`,
    [orgId],
  );
  const prevSeq = prev.rows.length > 0 ? Number(prev.rows[0]?.seq) : 0;
  const prevHash = prev.rows.length > 0 ? String(prev.rows[0]?.hash) : '0'.repeat(64);
  const seq = prevSeq + 1;
  const hash = createHash('sha256')
    .update(
      `${seq}|${prevHash}|${AUTH_EVENT_MAP.resource}|${event.name}|${event.aggregateId}|` +
      `${canonicalJson(event.payload)}|${event.occurredAt}`,
    )
    .digest('hex');
  await tx.query(
    'authstore.record_event',
    `INSERT INTO ${AUTH_EVENT_MAP.table}
          (org_id, actor_type, actor_id, action, resource, resource_id, payload, seq, prev_hash, hash, occurred_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [orgId, AUTH_EVENT_MAP.actorType, AUTH_EVENT_MAP.actorId, event.name, AUTH_EVENT_MAP.resource,
      event.aggregateId, canonicalJson(event.payload), seq, prevHash, hash, event.occurredAt],
  );
};
