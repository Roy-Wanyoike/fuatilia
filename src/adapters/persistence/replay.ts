/**
 * Deterministic replay — the read half of the file-backed AuthStore
 * (issue #61, F32). Pure functions over text: no I/O, no clock, no RNG —
 * the same journal bytes always reduce to the same state.
 *
 * Three responsibilities:
 *
 *   1. `replayJournal` — reduce JSONL journal lines onto row maps. A line
 *      that is corrupt, truncated, blank, unknown-kind or carries a
 *      malformed row is QUARANTINED: counted in the load report, skipped,
 *      never thrown, and never allowed to poison earlier (or later) lines.
 *      The journal is the source of truth, so a quarantine is data loss made
 *      VISIBLE, not silent.
 *
 *   2. `parseSnapshot` — revive a `state.json` snapshot (the boot
 *      optimization). All-or-nothing: one malformed row invalidates the
 *      whole snapshot and the caller falls back to the full journal replay,
 *      which is always sufficient because the journal is append-only.
 *
 *   3. Row revival — JSON rows carry ISO date strings; the store rows carry
 *      `Date` instances. Revival reconstructs the exact row shapes
 *      structurally (no domain re-validation: the writer validated, replay
 *      checks integrity).
 *
 * Sequence discipline: every entry burns its `seq` slot whether or not the
 * row survives revival, so the high-water mark (`lastSeq`) advances across
 * quarantined-but-valid envelopes and appended sequence numbers never
 * collide with history. Lines at or below a snapshot's `lastSeq` are already
 * folded into that snapshot — they count as `lines` but neither `applied`
 * nor `quarantined`.
 */
import type { ApiKey } from '../../domain/auth/apikeys';
import type { RoleGrant } from '../../domain/auth/assignments';
import type { Permission, Role } from '../../domain/auth/roles';
import type { Session } from '../../domain/auth/sessions';
import type { User, UserEmail, Username } from '../../domain/auth/user';
import type { Uuid } from '../../domain/shared/ids';
import type { StoredEvent } from '../http/runtime/memory';
import { isJournalKind, type JournalKind } from './journal';

/**
 * Structural revival has already type-checked the raw string; these casts
 * re-attach the domain's opaque brands (Uuid / UserEmail / Username /
 * Permission) at the single JSON→row boundary.
 */
const asUuid = (value: string): Uuid => value as Uuid;
const asEmail = (value: string): UserEmail => value as UserEmail;
const asUsername = (value: string): Username => value as Username;
const asPermissions = (value: string[]): Permission[] => value as Permission[];

/** Marker string of the snapshot format replay understands (v1). */
export const SNAPSHOT_FORMAT = 'fuatilia.auth-store/1';

/**
 * The boot report: `lines` = journal lines read from disk; `applied` = lines
 * applied onto the state (the journal tail beyond the snapshot); `quarantined`
 * = lines rejected. `lines >= applied + quarantined`; the difference is lines
 * already folded into the snapshot.
 */
export interface LoadReport {
  readonly lines: number;
  readonly applied: number;
  readonly quarantined: number;
}

/** The six AuthStore collections, as maps keyed by aggregate id (events stay a log). */
export interface ReplayState {
  readonly users: Map<string, User>;
  readonly roles: Map<string, Role>;
  readonly grants: Map<string, RoleGrant>;
  readonly keys: Map<string, ApiKey>;
  readonly sessions: Map<string, Session>;
  readonly events: StoredEvent[];
}

export interface ReplayResult {
  readonly state: ReplayState;
  readonly report: LoadReport;
  /** High-water mark: max(minSeq, every valid `seq` seen — quarantined ones included). */
  readonly lastSeq: number;
}

export interface ReplayOptions {
  /** Base state (the revived snapshot) the journal tail is applied onto. */
  readonly base?: ReplayState;
  /** Lines at or below this seq are already folded into `base` — skipped. */
  readonly minSeq?: number;
}

// --- structural helpers ---------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const asDate = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
};

const asArray = (value: unknown): readonly unknown[] | null => (Array.isArray(value) ? value : null);

/** A row field that failed structural revival — the whole row is quarantined. */
class RowFormatError extends Error {}

const requiredString = (row: Record<string, unknown>, key: string): string => {
  const value = asString(row[key]);
  if (value === null) throw new RowFormatError(`row field '${key}' must be a string`);
  return value;
};

const requiredDate = (row: Record<string, unknown>, key: string): Date => {
  const value = asDate(row[key]);
  if (value === null) throw new RowFormatError(`row field '${key}' must be an ISO-8601 date`);
  return value;
};

