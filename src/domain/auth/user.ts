/**
 * Users & principals — the org-scoped identity records (issue #46, SPEC §34
 * Authentication, §35 "Organization membership").
 *
 * Model:
 *   - a User belongs to exactly one org (org-scoped uniqueness: the same
 *     email/username MAY exist in two orgs — isolation is per org);
 *   - email/username are validated, normalized VALUE types; uniqueness is a
 *     decision the domain makes by scanning the org's existing users;
 *   - status lifecycle `active | suspended | deactivated` (table-driven):
 *
 *       active     → suspended     (suspendUser — the cascade fact)
 *       suspended  → active        (reactivateUser)
 *       active     → deactivated   (deactivateUser — actor's own exit)
 *       suspended  → deactivated   (deactivateUser — never come back)
 *       deactivated→ (terminal — rehiring creates a NEW user record)
 *
 *   - passwords live behind an INJECTED SecretCodec port ({ hash, verify }):
 *     the domain stores the hash it is handed and never sees a library, a
 *     salt, or plaintext at rest (SPEC §34: "Never store plaintext
 *     passwords"). The port returning junk is refused, not stored.
 *
 * Credential mutations (password set) carry no catalog event by design — the
 * issue's event list has none and a hash is not a business fact; the audit
 * story for credentials is the access log. Reactivation/deactivation likewise
 * return the fresh aggregate without a dedicated event (catalog gap, README).
 *
 * Everything is a pure function: no I/O, no RNG, no Date.now(), time only via
 * the injected Clock. Fresh immutable copies — nothing mutates in place.
 */
import { DomainError, type Clock, type Uuid } from '../shared';
import { authEvent, type AuthEvent, type UserCreatedPayload, type UserSuspendedPayload } from './events';

// --- validated identity values ------------------------------------------------

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_SHAPE = /^[a-z0-9](?:[a-z0-9._-]{2,30})$/;

/** Normalized (lowercase, trimmed) email value. */
export type UserEmail = string & { readonly __email: unique symbol };

/** Normalized (lowercase) username value, 3–31 chars `[a-z0-9._-]`. */
export type Username = string & { readonly __username: unique symbol };

export const assertEmail = (raw: string): UserEmail => {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) {
    throw new DomainError('AUTH_EMAIL_MALFORMED', `email '${raw}' is not a valid address`, {
      email: raw,
    });
  }
  return email as UserEmail;
};

export const assertUsername = (raw: string): Username => {
  const username = raw.trim().toLowerCase();
  if (!USERNAME_SHAPE.test(username)) {
    throw new DomainError(
      'AUTH_USERNAME_MALFORMED',
      `username '${raw}' must be 3-31 chars of [a-z0-9._-], starting alphanumeric`,
      { username: raw },
    );
  }
  return username as Username;
};

// --- the aggregate ---------------------------------------------------------------

export type UserStatus = 'active' | 'suspended' | 'deactivated';

export interface User {
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly email: UserEmail;
  readonly username: Username;
  readonly displayName: string;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly suspendedAt: Date | null;
  readonly suspendedReason: string | null;
  readonly reactivatedAt: Date | null;
  readonly deactivatedAt: Date | null;
}

// --- shared input guards -----------------------------------------------------------

export const assertClockDate = (at: Date, code: string): Date => {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new DomainError(code, 'clock returned an invalid Date');
  }
  return at;
};

export const assertNonBlank = (raw: string, code: string, label: string): string => {
  const value = raw.trim();
  if (!value) throw new DomainError(code, `a non-blank ${label} is required`);
  return value;
};

// --- creation ------------------------------------------------------------------------

export interface CreateUserArgs {
  readonly userId: Uuid;
  readonly orgId: Uuid;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
}

/**
 * Create an org-scoped user in status `active`, emitting `auth.userCreated`.
 * Uniqueness is checked ONLY within the org (isolation): pass the org's
 * existing users.
 *
 * Throws:
 *   - AUTH_USER_ID_TAKEN / AUTH_EMAIL_TAKEN / AUTH_USERNAME_TAKEN;
 *   - AUTH_EMAIL_MALFORMED / AUTH_USERNAME_MALFORMED;
 *   - AUTH_DISPLAY_NAME_REQUIRED;
 *   - AUTH_CLOCK_INVALID — broken injected clock.
 */
