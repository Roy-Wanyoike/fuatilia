import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  SECRET_MIN_LENGTH,
  createUser,
  deactivateUser,
  reactivateUser,
  recordPassword,
  suspendUser,
  verifyPassword,
  type SecretCodec,
  type User,
} from './user';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(101);
const OTHER_ORG = uid(102);
const USER = uid(110);

const T0 = '2026-01-15T09:00:00.000Z';
const T1 = '2026-01-15T09:05:00.000Z';
const at = (iso: string): Clock => ({ now: () => new Date(iso) });

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

const baseArgs = (overrides: Partial<Parameters<typeof createUser>[1]> = {}) => ({
  userId: USER,
  orgId: ORG,
  email: 'Ada@Example.ke',
  username: 'Ada.Collections',
  displayName: 'Ada Wanjiku',
  ...overrides,
});

const createUserIn = (existing: readonly User[] = [], overrides = {}) =>
  createUser(existing, baseArgs(overrides), at(T0));

// --- creation -----------------------------------------------------------------

describe('createUser — org-scoped principals (SPEC §34)', () => {
  it('creates an active user, normalizing email/username, and emits auth.userCreated', () => {
    const { user, event } = createUserIn();
    expect(user.status).toBe('active');
    expect(user.email).toBe('ada@example.ke');
    expect(user.username).toBe('ada.collections');
    expect(user.createdAt.toISOString()).toBe(T0);
    expect(event.name).toBe('auth.userCreated');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(USER);
    expect(event.occurredAt).toBe(T0);
    expect(event.payload).toEqual({
      userId: USER,
      orgId: ORG,
      email: 'ada@example.ke',
      username: 'ada.collections',
      displayName: 'Ada Wanjiku',
      createdAt: T0,
    });
  });

  it('rejects malformed identity values (table)', () => {
    const cases: Array<[string, Partial<Parameters<typeof createUser>[1]>, string]> = [
      ['email without @', { email: 'ada.example.ke' }, 'AUTH_EMAIL_MALFORMED'],
      ['email with spaces', { email: 'ada wanjiku@example.ke' }, 'AUTH_EMAIL_MALFORMED'],
      ['email without tld', { email: 'ada@example' }, 'AUTH_EMAIL_MALFORMED'],
      ['username too short', { username: 'ab' }, 'AUTH_USERNAME_MALFORMED'],
      ['username bad start', { username: '-ada' }, 'AUTH_USERNAME_MALFORMED'],
      ['username with space', { username: 'ada wan' }, 'AUTH_USERNAME_MALFORMED'],
      ['blank display name', { displayName: '   ' }, 'AUTH_DISPLAY_NAME_REQUIRED'],
    ];
    for (const [label, overrides, code] of cases) {
      expectCode(() => createUserIn([], overrides), code);
      expect(label).toBeTruthy();
    }
  });

  it('enforces uniqueness per org but isolates across orgs (table)', () => {
    const existing = [createUserIn().user];
    const freshId = uid(112);
    expectCode(() => createUserIn(existing), 'AUTH_USER_ID_TAKEN');
    expectCode(() => createUserIn(existing, { userId: freshId }), 'AUTH_EMAIL_TAKEN');
    expectCode(
      () =>
        createUser(
          existing,
          baseArgs({ userId: freshId, username: 'other.handle' }),
          at(T0),
        ),
      'AUTH_EMAIL_TAKEN',
    );
    expectCode(
      () =>
        createUser(
          existing,
          baseArgs({ userId: freshId, email: 'other@example.ke' }),
          at(T0),
        ),
      'AUTH_USERNAME_TAKEN',
    );
    // Same email/username in a DIFFERENT org is a different principal (org isolation).
    const crossOrg = createUser(
      existing,
      baseArgs({ orgId: OTHER_ORG, userId: uid(111) }),
      at(T0),
    );
    expect(crossOrg.user.orgId).toBe(OTHER_ORG);
    expect(crossOrg.event.payload.orgId).toBe(OTHER_ORG);
  });
});

// --- status lifecycle ----------------------------------------------------------