const nullableString = (row: Record<string, unknown>, key: string): string | null => {
  const raw = row[key];
  if (raw === null) return null;
  const value = asString(raw);
  if (value === null) throw new RowFormatError(`row field '${key}' must be a string or null`);
  return value;
};

const nullableDate = (row: Record<string, unknown>, key: string): Date | null => {
  const raw = row[key];
  if (raw === null) return null;
  const value = asDate(raw);
  if (value === null) throw new RowFormatError(`row field '${key}' must be an ISO-8601 date or null`);
  return value;
};

const requiredStringArray = (row: Record<string, unknown>, key: string): string[] => {
  const raw = row[key];
  if (!Array.isArray(raw)) throw new RowFormatError(`row field '${key}' must be an array`);
  return raw.map((entry) => {
    if (typeof entry !== 'string') throw new RowFormatError(`row field '${key}' must hold strings`);
    return entry;
  });
};

const requiredEnum = <T extends string>(row: Record<string, unknown>, key: string, allowed: readonly T[]): T => {
  const raw = row[key];
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new RowFormatError(`row field '${key}' must be one of ${allowed.join(' | ')}`);
  }
  return raw as T;
};

const requiredPositiveInt = (row: Record<string, unknown>, key: string): number => {
  const raw = row[key];
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new RowFormatError(`row field '${key}' must be a safe positive integer`);
  }
  return raw;
};

// --- row revival (structural, one per AuthStore collection) -----------------------

const USER_STATUSES = ['active', 'suspended', 'deactivated'] as const;
const KEY_STATUSES = ['active', 'revoked'] as const;
const SESSION_STATUSES = ['active', 'ended', 'expired', 'revoked'] as const;

const reviveUser = (raw: unknown): User | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('user row must be an object');
    return {
      userId: asUuid(requiredString(raw, 'userId')),
      orgId: asUuid(requiredString(raw, 'orgId')),
      email: asEmail(requiredString(raw, 'email')),
      username: asUsername(requiredString(raw, 'username')),
      displayName: requiredString(raw, 'displayName'),
      status: requiredEnum(raw, 'status', USER_STATUSES),
      createdAt: requiredDate(raw, 'createdAt'),
      suspendedAt: nullableDate(raw, 'suspendedAt'),
      suspendedReason: nullableString(raw, 'suspendedReason'),
      reactivatedAt: nullableDate(raw, 'reactivatedAt'),
      deactivatedAt: nullableDate(raw, 'deactivatedAt'),
    };
  } catch {
    return null;
  }
};

const reviveRole = (raw: unknown): Role | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('role row must be an object');
    return Object.freeze({
      roleId: asUuid(requiredString(raw, 'roleId')),
      orgId: asUuid(requiredString(raw, 'orgId')),
      name: requiredString(raw, 'name'),
      permissions: Object.freeze(asPermissions(requiredStringArray(raw, 'permissions'))),
      createdAt: requiredDate(raw, 'createdAt'),
    });
  } catch {
    return null;
  }
};

const reviveGrant = (raw: unknown): RoleGrant | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('grant row must be an object');
    return {
      grantId: asUuid(requiredString(raw, 'grantId')),
      orgId: asUuid(requiredString(raw, 'orgId')),
      userId: asUuid(requiredString(raw, 'userId')),
      roleId: asUuid(requiredString(raw, 'roleId')),
      resourceId: nullableString(raw, 'resourceId') === null ? null : asUuid(nullableString(raw, 'resourceId') as string),
      grantedBy: asUuid(requiredString(raw, 'grantedBy')),
      grantedAt: requiredDate(raw, 'grantedAt'),
      revokedAt: nullableDate(raw, 'revokedAt'),
      revokedBy: nullableString(raw, 'revokedBy') === null ? null : asUuid(nullableString(raw, 'revokedBy') as string),
      revokedReason: nullableString(raw, 'revokedReason'),
    };
  } catch {
    return null;
  }
};

