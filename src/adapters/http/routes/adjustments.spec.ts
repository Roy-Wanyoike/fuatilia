/**
 * The /v1/adjustments surface over the reference composition (issue #132):
 * the org-scoped feed plus the two DRY-RUN intent evaluators. The specs pin
 * the contract the DB-backed Go kernel answers too — the lane's refusal
 * tables travel as 200-body VALUES verbatim from
 * src/domain/adjustments/{credit-note,refund}.ts + shared/money.ts, the R6
 * ceiling is the payment snapshot's own math, and NOTHING is ever written
 * (R3/R6/R7).
 */
import { describe, expect, it } from 'vitest';
import type { Clock, Uuid } from '../../../domain/shared';
import { uuid } from '../../../domain/shared';
import { grantRole } from '../../../domain/auth/assignments';
import { ADMIN_MANAGE_USERS, defineRole, expandRolePermissions } from '../../../domain/auth/roles';
import { createHttpKernel } from '../server';
import { InMemoryAuthStore, seedWorld, type SeededWorld } from '../runtime/memory';
import { InMemoryResourceStore } from '../runtime/resources';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => uuid(`60000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);

// --- world seeding (the same shortcut payments.spec.ts documents) -----------------------

const grantPermissions = (
  authStore: InMemoryAuthStore,
  world: SeededWorld,
  permissions: readonly string[],
): void => {
  const { role } = defineRole(
    authStore.roles(),
    { roleId: nextId(), orgId: world.orgId, name: `Adjustments-Role-${++seq}`, permissions: [...permissions] },
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
      granterPermissions: [...new Set([...expandRolePermissions(role), ADMIN_MANAGE_USERS])],
    },
    clock,
  );
  if (!granted.granted) throw new Error('seed grant must succeed');
  authStore.saveGrant(granted.grant);
};

const makeWorld = (permissions: readonly string[]) => {
  const authStore = new InMemoryAuthStore();
  const world = seedWorld(authStore, clock);
  grantPermissions(authStore, world, permissions);
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

const bearerOf = (world: SeededWorld): string => `Bearer ${world.sessionId}`;

interface Seed {
  paymentId: string;
  externalRef: string;
}

/** Intake → confirm; the store then holds one confirmed 25_000 KES payment. */
const seedConfirmedPayment = (kernel: ReturnType<typeof createHttpKernel>, world: SeededWorld): Seed => {
  const externalRef = `ext-${++seq}`;
  const intake = call(kernel, 'POST', '/v1/payments/intake', {
    auth: bearerOf(world),
    body: {
      channel: 'c2b',
      externalRef,
      idempotencyKey: `idem-${++seq}`,
      amount: money(25_000),
    },
  });
  const paymentId = (intake.body as { data: { payment: { id: string } } }).data.payment.id;
  const confirm = call(kernel, 'POST', `/v1/payments/${paymentId}/confirmations`, {
    auth: bearerOf(world),
    body: { amount: money(25_000) },
  });
  if (confirm.status !== 201) throw new Error(`seed confirm failed: ${confirm.status}`);
  return { paymentId, externalRef };
};

/** A refund reservation over the payments surface (drops the R6 ceiling). */
const reserveRefund = (
  kernel: ReturnType<typeof createHttpKernel>,
  world: SeededWorld,
  paymentId: string,
  minor: number,
  reason: string,
): void => {
  const res = call(kernel, 'POST', `/v1/payments/${paymentId}/refund-reservations`, {
    auth: bearerOf(world),
    body: { amount: money(minor), reason },
  });
  if (res.status !== 201) throw new Error(`seed reservation failed: ${res.status}`);
};

const creditNoteBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  customerId: '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b',
  reason: 'goods returned — partial delivery shortfall',
  total: money(250_000),
  ...overrides,
});

describe('GET /v1/adjustments — the org-scoped discriminated feed', () => {
  it('an empty store answers an empty page; a reservation projects at the entry state', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'payments:refund', 'adjustments:request']);
    const empty = call(kernel, 'GET', '/v1/adjustments', { auth: bearerOf(world) });
    expect(empty.status).toBe(200);
    expect((empty.body as { data: { adjustments: unknown[] } }).data.adjustments).toEqual([]);

    const { paymentId } = seedConfirmedPayment(kernel, world);
    reserveRefund(kernel, world, paymentId, 10_000, 'goodwill');
    const res = call(kernel, 'GET', '/v1/adjustments', { auth: bearerOf(world) });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        adjustments: Array<{
          kind: string;
          id: string;
          paymentId: string;
          requestedBy: string | null;
          reason: string;
          total: { minor: number; currency: string };
          state: string;
          externalRef: string | null;
          rejectedReason: string | null;
          failedReason: string | null;
          createdAt: string;
        }>;
      };
      meta: { pagination: { nextCursor: string | null; total: number } };
    };
    expect(body.data.adjustments).toHaveLength(1);
    const row = body.data.adjustments[0]!;
    expect(row).toMatchObject({
      kind: 'refund',
      paymentId,
      requestedBy: null, // the reservation row carries no requester (see routes/adjustments.ts)
      reason: 'goodwill',
      total: { minor: 10_000, currency: 'KES' },
      state: 'requested',
      externalRef: null,
      rejectedReason: null,
      failedReason: null,
    });
    expect(row.createdAt).toBe(T0);
    expect(body.meta.pagination).toEqual({ nextCursor: null, total: 1 });
  });

  it('paginates multi-row feeds and refuses outside the sort whitelist', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'payments:refund', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    reserveRefund(kernel, world, paymentId, 10_000, 'first');
    reserveRefund(kernel, world, paymentId, 5_000, 'second');

    const page = call(kernel, 'GET', '/v1/adjustments', { auth: bearerOf(world), query: { limit: '1' } });
    const paged = page.body as { data: { adjustments: Array<{ reason: string }> }; meta: { pagination: { nextCursor: string | null; total: number } } };
    expect(paged.data.adjustments).toHaveLength(1);
    expect(paged.meta.pagination).toEqual({ nextCursor: '1', total: 2 });
    const rest = call(kernel, 'GET', '/v1/adjustments', {
      auth: bearerOf(world),
      query: { limit: '1', cursor: '1' },
    });
    expect((rest.body as { data: { adjustments: unknown[] } }).data.adjustments).toHaveLength(1);

    const sorted = call(kernel, 'GET', '/v1/adjustments', {
      auth: bearerOf(world),
      query: { sort: 'kind', order: 'desc' },
    });
    expect(sorted.status).toBe(200);
    const refused = call(kernel, 'GET', '/v1/adjustments', {
      auth: bearerOf(world),
      query: { sort: 'total' },
    });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
  });
});

describe('POST /v1/adjustments/credit-notes — the draft refusal table as values', () => {
  it('a clean proposal evaluates to a draft intent and writes NOTHING', () => {
    const { kernel, world, resources } = makeWorld(['payments:intake', 'adjustments:request']);
    seedConfirmedPayment(kernel, world);
    const paymentsBefore = resources.payments();
    const eventsBefore = resources.events().length;

    const res = call(kernel, 'POST', '/v1/adjustments/credit-notes', {
      auth: bearerOf(world),
      body: creditNoteBody({ invoiceId: '0f1e2d3c-4b5a-4968-8776-6554433221ff' }),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        intent: {
          id: string;
          customerId: string;
          invoiceId: string | null;
          reason: string;
          total: { minor: number; currency: string };
          state: string;
        } | null;
        accepted: boolean;
        refusals: unknown[];
      };
    };
    expect(body.data.accepted).toBe(true);
    expect(body.data.refusals).toEqual([]);
    expect(body.data.intent).toMatchObject({
      customerId: '11a2b3c4-d5e6-4789-8a0b-1c2d3e4f5a6b',
      invoiceId: '0f1e2d3c-4b5a-4968-8776-6554433221ff',
      reason: 'goods returned — partial delivery shortfall',
      total: { minor: 250_000, currency: 'KES' },
      state: 'draft',
    });
    expect(typeof body.data.intent!.id).toBe('string');

    // a proposal is not a fact: no payment row changed, no event was recorded
    expect(resources.payments()).toEqual(paymentsBefore);
    expect(resources.events()).toHaveLength(eventsBefore);
  });

  it('the independent value guards COLLECT (one proposal can fail both)', () => {
    const { kernel, world } = makeWorld(['adjustments:request']);
    const res = call(kernel, 'POST', '/v1/adjustments/credit-notes', {
      auth: bearerOf(world),
      body: creditNoteBody({ reason: '   ', total: money(0) }),
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        intent: unknown;
        accepted: boolean;
        refusals: Array<{ code: string; message: string; field: string; details: unknown }>;
      };
    };
    expect(body.data.accepted).toBe(false);
    expect(body.data.intent).toBeNull();
    expect(body.data.refusals).toEqual([
      { code: 'CREDIT_NOTE_REASON_REQUIRED', message: 'a credit note requires a reason', field: 'reason', details: null },
      { code: 'CREDIT_NOTE_TOTAL_INVALID', message: 'credit note total must be positive', field: 'total.minor', details: null },
    ]);
  });

  it('only JSON SHAPE is a transport 400 — blankness and non-positive minors are values', () => {
    const { kernel, world } = makeWorld(['adjustments:request']);
    for (const body of [
      creditNoteBody({ reason: 123 }),
      creditNoteBody({ total: { minor: '250000', currency: 'KES' } }),
      creditNoteBody({ total: { minor: 250_000, currency: 'XYZ' } }),
      creditNoteBody({ total: { minor: 0.5, currency: 'KES' } }),
      creditNoteBody({ customerId: 'not-a-uuid' }),
      { reason: 'x', total: money(100) }, // missing customerId
    ]) {
      const res = call(kernel, 'POST', '/v1/adjustments/credit-notes', { auth: bearerOf(world), body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');
    }
  });
});

describe('POST /v1/adjustments/refund-reservations — the R6 ceiling as a dry run', () => {
  it('a fitting proposal answers the Requested intent with the ceiling as an audit value', () => {
    const { kernel, world, resources } = makeWorld(['payments:intake', 'payments:refund', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    reserveRefund(kernel, world, paymentId, 10_000, 'goodwill'); // ceiling → 15_000
    const eventsBefore = resources.events().length;

    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId, amount: money(5_000), reason: 'duplicate deposit — refunding the overpayment' },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        intent: {
          id: string;
          paymentId: string;
          requestedBy: string;
          reason: string;
          total: { minor: number; currency: string };
          state: string;
          ceiling: { minor: number; currency: string };
        } | null;
        accepted: boolean;
        refusals: unknown[];
      };
    };
    expect(body.data.accepted).toBe(true);
    expect(body.data.refusals).toEqual([]);
    expect(body.data.intent).toMatchObject({
      paymentId,
      requestedBy: world.adminUserId, // defaults to the authenticated principal
      reason: 'duplicate deposit — refunding the overpayment',
      total: { minor: 5_000, currency: 'KES' },
      state: 'requested',
      ceiling: { minor: 15_000, currency: 'KES' },
    });
    expect(typeof body.data.intent!.id).toBe('string');

    // NOTHING was written: the reservation rows and the event log are unchanged
    const payment = resources.payments().find((p) => p.id === paymentId)!;
    expect(payment.refunds).toHaveLength(1); // only the seeded reservation
    expect(resources.events()).toHaveLength(eventsBefore);
  });

  it('an explicit requestedBy in the body rides the intent', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'payments:refund', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId, amount: money(1_000), reason: 'overpayment', requestedBy: world.adminUserId },
    });
    const intent = (res.body as { data: { intent: { requestedBy: string } | null } }).data.intent;
    expect(intent!.requestedBy).toBe(world.adminUserId);
  });

  it('the R6 ceiling refuses with the domain message and details as VALUES', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'payments:refund', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId, amount: money(25_001), reason: 'over the ceiling' },
    });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        intent: unknown;
        accepted: boolean;
        refusals: Array<{ code: string; message: string; field: string; details: Record<string, unknown> | null }>;
      };
    };
    expect(body.data.accepted).toBe(false);
    expect(body.data.intent).toBeNull();
    expect(body.data.refusals).toHaveLength(1);
    expect(body.data.refusals[0]).toMatchObject({
      code: 'REFUND_EXCEEDS_CEILING',
      message: 'refund 250.01 KES exceeds ceiling 250.00 KES',
      field: 'amount',
      details: { requestedMinor: 25_001, ceilingMinor: 25_000, paymentId },
    });
  });

  it('cross-currency refuses CURRENCY_MISMATCH before the comparison can succeed (R10)', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId, amount: money(1_000, 'USD'), reason: 'wrong wallet' },
    });
    expect(res.status).toBe(200);
    const refusals = (res.body as { data: { refusals: Array<{ code: string; message: string; field: string }> } }).data.refusals;
    expect(refusals).toEqual([
      { code: 'CURRENCY_MISMATCH', message: 'cannot compare USD with KES', field: 'amount.currency', details: null },
    ]);
  });

  it('an unconfirmed payment has nothing landed → ceiling 0 → any amount refuses', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'adjustments:request']);
    const intake = call(kernel, 'POST', '/v1/payments/intake', {
      auth: bearerOf(world),
      body: { channel: 'stk', externalRef: `ext-${++seq}`, idempotencyKey: `idem-${++seq}`, amount: money(2_000) },
    });
    const initiatedId = (intake.body as { data: { payment: { id: string } } }).data.payment.id;
    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId: initiatedId, amount: money(100), reason: 'too early' },
    });
    expect(res.status).toBe(200);
    const refusals = (res.body as { data: { refusals: Array<{ code: string; details: Record<string, unknown> | null }> } }).data.refusals;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.code).toBe('REFUND_EXCEEDS_CEILING');
    expect(refusals[0]!.details).toMatchObject({ requestedMinor: 100, ceilingMinor: 0, paymentId: initiatedId });
  });

  it('the independent value guards COLLECT; the requester defaults to the principal', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'adjustments:request']);
    const { paymentId } = seedConfirmedPayment(kernel, world);
    const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId, amount: money(0), reason: '   ' },
    });
    expect(res.status).toBe(200);
    const body = res.body as { data: { accepted: boolean; refusals: Array<{ code: string }> } };
    expect(body.data.accepted).toBe(false);
    const codes = body.data.refusals.map((r) => r.code).sort();
    expect(codes).toEqual(['REFUND_AMOUNT_INVALID', 'REFUND_REASON_REQUIRED']);
    // an authenticated principal is always the requester — the requester
    // refusal is unreachable over the wire (fail-closed kernel bug guard)
    expect(codes).not.toContain('REFUND_REQUESTER_REQUIRED');
  });

  it('an unknown payment answers the payments surface 404; only shape is a transport 400', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'adjustments:request']);
    const ghost = call(kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(world),
      body: { paymentId: '00000000-0000-4000-8000-00000000000f', amount: money(100), reason: 'ghost' },
    });
    expect(ghost.status).toBe(404);
    expect((ghost.body as { error: { code: string } }).error.code).toBe('HTTP_PAYMENT_NOT_FOUND');

    for (const body of [
      { paymentId: 'not-a-uuid', amount: money(100), reason: 'x' },
      { paymentId: '00000000-0000-4000-8000-00000000000f', amount: { minor: 1.5, currency: 'KES' }, reason: 'x' },
      { paymentId: '00000000-0000-4000-8000-00000000000f', amount: money(100), reason: 42 },
      { amount: money(100), reason: 'x' }, // missing paymentId
    ]) {
      const res = call(kernel, 'POST', '/v1/adjustments/refund-reservations', { auth: bearerOf(world), body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((res.body as { error: { code: string } }).error.code).toBe('HTTP_BODY_INVALID');
    }
  });
});

describe('the adjustments surface is permission-gated', () => {
  it('anonymous access refuses 401; a principal without adjustments:request refuses 403', () => {
    const { kernel } = makeWorld(['payments:intake', 'adjustments:request']);
    const anonymous = call(kernel, 'GET', '/v1/adjustments');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { error: { code: string } }).error.code).toBe('HTTP_UNAUTHENTICATED');
    const anonymousIntent = call(kernel, 'POST', '/v1/adjustments/credit-notes', {
      body: creditNoteBody(),
    });
    expect(anonymousIntent.status).toBe(401);

    const bare = makeWorld(['payments:intake']);
    const forbidden = call(bare.kernel, 'POST', '/v1/adjustments/refund-reservations', {
      auth: bearerOf(bare.world),
      body: { paymentId: '00000000-0000-4000-8000-00000000000f', amount: money(100), reason: 'x' },
    });
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');
  });
});
