/**
 * Claims — the explainable output shape of the financial memory lane
 * (issue #37, VISION §3.3/§3.7).
 *
 * Every number the memory lane produces is a CLAIM WITH EVIDENCE:
 *
 *   { claim, value, computedFrom: [eventId…], asOf }
 *
 * `computedFrom` lists the exact evidence anchors (the caller's eventIds)
 * that produced the value — a reviewer (human or AI agent) can pull those
 * events and re-derive the number. Given the same facts and asOf, claims are
 * byte-for-byte deterministic (same values, same evidence, same order).
 *
 * One claim per behavioral dimension; a dimension with NO data emits NO
 * claim (silence is honest — an empty history claims nothing), so:
 *   - empty history           → zero claims, no crash;
 *   - payments only           → cadence + sizeBands, no reliability claim;
 *   - every emitted number    → traceable via computedFrom.
 *
 * All money values are minor-unit safe integers (bigint is banned from the
 * JSON-serializable claim values; sums are computed in bigint internally and
 * guarded against safe-integer overflow).
 */
import { DomainError, type Currency, type Uuid } from '../shared';
import { wholeDaysBetween, type ConsentChangeStatus, type MemoryFact } from './facts';

/** Stable claim names — the contract F21 (financial-state) and F22 (NBA) read. */
export const MEMORY_CLAIMS = {
  cadence: 'payment.cadence',
  sizeBands: 'payment.sizeBands',
  reliability: 'promise.reliability',
  channels: 'channel.preference',
  exposure: 'exposure.current',
  disputes: 'dispute.history',
} as const;

export type MemoryClaimName = (typeof MEMORY_CLAIMS)[keyof typeof MEMORY_CLAIMS];

/** The universal explainable shape — every claim carries its evidence chain. */
export interface Claim<TValue = unknown> {
  /** Stable machine-readable claim name, e.g. 'payment.cadence' (MEMORY_CLAIMS). */
  readonly claim: MemoryClaimName;
  /** The projected value — plain, JSON-serializable data. */
  readonly value: TValue;
  /** Evidence anchors: eventIds of the facts this value was computed from. */
  readonly computedFrom: readonly Uuid[];
  /** ISO-8601 — the point in time the claim speaks about. */
  readonly asOf: string;
}

// --- claim value types ----------------------------------------------------------

/** `payment.cadence` — days-to-pay distribution (whole UTC days, clamped ≥ 0). */
export interface CadenceValue {
  readonly sampleCount: number;
  readonly minDaysToPay: number;
  /** Averaged middle pair for even samples (can be x.5). */
  readonly medianDaysToPay: number;
  /** Nearest-rank: the ⌈0.9·n⌉-th smallest sample. */
  readonly p90DaysToPay: number;
}

/** One currency's typical payment-size band (VISION: "Typical payment: KES 80K–150K"). */
export interface SizeBand {
  readonly currency: Currency;
  readonly count: number;
  readonly minMinor: number;
  /** Nearest-rank 25th percentile — the low edge of the typical band. */
  readonly p25Minor: number;
  readonly medianMinor: number;
  /** Nearest-rank 75th percentile — the high edge of the typical band. */
  readonly p75Minor: number;
  readonly maxMinor: number;
}

export interface SizeBandsValue {
  /** Sorted lexicographically by currency. */
  readonly bands: readonly SizeBand[];
}

/** `promise.reliability` — kept/broken/expired outcomes + kept rate (0..1). */
export interface ReliabilityValue {
  readonly kept: number;
  readonly broken: number;
  readonly expired: number;
  readonly total: number;
  /** kept / total — exact quotient, deterministic given the same inputs. */
  readonly rate: number;
}

export interface ChannelUsage {
  readonly channel: string;
  readonly inbound: number;
  readonly outbound: number;
  readonly total: number;
}

export interface ChannelConsent {
  readonly channel: string;
  /** Latest consent fact ≤ asOf wins; 'none' when no consent fact exists. */
  readonly status: ConsentChangeStatus | 'none';
}

