import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import { apiKeyPrincipal, authorize, can, userPrincipal, AUTH_ACCESS_DENIED } from './guard';
import { grantRole, isActiveGrant, type RoleGrant } from './assignments';
import { issueKey, type ApiKey } from './apikeys';
import { defineRole, type Role } from './roles';
import { openSession, type Session } from './sessions';
import { createUser, suspendUser, type SecretCodec, type User } from './user';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(401);
const ADMIN = uid(410);
const USER = uid(411);
const RESOURCE = uid(420);
const OTHER_RESOURCE = uid(421);

const T0 = '2026-03-01T08:00:00.000Z';
const T1 = '2026-03-01T08:05:00.000Z';
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

const codec: SecretCodec = {
  hash: (secret) => `hash(${secret})`,
  verify: (secret, hash) => hash === `hash(${secret})`,
};

const createUserAt = (): User =>
  createUser(
    [],
    { userId: USER, orgId: ORG, email: 'grace@fuatilia.ke', username: 'grace', displayName: 'Grace Wanjiru' },
    at(T0),
  ).user;

const define = (roleId: Uuid, name: string, permissions: string[]): Role =>
  defineRole([], { roleId, orgId: ORG, name, permissions }, at(T0)).role;

const ROLE_COLLECTOR = uid(430);
const ROLE_ADMIN = uid(431);
const ROLE_PAYMENTS_WILDCARD = uid(432);
const collectorRole = define(ROLE_COLLECTOR, 'Collector', ['collections:read', 'collections:act']);
const adminRole = define(ROLE_ADMIN, 'Admin', ['admin:manage-users', 'collections:read']);
const paymentsWildcardRole = define(ROLE_PAYMENTS_WILDCARD, 'Payments Ops', ['payments:*']);

const GRANT = uid(440);
const GRANT2 = uid(441);

const grantCollector = (resourceId: Uuid | null = null): RoleGrant => {
  const result = grantRole(
    [],
    {
      grantId: GRANT,
      orgId: ORG,
      userId: USER,
      role: collectorRole,
      grantedBy: ADMIN,
      granterPermissions: ['admin:manage-users', 'collections:read', 'collections:act'],
      resourceId,
    },
    at(T0),
  );
  if (!result.granted) throw new Error('fixture grant must succeed');
  return result.grant;
};

const grantPaymentsWildcard = (): RoleGrant => {
  const result = grantRole(
    [],
    {
      grantId: GRANT2,
      orgId: ORG,
      userId: USER,
      role: paymentsWildcardRole,
      grantedBy: ADMIN,
      granterPermissions: ['admin:manage-users', 'payments:read', 'payments:intake', 'payments:refund'],
    },
    at(T0),
  );
  if (!result.granted) throw new Error('fixture grant must succeed');
  return result.grant;
};

const issuedKey = (): ApiKey =>
  issueKey(
    [],
    {
      keyId: uid(450),
      orgId: ORG,
      name: 'bot',
      createdBy: ADMIN,
      secret: 'sk-live-a1b2c3d4e5f6g7h8',
      scopes: ['payments:intake'],
    },
    codec,
    at(T0),
  ).key;

const IDLE_MS = 30 * 60 * 1000;
const ABS_MS = 8 * 60 * 60 * 1000;
const openAt = (iso: string, overrides = {}): Session =>
  openSession(
    {
      sessionId: uid(460),
      userId: USER,
      orgId: ORG,
      idleTimeoutMs: IDLE_MS,
      absoluteTimeoutMs: ABS_MS,
      ...overrides,
    },
    at(iso),
  ).session;

// --- principal projection ----------------------------------------------------------

describe('userPrincipal — grant facts projected into authority rules', () => {
  it('active grants contribute their role rules with evidence; revoked grants and dangling role ids contribute nothing', () => {
    const user = createUserAt();
    const grant = grantCollector();
    const dangling: RoleGrant = { ...grant, grantId: uid(445), roleId: uid(446) };
    const revoked: RoleGrant = {
      ...grant,
      grantId: uid(447),
      revokedAt: new Date(T1),
      revokedBy: ADMIN,
      revokedReason: 'left team',
    };
    expect(isActiveGrant(grant)).toBe(true);
    expect(isActiveGrant(revoked)).toBe(false);

    const principal = userPrincipal(user, [grant, dangling, revoked], [collectorRole]);
    expect(principal.kind).toBe('user');
    expect(principal.status).toBe('active');
    // exactly the two live collector rules — the dangling role and revoked grant are invisible
    expect(principal.rules).toEqual([
      { rule: 'collections:act', roleId: ROLE_COLLECTOR, grantId: GRANT, resourceId: null },
      { rule: 'collections:read', roleId: ROLE_COLLECTOR, grantId: GRANT, resourceId: null },
    ]);
  });

  it('apiKeyPrincipal — scopes are rules with null role/grant evidence; revocation maps to status revoked', () => {
    const key = issuedKey();
    const principal = apiKeyPrincipal(key);
    expect(principal.kind).toBe('apiKey');
    expect(principal.status).toBe('active');
    expect(principal.rules).toEqual([{ rule: 'payments:intake', roleId: null, grantId: null, resourceId: null }]);
    const revokedKey: ApiKey = { ...key, status: 'revoked', revokedAt: new Date(T1) };
    expect(apiKeyPrincipal(revokedKey).status).toBe('revoked');
  });
});

