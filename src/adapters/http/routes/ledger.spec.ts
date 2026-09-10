/**
 * The /v1/ledger/* read surface over the reference composition (issue #132):
 * the chart + journal DERIVED where the posting flow seeds them, §38
 * pagination/sort discipline, the closed `ledger:read` permission and the
 * read-only invariant — no read writes anything (R3).
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
const nextId = (): Uuid => uuid(`50000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);

// --- world seeding (the same shortcut payments.spec.ts documents) -----------------------

const grantPermissions = (
  authStore: InMemoryAuthStore,
  world: SeededWorld,
  permissions: readonly string[],
): void => {
  const { role } = defineRole(
    authStore.roles(),
    { roleId: nextId(), orgId: world.orgId, name: `Ledger-Role-${++seq}`, permissions: [...permissions] },
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

type Currency = 'KES' | 'USD';

const bearerOf = (world: SeededWorld): string => `Bearer ${world.sessionId}`;

/** Drive one intake → confirmation through the payments surface so the store holds lane-built rows. */
const seedConfirmedPayment = (
  kernel: ReturnType<typeof createHttpKernel>,
  world: SeededWorld,
  overrides: { readonly minor?: number; readonly currency?: Currency; readonly externalRef?: string } = {},
): { paymentId: string; externalRef: string } => {
  const externalRef = overrides.externalRef ?? `ext-${++seq}`;
  const amount = money(overrides.minor ?? 25_000, overrides.currency);
  const intake = call(kernel, 'POST', '/v1/payments/intake', {
    auth: `Bearer ${world.sessionId}`,
    body: {
      channel: 'c2b',
      externalRef,
      idempotencyKey: `idem-${++seq}`,
      amount,
    },
  });
  const paymentId = (intake.body as { data: { payment: { id: string } } }).data.payment.id;
  const confirm = call(kernel, 'POST', `/v1/payments/${paymentId}/confirmations`, {
    auth: `Bearer ${world.sessionId}`,
    body: { amount },
  });
  if (confirm.status !== 201) throw new Error(`seed confirm failed: ${confirm.status}`);
  return { paymentId, externalRef };
};

describe('GET /v1/ledger/accounts — the chart derived where the posting flow seeds it', () => {
  it('an empty store answers an empty page with the pagination envelope', () => {
    const { kernel, world } = makeWorld(['ledger:read']);
    const res = call(kernel, 'GET', '/v1/ledger/accounts', { auth: bearerOf(world) });
    expect(res.status).toBe(200);
    const body = res.body as { data: { accounts: unknown[] }; meta: { pagination: { nextCursor: string | null; total: number } } };
    expect(body.data.accounts).toEqual([]);
    expect(body.meta.pagination).toEqual({ nextCursor: null, total: 0 });
  });

  it('one confirmation seeds exactly the per-currency cash/AR asset pair', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'ledger:read']);
    seedConfirmedPayment(kernel, world, { minor: 25_000, currency: 'KES' });
    const res = call(kernel, 'GET', '/v1/ledger/accounts', { auth: bearerOf(world) });
    expect(res.status).toBe(200);
    const body = res.body as { data: { accounts: Array<{ id: string; code: string; name: string; kind: string; currency: string }> } };
    expect(body.data.accounts.map((a) => a.code)).toEqual(['cash-KES', 'ar-KES']);
    expect(body.data.accounts.every((a) => a.kind === 'asset' && a.currency === 'KES')).toBe(true);
    expect(body.data.accounts[0]!.name).toBe('Mobile Money Cash (KES)');
    expect(body.data.accounts[1]!.name).toBe('Accounts Receivable (KES)');
  });

  it('a second currency seeds its own pair; the code sort orders deterministically', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'ledger:read']);
    seedConfirmedPayment(kernel, world, { minor: 25_000, currency: 'KES' });
    seedConfirmedPayment(kernel, world, { minor: 1_000, currency: 'USD' });
    const desc = call(kernel, 'GET', '/v1/ledger/accounts', {
      auth: bearerOf(world),
      query: { sort: 'code', order: 'desc' },
    });
    const body = desc.body as { data: { accounts: Array<{ code: string }> } };
    expect(body.data.accounts.map((a) => a.code)).toEqual(['cash-USD', 'cash-KES', 'ar-USD', 'ar-KES']);
  });

  it('paginates with the strict boundaries and refuses outside the sort whitelist', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'ledger:read']);
    seedConfirmedPayment(kernel, world, { minor: 25_000, currency: 'KES' });
    seedConfirmedPayment(kernel, world, { minor: 1_000, currency: 'USD' });

    const page = call(kernel, 'GET', '/v1/ledger/accounts', { auth: bearerOf(world), query: { limit: '2' } });
    const paged = page.body as { data: { accounts: unknown[] }; meta: { pagination: { nextCursor: string | null; total: number } } };
    expect(paged.data.accounts).toHaveLength(2);
    expect(paged.meta.pagination).toEqual({ nextCursor: '2', total: 4 });
    const next = call(kernel, 'GET', '/v1/ledger/accounts', {
      auth: bearerOf(world),
      query: { limit: '2', cursor: '2' },
    });
    const rest = next.body as { data: { accounts: unknown[] }; meta: { pagination: { nextCursor: string | null } } };
    expect(rest.data.accounts).toHaveLength(2);
    expect(rest.meta.pagination.nextCursor).toBeNull();

    for (const query of [{ limit: '0' }, { limit: '101' }, { sort: 'balance' }] as Array<Record<string, string>>) {
      const refused = call(kernel, 'GET', '/v1/ledger/accounts', { auth: bearerOf(world), query });
      expect(refused.status, JSON.stringify(query)).toBe(400);
      expect((refused.body as { error: { code: string } }).error.code).toBe('HTTP_QUERY_INVALID');
    }
  });
});