const reviveKey = (raw: unknown): ApiKey | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('api key row must be an object');
    return {
      keyId: asUuid(requiredString(raw, 'keyId')),
      orgId: asUuid(requiredString(raw, 'orgId')),
      name: requiredString(raw, 'name'),
      createdBy: asUuid(requiredString(raw, 'createdBy')),
      prefix: requiredString(raw, 'prefix'),
      secretHash: requiredString(raw, 'secretHash'),
      scopes: asPermissions(requiredStringArray(raw, 'scopes')),
      expiresAt: nullableDate(raw, 'expiresAt'),
      status: requiredEnum(raw, 'status', KEY_STATUSES),
      createdAt: requiredDate(raw, 'createdAt'),
      lastUsedAt: nullableDate(raw, 'lastUsedAt'),
      revokedAt: nullableDate(raw, 'revokedAt'),
      revokedBy: nullableString(raw, 'revokedBy') === null ? null : asUuid(nullableString(raw, 'revokedBy') as string),
      revokedReason: nullableString(raw, 'revokedReason'),
    };
  } catch {
    return null;
  }
};

const reviveSession = (raw: unknown): Session | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('session row must be an object');
    return {
      sessionId: asUuid(requiredString(raw, 'sessionId')),
      userId: asUuid(requiredString(raw, 'userId')),
      orgId: asUuid(requiredString(raw, 'orgId')),
      idleTimeoutMs: requiredPositiveInt(raw, 'idleTimeoutMs'),
      absoluteTimeoutMs: requiredPositiveInt(raw, 'absoluteTimeoutMs'),
      status: requiredEnum(raw, 'status', SESSION_STATUSES),
      createdAt: requiredDate(raw, 'createdAt'),
      lastSeenAt: requiredDate(raw, 'lastSeenAt'),
      endedAt: nullableDate(raw, 'endedAt'),
      endedReason: nullableString(raw, 'endedReason'),
    };
  } catch {
    return null;
  }
};

/** Events keep their payload verbatim (already narrow, serializable, id-only). */
const reviveEvent = (raw: unknown): StoredEvent | null => {
  try {
    if (!isPlainObject(raw)) throw new RowFormatError('event row must be an object');
    if (raw['version'] !== 1) throw new RowFormatError('event envelope version must be 1');
    if (!('payload' in raw)) throw new RowFormatError('event envelope requires a payload');
    return {
      name: requiredString(raw, 'name'),
      version: 1,
      aggregateId: asUuid(requiredString(raw, 'aggregateId')),
      payload: raw['payload'],
      occurredAt: requiredDate(raw, 'occurredAt').toISOString(),
    };
  } catch {
    return null;
  }
};

// --- the reducer -----------------------------------------------------------------

/** A fresh (or base-cloned) replay state; the input base is never mutated. */
export const emptyReplayState = (base?: ReplayState): ReplayState => ({
  users: new Map(base?.users ?? []),
  roles: new Map(base?.roles ?? []),
  grants: new Map(base?.grants ?? []),
  keys: new Map(base?.keys ?? []),
  sessions: new Map(base?.sessions ?? []),
  events: [...(base?.events ?? [])],
});

/**
 * Reduce journal text onto state. Deterministic and idempotent: replaying
 * the same bytes twice yields identical state. Evaluation per line, in
 * order: envelope validity (seq/kind/at/row) → snapshot-fold skip →
 * tail monotonicity → row revival → apply (rows upsert by aggregate id —
 * latest fact wins — events append). Every quarantine decision is about the
 * line alone: a bad line never stops the reduction.
 */
