import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import { memorySnapshot, claimOf, type CustomerMemory } from './snapshot';
import { MEMORY_CLAIMS, type Claim, type CadenceValue } from './claims';
import { DAY_MS, type InvoiceIssuedFact, type MemoryFact, type PaymentReceivedFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const ALICE = uid(1);
const BOB = uid(2);
const AS_OF = '2026-03-31T00:00:00.000Z';
const ISSUE = '2026-01-01T00:00:00.000Z';

let seq = 2000;
const ev = (): Uuid => uid(++seq);

const issued = (customerId: Uuid, invoiceId: Uuid, atIso = ISSUE): InvoiceIssuedFact => ({
  eventId: ev(), customerId, at: atIso, type: 'invoice_issued', invoiceId, currency: 'KES', totalMinor: 100_000,
});

const paid = (customerId: Uuid, invoiceId: Uuid, days: number, atIso?: string): PaymentReceivedFact => ({
  eventId: ev(), customerId,
  at: atIso ?? new Date(Date.parse(ISSUE) + days * DAY_MS + 12 * 3_600_000).toISOString(),
  type: 'payment_received', paymentId: uid(++seq), invoiceId, currency: 'KES', amountMinor: 100_000,
});

const promiseOutcome = (customerId: Uuid, outcome: 'kept' | 'broken' | 'expired', atIso: string): MemoryFact => ({
  eventId: ev(), customerId, at: atIso, type: 'promise_outcome', promiseId: uid(++seq), outcome,
});

const consent = (customerId: Uuid, status: 'granted' | 'revoked', atIso: string): MemoryFact => ({
  eventId: ev(), customerId, at: atIso, type: 'consent_changed', channel: 'whatsapp', status,
});

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError && error.code === code) return;
    throw error;
  }
  throw new Error(`expected DomainError '${code}', but nothing was thrown`);
};

// --- projection ---------------------------------------------------------------

