/**
 * Isolation specs (issue #73, acceptance criterion 3) — multi-org isolation
 * is enforced exactly HERE, in the PG adapters, and the strongest form of
 * the threat is proven against the REAL schema.
 *
 * The financial-truth model of this platform (db/migrations, wave 9) makes
 * every aggregate id GLOBALLY unique (`id uuid PRIMARY KEY`), so an id can
 * never carry two orgs' facts. The isolation guarantees proven below:
 *   - a cross-org id collision is REFUSED at flush: the second org's write
 *     dies with PG_UNIQUE_VIOLATION and the first org's fact is untouched —
 *     no silent overwrite, no merge, no leak;
 *   - different facts under different orgs are invisible across scoped
 *     reads (a scoped store reads ONLY its org's rows);
 *   - collections cases: a case carrying another org's id is refused
 *     (PG_ORG_SCOPE_MISMATCH);
 *   - org-less lane saves without a fixed scope are refused
 *     (PG_ORG_SCOPE_REQUIRED) — no fact enters PostgreSQL un-scoped;
 *   - case sequences: the two orgs count independently from 1 (durable
 *     per-org hi-lo blocks);
 *   - auth rows: the same rule — a user id is global, a second org cannot
 *     register it, and scoped reads never leak the other org's user.
 *
 * Ids are unique per PROCESS (random run prefix): the lane cluster is
 * shared and rows survive until afterAll — a per-test reset would collide
 * with rows this or an earlier process already persisted (and boot-time
 * case-sequence reservations are durable by design).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../../domain/auth/user';
import { createInvoice, addInvoiceLine, issueInvoice } from '../../../domain/receivables/invoice';
import { openReceivable } from '../../../domain/receivables/receivable';
import { intakePayment } from '../../../domain/payments/intake';
import { openCase } from '../../../domain/collections/case';
import { Money } from '../../../domain/shared/money';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { PGClient } from './client';
import { PGAuthStore, PGScopeError } from './authstore';
import { PGResourceStore } from './resourcestore';
import { bootstrapTestDb, purgeOrgs, testDatabaseUrl } from './testutil';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const RUN_PREFIX = crypto.randomUUID().slice(0, 8);
const nextId = (): Uuid => {
  seq += 1;
  return `${RUN_PREFIX}-0000-4000-8000-${String(seq).padStart(12, '0')}` as Uuid;
};

let config: Record<string, unknown>;
let client: PGClient;
const orgs: string[] = [];

beforeAll(async () => {
  config = (await bootstrapTestDb()) as unknown as Record<string, unknown>;
  client = new PGClient({ config: config as never });
});

afterAll(async () => {
  await purgeOrgs(testDatabaseUrl(), orgs).catch(() => undefined);
  await client.close().catch(() => undefined);
});

const trackOrg = (orgId: Uuid): Uuid => {
  orgs.push(orgId);
  return orgId;
};

const scoped = async (orgId: Uuid): Promise<PGResourceStore> => {
  const store = new PGResourceStore(new PGClient({ config: config as never }), { orgScope: orgId });
  const report = await store.ensureReady();
  expect(report.quarantined).toBe(0);
  return store;
};

const makeReceivable = (orgId: Uuid, amountMinor: number, receivableId?: Uuid) => {
  const invoice = createInvoice({ id: nextId(), customerId: nextId(), currency: 'KES', dueDate: new Date('2026-04-01T00:00:00.000Z') });
  const withLine = addInvoiceLine(invoice, { description: 'Isolation fixture', amount: Money.ofMinor(amountMinor, 'KES') });
  const issued = issueInvoice(withLine, { sequenceNo: 1, reserveNumber: (n: number) => `ISO-${seq}-${n}` }, clock).invoice;
  return openReceivable(issued, receivableId ?? nextId(), clock).receivable;
};

const originalMinor = (receivable: { readonly original: { readonly currency: string; readonly amount: string | number | bigint } }): number =>
  Number(receivable.original.amount);

describe('multi-org isolation — collisions refused, reads scoped, sequences independent', () => {
  it('a cross-org id collision is REFUSED (PG_UNIQUE_VIOLATION) and the first org keeps its fact', async () => {
    const orgA = trackOrg(nextId());
    const orgB = trackOrg(nextId());
    const sharedReceivableId = nextId();

    const storeA = await scoped(orgA);
    const forA = makeReceivable(orgA, 11_000, sharedReceivableId);
    storeA.saveReceivable(forA);
    await storeA.flush();
    await storeA.close();

    // org B tries to persist a DIFFERENT fact under the SAME id — the
    // global primary key refuses the collision; nothing is overwritten.
    const storeB = await scoped(orgB);
    const forB = makeReceivable(orgB, 99_000, sharedReceivableId);
    storeB.saveReceivable(forB);
    await expect(storeB.flush()).rejects.toMatchObject({ code: 'PG_UNIQUE_VIOLATION' });
    // the sticky failure means close()'s final drain will re-throw — expected here
    await storeB.close().catch(() => undefined);

    // org A's fact survives untouched; org B holds nothing in PostgreSQL.
    const reA = await scoped(orgA);
    const seenA = reA.receivables().find((r) => r.id === sharedReceivableId);
    expect(seenA).toBeDefined();
    expect(originalMinor(seenA as never)).toBe(11_000);
    await reA.close();

    const reB = await scoped(orgB);
    expect(reB.receivables().filter((r) => r.id === sharedReceivableId)).toHaveLength(0);
    await reB.close();
  });

  it('different orgs, different ids: scoped reads never cross — each store sees exactly its org', async () => {
    const orgA = trackOrg(nextId());
    const orgB = trackOrg(nextId());

    const storeA = await scoped(orgA);
    const pA = intakePayment({
      channel: 'c2b',
      externalRef: 'DARAJA-ORG-A',
      idempotencyKey: `iso-${RUN_PREFIX}-${(seq += 1)}`,
      amount: Money.ofMinor(5_000, 'KES'),
    }, { clock }).payment;
    const rA = makeReceivable(orgA, 21_000);
    storeA.savePayment(pA);
    storeA.saveReceivable(rA);
    await storeA.flush();

    const storeB = await scoped(orgB);
    const pB = intakePayment({
      channel: 'c2b',
      externalRef: 'DARAJA-ORG-B',
      idempotencyKey: `iso-${RUN_PREFIX}-${(seq += 1)}`,
      amount: Money.ofMinor(7_500, 'KES'),
    }, { clock }).payment;
    const rB = makeReceivable(orgB, 33_000);
    storeB.savePayment(pB);
    storeB.saveReceivable(rB);
    await storeB.flush();

    // re-boot both scoped stores and prove the read scoping on REAL rows
    const reA = await scoped(orgA);
    expect(reA.payments().map((p) => p.externalRef)).toEqual(['DARAJA-ORG-A']);
    expect(reA.receivables().map((r) => r.id)).toEqual([rA.id]);
    await reA.close();

    const reB = await scoped(orgB);
    expect(reB.payments().map((p) => p.externalRef)).toEqual(['DARAJA-ORG-B']);
    expect(reB.receivables().map((r) => r.id)).toEqual([rB.id]);
    await reB.close();
    await storeA.close();
    await storeB.close();
  });

  it('collections cases: a case of ANOTHER org is refused (PG_ORG_SCOPE_MISMATCH)', async () => {
    const orgA = trackOrg(nextId());
    const orgB = trackOrg(nextId());
    const storeA = await scoped(orgA);
    const foreignCase = openCase({
      id: nextId(),
      orgId: orgB, // the case carries org B's identity…
      receivableIds: [nextId()],
      collectorId: nextId(),
      openedBy: 'collector-1',
      sequenceNo: 1,
    }, [], clock).case;

    // …but the adapter is scoped to org A — the mismatch is a typed refusal
    expect(() => storeA.saveCase(foreignCase)).toThrow(PGScopeError);
    try {
      storeA.saveCase(foreignCase);
    } catch (error) {
      expect((error as PGScopeError).code).toBe('PG_ORG_SCOPE_MISMATCH');
    }
    expect(storeA.cases()).toHaveLength(0);
    await storeA.close();
  });

  it('org-less lane saves without a fixed scope are refused (PG_ORG_SCOPE_REQUIRED) — no fact enters PG un-scoped', async () => {
    const unscoped = new PGResourceStore(new PGClient({ config: config as never }));
    await unscoped.ensureReady();
    const orgId = trackOrg(nextId());
    const receivable = makeReceivable(orgId, 1_000);
    try {
      expect(() => unscoped.saveReceivable(receivable)).toThrow(PGScopeError);
      try {
        unscoped.saveReceivable(receivable);
      } catch (error) {
        expect((error as PGScopeError).code).toBe('PG_ORG_SCOPE_REQUIRED');
      }
      expect(() => unscoped.savePayment(intakePayment({
        channel: 'c2b',
        externalRef: 'UNSCOPED-REF',
        idempotencyKey: `iso-unscoped-${RUN_PREFIX}-${(seq += 1)}`,
        amount: Money.ofMinor(500, 'KES'),
      }, { clock }).payment)).toThrow(PGScopeError);
    } finally {
      await unscoped.flush().catch(() => undefined);
      await unscoped.close();
    }
  });

  it('case sequences count independently per org (both start at 1)', async () => {
    const orgA = trackOrg(nextId());
    const orgB = trackOrg(nextId());
    const storeA = await scoped(orgA);
    const storeB = await scoped(orgB);
    expect(storeA.nextCaseSequence(orgA)).toBe(1);
    expect(storeA.nextCaseSequence(orgA)).toBe(2);
    expect(storeB.nextCaseSequence(orgB)).toBe(1);
    await Promise.all([storeA.flush(), storeB.flush()]);
    await storeA.close();
    await storeB.close();
  });

  it('auth rows: a user id is global — a second org cannot register it, and scoped reads never leak', async () => {
    const orgA = trackOrg(nextId());
    const orgB = trackOrg(nextId());
    const sharedUserId = nextId();

    const build = (orgId: Uuid, username: string) =>
      createUser([], {
        userId: sharedUserId,
        orgId,
        email: 'twin@fuatilia.test',
        username,
        displayName: 'Twin User',
      }, clock).user;

    const authA = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgA });
    await authA.ensureReady();
    authA.saveUser(build(orgA, 'twin-a'));
    await authA.flush();

    // the same id under org B is refused by the global primary key
    const authB = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgB });
    await authB.ensureReady();
    authB.saveUser(build(orgB, 'twin-b'));
    await expect(authB.flush()).rejects.toMatchObject({ code: 'PG_UNIQUE_VIOLATION' });
    // sticky failure: close()'s final drain re-throws — expected here
    await authB.close().catch(() => undefined);

    // org A's user is intact; org B holds nothing
    const reA = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgA });
    await reA.ensureReady();
    const seen = reA.users().find((u) => u.userId === sharedUserId);
    expect((seen as unknown as { username: string }).username).toBe('twin-a');
    const reB = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgB });
    await reB.ensureReady();
    expect(reB.users().filter((u) => u.userId === sharedUserId)).toHaveLength(0);

    // authB is already closed above (its sticky failure makes close() throw);
    // closing it twice would re-throw the restored batch's flush failure.
    await authA.close();
    await reA.close();
    await reB.close();
  });
});