describe('GET /v1/ledger/entries — the append-only journal, one row per line', () => {
  it('a confirmation posts exactly the balanced Dr cash / Cr AR pair with full provenance', () => {
    const { kernel, world, resources } = makeWorld(['payments:intake', 'ledger:read']);
    const { paymentId, externalRef } = seedConfirmedPayment(kernel, world, {
      minor: 25_000,
      currency: 'KES',
      externalRef: 'SJ91AB2KX1',
    });
    const res = call(kernel, 'GET', '/v1/ledger/entries', { auth: bearerOf(world) });
    expect(res.status).toBe(200);
    const body = res.body as {
      data: {
        entries: Array<{
          entryId: string;
          lineNo: number;
          accountCode: string;
          accountKind: string;
          direction: string;
          amount: { minor: number; currency: string };
          source: string;
          sourceRef: string | null;
          journalRef: string;
          postedAt: string;
          reversalOf: string | null;
        }>;
      };
      meta: { pagination: { total: number } };
    };
    expect(body.data.entries).toHaveLength(2);
    expect(body.meta.pagination.total).toBe(2);
    const [debit, credit] = body.data.entries;
    expect(debit!.entryId).toBe(credit!.entryId);
    expect(debit).toMatchObject({
      lineNo: 1,
      accountCode: 'cash-KES',
      direction: 'DEBIT',
      amount: { minor: 25_000, currency: 'KES' },
      source: 'payments',
      journalRef: `payment_confirmed:${paymentId}`,
      reversalOf: null,
    });
    expect(credit).toMatchObject({
      lineNo: 2,
      accountCode: 'ar-KES',
      direction: 'CREDIT',
      amount: { minor: 25_000, currency: 'KES' },
      source: 'payments',
    });
    expect(debit!.sourceRef).toBe(externalRef);
    expect(debit!.postedAt).toBe(T0);
    // the derived entry id is a pure function of the replay key — a re-read
    // answers the SAME entry id (and a replay can never double-post, R9's
    // ledger face)
    const again = call(kernel, 'GET', '/v1/ledger/entries', { auth: bearerOf(world) });
    expect((again.body as { data: { entries: Array<{ entryId: string }> } }).data.entries[0]!.entryId).toBe(
      debit!.entryId,
    );
    // the payment snapshot is untouched — a read is not a write
    expect(resources.payments()).toHaveLength(1);
  });

  it('the default order is the append-only write order and the tiebreak never shuffles lines', () => {
    const { kernel, world } = makeWorld(['payments:intake', 'ledger:read']);
    seedConfirmedPayment(kernel, world, { minor: 25_000, currency: 'KES' });
    seedConfirmedPayment(kernel, world, { minor: 1_000, currency: 'USD' });
    const desc = call(kernel, 'GET', '/v1/ledger/entries', {
      auth: bearerOf(world),
      query: { sort: 'postedAt', order: 'desc' },
    });
    const entries = (desc.body as { data: { entries: Array<{ entryId: string; lineNo: number }> } }).data.entries;
    expect(entries).toHaveLength(4);
    for (let i = 0; i < entries.length; i += 2) {
      expect(entries[i]!.entryId).toBe(entries[i + 1]!.entryId);
      expect([entries[i]!.lineNo, entries[i + 1]!.lineNo]).toEqual([1, 2]);
    }
    // outside the whitelist refuses
    const refused = call(kernel, 'GET', '/v1/ledger/entries', {
      auth: bearerOf(world),
      query: { sort: 'amount' },
    });
    expect(refused.status).toBe(400);
  });
});

describe('the ledger surface is permission-gated and strictly read-only', () => {
  it('anonymous access refuses 401; a principal without ledger:read refuses 403', () => {
    const { kernel } = makeWorld(['payments:intake', 'ledger:read']);
    const anonymous = call(kernel, 'GET', '/v1/ledger/accounts');
    expect(anonymous.status).toBe(401);
    expect((anonymous.body as { error: { code: string } }).error.code).toBe('HTTP_UNAUTHENTICATED');

    // a principal holding NO ledger grant (this world's role covers only the
    // intake vocabulary) refuses with the audited denial code
    const bare = makeWorld(['payments:intake']);
    seedConfirmedPayment(bare.kernel, bare.world);
    const forbidden = call(bare.kernel, 'GET', '/v1/ledger/entries', { auth: bearerOf(bare.world) });
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { error: { code: string } }).error.code).toBe('AUTH_ACCESS_DENIED');
  });

  it('no GET on the surface mutates the store or records an event (R3)', () => {
    const { kernel, world, resources } = makeWorld(['payments:intake', 'ledger:read']);
    seedConfirmedPayment(kernel, world);
    const paymentsBefore = resources.payments().length;
    const eventsBefore = resources.events().length;
    for (const path of ['/v1/ledger/accounts', '/v1/ledger/entries']) {
      const res = call(kernel, 'GET', path, { auth: bearerOf(world), query: { limit: '1', cursor: '1' } });
      expect(res.status).toBe(200);
    }
    expect(resources.payments()).toHaveLength(paymentsBefore);
    expect(resources.events()).toHaveLength(eventsBefore);
  });
});