export interface ChannelPreferenceValue {
  /** Channels with at least one message, sorted lexicographically. */
  readonly channels: readonly ChannelUsage[];
  /** Every channel with usage or a consent fact, sorted lexicographically. */
  readonly consent: readonly ChannelConsent[];
}

/** Aging buckets — whole days past the due date (docs/03 receivable aging). */
export const AGING_BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Aging boundary semantics: day 30 → '0-30', day 31 → '31-60', day 91 → '90+'. */
export const agingBucketFor = (daysPastDue: number): AgingBucket => {
  if (daysPastDue <= 30) return '0-30';
  if (daysPastDue <= 60) return '31-60';
  if (daysPastDue <= 90) return '61-90';
  return '90+';
};

export interface AgingRow {
  readonly bucket: AgingBucket;
  readonly count: number;
  readonly amountMinor: number;
}

export interface ExposureCurrency {
  readonly currency: Currency;
  /** Open receivables = opened ≤ asOf, not settled, balance > 0. */
  readonly openReceivables: number;
  readonly openMinor: number;
  /** All four buckets always present (0-filled) in AGING_BUCKETS order. */
  readonly aging: readonly AgingRow[];
}

export interface ExposureValue {
  /** Sorted lexicographically by currency. */
  readonly currencies: readonly ExposureCurrency[];
}

export interface DisputeHistoryValue {
  readonly opened: number;
  readonly resolved: number;
  /** Opened without a matching resolution ≤ asOf. */
  readonly currentlyOpen: number;
}

// --- deterministic stats helpers --------------------------------------------------

const assertNonEmpty = (values: readonly number[]): void => {
  if (values.length === 0) {
    throw new DomainError('MEM_SAMPLE_EMPTY', 'statistics require at least one sample');
  }
};

/** Classic median: middle element, or the averaged middle pair (may be x.5). */
export const medianOf = (values: readonly number[]): number => {
  assertNonEmpty(values);
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/**
 * Nearest-rank percentile (no interpolation): the ⌈p·n⌉-th smallest value.
 * Deterministic and transparent — p90 of 10 samples is the 9th smallest.
 */
export const nearestRankPercentile = (values: readonly number[], p: number): number => {
  assertNonEmpty(values);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(Math.max(Math.ceil(p * sorted.length), 1), sorted.length);
  return sorted[rank - 1] as number;
};

/** Money sums run in bigint and are refused if they leave the safe-integer range. */
const sumMinor = (values: readonly number[]): number => {
  const total = values.reduce((acc, v) => acc + BigInt(v), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      'MEM_AMOUNT_OVERFLOW',
      `sum ${total} exceeds the safe-integer range for claim values`,
    );
  }
  return Number(total);
};

/** Evidence lists keep first-appearance order and never contain duplicates. */
const orderedUnique = (ids: readonly Uuid[]): Uuid[] => [...new Set(ids)];

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Point-in-time resolution rule: when the same anchor appears more than once
 * in a history (a re-issued invoice, a duplicate settlement, a consent flip),
 * the fact's `at` decides — EARLIEST for issue/settlement, LATEST for consent
 * — with array order used ONLY to break equal-timestamp ties. Deciding by
 * array order alone would make claims depend on presentation, not history.
 */
const atKey = (fact: MemoryFact): number => Date.parse(fact.at);

// --- claim builders ---------------------------------------------------------------
// Each builder takes the ALREADY-FILTERED facts of ONE customer (at ≤ asOf) and
// returns null when the dimension has no data — no data, no claim.

