import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../domain/auth/guard';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import {
  accessDeniedEvent,
  authenticateRequest,
  authorizeRequest,
  NIL_ORG,
  parseAuthorization,
  type AuthOutcome,
  type AuthPort,
} from './auth';
import type { DenyReason } from '../../../domain/auth/events';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };
const ORG = uuid('00000000-0000-4000-8000-000000004501');
const USER = uuid('00000000-0000-4000-8000-000000004502');

const principalFor = (overrides: Partial<Principal> = {}): Principal => ({
  kind: 'user',
  principalId: USER,
  orgId: ORG,
  status: 'active',
  rules: [{ rule: 'receivables:read', roleId: uuid('00000000-0000-4000-8000-000000004503'), grantId: uuid('00000000-0000-4000-8000-000000004504'), resourceId: null }],
  ...overrides,
});

/** A recording port: outcomes answered from a fixed table, denials captured. */
const portWith = (
  outcome: AuthOutcome,
  captured: AccessEventList = [],
): AuthPort & { readonly captured: AccessEventList } => ({
  sessionPrincipal: () => outcome,
  apiKeyPrincipal: () => outcome,
  onDenied: (event) => captured.push(event),
  captured,
});
type AccessEventList = ReturnType<typeof accessDeniedEvent>[];

const okKey = (p: Principal): AuthOutcome => ({ authenticated: true, principal: p });
const deny = (code: string, reason: DenyReason): AuthOutcome => ({
  authenticated: false,
  code,
  message: `denied: ${code}`,
  reason,
  orgId: ORG,
  principalId: USER,
  principalKind: 'apiKey',
  event: null,
});

// --- header parsing -----------------------------------------------------------------

describe('parseAuthorization — the wire contract', () => {
  it('reads Bearer and ApiKey credentials (table)', () => {
    const cases: readonly { readonly header: string; readonly expected: ReturnType<typeof parseAuthorization> }[] = [
      { header: 'Bearer abc.def', expected: { kind: 'bearer', token: 'abc.def' } },
      { header: 'bearer abc.def', expected: { kind: 'bearer', token: 'abc.def' } },
      { header: 'ApiKey key-1.secret-part', expected: { kind: 'apiKey', id: 'key-1', secret: 'secret-part' } },
      { header: 'ApiKey id.with.dots', expected: { kind: 'apiKey', id: 'id', secret: 'with.dots' } },
    ];
    for (const c of cases) {
      expect(parseAuthorization(c.header)).toEqual(c.expected);
    }
  });

  it('answers "none" for a missing or blank header', () => {
    expect(parseAuthorization(undefined)).toEqual({ kind: 'none' });
    expect(parseAuthorization('   ')).toEqual({ kind: 'none' });
  });

  it('refuses malformed headers without echoing credential material (table)', () => {
    const cases: readonly { readonly header: string; readonly detail: string }[] = [
      { header: 'Bearer', detail: 'Authorization header must be' },
      { header: 'ApiKey nosecret', detail: 'ApiKey credentials must be' },
      { header: 'ApiKey .secret', detail: 'ApiKey credentials must be' },
      { header: 'ApiKey id.', detail: 'ApiKey credentials must be' },
      { header: 'Digest abc', detail: 'unsupported authorization scheme' },
      { header: 'BearerToken abc', detail: 'unsupported authorization scheme' },
    ];
    for (const c of cases) {
      const parsed = parseAuthorization(c.header);
      expect(parsed.kind, c.header).toBe('malformed');
      if (parsed.kind === 'malformed') expect(parsed.detail).toContain(c.detail);
    }
  });
});

// --- authentication (401) ------------------------------------------------------------

