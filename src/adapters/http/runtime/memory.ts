/**
 * In-memory reference runtime for the HTTP lane (issue #55).
 *
 * This is COMPOSITION, not domain: it adapts the merged auth lane's pure
 * functions (users/roles/assignments/apikeys/sessions/guard) to the two ports
 * the kernel injects —
 *
 *   - `AuthStore`   — the mutable state the /v1/auth admin routes act on,
 *                     plus an append-only event/audit log (`record`);
 *   - `AuthPort`    — the authentication port `middleware/auth.ts` delegates
 *                     to: Bearer session tokens verify via the sessions lane
 *                     (`sessionState` — idle/absolute/revoked semantics are
 *                     the lane's own), `ApiKey <id>.<secret>` verifies via
 *                     the apikeys lane (`authenticateKey` — prefix pick +
 *                     injected hash codec, so verification NEVER stores or
 *                     compares plaintext), and both project to Principals
 *                     via the guard lane.
 *
 * A production deployment replaces this file's stores with databases; the
 * kernel/handlers/middleware stay untouched (that is the adapter seam).
 */
import { createHash } from 'node:crypto';
import {
  authenticateKey,
  issueKey,
  type ApiKey,
} from '../../../domain/auth/apikeys';
import {
  apiKeyPrincipal as projectApiKeyPrincipal,
  userPrincipal as projectUserPrincipal,
  type Principal,
} from '../../../domain/auth/guard';
import { grantRole, type RoleGrant } from '../../../domain/auth/assignments';
import { defineRole, expandRolePermissions, type Role } from '../../../domain/auth/roles';
import {
  openSession,
  revokeSession,
  sessionState,
  type Session,
  type SessionState,
} from '../../../domain/auth/sessions';
import {
  createUser,
  type SecretCodec,
  type User,
  type UserStatus,
} from '../../../domain/auth/user';
import type { AuthEvent, AuthEventName, DenyReason } from '../../../domain/auth/events';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { uuid } from '../../../domain/shared/ids';
import type { AuthPort } from '../middleware/auth';

/** Structural view of the lane envelope — every AuthEvent fits. */
export interface StoredEvent {
  readonly name: string;
  readonly version: 1;
  readonly aggregateId: string;
  readonly payload: unknown;
  readonly occurredAt: string;
}

/**
 * The mutable auth-lane state the /v1/auth routes act on. All getters return
 * fresh copies; saves upsert by aggregate id (revocation flows replace the
 * record — the lane's facts are immutable values).
 */
export interface AuthStore {
  readonly codec: SecretCodec;
  users(): readonly User[];
  roles(): readonly Role[];
  grants(): readonly RoleGrant[];
  keys(): readonly ApiKey[];
  sessions(): readonly Session[];
  saveUser(user: User): void;
  saveRole(role: Role): void;
  saveGrant(grant: RoleGrant): void;
  saveKey(key: ApiKey): void;
  saveSession(session: Session): void;
  /** Append-only event/audit log — domain facts AND audited denials. */
  record(event: StoredEvent): void;
  events(): readonly StoredEvent[];
}

const upsert = <T>(items: T[], item: T, keyOf: (item: T) => string): void => {
  const key = keyOf(item);
  const index = items.findIndex((existing) => keyOf(existing) === key);
  if (index >= 0) items[index] = item;
  else items.push(item);
};

/** In-memory AuthStore — deterministic, no I/O, test-seedable. */
export class InMemoryAuthStore implements AuthStore {
  readonly codec: SecretCodec;

  private readonly userRows: User[] = [];
  private readonly roleRows: Role[] = [];
  private readonly grantRows: RoleGrant[] = [];
  private readonly keyRows: ApiKey[] = [];
  private readonly sessionRows: Session[] = [];
  private readonly eventLog: StoredEvent[] = [];

  constructor(codec: SecretCodec = sha256Codec) {
    this.codec = codec;
  }