describe('memorySnapshot — point-in-time projection', () => {
  it('returns an empty customer list for an empty history (no claims, no crash)', () => {
    expect(memorySnapshot([], AS_OF)).toEqual({ asOf: AS_OF, customers: [] });
  });

  it('projects claims in fixed dimension order and counts the visible facts', () => {
    const inv = issued(ALICE, uid(++seq));
    const snapshot = memorySnapshot([inv, paid(ALICE, inv.invoiceId, 5), promiseOutcome(ALICE, 'kept', '2026-02-01T09:00:00.000Z')], AS_OF);
    expect(snapshot.customers).toHaveLength(1);
    const alice = snapshot.customers[0] as CustomerMemory;
    expect(alice.customerId).toBe(ALICE);
    expect(alice.asOf).toBe(AS_OF);
    expect(alice.claims.map((claim) => claim.claim)).toEqual([MEMORY_CLAIMS.cadence, MEMORY_CLAIMS.sizeBands, MEMORY_CLAIMS.reliability]);
    expect(alice.factCount).toBe(3);
  });

  it('sorts customers lexicographically by id', () => {
    const a = issued(BOB, uid(++seq));
    const b = issued(ALICE, uid(++seq));
    expect(memorySnapshot([a, b], AS_OF).customers.map((customer) => customer.customerId)).toEqual([ALICE, BOB]);
  });

  it('hides facts strictly after asOf and includes a fact at exactly asOf', () => {
    const inv = issued(ALICE, uid(++seq));
    const atBoundary = paid(ALICE, inv.invoiceId, 10, AS_OF); // at === asOf → visible
    const after = paid(ALICE, inv.invoiceId, 20, '2026-03-31T00:00:00.001Z'); // asOf + 1ms → invisible
    const snapshot = memorySnapshot([inv, atBoundary, after], AS_OF);
    const alice = snapshot.customers[0] as CustomerMemory;
    expect(alice.factCount).toBe(2);
    const cadence = claimOf(alice, MEMORY_CLAIMS.cadence)?.value as CadenceValue;
    expect(cadence.sampleCount).toBe(1); // only the boundary payment
  });

  it('keeps point-in-time consent: a post-asOf flip is invisible', () => {
    const grant = consent(ALICE, 'granted', '2026-01-15T09:00:00.000Z');
    const revoke = consent(ALICE, 'revoked', '2026-04-01T09:00:00.000Z'); // after asOf
    const snapshot = memorySnapshot([grant, revoke], AS_OF);
    const alice = snapshot.customers[0] as CustomerMemory;
    const channels = claimOf(alice, MEMORY_CLAIMS.channels)?.value as { consent: { status: string }[] };
    expect(channels.consent).toEqual([{ channel: 'whatsapp', status: 'granted' }]);
  });

  it('yields an empty claims list for a customer with no derivable dimension (silence is honest)', () => {
    const orphanAllocation: MemoryFact = {
      eventId: ev(), customerId: ALICE, at: '2026-03-01T09:00:00.000Z',
      type: 'allocation_applied', receivableId: uid(++seq), currency: 'KES', amountMinor: 5_000,
    };
    const snapshot = memorySnapshot([orphanAllocation], AS_OF);
    const alice = snapshot.customers[0] as CustomerMemory;
    expect(alice.claims).toEqual([]);
    expect(alice.factCount).toBe(1);
  });

  it('omits customers whose every fact lies after asOf', () => {
    const future: MemoryFact = { eventId: ev(), customerId: BOB, at: '2026-04-02T09:00:00.000Z', type: 'promise_outcome', promiseId: uid(++seq), outcome: 'kept' };
    const snapshot = memorySnapshot([future], AS_OF);
    expect(snapshot.customers).toEqual([]);
  });

  it('is byte-for-byte deterministic for the same inputs', () => {
    const inv = issued(ALICE, uid(++seq));
    const facts = [inv, paid(ALICE, inv.invoiceId, 7), promiseOutcome(ALICE, 'broken', '2026-02-02T09:00:00.000Z'), consent(ALICE, 'granted', '2026-02-03T09:00:00.000Z')];
    const first = JSON.stringify(memorySnapshot(facts, AS_OF));
    const second = JSON.stringify(memorySnapshot([...facts], AS_OF));
    expect(first).toBe(second);
  });

  it('never mutates the supplied history (frozen-input + JSON pin)', () => {
    const inv = issued(ALICE, uid(++seq));
    const facts = [inv, paid(ALICE, inv.invoiceId, 4)].map((fact) => Object.freeze({ ...fact }));
    Object.freeze(facts);
    const before = JSON.stringify(facts);
    expect(() => memorySnapshot(facts, AS_OF)).not.toThrow();
    expect(JSON.stringify(facts)).toBe(before);
  });

  it('returns fresh claim objects — mutating a snapshot never leaks into the next run', () => {
    const inv = issued(ALICE, uid(++seq));
    const facts = [inv, paid(ALICE, inv.invoiceId, 4)];
    const first = memorySnapshot(facts, AS_OF);
    (first.customers[0]?.claims as Claim[]).push({ claim: MEMORY_CLAIMS.disputes, value: {}, computedFrom: [], asOf: AS_OF });
    const second = memorySnapshot(facts, AS_OF);
    expect(second.customers[0]?.claims).toHaveLength(2);
  });

  it('exposes claimOf to look claims up by stable name (undefined when absent)', () => {
    const inv = issued(ALICE, uid(++seq));
    const alice = memorySnapshot([inv, paid(ALICE, inv.invoiceId, 3)], AS_OF).customers[0] as CustomerMemory;
    expect(claimOf(alice, MEMORY_CLAIMS.cadence)?.claim).toBe('payment.cadence');
    expect(claimOf(alice, MEMORY_CLAIMS.disputes)).toBeUndefined();
  });
});

// --- validation -----------------------------------------------------------------

describe('memorySnapshot — validation gates', () => {
  it('refuses a non-ISO asOf with MEM_ASOF_INVALID', () => {
    const table = ['', '2026-03-31', '2026-03-31T00:00:00', 'yesterday', 42, null, undefined];
    table.forEach((bad) => {
      expectCode(() => memorySnapshot([], bad as unknown as string), 'MEM_ASOF_INVALID');
    });
  });

  it('propagates fact-validation failures (unknown type, duplicates, malformed ids)', () => {
    const inv = issued(ALICE, uid(++seq));
    const ghost = { ...inv, type: 'ghost' as unknown as 'invoice_issued' };
    expectCode(() => memorySnapshot([ghost], AS_OF), 'MEM_FACT_UNKNOWN_TYPE');
    expectCode(() => memorySnapshot([inv, inv], AS_OF), 'MEM_FACT_DUPLICATE_EVENT_ID');
    const malformed = { ...inv, invoiceId: 'inv-1' as unknown as Uuid };
    expectCode(() => memorySnapshot([malformed], AS_OF), 'MEM_FACT_INVALID');
  });

  it('validates asOf before the facts (documented precedence)', () => {
    expectCode(() => memorySnapshot([{ ...issued(ALICE, uid(++seq)), at: 'nope' }], 'nope'), 'MEM_ASOF_INVALID');
  });
});
