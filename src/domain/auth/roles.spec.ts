import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  ADMIN_MANAGE_USERS,
  PERMISSIONS,
  RESOURCES,
  assertPermission,
  assertRolePermission,
  defineRole,
  effectivePermissions,
  expandRolePermissions,
  roleCovers,
  type Role,
} from './roles';
import type { RoleGrant } from './assignments';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(201);
const OTHER_ORG = uid(202);
const ROLE = uid(210);

const T0 = '2026-02-01T08:00:00.000Z';
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

const defineRoleIn = (
  existing: readonly Role[] = [],
  overrides: Partial<Parameters<typeof defineRole>[1]> = {},
): Role => defineRole(existing, { roleId: ROLE, orgId: ORG, name: 'Collector', permissions: ['collections:read', 'collections:act'], ...overrides }, at(T0)).role;

const grant = (roleId: Uuid, revokedAt: Date | null = null): RoleGrant => ({
  grantId: uid(299),
  orgId: ORG,
  userId: uid(220),
  roleId,
  resourceId: null,
  grantedBy: uid(230),
  grantedAt: new Date(T0),
  revokedAt,
  revokedBy: null,
  revokedReason: null,
});

// --- the closed vocabulary ------------------------------------------------------

describe('the closed permission vocabulary (issue #46)', () => {
  it('carries every permission the issue names', () => {
    for (const required of [
      'receivables:read',
      'payments:intake',
      'collections:act',
      'adjustments:request',
      'ledger:post',
      'intelligence:read',
      'admin:manage-users',
      'policy:manage',
    ]) {
      expect(PERMISSIONS).toContain(required);
    }
    expect(ADMIN_MANAGE_USERS).toBe('admin:manage-users');
  });

  it('stays inside the <resource>:<action> discipline', () => {
    for (const permission of PERMISSIONS) {
      const [resource] = permission.split(':');
      expect(RESOURCES).toContain(resource);
    }
  });

  it('assertPermission validation table — malformed / wildcard / unknown', () => {
    const cases: Array<[string, string]> = [
      ['invoice.read', 'AUTH_PERMISSION_MALFORMED'], // SPEC §35 dot-style ≠ issue colon-style
      ['invoice', 'AUTH_PERMISSION_MALFORMED'],
      ['a:b:c', 'AUTH_PERMISSION_MALFORMED'],
      ['Receivables:read', 'AUTH_PERMISSION_MALFORMED'],
      ['collections:*', 'AUTH_PERMISSION_WILDCARD_FORBIDDEN'], // never per grant / key scope
      ['*', 'AUTH_PERMISSION_MALFORMED'], // no global wildcard, anywhere
      ['invoice:read', 'AUTH_PERMISSION_UNKNOWN'], // well-formed, outside vocabulary
      ['payments:nuke', 'AUTH_PERMISSION_UNKNOWN'],
    ];
    for (const [raw, code] of cases) expectCode(() => assertPermission(raw), code);
    for (const raw of PERMISSIONS) expect(assertPermission(raw)).toBe(raw);
  });

  it('assertRolePermission allows resource wildcards at ROLE level only', () => {
    expect(assertRolePermission('collections:*')).toBe('collections:*');
    expectCode(() => assertRolePermission('*'), 'AUTH_PERMISSION_MALFORMED');
    expectCode(() => assertRolePermission('payroll:*'), 'AUTH_PERMISSION_MALFORMED'); // unknown resource
    expectCode(() => assertRolePermission('invoice.read'), 'AUTH_PERMISSION_MALFORMED');
    expectCode(() => assertRolePermission('invoice:read'), 'AUTH_PERMISSION_UNKNOWN');
  });
});

// --- roles -------------------------------------------------------------------

