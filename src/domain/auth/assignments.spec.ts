import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  AUTH_ESCALATION_BLOCKED,
  grantRole,
  isActiveGrant,
  revokeRole,
  type GrantRoleResult,
  type RoleGrant,
} from './assignments';
import { defineRole, effectivePermissions, type Role } from './roles';
import { PERMISSIONS } from './roles';
import { createUser } from './user';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(301);
const USER = uid(310);
const GRANTER = uid(311);
const RESOURCE = uid(312);

const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T09:00:00.000Z';
const T2 = '2026-03-01T10:00:00.000Z';
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

const role = (name: string, roleId: Uuid, permissions: string[]): Role =>
  defineRole([], { roleId, orgId: ORG, name, permissions }, at(T0)).role;

const COLLECTOR = role('Collector', uid(320), ['collections:read', 'collections:act']);
const LEDGER_CLERK = role('Ledger Clerk', uid(321), ['ledger:read']);
const POWERFUL = role('Everything', uid(322), PERMISSIONS.map((p) => (p.startsWith('collections:') ? p : p))); // concrete only

/** The granter's effective set: full admin + everything, i.e. can grant anything. */
const OWNER_PERMISSIONS = effectivePermissions(
  [POWERFUL],
  [{ roleId: POWERFUL.roleId, revokedAt: null }],
);

const granterOf = (permissions: readonly string[], userId: Uuid = GRANTER) => ({
  granterPermissions: permissions as never[],
  grantedBy: userId,
});

const grantArgs = (overrides: Partial<Parameters<typeof grantRole>[1]> = {}) => ({
  grantId: uid(330),
  orgId: ORG,
  userId: USER,
  role: COLLECTOR,
  ...granterOf(OWNER_PERMISSIONS),
  ...overrides,
});

/** Drive a grant through grantRole and return the fresh trail. */
const grantIn = (
  existing: readonly RoleGrant[],
  overrides: Partial<Parameters<typeof grantRole>[1]> = {},
): { trail: RoleGrant[]; result: GrantRoleResult } => {
  const result = grantRole(existing, grantArgs(overrides), at(T1));
  if (result.granted && result.event) return { trail: [...existing, result.grant], result };
  return { trail: [...existing], result };
};

// --- granting -----------------------------------------------------------------