  users(): readonly User[] {
    return [...this.userRows];
  }
  roles(): readonly Role[] {
    return [...this.roleRows];
  }
  grants(): readonly RoleGrant[] {
    return [...this.grantRows];
  }
  keys(): readonly ApiKey[] {
    return [...this.keyRows];
  }
  sessions(): readonly Session[] {
    return [...this.sessionRows];
  }
  events(): readonly StoredEvent[] {
    return [...this.eventLog];
  }
  saveUser(user: User): void {
    upsert(this.userRows, user, (u) => u.userId);
  }
  saveRole(role: Role): void {
    upsert(this.roleRows, role, (r) => r.roleId);
  }
  saveGrant(grant: RoleGrant): void {
    upsert(this.grantRows, grant, (g) => g.grantId);
  }
  saveKey(key: ApiKey): void {
    upsert(this.keyRows, key, (k) => k.keyId);
  }
  saveSession(session: Session): void {
    upsert(this.sessionRows, session, (s) => s.sessionId);
  }
  record(event: StoredEvent): void {
    this.eventLog.push(event);
  }
}

/**
 * The reference SecretCodec: SHA-256 over the raw secret. The domain never
 * sees a library — codecs are injected values (SPEC §34: never store
 * plaintext; the ADAPTER owns cryptography).
 */
export const sha256Codec: SecretCodec = {
  hash: (secret) => createHash('sha256').update(secret, 'utf8').digest('hex'),
  verify: (secret, hash) => createHash('sha256').update(secret, 'utf8').digest('hex') === hash,
};

// --- the authentication port over the auth lane -----------------------------------

/** Session-state → stable denial code (mirrors the guard's precedence). */
const SESSION_STATE_CODES: Record<SessionState, DenyReason> = {
  active: 'PRINCIPAL_UNKNOWN', // unreachable — checked before use
  idleExpired: 'SESSION_IDLE_EXPIRED',
  absoluteExpired: 'SESSION_ABSOLUTE_EXPIRED',
  expired: 'SESSION_ABSOLUTE_EXPIRED',
  revoked: 'SESSION_REVOKED',
  ended: 'SESSION_ENDED',
};

const STATUS_CODES: Record<UserStatus, DenyReason> = {
  active: 'PRINCIPAL_UNKNOWN', // unreachable
  suspended: 'PRINCIPAL_SUSPENDED',
  deactivated: 'PRINCIPAL_DEACTIVATED',
};

/**
 * Build the kernel's AuthPort over a store. Bearer tokens ARE session ids in
 * this reference composition; key credentials are `ApiKey <keyId>.<secret>`.
 * Every denial carries the auth lane's stable code (+ its paired
 * `auth.accessDenied` event where the lane produces one).
 */
export const authPortFromStore = (store: AuthStore, clock: Clock): AuthPort => ({
  // Audited denials land in the store's append-only event log (SPEC §37).
  onDenied: (event) => store.record(event),
  sessionPrincipal: (token) => {
    const session = store.sessions().find((s) => s.sessionId === token);
    if (!session) {
      return denial('PRINCIPAL_UNKNOWN', 'no session matches the presented token', null, null, 'unknown');
    }
    const state = sessionState(session, clock);
    if (state !== 'active') {
      const code = SESSION_STATE_CODES[state];
      return denial(code, `session ${session.sessionId} is ${state} — unusable credentials`, session.orgId, session.userId, 'user');
    }
    const user = store.users().find((u) => u.userId === session.userId);
    if (!user) {
      return denial('PRINCIPAL_UNKNOWN', 'no user record matches the session identity', session.orgId, session.userId, 'user');
    }
    if (user.status !== 'active') {
      return denial(STATUS_CODES[user.status], `user ${user.userId} is ${user.status} — principals must be live`, user.orgId, user.userId, 'user');
    }
    const principal = projectUserPrincipal(user, store.grants(), store.roles());
    return { authenticated: true, principal };
  },

  apiKeyPrincipal: (id, secret) => {
    const presented = store.keys().find((k) => k.keyId === id);
    if (!presented) {
      return denial('KEY_UNKNOWN', 'no api key carries the presented id', null, null, 'apiKey');
    }
    const owner = store.users().find((u) => u.userId === presented.createdBy);
    const result = authenticateKey(
      store.keys(),
      { orgId: presented.orgId, secret, ownerStatus: owner ? owner.status : null },
      store.codec,
      clock,
    );
    if (!result.authenticated) {
      return {
        authenticated: false,
        code: result.code,
        message: result.detail,
        reason: result.reason,
        orgId: presented.orgId,
        principalId: presented.keyId,
        principalKind: 'apiKey',
        event: result.event,
      };
    }
    if (result.key.keyId !== presented.keyId) {
      // Belt-and-braces: the wire named a specific id; a prefix collision that
      // verifies against a DIFFERENT key is not an authentication.
      return denial('KEY_UNKNOWN', 'presented id does not match the verified key', presented.orgId, presented.keyId, 'apiKey');
    }
    return { authenticated: true, principal: projectApiKeyPrincipal(result.key) };
  },
});