describe('defineRole — org-scoped, frozen policy objects (SPEC §35)', () => {
  it('creates a frozen role with a deduped, sorted rule set and clock time', () => {
    const role = defineRoleIn([], { permissions: ['collections:act', 'collections:read', 'collections:read'] });
    expect(Object.isFrozen(role)).toBe(true);
    expect(Object.isFrozen(role.permissions)).toBe(true);
    expect(role.permissions).toEqual(['collections:act', 'collections:read']);
    expect(role.createdAt.toISOString()).toBe(T0);
  });

  it('validation table — id/name/permissions', () => {
    const existing = [defineRoleIn()];
    const freshId = uid(215);
    expectCode(() => defineRoleIn(existing), 'AUTH_ROLE_ID_TAKEN');
    expectCode(() => defineRoleIn(existing, { roleId: freshId }), 'AUTH_ROLE_NAME_TAKEN');
    expectCode(() => defineRoleIn(existing, { roleId: freshId, name: 'COLLECTOR' }), 'AUTH_ROLE_NAME_TAKEN'); // case-insensitive
    expectCode(() => defineRoleIn([], { name: '   ' }), 'AUTH_ROLE_NAME_REQUIRED');
    expectCode(() => defineRoleIn([], { permissions: [] }), 'AUTH_ROLE_PERMISSIONS_REQUIRED');
    expectCode(() => defineRoleIn(existing, { roleId: ROLE, name: 'Other' }), 'AUTH_ROLE_ID_TAKEN');
    // Same NAME in a different org is a different policy (org isolation).
    expect(defineRoleIn([], { orgId: OTHER_ORG }).name).toBe('Collector');
  });

  it('refuses invalid rules inside role definitions too', () => {
    expectCode(() => defineRoleIn([], { permissions: ['invoice.read'] }), 'AUTH_PERMISSION_MALFORMED');
    expectCode(() => defineRoleIn([], { permissions: ['invoice:read'] }), 'AUTH_PERMISSION_UNKNOWN');
    expectCode(() => defineRoleIn([], { permissions: ['*'] }), 'AUTH_PERMISSION_MALFORMED');
  });
});

// --- rule matching + expansion ------------------------------------------------------

describe('roleCovers / expandRolePermissions — wildcards interpreted in exactly one place', () => {
  const collector = defineRoleIn([], { permissions: ['collections:read', 'collections:act'] });
  const ops = defineRoleIn([], { roleId: uid(212), name: 'Ops', permissions: ['collections:*', 'ledger:read'] });

  it('cover grid (table)', () => {
    const cases: Array<[Role, string, boolean]> = [
      [collector, 'collections:read', true],
      [collector, 'collections:act', true],
      [collector, 'collections:write', false], // not in vocabulary anyway
      [collector, 'payments:intake', false],
      [ops, 'collections:read', true], // wildcard covers the whole resource
      [ops, 'collections:act', true],
      [ops, 'ledger:read', true],
      [ops, 'ledger:post', false], // concrete entries match only themselves
      [ops, 'payments:intake', false], // wildcard is scoped to its resource
    ];
    for (const [role, permission, expected] of cases) {
      expect(roleCovers(role, permission as never)).toBe(expected);
    }
  });

  it('expands wildcards against the closed vocabulary, sorted', () => {
    expect(expandRolePermissions(collector)).toEqual(['collections:act', 'collections:read']);
    expect(expandRolePermissions(ops)).toEqual([
      'collections:act',
      'collections:read',
      'ledger:read',
    ]);
  });

  it('effectivePermissions: active grants only, dangling grants confer nothing', () => {
    const roles = [collector, ops];
    const dangling = defineRoleIn([], { roleId: uid(213), name: 'Ghost', permissions: ['policy:manage'] });
    const grants = [
      grant(collector.roleId),
      grant(ops.roleId),
      grant(dangling.roleId), // role not in the registry — no authority
      { ...grant(collector.roleId), revokedAt: new Date(T0) }, // revoked — no authority
    ];
    expect(effectivePermissions(roles, grants)).toEqual([
      'collections:act',
      'collections:read',
      'ledger:read',
    ]);
  });
});

// --- immutability pin ------------------------------------------------------------

describe('no-mutation pins', () => {
  it('defineRole never mutates the registry or the args', () => {
    const existing = [defineRoleIn()];
    const before = JSON.stringify(existing);
    const permissions = ['ledger:read', 'ledger:post'];
    const permsBefore = JSON.stringify(permissions);
    defineRole(existing, { roleId: uid(214), orgId: ORG, name: 'Accountant', permissions }, at(T0));
    expect(JSON.stringify(existing)).toBe(before);
    expect(JSON.stringify(permissions)).toBe(permsBefore);
  });
});
