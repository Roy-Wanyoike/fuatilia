import { describe, expect, it } from 'vitest';
import { DomainError, type Uuid, uuid } from '../shared';
import {
  AGING_BUCKETS,
  CLAIM_BUILDERS,
  MEMORY_CLAIMS,
  agingBucketFor,
  buildCadenceClaim,
  buildChannelClaim,
  buildDisputeClaim,
  buildExposureClaim,
  buildReliabilityClaim,
  buildSizeBandsClaim,
  type Claim,
  type CadenceValue,
  type ChannelPreferenceValue,
  type DisputeHistoryValue,
  type ExposureValue,
  type ReliabilityValue,
  type SizeBandsValue,
} from './claims';
import { DAY_MS, type AllocationAppliedFact, type InvoiceIssuedFact, type MemoryFact, type PaymentReceivedFact, type ReceivableOpenedFact } from './facts';

// --- fixtures ---------------------------------------------------------------

const uid = (n: number): Uuid => uuid(`00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
const CUSTOMER = uid(1);
const AS_OF = '2026-03-31T00:00:00.000Z';
const ISSUE = '2026-01-01T00:00:00.000Z';

let seq = 1000;
const ev = (): Uuid => uid(++seq);

/** Invoice issued at ISSUE (00:00 UTC). */
const issued = (invoiceId: Uuid = uid(++seq), atIso = ISSUE): InvoiceIssuedFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso,
  type: 'invoice_issued', invoiceId, currency: 'KES', totalMinor: 120_000,
});

/** Payment `days` whole UTC days after ISSUE at noon (so day math floors exactly to `days`). */
const payDays = (
  days: number,
  opts: { invoiceId?: Uuid | null; currency?: 'KES' | 'USD' | 'TZS'; amountMinor?: number; atIso?: string } = {},
): PaymentReceivedFact => ({
  eventId: ev(), customerId: CUSTOMER,
  at: opts.atIso ?? new Date(Date.parse(ISSUE) + days * DAY_MS + 12 * 3_600_000).toISOString(),
  type: 'payment_received',
  paymentId: uid(++seq),
  invoiceId: opts.invoiceId === undefined ? null : opts.invoiceId,
  currency: opts.currency ?? 'KES',
  amountMinor: opts.amountMinor ?? 100_000,
});

const promiseOutcome = (outcome: 'kept' | 'broken' | 'expired', atIso = '2026-02-01T09:00:00.000Z'): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'promise_outcome', promiseId: uid(++seq), outcome,
});

const message = (direction: 'inbound' | 'outbound', atIso: string, channel = 'whatsapp'): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'message_exchanged', channel, direction,
});

const consent = (status: 'granted' | 'revoked', atIso: string, channel = 'whatsapp'): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'consent_changed', channel, status,
});

/** Receivable opened `daysBeforeAsOf` days before AS_OF (due date drives aging). */
const opened = (
  daysBeforeAsOf: number,
  opts: { currency?: 'KES' | 'USD'; amountMinor?: number; receivableId?: Uuid; atIso?: string } = {},
): ReceivableOpenedFact => ({
  eventId: ev(), customerId: CUSTOMER,
  at: opts.atIso ?? new Date(Date.parse(AS_OF) - 40 * DAY_MS).toISOString(),
  type: 'receivable_opened',
  receivableId: opts.receivableId ?? uid(++seq),
  currency: opts.currency ?? 'KES',
  amountMinor: opts.amountMinor ?? 500_000,
  dueDate: new Date(Date.parse(AS_OF) - daysBeforeAsOf * DAY_MS).toISOString(),
});

const allocation = (receivableId: Uuid, amountMinor: number, atIso = '2026-03-10T09:00:00.000Z'): AllocationAppliedFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'allocation_applied', receivableId, currency: 'KES', amountMinor,
});

const settled = (receivableId: Uuid, atIso: string): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'receivable_settled', receivableId,
});

const disputeOpened = (disputeId: Uuid, atIso = '2026-02-01T09:00:00.000Z'): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'dispute_opened', disputeId, receivableId: null,
});

const disputeResolved = (disputeId: Uuid, atIso = '2026-02-10T09:00:00.000Z'): MemoryFact => ({
  eventId: ev(), customerId: CUSTOMER, at: atIso, type: 'dispute_resolved', disputeId,
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

// --- claim names + fixed order ------------------------------------------------

describe('claim vocabulary', () => {
  it('pins the six stable claim names (the F21/F22 supplier contract)', () => {
    expect(MEMORY_CLAIMS).toEqual({
      cadence: 'payment.cadence',
      sizeBands: 'payment.sizeBands',
      reliability: 'promise.reliability',
      channels: 'channel.preference',
      exposure: 'exposure.current',
      disputes: 'dispute.history',
    });
  });

  it('runs the builders in the fixed snapshot order', () => {
    const inv = issued();
    const rec = opened(10);
    const facts = [
      inv, payDays(5, { invoiceId: inv.invoiceId }),
      promiseOutcome('kept'),
      message('inbound', '2026-02-02T09:00:00.000Z'),
      rec,
      disputeOpened(uid(++seq)),
    ];
    const names = CLAIM_BUILDERS.flatMap((build) => {
      const claim = build(facts, AS_OF);
      return claim ? [claim.claim] : [];
    });
    expect(names).toEqual([
      'payment.cadence', 'payment.sizeBands', 'promise.reliability',
      'channel.preference', 'exposure.current', 'dispute.history',
    ]);
  });
});

// --- payment.cadence ------------------------------------------------------------

describe('buildCadenceClaim — days-to-pay distribution', () => {
  const cadenceOf = (facts: MemoryFact[]): CadenceValue | null => {
    const claim = buildCadenceClaim(facts, AS_OF);
    return claim ? (claim.value as CadenceValue) : null;
  };

  it('emits no claim when no payment is linked to an issued invoice', () => {
    expect(cadenceOf([])).toBeNull();
    expect(cadenceOf([issued(), payDays(5, { invoiceId: null })])).toBeNull(); // unlinked payment
    expect(cadenceOf([payDays(5, { invoiceId: uid(++seq) })])).toBeNull(); // invoice never issued here
  });

  it('pins min/median/p90 for a single sample', () => {
    const inv = issued();
    expect(cadenceOf([inv, payDays(8, { invoiceId: inv.invoiceId })])).toEqual({
      sampleCount: 1, minDaysToPay: 8, medianDaysToPay: 8, p90DaysToPay: 8,
    });
  });

  it('pins nearest-rank p90 and averaged-pair median across sample shapes', () => {
    const linked = (days: number): MemoryFact[] => {
      const inv = issued();
      return [inv, payDays(days, { invoiceId: inv.invoiceId })];
    };
    const table: { days: number[]; median: number; p90: number; min: number }[] = [
      { days: [5], median: 5, p90: 5, min: 5 },
      { days: [1, 2, 3], median: 2, p90: 3, min: 1 },            // ⌈0.9·3⌉ = 3rd
      { days: [1, 2, 3, 4], median: 2.5, p90: 4, min: 1 },       // ⌈0.9·4⌉ = 4th
      { days: [8, 3, 10, 1], median: 5.5, p90: 10, min: 1 },     // order-independent
      { days: [4, 4, 4], median: 4, p90: 4, min: 4 },
    ];
    table.forEach(({ days, median, p90, min }) => {
      const facts = days.flatMap((d) => {
        const inv = issued();
        return [inv, payDays(d, { invoiceId: inv.invoiceId })];
      });
      expect(cadenceOf(facts)).toEqual({ sampleCount: days.length, minDaysToPay: min, medianDaysToPay: median, p90DaysToPay: p90 });
    });
  });

  it('pins the ten-sample p90 (9th smallest) and even-sample median (5.5)', () => {
    const inv = issued();
    const facts = [inv, ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => payDays(d, { invoiceId: inv.invoiceId }))];
    expect(cadenceOf(facts)).toEqual({ sampleCount: 10, minDaysToPay: 1, medianDaysToPay: 5.5, p90DaysToPay: 9 });
  });

  it('floors partial days to whole UTC days and clamps early payments to 0', () => {
    const inv = issued();
    // paid 2 days + 23h later → 2 whole days
    const late = payDays(0, { invoiceId: inv.invoiceId, atIso: new Date(Date.parse(ISSUE) + 2 * DAY_MS + 23 * 3_600_000).toISOString() });
    // "paid" 5 days BEFORE issue (anomalous data) → clamped at 0, never negative
    const early = payDays(0, { invoiceId: inv.invoiceId, atIso: new Date(Date.parse(ISSUE) - 5 * DAY_MS).toISOString() });
    expect(cadenceOf([inv, late, early])).toEqual({ sampleCount: 2, minDaysToPay: 0, medianDaysToPay: 1, p90DaysToPay: 2 });
  });

  it('resolves a re-issued invoice by EARLIEST issue date (not array order)', () => {
    const inv = uid(++seq);
    const first = issued(inv, ISSUE);                       // array position 2, earliest
    const reissue = issued(inv, '2026-01-04T00:00:00.000Z'); // array position 1, later in time
    const payment = payDays(3, { invoiceId: inv });          // 3 days after the FIRST issue
    expect(cadenceOf([reissue, payment, first])?.medianDaysToPay).toBe(3);
  });

  it('breaks exact issue-timestamp ties by array order (documented determinism)', () => {
    const inv = uid(++seq);
    const a = issued(inv, ISSUE);
    const b = issued(inv, ISSUE); // same `at` — the later row wins nothing, first stands
    const payment = payDays(6, { invoiceId: inv });
    const byEvidence = buildCadenceClaim([a, b, payment], AS_OF);
    expect(byEvidence?.computedFrom[1]).toBe(a.eventId);
  });

  it('lists evidence as [payment, invoice…] in first-appearance order, invoice deduped', () => {
    const inv = issued();
    const p1 = payDays(4, { invoiceId: inv.invoiceId });
    const p2 = payDays(9, { invoiceId: inv.invoiceId });
    const claim = buildCadenceClaim([inv, p1, p2], AS_OF);
    expect(claim?.computedFrom).toEqual([p1.eventId, inv.eventId, p2.eventId]);
  });

  it('is deterministic: same facts ⇒ byte-identical claim', () => {
    const inv = issued();
    const facts = [inv, payDays(2, { invoiceId: inv.invoiceId }), payDays(7, { invoiceId: inv.invoiceId })];
    const a = JSON.stringify(buildCadenceClaim(facts, AS_OF));
    const b = JSON.stringify(buildCadenceClaim([...facts], AS_OF));
    expect(a).toBe(b);
  });
});

// --- payment.sizeBands ----------------------------------------------------------

describe('buildSizeBandsClaim — typical payment size per currency', () => {
  const bandsOf = (facts: MemoryFact[]): SizeBandsValue | null => {
    const claim = buildSizeBandsClaim(facts, AS_OF);
    return claim ? (claim.value as SizeBandsValue) : null;
  };

  it('emits no claim without payments', () => {
    expect(bandsOf([])).toBeNull();
    expect(bandsOf([issued(), promiseOutcome('kept')])).toBeNull();
  });

  it('pins nearest-rank quartiles for a three-sample band', () => {
    const facts = [
      payDays(1, { amountMinor: 80_000 }),
      payDays(2, { amountMinor: 150_000 }),
      payDays(3, { amountMinor: 100_000 }),
    ];
    expect(bandsOf(facts)?.bands).toEqual([
      { currency: 'KES', count: 3, minMinor: 80_000, p25Minor: 80_000, medianMinor: 100_000, p75Minor: 150_000, maxMinor: 150_000 },
    ]);
  });

  it('degenerates to the single amount for one payment', () => {
    expect(bandsOf([payDays(1, { amountMinor: 42_000 })])?.bands).toEqual([
      { currency: 'KES', count: 1, minMinor: 42_000, p25Minor: 42_000, medianMinor: 42_000, p75Minor: 42_000, maxMinor: 42_000 },
    ]);
  });

  it('splits multi-currency histories into lexicographically sorted bands', () => {
    const facts = [
      payDays(1, { currency: 'USD', amountMinor: 5_000 }),
      payDays(2, { currency: 'KES', amountMinor: 90_000 }),
      payDays(3, { currency: 'TZS', amountMinor: 700_000 }),
      payDays(4, { currency: 'KES', amountMinor: 110_000 }),
    ];
    const value = bandsOf(facts) as SizeBandsValue;
    expect(value.bands.map((band) => band.currency)).toEqual(['KES', 'TZS', 'USD']);
    expect(value.bands[0]).toEqual({ currency: 'KES', count: 2, minMinor: 90_000, p25Minor: 90_000, medianMinor: 100_000, p75Minor: 110_000, maxMinor: 110_000 });
    expect(value.bands.map((band) => band.count)).toEqual([2, 1, 1]);
  });

  it('carries every payment eventId as evidence (deduped, input order)', () => {
    const p1 = payDays(1, { amountMinor: 10_000 });
    const p2 = payDays(2, { currency: 'USD', amountMinor: 20_000 });
    const claim = buildSizeBandsClaim([p1, p2], AS_OF);
    expect(claim?.computedFrom).toEqual([p1.eventId, p2.eventId]);
  });
});

// --- promise.reliability ----------------------------------------------------------

describe('buildReliabilityClaim — kept/broken/expired + rate', () => {
  const reliabilityOf = (facts: MemoryFact[]): ReliabilityValue | null => {
    const claim = buildReliabilityClaim(facts, AS_OF);
    return claim ? (claim.value as ReliabilityValue) : null;
  };

  it('emits no claim without promise outcomes', () => {
    expect(reliabilityOf([])).toBeNull();
    expect(reliabilityOf([payDays(1, {}), message('inbound', '2026-02-02T09:00:00.000Z')])).toBeNull();
  });

  it('counts outcomes and computes the kept rate exactly', () => {
    const table: { outcomes: ('kept' | 'broken' | 'expired')[]; kept: number; broken: number; expired: number; rate: number }[] = [
      { outcomes: ['kept', 'kept', 'broken', 'expired'], kept: 2, broken: 1, expired: 1, rate: 0.5 },
      { outcomes: ['kept'], kept: 1, broken: 0, expired: 0, rate: 1 },
      { outcomes: ['broken'], kept: 0, broken: 1, expired: 0, rate: 0 },
      { outcomes: ['expired', 'expired'], kept: 0, broken: 0, expired: 2, rate: 0 },
      { outcomes: ['kept', 'kept', 'kept'], kept: 3, broken: 0, expired: 0, rate: 1 },
    ];
    table.forEach(({ outcomes, kept, broken, expired, rate }) => {
      expect(reliabilityOf(outcomes.map((outcome) => promiseOutcome(outcome)))).toEqual({
        kept, broken, expired, total: outcomes.length, rate,
      });
    });
  });

  it('keeps outcome eventIds as evidence in input order', () => {
    const facts = [promiseOutcome('broken'), promiseOutcome('kept'), promiseOutcome('kept')];
    const claim = buildReliabilityClaim(facts, AS_OF);
    expect(claim?.computedFrom).toEqual(facts.map((fact) => fact.eventId));
  });
});

// --- channel.preference -----------------------------------------------------------

describe('buildChannelClaim — histogram + consent trail', () => {
  const channelsOf = (facts: MemoryFact[]): ChannelPreferenceValue | null => {
    const claim = buildChannelClaim(facts, AS_OF);
    return claim ? (claim.value as ChannelPreferenceValue) : null;
  };

  it('emits no claim without messages or consent facts', () => {
    expect(channelsOf([])).toBeNull();
    expect(channelsOf([payDays(1, {}), promiseOutcome('kept')])).toBeNull();
  });

  it('builds an inbound/outbound histogram, channels sorted lexicographically', () => {
    const facts = [
      message('inbound', '2026-02-01T09:00:00.000Z', 'whatsapp'),
      message('outbound', '2026-02-02T09:00:00.000Z', 'whatsapp'),
      message('outbound', '2026-02-03T09:00:00.000Z', 'sms'),
      message('outbound', '2026-02-04T09:00:00.000Z', 'sms'),
      message('inbound', '2026-02-05T09:00:00.000Z', 'email'),
    ];
    expect(channelsOf(facts)?.channels).toEqual([
      { channel: 'email', inbound: 1, outbound: 0, total: 1 },
      { channel: 'sms', inbound: 0, outbound: 2, total: 2 },
      { channel: 'whatsapp', inbound: 1, outbound: 1, total: 2 },
    ]);
  });

  it('resolves consent by LATEST `at` even when array order disagrees (the fix pin)', () => {
    const facts = [
      consent('revoked', '2026-02-01T09:00:00.000Z'),
      consent('granted', '2026-02-20T09:00:00.000Z'), // later in TIME, earlier in array
    ];
    expect(channelsOf(facts)?.consent).toEqual([{ channel: 'whatsapp', status: 'granted' }]);
  });

  it('resolves a grant-then-revoke trail to revoked', () => {
    const facts = [consent('granted', '2026-02-01T09:00:00.000Z'), consent('revoked', '2026-02-20T09:00:00.000Z')];
    expect(channelsOf(facts)?.consent).toEqual([{ channel: 'whatsapp', status: 'revoked' }]);
  });

  it('breaks exact consent-timestamp ties by array order (later row wins)', () => {
    const facts = [consent('granted', '2026-02-01T09:00:00.000Z'), consent('revoked', '2026-02-01T09:00:00.000Z')];
    expect(channelsOf(facts)?.consent).toEqual([{ channel: 'whatsapp', status: 'revoked' }]);
  });

  it('reports consent per channel: usage-without-consent → none; consent-without-usage still listed', () => {
    const facts = [
      message('inbound', '2026-02-01T09:00:00.000Z', 'whatsapp'),
      consent('granted', '2026-02-02T09:00:00.000Z', 'sms'),
    ];
    const value = channelsOf(facts) as ChannelPreferenceValue;
    expect(value.channels.map((row) => row.channel)).toEqual(['whatsapp']);
    expect(value.consent).toEqual([
      { channel: 'sms', status: 'granted' },
      { channel: 'whatsapp', status: 'none' },
    ]);
  });

  it('records only the DECIDING consent fact as evidence (superseded flips excluded)', () => {
    const kept = consent('granted', '2026-02-01T09:00:00.000Z');
    const deciding = consent('revoked', '2026-02-20T09:00:00.000Z');
    const m = message('outbound', '2026-02-02T09:00:00.000Z');
    const claim = buildChannelClaim([kept, m, deciding], AS_OF);
    expect(claim?.computedFrom).toEqual([m.eventId, deciding.eventId]);
  });

  it('emits a consent-only claim with an empty channels histogram', () => {
    const value = channelsOf([consent('revoked', '2026-02-20T09:00:00.000Z', 'email')]) as ChannelPreferenceValue;
    expect(value.channels).toEqual([]);
    expect(value.consent).toEqual([{ channel: 'email', status: 'revoked' }]);
  });
});

// --- exposure.current -------------------------------------------------------------

describe('buildExposureClaim — open receivables + aging', () => {
  const exposureOf = (facts: MemoryFact[]): ExposureValue | null => {
    const claim = buildExposureClaim(facts, AS_OF);
    return claim ? (claim.value as ExposureValue) : null;
  };

  it('emits no claim without receivables', () => {
    expect(exposureOf([])).toBeNull();
    expect(exposureOf([payDays(1, {}), disputeOpened(uid(++seq))])).toBeNull();
  });

  it('projects one fully-open receivable with zero-filled aging buckets', () => {
    const rec = opened(10, { amountMinor: 620_000 });
    expect(exposureOf([rec])?.currencies).toEqual([
      {
        currency: 'KES',
        openReceivables: 1,
        openMinor: 620_000,
        aging: [
          { bucket: '0-30', count: 1, amountMinor: 620_000 },
          { bucket: '31-60', count: 0, amountMinor: 0 },
          { bucket: '61-90', count: 0, amountMinor: 0 },
          { bucket: '90+', count: 0, amountMinor: 0 },
        ],
      },
    ]);
  });

  it('nets allocations off the opened amount (clamped at 0, never negative)', () => {
    const rec = opened(45, { amountMinor: 500_000 });
    const table: { allocations: number[]; expected: number }[] = [
      { allocations: [150_000, 50_000], expected: 300_000 },
      { allocations: [500_000], expected: 0 },
      { allocations: [600_000], expected: 0 }, // over-allocation cannot create negative exposure
    ];
    table.forEach(({ allocations, expected }) => {
      const facts = [rec, ...allocations.map((amountMinor) => allocation(rec.receivableId, amountMinor))];
      const row = exposureOf(facts)?.currencies[0];
      expect(row?.openMinor).toBe(expected);
      expect(row?.openReceivables).toBe(allocationsSum(allocations) < 500_000 ? 1 : 0);
    });
  });

  const allocationsSum = (amounts: number[]): number => amounts.reduce((a, b) => a + b, 0);

  it('treats a settled fact as authoritative — the receivable leaves exposure', () => {
    const rec = opened(5, { amountMinor: 500_000 });
    const value = exposureOf([rec, settled(rec.receivableId, '2026-03-15T09:00:00.000Z')]) as ExposureValue;
    expect(value.currencies[0]).toMatchObject({ openReceivables: 0, openMinor: 0 });
    // currency row still present (zero-filled) — honest "nothing open in KES"
    expect(value.currencies).toHaveLength(1);
    expect(value.currencies[0]?.aging.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('keeps a receivable open when the settlement cannot be attributed (opened later in the array)', () => {
    const rec = opened(5, { amountMinor: 500_000 });
    const settle = settled(rec.receivableId, '2026-03-15T09:00:00.000Z');
    expect(exposureOf([settle, rec])?.currencies[0]).toMatchObject({ openReceivables: 1, openMinor: 500_000 });
  });

  it('ignores allocations for unknown receivables (no attribution, no evidence)', () => {
    const orphan = allocation(uid(++seq), 999_000);
    expect(exposureOf([orphan])).toBeNull(); // nothing derivable — silence is honest
  });

  it('pins the aging bucket boundaries (day 30/31, 60/61, 90/91, not-yet-due → 0-30)', () => {
    const table: [number, string][] = [
      [0, '0-30'], [5, '0-30'], [30, '0-30'], [31, '31-60'],
      [60, '31-60'], [61, '61-90'], [90, '61-90'], [91, '90+'], [365, '90+'],
    ];
    table.forEach(([daysPastDue, bucket]) => {
      expect(agingBucketFor(daysPastDue)).toBe(bucket);
      const rec = opened(daysPastDue, { amountMinor: 10_000 });
      const aging = exposureOf([rec])?.currencies[0]?.aging ?? [];
      const filled = aging.filter((row) => row.count === 1);
      expect(filled).toHaveLength(1);
      expect(filled[0]?.bucket).toBe(bucket);
    });
  });

  it('never assigns a negative days-past-due bucket (future-due receivables age as 0-30)', () => {
    const future = opened(-3, { amountMinor: 10_000 }); // due 3 days AFTER asOf
    const aging = exposureOf([future])?.currencies[0]?.aging ?? [];
    expect(aging.find((row) => row.count === 1)?.bucket).toBe('0-30');
  });

  it('splits multi-currency exposure into sorted rows with independent aging', () => {
    const kes = opened(40, { currency: 'KES', amountMinor: 600_000 });
    const usd = opened(100, { currency: 'USD', amountMinor: 2_000 });
    const value = exposureOf([kes, usd]) as ExposureValue;
    expect(value.currencies.map((row) => row.currency)).toEqual(['KES', 'USD']);
    expect(value.currencies[0]?.aging.find((b) => b.bucket === '31-60')).toMatchObject({ count: 1, amountMinor: 600_000 });
    expect(value.currencies[1]?.aging.find((b) => b.bucket === '90+')).toMatchObject({ count: 1, amountMinor: 2_000 });
  });

  it('aggregates same-bucket receivables into bucket counts and amounts', () => {
    const a = opened(10, { amountMinor: 100_000 });
    const b = opened(20, { amountMinor: 250_000 });
    const row = exposureOf([a, b])?.currencies[0];
    expect(row).toMatchObject({ openReceivables: 2, openMinor: 350_000 });
    expect(row?.aging.find((bucket) => bucket.bucket === '0-30')).toMatchObject({ count: 2, amountMinor: 350_000 });
  });

  it('lists evidence as opened → attributed allocations → deciding settlement, deduped', () => {
    const rec = opened(10, { amountMinor: 500_000 });
    const a1 = allocation(rec.receivableId, 100_000);
    const a2 = allocation(rec.receivableId, 100_000);
    const lateSettlement = settled(rec.receivableId, '2026-03-20T09:00:00.000Z');
    const earlySettlement = settled(rec.receivableId, '2026-03-15T09:00:00.000Z'); // earlier in time, later in array
    const claim = buildExposureClaim([rec, a1, lateSettlement, a2, earlySettlement], AS_OF);
    expect(claim?.computedFrom).toEqual([rec.eventId, a1.eventId, a2.eventId, earlySettlement.eventId]);
  });

  it('refuses exposure sums that leave the safe-integer range (MEM_AMOUNT_OVERFLOW)', () => {
    const a = opened(1, { amountMinor: Number.MAX_SAFE_INTEGER });
    const b = opened(2, { amountMinor: Number.MAX_SAFE_INTEGER });
    expectCode(() => buildExposureClaim([a, b], AS_OF), 'MEM_AMOUNT_OVERFLOW');
  });
});

// --- dispute.history ---------------------------------------------------------------

describe('buildDisputeClaim — opened/resolved + currentlyOpen', () => {
  const disputesOf = (facts: MemoryFact[]): DisputeHistoryValue | null => {
    const claim = buildDisputeClaim(facts, AS_OF);
    return claim ? (claim.value as DisputeHistoryValue) : null;
  };

  it('emits no claim without dispute facts', () => {
    expect(disputesOf([])).toBeNull();
    expect(disputesOf([payDays(1, {}), promiseOutcome('kept')])).toBeNull();
  });

  it('counts opened/resolved and flags currently-open disputes', () => {
    const table: { opened: number; resolved: number; expectedCurrentlyOpen: number }[] = [
      { opened: 2, resolved: 1, expectedCurrentlyOpen: 1 },
      { opened: 3, resolved: 3, expectedCurrentlyOpen: 0 },
      { opened: 1, resolved: 0, expectedCurrentlyOpen: 1 },
      { opened: 0, resolved: 2, expectedCurrentlyOpen: 0 }, // resolution-only history is still a claim
    ];
    table.forEach(({ opened: nOpened, resolved: nResolved, expectedCurrentlyOpen }) => {
      const facts: MemoryFact[] = [];
      const ids: Uuid[] = [];
      for (let i = 0; i < Math.max(nOpened, nResolved); i += 1) ids.push(uid(++seq));
      ids.forEach((id, i) => {
        if (i < nOpened) facts.push(disputeOpened(id));
        if (i < nResolved) facts.push(disputeResolved(id));
      });
      expect(disputesOf(facts)).toEqual({ opened: nOpened, resolved: nResolved, currentlyOpen: expectedCurrentlyOpen });
    });
  });

  it('counts a dispute once even with duplicate resolution facts', () => {
    const id = uid(++seq);
    expect(disputesOf([disputeOpened(id), disputeResolved(id), disputeResolved(id)])).toEqual({
      opened: 1, resolved: 1, currentlyOpen: 0,
    });
  });

  it('carries opened + resolved eventIds as evidence', () => {
    const a = uid(++seq);
    const b = uid(++seq);
    const o1 = disputeOpened(a);
    const o2 = disputeOpened(b);
    const r1 = disputeResolved(a);
    const claim = buildDisputeClaim([o1, o2, r1], AS_OF);
    expect(claim?.computedFrom).toEqual([o1.eventId, o2.eventId, r1.eventId]);
  });
});

// --- cross-cutting claim contract -------------------------------------------------

describe('claims — the evidence contract', () => {
  it('shapes every claim as { claim, value, computedFrom, asOf } with ISO asOf', () => {
    const inv = issued();
    const facts = [inv, payDays(3, { invoiceId: inv.invoiceId }), promiseOutcome('kept')];
    const claims = CLAIM_BUILDERS.flatMap((build) => {
      const claim = build(facts, AS_OF);
      return claim ? [claim] : [];
    });
    claims.forEach((claim: Claim) => {
      expect(Object.keys(claim).sort()).toEqual(['asOf', 'claim', 'computedFrom', 'value']);
      expect(claim.asOf).toBe(AS_OF);
      expect(Array.isArray(claim.computedFrom)).toBe(true);
      expect(claim.computedFrom.length).toBeGreaterThan(0);
      expect(new Set(claim.computedFrom).size).toBe(claim.computedFrom.length); // deduped
      for (const id of claim.computedFrom) {
        expect(facts.some((fact) => fact.eventId === id)).toBe(true); // resolves to supplied inputs
      }
    });
  });

  it('emits exactly [cadence, sizeBands] for a payments-with-invoices history (silence is honest)', () => {
    const inv = issued();
    const facts = [inv, payDays(1, { invoiceId: inv.invoiceId, amountMinor: 10_000 }), payDays(2, { invoiceId: inv.invoiceId, amountMinor: 20_000 })];
    const names = CLAIM_BUILDERS.flatMap((build) => {
      const claim = build(facts, AS_OF);
      return claim ? [claim.claim] : [];
    });
    expect(names).toEqual(['payment.cadence', 'payment.sizeBands']);
  });

  it('is deterministic across runs for a mixed history', () => {
    const inv = issued();
    const rec = opened(35, { amountMinor: 400_000 });
    const facts = [
      inv, payDays(6, { invoiceId: inv.invoiceId }), promiseOutcome('broken'),
      message('inbound', '2026-02-02T09:00:00.000Z'), rec, allocation(rec.receivableId, 50_000),
      disputeOpened(uid(++seq)),
    ];
    const first = JSON.stringify(CLAIM_BUILDERS.map((build) => build(facts, AS_OF)));
    const second = JSON.stringify(CLAIM_BUILDERS.map((build) => build([...facts], AS_OF)));
    expect(first).toBe(second);
  });

  it('pins all four aging buckets in canonical order', () => {
    expect(AGING_BUCKETS).toEqual(['0-30', '31-60', '61-90', '90+']);
  });
});
