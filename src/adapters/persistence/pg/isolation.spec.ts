/**
 * Isolation specs (issue #73, acceptance criterion 3) — multi-org isolation
 * is enforced exactly HERE, in the PG adapters.
 *
 * The strongest version of the threat is proven, not asserted: TWO orgs are
 * given IDENTICAL aggregate ids (the same UUID strings) and DIFFERENT
 * financial facts. Every read is org-filtered, every write lands under the
 * writing org's scope, and cross-org identifiers can never leak a fact:
 *   - receivables / payments / cases: same ids, different amounts — each
 *     scoped store observes ONLY its org's version;
 *   - collections cases: a case carrying another org's id is refused
 *     (PG_ORG_SCOPE_MISMATCH);
 *   - org-less lane saves without a fixed scope are refused
 *     (PG_ORG_SCOPE_REQUIRED) — no fact may enter PostgreSQL un-scoped;
 *   - case sequences: the two orgs count independently from 1;
 *   - auth rows: the same user id may exist under two orgs, invisible to
 *     each other's scoped reads.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from '../../../domain/auth/user';
import { createInvoice, addInvoiceLine, issueInvoice } from '../../../domain/receivables/invoice';
import { openReceivable } from '../../../domain/receivables/receivable';
import { intakePayment } from '../../../domain/payments/intake';
import { openCase } from '../../../domain/collections/case';
import { Money } from '../../../domain/shared/money';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { PGClient } from './client';
import { PGAuthStore } from './authstore';
import { PGResourceStore } from './resourcestore';
import { PGScopeError } from './authstore';
import { bootstrapTestDb, purgeOrgs, testDatabaseUrl } from './testutil';

const T0 = '2026-03-01T08:00:00.000Z';
const clock: Clock = { now: () => new Date(T0) };

let seq = 0;
const nextId = (): Uuid => {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` as Uuid;
};

let config: Record<string, unknown>;
let client: PGClient;
const orgs: string[] = [];

beforeAll(async () => {
  config = (await bootstrapTestDb()) as unknown as Record<string, unknown>;
  client = new PGClient({ config: config as never });
});

afterEach(() => {
  seq = 0;
});

afterAll(async () => {
  await purgeOrgs(testDatabaseUrl(), orgs).catch(() => undefined);
  await client.close().catch(() => undefined);
});

const scoped = async (orgId: Uuid): Promise<PGResourceStore> => {
  const store = new PGResourceStore(new PGClient({ config: config as never }), { orgScope: orgId });
  await store.ensureReady();
  return store;
};

const makeReceivable = (amountMinor: number) => {
  const invoice = createInvoice({ id: nextId(), customerId: nextId(), currency: 'KES', dueDate: new Date('2026-04-01T00:00:00.000Z') });
  const withLine = addInvoiceLine(invoice, { description: 'Isolation fixture', amount: Money.ofMinor(amountMinor, 'KES') });
  const issued = issueInvoice(withLine, { sequenceNo: 1, reserveNumber: (n: number) => `ISO-${seq}-${n}` }, clock).invoice;
  return openReceivable(issued, nextId(), clock).receivable;
};

describe('multi-org isolation — identical ids, zero cross-org reads', () => {
  it('the SAME receivable id under two orgs carries two different facts and neither store sees the other', async () => {
    const orgA = nextId() as Uuid;
    const orgB = nextId() as Uuid;
    orgs.push(orgA, orgB);
    const sharedReceivableId = nextId();

    // build two receivables with the SAME id but different amounts
    const buildWithId = (amountMinor: number) => {
      const invoice = createInvoice({ id: nextId(), customerId: nextId(), currency: 'KES', dueDate: new Date('2026-04-01T00:00:00.000Z') });
      const withLine = addInvoiceLine(invoice, { description: 'Isolation fixture', amount: Money.ofMinor(amountMinor, 'KES') });
      const issued = issueInvoice(withLine, { sequenceNo: 1, reserveNumber: (n: number) => `ISO-A-${n}` }, clock).invoice;
      return openReceivable(issued, sharedReceivableId as Uuid, clock).receivable;
    };
    const originalMinor = (receivable: { readonly original: { readonly currency: string; readonly amount: string | number | bigint } }): number =>
      Number(receivable.original.amount);

    const forA = buildWithId(11_000);
    const forB = buildWithId(99_000);

    const storeA = await scoped(orgA);
    const storeB = await scoped(orgB);
    storeA.saveReceivable(forA);
    storeB.saveReceivable(forB);
    await Promise.all([storeA.flush(), storeB.flush()]);

    // each store observes exactly one row for the shared id — its own
    expect(storeA.receivables().filter((r) => r.id === sharedReceivableId)).toHaveLength(1);
    expect(storeB.receivables().filter((r) => r.id === sharedReceivableId)).toHaveLength(1);
    const seenA = storeA.receivables().find((r) => r.id === sharedReceivableId);
    const seenB = storeB.receivables().find((r) => r.id === sharedReceivableId);
    expect(originalMinor(seenA as never)).toBe(11_000);
    expect(originalMinor(seenB as never)).toBe(99_000);
  });

  it('payments under identical ids stay per-org (same id, different payer refs)', async () => {
    const orgA = nextId() as Uuid;
    const orgB = nextId() as Uuid;
    orgs.push(orgA, orgB);
    const sharedPaymentId = nextId();

    const build = (externalRef: string) => {
      seq += 1;
      const payment = intakePayment({
        channel: 'c2b',
        externalRef,
        idempotencyKey: `iso-${seq}`,
        amount: Money.ofMinor(5_000, 'KES'),
        paymentId: sharedPaymentId as Uuid,
      }, { clock }).payment;
      return payment;
    };

    const storeA = await scoped(orgA);
    const storeB = await scoped(orgB);
    storeA.savePayment(build('DARAJA-ORG-A'));
    storeB.savePayment(build('DARAJA-ORG-B'));
    await Promise.all([storeA.flush(), storeB.flush()]);

    expect(storeA.payments().filter((p) => p.id === sharedPaymentId)).toHaveLength(1);
    expect(storeB.payments().filter((p) => p.id === sharedPaymentId)).toHaveLength(1);
    expect((storeA.payments().find((p) => p.id === sharedPaymentId) as unknown as { externalRef: string }).externalRef).toBe('DARAJA-ORG-A');
    expect((storeB.payments().find((p) => p.id === sharedPaymentId) as unknown as { externalRef: string }).externalRef).toBe('DARAJA-ORG-B');
  });

  it('collections cases: a case of ANOTHER org is refused (PG_ORG_SCOPE_MISMATCH)', async () => {
    const orgA = nextId() as Uuid;
    const orgB = nextId() as Uuid;
    orgs.push(orgA, orgB);
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
  });

  it('org-less lane saves without a fixed scope are refused (PG_ORG_SCOPE_REQUIRED) — no fact enters PG un-scoped', async () => {
    const unscoped = new PGResourceStore(new PGClient({ config: config as never }));
    await unscoped.ensureReady();
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const receivable = makeReceivable(1_000);
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
        idempotencyKey: `iso-unscoped-${seq}`,
        amount: Money.ofMinor(500, 'KES'),
      }, { clock }).payment)).toThrow(PGScopeError);
    } finally {
      await unscoped.flush().catch(() => undefined);
    }
  });

  it('case sequences count independently per org (both start at 1)', async () => {
    const orgA = nextId() as Uuid;
    const orgB = nextId() as Uuid;
    orgs.push(orgA, orgB);
    const storeA = await scoped(orgA);
    const storeB = await scoped(orgB);
    expect(storeA.nextCaseSequence(orgA)).toBe(1);
    expect(storeA.nextCaseSequence(orgA)).toBe(2);
    expect(storeB.nextCaseSequence(orgB)).toBe(1);
    await Promise.all([storeA.flush(), storeB.flush()]);
  });

  it('auth rows: the same user id under two orgs is invisible across scoped reads', async () => {
    const orgA = nextId() as Uuid;
    const orgB = nextId() as Uuid;
    orgs.push(orgA, orgB);
    const sharedUserId = nextId();
    const sharedEmail = 'twin@fuatilia.test';

    const build = (orgId: Uuid, username: string) =>
      createUser([], {
        userId: sharedUserId,
        orgId,
        email: sharedEmail,
        username,
        displayName: 'Twin User',
      }, clock).user;

    const authA = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgA });
    const authB = new PGAuthStore(new PGClient({ config: config as never }), { orgScope: orgB });
    await Promise.all([authA.ensureReady(), authB.ensureReady()]);
    authA.saveUser(build(orgA, 'twin-a'));
    authB.saveUser(build(orgB, 'twin-b'));
    await Promise.all([authA.flush(), authB.flush()]);

    expect(authA.users().filter((u) => u.userId === sharedUserId)).toHaveLength(1);
    expect(authB.users().filter((u) => u.userId === sharedUserId)).toHaveLength(1);
    expect((authA.users().find((u) => u.userId === sharedUserId) as unknown as { username: string }).username).toBe('twin-a');
    expect((authB.users().find((u) => u.userId === sharedUserId) as unknown as { username: string }).username).toBe('twin-b');
  });
});
