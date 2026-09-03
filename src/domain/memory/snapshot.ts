/**
 * memorySnapshot — the point-in-time customer financial memory projection
 * (issue #37, VISION §3.3: the ABC Hardware view — cadence, channel,
 * typical payment, reliability, recent behavior, exposure).
 *
 * Pure: (facts, asOf) → snapshot. Facts at or before `asOf` (inclusive) are
 * grouped per customer, and each behavioral dimension becomes a CLAIM WITH
 * EVIDENCE (see ./claims). A dimension with no data emits no claim, so an
 * empty history yields an empty claims list — never zeros pretending to be
 * observations, never a crash.
 *
 * Determinism: the same facts + asOf always produce the identical snapshot —
 * customers sorted by id, claims in a fixed dimension order, evidence lists
 * in first-appearance order. Array order of the supplied facts is part of the
 * input (it breaks timestamp ties for last-fact-wins projections like consent).
 */
import { DomainError, type Uuid } from '../shared';
import { assertMemoryFacts, isIsoTimestamp, type MemoryFact } from './facts';
import { CLAIM_BUILDERS, type Claim } from './claims';

/** One customer's point-in-time behavioral profile — claims + evidence only. */
export interface CustomerMemory {
  /** Opaque customer id (the snapshot never dereferences it). */
  readonly customerId: Uuid;
  /** ISO-8601 — the point in time every claim in this memory speaks about. */
  readonly asOf: string;
  /** Claims in fixed dimension order; dimensions without data are absent. */
  readonly claims: readonly Claim[];
  /** Facts of this customer that were at or before asOf (projection breadth). */
  readonly factCount: number;
}

export interface MemorySnapshot {
  readonly asOf: string;
  /** Sorted lexicographically by customerId — deterministic for consumers. */
  readonly customers: readonly CustomerMemory[];
}

/** The claim a memory carries, by stable claim name. */
export const claimOf = (memory: CustomerMemory, name: string): Claim | undefined =>
  memory.claims.find((claim) => claim.claim === name);

/**
 * Project the point-in-time financial memory per customer from a fact history.
 *
 * - facts must pass `assertMemoryFacts` (MEM_FACT_* / MEM_CURRENCY_INVALID);
 * - asOf must be ISO-8601 (MEM_ASOF_INVALID);
 * - facts after asOf are invisible to the snapshot (point-in-time discipline);
 * - customers appear iff they have at least one fact ≤ asOf; their claims list
 *   may still be empty (e.g. only allocations for unknown receivables).
 *
 * Never mutates the input.
 */
export function memorySnapshot(facts: readonly MemoryFact[], asOf: string): MemorySnapshot {
  if (!isIsoTimestamp(asOf)) {
    throw new DomainError(
      'MEM_ASOF_INVALID',
      `asOf must be ISO-8601 (e.g. 2026-03-02T08:00:00.000Z), got ${String(asOf)}`,
      { asOf: String(asOf) },
    );
  }
  assertMemoryFacts(facts);
  const asOfMs = Date.parse(asOf);

  const byCustomer = new Map<string, MemoryFact[]>();
  for (const fact of facts) {
    if (Date.parse(fact.at) > asOfMs) continue; // after the point in time — invisible
    const history = byCustomer.get(fact.customerId);
    if (history) history.push(fact);
    else byCustomer.set(fact.customerId, [fact]);
  }

  const customers: CustomerMemory[] = [...byCustomer.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([customerId, customerFacts]) => {
      const claims = CLAIM_BUILDERS.flatMap((build) => {
        const claim = build(customerFacts, asOf);
        return claim ? [claim] : [];
      });
      return { customerId: customerId as Uuid, asOf, claims, factCount: customerFacts.length };
    });

  return { asOf, customers };
}