export function createUser(
  existingUsers: readonly User[],
  args: CreateUserArgs,
  clock: Clock,
): { user: User; event: AuthEvent<'auth.userCreated', UserCreatedPayload> } {
  if (existingUsers.some((u) => u.userId === args.userId)) {
    throw new DomainError('AUTH_USER_ID_TAKEN', `user ${args.userId} already exists`, {
      userId: args.userId,
    });
  }
  const email = assertEmail(args.email);
  const username = assertUsername(args.username);
  const displayName = assertNonBlank(args.displayName, 'AUTH_DISPLAY_NAME_REQUIRED', 'display name');
  if (existingUsers.some((u) => u.orgId === args.orgId && u.email === email)) {
    throw new DomainError('AUTH_EMAIL_TAKEN', `email ${email} is already registered in this org`, {
      email,
    });
  }
  if (existingUsers.some((u) => u.orgId === args.orgId && u.username === username)) {
    throw new DomainError('AUTH_USERNAME_TAKEN', `username '${username}' is already taken in this org`, {
      username,
    });
  }
  const createdAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');

  const user: User = {
    userId: args.userId,
    orgId: args.orgId,
    email,
    username,
    displayName,
    status: 'active',
    createdAt,
    suspendedAt: null,
    suspendedReason: null,
    reactivatedAt: null,
    deactivatedAt: null,
  };
  const payload: UserCreatedPayload = {
    userId: user.userId,
    orgId: user.orgId,
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    createdAt: createdAt.toISOString(),
  };
  return {
    user,
    event: authEvent('auth.userCreated', user.userId, payload, clock),
  };
}

// --- status lifecycle -------------------------------------------------------------------

export interface UserTransitionArgs {
  /** Mandatory audit pair — WHY the status moved, and by whose command. */
  readonly reason: string;
  readonly actorId: string;
}

/**
 * Suspend a user (investigation, offboarding, admin lockout). Emits
 * `auth.userSuspended`; sessions and API keys cascade from this fact
 * (sessions.revokeSessionsForUser + authenticateKey's owner-status check).
 * Legal only from `active` — suspending a deactivated user is a no-op
 * fantasy (AUTH_USER_NOT_ACTIVE).
 */
export function suspendUser(
  user: User,
  args: UserTransitionArgs,
  clock: Clock,
): { user: User; event: AuthEvent<'auth.userSuspended', UserSuspendedPayload> } {
  if (user.status !== 'active') {
    throw new DomainError(
      'AUTH_USER_NOT_ACTIVE',
      `cannot suspend a ${user.status} user — suspension applies to active principals`,
      { userId: user.userId, from: user.status },
    );
  }
  const reason = assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'suspension reason');
  assertNonBlank(args.actorId, 'AUTH_ACTOR_REQUIRED', 'actor id');
  const suspendedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');

  const suspended: User = { ...user, status: 'suspended', suspendedAt, suspendedReason: reason };
  const payload: UserSuspendedPayload = {
    userId: user.userId,
    orgId: user.orgId,
    reason,
    suspendedAt: suspendedAt.toISOString(),
  };
  return { user: suspended, event: authEvent('auth.userSuspended', user.userId, payload, clock) };
}

/**
 * Lift a suspension (suspended → active). Returns the fresh aggregate; the
 * issue's catalog has no `auth.userReactivated` — the status change is the
 * fact (documented gap; the dispatcher owns catalog registration).
 * Legal only from `suspended` (deactivation is terminal).
 */
export function reactivateUser(user: User, args: UserTransitionArgs, clock: Clock): { user: User } {
  if (user.status !== 'suspended') {
    throw new DomainError(
      'AUTH_USER_NOT_ACTIVE',
      `cannot reactivate a ${user.status} user — only a suspended user returns to active`,
      { userId: user.userId, from: user.status },
    );
  }
  assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'reactivation reason');
  assertNonBlank(args.actorId, 'AUTH_ACTOR_REQUIRED', 'actor id');
  const reactivatedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { user: { ...user, status: 'active', reactivatedAt } };
}