describe('user status lifecycle — active | suspended | deactivated (table)', () => {
  it('has the exact lifecycle the issue specifies and no others', () => {
    const active = createUserIn().user;
    const suspended = suspendUser(active, { reason: 'investigation', actorId: 'admin-1' }, at(T1)).user;
    expect(suspended.status).toBe('suspended');

    const reactivated = reactivateUser(suspended, { reason: 'cleared', actorId: 'admin-1' }, at(T1)).user;
    expect(reactivated.status).toBe('active');
    expect(reactivated.reactivatedAt?.toISOString()).toBe(T1);

    const deactivated = deactivateUser(
      reactivated,
      { reason: 'offboarding', actorId: 'admin-1' },
      at(T1),
    ).user;
    expect(deactivated.status).toBe('deactivated');
  });

  it('suspension emits auth.userSuspended with the mandatory audit pair', () => {
    const active = createUserIn().user;
    const { user, event } = suspendUser(active, { reason: 'pending investigation', actorId: 'admin-9' }, at(T1));
    expect(user.suspendedAt?.toISOString()).toBe(T1);
    expect(user.suspendedReason).toBe('pending investigation');
    expect(event.name).toBe('auth.userSuspended');
    expect(event.aggregateId).toBe(USER);
    expect(event.payload).toEqual({
      userId: USER,
      orgId: ORG,
      reason: 'pending investigation',
      suspendedAt: T1,
    });
  });

  it('refuses illegal transitions (table)', () => {
    const active = createUserIn().user;
    const suspended = suspendUser(active, { reason: 'x', actorId: 'a' }, at(T1)).user;
    const deactivated = deactivateUser(suspended, { reason: 'x', actorId: 'a' }, at(T1)).user;
    const cases: Array<[() => unknown, string]> = [
      [() => suspendUser(suspended, { reason: 'x', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
      [() => suspendUser(deactivated, { reason: 'x', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
      [() => reactivateUser(active, { reason: 'x', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
      [() => reactivateUser(deactivated, { reason: 'x', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
      [() => deactivateUser(deactivated, { reason: 'x', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
    ];
    for (const [fn, code] of cases) expectCode(fn, code);
  });

  it('demands the audit pair on every transition (table)', () => {
    const active = createUserIn().user;
    const cases: Array<[() => unknown, string]> = [
      [() => suspendUser(active, { reason: '  ', actorId: 'a' }, at(T1)), 'AUTH_REASON_REQUIRED'],
      [() => suspendUser(active, { reason: 'x', actorId: '' }, at(T1)), 'AUTH_ACTOR_REQUIRED'],
      [() => reactivateUser(active, { reason: '', actorId: 'a' }, at(T1)), 'AUTH_USER_NOT_ACTIVE'],
      [() => deactivateUser(active, { reason: '', actorId: 'a' }, at(T1)), 'AUTH_REASON_REQUIRED'],
    ];
    for (const [fn, code] of cases) expectCode(fn, code);
  });

  it('reactivation/deactivation return the fresh aggregate without a catalog event', () => {
    const active = createUserIn().user;
    const suspended = suspendUser(active, { reason: 'x', actorId: 'a' }, at(T1)).user;
    const reactivated = reactivateUser(suspended, { reason: 'cleared', actorId: 'a' }, at(T1));
    expect('event' in reactivated).toBe(false);
    const deactivated = deactivateUser(suspended, { reason: 'exit', actorId: 'a' }, at(T1));
    expect('event' in deactivated).toBe(false);
  });
});

// --- password credentials (injected SecretCodec port) -----------------------------

describe('password credentials — hashing behind the injected port', () => {
  const codec: SecretCodec & { calls: string[] } = {
    calls: [],
    hash(secret: string): string {
      this.calls.push(secret);
      return `hash:${secret.length}:${secret.slice(-1)}`;
    },
    verify(secret: string, hash: string): boolean {
      return hash === `hash:${secret.length}:${secret.slice(-1)}`;
    },
  };

  it('stores only the codec output — never plaintext (SPEC §34)', () => {
    codec.calls = [];
    const secret = 'correct horse battery';
    const { record } = recordPassword(USER, { secret }, codec, at(T1));
    expect(record.userId).toBe(USER);
    expect(record.updatedAt.toISOString()).toBe(T1);
    // The port was called with the RAW secret (the adapter owns crypto)...
    expect(codec.calls).toEqual([secret]);
    // ...but nothing plaintext survives in the record.
    expect(record.secretHash).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('verifies as a boolean decision — wrong password is not an exception', () => {
    const { record } = recordPassword(USER, { secret: 'correct horse battery' }, codec, at(T1));
    expect(verifyPassword(record, 'correct horse battery', codec)).toBe(true);
    expect(verifyPassword(record, 'wrong horse battery', codec)).toBe(false);
    // No enumeration oracle: a missing record verifies false, never throws.
    expect(verifyPassword(null, 'correct horse battery', codec)).toBe(false);
    expect(verifyPassword(undefined, 'x'.repeat(SECRET_MIN_LENGTH), codec)).toBe(false);
  });

  it('refuses short secrets and a broken port (table)', () => {
    expectCode(
      () => recordPassword(USER, { secret: 'short' }, codec, at(T1)),
      'AUTH_SECRET_TOO_SHORT',
    );
    expectCode(
      () => recordPassword(USER, { secret: 'x'.repeat(SECRET_MIN_LENGTH) }, {} as SecretCodec, at(T1)),
      'AUTH_HASH_PORT_INVALID',
    );
    expectCode(
      () => recordPassword(USER, { secret: 'x'.repeat(SECRET_MIN_LENGTH) }, { hash: codec.hash, verify: undefined as unknown as () => boolean }, at(T1)),
      'AUTH_HASH_PORT_INVALID',
    );
    expectCode(
      () => verifyPassword(null, 'whatever', {} as SecretCodec),
      'AUTH_HASH_PORT_INVALID',
    );
  });
});

// --- immutability pin ---------------------------------------------------------------

describe('no-mutation pins (append-only discipline)', () => {
  it('createUser never mutates the existing-users registry or its args', () => {
    const existing = [createUserIn().user];
    const before = JSON.stringify(existing);
    const args = baseArgs({ email: 'new@example.ke', username: 'new.handler', userId: uid(199) });
    const argsBefore = JSON.stringify(args);
    createUser(existing, args, at(T1));
    expect(JSON.stringify(existing)).toBe(before);
    expect(JSON.stringify(args)).toBe(argsBefore);
  });

  it('suspendUser/reactivateUser/deactivateUser return fresh copies', () => {
    const active = createUserIn().user;
    const before = JSON.stringify(active);
    const suspended = suspendUser(active, { reason: 'x', actorId: 'a' }, at(T1)).user;
    expect(JSON.stringify(active)).toBe(before);
    expect(suspended).not.toBe(active);
    const reactivated = reactivateUser(suspended, { reason: 'y', actorId: 'a' }, at(T1)).user;
    expect(JSON.stringify(suspended)).toBe(
      JSON.stringify(suspendUser(active, { reason: 'x', actorId: 'a' }, at(T1)).user),
    );
    expect(reactivated).not.toBe(suspended);
  });
});