// --- the decision core ----------------------------------------------------------------

describe('can — the deterministic permission matrix (deny by default)', () => {
  const user = createUserAt();

  it('allow carries matched-rule evidence (which rule, which grant, which role)', () => {
    const principal = userPrincipal(user, [grantCollector()], [collectorRole]);
    const decision = can(principal, 'collections:act');
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.via.rule).toBe('collections:act');
      expect(decision.via.grantId).toBe(GRANT);
      expect(decision.via.roleId).toBe(ROLE_COLLECTOR);
    }
  });

  it('unknown permission denies before anything else', () => {
    const principal = userPrincipal(user, [grantCollector()], [collectorRole]);
    const decision = can(principal, 'invoice:nuke');
    expect(decision).toEqual({
      allowed: false,
      reason: 'PERMISSION_UNKNOWN',
      detail: expect.stringContaining('closed vocabulary'),
    });
  });

  it('principal status table — suspended / deactivated principals authorize nothing', () => {
    const suspended = suspendUser(createUserAt(), { reason: 'investigation', actorId: ADMIN }, at(T1)).user;
    const suspendedPrincipal = userPrincipal(suspended, [grantCollector()], [collectorRole]);
    expect(can(suspendedPrincipal, 'collections:read')).toEqual({
      allowed: false,
      reason: 'PRINCIPAL_SUSPENDED',
      detail: expect.any(String),
    });
    const deactivated: User = { ...createUserAt(), status: 'deactivated' };
    expect(can(userPrincipal(deactivated, [grantCollector()], [collectorRole]), 'collections:read')).toEqual({
      allowed: false,
      reason: 'PRINCIPAL_DEACTIVATED',
      detail: expect.any(String),
    });
  });

  it('a revoked API-key principal denies with PRINCIPAL_REVOKED', () => {
    const key = issuedKey();
    const revokedKey: ApiKey = { ...key, status: 'revoked', revokedAt: new Date(T1) };
    expect(can(apiKeyPrincipal(revokedKey), 'payments:intake')).toEqual({
      allowed: false,
      reason: 'PRINCIPAL_REVOKED',
      detail: expect.any(String),
    });
  });

  it('no covering rule → NO_GRANT (deny-by-default is explicit)', () => {
    const principal = userPrincipal(user, [grantCollector()], [collectorRole]);
    expect(can(principal, 'ledger:post')).toEqual({
      allowed: false,
      reason: 'NO_GRANT',
      detail: expect.stringContaining('deny by default'),
    });
  });

  it('role wildcards expand at match time — payments:* covers concrete payments permissions', () => {
    const principal = userPrincipal(user, [grantPaymentsWildcard()], [paymentsWildcardRole]);
    const decision = can(principal, 'payments:intake');
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.via.rule).toBe('payments:*');
    expect(can(principal, 'collections:act').allowed).toBe(false);
  });

  it('resource scoping: org-wide grants cover every resource; scoped grants cover exactly one', () => {
    const orgWide = userPrincipal(user, [grantCollector(null)], [collectorRole]);
    expect(can(orgWide, 'collections:act', RESOURCE).allowed).toBe(true);
    expect(can(orgWide, 'collections:act', OTHER_RESOURCE).allowed).toBe(true);

    const scoped = userPrincipal(user, [grantCollector(RESOURCE)], [collectorRole]);
    expect(can(scoped, 'collections:act', RESOURCE).allowed).toBe(true);
    const elsewhere = can(scoped, 'collections:act', OTHER_RESOURCE);
    expect(elsewhere).toEqual({
      allowed: false,
      reason: 'NOT_IN_RESOURCE_SCOPE',
      detail: expect.stringContaining('scoped, not guessed'),
    });
    // a query that names NO resource is not scope-constrained (org-wide semantics)
    const unscoped = can(scoped, 'collections:act');
    expect(unscoped.allowed).toBe(true);
    if (unscoped.allowed) expect(unscoped.via.rule).toBe('collections:act');
  });
});

// --- the auditable boundary -------------------------------------------------------------