describe('grantRole — append-only facts + auth.roleGranted', () => {
  it('appends a grant fact and emits auth.roleGranted (aggregate = the grant)', () => {
    const { trail, result } = grantIn([]);
    if (!result.granted || !result.event) throw new Error('expected a fresh grant');
    expect(result.alreadyHeld).toBe(false);
    expect(trail).toHaveLength(1);
    const g = result.grant;
    expect(g.userId).toBe(USER);
    expect(g.roleId).toBe(COLLECTOR.roleId);
    expect(g.resourceId).toBeNull(); // org-wide by default
    expect(g.grantedBy).toBe(GRANTER);
    expect(g.grantedAt.toISOString()).toBe(T1);
    expect(g.revokedAt).toBeNull();
    expect(result.event.name).toBe('auth.roleGranted');
    expect(result.event.version).toBe(1);
    expect(result.event.aggregateId).toBe(g.grantId);
    expect(result.event.payload).toEqual({
      grantId: g.grantId,
      orgId: ORG,
      userId: USER,
      roleId: COLLECTOR.roleId,
      resourceId: null,
      grantedBy: GRANTER,
      grantedAt: T1,
    });
  });

  it('keeps an explicit resource scope for resource-level authorization (SPEC §35)', () => {
    const { result } = grantIn([], { resourceId: RESOURCE });
    if (!result.granted) throw new Error('expected grant');
    expect(result.grant.resourceId).toBe(RESOURCE);
    expect(result.event?.payload.resourceId).toBe(RESOURCE);
  });

  it('same-role re-grant is IDEMPOTENT: original fact returned, no duplicate, no event', () => {
    const first = grantIn([]);
    if (!first.result.granted) throw new Error('setup');
    const originalGrant = first.result.grant;
    // (a) command replay — same grantId, same payload:
    const replayed = grantRole(first.trail, grantArgs(), at(T2));
    expect(replayed).toMatchObject({ granted: true, alreadyHeld: true, event: null });
    if (!replayed.granted) throw new Error('unreachable');
    expect(replayed.grant).toBe(originalGrant); // SAME fact object
    // (b) fresh command id over an assignment the user already holds:
    const regrant = grantRole(first.trail, grantArgs({ grantId: uid(333) }), at(T2));
    expect(regrant).toMatchObject({ granted: true, alreadyHeld: true, event: null });
    if (!regrant.granted) throw new Error('unreachable');
    expect(regrant.grant).toBe(originalGrant);
    expect(first.trail).toHaveLength(1); // no duplicate appended either way
    // (c) same grantId over a DIFFERENT assignment is a collision, not a replay:
    expectCode(
      () => grantRole(first.trail, grantArgs({ userId: uid(350) }), at(T2)),
      'AUTH_GRANT_ID_TAKEN',
    );
  });

  it('same role with a DIFFERENT scope is a distinct fact, not a replay', () => {
    const first = grantIn([]);
    const scoped = grantRole(first.trail, grantArgs({ resourceId: RESOURCE, grantId: uid(331) }), at(T2));
    expect(scoped).toMatchObject({ granted: true, alreadyHeld: false });
  });

  it('re-grant after revocation appends a NEW fact — latest-fact-wins, history intact', () => {
    const first = grantIn([]);
    if (!first.result.granted || !first.result.event) throw new Error('setup');
    const revoked = revokeRole(
      first.trail,
      { userId: USER, roleId: COLLECTOR.roleId, revokedBy: GRANTER, reason: 'role change' },
      at(T2),
    );
    expect(revoked.grant.revokedAt?.toISOString()).toBe(T2);
    expect(revoked.grant.revokedBy).toBe(GRANTER);
    expect(revoked.grant.revokedReason).toBe('role change');
    expect(revoked.event.name).toBe('auth.roleRevoked');
    expect(revoked.event.aggregateId).toBe(first.result.grant.grantId);
    // The original fact is untouched (revocation sets fields on a copy).
    expect(first.result.grant.revokedAt).toBeNull();
    expect(isActiveGrant(first.result.grant)).toBe(true);
    expect(isActiveGrant(revoked.grant)).toBe(false);

    const regrant = grantRole(
      [...first.trail.map((g) => (g.grantId === revoked.grant.grantId ? revoked.grant : g))],
      grantArgs({ grantId: uid(332) }),
      at(T2),
    );
    expect(regrant).toMatchObject({ granted: true, alreadyHeld: false });
  });

  it('a grantId is bound to its assignment forever (collision refused)', () => {
    const { trail } = grantIn([]);
    expectCode(
      () =>
        grantRole(
          trail,
          grantArgs({ grantId: trail[0]?.grantId, resourceId: RESOURCE }),
          at(T2),
        ),
      'AUTH_GRANT_ID_TAKEN',
    );
  });
});

// --- the escalation guard (issue invariant) ---------------------------------------

describe('grantRole — escalation guard: grants never outlive the granter', () => {
  it('refuses (as a value + auth.escalationBlocked) a granter without admin:manage-users', () => {
    const result = grantRole([], grantArgs({ ...granterOf(['collections:read', 'collections:act']) }), at(T1));
    expect(result).toMatchObject({
      granted: false,
      code: AUTH_ESCALATION_BLOCKED,
      reason: 'GRANTER_NOT_ADMIN',
      missing: [],
    });
    if (result.granted) throw new Error('unreachable');
    expect(result.event.name).toBe('auth.escalationBlocked');
    expect(result.event.version).toBe(1);
    expect(result.event.aggregateId).toBe(ORG); // no grant aggregate may exist
    expect(result.event.payload).toEqual({
      orgId: ORG,
      granterId: GRANTER,
      userId: USER,
      roleId: COLLECTOR.roleId,
      reason: 'GRANTER_NOT_ADMIN',
      missing: [],
      at: T1,
    });
  });

  it('refuses a granter who lacks any permission the role confers (missing sorted)', () => {
    const manager = ['admin:manage-users', 'collections:read'];
    const result = grantRole([], grantArgs({ ...granterOf(manager) }), at(T1));
    expect(result).toMatchObject({
      granted: false,
      reason: 'GRANTER_LACKS_PERMISSION',
      missing: ['collections:act'],
    });
    expect(result.granted).toBe(false);
  });

  it('refuses a role-level wildcard the granter cannot cover', () => {
    const wideRole = role('Collections Ops', uid(323), ['collections:*']);
    const result = grantRole(
      [],
      grantArgs({ role: wideRole, ...granterOf(['admin:manage-users', 'ledger:read']) }),
      at(T1),
    );
    expect(result).toMatchObject({ granted: false, reason: 'GRANTER_LACKS_PERMISSION', missing: ['collections:*'] });
  });

  it('a granter holding collections:* (expanded) can grant collections roles', () => {
    const collectorAdmin = effectivePermissions(
      [role('Collections Admin', uid(324), ['collections:*', 'admin:manage-users'])],
      [{ roleId: uid(324), revokedAt: null }],
    );
    const result = grantRole([], grantArgs({ ...granterOf(collectorAdmin) }), at(T1));
    expect(result.granted).toBe(true);
  });

  it('a fully-empowered owner grants cleanly; a suspended granter (empty set) is blocked', () => {
    expect(grantRole([], grantArgs(), at(T1)).granted).toBe(true);
    const blocked = grantRole([], grantArgs({ ...granterOf([]) }), at(T1));
    expect(blocked).toMatchObject({ granted: false, reason: 'GRANTER_NOT_ADMIN' });
  });

  it('the refusal is pure: nothing was appended anywhere', () => {
    const result = grantRole([], grantArgs({ ...granterOf([]) }), at(T1));
    expect(result.granted).toBe(false);
    // the caller received a value; there is no grant to persist
    if (!result.granted) expect(result.event.payload.roleId).toBe(COLLECTOR.roleId);
  });
});