export const replayJournal = (raw: string, options: ReplayOptions = {}): ReplayResult => {
  const minSeq = options.minSeq ?? 0;
  const state = emptyReplayState(options.base);
  let lines = 0;
  let applied = 0;
  let quarantined = 0;
  let lastSeq = minSeq;

  const segments = raw.split('\n');
  if (segments[segments.length - 1] === '') segments.pop(); // the commit mark is the newline, not the EOF

  for (const segment of segments) {
    lines += 1;

    const trimmed = segment.trim();
    if (trimmed === '') {
      quarantined += 1; // a blank line is not an event
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(segment);
    } catch {
      quarantined += 1; // corrupt or torn line — the trailing newline is the commit mark
      continue;
    }
    if (!isPlainObject(parsed)) {
      quarantined += 1;
      continue;
    }

    const seqRaw = parsed['seq'];
    if (typeof seqRaw !== 'number' || !Number.isSafeInteger(seqRaw) || seqRaw <= 0) {
      quarantined += 1;
      continue;
    }
    const seq: number = seqRaw;
    const priorHighWater = lastSeq;
    if (seq > lastSeq) lastSeq = seq; // the slot is burned whether or not the row survives

    const kind = parsed['kind'];
    const at = parsed['at'];
    if (!isJournalKind(kind) || !('row' in parsed) || typeof at !== 'string' || Number.isNaN(Date.parse(at))) {
      quarantined += 1; // unknown kind / missing row / bad stamp — keep counting
      continue;
    }

    if (seq <= minSeq) continue; // already folded into the base snapshot — neither applied nor quarantined
    if (seq <= priorHighWater) {
      quarantined += 1; // non-monotonic within the tail (duplicate or reordered seq)
      continue;
    }

    switch (kind) {
      case 'user': {
        const user = reviveUser(parsed['row']);
        if (user === null) quarantined += 1;
        else {
          state.users.set(user.userId, user);
          applied += 1;
        }
        break;
      }
      case 'role': {
        const role = reviveRole(parsed['row']);
        if (role === null) quarantined += 1;
        else {
          state.roles.set(role.roleId, role);
          applied += 1;
        }
        break;
      }
      case 'grant': {
        const grant = reviveGrant(parsed['row']);
        if (grant === null) quarantined += 1;
        else {
          state.grants.set(grant.grantId, grant);
          applied += 1;
        }
        break;
      }
      case 'key': {
        const key = reviveKey(parsed['row']);
        if (key === null) quarantined += 1;
        else {
          state.keys.set(key.keyId, key);
          applied += 1;
        }
        break;
      }
      case 'session': {
        const session = reviveSession(parsed['row']);
        if (session === null) quarantined += 1;
        else {
          state.sessions.set(session.sessionId, session);
          applied += 1;
        }
        break;
      }
      case 'event': {
        const event = reviveEvent(parsed['row']);
        if (event === null) quarantined += 1;
        else {
          state.events.push(event);
          applied += 1;
        }
        break;
      }
    }
  }

  return { state, report: { lines, applied, quarantined }, lastSeq };
};

// --- the snapshot ----------------------------------------------------------------

export interface ParsedSnapshot {
  /** Everything at or below this seq is inside the snapshot. */
  readonly lastSeq: number;
  readonly state: ReplayState;
}

/**
 * Revive a snapshot file's text. All-or-nothing: a snapshot that fails to
 * parse, carries a foreign format marker, or holds one malformed row returns
 * null and the caller falls back to the full journal replay (which is always
 * sufficient — the journal is append-only and the source of truth).
 */
export const parseSnapshot = (raw: string): ParsedSnapshot | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed['format'] !== SNAPSHOT_FORMAT) return null;

  const lastSeq = parsed['lastSeq'];
  if (typeof lastSeq !== 'number' || !Number.isSafeInteger(lastSeq) || lastSeq < 0) return null;
  if (typeof parsed['takenAt'] !== 'string' || Number.isNaN(Date.parse(parsed['takenAt']))) return null;

  const rows = parsed['rows'];
  if (!isPlainObject(rows)) return null;
  const usersRaw = asArray(rows['users']);
  const rolesRaw = asArray(rows['roles']);
  const grantsRaw = asArray(rows['grants']);
  const keysRaw = asArray(rows['keys']);
  const sessionsRaw = asArray(rows['sessions']);
  const eventsRaw = asArray(rows['events']);
  if (usersRaw === null || rolesRaw === null || grantsRaw === null || keysRaw === null || sessionsRaw === null || eventsRaw === null) {
    return null;
  }

  const users: User[] = [];
  const roles: Role[] = [];
  const grants: RoleGrant[] = [];
  const keys: ApiKey[] = [];
  const sessions: Session[] = [];
  const events: StoredEvent[] = [];

  for (const entry of usersRaw) {
    const user = reviveUser(entry);
    if (user === null) return null;
    users.push(user);
  }
  for (const entry of rolesRaw) {
    const role = reviveRole(entry);
    if (role === null) return null;
    roles.push(role);
  }
  for (const entry of grantsRaw) {
    const grant = reviveGrant(entry);
    if (grant === null) return null;
    grants.push(grant);
  }
  for (const entry of keysRaw) {
    const key = reviveKey(entry);
    if (key === null) return null;
    keys.push(key);
  }
  for (const entry of sessionsRaw) {
    const session = reviveSession(entry);
    if (session === null) return null;
    sessions.push(session);
  }
  for (const entry of eventsRaw) {
    const event = reviveEvent(entry);
    if (event === null) return null;
    events.push(event);
  }

  return {
    lastSeq,
    state: {
      users: new Map(users.map((user) => [user.userId, user])),
      roles: new Map(roles.map((role) => [role.roleId, role])),
      grants: new Map(grants.map((grant) => [grant.grantId, grant])),
      keys: new Map(keys.map((key) => [key.keyId, key])),
      sessions: new Map(sessions.map((session) => [session.sessionId, session])),
      events,
    },
  };
};
