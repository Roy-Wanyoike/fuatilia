import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import { Money } from '../../../domain/shared/money';
import { grantRole } from '../../../domain/auth/assignments';
import { issueKey } from '../../../domain/auth/apikeys';
import { ADMIN_MANAGE_USERS, defineRole, expandRolePermissions } from '../../../domain/auth/roles';
import {
  failPayment,
  recordAllocationReservation,
} from '../../../domain/payments/payment';
import { createHttpKernel } from '../server';
import { InMemoryAuthStore, seedWorld, type SeededWorld } from '../runtime/memory';
import { InMemoryResourceStore } from '../runtime/resources';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => uuid(`40000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);

// --- world seeding -----------------------------------------------------------------------

/** Grant the seeded admin a role carrying exactly these permissions (spec-seeding shortcut). */
const grantPermissions = (
  authStore: InMemoryAuthStore,
  world: SeededWorld,
  permissions: readonly string[],
  roleName: string,
): void => {
  const { role } = defineRole(
    authStore.roles(),
    { roleId: nextId(), orgId: world.orgId, name: roleName, permissions: [...permissions] },
    clock,
  );
  authStore.saveRole(role);
  const granted = grantRole(
    authStore.grants(),
    {
      grantId: nextId(),
      orgId: world.orgId,
      userId: world.adminUserId,
      role,
      grantedBy: world.adminUserId,
      // Spec seeding: the seed world's granter set does not include lane
      // permissions, so the grant is seeded with the role's own expansion
      // PLUS the role-administration permission the escalation guard demands
      // (the same shortcut runtime/memory.ts seedWorld uses).
      granterPermissions: [...new Set([...expandRolePermissions(role), ADMIN_MANAGE_USERS])],
    },
    clock,
  );
  if (!granted.granted) throw new Error('seed grant must succeed');
  authStore.saveGrant(granted.grant);
};

const seedKeyWithScopes = (authStore: InMemoryAuthStore, world: SeededWorld, scopes: readonly string[]): Uuid => {
  const issued = issueKey(
    [],
    {
      keyId: nextId(),
      orgId: world.orgId,
      name: `spec-key-${seq}`,
      createdBy: world.adminUserId,
      secret: 'fuatilia-spec-key-secret-001',
      scopes: [...scopes],
    },
    authStore.codec,
    clock,
  );
  authStore.saveKey(issued.key);
  authStore.record(issued.event);
  return issued.key.keyId;
};

const makeWorld = (options: { readonly permissions?: readonly string[] } = {}) => {
  const authStore = new InMemoryAuthStore();
  const world = seedWorld(authStore, clock);
  if (options.permissions) grantPermissions(authStore, world, options.permissions, `Role-${++seq}`);
  const resources = new InMemoryResourceStore();
  const kernel = createHttpKernel({ store: authStore, resourceStore: resources, clock });
  return { authStore, world, resources, kernel };
};

const call = (
  kernel: ReturnType<typeof createHttpKernel>,
  method: string,
  path: string,
  opts: { body?: unknown; auth?: string; query?: Record<string, string> } = {},
) =>
  kernel.handle({
    method,
    path,
    headers: opts.auth ? { authorization: opts.auth } : {},
    rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    query: opts.query,
  });

const money = (minor: number, currency = 'KES') => ({ minor, currency });

const intakeBody = (overrides: Record<string, unknown> = {}) => ({
  channel: 'c2b',
  externalRef: 'SJ91AB2KX1',
  idempotencyKey: 'journey-001',
  amount: money(25_000),
  ...overrides,
});

/** Drive one intake through the wire so the store holds a lane-built payment. */
const seedPaymentOverTheWire = (
  kernel: ReturnType<typeof createHttpKernel>,
  world: SeededWorld,
  overrides: Record<string, unknown> = {},
): { id: string; status: number } => {
  const res = call(kernel, 'POST', '/v1/payments/intake', {
    auth: `Bearer ${world.sessionId}`,
    body: intakeBody(overrides),
  });
  const data = res.body as { data: { payment: { id: string } } };
  return { id: data.data.payment.id, status: res.status };
};

const eventNames = (resources: InMemoryResourceStore): string[] => resources.events().map((e) => e.name);

// --- composition --------------------------------------------------------------------------

describe('route-table composition — /v1/payments mounted on the kernel', () => {
  it('exposes the intake/lookup/refund rows with their concrete vocabulary permissions', () => {
    const { kernel } = makeWorld();
    const rows = kernel.routes
      .filter((r) => r.pattern.startsWith('/v1/payments'))
      .map((r) => `${r.method} ${r.pattern} → ${r.permission}`)
      .sort();
    expect(rows).toEqual([
      'GET /v1/payments → payments:read',
      'GET /v1/payments/:paymentId → payments:read',
      'POST /v1/payments/:paymentId/confirmations → payments:intake',
      'POST /v1/payments/:paymentId/refund-reservations → payments:refund',
      'POST /v1/payments/intake → payments:intake',
    ]);
  });
});

// --- intake (payments:intake) --------------------------------------------------------------

describe('POST /v1/payments/intake — the ONE funnel (R9/C5 idempotency)', () => {
  it('intakes a new payment → 201, initiated state, payment.initiated recorded', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const res = call(kernel, 'POST', '/v1/payments/intake', { auth: `Bearer ${world.sessionId}`, body: intakeBody() });
    expect(res.status).toBe(201);
    const data = (res.body as { data: { payment: Record<string, unknown>; duplicate: boolean } }).data;
    expect(data.duplicate).toBe(false);
    expect(data.payment.state).toBe('initiated');
    expect(data.payment.externalRef).toBe('SJ91AB2KX1');
    expect(data.payment.requested).toEqual({ minor: 25_000, currency: 'KES' });
    expect(eventNames(resources)).toEqual(['payment.initiated']);
    expect(resources.payments()).toHaveLength(1);
  });

  it('replays the same (channel, externalRef) → 200 with the EXISTING payment + duplicate tripwire', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const first = seedPaymentOverTheWire(kernel, world);
    const second = seedPaymentOverTheWire(kernel, world);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(resources.payments()).toHaveLength(1); // never a second Payment
    expect(eventNames(resources)).toEqual(['payment.initiated', 'payments.duplicateCallbackObserved']);
    expect(second.id).toBe(first.id);
  });

  it('a duplicate under a different externalRef but the SAME idempotencyKey is still the same payment', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    seedPaymentOverTheWire(kernel, world);
    const replay = seedPaymentOverTheWire(kernel, world, { externalRef: 'OTHER-DARAJA-ID' });
    expect(replay.status).toBe(200);
    expect(resources.payments()).toHaveLength(1);
  });

  it('a duplicate carrying DIFFERENT money is refused → 409 DUPLICATE_AMOUNT_MISMATCH', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake'] });
    seedPaymentOverTheWire(kernel, world);
    const res = call(kernel, 'POST', '/v1/payments/intake', {
      auth: `Bearer ${world.sessionId}`,
      body: intakeBody({ amount: money(99_999) }),
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('DUPLICATE_AMOUNT_MISMATCH');
  });

  it('a duplicate carrying a different currency is refused → 409 CURRENCY_MISMATCH (R10)', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake'] });
    seedPaymentOverTheWire(kernel, world);
    const res = call(kernel, 'POST', '/v1/payments/intake', {
      auth: `Bearer ${world.sessionId}`,
      body: intakeBody({ amount: money(25_000, 'USD') }),
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CURRENCY_MISMATCH');
  });

  it('rejects malformed bodies with 400 HTTP_BODY_INVALID before the lane is called (table)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const cases: readonly { readonly name: string; readonly body: unknown }[] = [
      { name: 'not an object', body: [1, 2, 3] },
      { name: 'missing channel', body: { externalRef: 'X', idempotencyKey: 'k', amount: money(100) } },
      { name: 'unknown channel', body: intakeBody({ channel: 'ussd' }) },
      { name: 'blank externalRef', body: intakeBody({ externalRef: '   ' }) },
      { name: 'missing idempotencyKey', body: { channel: 'c2b', externalRef: 'X', amount: money(100) } },
      { name: 'zero amount', body: intakeBody({ amount: money(0) }) },
      { name: 'negative amount', body: intakeBody({ amount: money(-5) }) },
      { name: 'fractional minor units', body: intakeBody({ amount: money(10.5) }) },
      { name: 'unknown currency', body: intakeBody({ amount: { minor: 100, currency: 'XAF' } }) },
      { name: 'amount not an object', body: intakeBody({ amount: 25_000 }) },
      { name: 'declaredRefs not strings', body: intakeBody({ declaredRefs: [42] }) },
      { name: 'customerId not a UUID', body: intakeBody({ customerId: 'cust-7' }) },
    ];
    for (const c of cases) {
      const res = call(kernel, 'POST', '/v1/payments/intake', { auth: `Bearer ${world.sessionId}`, body: c.body });
      expect(res.status, c.name).toBe(400);
      expect((res.body as { error: { code: string } }).error.code, c.name).toBe('HTTP_BODY_INVALID');
    }
    expect(resources.payments()).toHaveLength(0); // nothing persisted from bad shapes
    expect(eventNames(resources)).toEqual([]);
  });
});

// --- confirmations (payments:intake) ---------------------------------------------------------

describe('POST /v1/payments/:paymentId/confirmations — the Daraja success callback', () => {
  it('confirms an initiated payment → 201 confirmed, payment.confirmed recorded, unapplied = confirmed', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    const res = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    expect(res.status).toBe(201);
    const data = (res.body as { data: { payment: Record<string, unknown>; alreadyConfirmed: boolean } }).data;
    expect(data.alreadyConfirmed).toBe(false);
    expect(data.payment.state).toBe('confirmed');
    expect(data.payment.confirmed).toEqual({ minor: 25_000, currency: 'KES' });
    expect(data.payment.unapplied).toEqual({ minor: 25_000, currency: 'KES' }); // R2: nothing committed yet
    expect(eventNames(resources)).toEqual(['payment.initiated', 'payment.confirmed']);
  });

  it('replays the SAME amount → 200 alreadyConfirmed, no new event (confirmedMinor set exactly once)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    const first = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    const replay = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((replay.body as { data: { alreadyConfirmed: boolean } }).data.alreadyConfirmed).toBe(true);
    expect(eventNames(resources).filter((name) => name === 'payment.confirmed')).toHaveLength(1);
  });

  it('replays with a DIFFERENT amount → 409 CONFIRMED_AMOUNT_MISMATCH (untrusted input)', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });
    const res = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(26_000) },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CONFIRMED_AMOUNT_MISMATCH');
  });

  it('a terminal payment refuses confirmation → 409 PAYMENT_TERMINAL', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    const payment = resources.payments()[0];
    if (!payment) throw new Error('seed payment missing');
    const { payment: failed } = failPayment(payment, 'INSUFFICIENT_FUNDS', clock);
    resources.savePayment(failed);

    const res = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('PAYMENT_TERMINAL');
  });

  it('confirming an already-allocated payment is a state conflict → 409 INVALID_TRANSITION', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    const payment = resources.payments()[0];
    if (!payment) throw new Error('seed payment missing');
    const { payment: confirmed } = ((): { payment: typeof payment } => {
      const result = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
        auth: `Bearer ${world.sessionId}`,
        body: { amount: money(25_000) },
      });
      const stored = resources.payments().find((p) => p.id === id);
      if (result.status !== 201 || !stored) throw new Error('seed confirmation failed');
      return { payment: stored };
    })();
    const { payment: allocated } = recordAllocationReservation(
      confirmed,
      { receivableId: nextId(), amount: Money.ofMinor(25_000, 'KES') },
      clock,
    );
    resources.savePayment(allocated);

    const res = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_TRANSITION');
  });

  it('rejects a malformed amount shape → 400 HTTP_BODY_INVALID', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    const res = call(kernel, 'POST', `/v1/payments/${id}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: { minor: 'lots', currency: 'KES' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');
  });

  it('an unknown payment → 404 HTTP_PAYMENT_NOT_FOUND', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake'] });
    const ghost = nextId();
    const res = call(kernel, 'POST', `/v1/payments/${ghost}/confirmations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(25_000) },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_PAYMENT_NOT_FOUND');
  });
});

// --- lookup (payments:read) -------------------------------------------------------------------

describe('GET /v1/payments/:paymentId and GET /v1/payments — the payment read model', () => {
  it('serves the aggregate view (rows persist exactly what the lane decided)', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake', 'payments:read'] });
    const { id } = seedPaymentOverTheWire(kernel, world, {
      customerId: nextId(),
      declaredRefs: ['INV-7', 'INV-7', ' RCPT-2 '], // the lane trims + dedupes
    });
    const res = call(kernel, 'GET', `/v1/payments/${id}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(200);
    const view = (res.body as { data: { payment: Record<string, unknown> } }).data.payment;
    expect(view.id).toBe(id);
    expect(view.declaredRefs).toEqual(['INV-7', 'RCPT-2']);
    expect(view.allocations).toEqual([]);
    expect(view.refunds).toEqual([]);
    expect(resources.payments()).toHaveLength(1);
  });

  it('an unknown payment → 404 HTTP_PAYMENT_NOT_FOUND', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:read'] });
    const res = call(kernel, 'GET', `/v1/payments/${nextId()}`, { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_PAYMENT_NOT_FOUND');
  });

  it('lists payments with pagination meta', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake', 'payments:read'] });
    seedPaymentOverTheWire(kernel, world, { externalRef: 'R-1', idempotencyKey: 'k-1' });
    seedPaymentOverTheWire(kernel, world, { externalRef: 'R-2', idempotencyKey: 'k-2' });
    const res = call(kernel, 'GET', '/v1/payments', { auth: `Bearer ${world.sessionId}`, query: { limit: '1' } });
    expect(res.status).toBe(200);
    const body = res.body as { data: { payments: unknown[] }; meta: { pagination: { nextCursor: string; total: number } } };
    expect(body.data.payments).toHaveLength(1);
    expect(body.meta.pagination.total).toBe(2);
    expect(body.meta.pagination.nextCursor).toBe('1');

    const page2 = call(kernel, 'GET', '/v1/payments', {
      auth: `Bearer ${world.sessionId}`,
      query: { limit: '1', cursor: body.meta.pagination.nextCursor },
    });
    expect((page2.body as { data: { payments: unknown[] } }).data.payments).toHaveLength(1);
    expect((page2.body as { meta: { pagination: { nextCursor: string | null } } }).meta.pagination.nextCursor).toBeNull();
  });

  it('refuses a garbage cursor → 400 HTTP_QUERY_INVALID', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:read'] });
    const res = call(kernel, 'GET', '/v1/payments', { auth: `Bearer ${world.sessionId}`, query: { cursor: 'ZZZ' } });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
  });
});

