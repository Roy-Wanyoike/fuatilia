import { describe, expect, it } from 'vitest';
import { DomainError, type Clock, type Uuid, uuid } from '../shared';
import {
  KEY_PREFIX_LENGTH,
  KEY_SECRET_MIN_LENGTH,
  authenticateKey,
  issueKey,
  revokeKey,
  type ApiKey,
} from './apikeys';
import { type SecretCodec } from './user';
import { AUTH_ATTEMPT_PERMISSION } from './apikeys';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ORG = uid(201);
const ISSUER = uid(210);
const KEY = uid(211);
const OTHER_KEY = uid(212);

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

/** Deterministic fake codec — the domain never imports crypto. */
const codec: SecretCodec = {
  hash: (secret) => `hash(${secret})`,
  verify: (secret, hash) => hash === `hash(${secret})`,
};

const SECRET = 'sk-live-a1b2c3d4e5f6g7h8'; // 23 chars — first 8 = prefix
const PREFIX = SECRET.slice(0, KEY_PREFIX_LENGTH);

const baseArgs = (overrides: Partial<Parameters<typeof issueKey>[1]> = {}) => ({
  keyId: KEY,
  orgId: ORG,
  name: 'Collector bot',
  createdBy: ISSUER,
  secret: SECRET,
  scopes: ['payments:intake'],
  ...overrides,
});

const issue = (overrides: Partial<Parameters<typeof issueKey>[1]> = {}, existing: readonly ApiKey[] = []) =>
  issueKey(existing, baseArgs(overrides), codec, at(T0));

// --- issuance -----------------------------------------------------------------

describe('issueKey — issuance records (SPEC §34)', () => {
  it('issues an active key: prefix visible, hash stored, apiKeyIssued payload carries neither secret nor hash', () => {
    const { key, event } = issue();
    expect(key.status).toBe('active');
    expect(key.prefix).toBe(PREFIX);
    expect(key.secretHash).toBe(`hash(${SECRET})`);
    expect(key.scopes).toEqual(['payments:intake']);
    expect(key.expiresAt).toBeNull();
    expect(key.lastUsedAt).toBeNull();
    expect(event.name).toBe('auth.apiKeyIssued');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(KEY);
    const payload = event.payload as unknown as Record<string, unknown>;
    expect(payload).toEqual({
      keyId: KEY,
      orgId: ORG,
      name: 'Collector bot',
      prefix: PREFIX,
      scopes: ['payments:intake'],
      expiresAt: null,
      createdBy: ISSUER,
      issuedAt: T0,
    });
    expect(JSON.stringify(payload)).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain(`hash(${SECRET})`);
  });

  it('dedupes and sorts scopes', () => {
    const { key } = issue({ scopes: ['payments:intake', 'ledger:post', 'payments:intake'] });
    expect(key.scopes).toEqual(['ledger:post', 'payments:intake']);
  });

  it('validation table', () => {
    expectCode(() => issue({}, [issue().key]), 'AUTH_KEY_ID_TAKEN');
    expectCode(() => issue({ name: '   ' }), 'AUTH_KEY_NAME_REQUIRED');
    expectCode(() => issue({ createdBy: '  ' as unknown as Uuid }), 'AUTH_ACTOR_REQUIRED');
    expectCode(() => issue({ scopes: [] }), 'AUTH_KEY_SCOPES_REQUIRED');
    expectCode(() => issue({ scopes: ['payments:*'] }), 'AUTH_PERMISSION_WILDCARD_FORBIDDEN');
    expectCode(() => issue({ scopes: ['payments'] }), 'AUTH_PERMISSION_MALFORMED');
    expectCode(() => issue({ scopes: ['invoice:nuke'] }), 'AUTH_PERMISSION_UNKNOWN');
    expectCode(() => issue({ secret: 'short' }), 'AUTH_SECRET_TOO_SHORT');
  });

  it(`enforces the ${KEY_SECRET_MIN_LENGTH}-char machine-secret floor via a boundary table`, () => {
    const atFloor = 'a'.repeat(KEY_SECRET_MIN_LENGTH);
    expect(issue({ secret: atFloor }).key.prefix).toBe(atFloor.slice(0, KEY_PREFIX_LENGTH));
    expectCode(() => issue({ secret: 'a'.repeat(KEY_SECRET_MIN_LENGTH - 1) }), 'AUTH_SECRET_TOO_SHORT');
  });

  it('refuses a prefix collision — prefix lookup must stay unambiguous', () => {
    const existing = issue().key;
    expectCode(
      () =>
        issueKey(
          [existing],
          baseArgs({ keyId: OTHER_KEY, secret: SECRET.slice(0, KEY_PREFIX_LENGTH) + 'ZZZ-zzz-9999' }),
          codec,
          at(T1),
        ),
      'AUTH_KEY_PREFIX_TAKEN',
    );
  });

  it('expiry must be strictly after issuance (±0 boundary)', () => {
    expectCode(() => issue({ expiresAt: new Date(T0) }), 'AUTH_KEY_EXPIRY_INVALID');
    expectCode(() => issue({ expiresAt: new Date('not-a-date') }), 'AUTH_KEY_EXPIRY_INVALID');
    const { key } = issue({ expiresAt: new Date('2026-03-02T08:00:00.000Z') });
    expect(key.expiresAt?.toISOString()).toBe('2026-03-02T08:00:00.000Z');
  });

  it('a broken codec port is a programming error, never silently stored', () => {
    expectCode(
      () => issueKey(existing0(), baseArgs(), {} as unknown as SecretCodec, at(T0)),
      'AUTH_HASH_PORT_INVALID',
    );
  });

  const existing0 = () => [] as ApiKey[];
});