/** `payment.cadence` — payments linked to an issued invoice, days-to-pay distribution. */
export function buildCadenceClaim(facts: readonly MemoryFact[], asOf: string): Claim<CadenceValue> | null {
  interface InvoiceIssue {
    readonly issuedIso: string;
    readonly eventId: Uuid;
    readonly at: number; // resolution key — earliest issue wins
  }
  const invoices = new Map<string, InvoiceIssue>();
  for (const fact of facts) {
    if (fact.type === 'invoice_issued') {
      const existing = invoices.get(fact.invoiceId);
      if (!existing || atKey(fact) < existing.at) {
        // earliest issue (array order breaks exact ties) — days-to-pay runs
        // from the FIRST time the invoice was issued, not the latest re-issue
        invoices.set(fact.invoiceId, { issuedIso: fact.at, eventId: fact.eventId, at: atKey(fact) });
      }
    }
  }
  const samples: { days: number; evidence: Uuid[] }[] = [];
  for (const fact of facts) {
    if (fact.type !== 'payment_received' || fact.invoiceId == null) continue;
    const invoice = invoices.get(fact.invoiceId);
    if (!invoice) continue; // no invoice evidence → no days-to-pay sample
    const days = wholeDaysBetween(invoice.issuedIso, fact.at); // clamped ≥ 0
    samples.push({ days, evidence: [fact.eventId, invoice.eventId] });
  }
  if (samples.length === 0) return null;
  const days = samples.map((s) => s.days);
  return {
    claim: MEMORY_CLAIMS.cadence,
    value: {
      sampleCount: days.length,
      minDaysToPay: days.reduce((min, d) => Math.min(min, d), Number.MAX_SAFE_INTEGER),
      medianDaysToPay: medianOf(days),
      p90DaysToPay: nearestRankPercentile(days, 0.9),
    },
    computedFrom: orderedUnique(samples.flatMap((s) => s.evidence)),
    asOf,
  };
}

/** `payment.sizeBands` — typical payment sizes per currency (minor units). */
export function buildSizeBandsClaim(
  facts: readonly MemoryFact[],
  asOf: string,
): Claim<SizeBandsValue> | null {
  const byCurrency = new Map<Currency, { amounts: number[]; eventIds: Uuid[] }>();
  for (const fact of facts) {
    if (fact.type !== 'payment_received') continue;
    const bucket = byCurrency.get(fact.currency) ?? { amounts: [], eventIds: [] };
    bucket.amounts.push(fact.amountMinor);
    bucket.eventIds.push(fact.eventId);
    byCurrency.set(fact.currency, bucket);
  }
  if (byCurrency.size === 0) return null;
  const bands: SizeBand[] = [...byCurrency.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([currency, { amounts }]) => ({
      currency,
      count: amounts.length,
      minMinor: amounts.reduce((min, v) => Math.min(min, v), Number.MAX_SAFE_INTEGER),
      p25Minor: nearestRankPercentile(amounts, 0.25),
      medianMinor: medianOf(amounts),
      p75Minor: nearestRankPercentile(amounts, 0.75),
      maxMinor: amounts.reduce((max, v) => Math.max(max, v), 0),
    }));
  return {
    claim: MEMORY_CLAIMS.sizeBands,
    value: { bands },
    computedFrom: orderedUnique([...byCurrency.values()].flatMap((b) => b.eventIds)),
    asOf,
  };
}

/** `promise.reliability` — kept vs broken vs expired outcomes + kept rate. */
export function buildReliabilityClaim(
  facts: readonly MemoryFact[],
  asOf: string,
): Claim<ReliabilityValue> | null {
  const outcomes = { kept: 0, broken: 0, expired: 0 };
  const eventIds: Uuid[] = [];
  for (const fact of facts) {
    if (fact.type !== 'promise_outcome') continue;
    outcomes[fact.outcome] += 1;
    eventIds.push(fact.eventId);
  }
  const total = outcomes.kept + outcomes.broken + outcomes.expired;
  if (total === 0) return null;
  return {
    claim: MEMORY_CLAIMS.reliability,
    value: { ...outcomes, total, rate: outcomes.kept / total },
    computedFrom: orderedUnique(eventIds),
    asOf,
  };
}