describe('authenticateRequest — 401 semantics with audited denials', () => {
  it('authenticates through the session and key paths to the SAME principal', () => {
    const p = principalFor();
    for (const outcome of [okKey(p)]) {
      const port = portWith(outcome);
      const viaSession = authenticateRequest({ authorization: 'Bearer tok' }, port, clock);
      const viaKey = authenticateRequest({ authorization: 'ApiKey id.sec' }, port, clock);
      expect(viaSession.ok && viaKey.ok && viaSession.principal).toBe(p);
      expect(port.captured).toHaveLength(0);
    }
  });

  it('a missing header is a 401 refusal AND an audited denial (deny-by-default is a fact)', () => {
    const captured: AccessEventList = [];
    const port = portWith(okKey(principalFor()), captured);
    const result = authenticateRequest({}, port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('HTTP_UNAUTHENTICATED');
      expect(result.message).toContain('Authorization');
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload.reason).toBe('PRINCIPAL_UNKNOWN');
    expect(captured[0]?.payload.orgId).toBe(NIL_ORG);
  });

  it('a malformed header is a 401 refusal with the parser detail, audited', () => {
    const port = portWith(okKey(principalFor()));
    const result = authenticateRequest({ authorization: 'Digest abc' }, port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('unsupported authorization scheme');
    expect(port.captured).toHaveLength(1);
  });

  it('credential refusals pass the lane code through and audit the lane event when paired (table)', () => {
    const cases: readonly { readonly name: string; readonly outcome: AuthOutcome; readonly header: string }[] = [
      { name: 'unknown key', outcome: deny('KEY_UNKNOWN', 'KEY_UNKNOWN'), header: 'ApiKey ghost.sec' },
      { name: 'secret mismatch', outcome: deny('KEY_SECRET_MISMATCH', 'KEY_SECRET_MISMATCH'), header: 'ApiKey k1.wrong' },
      { name: 'revoked key', outcome: deny('KEY_REVOKED', 'KEY_REVOKED'), header: 'ApiKey k1.sec' },
      { name: 'expired session', outcome: deny('SESSION_IDLE_EXPIRED', 'SESSION_IDLE_EXPIRED'), header: 'Bearer old' },
      { name: 'revoked session', outcome: deny('SESSION_REVOKED', 'SESSION_REVOKED'), header: 'Bearer gone' },
    ];
    for (const c of cases) {
      const captured: AccessEventList = [];
      const port = portWith(c.outcome, captured);
      const result = authenticateRequest({ authorization: c.header }, port, clock);
      expect(result.ok, c.name).toBe(false);
      if (!result.ok) expect(result.code, c.name).toBe((c.outcome as Extract<AuthOutcome, { authenticated: false }>).code);
      expect(captured, c.name).toHaveLength(1);
      expect(captured[0]?.payload.reason, c.name).toBe(
        (c.outcome as Extract<AuthOutcome, { authenticated: false }>).reason,
      );
    }
  });

  it('never echoes the presented credential in the refusal message', () => {
    const port = portWith(deny('KEY_UNKNOWN', 'KEY_UNKNOWN'));
    const result = authenticateRequest({ authorization: 'ApiKey k1.super-secret-value' }, port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('super-secret-value');
  });
});

// --- authorization (403) --------------------------------------------------------------

describe('authorizeRequest — 403 semantics with audited denials', () => {
  it('allows a principal holding the route permission', () => {
    const port = portWith(okKey(principalFor()));
    expect(authorizeRequest(principalFor(), 'receivables:read', port, clock)).toEqual({ ok: true });
    expect(port.captured).toHaveLength(0);
  });

  it('denies a principal without the permission and audits the CanDecision reason', () => {
    const port = portWith(okKey(principalFor()));
    const result = authorizeRequest(principalFor({ rules: [] }), 'receivables:read', port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('AUTH_ACCESS_DENIED');
      expect(result.reason).toBe('NO_GRANT');
      expect(result.message).toContain('receivables:read');
    }
    expect(port.captured).toHaveLength(1);
    expect(port.captured[0]?.payload.permission).toBe('receivables:read');
    expect(port.captured[0]?.payload.principalKind).toBe('user');
  });

  it('denies an unknown permission at the vocabulary and audits it', () => {
    const port = portWith(okKey(principalFor()));
    const result = authorizeRequest(principalFor(), 'ledger:rewrite-history', port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PERMISSION_UNKNOWN');
    expect(port.captured).toHaveLength(1);
  });

  it('a suspended principal is denied even with a valid grant', () => {
    const port = portWith(okKey(principalFor({ status: 'suspended' })));
    const result = authorizeRequest(principalFor({ status: 'suspended' }), 'receivables:read', port, clock);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PRINCIPAL_SUSPENDED');
    expect(port.captured).toHaveLength(1);
  });
});

// --- the audited denial event shape ---------------------------------------------------

describe('accessDeniedEvent — the auth.accessDenied fact', () => {
  it('carries the full §37 audit context and stamps the Clock instant', () => {
    const event = accessDeniedEvent(
      {
        orgId: ORG,
        principalId: USER,
        principalKind: 'user',
        permission: 'receivables:read',
        resource: null,
        reason: 'NO_GRANT',
        detail: 'no active grant',
      },
      clock,
    );
    expect(event.name).toBe('auth.accessDenied');
    expect(event.payload.orgId).toBe(ORG);
    expect(event.payload.at).toBe(T0);
  });

  it('denials before org identification use the nil-org aggregate', () => {
    const event = accessDeniedEvent(
      {
        orgId: null,
        principalId: null,
        principalKind: 'unknown',
        permission: 'auth:authenticate',
        resource: null,
        reason: 'PRINCIPAL_UNKNOWN',
        detail: 'no header',
      },
      clock,
    );
    expect(event.payload.orgId).toBe(NIL_ORG);
  });
});