// --- revocation ------------------------------------------------------------------

describe('revokeKey — revocation is a fact (idempotent replay)', () => {
  it('revokes and emits auth.apiKeyRevoked', () => {
    const { key } = issue();
    const { key: revoked, event } = revokeKey([key], { keyId: KEY, revokedBy: ISSUER, reason: 'leaked' }, at(T1));
    if (event === null) throw new Error('expected auth.apiKeyRevoked on first revocation');
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedAt?.toISOString()).toBe(T1);
    expect(revoked.revokedReason).toBe('leaked');
    expect(event.name).toBe('auth.apiKeyRevoked');
    expect(event.aggregateId).toBe(KEY);
    expect(event.payload).toEqual({
      keyId: KEY,
      orgId: ORG,
      revokedBy: ISSUER,
      reason: 'leaked',
      revokedAt: T1,
    });
  });

  it('replaying the revocation returns the original record with no event', () => {
    const { key } = issue();
    const first = revokeKey([key], { keyId: KEY, revokedBy: ISSUER, reason: 'leaked' }, at(T1));
    const replay = revokeKey([first.key], { keyId: KEY, revokedBy: ISSUER, reason: 'leaked' }, at(T1));
    expect(replay.alreadyRevoked).toBe(true);
    expect(replay.event).toBeNull();
    expect(replay.key).toBe(first.key);
  });

  it('refuses to revoke an unknown key and validates its inputs', () => {
    expectCode(
      () => revokeKey([], { keyId: KEY, revokedBy: ISSUER, reason: 'x' }, at(T0)),
      'AUTH_KEY_NOT_FOUND',
    );
    const { key } = issue();
    expectCode(() => revokeKey([key], { keyId: KEY, revokedBy: ISSUER, reason: '  ' }, at(T0)), 'AUTH_REASON_REQUIRED');
    expectCode(() => revokeKey([key], { keyId: KEY, revokedBy: ' ' as unknown as Uuid, reason: 'x' }, at(T0)), 'AUTH_ACTOR_REQUIRED');
  });
});

// --- authentication decisions ------------------------------------------------------