/**
 * Deactivate a user (voluntary exit or terminal removal). Terminal: nothing
 * re-opens a deactivated record — rehiring creates a NEW user (fresh ids,
 * fresh history). No catalog event (gap, see README); the status change is
 * the fact.
 */
export function deactivateUser(user: User, args: UserTransitionArgs, clock: Clock): { user: User } {
  if (user.status === 'deactivated') {
    throw new DomainError('AUTH_USER_NOT_ACTIVE', 'cannot deactivate an already deactivated user', {
      userId: user.userId,
      from: user.status,
    });
  }
  assertNonBlank(args.reason, 'AUTH_REASON_REQUIRED', 'deactivation reason');
  assertNonBlank(args.actorId, 'AUTH_ACTOR_REQUIRED', 'actor id');
  const deactivatedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { user: { ...user, status: 'deactivated', deactivatedAt } };
}

// --- password credentials (injected SecretCodec port) -----------------------------------

/**
 * The password/API-key hashing port. The domain owns DECISIONS (min length,
 * when to hash, what to store); the ADAPTER owns cryptography. No crypto
 * library is ever imported here — a SecretCodec is a function parameter.
 */
export interface SecretCodec {
  hash(secret: string): string;
  verify(secret: string, hash: string): boolean;
}

/** Minimum accepted secret length (passwords and API-key secrets alike). */
export const SECRET_MIN_LENGTH = 12;

export interface PasswordRecord {
  readonly userId: Uuid;
  /** Codec output — the domain cannot and does not interpret it. */
  readonly secretHash: string;
  readonly updatedAt: Date;
}

/**
 * Guard the injected codec: both halves must be functions. A broken port is
 * a programming error → AUTH_HASH_PORT_INVALID (never silently stored).
 */
export const assertSecretCodec = (codec: SecretCodec): SecretCodec => {
  if (
    !codec ||
    typeof codec.hash !== 'function' ||
    typeof codec.verify !== 'function'
  ) {
    throw new DomainError(
      'AUTH_HASH_PORT_INVALID',
      'the injected SecretCodec must provide hash() and verify() functions',
    );
  }
  return codec;
};

export const assertSecret = (secret: string): string => {
  if (typeof secret !== 'string' || secret.length < SECRET_MIN_LENGTH) {
    throw new DomainError(
      'AUTH_SECRET_TOO_SHORT',
      `a secret requires at least ${SECRET_MIN_LENGTH} characters`,
    );
  }
  return secret;
};

/**
 * Set (or rotate) a user's password credential: the codec hashes, the domain
 * stores only the hash. No catalog event — a password hash is not a business
 * fact (README). Throws AUTH_SECRET_TOO_SHORT / AUTH_HASH_PORT_INVALID /
 * AUTH_CLOCK_INVALID.
 */
export function recordPassword(
  userId: Uuid,
  args: { readonly secret: string },
  codec: SecretCodec,
  clock: Clock,
): { record: PasswordRecord } {
  assertSecretCodec(codec);
  const secret = assertSecret(args.secret);
  const updatedAt = assertClockDate(clock.now(), 'AUTH_CLOCK_INVALID');
  return { record: { userId, secretHash: codec.hash(secret), updatedAt } };
}

/**
 * Verify a presented password against the stored record. A wrong password is
 * a boolean outcome, not an exception (credential checks are decisions).
 * A missing record verifies false — unknown user ≡ wrong password (no
 * enumeration oracle). Broken codec → AUTH_HASH_PORT_INVALID.
 */
export function verifyPassword(
  record: PasswordRecord | null | undefined,
  presented: string,
  codec: SecretCodec,
): boolean {
  assertSecretCodec(codec);
  if (!record) return false;
  return codec.verify(presented, record.secretHash);
}