describe('authorize — session gate, unknown principals, audited denials', () => {
  const user = createUserAt();

  const authorizeArgs = (overrides: Partial<Parameters<typeof authorize>[0]> = {}) => ({
    user,
    assignments: [grantCollector()],
    roles: [collectorRole],
    session: null,
    orgId: ORG,
    ...overrides,
  });

  it('allow returns the decision with its evidence and the projected principal', () => {
    const result = authorize(authorizeArgs(), 'collections:act', null, at(T1));
    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.decision.via.rule).toBe('collections:act');
      expect(result.principal.principalId).toBe(USER);
    }
  });

  it('session gate table — idle/absolute expiry, revocation and logout each deny with their own reason', () => {
    const live = openAt(T0);
    const before = authorize(authorizeArgs({ session: live }), 'collections:act', null, at('2026-03-01T08:29:59.999Z'));
    expect(before.allowed).toBe(true); // 1ms inside the idle window

    const idleExpired = authorize(authorizeArgs({ session: live }), 'collections:act', null, at('2026-03-01T08:30:00.000Z'));
    expect(idleExpired.allowed).toBe(false);
    if (!idleExpired.allowed) expect(idleExpired.reason).toBe('SESSION_IDLE_EXPIRED');

    const revokedSession: Session = { ...live, status: 'revoked', endedAt: new Date(T1) };
    const revoked = authorize(authorizeArgs({ session: revokedSession }), 'collections:act', null, at(T1));
    expect(revoked.allowed).toBe(false);
    if (!revoked.allowed) expect(revoked.reason).toBe('SESSION_REVOKED');

    const endedSession: Session = { ...live, status: 'ended', endedAt: new Date(T1) };
    const ended = authorize(authorizeArgs({ session: endedSession }), 'collections:act', null, at(T1));
    expect(ended.allowed).toBe(false);
    if (!ended.allowed) expect(ended.reason).toBe('SESSION_ENDED');

    const absoluteSession = openAt(T0, { idleTimeoutMs: ABS_MS * 2, absoluteTimeoutMs: 60 * 1000 });
    const absolute = authorize(
      authorizeArgs({ session: absoluteSession }),
      'collections:act',
      null,
      at('2026-03-01T08:01:00.000Z'),
    );
    expect(absolute.allowed).toBe(false);
    if (!absolute.allowed) expect(absolute.reason).toBe('SESSION_ABSOLUTE_EXPIRED');
  });

  it('an expired session denies even a permission the user holds — and the denial is audited on the org', () => {
    const live = openAt(T0);
    const result = authorize(authorizeArgs({ session: live }), 'collections:act', null, at('2026-03-01T08:30:00.000Z'));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe(AUTH_ACCESS_DENIED);
      expect(result.event.name).toBe('auth.accessDenied');
      expect(result.event.version).toBe(1);
      expect(result.event.aggregateId).toBe(ORG);
      expect(result.event.payload).toEqual({
        orgId: ORG,
        principalId: null,
        principalKind: 'unknown',
        permission: 'collections:act',
        resource: null,
        reason: 'SESSION_IDLE_EXPIRED',
        detail: expect.any(String),
        at: '2026-03-01T08:30:00.000Z',
      });
    }
  });

  it('an unknown principal denies with PRINCIPAL_UNKNOWN (never an exception)', () => {
    const result = authorize(authorizeArgs({ user: null }), 'collections:act', null, at(T1));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('PRINCIPAL_UNKNOWN');
      expect(result.event.payload.principalId).toBeNull();
      expect(result.event.payload.principalKind).toBe('unknown');
    }
  });

  it('NO_GRANT denials are wrapped as AUTH_ACCESS_DENIED values + auth.accessDenied facts', () => {
    const result = authorize(authorizeArgs(), 'ledger:post', null, at(T1));
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe('AUTH_ACCESS_DENIED');
      expect(result.reason).toBe('NO_GRANT');
      expect(result.event.payload.principalId).toBe(USER);
      expect(result.event.payload.principalKind).toBe('user');
      expect(result.event.payload.reason).toBe('NO_GRANT');
    }
  });

  it('a suspended user denies through the matrix too — and the fact is audited', () => {
    const suspended = suspendUser(user, { reason: 'offboarding', actorId: ADMIN }, at(T1)).user;
    const result = authorize(authorizeArgs({ user: suspended }), 'collections:act', null, at(T1));
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe('PRINCIPAL_SUSPENDED');
  });

  it('a broken injected clock throws AUTH_CLOCK_INVALID (never a silent deny)', () => {
    expectCode(() => authorize(authorizeArgs(), 'collections:act', null, { now: () => new Date('junk') }), 'AUTH_CLOCK_INVALID');
  });
});