describe('authenticateKey — denial precedence (deterministic)', () => {
  const issued = issue().key;

  it('success stamps lastUsedAt and emits no event', () => {
    const result = authenticateKey([issued], { orgId: ORG, secret: SECRET }, codec, at(T1));
    expect(result.authenticated).toBe(true);
    if (result.authenticated) {
      expect(result.event).toBeNull();
      expect(result.key.lastUsedAt?.toISOString()).toBe(T1);
      expect(result.key.keyId).toBe(KEY);
    }
  });

  it('denial table — every denial carries its stable code AND an auth.accessDenied audit event', () => {
    const cases: Array<{
      label: string;
      keys: readonly ApiKey[];
      secret: string;
      ownerStatus?: 'active' | 'suspended' | null;
      reason: string;
      aggregateId: Uuid | null;
    }> = [
      { label: 'unknown prefix', keys: [], secret: SECRET, reason: 'KEY_UNKNOWN', aggregateId: null },
      {
        label: 'secret shorter than a prefix',
        keys: [issued],
        secret: 'abc',
        reason: 'KEY_UNKNOWN',
        aggregateId: null,
      },
      {
        label: 'wrong secret for the prefix',
        keys: [issued],
        secret: PREFIX + 'totally-wrong-secret',
        reason: 'KEY_SECRET_MISMATCH',
        aggregateId: issued.keyId,
      },
    ];
    for (const c of cases) {
      const result = authenticateKey(c.keys, { orgId: ORG, secret: c.secret, ownerStatus: c.ownerStatus }, codec, at(T1));
      expect(result.authenticated, c.label).toBe(false);
      if (!result.authenticated) {
        expect(result.reason, c.label).toBe(c.reason);
        expect(result.event.name, c.label).toBe('auth.accessDenied');
        expect(result.event.aggregateId, c.label).toBe(c.aggregateId ?? ORG);
        expect(result.event.payload.permission).toBe(AUTH_ATTEMPT_PERMISSION);
      }
    }
  });

  it('a revoked key denies even when the secret still matches — replay is denied and audited', () => {
    const { key: revoked } = revokeKey([issued], { keyId: KEY, revokedBy: ISSUER, reason: 'leaked' }, at(T1));
    const result = authenticateKey([revoked], { orgId: ORG, secret: SECRET }, codec, at(T1));
    expect(result.authenticated).toBe(false);
    if (!result.authenticated) {
      expect(result.reason).toBe('KEY_REVOKED');
      expect(result.detail).toContain('replay');
      expect(result.event.payload.principalId).toBe(KEY);
    }
  });

  it('expiry is inclusive: denies at expiresAt, authenticates 1ms before', () => {
    const expiry = '2026-03-01T09:00:00.000Z';
    const { key } = issue({ expiresAt: new Date(expiry) });
    const before = authenticateKey(
      [key],
      { orgId: ORG, secret: SECRET },
      codec,
      at('2026-03-01T08:59:59.999Z'),
    );
    expect(before.authenticated).toBe(true);
    const atEdge = authenticateKey([key], { orgId: ORG, secret: SECRET }, codec, at(expiry));
    expect(atEdge.authenticated).toBe(false);
    if (!atEdge.authenticated) expect(atEdge.reason).toBe('KEY_EXPIRED');
  });

  it('the suspension cascade: a suspended owner denies a perfectly valid key', () => {
    const ok = authenticateKey([issued], { orgId: ORG, secret: SECRET, ownerStatus: 'active' }, codec, at(T1));
    expect(ok.authenticated).toBe(true);
    const cascaded = authenticateKey(
      [issued],
      { orgId: ORG, secret: SECRET, ownerStatus: 'suspended' },
      codec,
      at(T1),
    );
    expect(cascaded.authenticated).toBe(false);
    if (!cascaded.authenticated) expect(cascaded.reason).toBe('KEY_OWNER_INACTIVE');
  });

  it('denial precedence: revoked outranks expired, expired outranks owner status', () => {
    const expiry = '2026-03-01T08:01:00.000Z';
    const { key: revokedAndExpiring } = revokeKey(
      [issue({ expiresAt: new Date(expiry) }).key],
      { keyId: KEY, revokedBy: ISSUER, reason: 'leaked' },
      at(T1),
    );
    const both = authenticateKey(
      [revokedAndExpiring],
      { orgId: ORG, secret: SECRET, ownerStatus: 'suspended' },
      codec,
      at('2026-03-01T08:02:00.000Z'),
    );
    expect(both.authenticated).toBe(false);
    if (!both.authenticated) expect(both.reason).toBe('KEY_REVOKED');

    const { key: expiring } = issue({ expiresAt: new Date(expiry) });
    const expiredWithDeadOwner = authenticateKey(
      [expiring],
      { orgId: ORG, secret: SECRET, ownerStatus: 'suspended' },
      codec,
      at('2026-03-01T08:02:00.000Z'),
    );
    expect(expiredWithDeadOwner.authenticated).toBe(false);
    if (!expiredWithDeadOwner.authenticated) expect(expiredWithDeadOwner.reason).toBe('KEY_EXPIRED');
  });

  it('a broken codec throws AUTH_HASH_PORT_INVALID (never a silent denial)', () => {
    expectCode(
      () => authenticateKey([issued], { orgId: ORG, secret: SECRET }, {} as unknown as SecretCodec, at(T1)),
      'AUTH_HASH_PORT_INVALID',
    );
  });
});