/** `channel.preference` — inbound/outbound histogram + consent status per channel. */
export function buildChannelClaim(
  facts: readonly MemoryFact[],
  asOf: string,
): Claim<ChannelPreferenceValue> | null {
  const usage = new Map<string, { inbound: number; outbound: number; eventIds: Uuid[] }>();
  // last consent fact BY TIME per channel decides the status (array order only
  // breaks exact-timestamp ties — see the resolution rule above)
  const consent = new Map<string, { status: ConsentChangeStatus; eventId: Uuid; at: number }>();
  for (const fact of facts) {
    if (fact.type === 'message_exchanged') {
      const entry = usage.get(fact.channel) ?? { inbound: 0, outbound: 0, eventIds: [] };
      if (fact.direction === 'inbound') entry.inbound += 1;
      else entry.outbound += 1;
      entry.eventIds.push(fact.eventId);
      usage.set(fact.channel, entry);
    } else if (fact.type === 'consent_changed') {
      const existing = consent.get(fact.channel);
      if (!existing || atKey(fact) >= existing.at) {
        consent.set(fact.channel, { status: fact.status, eventId: fact.eventId, at: atKey(fact) });
      }
    }
  }
  if (usage.size === 0 && consent.size === 0) return null;
  const channels: ChannelUsage[] = [...usage.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([channel, entry]) => ({
      channel,
      inbound: entry.inbound,
      outbound: entry.outbound,
      total: entry.inbound + entry.outbound,
    }));
  const allChannels = [...new Set([...usage.keys(), ...consent.keys()])].sort(byString);
  const consentRows: ChannelConsent[] = [];
  const decidingEvidence: Uuid[] = []; // the consent fact that decided each status
  for (const channel of allChannels) {
    const latest = consent.get(channel);
    consentRows.push(latest ? { channel, status: latest.status } : { channel, status: 'none' });
    if (latest) decidingEvidence.push(latest.eventId);
  }
  return {
    claim: MEMORY_CLAIMS.channels,
    value: { channels, consent: consentRows },
    // evidence: every message counted + the DECIDING consent fact per channel
    computedFrom: orderedUnique([
      ...[...usage.values()].flatMap((entry) => entry.eventIds),
      ...decidingEvidence,
    ]),
    asOf,
  };
}