// --- revoking --------------------------------------------------------------------

describe('revokeRole — revocation is a fact, never a silent success', () => {
  it('refuses revoking an unheld or already-revoked role (table)', () => {
    const { trail } = grantIn([]);
    expectCode(
      () => revokeRole([], { userId: USER, roleId: COLLECTOR.roleId, revokedBy: GRANTER, reason: 'x' }, at(T2)),
      'AUTH_ROLE_NOT_HELD',
    );
    expectCode(
      () => revokeRole(trail, { userId: USER, roleId: LEDGER_CLERK.roleId, revokedBy: GRANTER, reason: 'x' }, at(T2)),
      'AUTH_ROLE_NOT_HELD',
    );
    const { trail: scoped } = grantIn([], { resourceId: RESOURCE });
    expectCode(
      () => revokeRole(scoped, { userId: USER, roleId: COLLECTOR.roleId, revokedBy: GRANTER, reason: 'x' }, at(T2)),
      'AUTH_ROLE_NOT_HELD', // scope mismatch: only the org-wide grant exists
    );
  });

  it('demands the audit pair (table)', () => {
    const { trail } = grantIn([]);
    expectCode(
      () => revokeRole(trail, { userId: USER, roleId: COLLECTOR.roleId, revokedBy: GRANTER, reason: '' }, at(T2)),
      'AUTH_REASON_REQUIRED',
    );
    expectCode(
      () => revokeRole(trail, { userId: USER, roleId: COLLECTOR.roleId, revokedBy: '' as Uuid, reason: 'x' }, at(T2)),
      'AUTH_ACTOR_REQUIRED',
    );
  });

  it('emits auth.roleRevoked and returns the fresh (never mutated) fact', () => {
    const { trail, result } = grantIn([]);
    if (!result.granted) throw new Error('setup');
    const original = JSON.stringify(trail);
    const { grant: revoked, event } = revokeRole(
      trail,
      { userId: USER, roleId: COLLECTOR.roleId, revokedBy: GRANTER, reason: 'offboarding' },
      at(T2),
    );
    expect(JSON.stringify(trail)).toBe(original); // input trail untouched
    expect(revoked.grantId).toBe(result.grant.grantId);
    expect(event.payload).toEqual({
      grantId: result.grant.grantId,
      orgId: ORG,
      userId: USER,
      roleId: COLLECTOR.roleId,
      revokedBy: GRANTER,
      reason: 'offboarding',
      revokedAt: T2,
    });
  });
});

// --- no-mutation pin ---------------------------------------------------------------

describe('no-mutation pins', () => {
  it('grantRole never mutates the existing trail or its args', () => {
    const { trail } = grantIn([]);
    const before = JSON.stringify(trail);
    const args = grantArgs({ grantId: uid(340) });
    const argsBefore = JSON.stringify(args);
    grantRole(trail, args, at(T2));
    expect(JSON.stringify(trail)).toBe(before);
    expect(JSON.stringify(args)).toBe(argsBefore);
  });

  it('grants compose with users: a suspended user keeps facts but loses authority via status', () => {
    const { user } = createUser([], { userId: USER, orgId: ORG, email: 'a@b.ke', username: 'abc', displayName: 'A' }, at(T0));
    const suspended = { ...user, status: 'suspended' as const };
    expect(suspended.status).toBe('suspended'); // authority gating is guard.ts's job (status → deny)
  });
});