const denial = (
  code: DenyReason,
  message: string,
  orgId: Uuid | null,
  principalId: Uuid | null,
  principalKind: 'user' | 'apiKey' | 'unknown',
): { authenticated: false; code: string; message: string; reason: DenyReason; orgId: Uuid | null; principalId: Uuid | null; principalKind: 'user' | 'apiKey' | 'unknown'; event: null } => ({
  authenticated: false,
  code,
  message,
  reason: code,
  orgId,
  principalId,
  principalKind,
  event: null,
});

// --- deterministic seeding (tests / local composition) -------------------------------

/** Synthetic, DOCUMENTED, non-production seed secret (never a real credential). */
export const TEST_API_KEY_SECRET = 'fuatilia-local-seed-secret-001';

export interface SeededWorld {
  readonly orgId: Uuid;
  readonly adminUserId: Uuid;
  readonly roleId: Uuid;
  readonly grantId: Uuid;
  /** The Bearer token IS this session id (reference composition). */
  readonly sessionId: Uuid;
  readonly apiKeyId: Uuid;
  readonly apiKeySecret: string;
}

const sequentialUuid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);

/**
 * Seed a minimal admin world through the REAL domain functions (so the event
 * log starts populated and the code paths are the production ones):
 * an org, an admin user, an Admin role (`admin:manage-users` +
 * `receivables:read`), the grant, one live session and one API key.
 */
export function seedWorld(
  store: AuthStore,
  clock: Clock,
  nextId: (n: number) => Uuid = sequentialUuid,
): SeededWorld {
  const orgId = nextId(901);
  const adminUserId = nextId(902);
  const roleId = nextId(903);
  const grantId = nextId(904);
  const sessionId = nextId(905);
  const apiKeyId = nextId(906);

  const { user, event: userEvent } = createUser(
    [],
    {
      userId: adminUserId,
      orgId,
      email: 'admin@fuatilia.test',
      username: 'admin',
      displayName: 'Fuatilia Admin',
    },
    clock,
  );
  store.saveUser(user);
  store.record(userEvent);

  const { role } = defineRole(
    [],
    { roleId, orgId, name: 'Admin', permissions: ['admin:manage-users', 'receivables:read'] },
    clock,
  );
  store.saveRole(role);

  const granted = grantRole(
    [],
    {
      grantId,
      orgId,
      userId: adminUserId,
      role,
      grantedBy: adminUserId,
      granterPermissions: expandRolePermissions(role),
    },
    clock,
  );
  if (!granted.granted) throw new Error('seed grant must succeed');
  store.saveGrant(granted.grant);
  if (granted.event) store.record(granted.event);

  const { session } = openSession(
    { sessionId, userId: adminUserId, orgId, idleTimeoutMs: 30 * 60 * 1000, absoluteTimeoutMs: 8 * 60 * 60 * 1000 },
    clock,
  );
  store.saveSession(session);

  const issued = issueKey(
    [],
    {
      keyId: apiKeyId,
      orgId,
      name: 'seed-key',
      createdBy: adminUserId,
      secret: TEST_API_KEY_SECRET,
      scopes: ['receivables:read'],
    },
    store.codec,
    clock,
  );
  store.saveKey(issued.key);
  store.record(issued.event);

  return { orgId, adminUserId, roleId, grantId, sessionId, apiKeyId, apiKeySecret: TEST_API_KEY_SECRET };
}

export type { AuthEvent, AuthEventName };
export type { Principal };