// --- refund lifecycle (payments:refund) --------------------------------------------------------

describe('POST /v1/payments/:paymentId/refund-reservations — the R6 ceiling', () => {
  it('reserves a refund on confirmed funds → 201, refunds row appended, unapplied shrinks', () => {
    const { kernel, world, resources } = makeWorld({ permissions: ['payments:intake', 'payments:refund'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });

    const res = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(5_000), reason: 'payer double-paid one instalment' },
    });
    expect(res.status).toBe(201);
    const view = (res.body as { data: { payment: { refunds: { amount: { minor: number }; reason: string }[]; unapplied: { minor: number } } } }).data.payment;
    expect(view.refunds).toHaveLength(1);
    expect(view.refunds[0]?.amount.minor).toBe(5_000);
    expect(view.unapplied.minor).toBe(20_000); // confirmed 25_000 − refunds 5_000 — the lane's derivation
    // The lane emits no event here: the Refunded edges belong to the adjustments lane.
    expect(eventNames(resources)).toEqual(['payment.initiated', 'payment.confirmed']);
  });

  it('a refund beyond the available funds is refused → 422 REFUND_EXCEEDS_AVAILABLE', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake', 'payments:refund'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });

    const res = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(30_000), reason: 'over-draw' },
    });
    expect(res.status).toBe(422);
    expect((res.body as { error: { code: string } }).error.code).toBe('REFUND_EXCEEDS_AVAILABLE');
  });

  it('refunds draw on CONFIRMED funds only → 409 PAYMENT_NOT_CONFIRMED', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake', 'payments:refund'] });
    const { id } = seedPaymentOverTheWire(kernel, world); // state: initiated — confirmation never arrives
    const res = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(1_000), reason: 'too early' },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('PAYMENT_NOT_CONFIRMED');
  });

  it('a cross-currency refund is refused → 409 CURRENCY_MISMATCH (R10)', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake', 'payments:refund'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });

    const res = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(1_000, 'USD'), reason: 'wrong currency' },
    });
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('CURRENCY_MISMATCH');
  });

  it('a blank reason and a malformed amount are body-shape rejections → 400 HTTP_BODY_INVALID', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:intake', 'payments:refund'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });

    const blank = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(1_000), reason: '' },
    });
    expect(blank.status).toBe(400);
    expect((blank.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');

    const badAmount = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { reason: 'ok', amount: money(0) },
    });
    expect(badAmount.status).toBe(400);
    expect((badAmount.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');
  });

  it('an unknown payment → 404 HTTP_PAYMENT_NOT_FOUND', () => {
    const { kernel, world } = makeWorld({ permissions: ['payments:refund'] });
    const res = call(kernel, 'POST', `/v1/payments/${nextId()}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(1_000), reason: 'ghost' },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_PAYMENT_NOT_FOUND');
  });
});

// --- the permission boundary ------------------------------------------------------------------

describe('the permission boundary over /v1/payments', () => {
  it('payments:read alone cannot intake → 403 with the denial AUDITED (payments:intake)', () => {
    const { kernel, authStore, world } = makeWorld({ permissions: ['payments:read'] });
    const res = call(kernel, 'POST', '/v1/payments/intake', { auth: `Bearer ${world.sessionId}`, body: intakeBody() });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');
    expect(resources_payments(authStore)).toBe(0); // nothing written

    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect(denial).toBeDefined();
    expect((denial?.payload as { permission: string }).permission).toBe('payments:intake');
  });

  it('payments:intake alone cannot read → 403 with the denial AUDITED (payments:read)', () => {
    const { kernel, authStore, world } = makeWorld({ permissions: ['payments:intake'] });
    const res = call(kernel, 'GET', '/v1/payments', { auth: `Bearer ${world.sessionId}` });
    expect(res.status).toBe(403);
    expect((res.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');

    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect(denial).toBeDefined();
    expect((denial?.payload as { permission: string }).permission).toBe('payments:read');
  });

  it('payments:refund is its own authority — intake alone cannot refund → 403 (audited)', () => {
    const { kernel, authStore, world, resources } = makeWorld({ permissions: ['payments:intake'] });
    const { id } = seedPaymentOverTheWire(kernel, world);
    call(kernel, 'POST', `/v1/payments/${id}/confirmations`, { auth: `Bearer ${world.sessionId}`, body: { amount: money(25_000) } });

    const res = call(kernel, 'POST', `/v1/payments/${id}/refund-reservations`, {
      auth: `Bearer ${world.sessionId}`,
      body: { amount: money(1_000), reason: 'no refund authority' },
    });
    expect(res.status).toBe(403);
    const denial = authStore.events().find((event) => event.name === 'auth.accessDenied');
    expect((denial?.payload as { permission: string }).permission).toBe('payments:refund');
    expect(resources.payments().find((p) => p.id === id)?.refunds).toHaveLength(0);
  });

  it('an unauthenticated intake is 401 and audited', () => {
    const { kernel, authStore, resources } = makeWorld({ permissions: ['payments:intake'] });
    const res = call(kernel, 'POST', '/v1/payments/intake', { body: intakeBody() });
    expect(res.status).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_UNAUTHENTICATED');
    expect(authStore.events().some((event) => event.name === 'auth.accessDenied')).toBe(true);
    expect(resources.payments()).toHaveLength(0);
  });
});

const resources_payments = (authStore: InMemoryAuthStore): number =>
  authStore.events().filter((event) => event.name === 'payment.initiated').length;