/** `exposure.current` — open receivables per currency + aging profile. */
export function buildExposureClaim(
  facts: readonly MemoryFact[],
  asOf: string,
): Claim<ExposureValue> | null {
  interface OpenReceivable {
    readonly currency: Currency;
    readonly amountMinor: number;
    readonly dueDate: string;
    readonly eventId: Uuid;
    settledEventId: Uuid | null;
    settledAt: number; // resolution key — earliest settlement wins
    allocations: { amountMinor: number; eventId: Uuid }[];
  }
  const receivables = new Map<string, OpenReceivable>();
  const allocationEvidence: Uuid[] = []; // every allocation attributed to a known receivable
  for (const fact of facts) {
    if (fact.type === 'receivable_opened') {
      if (!receivables.has(fact.receivableId)) {
        receivables.set(fact.receivableId, {
          currency: fact.currency,
          amountMinor: fact.amountMinor,
          dueDate: fact.dueDate,
          eventId: fact.eventId,
          settledEventId: null,
          settledAt: Number.POSITIVE_INFINITY,
          allocations: [],
        });
      }
    } else if (fact.type === 'allocation_applied') {
      const receivable = receivables.get(fact.receivableId);
      if (receivable) {
        receivable.allocations.push({ amountMinor: fact.amountMinor, eventId: fact.eventId });
        allocationEvidence.push(fact.eventId);
      }
      // allocations for unknown receivables cannot be attributed — ignored
    } else if (fact.type === 'receivable_settled') {
      const receivable = receivables.get(fact.receivableId);
      if (receivable && atKey(fact) < receivable.settledAt) {
        // earliest settlement (array order breaks exact ties) is the one that
        // actually closed the receivable; duplicates never become evidence
        receivable.settledEventId = fact.eventId;
        receivable.settledAt = atKey(fact);
      }
    }
  }
  if (receivables.size === 0) return null;

  interface Accumulator {
    count: number;
    amounts: number[];
    agingCounts: Map<AgingBucket, number>;
    agingAmounts: Map<AgingBucket, number[]>;
  }
  const byCurrency = new Map<Currency, Accumulator>();
  for (const receivable of receivables.values()) {
    const settled = receivable.settledEventId !== null; // a settled fact is authoritative
    const allocated = receivable.allocations.reduce((acc, a) => acc + BigInt(a.amountMinor), 0n);
    const raw = BigInt(receivable.amountMinor) - allocated;
    // clamped at 0 — over-allocation never creates negative exposure
    const balance = settled || raw <= 0n ? 0n : raw;
    const bucket = byCurrency.get(receivable.currency) ?? {
      count: 0,
      amounts: [],
      agingCounts: new Map<AgingBucket, number>(),
      agingAmounts: new Map<AgingBucket, number[]>(),
    };
    if (balance > 0n) {
      bucket.count += 1;
      bucket.amounts.push(Number(balance));
      const agingBucket = agingBucketFor(wholeDaysBetween(receivable.dueDate, asOf));
      bucket.agingCounts.set(agingBucket, (bucket.agingCounts.get(agingBucket) ?? 0) + 1);
      const amounts = bucket.agingAmounts.get(agingBucket) ?? [];
      amounts.push(Number(balance));
      bucket.agingAmounts.set(agingBucket, amounts);
    }
    byCurrency.set(receivable.currency, bucket);
  }

  const currencies: ExposureCurrency[] = [...byCurrency.entries()]
    .sort(([a], [b]) => byString(a, b))
    .map(([currency, bucket]) => ({
      currency,
      openReceivables: bucket.count,
      openMinor: sumMinor(bucket.amounts),
      aging: AGING_BUCKETS.map((bucketName) => ({
        bucket: bucketName,
        count: bucket.agingCounts.get(bucketName) ?? 0,
        amountMinor: sumMinor(bucket.agingAmounts.get(bucketName) ?? []),
      })),
    }));
  return {
    claim: MEMORY_CLAIMS.exposure,
    value: { currencies },
    // evidence: every opened receivable, every attributed allocation, and the
    // DECIDING settlement per receivable — first-appearance order, deduped
    computedFrom: orderedUnique([
      ...[...receivables.values()].map((r) => r.eventId),
      ...allocationEvidence,
      ...[...receivables.values()].flatMap((r) => (r.settledEventId === null ? [] : [r.settledEventId])),
    ]),
    asOf,
  };
}

/** `dispute.history` — opened/resolved counts + currently-open flag count. */
export function buildDisputeClaim(
  facts: readonly MemoryFact[],
  asOf: string,
): Claim<DisputeHistoryValue> | null {
  const opened = new Map<string, { eventId: Uuid }>();
  const resolved = new Map<string, { eventId: Uuid }>();
  for (const fact of facts) {
    if (fact.type === 'dispute_opened') {
      if (!opened.has(fact.disputeId)) opened.set(fact.disputeId, { eventId: fact.eventId });
    } else if (fact.type === 'dispute_resolved') {
      if (!resolved.has(fact.disputeId)) resolved.set(fact.disputeId, { eventId: fact.eventId });
    }
  }
  if (opened.size === 0 && resolved.size === 0) return null;
  let currentlyOpen = 0;
  for (const disputeId of opened.keys()) {
    if (!resolved.has(disputeId)) currentlyOpen += 1;
  }
  return {
    claim: MEMORY_CLAIMS.disputes,
    value: { opened: opened.size, resolved: resolved.size, currentlyOpen },
    computedFrom: orderedUnique([
      ...[...opened.values()].map((o) => o.eventId),
      ...[...resolved.values()].map((r) => r.eventId),
    ]),
    asOf,
  };
}

/** All claim builders in the fixed order the snapshot emits them. */
export const CLAIM_BUILDERS: readonly ((
  facts: readonly MemoryFact[],
  asOf: string,
) => Claim | null)[] = [
  buildCadenceClaim,
  buildSizeBandsClaim,
  buildReliabilityClaim,
  buildChannelClaim,
  buildExposureClaim,
  buildDisputeClaim,
];
