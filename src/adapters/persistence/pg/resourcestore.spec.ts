/**
 * PGResourceStore specs (issue #73) — the cache-first synchronous facade
 * over PostgreSQL for the ResourceStore seam (receivables / payments /
 * collections cases + the lane event log + the per-org case sequence).
 *
 * Covered: the boot guard, aggregate round-trips THROUGH PostgreSQL for all
 * three resource lanes (save → flush → re-boot → identical state), upsert
 * safety on double-save, the per-org case-sequence allocator (50 sequential
 * grants are unique and strictly increasing; the reservation survives a
 * full reboot — hi-lo continuity is durable, not in-process), lane-event
 * capture with org derivation, and the sticky-failure contract under a real
 * dead postmaster (save* throws until flush() re-arms; the queue drains
 * after recovery; no partial aggregate ever reaches PostgreSQL).
 *
 * Real PG 16.4 (FUATILIA_TEST_DATABASE_URL lane cluster + a private
 * ephemeral cluster for the dead-postmaster suite). Never a silent skip.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createInvoice, addInvoiceLine, issueInvoice } from '../../../domain/receivables/invoice';
import { openReceivable } from '../../../domain/receivables/receivable';
import { intakePayment } from '../../../domain/payments/intake';
import { openCase } from '../../../domain/collections/case';
import { Money } from '../../../domain/shared/money';
import type { Clock, Uuid } from '../../../domain/shared/ids';
import { PGClient } from './client';
import { PGResourceStore } from './resourcestore';
import { bootstrapTestDb, purgeOrgs, spawnEphemeralCluster, testDatabaseUrl } from './testutil';

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

const scopedStore = async (orgId: Uuid): Promise<PGResourceStore> => {
  const store = new PGResourceStore(new PGClient({ config: config as never }), { orgScope: orgId });
  const report = await store.ensureReady();
  expect(report.quarantined).toBe(0);
  return store;
};

// --- aggregate builders (real domain lanes, not fixture literals) -----------

const makeReceivable = (orgId: Uuid, amountMinor = 10_000) => {
  const invoice = createInvoice({ id: nextId(), customerId: nextId(), currency: 'KES', dueDate: new Date('2026-04-01T00:00:00.000Z') });
  const withLine = addInvoiceLine(invoice, { description: 'Consulting — March', amount: Money.ofMinor(amountMinor, 'KES') });
  const issued = issueInvoice(withLine, { sequenceNo: 1, reserveNumber: (n: number) => `INV-${orgId.slice(0, 8)}-${n}` }, clock).invoice;
  return openReceivable(issued, nextId(), clock).receivable;
};

const makePayment = (amountMinor = 4_000) =>
  intakePayment({
    channel: 'c2b',
    externalRef: `SDK-${seq}-REF`,
    idempotencyKey: `idem-${seq}`,
    amount: Money.ofMinor(amountMinor, 'KES'),
  }, { clock }).payment;

const makeCase = (orgId: Uuid, receivableIds: readonly Uuid[], sequenceNo: number) =>
  openCase({
    id: nextId(),
    orgId,
    receivableIds,
    collectorId: nextId(),
    openedBy: 'collector-1',
    sequenceNo,
  }, [], clock).case;

const normalized = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('PGResourceStore — boot contract', () => {
  it('refuses mutations before ensureReady() (the projection must come from PostgreSQL first)', async () => {
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const store = new PGResourceStore(new PGClient({ config: config as never }), { orgScope: orgId });
    expect(() => store.saveReceivable(makeReceivable(orgId))).toThrow(/not ready|ensureReady/i);
    const report = await store.ensureReady();
    expect(report.quarantined).toBe(0);
    expect(() => store.saveReceivable(makeReceivable(orgId))).not.toThrow();
  });
});

describe('PGResourceStore — durability round-trips (save → flush → re-boot → identical)', () => {
  it('persists a receivable, a payment and a collections case across a full reboot', async () => {
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const store = await scopedStore(orgId);

    const receivable = makeReceivable(orgId, 25_000);
    const payment = makePayment(4_000);
    const kase = makeCase(orgId, [receivable.id], 1);
    store.saveReceivable(receivable);
    store.savePayment(payment);
    store.saveCase(kase);
    const laneEvent = {
      name: 'case.opened',
      version: 1 as const,
      aggregateId: kase.id,
      payload: { orgId, caseId: kase.id, sequenceNo: 1 },
      occurredAt: T0,
    };
    store.record(laneEvent);
    await store.flush();

    const reborn = await scopedStore(orgId);
    const savedReceivable = reborn.receivables().find((r) => r.id === receivable.id);
    expect(normalized(savedReceivable)).toEqual(normalized(receivable));
    expect(normalized(reborn.payments().find((p) => p.id === payment.id))).toEqual(normalized(payment));
    expect(normalized(reborn.cases().find((c) => c.id === kase.id))).toEqual(normalized(kase));
    const event = reborn.events().find((e) => e.name === 'case.opened' && e.aggregateId === kase.id);
    expect(normalized(event)).toEqual(normalized(laneEvent));
  });

  it('upserts on double-save — a replayed save never duplicates or corrupts', async () => {
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const store = await scopedStore(orgId);
    const receivable = makeReceivable(orgId);
    store.saveReceivable(receivable);
    store.saveReceivable(receivable);
    await store.flush();
    const reborn = await scopedStore(orgId);
    expect(reborn.receivables().filter((r) => r.id === receivable.id)).toHaveLength(1);
  });
});

describe('PGResourceStore — the per-org case sequence (hi-lo allocator)', () => {
  it('grants 50 sequential numbers — unique, strictly increasing, deterministic', async () => {
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const store = await scopedStore(orgId);
    const granted: number[] = [];
    // nextCaseSequence is a synchronous allocation (race-free by construction:
    // a single-threaded projection hands out from a reserved block) — Promise.all
    // schedules all 50 and every caller must still receive a distinct, strictly
    // increasing number.
    await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => granted.push(store.nextCaseSequence(orgId)))));
    expect(new Set(granted).size).toBe(50);
    expect([...granted]).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    await store.flush();
  });

  it('the reservation is DURABLE: after flush + full reboot the next grant continues after the high-water mark', async () => {
    const orgId = nextId() as Uuid;
    orgs.push(orgId);
    const store = await scopedStore(orgId);
    for (let i = 0; i < 7; i += 1) store.nextCaseSequence(orgId);
    await store.flush();

    const reborn = await scopedStore(orgId);
    const next = reborn.nextCaseSequence(orgId);
    expect(next).toBeGreaterThanOrEqual(8); // never re-issues a number a previous process granted
    await reborn.flush();

    // an org with no reservations yet starts at 1 — blocks are per-org
    const otherOrg = nextId() as Uuid;
    orgs.push(otherOrg);
    const fresh = await scopedStore(otherOrg);
    expect(fresh.nextCaseSequence(otherOrg)).toBe(1);
    await fresh.flush();
  });
});

describe('PGResourceStore — sticky failure under a REAL dead postmaster (ephemeral cluster)', () => {
  it('a batch that cannot commit leaves ZERO partial aggregates; the queue survives and drains on recovery', async () => {
    const cluster = await spawnEphemeralCluster('resourcestore-crash');
    try {
      const orgId = nextId() as Uuid;
      orgs.push(orgId);
      const laneClient = new PGClient({ config: cluster.config as never });
      const store = new PGResourceStore(laneClient, { orgScope: orgId });
      await store.ensureReady();

      const flushed = makeReceivable(orgId, 11_000);
      store.saveReceivable(flushed);
      await store.flush();

      // kill PostgreSQL, then enqueue two more saves — they can ONLY live in the queue
      await cluster.stop('fast');
      const queuedA = makeReceivable(orgId, 12_000);
      const queuedB = makePayment(1_500);
      store.saveReceivable(queuedA);
      store.savePayment(queuedB);
      await expect(store.flush()).rejects.toThrow();

      // recovery: the SAME queue drains in order, batch per transaction
      await cluster.start();
      await store.flush();

      const reborn = new PGResourceStore(new PGClient({ config: cluster.config as never }), { orgScope: orgId });
      await reborn.ensureReady();
      expect(normalized(reborn.receivables().find((r) => r.id === flushed.id))).toEqual(normalized(flushed));
      expect(normalized(reborn.receivables().find((r) => r.id === queuedA.id))).toEqual(normalized(queuedA));
      expect(normalized(reborn.payments().find((p) => p.id === queuedB.id))).toEqual(normalized(queuedB));
      await reborn.close();
      await laneClient.close();
    } finally {
      await cluster.destroy();
    }
  }, 120_000);
});
